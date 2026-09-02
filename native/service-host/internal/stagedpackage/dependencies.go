package stagedpackage

import (
	"errors"
	"reflect"
	"sync"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

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
	ReadAt([]byte, int64) (int, error)
	HashSHA256(winfile.HashOptions) (winfile.HashResult, error)
	VerifyAuthenticode(authenticode.Verifier) (authenticode.Evidence, error)
	VerifyUnchanged() error
	ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error)
	ReinspectDataStreams() ([]winfile.DataStream, error)
	Close() error
}

type logicalPlan struct {
	index       outerpackage.Index
	control     config.Config
	executor    config.Config
	signerKeyID string
}

type verifierDependencies struct {
	openTraversalRoot       func(string, winfile.OpenOptions) (directoryHandle, error)
	newAuthenticodeVerifier func() (authenticode.Verifier, error)
	admit                   func([]byte, []byte, []byte, []byte) (logicalPlan, error)
	checkSecurity           func(winfile.Evidence, winfile.ObjectKind, bool) error
}

type retainedObject struct {
	path        string
	object      secureconfig.ObjectEvidence
	directory   directoryHandle
	file        fileHandle
	enumeration *winfile.DirectoryEnumeration
	options     winfile.DirectoryEnumerationOptions
}

type handleOwner struct {
	mu      sync.Mutex
	objects []retainedObject
}

func (owner *handleOwner) addDirectory(
	path string,
	handle directoryHandle,
	object secureconfig.ObjectEvidence,
) int {
	owner.objects = append(owner.objects, retainedObject{
		path: path, directory: handle, object: cloneObjectEvidence(object),
	})
	return len(owner.objects) - 1
}

func (owner *handleOwner) addFile(
	path string,
	handle fileHandle,
	object secureconfig.ObjectEvidence,
) int {
	owner.objects = append(owner.objects, retainedObject{
		path: path, file: handle, object: cloneObjectEvidence(object),
	})
	return len(owner.objects) - 1
}

func (owner *handleOwner) setObject(index int, object secureconfig.ObjectEvidence) {
	owner.objects[index].object = cloneObjectEvidence(object)
}

func (owner *handleOwner) recordEnumeration(
	index int,
	value winfile.DirectoryEnumeration,
	options winfile.DirectoryEnumerationOptions,
) {
	copy := cloneEnumeration(value)
	owner.objects[index].enumeration = &copy
	owner.objects[index].options = options
}

func (owner *handleOwner) recheck() error {
	if owner == nil {
		return ErrInvalidEvidence
	}
	owner.mu.Lock()
	defer owner.mu.Unlock()
	return owner.recheckLocked()
}

func (owner *handleOwner) recheckLocked() error {
	var result error
	for index := len(owner.objects) - 1; index >= 0; index-- {
		resource := &owner.objects[index]
		if resource.file != nil {
			if err := resource.file.VerifyUnchanged(); err != nil {
				result = errors.Join(result, ErrInvalidEvidence)
			}
			if _, err := resource.file.ReinspectDataStreams(); err != nil {
				result = errors.Join(result, ErrInvalidEvidence)
			}
			security, err := resource.file.ReinspectSecurity()
			if err != nil || !reflect.DeepEqual(security, resource.object.Evidence.Security) {
				result = errors.Join(result, ErrInvalidEvidence)
			}
			continue
		}
		if resource.directory == nil {
			result = errors.Join(result, ErrInvalidEvidence)
			continue
		}
		if err := resource.directory.VerifyUnchanged(); err != nil {
			result = errors.Join(result, ErrInvalidEvidence)
		}
		if _, err := resource.directory.ReinspectDataStreams(); err != nil {
			result = errors.Join(result, ErrInvalidEvidence)
		}
		caseSensitive, err := resource.directory.ReinspectCaseSensitivity()
		if err != nil || caseSensitive {
			result = errors.Join(result, ErrInvalidEvidence)
		}
		security, err := resource.directory.ReinspectSecurity()
		if err != nil || !reflect.DeepEqual(security, resource.object.Evidence.Security) {
			result = errors.Join(result, ErrInvalidEvidence)
		}
		if resource.enumeration != nil {
			current, err := resource.directory.Enumerate(resource.options)
			if err != nil || !reflect.DeepEqual(current, *resource.enumeration) {
				result = errors.Join(result, ErrInvalidEvidence)
			}
		}
	}
	return result
}

func (owner *handleOwner) close() (error, bool) {
	if owner == nil {
		return nil, false
	}
	owner.mu.Lock()
	defer owner.mu.Unlock()
	var result error
	unresolved := false
	for index := len(owner.objects) - 1; index >= 0; index-- {
		resource := &owner.objects[index]
		var close func() error
		if resource.file != nil {
			close = resource.file.Close
		} else if resource.directory != nil {
			close = resource.directory.Close
		} else {
			continue
		}
		closed := false
		for attempt := 0; attempt < closeAttempts; attempt++ {
			if err := close(); err != nil {
				result = errors.Join(result, ErrCleanup)
				continue
			}
			closed = true
			break
		}
		if !closed {
			unresolved = true
			continue
		}
		resource.file = nil
		resource.directory = nil
	}
	if !unresolved {
		owner.objects = nil
	}
	return result, unresolved
}

func cloneEnumeration(value winfile.DirectoryEnumeration) winfile.DirectoryEnumeration {
	value.Entries = append([]winfile.DirectoryEntry(nil), value.Entries...)
	return value
}

func cloneObjectEvidence(value secureconfig.ObjectEvidence) secureconfig.ObjectEvidence {
	value.Evidence.Security.SelfRelativeDescriptor = append(
		[]byte(nil), value.Evidence.Security.SelfRelativeDescriptor...,
	)
	return value
}

func nilInterface(value any) bool {
	if value == nil {
		return true
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return reflected.IsNil()
	default:
		return false
	}
}
