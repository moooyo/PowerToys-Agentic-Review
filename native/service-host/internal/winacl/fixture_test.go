package winacl

import (
	"encoding/binary"
	"strconv"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

const (
	testControlSID  = "S-1-5-80-1-2-3-4-5"
	testExecutorSID = "S-1-5-80-6-7-8-9-10"
	testUsersSID    = "S-1-5-32-545"
	testEveryoneSID = "S-1-1-0"
)

type fixtureACE struct {
	aceType uint8
	flags   uint8
	mask    winfile.AccessMask
	sid     string
}

type descriptorFixture struct {
	ownerSID          string
	groupSID          string
	ownerDefaulted    bool
	groupDefaulted    bool
	daclDefaulted     bool
	daclAutoInherited bool
	daclProtected     bool
	aclRevision       uint8
	aces              []fixtureACE
}

func fixtureEvidence(t *testing.T, fixture descriptorFixture) winfile.SecurityDescriptorEvidence {
	t.Helper()
	if fixture.ownerSID == "" {
		fixture.ownerSID = localSystemSID
	}
	if fixture.groupSID == "" {
		fixture.groupSID = builtinAdministratorsSID
	}
	if fixture.aclRevision == 0 {
		fixture.aclRevision = 2
	}
	owner := encodeSID(t, fixture.ownerSID)
	group := encodeSID(t, fixture.groupSID)
	dacl := encodeACL(t, fixture.aclRevision, fixture.aces)

	ownerOffset := securityDescriptorRelativeSize
	groupOffset := ownerOffset + len(owner)
	daclOffset := groupOffset + len(group)
	raw := make([]byte, daclOffset+len(dacl))
	raw[0] = 1
	control := securitySelfRelative | securityDACLPresent
	if fixture.ownerDefaulted {
		control |= securityOwnerDefaulted
	}
	if fixture.groupDefaulted {
		control |= securityGroupDefaulted
	}
	if fixture.daclDefaulted {
		control |= securityDACLDefaulted
	}
	if fixture.daclAutoInherited {
		control |= securityDACLAutoInherited
	}
	if fixture.daclProtected {
		control |= securityDACLProtected
	}
	binary.LittleEndian.PutUint16(raw[2:4], control)
	binary.LittleEndian.PutUint32(raw[4:8], uint32(ownerOffset))
	binary.LittleEndian.PutUint32(raw[8:12], uint32(groupOffset))
	binary.LittleEndian.PutUint32(raw[16:20], uint32(daclOffset))
	copy(raw[ownerOffset:], owner)
	copy(raw[groupOffset:], group)
	copy(raw[daclOffset:], dacl)

	return winfile.SecurityDescriptorEvidence{
		OwnerSID:               fixture.ownerSID,
		GroupSID:               fixture.groupSID,
		OwnerDefaulted:         fixture.ownerDefaulted,
		GroupDefaulted:         fixture.groupDefaulted,
		DACLPresent:            true,
		DACLNull:               false,
		DACLDefaulted:          fixture.daclDefaulted,
		DACLProtected:          fixture.daclProtected,
		Control:                control,
		Revision:               1,
		SelfRelativeDescriptor: raw,
	}
}

func encodeACL(t *testing.T, revision uint8, entries []fixtureACE) []byte {
	t.Helper()
	encoded := make([][]byte, len(entries))
	size := aclHeaderSize
	for index, entry := range entries {
		encoded[index] = encodeACE(t, entry)
		size += len(encoded[index])
	}
	if size > int(^uint16(0)) {
		t.Fatalf("fixture ACL size %d exceeds uint16", size)
	}
	result := make([]byte, size)
	result[0] = revision
	binary.LittleEndian.PutUint16(result[2:4], uint16(size))
	binary.LittleEndian.PutUint16(result[4:6], uint16(len(entries)))
	offset := aclHeaderSize
	for _, entry := range encoded {
		copy(result[offset:], entry)
		offset += len(entry)
	}
	return result
}

func encodeACE(t *testing.T, entry fixtureACE) []byte {
	t.Helper()
	sid := encodeSID(t, entry.sid)
	result := make([]byte, 8+len(sid))
	result[0] = entry.aceType
	result[1] = entry.flags
	binary.LittleEndian.PutUint16(result[2:4], uint16(len(result)))
	binary.LittleEndian.PutUint32(result[4:8], uint32(entry.mask))
	copy(result[8:], sid)
	return result
}

func encodeSID(t *testing.T, value string) []byte {
	t.Helper()
	parts := strings.Split(value, "-")
	if len(parts) < 3 || parts[0] != "S" || parts[1] != "1" {
		t.Fatalf("invalid fixture SID %q", value)
	}
	authority, err := strconv.ParseUint(parts[2], 10, 48)
	if err != nil || len(parts)-3 > maximumSIDSubAuthorities {
		t.Fatalf("invalid fixture SID authority %q", value)
	}
	result := make([]byte, 8+4*(len(parts)-3))
	result[0] = 1
	result[1] = byte(len(parts) - 3)
	for index := 0; index < 6; index++ {
		shift := uint(8 * (5 - index))
		result[2+index] = byte(authority >> shift)
	}
	for index, part := range parts[3:] {
		subAuthority, err := strconv.ParseUint(part, 10, 32)
		if err != nil {
			t.Fatalf("invalid fixture SID sub-authority %q", value)
		}
		binary.LittleEndian.PutUint32(result[8+index*4:12+index*4], uint32(subAuthority))
	}
	return result
}

func cloneEvidence(value winfile.SecurityDescriptorEvidence) winfile.SecurityDescriptorEvidence {
	value.SelfRelativeDescriptor = append([]byte(nil), value.SelfRelativeDescriptor...)
	return value
}

func fixtureDACLOffset(evidence winfile.SecurityDescriptorEvidence) int {
	return int(binary.LittleEndian.Uint32(evidence.SelfRelativeDescriptor[16:20]))
}

func permuteDescriptorComponents(t *testing.T, raw []byte) []byte {
	t.Helper()
	ownerStart := int(binary.LittleEndian.Uint32(raw[4:8]))
	_, ownerLength, err := parseSID(raw[ownerStart:])
	if err != nil {
		t.Fatal(err)
	}
	groupStart := int(binary.LittleEndian.Uint32(raw[8:12]))
	_, groupLength, err := parseSID(raw[groupStart:])
	if err != nil {
		t.Fatal(err)
	}
	daclStart := int(binary.LittleEndian.Uint32(raw[16:20]))
	daclLength := int(binary.LittleEndian.Uint16(raw[daclStart+2 : daclStart+4]))

	permuted := make([]byte, len(raw))
	copy(permuted[:securityDescriptorRelativeSize], raw[:securityDescriptorRelativeSize])
	newDACLStart := securityDescriptorRelativeSize
	newGroupStart := newDACLStart + daclLength
	newOwnerStart := newGroupStart + groupLength
	binary.LittleEndian.PutUint32(permuted[4:8], uint32(newOwnerStart))
	binary.LittleEndian.PutUint32(permuted[8:12], uint32(newGroupStart))
	binary.LittleEndian.PutUint32(permuted[16:20], uint32(newDACLStart))
	copy(permuted[newDACLStart:], raw[daclStart:daclStart+daclLength])
	copy(permuted[newGroupStart:], raw[groupStart:groupStart+groupLength])
	copy(permuted[newOwnerStart:], raw[ownerStart:ownerStart+ownerLength])
	return permuted
}
