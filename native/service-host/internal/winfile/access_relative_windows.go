//go:build windows

package winfile

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// OpenTraversalRoot opens a canonical drive root with the traverse access
// needed for subsequent handle-relative component opens.
func OpenTraversalRoot(path string, options OpenOptions) (result *Directory, err error) {
	if err := validateOpenRequest(path, ObjectKindDirectory, options); err != nil {
		return nil, err
	}
	if len(path) != 3 {
		return nil, fmt.Errorf("%w: traversal root must be a drive root", ErrInvalidPath)
	}
	pathPointer, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, fmt.Errorf("encode traversal root: %w", err)
	}
	desiredAccess := uint32(windows.READ_CONTROL | windows.FILE_READ_ATTRIBUTES | windows.FILE_TRAVERSE)
	if options.DirectoryEnumeration {
		desiredAccess |= windows.FILE_LIST_DIRECTORY
	}
	handle, err := windows.CreateFile(
		pathPointer,
		desiredAccess,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS,
		0,
	)
	if err != nil {
		return nil, fmt.Errorf("CreateFileW traversal root: %w", err)
	}
	opened, err := inspectRelativeOpenHandle(handle, path, ObjectKindDirectory, options)
	if err != nil {
		return nil, errors.Join(err, closeDiscardedHandle(handle, "close rejected traversal root handle", windows.CloseHandle))
	}
	return &Directory{
		handle:             opened.handle,
		baseline:           opened.baseline,
		auxiliary:          opened.auxiliary,
		evidence:           opened.evidence,
		enumerationAllowed: opened.enumerationAllowed,
	}, nil
}

// OpenDirectoryComponent opens exactly one child directory relative to this
// retained directory handle. It never resolves the child through an absolute
// path.
func (directory *Directory) OpenDirectoryComponent(component string, options OpenOptions) (*Directory, error) {
	opened, err := directory.openComponent(component, ObjectKindDirectory, options)
	if err != nil {
		return nil, err
	}
	return &Directory{
		handle:             opened.handle,
		baseline:           opened.baseline,
		auxiliary:          opened.auxiliary,
		evidence:           opened.evidence,
		enumerationAllowed: opened.enumerationAllowed,
	}, nil
}

// OpenFileComponent opens exactly one child file relative to this retained
// directory handle. The file grants only read sharing.
func (directory *Directory) OpenFileComponent(component string, options OpenOptions) (*File, error) {
	opened, err := directory.openComponent(component, ObjectKindFile, options)
	if err != nil {
		return nil, err
	}
	return &File{
		handle:    opened.handle,
		baseline:  opened.baseline,
		auxiliary: opened.auxiliary,
		evidence:  opened.evidence,
	}, nil
}

func (directory *Directory) openComponent(
	component string,
	kind ObjectKind,
	options OpenOptions,
) (openedObject, error) {
	if directory == nil {
		return openedObject{}, ErrClosed
	}
	if strings.ContainsAny(component, `\/`) {
		return openedObject{}, fmt.Errorf("%w: relative open requires exactly one component", ErrInvalidPath)
	}
	if err := validatePathComponent(component); err != nil {
		return openedObject{}, err
	}

	directory.mu.Lock()
	defer directory.mu.Unlock()
	if directory.closed || directory.handle == 0 {
		return openedObject{}, ErrClosed
	}
	parentPath := directory.evidence.Path.RequestedPath
	requestedPath := parentPath + `\` + component
	if len(parentPath) == 3 {
		requestedPath = parentPath + component
	}
	if err := validateOpenRequest(requestedPath, kind, options); err != nil {
		return openedObject{}, err
	}

	objectName, err := windows.NewNTUnicodeString(component)
	if err != nil {
		return openedObject{}, fmt.Errorf("encode relative component: %w", err)
	}
	attributes := &windows.OBJECT_ATTRIBUTES{
		Length:        uint32(unsafe.Sizeof(windows.OBJECT_ATTRIBUTES{})),
		RootDirectory: directory.handle,
		ObjectName:    objectName,
		Attributes:    windows.OBJ_CASE_INSENSITIVE | windows.OBJ_DONT_REPARSE,
	}
	desiredAccess := uint32(windows.READ_CONTROL | windows.FILE_READ_ATTRIBUTES | windows.SYNCHRONIZE)
	shareMode := uint32(windows.FILE_SHARE_READ)
	createOptions := uint32(windows.FILE_OPEN_REPARSE_POINT | windows.FILE_SYNCHRONOUS_IO_NONALERT)
	if kind == ObjectKindFile {
		desiredAccess |= windows.GENERIC_READ
		createOptions |= windows.FILE_NON_DIRECTORY_FILE
	} else {
		desiredAccess |= windows.FILE_TRAVERSE
		if options.DirectoryEnumeration {
			desiredAccess |= windows.FILE_LIST_DIRECTORY
		}
		shareMode |= windows.FILE_SHARE_WRITE
		createOptions |= windows.FILE_DIRECTORY_FILE
	}
	var handle windows.Handle
	var status windows.IO_STATUS_BLOCK
	ntErr := windows.NtCreateFile(
		&handle,
		desiredAccess,
		attributes,
		&status,
		nil,
		0,
		shareMode,
		windows.FILE_OPEN,
		createOptions,
		0,
		0,
	)
	runtime.KeepAlive(objectName)
	if ntErr != nil {
		var closeErr error
		if handle != 0 && handle != windows.InvalidHandle {
			closeErr = closeDiscardedHandle(handle, "close failed relative-open handle", windows.CloseHandle)
		}
		return openedObject{}, errors.Join(
			fmt.Errorf("NtCreateFile relative %s %q: %w", kind, component, ntErr),
			closeErr,
		)
	}
	opened, err := inspectRelativeOpenHandle(handle, requestedPath, kind, options)
	if err != nil {
		return openedObject{}, errors.Join(
			err,
			closeDiscardedHandle(handle, "close rejected relative-open handle", windows.CloseHandle),
		)
	}
	return opened, nil
}

func inspectRelativeOpenHandle(
	handle windows.Handle,
	requestedPath string,
	kind ObjectKind,
	options OpenOptions,
) (openedObject, error) {
	fileType, err := windows.GetFileType(handle)
	if err != nil {
		return openedObject{}, fmt.Errorf("GetFileType: %w", err)
	}
	if fileType != windows.FILE_TYPE_DISK {
		return openedObject{}, fmt.Errorf("%w: file type=%d", ErrNotDiskObject, fileType)
	}
	before, err := querySnapshot(handle, kind)
	if err != nil {
		return openedObject{}, fmt.Errorf("inspect relative %s: %w", kind, err)
	}
	beforeAuxiliary, err := queryObjectAuxiliarySnapshot(handle, kind, uint64(before.standard.EndOfFile))
	if err != nil {
		return openedObject{}, fmt.Errorf("inspect relative %s streams and case mode: %w", kind, err)
	}
	volume, err := inspectVolume(handle, requestedPath, options.VolumeUse)
	if err != nil {
		return openedObject{}, err
	}
	security, err := inspectSecurityDescriptor(handle, options.SecurityMode)
	if err != nil {
		return openedObject{}, err
	}
	finalPath, finalPathErr := finalPathDiagnostic(handle)
	after, err := querySnapshot(handle, kind)
	if err != nil {
		return openedObject{}, fmt.Errorf("reinspect relative %s: %w", kind, err)
	}
	if err := compareSnapshots(before, after); err != nil {
		return openedObject{}, fmt.Errorf("verify stable relative %s inspection: %w", kind, err)
	}
	afterAuxiliary, err := queryObjectAuxiliarySnapshot(handle, kind, uint64(after.standard.EndOfFile))
	if err != nil {
		return openedObject{}, fmt.Errorf("reinspect relative %s streams and case mode: %w", kind, err)
	}
	if err := compareObjectAuxiliarySnapshots(beforeAuxiliary, afterAuxiliary); err != nil {
		return openedObject{}, fmt.Errorf("verify stable relative %s auxiliary inspection: %w", kind, err)
	}
	finalPathError := ""
	if finalPathErr != nil {
		finalPathError = finalPathErr.Error()
	}
	evidence := Evidence{
		Kind: kind,
		Identity: FileIdentity{
			VolumeSerialNumber: after.identity.VolumeSerialNumber,
			FileID:             after.identity.FileID,
		},
		Attributes: after.attribute.FileAttributes,
		Size:       uint64(after.standard.EndOfFile),
		LinkCount:  after.standard.NumberOfLinks,
		Path: PathEvidence{
			RequestedPath:                requestedPath,
			TerminalComponentReparseFree: true,
			Ancestors:                    AncestorValidationNotPerformed,
			FinalPathDiagnostic:          finalPath,
			FinalPathDiagnosticError:     finalPathError,
		},
		Volume:       volume,
		SecurityMode: options.SecurityMode,
		Security:     security,
	}
	return openedObject{
		handle:             handle,
		baseline:           after,
		auxiliary:          afterAuxiliary,
		evidence:           evidence,
		enumerationAllowed: kind == ObjectKindDirectory && options.DirectoryEnumeration,
	}, nil
}

// ReinspectSecurity reads a detached security descriptor from the retained
// file handle.
func (file *File) ReinspectSecurity() (SecurityDescriptorEvidence, error) {
	if file == nil {
		return SecurityDescriptorEvidence{}, ErrClosed
	}
	file.mu.Lock()
	defer file.mu.Unlock()
	if file.closed || file.handle == 0 {
		return SecurityDescriptorEvidence{}, ErrClosed
	}
	return inspectSecurityDescriptor(file.handle, file.evidence.SecurityMode)
}

// ReinspectSecurity reads a detached security descriptor from the retained
// directory handle.
func (directory *Directory) ReinspectSecurity() (SecurityDescriptorEvidence, error) {
	if directory == nil {
		return SecurityDescriptorEvidence{}, ErrClosed
	}
	directory.mu.Lock()
	defer directory.mu.Unlock()
	if directory.closed || directory.handle == 0 {
		return SecurityDescriptorEvidence{}, ErrClosed
	}
	return inspectSecurityDescriptor(directory.handle, directory.evidence.SecurityMode)
}
