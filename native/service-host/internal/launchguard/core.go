package launchguard

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"reflect"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/preflight"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

var productionQuarantine = &lifetimeQuarantine{}

var guardEnumerationOptions = winfile.DirectoryEnumerationOptions{
	MaximumEntries:             winfile.MaximumDirectoryEntries,
	MaximumNameUTF16Units:      winfile.MaximumDirectoryEntryNameUTF16Units,
	MaximumTotalNameUTF16Units: winfile.MaximumDirectoryNameUTF16Units,
}

func openWithDependencies(
	ctx context.Context,
	authority authoritySnapshot,
	deps dependencies,
) (result *Guard, err error) {
	if ctx == nil {
		return nil, authorityError("launch guard context is required", nil)
	}
	if err := validateDependencies(deps); err != nil {
		return nil, err
	}
	if err := validateAuthoritySnapshot(authority); err != nil {
		return nil, err
	}
	if unavailable := deps.quarantine.acquisitionStatus(); unavailable != nil {
		return nil, unavailable
	}
	if fatal := deps.platformCleanupStatus(); fatal != nil {
		return nil, errors.Join(ErrCleanupFatal, fatal)
	}
	if cause := context.Cause(ctx); cause != nil {
		return nil, cause
	}
	state := &guardState{authority: cloneAuthority(authority), deps: deps}
	defer func() {
		if err == nil {
			return
		}
		err = errors.Join(err, state.closeResourcesLocked())
	}()

	verifier, err := deps.newAuthenticodeVerifier()
	if err != nil || verifier == nil {
		return nil, authorityError("construct fresh Authenticode verifier", err)
	}
	for _, target := range authority.targets {
		if cause := context.Cause(ctx); cause != nil {
			return nil, cause
		}
		if err := state.openTarget(ctx, target, verifier); err != nil {
			return nil, err
		}
	}
	if err := state.verifyResourcesLocked(ctx, verifier); err != nil {
		return nil, err
	}
	return &Guard{state: state}, nil
}

func validateDependencies(deps dependencies) error {
	if deps.openTraversalRoot == nil || deps.newAuthenticodeVerifier == nil ||
		deps.launchNode == nil || deps.platformCleanupStatus == nil ||
		deps.commitPlatformHealthy == nil || deps.quarantine == nil {
		return authorityError("launch guard dependencies are incomplete", nil)
	}
	return nil
}

func (state *guardState) openTarget(
	ctx context.Context,
	target launchTarget,
	verifier authenticode.Verifier,
) error {
	rootPath, relative, err := relativeTargetComponents(state.authority.root.Path, target.file.AbsolutePath)
	if err != nil || len(relative) == 0 {
		return authorityError("derive launch target path below installation root", err)
	}
	currentPath := rootPath.drive
	expected := expectedDirectoryObject(state.authority.root, currentPath)
	if expected == nil {
		return authorityError("installation evidence omits the canonical drive root", nil)
	}
	current, err := state.deps.openTraversalRoot(currentPath, winfile.OpenOptions{
		VolumeUse: winfile.VolumeUseReadOnly, SecurityMode: expected.Evidence.SecurityMode,
	})
	if err != nil {
		return fmt.Errorf("open guarded traversal root %s: %w", currentPath, err)
	}
	retained, err := state.retainDirectory(currentPath, current, expected, false)
	if err != nil {
		return err
	}
	current = retained.handle

	for index, component := range rootPath.components {
		if cause := context.Cause(ctx); cause != nil {
			return cause
		}
		currentPath = appendPath(currentPath, component)
		expected = expectedDirectoryObject(state.authority.root, currentPath)
		if expected == nil {
			return authorityError("installation root ancestor evidence is incomplete", nil)
		}
		child, openErr := current.OpenDirectoryComponent(component, winfile.OpenOptions{
			VolumeUse: winfile.VolumeUseReadOnly, DirectoryEnumeration: index == len(rootPath.components)-1,
			SecurityMode: expected.Evidence.SecurityMode,
		})
		if openErr != nil {
			return fmt.Errorf("open guarded installation ancestor %s: %w", currentPath, openErr)
		}
		retained, err = state.retainDirectory(
			currentPath,
			child,
			expected,
			index == len(rootPath.components)-1,
		)
		if err != nil {
			return err
		}
		current = retained.handle
	}

	for _, component := range relative[:len(relative)-1] {
		if cause := context.Cause(ctx); cause != nil {
			return cause
		}
		currentPath = appendPath(currentPath, component)
		child, openErr := current.OpenDirectoryComponent(component, winfile.OpenOptions{
			VolumeUse: winfile.VolumeUseReadOnly, DirectoryEnumeration: true,
			SecurityMode: winfile.SecurityModeManaged,
		})
		if openErr != nil {
			return fmt.Errorf("open guarded target directory %s: %w", currentPath, openErr)
		}
		retained, err = state.retainDirectory(currentPath, child, nil, true)
		if err != nil {
			return err
		}
		current = retained.handle
	}

	leaf := relative[len(relative)-1]
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	file, err := current.OpenFileComponent(leaf, winfile.OpenOptions{
		VolumeUse: winfile.VolumeUseReadOnly, SecurityMode: winfile.SecurityModeManaged,
	})
	if err != nil {
		return fmt.Errorf("open guarded launch file %s: %w", target.file.AbsolutePath, err)
	}
	retainedFile := retainedFile{kind: target.kind, handle: file, file: cloneFile(target.file)}
	state.files = append(state.files, retainedFile)
	if err := verifyRetainedFile(retainedFile, state.authority.signerPin, verifier); err != nil {
		return err
	}
	return nil
}

func (state *guardState) retainDirectory(
	path string,
	handle directoryHandle,
	expected *secureconfig.ObjectEvidence,
	enumerate bool,
) (retainedDirectory, error) {
	if handle == nil {
		return retainedDirectory{}, authorityError("directory opener returned nil", nil)
	}
	object, err := objectFromHandle(path, handle.Evidence(), handle.ReinspectSecurity)
	if err != nil {
		state.directories = append(state.directories, retainedDirectory{path: path, handle: handle})
		return retainedDirectory{}, fmt.Errorf("reconstruct guarded directory evidence %s: %w", path, err)
	}
	if expected != nil && !sameObject(object, *expected) {
		state.directories = append(state.directories, retainedDirectory{path: path, handle: handle, object: object})
		return retainedDirectory{}, authorityError("reopened directory differs from preflight evidence", nil)
	}
	caseSensitive, err := handle.ReinspectCaseSensitivity()
	if err != nil || caseSensitive {
		state.directories = append(state.directories, retainedDirectory{path: path, handle: handle, object: object})
		return retainedDirectory{}, errors.Join(ErrChanged, fmt.Errorf("guarded directory case mode %s: %w", path, err))
	}
	if _, err := handle.ReinspectDataStreams(); err != nil {
		state.directories = append(state.directories, retainedDirectory{path: path, handle: handle, object: object})
		return retainedDirectory{}, errors.Join(ErrChanged, fmt.Errorf("guarded directory streams %s: %w", path, err))
	}
	retained := retainedDirectory{path: path, handle: handle, object: object}
	if enumerate {
		enumeration, err := handle.Enumerate(guardEnumerationOptions)
		if err != nil {
			state.directories = append(state.directories, retained)
			return retainedDirectory{}, errors.Join(ErrChanged, fmt.Errorf("enumerate guarded directory %s: %w", path, err))
		}
		retained.enumeration = &enumeration
		retained.enumOptions = guardEnumerationOptions
	}
	state.directories = append(state.directories, retained)
	return retained, nil
}

func expectedDirectoryObject(
	root preflight.VerifiedRoot,
	path string,
) *secureconfig.ObjectEvidence {
	for index := range root.Ancestors {
		if strings.EqualFold(root.Ancestors[index].Path, path) {
			value := cloneObject(root.Ancestors[index])
			return &value
		}
	}
	if strings.EqualFold(root.Object.Path, path) {
		value := cloneObject(root.Object)
		return &value
	}
	return nil
}

func objectFromHandle(
	path string,
	evidence winfile.Evidence,
	reinspect func() (winfile.SecurityDescriptorEvidence, error),
) (secureconfig.ObjectEvidence, error) {
	security, err := reinspect()
	if err != nil {
		return secureconfig.ObjectEvidence{}, err
	}
	evidence.Security = security
	return secureconfig.NewObjectEvidenceForMode(path, evidence.SecurityMode, evidence)
}

func verifyRetainedFile(
	retained retainedFile,
	signerPin string,
	verifier authenticode.Verifier,
) error {
	if retained.handle == nil {
		return authorityError("guarded launch file handle is nil", nil)
	}
	if err := retained.handle.VerifyUnchanged(); err != nil {
		return errors.Join(ErrChanged, fmt.Errorf("reinspect guarded launch file %s: %w", retained.file.AbsolutePath, err))
	}
	object, err := objectFromHandle(
		retained.file.AbsolutePath,
		retained.handle.Evidence(),
		retained.handle.ReinspectSecurity,
	)
	if err != nil || !sameObject(object, retained.file.Object) {
		return errors.Join(ErrChanged, fmt.Errorf("guarded launch file evidence changed for %s: %w", retained.file.AbsolutePath, err))
	}
	if _, err := retained.handle.ReinspectDataStreams(); err != nil {
		return errors.Join(ErrChanged, fmt.Errorf("guarded launch file streams changed for %s: %w", retained.file.AbsolutePath, err))
	}
	hash, err := retained.handle.HashSHA256(winfile.HashOptions{
		ExpectedSize: retained.file.Size,
		MaximumBytes: releasemanifest.MaximumFileBytes,
	})
	if err != nil || hash.Size != retained.file.Size || !digestMatches(hash.SHA256, retained.file.SHA256) {
		return errors.Join(ErrChanged, fmt.Errorf("guarded launch file digest changed for %s: %w", retained.file.AbsolutePath, err))
	}
	if retained.kind == targetBundle {
		if retained.file.Role != expectedRole(targetBundle, retainedRoleFromFile(retained.file)) {
			return authorityError("guarded bundle role is invalid", nil)
		}
		return nil
	}
	authenticodeEvidence, err := retained.handle.VerifyAuthenticode(verifier)
	validationErr := validateAuthenticode(authenticodeEvidence, signerPin)
	if err != nil || validationErr != nil {
		return authorityError("guarded executable Authenticode verification failed", errors.Join(err, validationErr))
	}
	return nil
}

func retainedRoleFromFile(file preflight.VerifiedFile) config.Role {
	if file.Role == releasemanifest.RoleControlBundle {
		return config.RoleControl
	}
	return config.RoleExecutor
}

func validateAuthenticode(evidence authenticode.Evidence, signerPin string) error {
	if !evidence.Trusted || evidence.SignatureKind != authenticode.SignatureKindEmbedded ||
		evidence.SignatureCount != 1 || evidence.VerifiedSignatureIndex != 0 ||
		evidence.RevocationPolicy != authenticode.RevocationPolicyRuntimeCacheOnlyNoCheck ||
		evidence.DigestPolicy != authenticode.DigestPolicySHA256Only ||
		evidence.StrongSignaturePolicy != authenticode.StrongSignaturePolicyWindowsOSCurrent ||
		evidence.SignerDigestAlgorithmOID != authenticode.SHA256ObjectIdentifier ||
		evidence.FileDigestAlgorithmOID != authenticode.SHA256ObjectIdentifier ||
		strings.TrimSpace(evidence.SignerIdentity) == "" || !validSHA256(signerPin) ||
		subtle.ConstantTimeCompare(
			[]byte(evidence.VerifiedLeafSignerCertificateDERSHA256),
			[]byte(signerPin),
		) != 1 {
		return errors.New("Authenticode evidence differs from the compiled signer policy")
	}
	return nil
}

func sameObject(left, right secureconfig.ObjectEvidence) bool {
	leftEvidence := left.Evidence
	rightEvidence := right.Evidence
	leftVolume := leftEvidence.Volume
	rightVolume := rightEvidence.Volume
	return left.Path == right.Path && left.EvidenceSHA256 == right.EvidenceSHA256 &&
		left.SecurityDescriptorSHA256 == right.SecurityDescriptorSHA256 &&
		leftEvidence.Kind == rightEvidence.Kind && leftEvidence.Identity == rightEvidence.Identity &&
		leftEvidence.Attributes == rightEvidence.Attributes && leftEvidence.Size == rightEvidence.Size &&
		leftEvidence.LinkCount == rightEvidence.LinkCount &&
		leftEvidence.Path.RequestedPath == rightEvidence.Path.RequestedPath &&
		leftEvidence.Path.TerminalComponentReparseFree == rightEvidence.Path.TerminalComponentReparseFree &&
		leftEvidence.Path.Ancestors == rightEvidence.Path.Ancestors &&
		leftVolume.FileSystem == rightVolume.FileSystem &&
		leftVolume.FileSystemFlags == rightVolume.FileSystemFlags &&
		leftVolume.HandleSerialNumber == rightVolume.HandleSerialNumber &&
		leftVolume.PathSerialNumber == rightVolume.PathSerialNumber &&
		leftVolume.DriveType == rightVolume.DriveType &&
		leftVolume.PersistentACLs == rightVolume.PersistentACLs &&
		leftVolume.ReadOnly == rightVolume.ReadOnly &&
		leftVolume.RequiredUse == rightVolume.RequiredUse &&
		leftVolume.PathIdentityCrossCheck == rightVolume.PathIdentityCrossCheck &&
		leftEvidence.SecurityMode == rightEvidence.SecurityMode &&
		reflect.DeepEqual(leftEvidence.Security, rightEvidence.Security)
}

func digestMatches(actual [32]byte, expected string) bool {
	if !validSHA256(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(fmt.Sprintf("%x", actual)), []byte(expected)) == 1
}
