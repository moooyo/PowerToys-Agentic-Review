package cng

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"unicode/utf16"
)

const (
	// DigestSize is the only digest length accepted by SignDigest.
	DigestSize = 32
	// SignatureSize is the fixed size of a P-256 P1363 signature.
	SignatureSize = 64

	ncryptAllowSigningFlag = uint32(0x00000002)
)

var (
	ErrUnsupported        = errors.New("Windows CNG signing is unsupported on this platform")
	ErrInvalidOptions     = errors.New("invalid CNG signer options")
	ErrInvalidDigest      = errors.New("CNG signing requires an exactly 32-byte digest")
	ErrInvalidKey         = errors.New("CNG key does not satisfy the P-256 signing policy")
	ErrInvalidKeySecurity = errors.New("CNG key security descriptor is invalid")
	ErrInvalidSignature   = errors.New("CNG returned an invalid P-256 signature")
	ErrClosed             = errors.New("CNG signer is closed")
)

// Options selects one Local Machine key and pins its installed access policy.
// The storage provider is deliberately fixed and is not caller-selectable.
type Options struct {
	KeyName                          string
	ExpectedSecurityDescriptorSHA256 string
	ControlServiceSID                string
	ExecutorServiceSID               string
}

// KeyIdentity is a detached, comparable identity for a persisted CNG key.
// It contains no native handle and can be compared with another credential's
// identity to reject accidental key reuse across security purposes.
type KeyIdentity struct {
	ProviderName string
	UniqueName   string
	MachineKey   bool
}

// StatusError reports a failing SECURITY_STATUS returned by an NCrypt function.
type StatusError struct {
	Operation string
	Code      uint32
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("%s failed with SECURITY_STATUS 0x%08x", e.Operation, e.Code)
}

var p256Order = [32]byte{
	0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00,
	0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
	0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84,
	0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
}

var p256HalfOrder = [32]byte{
	0x7f, 0xff, 0xff, 0xff, 0x80, 0x00, 0x00, 0x00,
	0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
	0xde, 0x73, 0x7d, 0x56, 0xd3, 0x8b, 0xcf, 0x42,
	0x79, 0xdc, 0xe5, 0x61, 0x7e, 0x31, 0x92, 0xa8,
}

type keyProperties struct {
	algorithm    string
	length       uint32
	exportPolicy uint32
	keyUsage     uint32
}

func parseKeyProperties(
	algorithmValue []byte,
	lengthValue []byte,
	exportPolicyValue []byte,
	keyUsageValue []byte,
) (keyProperties, error) {
	algorithm, err := decodeUTF16Property(algorithmValue)
	if err != nil {
		return keyProperties{}, fmt.Errorf("decode Algorithm property: %w", err)
	}
	length, err := decodeUint32Property(lengthValue)
	if err != nil {
		return keyProperties{}, fmt.Errorf("decode Length property: %w", err)
	}
	exportPolicy, err := decodeUint32Property(exportPolicyValue)
	if err != nil {
		return keyProperties{}, fmt.Errorf("decode Export Policy property: %w", err)
	}
	keyUsage, err := decodeUint32Property(keyUsageValue)
	if err != nil {
		return keyProperties{}, fmt.Errorf("decode Key Usage property: %w", err)
	}
	return keyProperties{
		algorithm:    algorithm,
		length:       length,
		exportPolicy: exportPolicy,
		keyUsage:     keyUsage,
	}, nil
}

func validateP256SigningProperties(properties keyProperties) error {
	if properties.algorithm != "ECDSA_P256" {
		return fmt.Errorf("%w: Algorithm is %q", ErrInvalidKey, properties.algorithm)
	}
	if properties.length != 256 {
		return fmt.Errorf("%w: Length is %d", ErrInvalidKey, properties.length)
	}
	if properties.exportPolicy != 0 {
		return fmt.Errorf("%w: Export Policy is 0x%08x", ErrInvalidKey, properties.exportPolicy)
	}
	if properties.keyUsage != ncryptAllowSigningFlag {
		return fmt.Errorf("%w: Key Usage is 0x%08x", ErrInvalidKey, properties.keyUsage)
	}
	return nil
}

func decodeUTF16Property(value []byte) (string, error) {
	if len(value) < 2 || len(value)%2 != 0 {
		return "", errors.New("value is not a non-empty sequence of UTF-16 code units")
	}

	units := make([]uint16, len(value)/2)
	for index := range units {
		units[index] = binary.LittleEndian.Uint16(value[index*2:])
	}
	if units[len(units)-1] != 0 {
		return "", errors.New("value is not null-terminated")
	}
	units = units[:len(units)-1]
	for index := 0; index < len(units); index++ {
		unit := units[index]
		if unit == 0 {
			return "", errors.New("value contains an embedded null")
		}
		if unit >= 0xd800 && unit <= 0xdbff {
			if index+1 >= len(units) || units[index+1] < 0xdc00 || units[index+1] > 0xdfff {
				return "", errors.New("value contains an unpaired UTF-16 surrogate")
			}
			index++
			continue
		}
		if unit >= 0xdc00 && unit <= 0xdfff {
			return "", errors.New("value contains an unpaired UTF-16 surrogate")
		}
	}
	return string(utf16.Decode(units)), nil
}

func decodeUint32Property(value []byte) (uint32, error) {
	if len(value) != 4 {
		return 0, fmt.Errorf("value has %d bytes instead of 4", len(value))
	}
	return binary.LittleEndian.Uint32(value), nil
}

func canonicalizeP256Signature(signature []byte) ([]byte, error) {
	if len(signature) != SignatureSize {
		return nil, fmt.Errorf("%w: signature has %d bytes instead of %d", ErrInvalidSignature, len(signature), SignatureSize)
	}

	result := append([]byte(nil), signature...)
	r := result[:DigestSize]
	s := result[DigestSize:]
	if !validP256Scalar(r) {
		return nil, fmt.Errorf("%w: r is outside the P-256 scalar range", ErrInvalidSignature)
	}
	if !validP256Scalar(s) {
		return nil, fmt.Errorf("%w: s is outside the P-256 scalar range", ErrInvalidSignature)
	}
	if bytes.Compare(s, p256HalfOrder[:]) > 0 {
		subtractBigEndian(s, p256Order[:], s)
	}
	return result, nil
}

func validP256Scalar(value []byte) bool {
	if len(value) != DigestSize || bytes.Compare(value, p256Order[:]) >= 0 {
		return false
	}
	for _, octet := range value {
		if octet != 0 {
			return true
		}
	}
	return false
}

func subtractBigEndian(destination []byte, left []byte, right []byte) {
	borrow := 0
	for index := len(left) - 1; index >= 0; index-- {
		difference := int(left[index]) - int(right[index]) - borrow
		if difference < 0 {
			difference += 256
			borrow = 1
		} else {
			borrow = 0
		}
		destination[index] = byte(difference)
	}
}
