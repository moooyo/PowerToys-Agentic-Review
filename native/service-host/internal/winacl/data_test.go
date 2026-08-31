package winacl

import (
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

func TestRoleDataBoundaryCarriesExactSafeInheritanceTemplates(t *testing.T) {
	profile, err := NewManagedRoleDataBoundaryDirectoryProfile(testControlSID, testExecutorSID)
	if err != nil {
		t.Fatal(err)
	}
	evidence := fixtureEvidence(t, descriptorFixture{
		daclProtected: true,
		aces: []fixtureACE{
			{aceType: accessAllowedACEType, flags: aceObjectInherit | aceContainerInherit, mask: fileAllAccess, sid: localSystemSID},
			{aceType: accessAllowedACEType, flags: aceObjectInherit | aceContainerInherit, mask: fileAllAccess, sid: builtinAdministratorsSID},
			{aceType: accessAllowedACEType, mask: managedBoundaryDirectoryModify, sid: testControlSID},
			{aceType: accessAllowedACEType, flags: aceObjectInherit | aceInheritOnly, mask: managedFileModify, sid: testControlSID},
			{aceType: accessAllowedACEType, flags: aceContainerInherit | aceInheritOnly, mask: managedDirectoryModify, sid: testControlSID},
			{aceType: accessAllowedACEType, flags: aceObjectInherit | aceContainerInherit | aceInheritOnly, mask: readControl, sid: ownerRightsSID},
		},
	})
	if err := Audit(evidence, winfile.ObjectKindDirectory, profile); err != nil {
		t.Fatalf("Audit rejected the role data boundary template: %v", err)
	}
	if managedFileModify&fileExecute != 0 {
		t.Fatal("role data file Modify includes FILE_EXECUTE")
	}
	if managedDirectoryModify&fileExecute == 0 {
		t.Fatal("role data directory Modify omits traverse")
	}
	if managedBoundaryDirectoryModify&(deleteAccess|fileDeleteChild) != 0 {
		t.Fatal("boundary access can delete itself or a fixed child boundary")
	}
	if managedFileModify&(fileExecute|writeDACL|writeOwner) != 0 {
		t.Fatal("role data file Modify contains execute or security-control rights")
	}
}

func TestInheritedRoleDataAcceptsTypicalDirectoryAndFileACLs(t *testing.T) {
	directory, err := NewInheritedRoleDataDirectoryProfile(testControlSID, testExecutorSID)
	if err != nil {
		t.Fatal(err)
	}
	file, err := NewInheritedRoleDataFileProfile(testControlSID, testExecutorSID)
	if err != nil {
		t.Fatal(err)
	}
	directoryEvidence := fixtureEvidence(t, descriptorFixture{
		ownerSID: testControlSID, groupSID: testControlSID,
		ownerDefaulted: true, groupDefaulted: true, daclDefaulted: true,
		daclAutoInherited: true,
		aces: []fixtureACE{
			{aceType: accessAllowedACEType, flags: aceObjectInherit | aceContainerInherit | aceInherited, mask: fileAllAccess, sid: localSystemSID},
			{aceType: accessAllowedACEType, flags: aceObjectInherit | aceContainerInherit | aceInherited, mask: fileAllAccess, sid: builtinAdministratorsSID},
			{aceType: accessAllowedACEType, flags: aceObjectInherit | aceInheritOnly | aceInherited, mask: managedFileModify, sid: testControlSID},
			{aceType: accessAllowedACEType, flags: aceContainerInherit | aceInherited, mask: managedDirectoryModify, sid: testControlSID},
			{aceType: accessAllowedACEType, flags: aceObjectInherit | aceContainerInherit | aceInherited, mask: readControl, sid: ownerRightsSID},
		},
	})
	if err := Audit(directoryEvidence, winfile.ObjectKindDirectory, directory); err != nil {
		t.Fatalf("Audit rejected a typical inherited directory ACL: %v", err)
	}
	fileEvidence := fixtureEvidence(t, descriptorFixture{
		ownerSID: testControlSID, groupSID: testUsersSID,
		ownerDefaulted: true, groupDefaulted: true, daclDefaulted: true,
		daclAutoInherited: true,
		aces: []fixtureACE{
			{aceType: accessAllowedACEType, flags: aceInherited, mask: fileAllAccess, sid: localSystemSID},
			{aceType: accessAllowedACEType, flags: aceInherited, mask: fileAllAccess, sid: builtinAdministratorsSID},
			{aceType: accessAllowedACEType, flags: aceInherited, mask: managedFileModify, sid: testControlSID},
			{aceType: accessAllowedACEType, flags: aceInherited, mask: readControl, sid: ownerRightsSID},
		},
	})
	if err := Audit(fileEvidence, winfile.ObjectKindFile, file); err != nil {
		t.Fatalf("Audit rejected a typical inherited file ACL: %v", err)
	}
}

func TestRoleDataPoliciesRejectPeerUnexpectedAndElevatedAccess(t *testing.T) {
	boundary, err := NewManagedRoleDataBoundaryDirectoryProfile(testControlSID, testExecutorSID)
	if err != nil {
		t.Fatal(err)
	}
	inheritedFile, err := NewInheritedRoleDataFileProfile(testControlSID, testExecutorSID)
	if err != nil {
		t.Fatal(err)
	}
	boundaryEntries := []fixtureACE{
		{aceType: accessAllowedACEType, flags: aceObjectInherit | aceContainerInherit, mask: fileAllAccess, sid: localSystemSID},
		{aceType: accessAllowedACEType, flags: aceObjectInherit | aceContainerInherit, mask: fileAllAccess, sid: builtinAdministratorsSID},
		{aceType: accessAllowedACEType, mask: managedBoundaryDirectoryModify, sid: testControlSID},
		{aceType: accessAllowedACEType, flags: aceObjectInherit | aceInheritOnly, mask: managedFileModify, sid: testControlSID},
		{aceType: accessAllowedACEType, flags: aceContainerInherit | aceInheritOnly, mask: managedDirectoryModify, sid: testControlSID},
		{aceType: accessAllowedACEType, flags: aceObjectInherit | aceContainerInherit | aceInheritOnly, mask: readControl, sid: ownerRightsSID},
	}
	withPeer := append(append([]fixtureACE(nil), boundaryEntries...), fixtureACE{
		aceType: accessAllowedACEType, mask: fileGenericRead, sid: testExecutorSID,
	})
	if err := Audit(fixtureEvidence(t, descriptorFixture{daclProtected: true, aces: withPeer}), winfile.ObjectKindDirectory, boundary); err == nil {
		t.Fatal("Audit accepted a peer ACE on a role data boundary")
	}
	withoutOwnerRights := append([]fixtureACE(nil), boundaryEntries[:len(boundaryEntries)-1]...)
	if err := Audit(fixtureEvidence(t, descriptorFixture{daclProtected: true, aces: withoutOwnerRights}), winfile.ObjectKindDirectory, boundary); err == nil {
		t.Fatal("Audit accepted a boundary without OWNER RIGHTS inheritance")
	}
	autoInheritedBoundary := fixtureEvidence(t, descriptorFixture{
		daclProtected: true, daclAutoInherited: true, aces: boundaryEntries,
	})
	if err := Audit(autoInheritedBoundary, winfile.ObjectKindDirectory, boundary); err == nil {
		t.Fatal("Audit accepted an auto-inherited installer boundary")
	}
	genericBoundary := append([]fixtureACE(nil), boundaryEntries...)
	genericBoundary[0].mask = genericAll
	if err := Audit(fixtureEvidence(t, descriptorFixture{daclProtected: true, aces: genericBoundary}), winfile.ObjectKindDirectory, boundary); err == nil {
		t.Fatal("Audit accepted a generic inheritance mask")
	}

	baseFileEntries := []fixtureACE{
		{aceType: accessAllowedACEType, flags: aceInherited, mask: fileAllAccess, sid: localSystemSID},
		{aceType: accessAllowedACEType, flags: aceInherited, mask: fileAllAccess, sid: builtinAdministratorsSID},
		{aceType: accessAllowedACEType, flags: aceInherited, mask: managedFileModify, sid: testControlSID},
		{aceType: accessAllowedACEType, flags: aceInherited, mask: readControl, sid: ownerRightsSID},
	}
	for _, test := range []struct {
		name   string
		mutate func([]fixtureACE) []fixtureACE
	}{
		{name: "peer", mutate: func(entries []fixtureACE) []fixtureACE {
			return append(entries, fixtureACE{aceType: accessAllowedACEType, flags: aceInherited, mask: fileGenericRead, sid: testExecutorSID})
		}},
		{name: "unexpected trustee", mutate: func(entries []fixtureACE) []fixtureACE {
			entries[2].sid = testEveryoneSID
			return entries
		}},
		{name: "execute", mutate: func(entries []fixtureACE) []fixtureACE {
			entries[2].mask |= fileExecute
			return entries
		}},
		{name: "write DACL", mutate: func(entries []fixtureACE) []fixtureACE {
			entries[2].mask |= writeDACL
			return entries
		}},
		{name: "write owner", mutate: func(entries []fixtureACE) []fixtureACE {
			entries[2].mask |= writeOwner
			return entries
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			entries := test.mutate(append([]fixtureACE(nil), baseFileEntries...))
			evidence := fixtureEvidence(t, descriptorFixture{
				ownerSID: testControlSID, groupSID: testControlSID,
				daclAutoInherited: true, aces: entries,
			})
			if err := Audit(evidence, winfile.ObjectKindFile, inheritedFile); err == nil {
				t.Fatal("Audit accepted unsafe inherited role data")
			}
		})
	}
}

func TestInheritedRoleDataRejectsWrongOwnerAndInheritanceState(t *testing.T) {
	profile, err := NewInheritedRoleDataFileProfile(testControlSID, testExecutorSID)
	if err != nil {
		t.Fatal(err)
	}
	entries := []fixtureACE{
		{aceType: accessAllowedACEType, flags: aceInherited, mask: fileAllAccess, sid: localSystemSID},
		{aceType: accessAllowedACEType, flags: aceInherited, mask: fileAllAccess, sid: builtinAdministratorsSID},
		{aceType: accessAllowedACEType, flags: aceInherited, mask: managedFileModify, sid: testControlSID},
		{aceType: accessAllowedACEType, flags: aceInherited, mask: readControl, sid: ownerRightsSID},
	}
	for _, fixture := range []descriptorFixture{
		{ownerSID: localSystemSID, groupSID: localSystemSID, daclAutoInherited: true, aces: entries},
		{ownerSID: testControlSID, groupSID: testControlSID, daclProtected: true, daclAutoInherited: true, aces: entries},
		{ownerSID: testControlSID, groupSID: testControlSID, aces: entries},
	} {
		if err := Audit(fixtureEvidence(t, fixture), winfile.ObjectKindFile, profile); err == nil {
			t.Fatal("Audit accepted invalid inherited ownership or DACL state")
		}
	}
}
