package winfile

import (
	"errors"
	"io"
	"strings"
	"testing"
)

func TestValidateWindowsLocalPath(t *testing.T) {
	tests := []struct {
		name string
		path string
		ok   bool
	}{
		{name: "file", path: `C:\Program Files\AgenticReview\config.json`, ok: true},
		{name: "volume root", path: `D:\`, ok: true},
		{name: "relative", path: `config.json`},
		{name: "UNC", path: `\\server\share\config.json`},
		{name: "lowercase drive", path: `c:\config.json`},
		{name: "forward slash", path: `C:/config.json`},
		{name: "data stream", path: `C:\config.json:payload`},
		{name: "relative component", path: `C:\safe\..\config.json`},
		{name: "trailing separator", path: `C:\safe\`},
		{name: "trailing space", path: `C:\safe \config.json`},
		{name: "device", path: `C:\safe\CON.txt`},
		{name: "superscript device", path: "C:\\safe\\COM\u00b9.txt"},
		{name: "NUL", path: "C:\\safe\\bad\x00name"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateWindowsLocalPath(test.path)
			if test.ok && err != nil {
				t.Fatalf("validateWindowsLocalPath rejected %q: %v", test.path, err)
			}
			if !test.ok && !errors.Is(err, ErrInvalidPath) {
				t.Fatalf("validateWindowsLocalPath accepted %q or returned the wrong error: %v", test.path, err)
			}
		})
	}
}

func TestValidateOpenAndReadOptions(t *testing.T) {
	if err := validateOpenRequest(
		`C:\safe\config.json`,
		ObjectKindFile,
		OpenOptions{VolumeUse: VolumeUseReadOnly},
	); err != nil {
		t.Fatalf("validateOpenRequest rejected valid options: %v", err)
	}
	if err := validateOpenRequest(
		`C:\safe\config.json`,
		ObjectKindUnknown,
		OpenOptions{VolumeUse: VolumeUseReadOnly},
	); !errors.Is(err, ErrInvalidOptions) {
		t.Fatalf("unknown kind returned the wrong error: %v", err)
	}
	if err := validateOpenRequest(
		`C:\safe\config.json`,
		ObjectKindFile,
		OpenOptions{VolumeUse: VolumeUseReadOnly, DirectoryEnumeration: true},
	); !errors.Is(err, ErrInvalidOptions) {
		t.Fatalf("file enumeration access returned the wrong error: %v", err)
	}
	if err := validateOpenRequest(
		`C:\safe`,
		ObjectKindDirectory,
		OpenOptions{VolumeUse: VolumeUseReadOnly, SecurityMode: SecurityModeAmbientAncestor},
	); err != nil {
		t.Fatalf("ambient ancestor mode was rejected: %v", err)
	}
	if err := validateOpenRequest(
		`C:\safe`,
		ObjectKindDirectory,
		OpenOptions{VolumeUse: VolumeUseReadOnly, SecurityMode: SecurityMode(255)},
	); !errors.Is(err, ErrInvalidOptions) {
		t.Fatalf("unknown security mode returned the wrong error: %v", err)
	}
	if err := validateOpenRequest(
		`C:\safe\config.json`,
		ObjectKindFile,
		OpenOptions{VolumeUse: VolumeUseReadOnly, SecurityMode: SecurityModeAmbientAncestor},
	); !errors.Is(err, ErrInvalidOptions) {
		t.Fatalf("file ambient ancestor mode returned the wrong error: %v", err)
	}
	if err := validateOpenRequest(
		`C:\safe\runtime.dat`,
		ObjectKindFile,
		OpenOptions{VolumeUse: VolumeUseWritable, SecurityMode: SecurityModeRoleDataInherited},
	); err != nil {
		t.Fatalf("inherited role data mode was rejected: %v", err)
	}
	if err := validateOpenRequest(
		`C:\safe\config.json`,
		ObjectKindFile,
		OpenOptions{},
	); !errors.Is(err, ErrInvalidOptions) {
		t.Fatalf("unknown volume use returned the wrong error: %v", err)
	}
	if err := validateReadOptions(ReadOptions{MaximumBytes: 0, VolumeUse: VolumeUseReadOnly}); !errors.Is(err, ErrInvalidOptions) {
		t.Fatalf("zero read limit returned the wrong error: %v", err)
	}
}

func TestValidateSecurityDescriptorForMode(t *testing.T) {
	managed := SecurityDescriptorEvidence{
		OwnerSID:               "S-1-5-18",
		GroupSID:               "S-1-5-18",
		DACLPresent:            true,
		DACLProtected:          true,
		Control:                securityDACLPresent | securityDACLProtected | securitySelfRelative,
		SelfRelativeDescriptor: []byte{1},
	}
	if err := validateSecurityDescriptorForMode(managed, SecurityModeManaged); err != nil {
		t.Fatalf("managed descriptor rejected: %v", err)
	}

	ambient := managed
	ambient.OwnerDefaulted = true
	ambient.GroupDefaulted = true
	ambient.DACLDefaulted = true
	ambient.DACLProtected = false
	ambient.Control &^= securityDACLProtected
	if err := validateSecurityDescriptorForMode(ambient, SecurityModeAmbientAncestor); err != nil {
		t.Fatalf("ambient descriptor rejected: %v", err)
	}
	if err := validateSecurityDescriptorForMode(ambient, SecurityModeManaged); !errors.Is(err, ErrUnsafeSecurityDescriptor) {
		t.Fatalf("managed mode accepted ambient descriptor: %v", err)
	}
	inherited := ambient
	inherited.Control |= securityDACLAutoInherited
	if err := validateSecurityDescriptorForMode(inherited, SecurityModeRoleDataInherited); err != nil {
		t.Fatalf("inherited role data descriptor rejected: %v", err)
	}
	withoutAutoInheritance := inherited
	withoutAutoInheritance.Control &^= securityDACLAutoInherited
	if err := validateSecurityDescriptorForMode(withoutAutoInheritance, SecurityModeRoleDataInherited); !errors.Is(err, ErrUnsafeSecurityDescriptor) {
		t.Fatalf("role data mode accepted a non-inherited descriptor: %v", err)
	}
	protectedInherited := inherited
	protectedInherited.DACLProtected = true
	protectedInherited.Control |= securityDACLProtected
	if err := validateSecurityDescriptorForMode(protectedInherited, SecurityModeRoleDataInherited); !errors.Is(err, ErrUnsafeSecurityDescriptor) {
		t.Fatalf("role data mode accepted a protected descriptor: %v", err)
	}

	missingDACL := ambient
	missingDACL.DACLPresent = false
	missingDACL.Control &^= securityDACLPresent
	if err := validateSecurityDescriptorForMode(missingDACL, SecurityModeAmbientAncestor); !errors.Is(err, ErrUnsafeSecurityDescriptor) {
		t.Fatalf("ambient mode accepted missing DACL: %v", err)
	}
	if err := validateSecurityDescriptorForMode(managed, SecurityMode(255)); !errors.Is(err, ErrInvalidOptions) {
		t.Fatalf("unknown security mode returned %v", err)
	}
}

func TestValidateSnapshotAcceptsFileAndDirectory(t *testing.T) {
	if err := validateSnapshot(validFileSnapshot(), ObjectKindFile); err != nil {
		t.Fatalf("validateSnapshot rejected a file: %v", err)
	}
	directory := validFileSnapshot()
	directory.attribute.FileAttributes |= fileAttributeDirectory
	directory.basic.FileAttributes = directory.attribute.FileAttributes
	directory.standard.Directory = 1
	directory.standard.NumberOfLinks = 7
	if err := validateSnapshot(directory, ObjectKindDirectory); err != nil {
		t.Fatalf("validateSnapshot rejected a directory: %v", err)
	}
}

func TestValidateSnapshotRejectsUnsafeFacts(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*objectSnapshot)
		kind   ObjectKind
		err    error
	}{
		{
			name: "reparse attribute",
			mutate: func(value *objectSnapshot) {
				value.attribute.FileAttributes |= fileAttributeReparsePoint
				value.basic.FileAttributes = value.attribute.FileAttributes
			},
			kind: ObjectKindFile,
			err:  ErrReparsePoint,
		},
		{
			name:   "reparse tag",
			mutate: func(value *objectSnapshot) { value.attribute.ReparseTag = 0xa000000c },
			kind:   ObjectKindFile,
			err:    ErrReparsePoint,
		},
		{
			name: "attribute disagreement",
			mutate: func(value *objectSnapshot) {
				value.basic.FileAttributes++
			},
			kind: ObjectKindFile,
			err:  ErrObjectChanged,
		},
		{
			name: "directory indicator disagreement",
			mutate: func(value *objectSnapshot) {
				value.standard.Directory = 1
			},
			kind: ObjectKindFile,
			err:  ErrObjectChanged,
		},
		{
			name: "wrong kind",
			mutate: func(value *objectSnapshot) {
				value.attribute.FileAttributes |= fileAttributeDirectory
				value.basic.FileAttributes = value.attribute.FileAttributes
				value.standard.Directory = 1
			},
			kind: ObjectKindFile,
			err:  ErrWrongObjectType,
		},
		{
			name:   "hard link",
			mutate: func(value *objectSnapshot) { value.standard.NumberOfLinks = 2 },
			kind:   ObjectKindFile,
			err:    ErrHardLinkedFile,
		},
		{
			name:   "delete pending",
			mutate: func(value *objectSnapshot) { value.standard.DeletePending = 1 },
			kind:   ObjectKindFile,
			err:    ErrDeletePending,
		},
		{
			name:   "negative size",
			mutate: func(value *objectSnapshot) { value.standard.EndOfFile = -1 },
			kind:   ObjectKindFile,
			err:    ErrObjectChanged,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := validFileSnapshot()
			test.mutate(&value)
			if err := validateSnapshot(value, test.kind); !errors.Is(err, test.err) {
				t.Fatalf("validateSnapshot returned %v, want %v", err, test.err)
			}
		})
	}
}

func TestValidateVolume(t *testing.T) {
	valid := volumeFacts{
		fileSystem:         "NTFS",
		flags:              filePersistentACLs,
		handleSerialNumber: 0x1234,
		pathSerialNumber:   0x1234,
		driveType:          driveTypeFixed,
	}
	if err := validateVolume(valid, VolumeUseWritable); err != nil {
		t.Fatalf("validateVolume rejected valid facts: %v", err)
	}

	readOnly := valid
	readOnly.flags |= fileReadOnlyVolume
	if err := validateVolume(readOnly, VolumeUseReadOnly); err != nil {
		t.Fatalf("read-only use rejected a read-only volume: %v", err)
	}
	if err := validateVolume(readOnly, VolumeUseWritable); !errors.Is(err, ErrReadOnlyVolume) {
		t.Fatalf("writable use returned the wrong read-only error: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*volumeFacts)
		err    error
	}{
		{name: "filesystem", mutate: func(value *volumeFacts) { value.fileSystem = "ReFS" }, err: ErrUnsupportedVolume},
		{name: "ACLs", mutate: func(value *volumeFacts) { value.flags = 0 }, err: ErrUnsupportedVolume},
		{name: "drive", mutate: func(value *volumeFacts) { value.driveType = 4 }, err: ErrUnsupportedVolume},
		{name: "serial", mutate: func(value *volumeFacts) { value.pathSerialNumber++ }, err: ErrVolumeIdentityMismatch},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := valid
			test.mutate(&value)
			if err := validateVolume(value, VolumeUseReadOnly); !errors.Is(err, test.err) {
				t.Fatalf("validateVolume returned %v, want %v", err, test.err)
			}
		})
	}
}

func TestCompareSnapshotsDistinguishesIdentityAndContentChanges(t *testing.T) {
	before := validFileSnapshot()
	after := before
	if err := compareSnapshots(before, after); err != nil {
		t.Fatalf("compareSnapshots rejected equal snapshots: %v", err)
	}

	after.identity.FileID[15]++
	if err := compareSnapshots(before, after); !errors.Is(err, ErrIdentityChanged) {
		t.Fatalf("identity change returned the wrong error: %v", err)
	}

	after = before
	after.basic.ChangeTime++
	if err := compareSnapshots(before, after); !errors.Is(err, ErrObjectChanged) {
		t.Fatalf("metadata change returned the wrong error: %v", err)
	}

	after = before
	after.basic.LastAccessTime++
	if err := compareSnapshots(before, after); err != nil {
		t.Fatalf("last-access updates must not invalidate a read: %v", err)
	}
}

func TestReadBounded(t *testing.T) {
	data, err := readBounded(strings.NewReader("abc"), 3)
	if err != nil || string(data) != "abc" {
		t.Fatalf("readBounded returned %q, %v", data, err)
	}
	if _, err := readBounded(strings.NewReader("abc"), 2); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversized input returned the wrong error: %v", err)
	}
	if _, err := readBounded(errorReader{}, 8); !errors.Is(err, errFixtureRead) {
		t.Fatalf("reader failure returned the wrong error: %v", err)
	}
}

func TestCloneEvidenceDetachesSecurityDescriptor(t *testing.T) {
	original := Evidence{Security: SecurityDescriptorEvidence{SelfRelativeDescriptor: []byte{1, 2, 3}}}
	clone := cloneEvidence(original)
	clone.Security.SelfRelativeDescriptor[0] = 9
	if original.Security.SelfRelativeDescriptor[0] != 1 {
		t.Fatal("cloneEvidence aliased the original security descriptor")
	}
}

func validFileSnapshot() objectSnapshot {
	return objectSnapshot{
		attribute: fileAttributeTagInfo{FileAttributes: 0x20},
		identity: fileIDInfo{
			VolumeSerialNumber: 0x1020304050607080,
			FileID:             [16]byte{1, 2, 3, 4},
		},
		standard: fileStandardInfo{
			AllocationSize: 4_096,
			EndOfFile:      3,
			NumberOfLinks:  1,
		},
		basic: fileBasicInfo{
			CreationTime:   1,
			LastAccessTime: 2,
			LastWriteTime:  3,
			ChangeTime:     4,
			FileAttributes: 0x20,
		},
	}
}

var errFixtureRead = errors.New("fixture read failure")

type errorReader struct{}

func (errorReader) Read([]byte) (int, error) {
	return 0, errFixtureRead
}

var _ io.Reader = errorReader{}
