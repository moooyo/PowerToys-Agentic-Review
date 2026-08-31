package winfile

import (
	"fmt"
	"io"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	fileAttributeDirectory    uint32 = 0x00000010
	fileAttributeReparsePoint uint32 = 0x00000400
	filePersistentACLs        uint32 = 0x00000008
	fileReadOnlyVolume        uint32 = 0x00080000
	driveTypeFixed            uint32 = 3
	maximumWindowsPathUnits          = 32_767
	securityDACLPresent       uint16 = 0x0004
	securityDACLProtected     uint16 = 0x1000
	securitySelfRelative      uint16 = 0x8000
)

type fileAttributeTagInfo struct {
	FileAttributes uint32
	ReparseTag     uint32
}

type fileIDInfo struct {
	VolumeSerialNumber uint64
	FileID             [16]byte
}

type fileStandardInfo struct {
	AllocationSize int64
	EndOfFile      int64
	NumberOfLinks  uint32
	DeletePending  byte
	Directory      byte
}

type fileBasicInfo struct {
	CreationTime   int64
	LastAccessTime int64
	LastWriteTime  int64
	ChangeTime     int64
	FileAttributes uint32
}

type objectSnapshot struct {
	attribute fileAttributeTagInfo
	identity  fileIDInfo
	standard  fileStandardInfo
	basic     fileBasicInfo
}

type volumeFacts struct {
	fileSystem         string
	flags              uint32
	handleSerialNumber uint32
	pathSerialNumber   uint32
	driveType          uint32
}

func validateOpenRequest(path string, kind ObjectKind, options OpenOptions) error {
	if err := validateWindowsLocalPath(path); err != nil {
		return err
	}
	if kind != ObjectKindFile && kind != ObjectKindDirectory {
		return fmt.Errorf("%w: unknown object kind", ErrInvalidOptions)
	}
	if options.VolumeUse != VolumeUseReadOnly && options.VolumeUse != VolumeUseWritable {
		return fmt.Errorf("%w: volume use must be read-only or writable", ErrInvalidOptions)
	}
	if kind != ObjectKindDirectory && options.DirectoryEnumeration {
		return fmt.Errorf("%w: directory enumeration access requires a directory", ErrInvalidOptions)
	}
	if options.SecurityMode != SecurityModeManaged && options.SecurityMode != SecurityModeAmbientAncestor {
		return fmt.Errorf("%w: unknown security mode", ErrInvalidOptions)
	}
	if options.SecurityMode == SecurityModeAmbientAncestor && kind != ObjectKindDirectory {
		return fmt.Errorf("%w: ambient ancestor security mode requires a directory", ErrInvalidOptions)
	}
	return nil
}

func validateSecurityDescriptorForMode(security SecurityDescriptorEvidence, mode SecurityMode) error {
	if mode != SecurityModeManaged && mode != SecurityModeAmbientAncestor {
		return fmt.Errorf("%w: unknown security mode", ErrInvalidOptions)
	}
	requiredControl := securityDACLPresent | securitySelfRelative
	if security.OwnerSID == "" || security.GroupSID == "" ||
		!security.DACLPresent || security.DACLNull ||
		security.Control&requiredControl != requiredControl ||
		len(security.SelfRelativeDescriptor) == 0 {
		return fmt.Errorf("%w: security descriptor lacks a valid owner, group, or DACL", ErrUnsafeSecurityDescriptor)
	}
	protectedByControl := security.Control&securityDACLProtected != 0
	if security.DACLProtected != protectedByControl {
		return fmt.Errorf("%w: DACL protection evidence is inconsistent", ErrUnsafeSecurityDescriptor)
	}
	if mode == SecurityModeManaged && (!security.DACLProtected ||
		security.OwnerDefaulted || security.GroupDefaulted || security.DACLDefaulted) {
		return fmt.Errorf("%w: managed security must be protected and non-defaulted", ErrUnsafeSecurityDescriptor)
	}
	return nil
}

func validateReadOptions(options ReadOptions) error {
	if options.MaximumBytes == 0 || options.MaximumBytes > maximumReadableBytes() {
		return fmt.Errorf("%w: maximum bytes is outside the supported range", ErrInvalidOptions)
	}
	if options.VolumeUse != VolumeUseReadOnly && options.VolumeUse != VolumeUseWritable {
		return fmt.Errorf("%w: volume use must be read-only or writable", ErrInvalidOptions)
	}
	return nil
}

func validateWindowsLocalPath(path string) error {
	if !utf8.ValidString(path) || strings.ContainsRune(path, utf8.RuneError) || strings.ContainsRune(path, '\x00') {
		return fmt.Errorf("%w: path is not well-formed Unicode", ErrInvalidPath)
	}
	if len(utf16.Encode([]rune(path))) > maximumWindowsPathUnits {
		return fmt.Errorf("%w: path exceeds the Windows UTF-16 limit", ErrInvalidPath)
	}
	if len(path) < 3 || path[0] < 'A' || path[0] > 'Z' || path[1] != ':' || path[2] != '\\' {
		return fmt.Errorf("%w: expected an absolute drive path with an uppercase drive letter", ErrInvalidPath)
	}
	if strings.Contains(path, "/") || strings.Contains(path[2:], ":") {
		return fmt.Errorf("%w: alternate separators and data streams are not permitted", ErrInvalidPath)
	}
	if len(path) == 3 {
		return nil
	}
	if strings.HasSuffix(path, `\`) {
		return fmt.Errorf("%w: trailing separators are not canonical", ErrInvalidPath)
	}
	for _, component := range strings.Split(path[3:], `\`) {
		if err := validatePathComponent(component); err != nil {
			return err
		}
	}
	return nil
}

func validatePathComponent(component string) error {
	if component == "" || component == "." || component == ".." {
		return fmt.Errorf("%w: empty and relative components are not permitted", ErrInvalidPath)
	}
	if strings.HasSuffix(component, ".") || strings.HasSuffix(component, " ") {
		return fmt.Errorf("%w: trailing dots and spaces are not canonical", ErrInvalidPath)
	}
	for _, character := range component {
		if character < 32 || strings.ContainsRune(`<>:"|?*`, character) {
			return fmt.Errorf("%w: component contains an invalid character", ErrInvalidPath)
		}
	}
	base := strings.ToUpper(strings.SplitN(component, ".", 2)[0])
	baseRunes := []rune(base)
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
		base == "CONIN$" || base == "CONOUT$" || base == "CLOCK$" ||
		(len(baseRunes) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) &&
			isReservedDeviceDigit(baseRunes[3])) {
		return fmt.Errorf("%w: component is a reserved Windows device name", ErrInvalidPath)
	}
	return nil
}

func isReservedDeviceDigit(value rune) bool {
	return value >= '1' && value <= '9' || value == '\u00b9' || value == '\u00b2' || value == '\u00b3'
}

func validateSnapshot(snapshot objectSnapshot, expectedKind ObjectKind) error {
	if snapshot.attribute.FileAttributes&fileAttributeReparsePoint != 0 || snapshot.attribute.ReparseTag != 0 {
		return ErrReparsePoint
	}
	if snapshot.basic.FileAttributes != snapshot.attribute.FileAttributes {
		return fmt.Errorf("%w: attribute queries disagree", ErrObjectChanged)
	}
	directoryAttribute := snapshot.attribute.FileAttributes&fileAttributeDirectory != 0
	directoryStandard := snapshot.standard.Directory != 0
	if directoryAttribute != directoryStandard {
		return fmt.Errorf("%w: directory indicators disagree", ErrObjectChanged)
	}
	if expectedKind == ObjectKindFile && directoryAttribute || expectedKind == ObjectKindDirectory && !directoryAttribute {
		return fmt.Errorf("%w: expected %s", ErrWrongObjectType, expectedKind)
	}
	if snapshot.standard.DeletePending != 0 {
		return ErrDeletePending
	}
	if snapshot.standard.EndOfFile < 0 || snapshot.standard.AllocationSize < 0 {
		return fmt.Errorf("%w: negative file size", ErrObjectChanged)
	}
	if expectedKind == ObjectKindFile && snapshot.standard.NumberOfLinks != 1 {
		return fmt.Errorf("%w: observed %d links", ErrHardLinkedFile, snapshot.standard.NumberOfLinks)
	}
	return nil
}

func validateVolume(facts volumeFacts, use VolumeUse) error {
	if !strings.EqualFold(facts.fileSystem, "NTFS") || facts.flags&filePersistentACLs == 0 {
		return fmt.Errorf("%w: filesystem=%q flags=0x%08x", ErrUnsupportedVolume, facts.fileSystem, facts.flags)
	}
	if facts.driveType != driveTypeFixed {
		return fmt.Errorf("%w: drive type=%d", ErrUnsupportedVolume, facts.driveType)
	}
	if facts.handleSerialNumber != facts.pathSerialNumber {
		return fmt.Errorf(
			"%w: handle serial=0x%08x path serial=0x%08x",
			ErrVolumeIdentityMismatch,
			facts.handleSerialNumber,
			facts.pathSerialNumber,
		)
	}
	if use == VolumeUseWritable && facts.flags&fileReadOnlyVolume != 0 {
		return ErrReadOnlyVolume
	}
	return nil
}

func compareSnapshots(before objectSnapshot, after objectSnapshot) error {
	if before.identity != after.identity {
		return ErrIdentityChanged
	}
	if before.attribute != after.attribute ||
		before.standard != after.standard ||
		before.basic.CreationTime != after.basic.CreationTime ||
		before.basic.LastWriteTime != after.basic.LastWriteTime ||
		before.basic.ChangeTime != after.basic.ChangeTime ||
		before.basic.FileAttributes != after.basic.FileAttributes {
		return ErrObjectChanged
	}
	return nil
}

func maximumReadableBytes() uint64 {
	maximumInt := uint64(^uint(0) >> 1)
	maximumInt64 := uint64(^uint64(0) >> 1)
	if maximumInt < maximumInt64 {
		return maximumInt - 1
	}
	return maximumInt64 - 1
}

func readBounded(reader io.Reader, maximumBytes uint64) ([]byte, error) {
	if maximumBytes == 0 || maximumBytes > maximumReadableBytes() {
		return nil, fmt.Errorf("%w: maximum bytes is outside the supported range", ErrInvalidOptions)
	}
	limited := io.LimitReader(reader, int64(maximumBytes)+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if uint64(len(data)) > maximumBytes {
		return nil, ErrTooLarge
	}
	return data, nil
}
