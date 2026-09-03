package servicebootstrap

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winidentity"
)

var (
	ErrUnsupportedPlatform = errors.New("ServiceHost bootstrap requires Windows")
	ErrInvalidRole         = errors.New("invalid ServiceHost role")
	ErrAlreadyPrepared     = errors.New("ServiceHost bootstrap has already been attempted")
	ErrDACLVerification    = errors.New("ServiceHost bootstrap DACL verification failed")
)

const (
	localSystemSID           = "S-1-5-18"
	builtinAdministratorsSID = "S-1-5-32-544"

	genericAllAccessMask          uint32 = 0x10000000
	processQueryLimitedAccessMask uint32 = 0x00001000
	synchronizeAccessMask         uint32 = 0x00100000
	tokenQueryAccessMask          uint32 = 0x00000008

	securityDescriptorDACLPresent   uint16 = 0x0004
	securityDescriptorDACLProtected uint16 = 0x1000
	accessAllowedACEType            uint8  = 0
)

type roleIdentities struct {
	own  winidentity.ServiceIdentity
	peer winidentity.ServiceIdentity
}

type accessEntry struct {
	sid     string
	mask    uint32
	aceType uint8
	flags   uint8
}

type daclEvidence struct {
	control     uint16
	present     bool
	protected   bool
	null        bool
	defaulted   bool
	accessRules []accessEntry
}

type daclPolicy struct {
	entries []accessEntry
}

func resolveRole(role config.Role) (roleIdentities, error) {
	resolved := roleIdentities{
		own: winidentity.ServiceIdentity{
			Name: config.ControlServiceName,
			SID:  config.ControlServiceSID,
		},
		peer: winidentity.ServiceIdentity{
			Name: config.ExecutorServiceName,
			SID:  config.ExecutorServiceSID,
		},
	}
	switch role {
	case config.RoleControl:
	case config.RoleExecutor:
		resolved.own, resolved.peer = resolved.peer, resolved.own
	default:
		return roleIdentities{}, fmt.Errorf("%w: role must be control or executor", ErrInvalidRole)
	}
	if resolved.own.Name == "" || resolved.peer.Name == "" ||
		resolved.own.Name == resolved.peer.Name || strings.ContainsRune(resolved.own.Name, '\x00') ||
		strings.ContainsRune(resolved.peer.Name, '\x00') {
		return roleIdentities{}, fmt.Errorf("%w: fixed service names are invalid", ErrInvalidRole)
	}
	if err := validateCanonicalServiceSID(resolved.own.SID); err != nil {
		return roleIdentities{}, fmt.Errorf("%w: fixed own service SID: %v", ErrInvalidRole, err)
	}
	if err := validateCanonicalServiceSID(resolved.peer.SID); err != nil || resolved.peer.SID == resolved.own.SID {
		return roleIdentities{}, fmt.Errorf("%w: fixed peer service SID is invalid", ErrInvalidRole)
	}
	return resolved, nil
}

func policiesForRole(resolved roleIdentities) (daclPolicy, daclPolicy) {
	base := []accessEntry{
		{sid: localSystemSID, mask: genericAllAccessMask, aceType: accessAllowedACEType},
		{sid: builtinAdministratorsSID, mask: genericAllAccessMask, aceType: accessAllowedACEType},
		{sid: resolved.own.SID, mask: genericAllAccessMask, aceType: accessAllowedACEType},
	}
	process := append(append([]accessEntry(nil), base...), accessEntry{
		sid:     resolved.peer.SID,
		mask:    processQueryLimitedAccessMask | synchronizeAccessMask,
		aceType: accessAllowedACEType,
	})
	token := append(append([]accessEntry(nil), base...), accessEntry{
		sid:     resolved.peer.SID,
		mask:    tokenQueryAccessMask,
		aceType: accessAllowedACEType,
	})
	return daclPolicy{entries: process}, daclPolicy{entries: token}
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

func validateDACL(evidence daclEvidence, policy daclPolicy) error {
	if evidence.control&(securityDescriptorDACLPresent|securityDescriptorDACLProtected) !=
		securityDescriptorDACLPresent|securityDescriptorDACLProtected || !evidence.present || !evidence.protected {
		return fmt.Errorf("%w: descriptor does not contain a protected DACL", ErrDACLVerification)
	}
	if evidence.null || evidence.defaulted {
		return fmt.Errorf("%w: descriptor contains a null or defaulted DACL", ErrDACLVerification)
	}
	if len(evidence.accessRules) != len(policy.entries) {
		return fmt.Errorf("%w: DACL contains %d ACEs, want %d", ErrDACLVerification, len(evidence.accessRules), len(policy.entries))
	}
	expected := make(map[string]accessEntry, len(policy.entries))
	for _, entry := range policy.entries {
		expected[entry.sid] = entry
	}
	seen := make(map[string]struct{}, len(evidence.accessRules))
	for _, entry := range evidence.accessRules {
		want, exists := expected[entry.sid]
		if !exists || entry != want {
			return fmt.Errorf("%w: unexpected ACE for SID %s", ErrDACLVerification, entry.sid)
		}
		if _, duplicate := seen[entry.sid]; duplicate {
			return fmt.Errorf("%w: duplicate ACE for SID %s", ErrDACLVerification, entry.sid)
		}
		seen[entry.sid] = struct{}{}
	}
	return nil
}
