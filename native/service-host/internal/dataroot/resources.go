package dataroot

import (
	"errors"
	"fmt"
	"reflect"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

const rejectedCloseAttempts = 3

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
	VerifyUnchanged() error
	ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error)
	ReinspectDataStreams() ([]winfile.DataStream, error)
	Close() error
}

type dependencies struct {
	openTraversalRoot func(string, winfile.OpenOptions) (directoryHandle, error)
}

type retainedResource struct {
	path            string
	object          ObjectSnapshot
	directory       directoryHandle
	file            fileHandle
	closedChildren  []winfile.DirectoryEntry
	closedStructure bool
}

type retainedResources struct {
	values []retainedResource
}

func (resources *retainedResources) snapshots() []ObjectSnapshot {
	result := make([]ObjectSnapshot, len(resources.values))
	for index := range resources.values {
		result[index] = cloneObjectSnapshot(resources.values[index].object)
	}
	return result
}

func (resources *retainedResources) addDirectory(path string, handle directoryHandle, object ObjectSnapshot) {
	resources.values = append(resources.values, retainedResource{
		path: path, object: cloneObjectSnapshot(object), directory: handle,
	})
}

func (resources *retainedResources) addFile(path string, handle fileHandle, object ObjectSnapshot) {
	resources.values = append(resources.values, retainedResource{
		path: path, object: cloneObjectSnapshot(object), file: handle,
	})
}

func (resources *retainedResources) sealDirectory(path string, children []winfile.DirectoryEntry) error {
	for index := range resources.values {
		resource := &resources.values[index]
		if resource.path != path {
			continue
		}
		if resource.directory == nil || resource.closedStructure {
			return fmt.Errorf("directory %s cannot be sealed twice or without a handle", path)
		}
		if err := verifyClosedDirectory(resource.directory, path, children); err != nil {
			return err
		}
		resource.closedChildren = append([]winfile.DirectoryEntry(nil), children...)
		resource.closedStructure = true
		return nil
	}
	return fmt.Errorf("directory %s is not retained", path)
}

func (resources *retainedResources) recheck() error {
	var result error
	for index := len(resources.values) - 1; index >= 0; index-- {
		result = errors.Join(result, resources.values[index].recheck())
	}
	return result
}

func (resource retainedResource) recheck() error {
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
		} else if !reflect.DeepEqual(resource.object.evidence.Security, security) {
			result = errors.Join(result, fmt.Errorf("file security changed for %s", resource.path))
		}
		return result
	}
	if resource.directory == nil {
		return fmt.Errorf("retained object %s has no handle", resource.path)
	}
	if resource.closedStructure {
		if err := verifyClosedDirectory(resource.directory, resource.path, resource.closedChildren); err != nil {
			result = errors.Join(result, err)
		}
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
	} else if !reflect.DeepEqual(resource.object.evidence.Security, security) {
		result = errors.Join(result, fmt.Errorf("directory security changed for %s", resource.path))
	}
	return result
}

func verifyClosedDirectory(handle directoryHandle, path string, expected []winfile.DirectoryEntry) error {
	maximumEntries := len(expected) + 1
	if maximumEntries > maximumRetainedObjects {
		maximumEntries = maximumRetainedObjects
	}
	listing, err := handle.Enumerate(winfile.DirectoryEnumerationOptions{
		MaximumEntries:             uint32(maximumEntries),
		MaximumNameUTF16Units:      winfile.MaximumDirectoryEntryNameUTF16Units,
		MaximumTotalNameUTF16Units: uint64(maximumEntries) * uint64(winfile.MaximumDirectoryEntryNameUTF16Units),
	})
	if err != nil {
		return fmt.Errorf("enumerate closed structure directory %s: %w", path, err)
	}
	if len(listing.Entries) != len(expected) {
		return fmt.Errorf("closed structure directory %s has %d entries, want %d", path, len(listing.Entries), len(expected))
	}
	wanted := make(map[string]winfile.DirectoryEntry, len(expected))
	for _, entry := range expected {
		if entry.Name == "" || entry.Identity.FileID == ([16]byte{}) {
			return fmt.Errorf("closed structure directory %s has an invalid expected entry", path)
		}
		if _, duplicate := wanted[entry.Name]; duplicate {
			return fmt.Errorf("closed structure directory %s repeats expected entry %s", path, entry.Name)
		}
		wanted[entry.Name] = entry
	}
	for _, entry := range listing.Entries {
		expectedEntry, exists := wanted[entry.Name]
		if !exists {
			return fmt.Errorf("closed structure directory %s contains unexpected entry %s", path, entry.Name)
		}
		if entry.Kind != expectedEntry.Kind || entry.Identity != expectedEntry.Identity {
			return fmt.Errorf("closed structure entry %s in %s has the wrong kind or identity", entry.Name, path)
		}
		delete(wanted, entry.Name)
	}
	if len(wanted) != 0 {
		return fmt.Errorf("closed structure directory %s is missing expected entries", path)
	}
	return nil
}

func (resources *retainedResources) close(attempts int) error {
	if attempts < 1 {
		attempts = 1
	}
	failedReverse := make([]retainedResource, 0)
	var result error
	for index := len(resources.values) - 1; index >= 0; index-- {
		resource := resources.values[index]
		var closeFailures error
		closed := false
		for attempt := 1; attempt <= attempts; attempt++ {
			var err error
			if resource.file != nil {
				err = resource.file.Close()
			} else if resource.directory != nil {
				err = resource.directory.Close()
			}
			if err == nil {
				closed = true
				break
			}
			closeFailures = errors.Join(closeFailures, fmt.Errorf("attempt %d: %w", attempt, err))
		}
		if !closed {
			failedReverse = append(failedReverse, resource)
			result = errors.Join(result, fmt.Errorf("close retained object %s: %w", resource.path, closeFailures))
		}
	}
	remaining := make([]retainedResource, len(failedReverse))
	for index := range failedReverse {
		remaining[len(failedReverse)-1-index] = failedReverse[index]
	}
	resources.values = remaining
	return result
}

func closeRejectedDirectory(handle directoryHandle) error {
	if handle == nil {
		return nil
	}
	var result error
	for attempt := 1; attempt <= rejectedCloseAttempts; attempt++ {
		if err := handle.Close(); err != nil {
			result = errors.Join(result, fmt.Errorf("close rejected directory attempt %d: %w", attempt, err))
			continue
		}
		return result
	}
	return result
}

func closeRejectedFile(handle fileHandle) error {
	if handle == nil {
		return nil
	}
	var result error
	for attempt := 1; attempt <= rejectedCloseAttempts; attempt++ {
		if err := handle.Close(); err != nil {
			result = errors.Join(result, fmt.Errorf("close rejected file attempt %d: %w", attempt, err))
			continue
		}
		return result
	}
	return result
}
