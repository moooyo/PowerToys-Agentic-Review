package cng

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"testing"
	"unicode/utf16"
)

const (
	testControlSID  = "S-1-5-80-1-2-3-4-5"
	testExecutorSID = "S-1-5-80-6-7-8-9-10"
)

func TestValidateOptionsPinsCanonicalSecurityInputs(t *testing.T) {
	options, _ := validTestOptions()
	if _, err := validateOptions(options); err != nil {
		t.Fatalf("validateOptions returned an error: %v", err)
	}
	tests := []struct {
		name   string
		mutate func(*Options)
	}{
		{name: "empty key", mutate: func(value *Options) { value.KeyName = "" }},
		{name: "noncanonical key", mutate: func(value *Options) { value.KeyName += " " }},
		{name: "uppercase digest", mutate: func(value *Options) {
			value.ExpectedSecurityDescriptorSHA256 = strings.Repeat("A", 64)
		}},
		{name: "bad control SID", mutate: func(value *Options) { value.ControlServiceSID = "S-1-5-18" }},
		{name: "bad executor SID", mutate: func(value *Options) { value.ExecutorServiceSID += "-11" }},
		{name: "same SIDs", mutate: func(value *Options) { value.ExecutorServiceSID = value.ControlServiceSID }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := options
			test.mutate(&value)
			if _, err := validateOptions(value); !errors.Is(err, ErrInvalidOptions) {
				t.Fatalf("expected ErrInvalidOptions, got %v", err)
			}
		})
	}
}

func TestKeySecurityDescriptorExactDigestAndSafeSemantics(t *testing.T) {
	options, descriptor := validTestOptions()
	digest, err := validateOptions(options)
	if err != nil {
		t.Fatalf("validateOptions returned an error: %v", err)
	}
	evidence, err := parseKeySecurityDescriptor(descriptor)
	if err != nil {
		t.Fatalf("parseKeySecurityDescriptor returned an error: %v", err)
	}
	if err := validateKeySecurityEvidence(evidence, digest, testControlSID, testExecutorSID); err != nil {
		t.Fatalf("validateKeySecurityEvidence returned an error: %v", err)
	}
	evidence.raw[0] ^= 0xff
	if descriptor[0] != 1 {
		t.Fatal("security evidence aliases its input")
	}

	evidence, _ = parseKeySecurityDescriptor(descriptor)
	mappedRead := evidence
	mappedRead.entries = append([]keySecurityACE(nil), evidence.entries...)
	mappedRead.entries[2].mask = mappedGenericRead
	if err := validateKeySecurityEvidence(mappedRead, digest, testControlSID, testExecutorSID); err != nil {
		t.Fatalf("mapped GenericRead was rejected: %v", err)
	}
	tests := []struct {
		name   string
		mutate func(*keySecurityEvidence, *[sha256.Size]byte)
	}{
		{name: "digest", mutate: func(_ *keySecurityEvidence, value *[sha256.Size]byte) { value[0] ^= 1 }},
		{name: "unprotected", mutate: func(value *keySecurityEvidence, _ *[sha256.Size]byte) { value.control &^= securityDACLProtected }},
		{name: "defaulted owner", mutate: func(value *keySecurityEvidence, _ *[sha256.Size]byte) { value.ownerDefaulted = true }},
		{name: "service owner", mutate: func(value *keySecurityEvidence, _ *[sha256.Size]byte) { value.ownerSID = testControlSID }},
		{name: "executor", mutate: func(value *keySecurityEvidence, _ *[sha256.Size]byte) { value.entries[2].sid = testExecutorSID }},
		{name: "extra trustee", mutate: func(value *keySecurityEvidence, _ *[sha256.Size]byte) { value.entries[2].sid = "S-1-5-11" }},
		{name: "deny ACE", mutate: func(value *keySecurityEvidence, _ *[sha256.Size]byte) { value.entries[2].aceType = 1 }},
		{name: "inherited ACE", mutate: func(value *keySecurityEvidence, _ *[sha256.Size]byte) { value.entries[2].flags = 0x10 }},
		{name: "control changes DACL", mutate: func(value *keySecurityEvidence, _ *[sha256.Size]byte) { value.entries[2].mask |= writeDACLAccess }},
		{name: "recovery lacks control", mutate: func(value *keySecurityEvidence, _ *[sha256.Size]byte) { value.entries[0].mask = genericReadAccess }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := evidence
			value.raw = append([]byte(nil), evidence.raw...)
			value.entries = append([]keySecurityACE(nil), evidence.entries...)
			expected := digest
			test.mutate(&value, &expected)
			if err := validateKeySecurityEvidence(value, expected, testControlSID, testExecutorSID); !errors.Is(err, ErrInvalidKeySecurity) {
				t.Fatalf("expected ErrInvalidKeySecurity, got %v", err)
			}
		})
	}
}

func TestParseKeySecurityDescriptorRejectsMalformedOffsetsAndLengths(t *testing.T) {
	_, descriptor := validTestOptions()
	tests := []struct {
		name   string
		mutate func([]byte) []byte
	}{
		{name: "short", mutate: func([]byte) []byte { return make([]byte, 19) }},
		{name: "revision", mutate: func(value []byte) []byte { value[0] = 2; return value }},
		{name: "owner offset", mutate: func(value []byte) []byte {
			binary.LittleEndian.PutUint32(value[4:8], ^uint32(0))
			return value
		}},
		{name: "DACL offset", mutate: func(value []byte) []byte {
			binary.LittleEndian.PutUint32(value[16:20], ^uint32(0))
			return value
		}},
		{name: "ACL size", mutate: func(value []byte) []byte {
			offset := binary.LittleEndian.Uint32(value[16:20])
			binary.LittleEndian.PutUint16(value[offset+2:offset+4], ^uint16(0))
			return value
		}},
		{name: "ACE count", mutate: func(value []byte) []byte {
			offset := binary.LittleEndian.Uint32(value[16:20])
			binary.LittleEndian.PutUint16(value[offset+4:offset+6], maximumKeySecurityACEs+1)
			return value
		}},
		{name: "ACE size", mutate: func(value []byte) []byte {
			offset := binary.LittleEndian.Uint32(value[16:20])
			binary.LittleEndian.PutUint16(value[offset+10:offset+12], ^uint16(0))
			return value
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := test.mutate(append([]byte(nil), descriptor...))
			if _, err := parseKeySecurityDescriptor(value); !errors.Is(err, ErrInvalidKeySecurity) {
				t.Fatalf("expected ErrInvalidKeySecurity, got %v", err)
			}
		})
	}
}

func TestP256PublicBlobAndSignatureVerification(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate P-256 fixture: %v", err)
	}
	blob := make([]byte, 8+2*DigestSize)
	binary.LittleEndian.PutUint32(blob[:4], ecdsaPublicP256Magic)
	binary.LittleEndian.PutUint32(blob[4:8], DigestSize)
	privateKey.X.FillBytes(blob[8 : 8+DigestSize])
	privateKey.Y.FillBytes(blob[8+DigestSize:])
	publicKey, err := parseP256PublicBlob(blob)
	if err != nil {
		t.Fatalf("parseP256PublicBlob returned an error: %v", err)
	}
	spki, err := x509.MarshalPKIXPublicKey(&privateKey.PublicKey)
	if err != nil {
		t.Fatalf("marshal fixture SPKI: %v", err)
	}
	expectedSPKIDigest := sha256.Sum256(spki)
	actualSPKIDigest, err := p256PublicKeySPKISHA256(publicKey)
	if err != nil {
		t.Fatalf("p256PublicKeySPKISHA256 returned an error: %v", err)
	}
	if actualSPKIDigest != expectedSPKIDigest {
		t.Fatalf("SPKI digest is %x, want %x", actualSPKIDigest, expectedSPKIDigest)
	}

	digest := sha256.Sum256([]byte("cng-signature-verification"))
	r, s, err := ecdsa.Sign(rand.Reader, privateKey, digest[:])
	if err != nil {
		t.Fatalf("sign fixture digest: %v", err)
	}
	signature := joinScalars(r.FillBytes(make([]byte, DigestSize)), s.FillBytes(make([]byte, DigestSize)))
	signature, err = canonicalizeP256Signature(signature)
	if err != nil {
		t.Fatalf("canonicalizeP256Signature returned an error: %v", err)
	}
	if err := verifyP256Signature(publicKey, digest[:], signature); err != nil {
		t.Fatalf("verifyP256Signature returned an error: %v", err)
	}
	digest[0] ^= 1
	if err := verifyP256Signature(publicKey, digest[:], signature); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("expected ErrInvalidSignature, got %v", err)
	}
	blob[0] ^= 1
	if _, err := parseP256PublicBlob(blob); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("expected ErrInvalidKey, got %v", err)
	}
}

func TestDecodeUTF16Property(t *testing.T) {
	value, err := decodeUTF16Property(encodeUTF16Property("ECDSA_P256"))
	if err != nil {
		t.Fatalf("decodeUTF16Property returned an error: %v", err)
	}
	if value != "ECDSA_P256" {
		t.Fatalf("decodeUTF16Property returned %q", value)
	}

	nonBMP, err := decodeUTF16Property(encodeUTF16Property("A\U0001f600"))
	if err != nil || nonBMP != "A\U0001f600" {
		t.Fatalf("decodeUTF16Property did not preserve a surrogate pair: %q, %v", nonBMP, err)
	}
}

func TestDecodeUTF16PropertyRejectsMalformedValues(t *testing.T) {
	tests := []struct {
		name  string
		value []byte
	}{
		{name: "empty"},
		{name: "odd width", value: []byte{0}},
		{name: "missing terminator", value: []byte{'A', 0}},
		{name: "embedded null", value: []byte{'A', 0, 0, 0, 0, 0}},
		{name: "unpaired high surrogate", value: []byte{0x00, 0xd8, 0, 0}},
		{name: "unpaired low surrogate", value: []byte{0x00, 0xdc, 0, 0}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := decodeUTF16Property(test.value); err == nil {
				t.Fatal("decodeUTF16Property accepted malformed input")
			}
		})
	}
}

func TestDecodeUint32PropertyRequiresExactWidth(t *testing.T) {
	encoded := encodeUint32Property(0x12345678)
	value, err := decodeUint32Property(encoded)
	if err != nil {
		t.Fatalf("decodeUint32Property returned an error: %v", err)
	}
	if value != 0x12345678 {
		t.Fatalf("decodeUint32Property returned 0x%08x", value)
	}
	for _, invalid := range [][]byte{nil, {0, 0, 0}, {0, 0, 0, 0, 0}} {
		if _, err := decodeUint32Property(invalid); err == nil {
			t.Fatalf("decodeUint32Property accepted %d bytes", len(invalid))
		}
	}
}

func TestParseAndValidateP256SigningProperties(t *testing.T) {
	properties, err := parseKeyProperties(
		encodeUTF16Property("ECDSA_P256"),
		encodeUint32Property(256),
		encodeUint32Property(0),
		encodeUint32Property(ncryptAllowSigningFlag),
	)
	if err != nil {
		t.Fatalf("parseKeyProperties returned an error: %v", err)
	}
	if err := validateP256SigningProperties(properties); err != nil {
		t.Fatalf("validateP256SigningProperties returned an error: %v", err)
	}
}

func TestP256SigningPropertiesRejectEveryPolicyMismatch(t *testing.T) {
	valid := keyProperties{
		algorithm:    "ECDSA_P256",
		length:       256,
		exportPolicy: 0,
		keyUsage:     ncryptAllowSigningFlag,
	}
	tests := []struct {
		name   string
		mutate func(*keyProperties)
	}{
		{name: "algorithm", mutate: func(value *keyProperties) { value.algorithm = "ECDSA" }},
		{name: "length", mutate: func(value *keyProperties) { value.length = 384 }},
		{name: "export policy", mutate: func(value *keyProperties) { value.exportPolicy = 1 }},
		{name: "no key usage", mutate: func(value *keyProperties) { value.keyUsage = 0 }},
		{name: "additional key usage", mutate: func(value *keyProperties) { value.keyUsage |= 1 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			properties := valid
			test.mutate(&properties)
			err := validateP256SigningProperties(properties)
			if !errors.Is(err, ErrInvalidKey) {
				t.Fatalf("expected ErrInvalidKey, got %v", err)
			}
		})
	}
}

func TestCanonicalizeP256SignaturePreservesLowSAndDoesNotAlias(t *testing.T) {
	one := scalarOne()
	signature := joinScalars(one[:], one[:])
	canonical, err := canonicalizeP256Signature(signature)
	if err != nil {
		t.Fatalf("canonicalizeP256Signature returned an error: %v", err)
	}
	if string(canonical) != string(signature) {
		t.Fatal("canonicalizeP256Signature changed a low-S signature")
	}
	canonical[0] ^= 0xff
	if signature[0] != one[0] {
		t.Fatal("canonicalizeP256Signature returned an alias of its input")
	}
}

func TestCanonicalizeP256SignatureNormalizesHighS(t *testing.T) {
	one := scalarOne()
	high := p256Order
	decrementBigEndian(high[:])
	signature := joinScalars(one[:], high[:])
	canonical, err := canonicalizeP256Signature(signature)
	if err != nil {
		t.Fatalf("canonicalizeP256Signature returned an error: %v", err)
	}
	if string(canonical[DigestSize:]) != string(one[:]) {
		t.Fatalf("high-S value was not normalized to one: %x", canonical[DigestSize:])
	}

	aboveHalf := p256HalfOrder
	incrementBigEndian(aboveHalf[:])
	canonical, err = canonicalizeP256Signature(joinScalars(one[:], aboveHalf[:]))
	if err != nil {
		t.Fatalf("canonicalizeP256Signature returned an error: %v", err)
	}
	if string(canonical[DigestSize:]) != string(p256HalfOrder[:]) {
		t.Fatalf("half-order boundary normalized incorrectly: %x", canonical[DigestSize:])
	}
}

func TestCanonicalizeP256SignatureRejectsInvalidScalars(t *testing.T) {
	one := scalarOne()
	zero := [DigestSize]byte{}
	tests := []struct {
		name      string
		signature []byte
	}{
		{name: "short signature", signature: make([]byte, SignatureSize-1)},
		{name: "long signature", signature: make([]byte, SignatureSize+1)},
		{name: "zero r", signature: joinScalars(zero[:], one[:])},
		{name: "order r", signature: joinScalars(p256Order[:], one[:])},
		{name: "zero s", signature: joinScalars(one[:], zero[:])},
		{name: "order s", signature: joinScalars(one[:], p256Order[:])},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := canonicalizeP256Signature(test.signature)
			if !errors.Is(err, ErrInvalidSignature) {
				t.Fatalf("expected ErrInvalidSignature, got %v", err)
			}
		})
	}
}

func encodeUTF16Property(value string) []byte {
	units := append(utf16.Encode([]rune(value)), 0)
	encoded := make([]byte, len(units)*2)
	for index, unit := range units {
		binary.LittleEndian.PutUint16(encoded[index*2:], unit)
	}
	return encoded
}

func encodeUint32Property(value uint32) []byte {
	encoded := make([]byte, 4)
	binary.LittleEndian.PutUint32(encoded, value)
	return encoded
}

func scalarOne() [DigestSize]byte {
	var value [DigestSize]byte
	value[len(value)-1] = 1
	return value
}

func joinScalars(r []byte, s []byte) []byte {
	signature := make([]byte, 0, len(r)+len(s))
	signature = append(signature, r...)
	signature = append(signature, s...)
	return signature
}

func incrementBigEndian(value []byte) {
	for index := len(value) - 1; index >= 0; index-- {
		value[index]++
		if value[index] != 0 {
			return
		}
	}
}

func decrementBigEndian(value []byte) {
	for index := len(value) - 1; index >= 0; index-- {
		before := value[index]
		value[index]--
		if before != 0 {
			return
		}
	}
}

func validTestOptions() (Options, []byte) {
	descriptor := encodeTestSecurityDescriptor(
		systemSID,
		[]keySecurityACE{
			{sid: systemSID, mask: genericAllAccess, aceType: accessAllowedACEType},
			{sid: administratorsSID, mask: genericAllAccess, aceType: accessAllowedACEType},
			{sid: testControlSID, mask: genericReadAccess, aceType: accessAllowedACEType},
		},
	)
	digest := sha256.Sum256(descriptor)
	return Options{
		KeyName:                          "AgenticReview.Worker.Control.LocalAuthority",
		ExpectedSecurityDescriptorSHA256: hex.EncodeToString(digest[:]),
		ControlServiceSID:                testControlSID,
		ExecutorServiceSID:               testExecutorSID,
	}, descriptor
}

func encodeTestSecurityDescriptor(owner string, entries []keySecurityACE) []byte {
	ownerBytes := encodeTestSID(owner)
	daclBytes := encodeTestDACL(entries)
	value := make([]byte, 20+len(ownerBytes)+len(daclBytes))
	value[0] = 1
	binary.LittleEndian.PutUint16(
		value[2:4],
		securityDACLPresent|securityDACLProtected|securityDescriptorSelfRelative,
	)
	binary.LittleEndian.PutUint32(value[4:8], 20)
	binary.LittleEndian.PutUint32(value[16:20], uint32(20+len(ownerBytes)))
	copy(value[20:], ownerBytes)
	copy(value[20+len(ownerBytes):], daclBytes)
	return value
}

func encodeTestDACL(entries []keySecurityACE) []byte {
	aces := make([][]byte, len(entries))
	total := 8
	for index, entry := range entries {
		sid := encodeTestSID(entry.sid)
		ace := make([]byte, 8+len(sid))
		ace[0] = entry.aceType
		ace[1] = entry.flags
		binary.LittleEndian.PutUint16(ace[2:4], uint16(len(ace)))
		binary.LittleEndian.PutUint32(ace[4:8], entry.mask)
		copy(ace[8:], sid)
		aces[index] = ace
		total += len(ace)
	}
	value := make([]byte, total)
	value[0] = aclRevision
	binary.LittleEndian.PutUint16(value[2:4], uint16(total))
	binary.LittleEndian.PutUint16(value[4:6], uint16(len(entries)))
	offset := 8
	for _, ace := range aces {
		copy(value[offset:], ace)
		offset += len(ace)
	}
	return value
}

func encodeTestSID(value string) []byte {
	parts := strings.Split(value, "-")
	authority, _ := strconv.ParseUint(parts[2], 10, 48)
	result := make([]byte, 8+4*(len(parts)-3))
	result[0] = 1
	result[1] = byte(len(parts) - 3)
	for index := 0; index < 6; index++ {
		result[7-index] = byte(authority)
		authority >>= 8
	}
	for index, part := range parts[3:] {
		subauthority, _ := strconv.ParseUint(part, 10, 32)
		binary.LittleEndian.PutUint32(result[8+index*4:], uint32(subauthority))
	}
	return result
}
