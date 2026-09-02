package winidentity

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	// Stable Win32 ABI constants live outside the Windows build so ordinary
	// contract tests can inspect the complete policy.
	serviceManagerConnectAccess uint32 = 0x0001
	serviceQueryConfigAccess    uint32 = 0x0001
	serviceSIDInfoLevel         uint32 = 5
	tokenQueryAccess            uint32 = 0x0008
	tokenPrimaryType            uint32 = 1
	serviceSIDAccountType       uint32 = 5
	serviceWin32OwnProcessType  uint32 = 0x00000010

	groupMandatory              uint32 = 0x00000001
	groupEnabledByDefault       uint32 = 0x00000002
	groupEnabled                uint32 = 0x00000004
	groupUseForDenyOnly         uint32 = 0x00000010
	groupLogonID                uint32 = 0xc0000000
	groupValidAttributes        uint32 = 0xe000007f
	serviceLogonGroupAttributes        = groupLogonID | groupMandatory | groupEnabledByDefault | groupEnabled
	privilegeEnabled            uint32 = 0x00000002
	privilegeValidAttributes    uint32 = 0x80000007
	maximumServiceNameUnits            = 256
	serviceAccountDomain               = "NT SERVICE"
)

const (
	localSystemSID           = "S-1-5-18"
	localServiceSID          = "S-1-5-19"
	networkServiceSID        = "S-1-5-20"
	builtinAdministratorsSID = "S-1-5-32-544"
	worldSID                 = "S-1-1-0"
	writeRestrictedSID       = "S-1-5-33"
	allServicesSID           = "S-1-5-80-0"
)

var forbiddenPrivilegeNames = map[string]struct{}{
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

var forbiddenTokenUserSIDs = map[string]string{
	localSystemSID:    "LocalSystem",
	localServiceSID:   "LocalService",
	networkServiceSID: "NetworkService",
}

func validateOptions(options Options) error {
	if err := validateServiceIdentity("own", options.OwnService); err != nil {
		return err
	}
	if err := validateServiceIdentity("peer", options.PeerService); err != nil {
		return err
	}
	if options.OwnService.Name == options.PeerService.Name {
		return fmt.Errorf("%w: own and peer service names must differ", ErrInvalidOptions)
	}
	if options.OwnService.SID == options.PeerService.SID {
		return fmt.Errorf("%w: own and peer service SIDs must differ", ErrInvalidOptions)
	}
	return nil
}

func validateServiceIdentity(label string, identity ServiceIdentity) error {
	if !validServiceName(identity.Name) {
		return fmt.Errorf("%w: %s service name is invalid", ErrInvalidOptions, label)
	}
	if err := validateCanonicalServiceSID(identity.SID); err != nil {
		return fmt.Errorf("%w: %s service SID %q %v", ErrInvalidOptions, label, identity.SID, err)
	}
	return nil
}

func validServiceName(value string) bool {
	return value != "" && utf8.ValidString(value) &&
		!strings.ContainsRune(value, utf8.RuneError) &&
		!strings.ContainsRune(value, '\x00') &&
		!strings.ContainsAny(value, `/\\`) &&
		len(utf16.Encode([]rune(value))) <= maximumServiceNameUnits
}

func validateCanonicalServiceSID(value string) error {
	parts := strings.Split(value, "-")
	if len(parts) != 9 || parts[0] != "S" || parts[1] != "1" || parts[2] != "5" || parts[3] != "80" {
		return errors.New("must be a canonical S-1-5-80 service SID")
	}
	for _, part := range parts[4:] {
		parsed, err := strconv.ParseUint(part, 10, 32)
		if err != nil || strconv.FormatUint(parsed, 10) != part {
			return errors.New("must be a canonical S-1-5-80 service SID")
		}
	}
	return nil
}

func validateEvidence(options Options, evidence Evidence) error {
	if err := validateOptions(options); err != nil {
		return err
	}
	if evidence.ProcessID == 0 {
		return fmt.Errorf("%w: current process ID is zero", ErrUnsafeToken)
	}
	if err := validateServiceEvidence("own", options.OwnService, evidence.OwnService); err != nil {
		return err
	}
	if err := validateServiceEvidence("peer", options.PeerService, evidence.PeerService); err != nil {
		return err
	}
	return validateTokenEvidence(options, evidence.Token)
}

func validateServiceEvidence(label string, expected ServiceIdentity, observed ServiceEvidence) error {
	if observed.Name != expected.Name || observed.SID != expected.SID {
		return fmt.Errorf(
			"%w: %s service resolved as name %q SID %q, want name %q SID %q",
			ErrServiceSIDMismatch,
			label,
			observed.Name,
			observed.SID,
			expected.Name,
			expected.SID,
		)
	}
	if observed.SIDType != ServiceSIDTypeRestricted {
		return fmt.Errorf(
			"%w: %s service %q has SID type %d, want %d",
			ErrServiceNotRestricted,
			label,
			observed.Name,
			observed.SIDType,
			ServiceSIDTypeRestricted,
		)
	}
	if observed.ServiceType != serviceWin32OwnProcessType {
		return fmt.Errorf(
			"%w: %s service %q has service type 0x%x, want 0x%x",
			ErrServiceType,
			label,
			observed.Name,
			observed.ServiceType,
			serviceWin32OwnProcessType,
		)
	}
	expectedAccount := serviceAccountName(expected.Name)
	if observed.StartAccount != expectedAccount {
		return fmt.Errorf(
			"%w: %s service %q starts as %q, want %q",
			ErrServiceAccountMismatch,
			label,
			observed.Name,
			observed.StartAccount,
			expectedAccount,
		)
	}
	if observed.Domain != serviceAccountDomain || observed.AccountType != serviceSIDAccountType {
		return fmt.Errorf(
			"%w: %s service SID resolved as domain %q account type %d",
			ErrServiceSIDMismatch,
			label,
			observed.Domain,
			observed.AccountType,
		)
	}
	return nil
}

func serviceAccountName(serviceName string) string {
	return serviceAccountDomain + `\` + serviceName
}

func validateTokenEvidence(options Options, token TokenEvidence) error {
	if token.Type != tokenPrimaryType {
		return fmt.Errorf("%w: token type is %d, want primary", ErrUnsafeToken, token.Type)
	}
	if !token.HasRestrictions {
		return fmt.Errorf("%w: TokenHasRestrictions is false", ErrOwnServiceSID)
	}
	if token.User.SID == "" || token.User.Attributes != 0 {
		return fmt.Errorf("%w: token user SID is empty or attributes are nonzero", ErrUnsafeToken)
	}
	if token.User.SID == options.PeerService.SID {
		return fmt.Errorf("%w: peer SID is the token user", ErrPeerServiceSID)
	}
	if identity, forbidden := forbiddenTokenUserSIDs[token.User.SID]; forbidden {
		return fmt.Errorf("%w: token user is %s (%s)", ErrBuiltInServiceIdentity, identity, token.User.SID)
	}
	if token.User.SID == builtinAdministratorsSID {
		return fmt.Errorf("%w: Administrators SID is the token user", ErrAdministrativeToken)
	}
	if token.User.SID != options.OwnService.SID {
		return fmt.Errorf(
			"%w: token user is %s, want %s",
			ErrTokenUserMismatch,
			token.User.SID,
			options.OwnService.SID,
		)
	}

	groups, err := indexSIDEntries("token groups", token.Groups)
	if err != nil {
		return err
	}
	restricted, err := indexSIDEntries("restricted SIDs", token.RestrictedSIDs)
	if err != nil {
		return err
	}
	for _, entry := range token.RestrictedSIDs {
		if entry.Attributes != 0 {
			return fmt.Errorf(
				"%w: restricting SID %s has attributes 0x%x, want zero",
				ErrUnsafeToken,
				entry.SID,
				entry.Attributes,
			)
		}
	}
	if _, present := groups[options.PeerService.SID]; present {
		return fmt.Errorf("%w: peer SID is a token group", ErrPeerServiceSID)
	}
	if _, present := restricted[options.PeerService.SID]; present {
		return fmt.Errorf("%w: peer SID is a restricting SID", ErrPeerServiceSID)
	}
	for sid := range groups {
		if sid != options.OwnService.SID && isIndividualServiceSID(sid) {
			return fmt.Errorf("%w: token group %s", ErrUnexpectedServiceSID, sid)
		}
	}
	for sid := range restricted {
		if sid != options.OwnService.SID && isIndividualServiceSID(sid) {
			return fmt.Errorf("%w: restricting SID %s", ErrUnexpectedServiceSID, sid)
		}
	}
	if _, present := groups[builtinAdministratorsSID]; present {
		return fmt.Errorf("%w: Administrators SID is present, including deny-only membership", ErrAdministrativeToken)
	}
	for sid, identity := range forbiddenTokenUserSIDs {
		if _, present := groups[sid]; present {
			return fmt.Errorf("%w: %s SID (%s) is a token group", ErrBuiltInServiceIdentity, identity, sid)
		}
	}
	ownGroup, present := groups[options.OwnService.SID]
	if !present || !ownGroup.Enabled() {
		return fmt.Errorf("%w: own SID is absent, disabled, or deny-only in token groups", ErrOwnServiceSID)
	}
	if _, present := restricted[options.OwnService.SID]; !present {
		return fmt.Errorf("%w: own SID is absent from TokenRestrictedSids", ErrOwnServiceSID)
	}
	logonSID, err := enabledLogonSID(groups)
	if err != nil {
		return err
	}
	if err := validateRestrictedSIDSet(options.OwnService.SID, logonSID, restricted); err != nil {
		return err
	}

	return validateReleaseTokenPrivileges(token.Privileges)
}

func validateReleaseProcessTokenEvidence(token TokenEvidence) error {
	if token.Type != tokenPrimaryType {
		return fmt.Errorf("%w: release token type is %d, want primary", ErrUnsafeToken, token.Type)
	}
	if token.User.SID == "" || token.User.Attributes != 0 {
		return fmt.Errorf("%w: release token user SID is empty or attributes are nonzero", ErrUnsafeToken)
	}
	if token.User.SID == builtinAdministratorsSID {
		return fmt.Errorf("%w: Administrators SID is the release token user", ErrAdministrativeToken)
	}
	if identity, forbidden := forbiddenTokenUserSIDs[token.User.SID]; forbidden {
		return fmt.Errorf("%w: release token user is %s", ErrBuiltInServiceIdentity, identity)
	}
	groups, err := indexSIDEntries("release token groups", token.Groups)
	if err != nil {
		return err
	}
	if _, present := groups[builtinAdministratorsSID]; present {
		return fmt.Errorf("%w: Administrators SID is present in the release token", ErrAdministrativeToken)
	}
	for sid, identity := range forbiddenTokenUserSIDs {
		if _, present := groups[sid]; present {
			return fmt.Errorf("%w: %s SID is present in the release token", ErrBuiltInServiceIdentity, identity)
		}
	}
	return validateReleaseTokenPrivileges(token.Privileges)
}

func validateReleaseTokenPrivileges(privileges []PrivilegeEvidence) error {
	seenPrivilegeNames := make(map[string]struct{}, len(privileges))
	seenPrivilegeLUIDs := make(map[LUID]struct{}, len(privileges))
	for _, privilege := range privileges {
		if privilege.Name == "" || privilege.Attributes&^privilegeValidAttributes != 0 {
			return fmt.Errorf("%w: privilege name or attributes are invalid", ErrUnsafeToken)
		}
		if _, duplicate := seenPrivilegeNames[privilege.Name]; duplicate {
			return fmt.Errorf("%w: duplicate privilege name %q", ErrUnsafeToken, privilege.Name)
		}
		if _, duplicate := seenPrivilegeLUIDs[privilege.LUID]; duplicate {
			return fmt.Errorf("%w: duplicate privilege LUID for %q", ErrUnsafeToken, privilege.Name)
		}
		seenPrivilegeNames[privilege.Name] = struct{}{}
		seenPrivilegeLUIDs[privilege.LUID] = struct{}{}
		if _, forbidden := forbiddenPrivilegeNames[privilege.Name]; forbidden {
			return fmt.Errorf("%w: %s", ErrForbiddenPrivilege, privilege.Name)
		}
	}
	return nil
}

func isIndividualServiceSID(sid string) bool {
	return validateCanonicalServiceSID(sid) == nil
}

func enabledLogonSID(groups map[string]SIDEntry) (string, error) {
	logonSID := ""
	for sid, entry := range groups {
		if entry.Attributes&groupLogonID != groupLogonID {
			continue
		}
		if entry.Attributes != serviceLogonGroupAttributes || !isCanonicalLogonSID(sid) {
			return "", fmt.Errorf(
				"%w: token logon SID %s has attributes 0x%x or is malformed",
				ErrUnsafeToken,
				sid,
				entry.Attributes,
			)
		}
		if logonSID != "" {
			return "", fmt.Errorf("%w: token contains multiple logon SIDs", ErrUnsafeToken)
		}
		logonSID = sid
	}
	if logonSID == "" {
		return "", fmt.Errorf("%w: token has no enabled service logon SID", ErrUnsafeToken)
	}
	return logonSID, nil
}

func isCanonicalLogonSID(sid string) bool {
	parts := strings.Split(sid, "-")
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

// SERVICE_SID_TYPE_RESTRICTED adds exactly the service SID, Everyone, the
// service logon SID, and WRITE RESTRICTED to the restricting SID set.
func validateRestrictedSIDSet(ownSID string, logonSID string, restricted map[string]SIDEntry) error {
	expected := map[string]struct{}{
		ownSID:             {},
		worldSID:           {},
		writeRestrictedSID: {},
		logonSID:           {},
	}
	if len(restricted) != len(expected) {
		return fmt.Errorf(
			"%w: restricted SID count is %d, want %d",
			ErrUnsafeToken,
			len(restricted),
			len(expected),
		)
	}
	for sid := range expected {
		if _, present := restricted[sid]; !present {
			return fmt.Errorf("%w: required restricting SID %s is absent", ErrUnsafeToken, sid)
		}
	}
	return nil
}

func indexSIDEntries(label string, entries []SIDEntry) (map[string]SIDEntry, error) {
	indexed := make(map[string]SIDEntry, len(entries))
	for _, entry := range entries {
		if entry.SID == "" || entry.Attributes&^groupValidAttributes != 0 {
			return nil, fmt.Errorf("%w: %s contain an invalid SID or attributes", ErrUnsafeToken, label)
		}
		if _, duplicate := indexed[entry.SID]; duplicate {
			return nil, fmt.Errorf("%w: %s contain duplicate SID %s", ErrUnsafeToken, label, entry.SID)
		}
		indexed[entry.SID] = entry
	}
	return indexed, nil
}
