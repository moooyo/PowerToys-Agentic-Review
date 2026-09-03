package installerdestination

import (
	"errors"
	"reflect"
	"sync"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
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
	HashSHA256(winfile.HashOptions) (winfile.HashResult, error)
	VerifyAuthenticode(authenticode.Verifier) (authenticode.Evidence, error)
	VerifyUnchanged() error
	ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error)
	ReinspectDataStreams() ([]winfile.DataStream, error)
	Close() error
}

type securityCheck func(
	root outerpackage.Root,
	role outerpackage.Role,
	relativePath string,
	evidence winfile.Evidence,
	managed bool,
) error

type dependencies struct {
	acquireSource           func() sourceLease
	openTraversalRoot       func(string, winfile.OpenOptions) (directoryHandle, error)
	newAuthenticodeVerifier func() (authenticode.Verifier, error)
	checkSecurity           securityCheck
	admitDestination        func(sourcePlan) error
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

func (owner *handleOwner) addDirectory(path string, handle directoryHandle, object secureconfig.ObjectEvidence) int {
	owner.objects = append(owner.objects, retainedObject{path: path, directory: handle, object: cloneObjectEvidence(object)})
	return len(owner.objects) - 1
}

func (owner *handleOwner) addFile(path string, handle fileHandle, object secureconfig.ObjectEvidence) int {
	owner.objects = append(owner.objects, retainedObject{path: path, file: handle, object: cloneObjectEvidence(object)})
	return len(owner.objects) - 1
}

func (owner *handleOwner) setObject(index int, object secureconfig.ObjectEvidence) {
	owner.objects[index].object = cloneObjectEvidence(object)
}

func (owner *handleOwner) recordEnumeration(index int, value winfile.DirectoryEnumeration, options winfile.DirectoryEnumerationOptions) {
	copy := value
	copy.Entries = append([]winfile.DirectoryEntry(nil), value.Entries...)
	owner.objects[index].enumeration = &copy
	owner.objects[index].options = options
}

func (owner *handleOwner) recheck() error {
	if owner == nil {
		return ErrInvalidEvidence
	}
	owner.mu.Lock()
	defer owner.mu.Unlock()
	var result error
	for index := len(owner.objects) - 1; index >= 0; index-- {
		object := &owner.objects[index]
		if object.file != nil {
			if object.file.VerifyUnchanged() != nil {
				result = errors.Join(result, ErrInvalidEvidence)
			}
			if _, err := object.file.ReinspectDataStreams(); err != nil {
				result = errors.Join(result, ErrInvalidEvidence)
			}
			security, err := object.file.ReinspectSecurity()
			if err != nil || !reflect.DeepEqual(security, object.object.Evidence.Security) {
				result = errors.Join(result, ErrInvalidEvidence)
			}
			continue
		}
		if object.directory.VerifyUnchanged() != nil {
			result = errors.Join(result, ErrInvalidEvidence)
		}
		if _, err := object.directory.ReinspectDataStreams(); err != nil {
			result = errors.Join(result, ErrInvalidEvidence)
		}
		if sensitive, err := object.directory.ReinspectCaseSensitivity(); err != nil || sensitive {
			result = errors.Join(result, ErrInvalidEvidence)
		}
		security, err := object.directory.ReinspectSecurity()
		if err != nil || !reflect.DeepEqual(security, object.object.Evidence.Security) {
			result = errors.Join(result, ErrInvalidEvidence)
		}
		if object.enumeration != nil {
			current, err := object.directory.Enumerate(object.options)
			if err != nil || !reflect.DeepEqual(current, *object.enumeration) {
				result = errors.Join(result, ErrInvalidEvidence)
			}
		}
	}
	return result
}

func (owner *handleOwner) close() (error, bool) {
	if owner == nil {
		return ErrCleanup, false
	}
	owner.mu.Lock()
	defer owner.mu.Unlock()
	var result error
	unresolved := owner.objects[:0]
	for index := len(owner.objects) - 1; index >= 0; index-- {
		object := owner.objects[index]
		var closeErr error
		for attempt := 0; attempt < closeAttempts; attempt++ {
			if object.file != nil {
				closeErr = object.file.Close()
			} else {
				closeErr = object.directory.Close()
			}
			if closeErr == nil {
				break
			}
		}
		if closeErr != nil {
			result = errors.Join(result, closeErr)
			unresolved = append(unresolved, object)
		}
	}
	owner.objects = unresolved
	return result, len(unresolved) != 0
}

func cloneObjectEvidence(value secureconfig.ObjectEvidence) secureconfig.ObjectEvidence {
	value.Evidence.Security.SelfRelativeDescriptor = append([]byte(nil), value.Evidence.Security.SelfRelativeDescriptor...)
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
