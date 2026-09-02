package winidentity

import (
	"errors"
	"sort"
	"strings"
	"testing"
)

const (
	testOwnServiceSID   = "S-1-5-80-1-2-3-4-5"
	testPeerServiceSID  = "S-1-5-80-6-7-8-9-10"
	testOtherServiceSID = "S-1-5-80-11-12-13-14-15"
	testLogonSID        = "S-1-5-5-100-200"
)

func TestCanonicalServiceSIDValidation(t *testing.T) {
	valid := []string{
		testOwnServiceSID,
		"S-1-5-80-0-0-0-0-0",
		"S-1-5-80-4294967295-4294967295-4294967295-4294967295-4294967295",
	}
	for _, sid := range valid {
		if err := validateCanonicalServiceSID(sid); err != nil {
			t.Fatalf("validateCanonicalServiceSID rejected %q: %v", sid, err)
		}
	}

	invalid := []string{
		"",
		"S-1-5-18",
		"S-1-5-80-1-2-3-4",
		"S-1-5-80-1-2-3-4-5-6",
		"S-1-5-80-01-2-3-4-5",
		"S-1-5-80-+1-2-3-4-5",
		"S-1-5-80--1-2-3-4-5",
		"S-1-5-80-4294967296-2-3-4-5",
		"s-1-5-80-1-2-3-4-5",
		"S-01-5-80-1-2-3-4-5",
		"S-1-05-80-1-2-3-4-5",
		"S-1-5-080-1-2-3-4-5",
	}
	for _, sid := range invalid {
		if err := validateCanonicalServiceSID(sid); err == nil {
			t.Fatalf("validateCanonicalServiceSID accepted %q", sid)
		}
	}
}

func TestCanonicalLogonSIDValidation(t *testing.T) {
	for _, sid := range []string{"S-1-5-5-0-0", testLogonSID, "S-1-5-5-4294967295-4294967295"} {
		if !isCanonicalLogonSID(sid) {
			t.Fatalf("isCanonicalLogonSID rejected %q", sid)
		}
	}
	for _, sid := range []string{
		"",
		"S-1-5-5-100",
		"S-1-5-5-100-200-300",
		"S-1-5-5-01-200",
		"S-1-5-5-4294967296-200",
		"s-1-5-5-100-200",
	} {
		if isCanonicalLogonSID(sid) {
			t.Fatalf("isCanonicalLogonSID accepted %q", sid)
		}
	}
}

func TestOptionsRequireDistinctCanonicalIdentities(t *testing.T) {
	if err := validateOptions(validOptions()); err != nil {
		t.Fatalf("validateOptions rejected valid identities: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*Options)
	}{
		{name: "empty own name", mutate: func(value *Options) { value.OwnService.Name = "" }},
		{name: "NUL name", mutate: func(value *Options) { value.OwnService.Name += "\x00suffix" }},
		{name: "invalid UTF-8 name", mutate: func(value *Options) { value.OwnService.Name = string([]byte{0xff}) }},
		{name: "slash name", mutate: func(value *Options) { value.OwnService.Name = "Control/Other" }},
		{name: "backslash name", mutate: func(value *Options) { value.OwnService.Name = `Control\Other` }},
		{name: "long name", mutate: func(value *Options) { value.OwnService.Name = strings.Repeat("a", maximumServiceNameUnits+1) }},
		{name: "invalid own SID", mutate: func(value *Options) { value.OwnService.SID = localSystemSID }},
		{name: "invalid peer SID", mutate: func(value *Options) { value.PeerService.SID = builtinAdministratorsSID }},
		{name: "same name", mutate: func(value *Options) { value.PeerService.Name = value.OwnService.Name }},
		{name: "same SID", mutate: func(value *Options) { value.PeerService.SID = value.OwnService.SID }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			options := validOptions()
			test.mutate(&options)
			if err := validateOptions(options); !errors.Is(err, ErrInvalidOptions) {
				t.Fatalf("validateOptions returned %v, want ErrInvalidOptions", err)
			}
		})
	}
}

func TestEvidenceRequiresExactRestrictedServiceConfiguration(t *testing.T) {
	options := validOptions()
	if err := validateEvidence(options, validEvidence()); err != nil {
		t.Fatalf("validateEvidence rejected valid evidence: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*Evidence)
		err    error
	}{
		{name: "zero process ID", mutate: func(value *Evidence) { value.ProcessID = 0 }, err: ErrUnsafeToken},
		{name: "own name", mutate: func(value *Evidence) { value.OwnService.Name = "Other" }, err: ErrServiceSIDMismatch},
		{name: "own SID", mutate: func(value *Evidence) { value.OwnService.SID = testPeerServiceSID }, err: ErrServiceSIDMismatch},
		{name: "peer name", mutate: func(value *Evidence) { value.PeerService.Name = "Other" }, err: ErrServiceSIDMismatch},
		{name: "peer SID", mutate: func(value *Evidence) { value.PeerService.SID = testOwnServiceSID }, err: ErrServiceSIDMismatch},
		{name: "own none", mutate: func(value *Evidence) { value.OwnService.SIDType = ServiceSIDTypeNone }, err: ErrServiceNotRestricted},
		{name: "own unrestricted", mutate: func(value *Evidence) { value.OwnService.SIDType = ServiceSIDTypeUnrestricted }, err: ErrServiceNotRestricted},
		{name: "peer none", mutate: func(value *Evidence) { value.PeerService.SIDType = ServiceSIDTypeNone }, err: ErrServiceNotRestricted},
		{name: "unknown SID type", mutate: func(value *Evidence) { value.PeerService.SIDType = 7 }, err: ErrServiceNotRestricted},
		{name: "shared-process service", mutate: func(value *Evidence) { value.OwnService.ServiceType = 0x20 }, err: ErrServiceType},
		{name: "interactive own-process service", mutate: func(value *Evidence) { value.PeerService.ServiceType = 0x110 }, err: ErrServiceType},
		{name: "own start account", mutate: func(value *Evidence) { value.OwnService.StartAccount = `NT AUTHORITY\LocalService` }, err: ErrServiceAccountMismatch},
		{name: "peer start account", mutate: func(value *Evidence) { value.PeerService.StartAccount = value.OwnService.StartAccount }, err: ErrServiceAccountMismatch},
		{name: "resolved domain", mutate: func(value *Evidence) { value.OwnService.Domain = "BUILTIN" }, err: ErrServiceSIDMismatch},
		{name: "resolved account type", mutate: func(value *Evidence) { value.PeerService.AccountType = 1 }, err: ErrServiceSIDMismatch},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			evidence := validEvidence()
			test.mutate(&evidence)
			if err := validateEvidence(options, evidence); !errors.Is(err, test.err) {
				t.Fatalf("validateEvidence returned %v, want %v", err, test.err)
			}
		})
	}
}

func TestTokenRejectsAdministratorAndBuiltInServiceIdentities(t *testing.T) {
	options := validOptions()
	for sid, identity := range forbiddenTokenUserSIDs {
		t.Run("user "+identity, func(t *testing.T) {
			evidence := validEvidence()
			evidence.Token.User.SID = sid
			if err := validateEvidence(options, evidence); !errors.Is(err, ErrBuiltInServiceIdentity) {
				t.Fatalf("built-in user returned %v", err)
			}
		})
		t.Run("group "+identity, func(t *testing.T) {
			evidence := validEvidence()
			evidence.Token.Groups = append(evidence.Token.Groups, SIDEntry{SID: sid, Attributes: groupEnabled})
			if err := validateEvidence(options, evidence); !errors.Is(err, ErrBuiltInServiceIdentity) {
				t.Fatalf("built-in group returned %v", err)
			}
		})
	}

	for _, attributes := range []uint32{groupEnabled, groupUseForDenyOnly} {
		evidence := validEvidence()
		evidence.Token.Groups = append(evidence.Token.Groups, SIDEntry{
			SID:        builtinAdministratorsSID,
			Attributes: attributes,
		})
		if err := validateEvidence(options, evidence); !errors.Is(err, ErrAdministrativeToken) {
			t.Fatalf("Administrators attributes 0x%x returned %v", attributes, err)
		}
	}

	evidence := validEvidence()
	evidence.Token.User.SID = builtinAdministratorsSID
	if err := validateEvidence(options, evidence); !errors.Is(err, ErrAdministrativeToken) {
		t.Fatalf("Administrators token user returned %v", err)
	}
}

func TestOwnServiceSIDMustBeEnabledAndRestricting(t *testing.T) {
	options := validOptions()
	tests := []struct {
		name   string
		mutate func(*Evidence)
		err    error
	}{
		{name: "token not restricted", mutate: func(value *Evidence) { value.Token.HasRestrictions = false }, err: ErrOwnServiceSID},
		{name: "missing group", mutate: func(value *Evidence) { value.Token.Groups = nil }, err: ErrOwnServiceSID},
		{name: "disabled group", mutate: func(value *Evidence) { value.Token.Groups[0].Attributes = 0 }, err: ErrOwnServiceSID},
		{name: "default-only group", mutate: func(value *Evidence) { value.Token.Groups[0].Attributes = 0x2 }, err: ErrOwnServiceSID},
		{name: "deny-only group", mutate: func(value *Evidence) { value.Token.Groups[0].Attributes = groupUseForDenyOnly }, err: ErrOwnServiceSID},
		{name: "missing restricting SID", mutate: func(value *Evidence) { value.Token.RestrictedSIDs = nil }, err: ErrOwnServiceSID},
		{name: "restricting SID attributes", mutate: func(value *Evidence) { value.Token.RestrictedSIDs[0].Attributes = groupEnabled }, err: ErrUnsafeToken},
		{name: "duplicate group", mutate: func(value *Evidence) { value.Token.Groups = append(value.Token.Groups, value.Token.Groups[0]) }, err: ErrUnsafeToken},
		{name: "duplicate restricting SID", mutate: func(value *Evidence) {
			value.Token.RestrictedSIDs = append(value.Token.RestrictedSIDs, value.Token.RestrictedSIDs[0])
		}, err: ErrUnsafeToken},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			evidence := validEvidence()
			test.mutate(&evidence)
			if err := validateEvidence(options, evidence); !errors.Is(err, test.err) {
				t.Fatalf("validateEvidence returned %v, want %v", err, test.err)
			}
		})
	}
}

func TestTokenUserMustBeOwnVirtualServiceAccount(t *testing.T) {
	evidence := validEvidence()
	evidence.Token.User.SID = "S-1-5-21-100-200-300-1001"
	if err := validateEvidence(validOptions(), evidence); !errors.Is(err, ErrTokenUserMismatch) {
		t.Fatalf("wrong token user returned %v, want ErrTokenUserMismatch", err)
	}
}

func TestPeerServiceSIDMustBeAbsentFromEveryTokenSIDSet(t *testing.T) {
	options := validOptions()
	tests := []struct {
		name   string
		mutate func(*Evidence)
	}{
		{name: "user", mutate: func(value *Evidence) { value.Token.User.SID = testPeerServiceSID }},
		{name: "enabled group", mutate: func(value *Evidence) {
			value.Token.Groups = append(value.Token.Groups, SIDEntry{SID: testPeerServiceSID, Attributes: groupEnabled})
		}},
		{name: "deny-only group", mutate: func(value *Evidence) {
			value.Token.Groups = append(value.Token.Groups, SIDEntry{SID: testPeerServiceSID, Attributes: groupUseForDenyOnly})
		}},
		{name: "restricting SID", mutate: func(value *Evidence) {
			value.Token.RestrictedSIDs = append(value.Token.RestrictedSIDs, SIDEntry{SID: testPeerServiceSID})
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			evidence := validEvidence()
			test.mutate(&evidence)
			if err := validateEvidence(options, evidence); !errors.Is(err, ErrPeerServiceSID) {
				t.Fatalf("validateEvidence returned %v, want ErrPeerServiceSID", err)
			}
		})
	}
}

func TestUnexpectedIndividualServiceSIDIsRejectedButAllServicesIsAllowed(t *testing.T) {
	options := validOptions()
	if err := validateEvidence(options, validEvidence()); err != nil {
		t.Fatalf("ALL SERVICES baseline group was rejected: %v", err)
	}

	for _, attributes := range []uint32{groupEnabled, groupUseForDenyOnly} {
		groupEvidence := validEvidence()
		groupEvidence.Token.Groups = append(groupEvidence.Token.Groups, SIDEntry{
			SID:        testOtherServiceSID,
			Attributes: attributes,
		})
		if err := validateEvidence(options, groupEvidence); !errors.Is(err, ErrUnexpectedServiceSID) {
			t.Fatalf("unexpected service group attributes 0x%x returned %v", attributes, err)
		}
	}

	restrictedEvidence := validEvidence()
	restrictedEvidence.Token.RestrictedSIDs = append(restrictedEvidence.Token.RestrictedSIDs, SIDEntry{
		SID: testOtherServiceSID,
	})
	if err := validateEvidence(options, restrictedEvidence); !errors.Is(err, ErrUnexpectedServiceSID) {
		t.Fatalf("unexpected restricting service SID returned %v", err)
	}

	combinedEvidence := validEvidence()
	combinedEvidence.Token.Groups = append(combinedEvidence.Token.Groups, SIDEntry{
		SID:        testOtherServiceSID,
		Attributes: groupEnabled,
	})
	combinedEvidence.Token.RestrictedSIDs = append(combinedEvidence.Token.RestrictedSIDs, SIDEntry{
		SID: testOtherServiceSID,
	})
	if err := validateEvidence(options, combinedEvidence); !errors.Is(err, ErrUnexpectedServiceSID) {
		t.Fatalf("service SID present in both sets returned %v", err)
	}
}

func TestRestrictedSIDSetMatchesWindowsRestrictedServiceBaseline(t *testing.T) {
	options := validOptions()
	tests := []struct {
		name   string
		mutate func(*Evidence)
	}{
		{name: "missing Everyone", mutate: func(value *Evidence) {
			value.Token.RestrictedSIDs = append(value.Token.RestrictedSIDs[:1], value.Token.RestrictedSIDs[2:]...)
		}},
		{name: "missing WRITE RESTRICTED", mutate: func(value *Evidence) {
			value.Token.RestrictedSIDs = append(value.Token.RestrictedSIDs[:2], value.Token.RestrictedSIDs[3:]...)
		}},
		{name: "mismatched logon SID", mutate: func(value *Evidence) {
			value.Token.RestrictedSIDs[3].SID = "S-1-5-5-300-400"
		}},
		{name: "extra restricting SID", mutate: func(value *Evidence) {
			value.Token.RestrictedSIDs = append(value.Token.RestrictedSIDs, SIDEntry{SID: "S-1-5-12"})
		}},
		{name: "missing logon group", mutate: func(value *Evidence) {
			value.Token.Groups = value.Token.Groups[:2]
		}},
		{name: "disabled logon group", mutate: func(value *Evidence) {
			value.Token.Groups[2].Attributes &^= groupEnabled
		}},
		{name: "unexpected logon group attribute", mutate: func(value *Evidence) {
			value.Token.Groups[2].Attributes |= 0x8
		}},
		{name: "malformed logon SID", mutate: func(value *Evidence) {
			value.Token.Groups[2].SID = "S-1-5-5-01-200"
		}},
		{name: "multiple logon groups", mutate: func(value *Evidence) {
			value.Token.Groups = append(value.Token.Groups, SIDEntry{
				SID:        "S-1-5-5-300-400",
				Attributes: serviceLogonGroupAttributes,
			})
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			evidence := validEvidence()
			test.mutate(&evidence)
			if err := validateEvidence(options, evidence); !errors.Is(err, ErrUnsafeToken) {
				t.Fatalf("validateEvidence returned %v, want ErrUnsafeToken", err)
			}
		})
	}
}

func TestEveryHighRiskPrivilegeMustBeAbsent(t *testing.T) {
	options := validOptions()
	names := make([]string, 0, len(forbiddenPrivilegeNames))
	for name := range forbiddenPrivilegeNames {
		names = append(names, name)
	}
	sort.Strings(names)
	for index, name := range names {
		t.Run(name, func(t *testing.T) {
			for _, attributes := range []uint32{0, privilegeEnabled} {
				evidence := validEvidence()
				evidence.Token.Privileges = append(evidence.Token.Privileges, PrivilegeEvidence{
					Name:       name,
					LUID:       LUID{LowPart: uint32(index + 100)},
					Attributes: attributes,
				})
				if err := validateEvidence(options, evidence); !errors.Is(err, ErrForbiddenPrivilege) {
					t.Fatalf("%s attributes 0x%x returned %v", name, attributes, err)
				}
			}
		})
	}
}

func TestReleaseProcessTokenRejectsAdministrativeAndHighRiskCapabilities(t *testing.T) {
	valid := TokenEvidence{
		TokenID:          LUID{LowPart: 1},
		AuthenticationID: LUID{LowPart: 2},
		ModifiedID:       LUID{LowPart: 3},
		Type:             tokenPrimaryType,
		User:             SIDEntry{SID: "S-1-5-21-100-200-300-1001"},
		Groups:           []SIDEntry{{SID: worldSID, Attributes: groupEnabled}},
		Privileges: []PrivilegeEvidence{{
			Name: "SeChangeNotifyPrivilege", LUID: LUID{LowPart: 4}, Attributes: privilegeEnabled,
		}},
	}
	if err := validateReleaseProcessTokenEvidence(valid); err != nil {
		t.Fatalf("valid release process token was rejected: %v", err)
	}

	administrator := valid
	administrator.Groups = append([]SIDEntry(nil), valid.Groups...)
	administrator.Groups = append(administrator.Groups, SIDEntry{
		SID: builtinAdministratorsSID, Attributes: groupUseForDenyOnly,
	})
	if err := validateReleaseProcessTokenEvidence(administrator); !errors.Is(err, ErrAdministrativeToken) {
		t.Fatalf("deny-only Administrators membership returned %v", err)
	}

	privileged := valid
	privileged.Privileges = append([]PrivilegeEvidence(nil), valid.Privileges...)
	privileged.Privileges = append(privileged.Privileges, PrivilegeEvidence{
		Name: "SeImpersonatePrivilege", LUID: LUID{LowPart: 5}, Attributes: 0,
	})
	if err := validateReleaseProcessTokenEvidence(privileged); !errors.Is(err, ErrForbiddenPrivilege) {
		t.Fatalf("disabled high-risk privilege returned %v", err)
	}
}

func TestMalformedTokenEvidenceFailsClosed(t *testing.T) {
	options := validOptions()
	tests := []struct {
		name   string
		mutate func(*Evidence)
	}{
		{name: "impersonation token", mutate: func(value *Evidence) { value.Token.Type = 2 }},
		{name: "empty user", mutate: func(value *Evidence) { value.Token.User.SID = "" }},
		{name: "nonzero user attribute", mutate: func(value *Evidence) { value.Token.User.Attributes = groupMandatory }},
		{name: "unknown group attribute", mutate: func(value *Evidence) { value.Token.Groups[0].Attributes |= 0x100 }},
		{name: "empty privilege name", mutate: func(value *Evidence) { value.Token.Privileges[0].Name = "" }},
		{name: "unknown privilege attribute", mutate: func(value *Evidence) { value.Token.Privileges[0].Attributes |= 0x8 }},
		{name: "duplicate privilege name", mutate: func(value *Evidence) {
			value.Token.Privileges = append(value.Token.Privileges, PrivilegeEvidence{Name: value.Token.Privileges[0].Name, LUID: LUID{LowPart: 99}})
		}},
		{name: "duplicate privilege LUID", mutate: func(value *Evidence) {
			value.Token.Privileges = append(value.Token.Privileges, PrivilegeEvidence{Name: "SeTimeZonePrivilege", LUID: value.Token.Privileges[0].LUID})
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			evidence := validEvidence()
			test.mutate(&evidence)
			if err := validateEvidence(options, evidence); !errors.Is(err, ErrUnsafeToken) {
				t.Fatalf("validateEvidence returned %v, want ErrUnsafeToken", err)
			}
		})
	}
}

func TestEvidenceCloneOwnsAllSliceStorage(t *testing.T) {
	original := validEvidence()
	clone := cloneEvidence(original)
	clone.Token.Groups[0].SID = "S-1-1-0"
	clone.Token.RestrictedSIDs[0].SID = "S-1-5-33"
	clone.Token.Privileges[0].Name = "SeTimeZonePrivilege"
	if original.Token.Groups[0].SID != testOwnServiceSID ||
		original.Token.RestrictedSIDs[0].SID != testOwnServiceSID ||
		original.Token.Privileges[0].Name != "SeChangeNotifyPrivilege" {
		t.Fatal("cloneEvidence retained mutable slice aliases")
	}
}

func TestEvidenceAttributeHelpers(t *testing.T) {
	if !((SIDEntry{Attributes: groupEnabled}).Enabled()) {
		t.Fatal("enabled SID was not reported enabled")
	}
	if (SIDEntry{Attributes: groupEnabled | groupUseForDenyOnly}).Enabled() {
		t.Fatal("deny-only SID was reported enabled")
	}
	if !((SIDEntry{Attributes: groupUseForDenyOnly}).DenyOnly()) {
		t.Fatal("deny-only SID was not reported deny-only")
	}
	if !((PrivilegeEvidence{Attributes: privilegeEnabled}).Enabled()) {
		t.Fatal("enabled privilege was not reported enabled")
	}
}

func validOptions() Options {
	return Options{
		OwnService: ServiceIdentity{
			Name: "AgenticReview.Worker.Control",
			SID:  testOwnServiceSID,
		},
		PeerService: ServiceIdentity{
			Name: "AgenticReview.Worker.Executor",
			SID:  testPeerServiceSID,
		},
	}
}

func validEvidence() Evidence {
	options := validOptions()
	return Evidence{
		ProcessID: 42,
		OwnService: ServiceEvidence{
			Name:         options.OwnService.Name,
			SID:          options.OwnService.SID,
			SIDType:      ServiceSIDTypeRestricted,
			ServiceType:  serviceWin32OwnProcessType,
			StartAccount: serviceAccountName(options.OwnService.Name),
			Domain:       serviceAccountDomain,
			AccountType:  serviceSIDAccountType,
		},
		PeerService: ServiceEvidence{
			Name:         options.PeerService.Name,
			SID:          options.PeerService.SID,
			SIDType:      ServiceSIDTypeRestricted,
			ServiceType:  serviceWin32OwnProcessType,
			StartAccount: serviceAccountName(options.PeerService.Name),
			Domain:       serviceAccountDomain,
			AccountType:  serviceSIDAccountType,
		},
		Token: TokenEvidence{
			TokenID:          LUID{LowPart: 1},
			AuthenticationID: LUID{LowPart: 2},
			ModifiedID:       LUID{LowPart: 3},
			Type:             tokenPrimaryType,
			HasRestrictions:  true,
			User: SIDEntry{
				SID: options.OwnService.SID,
			},
			Groups: []SIDEntry{
				{SID: options.OwnService.SID, Attributes: groupEnabled | 0x2 | 0x8},
				{SID: allServicesSID, Attributes: groupEnabled | 0x2},
				{SID: testLogonSID, Attributes: serviceLogonGroupAttributes},
			},
			RestrictedSIDs: []SIDEntry{
				{SID: options.OwnService.SID},
				{SID: worldSID},
				{SID: writeRestrictedSID},
				{SID: testLogonSID},
			},
			Privileges: []PrivilegeEvidence{
				{Name: "SeChangeNotifyPrivilege", LUID: LUID{LowPart: 23}, Attributes: privilegeEnabled},
			},
		},
	}
}
