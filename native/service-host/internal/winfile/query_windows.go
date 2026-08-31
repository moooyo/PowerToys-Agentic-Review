//go:build windows

package winfile

import (
	"errors"
	"fmt"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	fileAttributeTagInfoSize       = 8
	fileIDInfoSize                 = 24
	fileStandardInfoSize           = 24
	fileBasicInfoSize              = 40
	fileSystemNameBufferUnits      = 64
	volumePathBufferUnits          = 32_768
	initialFinalPathBufferUnits    = 512
	maximumFinalPathBufferUnits    = 32_768
	maximumSecurityDescriptorBytes = 1024 * 1024
	discardedHandleCloseAttempts   = 3
)

var (
	_ [fileAttributeTagInfoSize - unsafe.Sizeof(fileAttributeTagInfo{})]byte
	_ [unsafe.Sizeof(fileAttributeTagInfo{}) - fileAttributeTagInfoSize]byte
	_ [fileIDInfoSize - unsafe.Sizeof(fileIDInfo{})]byte
	_ [unsafe.Sizeof(fileIDInfo{}) - fileIDInfoSize]byte
	_ [fileStandardInfoSize - unsafe.Sizeof(fileStandardInfo{})]byte
	_ [unsafe.Sizeof(fileStandardInfo{}) - fileStandardInfoSize]byte
	_ [fileBasicInfoSize - unsafe.Sizeof(fileBasicInfo{})]byte
	_ [unsafe.Sizeof(fileBasicInfo{}) - fileBasicInfoSize]byte
)

func openObject(path string, kind ObjectKind, options OpenOptions) (result openedObject, err error) {
	if err := validateOpenRequest(path, kind, options); err != nil {
		return openedObject{}, err
	}
	pathPointer, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return openedObject{}, fmt.Errorf("encode object path: %w", err)
	}

	desiredAccess := uint32(windows.READ_CONTROL | windows.FILE_READ_ATTRIBUTES)
	flags := uint32(windows.FILE_FLAG_OPEN_REPARSE_POINT)
	shareMode := uint32(windows.FILE_SHARE_READ)
	if kind == ObjectKindFile {
		desiredAccess |= windows.GENERIC_READ
	} else {
		if options.DirectoryEnumeration {
			desiredAccess |= windows.FILE_LIST_DIRECTORY
		}
		flags |= windows.FILE_FLAG_BACKUP_SEMANTICS
		shareMode |= windows.FILE_SHARE_WRITE
	}
	handle, err := windows.CreateFile(
		pathPointer,
		desiredAccess,
		shareMode,
		nil,
		windows.OPEN_EXISTING,
		flags,
		0,
	)
	if err != nil {
		return openedObject{}, fmt.Errorf("CreateFileW %s: %w", kind, err)
	}
	defer func() {
		if err != nil {
			err = errors.Join(err, closeDiscardedHandle(handle, "close rejected object handle", windows.CloseHandle))
		}
	}()

	fileType, err := windows.GetFileType(handle)
	if err != nil {
		return openedObject{}, fmt.Errorf("GetFileType: %w", err)
	}
	if fileType != windows.FILE_TYPE_DISK {
		return openedObject{}, fmt.Errorf("%w: file type=%d", ErrNotDiskObject, fileType)
	}

	before, err := querySnapshot(handle, kind)
	if err != nil {
		return openedObject{}, fmt.Errorf("inspect opened %s: %w", kind, err)
	}
	beforeAuxiliary, err := queryObjectAuxiliarySnapshot(handle, kind, uint64(before.standard.EndOfFile))
	if err != nil {
		return openedObject{}, fmt.Errorf("inspect opened %s streams and case mode: %w", kind, err)
	}
	volume, err := inspectVolume(handle, path, options.VolumeUse)
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
		return openedObject{}, fmt.Errorf("reinspect opened %s: %w", kind, err)
	}
	if err := compareSnapshots(before, after); err != nil {
		return openedObject{}, fmt.Errorf("verify stable %s inspection: %w", kind, err)
	}
	afterAuxiliary, err := queryObjectAuxiliarySnapshot(handle, kind, uint64(after.standard.EndOfFile))
	if err != nil {
		return openedObject{}, fmt.Errorf("reinspect opened %s streams and case mode: %w", kind, err)
	}
	if err := compareObjectAuxiliarySnapshots(beforeAuxiliary, afterAuxiliary); err != nil {
		return openedObject{}, fmt.Errorf("verify stable %s auxiliary inspection: %w", kind, err)
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
			RequestedPath:                path,
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

func querySnapshot(handle windows.Handle, expectedKind ObjectKind) (objectSnapshot, error) {
	snapshot := objectSnapshot{}
	if err := windows.GetFileInformationByHandleEx(
		handle,
		windows.FileAttributeTagInfo,
		(*byte)(unsafe.Pointer(&snapshot.attribute)),
		uint32(unsafe.Sizeof(snapshot.attribute)),
	); err != nil {
		return objectSnapshot{}, fmt.Errorf("FileAttributeTagInfo: %w", err)
	}
	if err := windows.GetFileInformationByHandleEx(
		handle,
		windows.FileIdInfo,
		(*byte)(unsafe.Pointer(&snapshot.identity)),
		uint32(unsafe.Sizeof(snapshot.identity)),
	); err != nil {
		return objectSnapshot{}, fmt.Errorf("FileIdInfo: %w", err)
	}
	if err := windows.GetFileInformationByHandleEx(
		handle,
		windows.FileStandardInfo,
		(*byte)(unsafe.Pointer(&snapshot.standard)),
		uint32(unsafe.Sizeof(snapshot.standard)),
	); err != nil {
		return objectSnapshot{}, fmt.Errorf("FileStandardInfo: %w", err)
	}
	if err := windows.GetFileInformationByHandleEx(
		handle,
		windows.FileBasicInfo,
		(*byte)(unsafe.Pointer(&snapshot.basic)),
		uint32(unsafe.Sizeof(snapshot.basic)),
	); err != nil {
		return objectSnapshot{}, fmt.Errorf("FileBasicInfo: %w", err)
	}
	if err := validateSnapshot(snapshot, expectedKind); err != nil {
		return objectSnapshot{}, err
	}
	return snapshot, nil
}

func inspectVolume(handle windows.Handle, path string, use VolumeUse) (VolumeEvidence, error) {
	fileSystemName := make([]uint16, fileSystemNameBufferUnits)
	var handleSerialNumber uint32
	var fileSystemFlags uint32
	if err := windows.GetVolumeInformationByHandle(
		handle,
		nil,
		0,
		&handleSerialNumber,
		nil,
		&fileSystemFlags,
		&fileSystemName[0],
		uint32(len(fileSystemName)),
	); err != nil {
		return VolumeEvidence{}, fmt.Errorf("GetVolumeInformationByHandleW: %w", err)
	}

	pathPointer, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return VolumeEvidence{}, fmt.Errorf("encode volume lookup path: %w", err)
	}
	volumePathBuffer := make([]uint16, volumePathBufferUnits)
	if err := windows.GetVolumePathName(pathPointer, &volumePathBuffer[0], uint32(len(volumePathBuffer))); err != nil {
		return VolumeEvidence{}, fmt.Errorf("GetVolumePathNameW: %w", err)
	}
	volumePath := windows.UTF16ToString(volumePathBuffer)
	if volumePath == "" {
		return VolumeEvidence{}, fmt.Errorf("%w: GetVolumePathNameW returned an empty path", ErrUnsupportedVolume)
	}
	driveType := windows.GetDriveType(&volumePathBuffer[0])

	var pathSerialNumber uint32
	if err := windows.GetVolumeInformation(
		&volumePathBuffer[0],
		nil,
		0,
		&pathSerialNumber,
		nil,
		nil,
		nil,
		0,
	); err != nil {
		return VolumeEvidence{}, fmt.Errorf("GetVolumeInformationW for volume path: %w", err)
	}
	facts := volumeFacts{
		fileSystem:         windows.UTF16ToString(fileSystemName),
		flags:              fileSystemFlags,
		handleSerialNumber: handleSerialNumber,
		pathSerialNumber:   pathSerialNumber,
		driveType:          driveType,
	}
	if err := validateVolume(facts, use); err != nil {
		return VolumeEvidence{}, err
	}
	return VolumeEvidence{
		FileSystem:             facts.fileSystem,
		FileSystemFlags:        facts.flags,
		HandleSerialNumber:     facts.handleSerialNumber,
		PathSerialNumber:       facts.pathSerialNumber,
		VolumePath:             volumePath,
		DriveType:              facts.driveType,
		PersistentACLs:         true,
		ReadOnly:               facts.flags&fileReadOnlyVolume != 0,
		RequiredUse:            use,
		PathIdentityCrossCheck: true,
	}, nil
}

func inspectSecurityDescriptor(handle windows.Handle, mode SecurityMode) (SecurityDescriptorEvidence, error) {
	securityInformation := windows.SECURITY_INFORMATION(windows.OWNER_SECURITY_INFORMATION |
		windows.GROUP_SECURITY_INFORMATION |
		windows.DACL_SECURITY_INFORMATION)
	descriptor, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, securityInformation)
	if err != nil {
		return SecurityDescriptorEvidence{}, fmt.Errorf("GetSecurityInfo: %w", err)
	}
	if descriptor == nil || !descriptor.IsValid() {
		return SecurityDescriptorEvidence{}, fmt.Errorf("%w: invalid descriptor", ErrUnsafeSecurityDescriptor)
	}
	control, revision, err := descriptor.Control()
	if err != nil {
		return SecurityDescriptorEvidence{}, fmt.Errorf("read security descriptor control: %w", err)
	}
	if control&windows.SE_DACL_PRESENT == 0 {
		return SecurityDescriptorEvidence{}, fmt.Errorf("%w: DACL is absent", ErrUnsafeSecurityDescriptor)
	}
	if control&windows.SE_SELF_RELATIVE == 0 {
		return SecurityDescriptorEvidence{}, fmt.Errorf("%w: descriptor is not self-relative", ErrUnsafeSecurityDescriptor)
	}
	dacl, daclDefaulted, err := descriptor.DACL()
	if err != nil {
		return SecurityDescriptorEvidence{}, fmt.Errorf("read security descriptor DACL: %w", err)
	}
	if dacl == nil {
		return SecurityDescriptorEvidence{}, fmt.Errorf("%w: DACL is null", ErrUnsafeSecurityDescriptor)
	}
	owner, ownerDefaulted, err := descriptor.Owner()
	if err != nil {
		return SecurityDescriptorEvidence{}, fmt.Errorf("read security descriptor owner: %w", err)
	}
	group, groupDefaulted, err := descriptor.Group()
	if err != nil {
		return SecurityDescriptorEvidence{}, fmt.Errorf("read security descriptor group: %w", err)
	}
	if owner == nil || !owner.IsValid() || group == nil || !group.IsValid() {
		return SecurityDescriptorEvidence{}, fmt.Errorf("%w: owner or group SID is invalid", ErrUnsafeSecurityDescriptor)
	}
	ownerSID := owner.String()
	groupSID := group.String()
	if ownerSID == "" || groupSID == "" {
		return SecurityDescriptorEvidence{}, fmt.Errorf("%w: owner or group SID cannot be rendered", ErrUnsafeSecurityDescriptor)
	}
	descriptorLength := descriptor.Length()
	if descriptorLength == 0 || descriptorLength > maximumSecurityDescriptorBytes {
		return SecurityDescriptorEvidence{}, fmt.Errorf(
			"%w: descriptor length %d is outside the supported range",
			ErrUnsafeSecurityDescriptor,
			descriptorLength,
		)
	}
	descriptorBytes := unsafe.Slice((*byte)(unsafe.Pointer(descriptor)), int(descriptorLength))
	selfRelative := append([]byte(nil), descriptorBytes...)
	runtime.KeepAlive(descriptor)
	evidence := SecurityDescriptorEvidence{
		OwnerSID:               ownerSID,
		GroupSID:               groupSID,
		OwnerDefaulted:         ownerDefaulted,
		GroupDefaulted:         groupDefaulted,
		DACLPresent:            true,
		DACLNull:               false,
		DACLDefaulted:          daclDefaulted,
		DACLProtected:          control&windows.SE_DACL_PROTECTED != 0,
		Control:                uint16(control),
		Revision:               revision,
		SelfRelativeDescriptor: selfRelative,
	}
	if err := validateSecurityDescriptorForMode(evidence, mode); err != nil {
		return SecurityDescriptorEvidence{}, err
	}
	return evidence, nil
}

func finalPathDiagnostic(handle windows.Handle) (string, error) {
	size := uint32(initialFinalPathBufferUnits)
	for size <= maximumFinalPathBufferUnits {
		buffer := make([]uint16, size)
		length, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], size, 0)
		if err != nil {
			return "", fmt.Errorf("GetFinalPathNameByHandleW: %w", err)
		}
		if length == 0 {
			return "", errors.New("GetFinalPathNameByHandleW returned an empty path")
		}
		if length < size {
			return windows.UTF16ToString(buffer[:length]), nil
		}
		if length >= maximumFinalPathBufferUnits {
			break
		}
		size = length + 1
	}
	return "", fmt.Errorf("GetFinalPathNameByHandleW exceeded %d UTF-16 units", maximumFinalPathBufferUnits)
}

func closeDiscardedHandle(
	handle windows.Handle,
	operation string,
	closeHandle func(windows.Handle) error,
) error {
	if handle == 0 || handle == windows.InvalidHandle {
		return nil
	}
	if closeHandle == nil {
		closeHandle = windows.CloseHandle
	}
	var failures []error
	for attempt := 1; attempt <= discardedHandleCloseAttempts; attempt++ {
		if err := closeHandle(handle); err != nil {
			failures = append(failures, fmt.Errorf("%s attempt %d: %w", operation, attempt, err))
			continue
		}
		return errors.Join(failures...)
	}
	return errors.Join(failures...)
}
