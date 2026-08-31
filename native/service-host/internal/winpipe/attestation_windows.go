//go:build windows

package winpipe

import (
	"errors"
	"fmt"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	fileAllAccess             uint32 = 0x001f01ff
	localSystemSID                   = "S-1-5-18"
	builtinAdministratorsSID         = "S-1-5-32-544"
	serverSecurityInformation        = windows.OWNER_SECURITY_INFORMATION |
		windows.GROUP_SECURITY_INFORMATION |
		windows.DACL_SECURITY_INFORMATION
)

type endpointServerSecurityEvidence struct {
	ownServiceSID  string
	peerServiceSID string
	protected      bool
}

type endpointDACLEntry struct {
	sid      string
	mask     uint32
	aceType  uint8
	aceFlags uint8
}

type endpointSecurityEvidence struct {
	ownerSID       string
	groupSID       string
	ownerDefaulted bool
	groupDefaulted bool
	present        bool
	protected      bool
	selfRelative   bool
	null           bool
	defaulted      bool
	entries        []endpointDACLEntry
}

func readBackCreatedServerSecurity(
	handle windows.Handle,
	expectedOwnServiceSID string,
	expectedPeerServiceSID string,
) (endpointServerSecurityEvidence, error) {
	// PIPE_ACCESS_DUPLEX grants GENERIC_READ and GENERIC_WRITE, whose file
	// generic mappings include READ_CONTROL. CreateNamedPipe rejects unrelated
	// standard access bits in dwOpenMode, so READ_CONTROL is not added there.
	releaseNative, gateErr := windowsEndpointLifetimeQuarantine.beginNativeUse()
	if gateErr != nil {
		return endpointServerSecurityEvidence{}, gateErr
	}
	descriptor, err := windows.GetSecurityInfo(
		handle,
		windows.SE_KERNEL_OBJECT,
		serverSecurityInformation,
	)
	releaseNative()
	if err != nil {
		return endpointServerSecurityEvidence{}, fmt.Errorf("GetSecurityInfo security descriptor: %w", err)
	}
	evidence, err := endpointSecurityEvidenceFromDescriptor(descriptor)
	runtime.KeepAlive(descriptor)
	if err != nil {
		return endpointServerSecurityEvidence{}, err
	}
	return validateCreatedServerSecurity(evidence, expectedOwnServiceSID, expectedPeerServiceSID)
}

func endpointSecurityEvidenceFromDescriptor(
	descriptor *windows.SECURITY_DESCRIPTOR,
) (endpointSecurityEvidence, error) {
	if descriptor == nil || !descriptor.IsValid() {
		return endpointSecurityEvidence{}, errors.New("created named-pipe security descriptor is missing or invalid")
	}
	control, _, err := descriptor.Control()
	if err != nil {
		return endpointSecurityEvidence{}, fmt.Errorf("read created named-pipe security descriptor control: %w", err)
	}
	evidence := endpointSecurityEvidence{
		present:      control&windows.SE_DACL_PRESENT != 0,
		protected:    control&windows.SE_DACL_PROTECTED != 0,
		selfRelative: control&windows.SE_SELF_RELATIVE != 0,
	}
	owner, ownerDefaulted, err := descriptor.Owner()
	if err != nil {
		return endpointSecurityEvidence{}, fmt.Errorf("read created named-pipe security descriptor owner: %w", err)
	}
	group, groupDefaulted, err := descriptor.Group()
	if err != nil {
		return endpointSecurityEvidence{}, fmt.Errorf("read created named-pipe security descriptor group: %w", err)
	}
	evidence.ownerDefaulted = ownerDefaulted
	evidence.groupDefaulted = groupDefaulted
	if owner != nil && owner.IsValid() {
		evidence.ownerSID = owner.String()
	}
	if group != nil && group.IsValid() {
		evidence.groupSID = group.String()
	}
	dacl, defaulted, err := descriptor.DACL()
	if errors.Is(err, windows.ERROR_OBJECT_NOT_FOUND) {
		return evidence, nil
	}
	if err != nil {
		return endpointSecurityEvidence{}, fmt.Errorf("read created named-pipe DACL: %w", err)
	}
	evidence.null = dacl == nil
	evidence.defaulted = defaulted
	if dacl == nil {
		return evidence, nil
	}
	evidence.entries = make([]endpointDACLEntry, 0, int(dacl.AceCount))
	for index := uint32(0); index < uint32(dacl.AceCount); index++ {
		entry, err := readEndpointAllowedACE(dacl, index)
		if err != nil {
			return endpointSecurityEvidence{}, err
		}
		evidence.entries = append(evidence.entries, entry)
	}
	return evidence, nil
}

func readEndpointAllowedACE(acl *windows.ACL, index uint32) (endpointDACLEntry, error) {
	var ace *windows.ACCESS_ALLOWED_ACE
	if err := windows.GetAce(acl, index, &ace); err != nil {
		return endpointDACLEntry{}, fmt.Errorf("read created named-pipe DACL ACE %d: %w", index, err)
	}
	if ace == nil {
		return endpointDACLEntry{}, fmt.Errorf("created named-pipe DACL ACE %d is null", index)
	}
	if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
		return endpointDACLEntry{}, fmt.Errorf(
			"created named-pipe DACL ACE %d has unsupported type %d",
			index,
			ace.Header.AceType,
		)
	}
	sidOffset := int(unsafe.Offsetof(ace.SidStart))
	if int(ace.Header.AceSize) < sidOffset+8 {
		return endpointDACLEntry{}, fmt.Errorf("created named-pipe DACL ACE %d is too small for a SID", index)
	}
	sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
	if !sid.IsValid() || sid.String() == "" {
		return endpointDACLEntry{}, fmt.Errorf("created named-pipe DACL ACE %d contains an invalid SID", index)
	}
	if int(ace.Header.AceSize) != sidOffset+sid.Len() {
		return endpointDACLEntry{}, fmt.Errorf("created named-pipe DACL ACE %d has a noncanonical size", index)
	}
	return endpointDACLEntry{
		sid:      sid.String(),
		mask:     uint32(ace.Mask),
		aceType:  ace.Header.AceType,
		aceFlags: ace.Header.AceFlags,
	}, nil
}

func validateCreatedServerSecurity(
	evidence endpointSecurityEvidence,
	expectedOwnServiceSID string,
	expectedPeerServiceSID string,
) (endpointServerSecurityEvidence, error) {
	if err := validateServiceSID(expectedOwnServiceSID); err != nil {
		return endpointServerSecurityEvidence{}, err
	}
	if err := validateServiceSID(expectedPeerServiceSID); err != nil {
		return endpointServerSecurityEvidence{}, err
	}
	if expectedOwnServiceSID == expectedPeerServiceSID {
		return endpointServerSecurityEvidence{}, invalidOptions("own and peer service SIDs must be distinct")
	}
	if validateServiceSID(evidence.ownerSID) != nil || validateServiceSID(evidence.groupSID) != nil {
		return endpointServerSecurityEvidence{}, errors.New("created named-pipe owner or group SID is missing or noncanonical")
	}
	if evidence.ownerSID != expectedOwnServiceSID || evidence.groupSID != expectedOwnServiceSID {
		return endpointServerSecurityEvidence{}, fmt.Errorf(
			"created named-pipe owner/group are %s/%s, want %s/%s",
			evidence.ownerSID,
			evidence.groupSID,
			expectedOwnServiceSID,
			expectedOwnServiceSID,
		)
	}
	if evidence.ownerDefaulted || evidence.groupDefaulted {
		return endpointServerSecurityEvidence{}, errors.New("created named-pipe owner or group SID is defaulted")
	}
	if !evidence.present || !evidence.protected || !evidence.selfRelative {
		return endpointServerSecurityEvidence{}, errors.New("created named-pipe DACL is not present, protected, and self-relative")
	}
	if evidence.null || evidence.defaulted {
		return endpointServerSecurityEvidence{}, errors.New("created named-pipe DACL is null or defaulted")
	}
	if len(evidence.entries) != 3 {
		return endpointServerSecurityEvidence{}, fmt.Errorf("created named-pipe DACL has %d ACEs, want 3", len(evidence.entries))
	}
	expectedMasks := map[string]uint32{
		localSystemSID:           fileAllAccess,
		builtinAdministratorsSID: fileAllAccess,
		expectedPeerServiceSID:   peerAccessRights,
	}
	seen := make(map[string]struct{}, len(expectedMasks))
	validatedPeerServiceSID := ""
	for index, entry := range evidence.entries {
		if entry.aceType != windows.ACCESS_ALLOWED_ACE_TYPE || entry.aceFlags != 0 {
			return endpointServerSecurityEvidence{}, fmt.Errorf("created named-pipe DACL ACE %d has unexpected type or flags", index)
		}
		expectedMask, ok := expectedMasks[entry.sid]
		if !ok {
			return endpointServerSecurityEvidence{}, fmt.Errorf("created named-pipe DACL ACE %d grants unexpected SID %s", index, entry.sid)
		}
		if _, duplicate := seen[entry.sid]; duplicate {
			return endpointServerSecurityEvidence{}, fmt.Errorf("created named-pipe DACL repeats SID %s", entry.sid)
		}
		if entry.mask != expectedMask {
			return endpointServerSecurityEvidence{}, fmt.Errorf(
				"created named-pipe DACL grants SID %s mask 0x%08x, want 0x%08x",
				entry.sid,
				entry.mask,
				expectedMask,
			)
		}
		seen[entry.sid] = struct{}{}
		if entry.sid == expectedPeerServiceSID {
			validatedPeerServiceSID = entry.sid
		}
	}
	if len(seen) != len(expectedMasks) || validatedPeerServiceSID == "" {
		return endpointServerSecurityEvidence{}, errors.New("created named-pipe DACL is missing a required SID")
	}
	return endpointServerSecurityEvidence{
		ownServiceSID:  evidence.ownerSID,
		peerServiceSID: validatedPeerServiceSID,
		protected:      true,
	}, nil
}

func rejectUnattestedServerHandle(
	handle windows.Handle,
	cause error,
	closeHandle endpointCloseHandleFunc,
	quarantine *endpointLifetimeQuarantine,
) error {
	if errors.Is(cause, windows.ERROR_INVALID_HANDLE) {
		return quarantine.retain(
			&endpointRawHandleOwner{kind: "invalid unattested named-pipe server handle", value: handle},
			cause,
		)
	}
	return consumeEndpointHandleOnce(
		"close unattested named-pipe server handle",
		handle,
		closeHandle,
		quarantine,
	)
}
