package secureconfig

import (
	"crypto/sha256"
	"errors"
	"fmt"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

type directoryHandle interface {
	Evidence() winfile.Evidence
	VerifyUnchanged() error
	ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error)
	Close() error
}

type fileHandle interface {
	Evidence() winfile.Evidence
	ReadAll(uint64) ([]byte, error)
	VerifyUnchanged() error
	ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error)
	Close() error
}

type fileBackend interface {
	OpenRoot(string, winfile.SecurityMode) (directoryHandle, error)
	OpenDirectory(directoryHandle, string, winfile.SecurityMode) (directoryHandle, error)
	OpenFile(directoryHandle, string, winfile.SecurityMode) (fileHandle, error)
}

type openedResource struct {
	path  string
	close func() error
}

type openedDirectory struct {
	path   string
	handle directoryHandle
}

func readWithBackend(path string, options Options, backend fileBackend) (result Result, err error) {
	plan, err := planCanonicalFilePath(path)
	if err != nil {
		return Result{}, err
	}
	if options.MaximumBytes == 0 || options.MaximumBytes > maximumReadableBytes() {
		return Result{}, fmt.Errorf("%w: maximum bytes is outside the supported range", ErrInvalidOptions)
	}
	if isNilInterface(options.Policy) {
		return Result{}, fmt.Errorf("%w: security policy is required", ErrInvalidOptions)
	}
	if isNilInterface(backend) {
		return Result{}, fmt.Errorf("%w: file backend is required", ErrInvalidOptions)
	}
	managedAnchorIndex, err := resolveManagedAnchor(plan, options.ManagedAnchorPath)
	if err != nil {
		return Result{}, err
	}

	resources := make([]openedResource, 0, len(plan.ancestors)+1)
	defer func() {
		closeErr := closeResources(resources)
		if closeErr == nil {
			return
		}
		result = Result{}
		if err == nil {
			err = closeErr
			return
		}
		err = errors.Join(err, closeErr)
	}()

	ancestorHandles := make([]openedDirectory, 0, len(plan.ancestors))
	ancestorEvidence := make([]ObjectEvidence, 0, len(plan.ancestors))
	seenIdentities := make(map[objectIdentity]string, len(plan.ancestors)+1)
	var volumeRoot ObjectEvidence
	var parent directoryHandle

	for index, ancestorPath := range plan.ancestors {
		securityMode := winfile.SecurityModeAmbientAncestor
		if index >= managedAnchorIndex {
			securityMode = winfile.SecurityModeManaged
		}
		var directory directoryHandle
		var openErr error
		if index == 0 {
			directory, openErr = backend.OpenRoot(ancestorPath, securityMode)
		} else {
			directory, openErr = backend.OpenDirectory(parent, finalPathComponent(ancestorPath), securityMode)
		}
		if openErr != nil {
			return Result{}, fmt.Errorf("open configuration ancestor %s: %w", ancestorPath, openErr)
		}
		resources = append(resources, openedResource{path: ancestorPath, close: directory.Close})
		ancestorHandles = append(ancestorHandles, openedDirectory{path: ancestorPath, handle: directory})
		parent = directory

		evidence := directory.Evidence()
		if evidenceErr := validateObjectEvidence(
			ancestorPath,
			winfile.ObjectKindDirectory,
			evidence,
			options.MaximumBytes,
			securityMode,
		); evidenceErr != nil {
			return Result{}, evidenceErr
		}
		object := makeObjectEvidence(ancestorPath, evidence)
		if index == 0 {
			volumeRoot = object
		} else if volumeErr := compareVolumeEvidence(volumeRoot, object); volumeErr != nil {
			return Result{}, volumeErr
		}
		if identityErr := registerIdentity(seenIdentities, object); identityErr != nil {
			return Result{}, identityErr
		}

		policyErr := options.Policy.CheckAncestor(AncestorSecurityRequest{
			Index:        index,
			Count:        len(plan.ancestors),
			IsVolumeRoot: index == 0,
			Object:       cloneObjectEvidence(object),
		})
		if policyErr != nil {
			return Result{}, fmt.Errorf("%w: ancestor %s: %w", ErrPolicyRejected, ancestorPath, policyErr)
		}
		ancestorEvidence = append(ancestorEvidence, object)
	}

	file, openErr := backend.OpenFile(parent, finalPathComponent(plan.file), winfile.SecurityModeManaged)
	if openErr != nil {
		return Result{}, fmt.Errorf("open configuration file %s: %w", plan.file, openErr)
	}
	resources = append(resources, openedResource{path: plan.file, close: file.Close})
	fileEvidence := file.Evidence()
	if evidenceErr := validateObjectEvidence(
		plan.file,
		winfile.ObjectKindFile,
		fileEvidence,
		options.MaximumBytes,
		winfile.SecurityModeManaged,
	); evidenceErr != nil {
		return Result{}, evidenceErr
	}
	fileObject := makeObjectEvidence(plan.file, fileEvidence)
	if volumeErr := compareVolumeEvidence(volumeRoot, fileObject); volumeErr != nil {
		return Result{}, volumeErr
	}
	if identityErr := registerIdentity(seenIdentities, fileObject); identityErr != nil {
		return Result{}, identityErr
	}
	if policyErr := options.Policy.CheckFile(FileSecurityRequest{Object: cloneObjectEvidence(fileObject)}); policyErr != nil {
		return Result{}, fmt.Errorf("%w: file %s: %w", ErrPolicyRejected, plan.file, policyErr)
	}

	data, readErr := file.ReadAll(options.MaximumBytes)
	if readErr != nil {
		return Result{}, fmt.Errorf("read configuration file %s: %w", plan.file, readErr)
	}
	if uint64(len(data)) != fileObject.Evidence.Size {
		return Result{}, fmt.Errorf(
			"%w: read %d bytes but evidence reports %d",
			winfile.ErrObjectChanged,
			len(data),
			fileObject.Evidence.Size,
		)
	}
	if verifyErr := file.VerifyUnchanged(); verifyErr != nil {
		return Result{}, fmt.Errorf("verify configuration file %s after read: %w", plan.file, verifyErr)
	}
	fileSecurity, securityErr := file.ReinspectSecurity()
	if securityErr != nil {
		return Result{}, fmt.Errorf("reinspect configuration file security %s: %w", plan.file, securityErr)
	}
	if securityErr := compareSecurityEvidence(plan.file, fileObject.Evidence.Security, fileSecurity); securityErr != nil {
		return Result{}, securityErr
	}
	for index := len(ancestorHandles) - 1; index >= 0; index-- {
		ancestor := ancestorHandles[index]
		if verifyErr := ancestor.handle.VerifyUnchanged(); verifyErr != nil {
			return Result{}, fmt.Errorf("verify configuration ancestor %s after read: %w", ancestor.path, verifyErr)
		}
		currentSecurity, securityErr := ancestor.handle.ReinspectSecurity()
		if securityErr != nil {
			return Result{}, fmt.Errorf("reinspect configuration ancestor security %s: %w", ancestor.path, securityErr)
		}
		if securityErr := compareSecurityEvidence(
			ancestor.path,
			ancestorEvidence[index].Evidence.Security,
			currentSecurity,
		); securityErr != nil {
			return Result{}, securityErr
		}
	}

	detachedData := append([]byte(nil), data...)
	return Result{
		Data:          detachedData,
		ContentSHA256: Digest(sha256.Sum256(detachedData)),
		File:          fileObject,
		Ancestors:     ancestorEvidence,
	}, nil
}

func finalPathComponent(path string) string {
	for index := len(path) - 1; index >= 0; index-- {
		if path[index] == '\\' {
			return path[index+1:]
		}
	}
	return path
}

func closeResources(resources []openedResource) error {
	var result error
	for index := len(resources) - 1; index >= 0; index-- {
		resource := resources[index]
		if err := resource.close(); err != nil {
			result = errors.Join(result, fmt.Errorf("close configuration object %s: %w", resource.path, err))
		}
	}
	return result
}
