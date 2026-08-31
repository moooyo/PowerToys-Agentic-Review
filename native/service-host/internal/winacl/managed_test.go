package winacl

import (
	"errors"
	"reflect"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

func TestManagedProfilesAcceptOnlyTheirExactSemanticACLs(t *testing.T) {
	installationDirectory, err := NewManagedInstallationDirectoryProfile(testControlSID, testExecutorSID)
	if err != nil {
		t.Fatal(err)
	}
	installationFile, err := NewManagedInstallationFileProfile(
		testControlSID,
		testExecutorSID,
		AccessRead,
		AccessReadExecute,
	)
	if err != nil {
		t.Fatal(err)
	}
	trustedDirectory, err := NewManagedTrustedDirectoryProfile(testControlSID, testExecutorSID)
	if err != nil {
		t.Fatal(err)
	}
	trustedFile, err := NewManagedTrustedFileProfile(testControlSID, testExecutorSID)
	if err != nil {
		t.Fatal(err)
	}

	directoryEntries := []fixtureACE{
		{aceType: accessAllowedACEType, mask: genericAll, sid: localSystemSID},
		{aceType: accessAllowedACEType, mask: fileAllAccess, sid: builtinAdministratorsSID},
		{aceType: accessAllowedACEType, mask: genericRead | genericExecute, sid: testControlSID},
		{aceType: accessAllowedACEType, mask: managedDirectoryRead, sid: testExecutorSID},
	}
	fileEntries := []fixtureACE{
		{aceType: accessAllowedACEType, mask: genericAll, sid: localSystemSID},
		{aceType: accessAllowedACEType, mask: fileAllAccess, sid: builtinAdministratorsSID},
		{aceType: accessAllowedACEType, mask: genericRead, sid: testControlSID},
		{aceType: accessAllowedACEType, mask: genericRead | genericExecute, sid: testExecutorSID},
	}
	trustedFileEntries := []fixtureACE{
		{aceType: accessAllowedACEType, mask: genericAll, sid: localSystemSID},
		{aceType: accessAllowedACEType, mask: fileAllAccess, sid: builtinAdministratorsSID},
		{aceType: accessAllowedACEType, mask: genericRead, sid: testControlSID},
		{aceType: accessAllowedACEType, mask: fileGenericRead, sid: testExecutorSID},
	}

	tests := []struct {
		name    string
		kind    winfile.ObjectKind
		profile PolicyProfile
		entries []fixtureACE
	}{
		{name: "installation directory", kind: winfile.ObjectKindDirectory, profile: installationDirectory, entries: directoryEntries},
		{name: "installation file", kind: winfile.ObjectKindFile, profile: installationFile, entries: fileEntries},
		{name: "trusted directory", kind: winfile.ObjectKindDirectory, profile: trustedDirectory, entries: directoryEntries},
		{name: "trusted file", kind: winfile.ObjectKindFile, profile: trustedFile, entries: trustedFileEntries},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			evidence := fixtureEvidence(t, descriptorFixture{daclProtected: true, aces: test.entries})
			if err := Audit(evidence, test.kind, test.profile); err != nil {
				t.Fatalf("Audit rejected exact managed ACL: %v", err)
			}
		})
	}
}

func TestManagedInstallationFileSupportsNoServiceAccess(t *testing.T) {
	profile, err := NewManagedInstallationFileProfile(
		testControlSID,
		testExecutorSID,
		AccessNone,
		AccessReadExecute,
	)
	if err != nil {
		t.Fatal(err)
	}
	evidence := fixtureEvidence(t, descriptorFixture{
		daclProtected: true,
		aces: []fixtureACE{
			{aceType: accessAllowedACEType, mask: genericAll, sid: localSystemSID},
			{aceType: accessAllowedACEType, mask: genericAll, sid: builtinAdministratorsSID},
			{aceType: accessAllowedACEType, mask: genericRead | genericExecute, sid: testExecutorSID},
		},
	})
	if err := Audit(evidence, winfile.ObjectKindFile, profile); err != nil {
		t.Fatalf("Audit rejected AccessNone ACL: %v", err)
	}
}

func TestManagedExactPolicyUsesNormalizedSemanticsNotComponentLayout(t *testing.T) {
	profile, err := NewManagedTrustedFileProfile(testControlSID, testExecutorSID)
	if err != nil {
		t.Fatal(err)
	}
	evidence := fixtureEvidence(t, descriptorFixture{
		daclProtected: true,
		aces: []fixtureACE{
			{aceType: accessAllowedACEType, mask: genericAll, sid: localSystemSID},
			{aceType: accessAllowedACEType, mask: genericAll, sid: builtinAdministratorsSID},
			{aceType: accessAllowedACEType, mask: genericRead, sid: testControlSID},
			{aceType: accessAllowedACEType, mask: genericRead, sid: testExecutorSID},
		},
	})
	evidence.SelfRelativeDescriptor = permuteDescriptorComponents(t, evidence.SelfRelativeDescriptor)
	if err := Audit(evidence, winfile.ObjectKindFile, profile); err != nil {
		t.Fatalf("Audit rejected an equivalent component layout: %v", err)
	}
}

func TestManagedFileRejectsDirectoryCreateBits(t *testing.T) {
	profile, err := NewManagedInstallationFileProfile(
		testControlSID,
		testExecutorSID,
		AccessRead,
		AccessRead,
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, mask := range []winfile.AccessMask{fileWriteData, fileAppendData} {
		evidence := fixtureEvidence(t, descriptorFixture{
			daclProtected: true,
			aces: []fixtureACE{
				{aceType: accessAllowedACEType, mask: genericAll, sid: localSystemSID},
				{aceType: accessAllowedACEType, mask: genericAll, sid: builtinAdministratorsSID},
				{aceType: accessAllowedACEType, mask: genericRead | mask, sid: testControlSID},
				{aceType: accessAllowedACEType, mask: genericRead, sid: testExecutorSID},
			},
		})
		if err := Audit(evidence, winfile.ObjectKindFile, profile); !errors.Is(err, ErrPolicyRejected) {
			t.Fatalf("file mutation mask 0x%x returned %v, want ErrPolicyRejected", mask, err)
		}
	}
}

func TestManagedAuditRejectsEveryACLDeviation(t *testing.T) {
	profile, err := NewManagedInstallationFileProfile(
		testControlSID,
		testExecutorSID,
		AccessRead,
		AccessReadExecute,
	)
	if err != nil {
		t.Fatal(err)
	}
	base := descriptorFixture{
		daclProtected: true,
		aces: []fixtureACE{
			{aceType: accessAllowedACEType, mask: genericAll, sid: localSystemSID},
			{aceType: accessAllowedACEType, mask: genericAll, sid: builtinAdministratorsSID},
			{aceType: accessAllowedACEType, mask: genericRead, sid: testControlSID},
			{aceType: accessAllowedACEType, mask: genericRead | genericExecute, sid: testExecutorSID},
		},
	}
	tests := []struct {
		name   string
		mutate func(*descriptorFixture)
	}{
		{name: "untrusted owner", mutate: func(value *descriptorFixture) { value.ownerSID = testUsersSID }},
		{name: "untrusted group", mutate: func(value *descriptorFixture) { value.groupSID = testUsersSID }},
		{name: "unprotected DACL", mutate: func(value *descriptorFixture) { value.daclProtected = false }},
		{name: "defaulted owner", mutate: func(value *descriptorFixture) { value.ownerDefaulted = true }},
		{name: "defaulted group", mutate: func(value *descriptorFixture) { value.groupDefaulted = true }},
		{name: "defaulted DACL", mutate: func(value *descriptorFixture) { value.daclDefaulted = true }},
		{name: "DS ACL revision", mutate: func(value *descriptorFixture) { value.aclRevision = 4 }},
		{name: "deny ACE", mutate: func(value *descriptorFixture) { value.aces[0].aceType = accessDeniedACEType }},
		{name: "inherited ACE", mutate: func(value *descriptorFixture) { value.aces[3].flags = aceInherited }},
		{name: "propagating ACE", mutate: func(value *descriptorFixture) { value.aces[3].flags = aceObjectInherit }},
		{name: "object ACE", mutate: func(value *descriptorFixture) { value.aces[0].aceType = 5 }},
		{name: "unexpected trustee", mutate: func(value *descriptorFixture) { value.aces[3].sid = testEveryoneSID }},
		{name: "wrong mask", mutate: func(value *descriptorFixture) { value.aces[2].mask |= fileExecute }},
		{name: "missing trustee", mutate: func(value *descriptorFixture) { value.aces = value.aces[:3] }},
		{name: "duplicate trustee", mutate: func(value *descriptorFixture) { value.aces[3].sid = testControlSID }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := base
			fixture.aces = append([]fixtureACE(nil), base.aces...)
			test.mutate(&fixture)
			evidence := fixtureEvidence(t, fixture)
			if err := Audit(evidence, winfile.ObjectKindFile, profile); err == nil {
				t.Fatal("Audit accepted a managed ACL deviation")
			}
		})
	}
}

func TestPolicyProfilesCannotBeConstructedAsAllowAll(t *testing.T) {
	typeOfProfile := reflect.TypeFor[PolicyProfile]()
	for index := 0; index < typeOfProfile.NumField(); index++ {
		if field := typeOfProfile.Field(index); field.IsExported() {
			t.Fatalf("PolicyProfile exposes authorizing field %s", field.Name)
		}
	}

	invalidProfiles := []struct {
		name    string
		profile func() (PolicyProfile, error)
	}{
		{name: "non-service control SID", profile: func() (PolicyProfile, error) {
			return NewManagedInstallationDirectoryProfile(testUsersSID, testExecutorSID)
		}},
		{name: "noncanonical executor SID", profile: func() (PolicyProfile, error) {
			return NewManagedInstallationDirectoryProfile(testControlSID, "S-1-5-80-06-7-8-9-10")
		}},
		{name: "same SID", profile: func() (PolicyProfile, error) {
			return NewManagedInstallationDirectoryProfile(testControlSID, testControlSID)
		}},
		{name: "TrustedInstaller", profile: func() (PolicyProfile, error) {
			return NewManagedInstallationDirectoryProfile(trustedInstallerSID, testExecutorSID)
		}},
		{name: "unknown access class", profile: func() (PolicyProfile, error) {
			return NewManagedInstallationFileProfile(testControlSID, testExecutorSID, AccessClass(99), AccessRead)
		}},
	}
	for _, test := range invalidProfiles {
		t.Run(test.name, func(t *testing.T) {
			if _, err := test.profile(); !errors.Is(err, ErrInvalidProfile) {
				t.Fatalf("constructor returned %v, want ErrInvalidProfile", err)
			}
		})
	}

	valid := fixtureEvidence(t, descriptorFixture{daclProtected: true})
	if err := Audit(valid, winfile.ObjectKindFile, PolicyProfile{}); !errors.Is(err, ErrInvalidProfile) {
		t.Fatalf("zero profile returned %v, want ErrInvalidProfile", err)
	}
	ambient := NewAmbientAncestorProfile()
	if err := Audit(valid, winfile.ObjectKindFile, ambient); !errors.Is(err, ErrInvalidProfile) {
		t.Fatalf("ambient file returned %v, want ErrInvalidProfile", err)
	}
}
