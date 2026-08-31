package winacl

import (
	"encoding/binary"
	"errors"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

func TestDescriptorParserRejectsRedundantMetadataMismatch(t *testing.T) {
	valid := fixtureEvidence(t, descriptorFixture{aces: []fixtureACE{
		{aceType: accessAllowedACEType, mask: genericRead, sid: localSystemSID},
	}})
	tests := []struct {
		name   string
		mutate func(*winfile.SecurityDescriptorEvidence)
	}{
		{name: "owner", mutate: func(value *winfile.SecurityDescriptorEvidence) { value.OwnerSID = testUsersSID }},
		{name: "group", mutate: func(value *winfile.SecurityDescriptorEvidence) { value.GroupSID = testUsersSID }},
		{name: "owner defaulted", mutate: func(value *winfile.SecurityDescriptorEvidence) { value.OwnerDefaulted = true }},
		{name: "group defaulted", mutate: func(value *winfile.SecurityDescriptorEvidence) { value.GroupDefaulted = true }},
		{name: "DACL present", mutate: func(value *winfile.SecurityDescriptorEvidence) { value.DACLPresent = false }},
		{name: "DACL null", mutate: func(value *winfile.SecurityDescriptorEvidence) { value.DACLNull = true }},
		{name: "DACL defaulted", mutate: func(value *winfile.SecurityDescriptorEvidence) { value.DACLDefaulted = true }},
		{name: "DACL protected", mutate: func(value *winfile.SecurityDescriptorEvidence) { value.DACLProtected = true }},
		{name: "control", mutate: func(value *winfile.SecurityDescriptorEvidence) { value.Control ^= securityDACLDefaulted }},
		{name: "revision", mutate: func(value *winfile.SecurityDescriptorEvidence) { value.Revision = 2 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := cloneEvidence(valid)
			test.mutate(&candidate)
			if err := Audit(candidate, winfile.ObjectKindDirectory, NewAmbientAncestorProfile()); !errors.Is(err, ErrInvalidEvidence) {
				t.Fatalf("Audit returned %v, want ErrInvalidEvidence", err)
			}
		})
	}
}

func TestACEParserNormalizesGenericAccessAndApplicability(t *testing.T) {
	raw := encodeACE(t, fixtureACE{
		aceType: accessAllowedACEType,
		flags:   aceObjectInherit | aceContainerInherit | aceNoPropagate | aceInheritOnly,
		mask:    genericRead | genericExecute,
		sid:     testUsersSID,
	})
	ace, err := parseBasicACE(raw, 0)
	if err != nil {
		t.Fatal(err)
	}
	if ace.rawMask != genericRead|genericExecute ||
		ace.mask != fileGenericRead|fileGenericExecute ||
		ace.appliesToSelf || !ace.appliesToChildFile || !ace.appliesToChildDir {
		t.Fatalf("normalized ACE = %#v", ace)
	}
}

func TestSIDParserUsesCanonicalHighAuthorityForm(t *testing.T) {
	raw := []byte{1, 1, 0x01, 0x00, 0x00, 0x00, 0x00, 0x05, 42, 0, 0, 0}
	sid, length, err := parseSID(raw)
	if err != nil {
		t.Fatal(err)
	}
	if sid != "S-1-0x010000000005-42" || length != len(raw) {
		t.Fatalf("parseSID = %q, %d", sid, length)
	}
}

func TestDescriptorParserRejectsMalformedBoundaries(t *testing.T) {
	valid := fixtureEvidence(t, descriptorFixture{aces: []fixtureACE{
		{aceType: accessAllowedACEType, mask: genericRead, sid: localSystemSID},
	}})
	tests := malformedDescriptorCases(valid)
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := cloneEvidence(valid)
			test.mutate(&candidate)
			if err := Audit(candidate, winfile.ObjectKindDirectory, NewAmbientAncestorProfile()); !errors.Is(err, ErrInvalidEvidence) {
				t.Fatalf("Audit returned %v, want ErrInvalidEvidence", err)
			}
		})
	}
}

type malformedDescriptorCase struct {
	name   string
	mutate func(*winfile.SecurityDescriptorEvidence)
}

func malformedDescriptorCases(valid winfile.SecurityDescriptorEvidence) []malformedDescriptorCase {
	daclOffset := fixtureDACLOffset(valid)
	firstACE := daclOffset + aclHeaderSize
	ownerOffset := int(binary.LittleEndian.Uint32(valid.SelfRelativeDescriptor[4:8]))
	return []malformedDescriptorCase{
		{name: "empty", mutate: func(value *winfile.SecurityDescriptorEvidence) { value.SelfRelativeDescriptor = nil }},
		{name: "short header", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			value.SelfRelativeDescriptor = value.SelfRelativeDescriptor[:19]
		}},
		{name: "truncated body", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			value.SelfRelativeDescriptor = value.SelfRelativeDescriptor[:len(value.SelfRelativeDescriptor)-1]
		}},
		{name: "oversized", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			value.SelfRelativeDescriptor = make([]byte, maximumDescriptorBytes+1)
		}},
		{name: "descriptor revision", mutate: func(value *winfile.SecurityDescriptorEvidence) { value.SelfRelativeDescriptor[0] = 2 }},
		{name: "descriptor reserved", mutate: func(value *winfile.SecurityDescriptorEvidence) { value.SelfRelativeDescriptor[1] = 1 }},
		{name: "not self relative", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			control := binary.LittleEndian.Uint16(value.SelfRelativeDescriptor[2:4]) &^ securitySelfRelative
			binary.LittleEndian.PutUint16(value.SelfRelativeDescriptor[2:4], control)
		}},
		{name: "DACL not present", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			control := binary.LittleEndian.Uint16(value.SelfRelativeDescriptor[2:4]) &^ securityDACLPresent
			binary.LittleEndian.PutUint16(value.SelfRelativeDescriptor[2:4], control)
		}},
		{name: "missing owner", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			binary.LittleEndian.PutUint32(value.SelfRelativeDescriptor[4:8], 0)
		}},
		{name: "unaligned owner", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			binary.LittleEndian.PutUint32(value.SelfRelativeDescriptor[4:8], 21)
		}},
		{name: "owner beyond descriptor", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			binary.LittleEndian.PutUint32(value.SelfRelativeDescriptor[4:8], uint32(len(value.SelfRelativeDescriptor)+4))
		}},
		{name: "overlapping owner and group", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			binary.LittleEndian.PutUint32(value.SelfRelativeDescriptor[8:12], uint32(ownerOffset))
		}},
		{name: "SID revision", mutate: func(value *winfile.SecurityDescriptorEvidence) { value.SelfRelativeDescriptor[ownerOffset] = 2 }},
		{name: "SID sub-authority count", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			value.SelfRelativeDescriptor[ownerOffset+1] = maximumSIDSubAuthorities + 1
		}},
		{name: "null DACL", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			binary.LittleEndian.PutUint32(value.SelfRelativeDescriptor[16:20], 0)
		}},
		{name: "DACL overlaps descriptor header", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			binary.LittleEndian.PutUint32(value.SelfRelativeDescriptor[16:20], 4)
		}},
		{name: "DACL overlaps owner", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			binary.LittleEndian.PutUint32(value.SelfRelativeDescriptor[16:20], uint32(ownerOffset))
		}},
		{name: "unaligned DACL", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			binary.LittleEndian.PutUint32(value.SelfRelativeDescriptor[16:20], uint32(daclOffset+1))
		}},
		{name: "ACL revision", mutate: func(value *winfile.SecurityDescriptorEvidence) { value.SelfRelativeDescriptor[daclOffset] = 3 }},
		{name: "ACL reserved", mutate: func(value *winfile.SecurityDescriptorEvidence) { value.SelfRelativeDescriptor[daclOffset+1] = 1 }},
		{name: "ACL short size", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			binary.LittleEndian.PutUint16(value.SelfRelativeDescriptor[daclOffset+2:daclOffset+4], 4)
		}},
		{name: "ACL unaligned size", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			binary.LittleEndian.PutUint16(value.SelfRelativeDescriptor[daclOffset+2:daclOffset+4], 9)
		}},
		{name: "ACL oversized", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			binary.LittleEndian.PutUint16(value.SelfRelativeDescriptor[daclOffset+2:daclOffset+4], ^uint16(0))
		}},
		{name: "ACE count exceeds ACL", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			binary.LittleEndian.PutUint16(value.SelfRelativeDescriptor[daclOffset+4:daclOffset+6], 2)
		}},
		{name: "unsupported ACE", mutate: func(value *winfile.SecurityDescriptorEvidence) { value.SelfRelativeDescriptor[firstACE] = 5 }},
		{name: "unsupported ACE flags", mutate: func(value *winfile.SecurityDescriptorEvidence) { value.SelfRelativeDescriptor[firstACE+1] = 0x20 }},
		{name: "truncated ACE SID", mutate: func(value *winfile.SecurityDescriptorEvidence) { value.SelfRelativeDescriptor[firstACE+9]++ }},
		{name: "inherit-only without target", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			value.SelfRelativeDescriptor[firstACE+1] = aceInheritOnly
		}},
		{name: "no-propagate without target", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			value.SelfRelativeDescriptor[firstACE+1] = aceNoPropagate
		}},
		{name: "short ACE", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			binary.LittleEndian.PutUint16(value.SelfRelativeDescriptor[firstACE+2:firstACE+4], 12)
		}},
		{name: "unaligned ACE", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			binary.LittleEndian.PutUint16(value.SelfRelativeDescriptor[firstACE+2:firstACE+4], 17)
		}},
		{name: "oversized ACE", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			binary.LittleEndian.PutUint16(value.SelfRelativeDescriptor[firstACE+2:firstACE+4], ^uint16(0))
		}},
		{name: "empty ACE mask", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			binary.LittleEndian.PutUint32(value.SelfRelativeDescriptor[firstACE+4:firstACE+8], 0)
		}},
		{name: "MAXIMUM_ALLOWED ACE", mutate: func(value *winfile.SecurityDescriptorEvidence) {
			binary.LittleEndian.PutUint32(value.SelfRelativeDescriptor[firstACE+4:firstACE+8], uint32(maximumAllowed))
		}},
	}
}

func FuzzAuditMalformedDescriptorNeverPanics(f *testing.F) {
	f.Add([]byte(nil))
	f.Add([]byte{1, 0, 4, 128})
	f.Fuzz(func(t *testing.T, raw []byte) {
		if len(raw) > maximumDescriptorBytes+1 {
			return
		}
		evidence := winfile.SecurityDescriptorEvidence{SelfRelativeDescriptor: append([]byte(nil), raw...)}
		_ = Audit(evidence, winfile.ObjectKindDirectory, NewAmbientAncestorProfile())
	})
}
