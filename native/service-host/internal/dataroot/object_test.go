package dataroot

import (
	"errors"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

func TestObjectSnapshotRejectsFabricatedSecurityFacts(t *testing.T) {
	current, _, _, fs := verificationFixture(config.RoleControl)
	path := current.Node.WorkingDirectory
	baseline := fs.nodes[path].evidence()
	tests := []struct {
		name   string
		mutate func(*winfile.Evidence)
	}{
		{name: "reparse attribute", mutate: func(value *winfile.Evidence) { value.Attributes |= fileAttributeReparsePoint }},
		{name: "hard-linked file", mutate: func(value *winfile.Evidence) {
			value.Kind = winfile.ObjectKindFile
			value.Attributes = 0x00000080
			value.LinkCount = 2
		}},
		{name: "kind attribute mismatch", mutate: func(value *winfile.Evidence) { value.Attributes = 0x00000080 }},
		{name: "non-NTFS", mutate: func(value *winfile.Evidence) { value.Volume.FileSystem = "ReFS" }},
		{name: "no persistent ACLs", mutate: func(value *winfile.Evidence) { value.Volume.PersistentACLs = false }},
		{name: "remote volume", mutate: func(value *winfile.Evidence) { value.Volume.DriveType = 4 }},
		{name: "read-only volume", mutate: func(value *winfile.Evidence) { value.Volume.ReadOnly = true }},
		{name: "read-only volume flag", mutate: func(value *winfile.Evidence) { value.Volume.FileSystemFlags |= fileReadOnlyVolume }},
		{name: "read-only inspection use", mutate: func(value *winfile.Evidence) { value.Volume.RequiredUse = winfile.VolumeUseReadOnly }},
		{name: "volume identity unchecked", mutate: func(value *winfile.Evidence) { value.Volume.PathIdentityCrossCheck = false }},
		{name: "volume identity mismatch", mutate: func(value *winfile.Evidence) { value.Volume.PathSerialNumber++ }},
		{name: "wrong volume path", mutate: func(value *winfile.Evidence) { value.Volume.VolumePath = `D:\` }},
		{name: "missing DACL", mutate: func(value *winfile.Evidence) { value.Security.DACLPresent = false }},
		{name: "null DACL", mutate: func(value *winfile.Evidence) { value.Security.DACLNull = true }},
		{name: "unprotected managed DACL", mutate: func(value *winfile.Evidence) {
			value.Security.DACLProtected = false
			value.Security.Control &^= securityDACLProtected
		}},
		{name: "defaulted managed DACL", mutate: func(value *winfile.Evidence) { value.Security.DACLDefaulted = true }},
		{name: "final path case mismatch", mutate: func(value *winfile.Evidence) {
			value.Path.FinalPathDiagnostic = `\\?\C:\PROGRAMDATA\AgenticReview\Control\Work`
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := cloneWinfileEvidence(baseline)
			test.mutate(&candidate)
			if _, err := newObjectSnapshot(path, winfile.SecurityModeManaged, candidate); !errors.Is(err, ErrFilesystem) {
				t.Fatalf("newObjectSnapshot error = %v, want ErrFilesystem", err)
			}
		})
	}
}

func TestObjectSnapshotGetterReturnsDetachedEvidence(t *testing.T) {
	current, _, _, fs := verificationFixture(config.RoleControl)
	path := current.Node.WorkingDirectory
	snapshot, err := newObjectSnapshot(path, winfile.SecurityModeManaged, fs.nodes[path].evidence())
	if err != nil {
		t.Fatal(err)
	}
	first := snapshot.Evidence()
	first.Security.SelfRelativeDescriptor[0] ^= 0xff
	if snapshot.Evidence().Security.SelfRelativeDescriptor[0] == first.Security.SelfRelativeDescriptor[0] {
		t.Fatal("ObjectSnapshot.Evidence exposed mutable descriptor storage")
	}
}
