package peerverify

import (
	"fmt"
	"strconv"
	"strings"
)

const (
	tokenPrimaryType         = uint32(1)
	serviceGroupMandatory    = uint32(0x00000001)
	serviceGroupDefault      = uint32(0x00000002)
	serviceGroupEnabled      = uint32(0x00000004)
	serviceGroupDenyOnly     = uint32(0x00000010)
	serviceGroupLogonID      = uint32(0xc0000000)
	serviceGroupValid        = uint32(0xe000007f)
	serviceLogonAttributes   = serviceGroupLogonID | serviceGroupMandatory | serviceGroupDefault | serviceGroupEnabled
	privilegeEnabled         = uint32(0x00000002)
	privilegeValidAttributes = uint32(0x80000007)
	localSystemSID           = "S-1-5-18"
	localServiceSID          = "S-1-5-19"
	networkServiceSID        = "S-1-5-20"
	builtinAdministratorsSID = "S-1-5-32-544"
	worldSID                 = "S-1-1-0"
	writeRestrictedSID       = "S-1-5-33"
	allServicesSID           = "S-1-5-80-0"
)

var forbiddenPeerPrivilegeNames = map[string]struct{}{
	"SeAssignPrimaryTokenPrivilege":             {},
	"SeBackupPrivilege":                         {},
	"SeCreatePermanentPrivilege":                {},
	"SeCreateTokenPrivilege":                    {},
	"SeDebugPrivilege":                          {},
	"SeDelegateSessionUserImpersonatePrivilege": {},
	"SeEnableDelegationPrivilege":               {},
	"SeImpersonatePrivilege":                    {},
	"SeLoadDriverPrivilege":                     {},
	"SeManageVolumePrivilege":                   {},
	"SeRelabelPrivilege":                        {},
	"SeRestorePrivilege":                        {},
	"SeSecurityPrivilege":                       {},
	"SeSystemEnvironmentPrivilege":              {},
	"SeTakeOwnershipPrivilege":                  {},
	"SeTcbPrivilege":                            {},
	"SeTrustedCredManAccessPrivilege":           {},
}

var forbiddenPeerIdentitySIDs = map[string]struct{}{
	localSystemSID:    {},
	localServiceSID:   {},
	networkServiceSID: {},
}

// ExactRestrictedServiceSIDVerifier applies the mandatory peer-token policy.
// The configured virtual service SID must be the token user, an enabled normal
// group, and one member of the exact four-entry restricting SID set. Every
// high-risk privilege must be absent, including disabled entries.
type ExactRestrictedServiceSIDVerifier struct{}

// VerifyToken implements TokenVerifier without depending on a wider Windows
// identity package.
func (ExactRestrictedServiceSIDVerifier) VerifyToken(
	snapshot TokenSnapshot,
	expectedServiceSID string,
) (TokenEvidence, error) {
	if err := validateServiceSID(expectedServiceSID); err != nil {
		return TokenEvidence{}, fmt.Errorf("%w: expected service SID is not canonical", ErrTokenMismatch)
	}
	if snapshot.StatisticsBefore != snapshot.StatisticsAfter {
		return TokenEvidence{}, fmt.Errorf("%w: TokenStatistics changed during inspection", ErrTokenMismatch)
	}
	statistics := snapshot.StatisticsBefore
	if statistics.Type != tokenPrimaryType {
		return TokenEvidence{}, fmt.Errorf("%w: peer token type is %d, want primary", ErrTokenMismatch, statistics.Type)
	}
	if statistics.GroupCount != uint32(len(snapshot.Groups)) ||
		statistics.PrivilegeCount != uint32(len(snapshot.Privileges)) {
		return TokenEvidence{}, fmt.Errorf("%w: TokenStatistics counts do not match detached evidence", ErrTokenMismatch)
	}
	if !snapshot.HasRestrictions {
		return TokenEvidence{}, fmt.Errorf("%w: TokenHasRestrictions is false", ErrTokenMismatch)
	}
	if snapshot.User.SID != expectedServiceSID {
		return TokenEvidence{}, fmt.Errorf(
			"%w: token user is %q, expected %q",
			ErrTokenMismatch,
			snapshot.User.SID,
			expectedServiceSID,
		)
	}
	if snapshot.User.Attributes != 0 {
		return TokenEvidence{}, fmt.Errorf("%w: token user attributes are nonzero", ErrTokenMismatch)
	}
	if _, forbidden := forbiddenPeerIdentitySIDs[snapshot.User.SID]; forbidden ||
		snapshot.User.SID == builtinAdministratorsSID {
		return TokenEvidence{}, fmt.Errorf("%w: token user is a forbidden built-in identity", ErrTokenMismatch)
	}

	groups, err := indexPeerSIDEntries("token groups", snapshot.Groups, false)
	if err != nil {
		return TokenEvidence{}, err
	}
	restricted, err := indexPeerSIDEntries("restricting SIDs", snapshot.RestrictedSIDs, true)
	if err != nil {
		return TokenEvidence{}, err
	}
	if _, present := groups[builtinAdministratorsSID]; present {
		return TokenEvidence{}, fmt.Errorf("%w: Administrators SID is present, including deny-only membership", ErrTokenMismatch)
	}
	for sid := range forbiddenPeerIdentitySIDs {
		if _, present := groups[sid]; present {
			return TokenEvidence{}, fmt.Errorf("%w: forbidden built-in service SID %s is a token group", ErrTokenMismatch, sid)
		}
	}
	serviceGroup, present := groups[expectedServiceSID]
	if !present || serviceGroup.Attributes&serviceGroupEnabled == 0 ||
		serviceGroup.Attributes&serviceGroupDenyOnly != 0 {
		return TokenEvidence{}, fmt.Errorf("%w: expected service SID is not an enabled token group", ErrTokenMismatch)
	}
	if _, present := restricted[expectedServiceSID]; !present {
		return TokenEvidence{}, fmt.Errorf("%w: expected service SID is not a restricting SID", ErrTokenMismatch)
	}
	logonSID, err := exactServiceLogonSID(groups)
	if err != nil {
		return TokenEvidence{}, err
	}
	if err := validateExactRestrictedSIDSet(expectedServiceSID, logonSID, restricted); err != nil {
		return TokenEvidence{}, err
	}
	for sid := range groups {
		if sid != expectedServiceSID && sid != allServicesSID && isIndividualServiceSID(sid) {
			return TokenEvidence{}, fmt.Errorf("%w: unexpected service SID %s is a token group", ErrTokenMismatch, sid)
		}
	}

	seenPrivilegeNames := make(map[string]struct{}, len(snapshot.Privileges))
	seenPrivilegeLUIDs := make(map[LUID]struct{}, len(snapshot.Privileges))
	for _, privilege := range snapshot.Privileges {
		if privilege.Name == "" || privilege.Attributes&^privilegeValidAttributes != 0 {
			return TokenEvidence{}, fmt.Errorf("%w: privilege name or attributes are invalid", ErrTokenMismatch)
		}
		if _, duplicate := seenPrivilegeNames[privilege.Name]; duplicate {
			return TokenEvidence{}, fmt.Errorf("%w: duplicate privilege name %q", ErrTokenMismatch, privilege.Name)
		}
		if _, duplicate := seenPrivilegeLUIDs[privilege.LUID]; duplicate {
			return TokenEvidence{}, fmt.Errorf("%w: duplicate privilege LUID for %q", ErrTokenMismatch, privilege.Name)
		}
		seenPrivilegeNames[privilege.Name] = struct{}{}
		seenPrivilegeLUIDs[privilege.LUID] = struct{}{}
		if _, forbidden := forbiddenPeerPrivilegeNames[privilege.Name]; forbidden {
			return TokenEvidence{}, fmt.Errorf("%w: high-risk privilege %s is present", ErrTokenMismatch, privilege.Name)
		}
	}

	return TokenEvidence{
		Statistics:               statistics,
		ServiceSID:               expectedServiceSID,
		LogonSID:                 logonSID,
		PrimaryToken:             true,
		TokenRestricted:          true,
		TokenUserMatches:         true,
		ServiceSIDEnabled:        true,
		ServiceSIDIsRestricting:  true,
		NoAdministrativeSID:      true,
		NoBuiltInServiceIdentity: true,
		RestrictedSIDSetExact:    true,
		NoHighRiskPrivileges:     true,
		TokenStatisticsStable:    true,
	}, nil
}

func indexPeerSIDEntries(
	label string,
	entries []SIDAttributes,
	restricting bool,
) (map[string]SIDAttributes, error) {
	indexed := make(map[string]SIDAttributes, len(entries))
	for _, entry := range entries {
		if entry.SID == "" || entry.Attributes&^serviceGroupValid != 0 {
			return nil, fmt.Errorf("%w: %s contain invalid SID evidence", ErrTokenMismatch, label)
		}
		if restricting && entry.Attributes != 0 {
			return nil, fmt.Errorf("%w: restricting SID %s has nonzero attributes", ErrTokenMismatch, entry.SID)
		}
		if _, duplicate := indexed[entry.SID]; duplicate {
			return nil, fmt.Errorf("%w: %s contain duplicate SID %s", ErrTokenMismatch, label, entry.SID)
		}
		indexed[entry.SID] = entry
	}
	return indexed, nil
}

func isIndividualServiceSID(value string) bool {
	return validateServiceSID(value) == nil
}

func exactServiceLogonSID(groups map[string]SIDAttributes) (string, error) {
	logonSID := ""
	for sid, entry := range groups {
		if entry.Attributes&serviceGroupLogonID != serviceGroupLogonID {
			continue
		}
		if entry.Attributes != serviceLogonAttributes || !isCanonicalLogonSID(sid) {
			return "", fmt.Errorf(
				"%w: token logon SID %s has attributes 0x%x or is malformed",
				ErrTokenMismatch,
				sid,
				entry.Attributes,
			)
		}
		if logonSID != "" {
			return "", fmt.Errorf("%w: token contains multiple service logon SIDs", ErrTokenMismatch)
		}
		logonSID = sid
	}
	if logonSID == "" {
		return "", fmt.Errorf("%w: token has no enabled service logon SID", ErrTokenMismatch)
	}
	return logonSID, nil
}

func isCanonicalLogonSID(value string) bool {
	parts := strings.Split(value, "-")
	if len(parts) != 6 || parts[0] != "S" || parts[1] != "1" || parts[2] != "5" || parts[3] != "5" {
		return false
	}
	for _, part := range parts[4:] {
		parsed, err := strconv.ParseUint(part, 10, 32)
		if err != nil || strconv.FormatUint(parsed, 10) != part {
			return false
		}
	}
	return true
}

func validateExactRestrictedSIDSet(
	serviceSID string,
	logonSID string,
	restricted map[string]SIDAttributes,
) error {
	expected := map[string]struct{}{
		serviceSID:         {},
		worldSID:           {},
		writeRestrictedSID: {},
		logonSID:           {},
	}
	if len(restricted) != len(expected) {
		return fmt.Errorf(
			"%w: restricting SID count is %d, want %d",
			ErrTokenMismatch,
			len(restricted),
			len(expected),
		)
	}
	for sid := range expected {
		if _, present := restricted[sid]; !present {
			return fmt.Errorf("%w: required restricting SID %s is absent", ErrTokenMismatch, sid)
		}
	}
	return nil
}
