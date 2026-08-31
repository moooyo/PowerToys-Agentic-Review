package winacl

import (
	"errors"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

func TestAmbientProfileAcceptsTypicalProgramDataSemantics(t *testing.T) {
	evidence := fixtureEvidence(t, descriptorFixture{
		ownerSID: localSystemSID,
		groupSID: localSystemSID,
		aces: []fixtureACE{
			{aceType: accessDeniedACEType, mask: writeDACL, sid: testEveryoneSID},
			{aceType: accessAllowedACEType, flags: aceObjectInherit | aceContainerInherit, mask: genericAll, sid: localSystemSID},
			{aceType: accessAllowedACEType, flags: aceObjectInherit | aceContainerInherit, mask: genericAll, sid: builtinAdministratorsSID},
			{
				aceType: accessAllowedACEType,
				flags:   aceObjectInherit | aceContainerInherit | aceInheritOnly,
				mask:    genericAll,
				sid:     creatorOwnerSID,
			},
			{
				aceType: accessAllowedACEType,
				flags:   aceObjectInherit | aceContainerInherit,
				mask:    genericRead,
				sid:     testUsersSID,
			},
			{
				aceType: accessAllowedACEType,
				flags:   aceContainerInherit,
				mask:    fileWriteData | fileAppendData,
				sid:     testUsersSID,
			},
			{
				aceType: accessAllowedACEType,
				flags:   aceObjectInherit | aceContainerInherit,
				mask:    genericRead,
				sid:     "S-1-5-11",
			},
		},
	})
	if err := Audit(evidence, winfile.ObjectKindDirectory, NewAmbientAncestorProfile()); err != nil {
		t.Fatalf("Audit rejected typical ProgramData semantics: %v", err)
	}
}

func TestAmbientProfileAllowsSiblingCreationButRejectsObjectMutation(t *testing.T) {
	tests := []struct {
		name    string
		mask    winfile.AccessMask
		allowed bool
	}{
		{name: "add file", mask: fileWriteData, allowed: true},
		{name: "add directory", mask: fileAppendData, allowed: true},
		{name: "add siblings", mask: fileWriteData | fileAppendData, allowed: true},
		{name: "write EA", mask: fileWriteEA},
		{name: "write attributes", mask: fileWriteAttributes},
		{name: "delete child", mask: fileDeleteChild},
		{name: "delete object", mask: deleteAccess},
		{name: "write DACL", mask: writeDACL},
		{name: "write owner", mask: writeOwner},
		{name: "generic write", mask: genericWrite},
		{name: "generic all", mask: genericAll},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			evidence := fixtureEvidence(t, descriptorFixture{aces: []fixtureACE{
				{aceType: accessAllowedACEType, mask: genericAll, sid: localSystemSID},
				{aceType: accessAllowedACEType, mask: test.mask, sid: testUsersSID},
			}})
			err := Audit(evidence, winfile.ObjectKindDirectory, NewAmbientAncestorProfile())
			if test.allowed && err != nil {
				t.Fatalf("Audit rejected permitted sibling creation: %v", err)
			}
			if !test.allowed && !errors.Is(err, ErrPolicyRejected) {
				t.Fatalf("Audit returned %v, want ErrPolicyRejected", err)
			}
		})
	}
}

func TestAmbientDenyNeverCancelsDangerousAllow(t *testing.T) {
	evidence := fixtureEvidence(t, descriptorFixture{aces: []fixtureACE{
		{aceType: accessDeniedACEType, mask: writeDACL, sid: testUsersSID},
		{aceType: accessAllowedACEType, mask: genericAll, sid: localSystemSID},
		{aceType: accessAllowedACEType, mask: writeDACL, sid: testUsersSID},
	}})
	if err := Audit(evidence, winfile.ObjectKindDirectory, NewAmbientAncestorProfile()); !errors.Is(err, ErrPolicyRejected) {
		t.Fatalf("dangerous allow plus deny returned %v, want ErrPolicyRejected", err)
	}
}

func TestAmbientCreatorOwnerIsRestrictedToInheritanceTemplates(t *testing.T) {
	tests := []struct {
		name    string
		ace     fixtureACE
		allowed bool
	}{
		{
			name: "inherit-only child template",
			ace: fixtureACE{
				aceType: accessAllowedACEType,
				flags:   aceObjectInherit | aceContainerInherit | aceInheritOnly,
				mask:    genericAll,
				sid:     creatorOwnerSID,
			},
			allowed: true,
		},
		{
			name: "applies to ambient directory",
			ace: fixtureACE{
				aceType: accessAllowedACEType,
				flags:   aceObjectInherit | aceContainerInherit,
				mask:    genericAll,
				sid:     creatorOwnerSID,
			},
		},
		{
			name: "inherit-only ordinary SID",
			ace: fixtureACE{
				aceType: accessAllowedACEType,
				flags:   aceContainerInherit | aceInheritOnly,
				mask:    genericAll,
				sid:     testUsersSID,
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			evidence := fixtureEvidence(t, descriptorFixture{aces: []fixtureACE{
				{aceType: accessAllowedACEType, mask: genericAll, sid: localSystemSID},
				test.ace,
			}})
			err := Audit(evidence, winfile.ObjectKindDirectory, NewAmbientAncestorProfile())
			if test.allowed && err != nil {
				t.Fatalf("Audit rejected CREATOR OWNER template: %v", err)
			}
			if !test.allowed && !errors.Is(err, ErrPolicyRejected) {
				t.Fatalf("Audit returned %v, want ErrPolicyRejected", err)
			}
		})
	}
}

func TestAmbientCanonicalOrderingAndInheritedACEs(t *testing.T) {
	valid := fixtureEvidence(t, descriptorFixture{aces: []fixtureACE{
		{aceType: accessDeniedACEType, mask: writeDACL, sid: testEveryoneSID},
		{aceType: accessAllowedACEType, mask: genericAll, sid: localSystemSID},
		{aceType: accessAllowedACEType, flags: aceInherited, mask: genericRead, sid: testUsersSID},
		{aceType: accessDeniedACEType, flags: aceInherited, mask: writeDACL, sid: testUsersSID},
	}})
	if err := Audit(valid, winfile.ObjectKindDirectory, NewAmbientAncestorProfile()); err != nil {
		t.Fatalf("Audit rejected canonical inherited ACE block: %v", err)
	}

	noncanonical := fixtureEvidence(t, descriptorFixture{aces: []fixtureACE{
		{aceType: accessAllowedACEType, mask: genericRead, sid: testUsersSID},
		{aceType: accessDeniedACEType, mask: writeDACL, sid: testUsersSID},
	}})
	if err := Audit(noncanonical, winfile.ObjectKindDirectory, NewAmbientAncestorProfile()); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("noncanonical DACL returned %v, want ErrInvalidEvidence", err)
	}
}

func TestAmbientProfileAcceptsTrustedInstallerOnlyAsTrustedOwnerAndTrustee(t *testing.T) {
	evidence := fixtureEvidence(t, descriptorFixture{
		ownerSID: trustedInstallerSID,
		aces: []fixtureACE{
			{aceType: accessAllowedACEType, mask: genericAll, sid: trustedInstallerSID},
			{aceType: accessAllowedACEType, mask: genericRead, sid: testUsersSID},
		},
	})
	if err := Audit(evidence, winfile.ObjectKindDirectory, NewAmbientAncestorProfile()); err != nil {
		t.Fatalf("Audit rejected TrustedInstaller ambient ACL: %v", err)
	}

	untrustedOwner := fixtureEvidence(t, descriptorFixture{ownerSID: testUsersSID})
	if err := Audit(untrustedOwner, winfile.ObjectKindDirectory, NewAmbientAncestorProfile()); !errors.Is(err, ErrPolicyRejected) {
		t.Fatalf("untrusted owner returned %v, want ErrPolicyRejected", err)
	}
}
