package peerverify

import (
	"errors"
	"sort"
	"testing"
)

func TestExactRestrictedServiceSIDVerifierAcceptsExactEvidence(t *testing.T) {
	evidence, err := (ExactRestrictedServiceSIDVerifier{}).VerifyToken(validTokenSnapshot(), testServiceSID)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateTokenEvidence(evidence, testServiceSID); err != nil {
		t.Fatal(err)
	}
}

func TestEveryPeerBoundaryPrivilegeMustBeAbsent(t *testing.T) {
	names := make([]string, 0, len(forbiddenPeerPrivilegeNames))
	for name := range forbiddenPeerPrivilegeNames {
		names = append(names, name)
	}
	sort.Strings(names)
	for index, name := range names {
		t.Run(name, func(t *testing.T) {
			for _, attributes := range []uint32{0, privilegeEnabled} {
				snapshot := validTokenSnapshot()
				snapshot.Privileges = append(snapshot.Privileges, PrivilegeEvidence{
					Name: name, LUID: LUID{LowPart: uint32(index + 100)}, Attributes: attributes,
				})
				snapshot.StatisticsBefore.PrivilegeCount++
				snapshot.StatisticsAfter.PrivilegeCount++
				if _, err := (ExactRestrictedServiceSIDVerifier{}).VerifyToken(snapshot, testServiceSID); !errors.Is(err, ErrTokenMismatch) {
					t.Fatalf("%s attributes 0x%x returned %v", name, attributes, err)
				}
			}
		})
	}
}

func TestExactRestrictedServiceSIDVerifierRejectsIncompleteOrAmbiguousEvidence(t *testing.T) {
	otherServiceSID := "S-1-5-80-6-7-8-9-10"
	tests := []struct {
		name   string
		mutate func(*TokenSnapshot)
	}{
		{name: "missing user", mutate: func(value *TokenSnapshot) { value.User.SID = "" }},
		{name: "wrong token user", mutate: func(value *TokenSnapshot) { value.User.SID = otherServiceSID }},
		{name: "nonzero token user attributes", mutate: func(value *TokenSnapshot) { value.User.Attributes = serviceGroupMandatory }},
		{name: "impersonation token", mutate: func(value *TokenSnapshot) {
			value.StatisticsBefore.Type = 2
			value.StatisticsAfter.Type = 2
		}},
		{name: "unstable statistics", mutate: func(value *TokenSnapshot) { value.StatisticsAfter.ModifiedID.LowPart++ }},
		{name: "not restricted", mutate: func(value *TokenSnapshot) { value.HasRestrictions = false }},
		{name: "SID disabled", mutate: func(value *TokenSnapshot) { value.Groups[0].Attributes = 0 }},
		{name: "SID deny only", mutate: func(value *TokenSnapshot) { value.Groups[0].Attributes |= serviceGroupDenyOnly }},
		{name: "missing enabled SID", mutate: func(value *TokenSnapshot) {
			value.Groups = nil
			value.StatisticsBefore.GroupCount = 0
			value.StatisticsAfter.GroupCount = 0
		}},
		{name: "duplicate enabled SID", mutate: func(value *TokenSnapshot) {
			value.Groups = append(value.Groups, value.Groups[0])
			value.StatisticsBefore.GroupCount++
			value.StatisticsAfter.GroupCount++
		}},
		{name: "other enabled service SID", mutate: func(value *TokenSnapshot) {
			value.Groups = append(value.Groups, SIDAttributes{SID: otherServiceSID, Attributes: serviceGroupEnabled})
			value.StatisticsBefore.GroupCount++
			value.StatisticsAfter.GroupCount++
		}},
		{name: "missing restricting SID", mutate: func(value *TokenSnapshot) { value.RestrictedSIDs = nil }},
		{name: "restricting SID attributes", mutate: func(value *TokenSnapshot) { value.RestrictedSIDs[0].Attributes = serviceGroupEnabled }},
		{name: "duplicate restricting SID", mutate: func(value *TokenSnapshot) {
			value.RestrictedSIDs = append(value.RestrictedSIDs, value.RestrictedSIDs[0])
		}},
		{name: "other restricting service SID", mutate: func(value *TokenSnapshot) {
			value.RestrictedSIDs = append(value.RestrictedSIDs, SIDAttributes{SID: otherServiceSID})
		}},
		{name: "Administrators group", mutate: func(value *TokenSnapshot) {
			value.Groups = append(value.Groups, SIDAttributes{SID: builtinAdministratorsSID, Attributes: serviceGroupDenyOnly})
			value.StatisticsBefore.GroupCount++
			value.StatisticsAfter.GroupCount++
		}},
		{name: "built-in service group", mutate: func(value *TokenSnapshot) {
			value.Groups = append(value.Groups, SIDAttributes{SID: localServiceSID, Attributes: serviceGroupEnabled})
			value.StatisticsBefore.GroupCount++
			value.StatisticsAfter.GroupCount++
		}},
		{name: "enabled high-risk privilege", mutate: func(value *TokenSnapshot) {
			value.Privileges = append(value.Privileges, PrivilegeEvidence{
				Name: "SeDebugPrivilege", LUID: LUID{LowPart: 99}, Attributes: privilegeEnabled,
			})
			value.StatisticsBefore.PrivilegeCount++
			value.StatisticsAfter.PrivilegeCount++
		}},
		{name: "statistics count mismatch", mutate: func(value *TokenSnapshot) { value.StatisticsAfter.GroupCount++ }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			snapshot := validTokenSnapshot()
			test.mutate(&snapshot)
			_, err := (ExactRestrictedServiceSIDVerifier{}).VerifyToken(snapshot, testServiceSID)
			if !errors.Is(err, ErrTokenMismatch) {
				t.Fatalf("error = %v, want ErrTokenMismatch", err)
			}
		})
	}
}

func TestRestrictedSIDSetMatchesExactWindowsServiceBaseline(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*TokenSnapshot)
	}{
		{name: "missing Everyone", mutate: func(value *TokenSnapshot) {
			value.RestrictedSIDs = append(value.RestrictedSIDs[:1], value.RestrictedSIDs[2:]...)
		}},
		{name: "missing WRITE RESTRICTED", mutate: func(value *TokenSnapshot) {
			value.RestrictedSIDs = append(value.RestrictedSIDs[:2], value.RestrictedSIDs[3:]...)
		}},
		{name: "mismatched restricting logon SID", mutate: func(value *TokenSnapshot) {
			value.RestrictedSIDs[3].SID = "S-1-5-5-300-400"
		}},
		{name: "extra restricting SID", mutate: func(value *TokenSnapshot) {
			value.RestrictedSIDs = append(value.RestrictedSIDs, SIDAttributes{SID: "S-1-5-12"})
		}},
		{name: "missing normal logon SID", mutate: func(value *TokenSnapshot) {
			value.Groups = value.Groups[:2]
			value.StatisticsBefore.GroupCount--
			value.StatisticsAfter.GroupCount--
		}},
		{name: "disabled normal logon SID", mutate: func(value *TokenSnapshot) {
			value.Groups[2].Attributes &^= serviceGroupEnabled
		}},
		{name: "unexpected normal logon SID attributes", mutate: func(value *TokenSnapshot) {
			value.Groups[2].Attributes |= 0x8
		}},
		{name: "malformed normal logon SID", mutate: func(value *TokenSnapshot) {
			value.Groups[2].SID = "S-1-5-5-01-200"
		}},
		{name: "multiple normal logon SIDs", mutate: func(value *TokenSnapshot) {
			value.Groups = append(value.Groups, SIDAttributes{
				SID: "S-1-5-5-300-400", Attributes: serviceLogonAttributes,
			})
			value.StatisticsBefore.GroupCount++
			value.StatisticsAfter.GroupCount++
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			snapshot := validTokenSnapshot()
			test.mutate(&snapshot)
			if _, err := (ExactRestrictedServiceSIDVerifier{}).VerifyToken(snapshot, testServiceSID); !errors.Is(err, ErrTokenMismatch) {
				t.Fatalf("error = %v, want ErrTokenMismatch", err)
			}
		})
	}
}

func TestAllServicesGroupIsNotAnUnexpectedIndividualServiceSID(t *testing.T) {
	snapshot := validTokenSnapshot()
	if _, err := (ExactRestrictedServiceSIDVerifier{}).VerifyToken(snapshot, testServiceSID); err != nil {
		t.Fatalf("S-1-5-80-0 was rejected: %v", err)
	}
}

func TestValidateOptionsRejectsNoncanonicalSecurityInputs(t *testing.T) {
	fixture := newVerificationFixture(PipePeerClient)
	tests := []struct {
		name   string
		mutate func(*Options)
	}{
		{name: "unknown endpoint", mutate: func(value *Options) { value.PipePeer = PipePeerUnknown }},
		{name: "noncanonical service SID", mutate: func(value *Options) { value.ExpectedServiceSID = "S-1-5-80-01-2-3-4-5" }},
		{name: "relative wrapper path", mutate: func(value *Options) { value.WrapperImage.Path = "winsw.exe" }},
		{name: "uppercase hash", mutate: func(value *Options) {
			value.ServiceHostImage.SHA256 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
		}},
		{name: "same image path", mutate: func(value *Options) { value.ServiceHostImage.Path = value.WrapperImage.Path }},
		{name: "invalid signer pin", mutate: func(value *Options) { value.ExpectedLeafSignerCertificateDERSHA256 = "bad" }},
		{name: "missing immutable tree evidence", mutate: func(value *Options) {
			value.Prerequisites.ImmutableInstallationTreeVerified = false
		}},
		{name: "missing SCM launch evidence", mutate: func(value *Options) {
			value.Prerequisites.StableSCMWrapperLaunchVerified = false
		}},
		{name: "missing DACL evidence", mutate: func(value *Options) {
			value.Prerequisites.ProcessAndTokenDACLsVerified = false
		}},
		{name: "missing Authenticode", mutate: func(value *Options) { value.AuthenticodeVerifier = nil }},
		{name: "missing token verifier", mutate: func(value *Options) { value.TokenVerifier = nil }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			options := fixture.options
			test.mutate(&options)
			if err := validateOptions(options); !errors.Is(err, ErrInvalidOptions) {
				t.Fatalf("error = %v, want ErrInvalidOptions", err)
			}
		})
	}
}
