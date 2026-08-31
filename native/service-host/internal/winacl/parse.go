package winacl

import (
	"encoding/binary"
	"fmt"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

const (
	securityDescriptorRelativeSize = 20
	maximumDescriptorBytes         = 1024 * 1024
	maximumSIDSubAuthorities       = 15
	maximumACECount                = 4096
	aclHeaderSize                  = 8
	minimumBasicACESize            = 16
)

const (
	securityOwnerDefaulted    uint16 = 0x0001
	securityGroupDefaulted    uint16 = 0x0002
	securityDACLPresent       uint16 = 0x0004
	securityDACLDefaulted     uint16 = 0x0008
	securityDACLAutoInherited uint16 = 0x0400
	securityDACLProtected     uint16 = 0x1000
	securitySelfRelative      uint16 = 0x8000
)

const (
	accessAllowedACEType uint8 = 0
	accessDeniedACEType  uint8 = 1
)

const (
	aceObjectInherit    uint8 = 0x01
	aceContainerInherit uint8 = 0x02
	aceNoPropagate      uint8 = 0x04
	aceInheritOnly      uint8 = 0x08
	aceInherited        uint8 = 0x10
	validDACLACEFlags         = aceObjectInherit | aceContainerInherit | aceNoPropagate |
		aceInheritOnly | aceInherited
)

type normalizedACE struct {
	aceType            uint8
	flags              uint8
	rawMask            winfile.AccessMask
	mask               winfile.AccessMask
	sid                string
	appliesToSelf      bool
	appliesToChildFile bool
	appliesToChildDir  bool
}

type parsedDescriptor struct {
	revision       uint32
	control        uint16
	ownerSID       string
	groupSID       string
	ownerDefaulted bool
	groupDefaulted bool
	daclPresent    bool
	daclNull       bool
	daclDefaulted  bool
	daclProtected  bool
	aclRevision    uint8
	aces           []normalizedACE
}

func parseSecurityDescriptor(evidence winfile.SecurityDescriptorEvidence) (parsedDescriptor, error) {
	raw := evidence.SelfRelativeDescriptor
	if len(raw) < securityDescriptorRelativeSize || len(raw) > maximumDescriptorBytes {
		return parsedDescriptor{}, invalidEvidence("descriptor length %d is outside the supported range", len(raw))
	}
	if raw[0] != 1 || raw[1] != 0 {
		return parsedDescriptor{}, invalidEvidence("descriptor revision or reserved byte is invalid")
	}
	control := binary.LittleEndian.Uint16(raw[2:4])
	if control&securitySelfRelative == 0 {
		return parsedDescriptor{}, invalidEvidence("descriptor is not self-relative")
	}

	ownerOffset := binary.LittleEndian.Uint32(raw[4:8])
	ownerSID, ownerLength, err := parseSIDAt(raw, ownerOffset)
	if err != nil {
		return parsedDescriptor{}, invalidEvidence("owner SID: %v", err)
	}
	groupOffset := binary.LittleEndian.Uint32(raw[8:12])
	groupSID, groupLength, err := parseSIDAt(raw, groupOffset)
	if err != nil {
		return parsedDescriptor{}, invalidEvidence("group SID: %v", err)
	}

	daclPresent := control&securityDACLPresent != 0
	daclOffset := binary.LittleEndian.Uint32(raw[16:20])
	daclNull := daclOffset == 0
	if !daclPresent || daclNull {
		return parsedDescriptor{}, invalidEvidence("descriptor has an absent or null DACL")
	}
	aclRevision, aces, err := parseDACL(raw, daclOffset)
	if err != nil {
		return parsedDescriptor{}, invalidEvidence("DACL: %v", err)
	}
	daclStart := int(daclOffset)
	daclLength := int(binary.LittleEndian.Uint16(raw[daclStart+2 : daclStart+4]))
	if spansOverlap(int(ownerOffset), ownerLength, int(groupOffset), groupLength) ||
		spansOverlap(int(ownerOffset), ownerLength, daclStart, daclLength) ||
		spansOverlap(int(groupOffset), groupLength, daclStart, daclLength) {
		return parsedDescriptor{}, invalidEvidence("owner, group, and DACL components overlap")
	}

	parsed := parsedDescriptor{
		revision:       uint32(raw[0]),
		control:        control,
		ownerSID:       ownerSID,
		groupSID:       groupSID,
		ownerDefaulted: control&securityOwnerDefaulted != 0,
		groupDefaulted: control&securityGroupDefaulted != 0,
		daclPresent:    daclPresent,
		daclNull:       daclNull,
		daclDefaulted:  control&securityDACLDefaulted != 0,
		daclProtected:  control&securityDACLProtected != 0,
		aclRevision:    aclRevision,
		aces:           aces,
	}
	if err := compareDescriptorEvidence(parsed, evidence); err != nil {
		return parsedDescriptor{}, err
	}
	return parsed, nil
}

func compareDescriptorEvidence(parsed parsedDescriptor, evidence winfile.SecurityDescriptorEvidence) error {
	if parsed.ownerSID != evidence.OwnerSID {
		return invalidEvidence("owner SID %q differs from raw descriptor owner %q", evidence.OwnerSID, parsed.ownerSID)
	}
	if parsed.groupSID != evidence.GroupSID {
		return invalidEvidence("group SID %q differs from raw descriptor group %q", evidence.GroupSID, parsed.groupSID)
	}
	if parsed.ownerDefaulted != evidence.OwnerDefaulted ||
		parsed.groupDefaulted != evidence.GroupDefaulted ||
		parsed.daclPresent != evidence.DACLPresent ||
		parsed.daclNull != evidence.DACLNull ||
		parsed.daclDefaulted != evidence.DACLDefaulted ||
		parsed.daclProtected != evidence.DACLProtected ||
		parsed.control != evidence.Control ||
		parsed.revision != evidence.Revision {
		return invalidEvidence("descriptor metadata differs from raw descriptor")
	}
	return nil
}

func parseDACL(raw []byte, offset uint32) (uint8, []normalizedACE, error) {
	if offset < securityDescriptorRelativeSize {
		return 0, nil, fmt.Errorf("ACL offset %d overlaps the descriptor header", offset)
	}
	start, err := checkedOffset(raw, offset, aclHeaderSize)
	if err != nil {
		return 0, nil, err
	}
	if offset%4 != 0 {
		return 0, nil, fmt.Errorf("ACL offset %d is not DWORD-aligned", offset)
	}
	revision := raw[start]
	if revision != 2 && revision != 4 {
		return 0, nil, fmt.Errorf("ACL revision %d is unsupported", revision)
	}
	if raw[start+1] != 0 || binary.LittleEndian.Uint16(raw[start+6:start+8]) != 0 {
		return 0, nil, fmt.Errorf("ACL reserved fields are nonzero")
	}
	aclSize := int(binary.LittleEndian.Uint16(raw[start+2 : start+4]))
	if aclSize < aclHeaderSize || aclSize%4 != 0 || start > len(raw)-aclSize {
		return 0, nil, fmt.Errorf("ACL size %d is invalid", aclSize)
	}
	aceCount := int(binary.LittleEndian.Uint16(raw[start+4 : start+6]))
	if aceCount > maximumACECount || aceCount > (aclSize-aclHeaderSize)/minimumBasicACESize {
		return 0, nil, fmt.Errorf("ACL ACE count %d exceeds its bounded size", aceCount)
	}

	end := start + aclSize
	cursor := start + aclHeaderSize
	aces := make([]normalizedACE, 0, aceCount)
	inheritedStarted := false
	explicitAllowStarted := false
	for index := 0; index < aceCount; index++ {
		if cursor > end-4 {
			return 0, nil, fmt.Errorf("ACE %d header exceeds the ACL", index)
		}
		aceSize := int(binary.LittleEndian.Uint16(raw[cursor+2 : cursor+4]))
		if aceSize < minimumBasicACESize || aceSize%4 != 0 || cursor > end-aceSize {
			return 0, nil, fmt.Errorf("ACE %d size %d is invalid", index, aceSize)
		}
		ace, err := parseBasicACE(raw[cursor:cursor+aceSize], index)
		if err != nil {
			return 0, nil, err
		}
		inherited := ace.flags&aceInherited != 0
		if inherited {
			inheritedStarted = true
		} else {
			if inheritedStarted {
				return 0, nil, fmt.Errorf("explicit ACE %d follows an inherited ACE", index)
			}
			if ace.aceType == accessAllowedACEType {
				explicitAllowStarted = true
			} else if explicitAllowStarted {
				return 0, nil, fmt.Errorf("explicit deny ACE %d follows an explicit allow ACE", index)
			}
		}
		aces = append(aces, ace)
		cursor += aceSize
	}
	for _, value := range raw[cursor:end] {
		if value != 0 {
			return 0, nil, fmt.Errorf("ACL contains nonzero trailing bytes")
		}
	}
	return revision, aces, nil
}

func spansOverlap(leftStart, leftLength, rightStart, rightLength int) bool {
	return leftStart < rightStart+rightLength && rightStart < leftStart+leftLength
}

func parseBasicACE(raw []byte, index int) (normalizedACE, error) {
	aceType := raw[0]
	if aceType != accessAllowedACEType && aceType != accessDeniedACEType {
		return normalizedACE{}, fmt.Errorf("ACE %d has unsupported type %d", index, aceType)
	}
	flags := raw[1]
	if flags&^validDACLACEFlags != 0 {
		return normalizedACE{}, fmt.Errorf("ACE %d has unsupported flags 0x%x", index, flags)
	}
	inheritTargets := flags & (aceObjectInherit | aceContainerInherit)
	if flags&(aceInheritOnly|aceNoPropagate) != 0 && inheritTargets == 0 {
		return normalizedACE{}, fmt.Errorf("ACE %d has inheritance modifiers without a target", index)
	}
	sid, sidLength, err := parseSID(raw[8:])
	if err != nil {
		return normalizedACE{}, fmt.Errorf("ACE %d SID: %v", index, err)
	}
	if 8+sidLength != len(raw) {
		return normalizedACE{}, fmt.Errorf("ACE %d has noncanonical trailing data", index)
	}
	rawMask := winfile.AccessMask(binary.LittleEndian.Uint32(raw[4:8]))
	if rawMask == 0 {
		return normalizedACE{}, fmt.Errorf("ACE %d has an empty access mask", index)
	}
	if rawMask&maximumAllowed != 0 {
		return normalizedACE{}, fmt.Errorf("ACE %d uses MAXIMUM_ALLOWED", index)
	}
	mapped := mapGenericAccess(rawMask)
	if mapped&genericRights != 0 {
		return normalizedACE{}, fmt.Errorf("ACE %d retains generic access bits", index)
	}
	return normalizedACE{
		aceType:            aceType,
		flags:              flags,
		rawMask:            rawMask,
		mask:               mapped,
		sid:                sid,
		appliesToSelf:      flags&aceInheritOnly == 0,
		appliesToChildFile: flags&aceObjectInherit != 0,
		appliesToChildDir:  flags&aceContainerInherit != 0,
	}, nil
}

func mapGenericAccess(mask winfile.AccessMask) winfile.AccessMask {
	if mask&genericRead != 0 {
		mask = mask&^genericRead | fileGenericRead
	}
	if mask&genericWrite != 0 {
		mask = mask&^genericWrite | fileGenericWrite
	}
	if mask&genericExecute != 0 {
		mask = mask&^genericExecute | fileGenericExecute
	}
	if mask&genericAll != 0 {
		mask = mask&^genericAll | fileAllAccess
	}
	return mask
}

func invalidEvidence(format string, arguments ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidEvidence, fmt.Sprintf(format, arguments...))
}
