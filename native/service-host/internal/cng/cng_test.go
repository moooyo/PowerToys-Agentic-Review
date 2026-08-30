package cng

import (
	"encoding/binary"
	"errors"
	"testing"
	"unicode/utf16"
)

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
