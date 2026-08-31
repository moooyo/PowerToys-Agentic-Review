package servicebootstrap

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peerverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winprocess"
)

var (
	ErrUnsupportedPlatform = errors.New("ServiceHost bootstrap requires Windows")
	ErrInvalidOptions      = errors.New("invalid ServiceHost bootstrap options")
	ErrAlreadyBootstrapped = errors.New("ServiceHost bootstrap has already been attempted")
	ErrWrapperUnstable     = errors.New("WinSW wrapper identity is not stable")
	ErrParentMismatch      = errors.New("ServiceHost is not a direct child of the current WinSW wrapper")
	ErrDACLVerification    = errors.New("ServiceHost bootstrap DACL verification failed")
	ErrInvalidEvidence     = errors.New("ServiceHost bootstrap evidence is invalid")
	ErrClosed              = errors.New("ServiceHost bootstrap session is closed")
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
	noACEFlags                      uint8  = 0
	maximumServiceNameUnits                = 256
)

// Options names the current WinSW service and the independently verified
// service SIDs used in the exact process and token DACLs.
type Options struct {
	ServiceName    string
	OwnServiceSID  string
	PeerServiceSID string
}

// ServiceState is the SCM SERVICE_STATUS_PROCESS state sampled around opening
// the retained wrapper process handle.
type ServiceState uint32

const (
	ServiceStopped         ServiceState = 1
	ServiceStartPending    ServiceState = 2
	ServiceStopPending     ServiceState = 3
	ServiceRunning         ServiceState = 4
	ServiceContinuePending ServiceState = 5
	ServicePausePending    ServiceState = 6
	ServicePaused          ServiceState = 7
)

// ServiceObservation is detached SCM status evidence.
type ServiceObservation struct {
	State     ServiceState
	ProcessID uint32
}

// AccessEntry is one detached ACE read back from a kernel object DACL.
type AccessEntry struct {
	SID     string
	Mask    uint32
	ACEType uint8
	Flags   uint8
}

// DACLEvidence records the exact protected DACL read back after applying it.
// Entries contains no native SID or ACL pointers.
type DACLEvidence struct {
	Control     uint16
	Present     bool
	Protected   bool
	Null        bool
	Defaulted   bool
	AccessRules []AccessEntry
}

// Session owns the current service's stable WinSW process handle and all
// auxiliary bootstrap handles. It is both the local wrapper watcher and the
// StableWrapper identity anchor for this service lifetime. Peer verification
// independently opens and retains the opposing service wrapper through SCM;
// callers must never reconstruct either wrapper from a detached PID.
type Session interface {
	winprocess.WrapperWatcher
	peerverify.StableWrapper
	Evidence() Evidence
}

type daclPolicy struct {
	entries []AccessEntry
}

func serviceDACLPolicies(ownServiceSID, peerServiceSID string) (daclPolicy, daclPolicy, error) {
	if err := validateCanonicalServiceSID(ownServiceSID); err != nil {
		return daclPolicy{}, daclPolicy{}, fmt.Errorf("own service SID: %w", err)
	}
	if err := validateCanonicalServiceSID(peerServiceSID); err != nil {
		return daclPolicy{}, daclPolicy{}, fmt.Errorf("peer service SID: %w", err)
	}
	if ownServiceSID == peerServiceSID {
		return daclPolicy{}, daclPolicy{}, errors.New("own and peer service SIDs must be different")
	}
	base := []AccessEntry{
		{SID: localSystemSID, Mask: genericAllAccessMask, ACEType: accessAllowedACEType, Flags: noACEFlags},
		{SID: builtinAdministratorsSID, Mask: genericAllAccessMask, ACEType: accessAllowedACEType, Flags: noACEFlags},
		{SID: ownServiceSID, Mask: genericAllAccessMask, ACEType: accessAllowedACEType, Flags: noACEFlags},
	}
	processEntries := append(append([]AccessEntry(nil), base...), AccessEntry{
		SID:     peerServiceSID,
		Mask:    processQueryLimitedAccessMask | synchronizeAccessMask,
		ACEType: accessAllowedACEType,
		Flags:   noACEFlags,
	})
	tokenEntries := append(append([]AccessEntry(nil), base...), AccessEntry{
		SID:     peerServiceSID,
		Mask:    tokenQueryAccessMask,
		ACEType: accessAllowedACEType,
		Flags:   noACEFlags,
	})
	return daclPolicy{entries: processEntries}, daclPolicy{entries: tokenEntries}, nil
}

func validateOptions(options Options) error {
	if options.ServiceName == "" || !utf8.ValidString(options.ServiceName) ||
		strings.ContainsRune(options.ServiceName, utf8.RuneError) ||
		strings.ContainsRune(options.ServiceName, '\x00') ||
		len(utf16.Encode([]rune(options.ServiceName))) > maximumServiceNameUnits {
		return fmt.Errorf("%w: WinSW service name is not canonical text", ErrInvalidOptions)
	}
	if _, _, err := serviceDACLPolicies(options.OwnServiceSID, options.PeerServiceSID); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidOptions, err)
	}
	return nil
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

func validateDACL(evidence DACLEvidence, policy daclPolicy) error {
	if evidence.Control&(securityDescriptorDACLPresent|securityDescriptorDACLProtected) !=
		securityDescriptorDACLPresent|securityDescriptorDACLProtected ||
		!evidence.Present || !evidence.Protected {
		return fmt.Errorf("%w: descriptor does not contain a protected DACL", ErrDACLVerification)
	}
	if evidence.Null {
		return fmt.Errorf("%w: descriptor contains a null DACL", ErrDACLVerification)
	}
	if evidence.Defaulted {
		return fmt.Errorf("%w: descriptor DACL is defaulted", ErrDACLVerification)
	}
	if len(evidence.AccessRules) != len(policy.entries) {
		return fmt.Errorf(
			"%w: DACL contains %d ACEs, want %d",
			ErrDACLVerification,
			len(evidence.AccessRules),
			len(policy.entries),
		)
	}
	expected := make(map[string]AccessEntry, len(policy.entries))
	for _, entry := range policy.entries {
		expected[entry.SID] = entry
	}
	seen := make(map[string]struct{}, len(evidence.AccessRules))
	for _, entry := range evidence.AccessRules {
		want, exists := expected[entry.SID]
		if !exists {
			return fmt.Errorf("%w: DACL contains unexpected SID %s", ErrDACLVerification, entry.SID)
		}
		if _, duplicate := seen[entry.SID]; duplicate {
			return fmt.Errorf("%w: DACL contains duplicate SID %s", ErrDACLVerification, entry.SID)
		}
		seen[entry.SID] = struct{}{}
		if entry != want {
			return fmt.Errorf(
				"%w: DACL ACE for %s is %+v, want %+v",
				ErrDACLVerification,
				entry.SID,
				entry,
				want,
			)
		}
	}
	return nil
}

func cloneDACLEvidence(value DACLEvidence) DACLEvidence {
	value.AccessRules = append([]AccessEntry(nil), value.AccessRules...)
	return value
}
