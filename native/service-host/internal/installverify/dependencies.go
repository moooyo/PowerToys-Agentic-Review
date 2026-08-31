package installverify

import (
	"errors"
	"fmt"
	"reflect"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winidentity"
)

const closeAttempts = 3

type directoryHandle interface {
	Evidence() winfile.Evidence
	OpenDirectoryComponent(string, winfile.OpenOptions) (directoryHandle, error)
	OpenFileComponent(string, winfile.OpenOptions) (fileHandle, error)
	Enumerate(winfile.DirectoryEnumerationOptions) (winfile.DirectoryEnumeration, error)
	VerifyUnchanged() error
	ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error)
	ReinspectDataStreams() ([]winfile.DataStream, error)
	ReinspectCaseSensitivity() (bool, error)
	Close() error
}

type fileHandle interface {
	Evidence() winfile.Evidence
	ReadAll(uint64) ([]byte, error)
	HashSHA256(winfile.HashOptions) (winfile.HashResult, error)
	VerifyAuthenticode(authenticode.Verifier) (authenticode.Evidence, error)
	VerifyUnchanged() error
	ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error)
	ReinspectDataStreams() ([]winfile.DataStream, error)
	Close() error
}

type directorySecurityRequest struct {
	root         releasemanifest.FileRoot
	isVolumeRoot bool
	object       secureconfig.ObjectEvidence
}

type fileSecurityRequest struct {
	root         releasemanifest.FileRoot
	relativePath string
	purpose      filePurpose
	manifest     *releasemanifest.File
	object       secureconfig.ObjectEvidence
}

type filesystemSecurityPolicy interface {
	CheckDirectory(directorySecurityRequest) error
	CheckFile(fileSecurityRequest) error
}

type dependencies struct {
	identityPreflight       func(winidentity.Options) (winidentity.Evidence, error)
	newSecurityPolicy       func(winidentity.Evidence) (filesystemSecurityPolicy, error)
	newAuthenticodeVerifier func() (authenticode.Verifier, error)
	managedAnchor           func(releasemanifest.FileRoot, string) (string, error)
	secureRead              func(string, secureconfig.Options) (secureconfig.Result, error)
	openTraversalRoot       func(string, winfile.OpenOptions) (directoryHandle, error)
}

type retainedResource struct {
	path        string
	object      secureconfig.ObjectEvidence
	directory   directoryHandle
	file        fileHandle
	enumeration *winfile.DirectoryEnumeration
	enumOptions winfile.DirectoryEnumerationOptions
}

type retainedResources struct {
	values []retainedResource
}

func (resources *retainedResources) addDirectory(
	path string,
	directory directoryHandle,
	object secureconfig.ObjectEvidence,
) int {
	resources.values = append(resources.values, retainedResource{
		path: path, object: cloneObjectEvidence(object), directory: directory,
	})
	return len(resources.values) - 1
}

func (resources *retainedResources) addFile(
	path string,
	file fileHandle,
	object secureconfig.ObjectEvidence,
) int {
	resources.values = append(resources.values, retainedResource{
		path: path, object: cloneObjectEvidence(object), file: file,
	})
	return len(resources.values) - 1
}

func (resources *retainedResources) recordEnumeration(
	index int,
	value winfile.DirectoryEnumeration,
	options winfile.DirectoryEnumerationOptions,
) {
	copy := cloneEnumeration(value)
	resources.values[index].enumeration = &copy
	resources.values[index].enumOptions = options
}

func (resources *retainedResources) finalize() error {
	var result error
	for index := len(resources.values) - 1; index >= 0; index-- {
		resource := &resources.values[index]
		result = errors.Join(result, resource.recheck())
		var closeFailures error
		for attempt := 1; attempt <= closeAttempts; attempt++ {
			var err error
			if resource.file != nil {
				err = resource.file.Close()
			} else {
				err = resource.directory.Close()
			}
			if err == nil {
				break
			}
			closeFailures = errors.Join(closeFailures, fmt.Errorf("close attempt %d: %w", attempt, err))
		}
		if closeFailures != nil {
			result = errors.Join(result, fmt.Errorf("close retained object %s: %w", resource.path, closeFailures))
		}
	}
	resources.values = nil
	return result
}

func (resource *retainedResource) recheck() error {
	var result error
	if resource.file != nil {
		if err := resource.file.VerifyUnchanged(); err != nil {
			result = errors.Join(result, fmt.Errorf("recheck file %s: %w", resource.path, err))
		}
		if _, err := resource.file.ReinspectDataStreams(); err != nil {
			result = errors.Join(result, fmt.Errorf("recheck file streams %s: %w", resource.path, err))
		}
		security, err := resource.file.ReinspectSecurity()
		if err != nil {
			result = errors.Join(result, fmt.Errorf("recheck file security %s: %w", resource.path, err))
		} else if !equalSecurity(resource.object.Evidence.Security, security) {
			result = errors.Join(result, fmt.Errorf("file security changed for %s", resource.path))
		}
		return result
	}

	if err := resource.directory.VerifyUnchanged(); err != nil {
		result = errors.Join(result, fmt.Errorf("recheck directory %s: %w", resource.path, err))
	}
	if _, err := resource.directory.ReinspectDataStreams(); err != nil {
		result = errors.Join(result, fmt.Errorf("recheck directory streams %s: %w", resource.path, err))
	}
	caseSensitive, err := resource.directory.ReinspectCaseSensitivity()
	if err != nil {
		result = errors.Join(result, fmt.Errorf("recheck directory case mode %s: %w", resource.path, err))
	} else if caseSensitive {
		result = errors.Join(result, fmt.Errorf("directory became case-sensitive: %s", resource.path))
	}
	security, err := resource.directory.ReinspectSecurity()
	if err != nil {
		result = errors.Join(result, fmt.Errorf("recheck directory security %s: %w", resource.path, err))
	} else if !equalSecurity(resource.object.Evidence.Security, security) {
		result = errors.Join(result, fmt.Errorf("directory security changed for %s", resource.path))
	}
	if resource.enumeration != nil {
		current, err := resource.directory.Enumerate(resource.enumOptions)
		if err != nil {
			result = errors.Join(result, fmt.Errorf("re-enumerate directory %s: %w", resource.path, err))
		} else if !reflect.DeepEqual(*resource.enumeration, current) {
			result = errors.Join(result, fmt.Errorf("directory entries changed for %s", resource.path))
		}
	}
	return result
}

func equalSecurity(left, right winfile.SecurityDescriptorEvidence) bool {
	return reflect.DeepEqual(left, right)
}

func cloneEnumeration(value winfile.DirectoryEnumeration) winfile.DirectoryEnumeration {
	value.Entries = append([]winfile.DirectoryEntry(nil), value.Entries...)
	return value
}
