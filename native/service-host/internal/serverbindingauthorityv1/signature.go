package serverbindingauthorityv1

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"math/big"
)

const (
	receiptSignatureDomain      = "AgenticReview Server binding receipt v1\x00"
	activeStatusSignatureDomain = "AgenticReview Server binding active status v1\x00"
	canonicalP256SPKIPrefixHex  = "3059301306072a8648ce3d020106082a8648ce3d03010703420004"
	canonicalP256SPKIBytes      = 91
)

// ReceiptSigningPreimage returns the exact bytes a single-hashing signing API must receive.
func ReceiptSigningPreimage(statement ServerBindingReceiptStatementV1) ([]byte, error) {
	canonical, err := marshalReceiptStatement(statement)
	if err != nil {
		return nil, err
	}
	result := make([]byte, 0, len(receiptSignatureDomain)+len(canonical))
	result = append(result, receiptSignatureDomain...)
	result = append(result, canonical...)
	return result, nil
}

// ReceiptSigningDigest returns the raw prehash a native ECDSA verifier must verify directly.
func ReceiptSigningDigest(statement ServerBindingReceiptStatementV1) ([sha256.Size]byte, error) {
	preimage, err := ReceiptSigningPreimage(statement)
	if err != nil {
		return [sha256.Size]byte{}, err
	}
	return sha256.Sum256(preimage), nil
}

// ActiveStatusSigningPreimage returns the exact bytes a single-hashing signing API must receive.
func ActiveStatusSigningPreimage(statement ServerBindingActiveStatusStatementV1) ([]byte, error) {
	canonical, err := marshalActiveStatusStatement(statement)
	if err != nil {
		return nil, err
	}
	result := make([]byte, 0, len(activeStatusSignatureDomain)+len(canonical))
	result = append(result, activeStatusSignatureDomain...)
	result = append(result, canonical...)
	return result, nil
}

// ActiveStatusSigningDigest returns the raw prehash a native ECDSA verifier must verify directly.
func ActiveStatusSigningDigest(statement ServerBindingActiveStatusStatementV1) ([sha256.Size]byte, error) {
	preimage, err := ActiveStatusSigningPreimage(statement)
	if err != nil {
		return [sha256.Size]byte{}, err
	}
	return sha256.Sum256(preimage), nil
}

// ValidateIssuerSPKI accepts only the exact 91-byte canonical uncompressed P-256 PKIX DER form.
func ValidateIssuerSPKI(document []byte) error {
	_, _, err := parseCanonicalP256SPKI(document)
	return err
}

// DeriveIssuerKeyID returns the lowercase SHA-256 of an exact canonical issuer SPKI.
func DeriveIssuerKeyID(document []byte) (string, error) {
	_, digest, err := parseCanonicalP256SPKI(document)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(digest[:]), nil
}

// VerifyReceiptWithSPKI verifies one canonical receipt with ordinary caller-supplied key bytes.
// Success is a signature fact only and does not mint trust or evidence.
func VerifyReceiptWithSPKI(document, issuerSPKI []byte) (ServerBindingReceiptV1, error) {
	value, err := ParseReceipt(document)
	if err != nil {
		return ServerBindingReceiptV1{}, err
	}
	key, keyDigest, err := parseCanonicalP256SPKI(issuerSPKI)
	if err != nil || !constantTimeHexDigestEqual(value.IssuerKeyID, keyDigest) {
		return ServerBindingReceiptV1{}, fmt.Errorf("%w: receipt issuer key differs", ErrSignature)
	}
	r, s, err := parseP1363Signature(value.Signature)
	if err != nil {
		return ServerBindingReceiptV1{}, err
	}
	digest, err := ReceiptSigningDigest(value.Statement)
	if err != nil || !ecdsa.Verify(key, digest[:], r, s) {
		return ServerBindingReceiptV1{}, fmt.Errorf("%w: receipt verification failed", ErrSignature)
	}
	return value, nil
}

// VerifyActiveStatusWithSPKI verifies one canonical assertion with ordinary caller-supplied key
// bytes. It does not check trusted time or challenge state and cannot mint evidence.
func VerifyActiveStatusWithSPKI(document, issuerSPKI []byte) (ServerBindingActiveStatusV1, error) {
	value, err := ParseActiveStatus(document)
	if err != nil {
		return ServerBindingActiveStatusV1{}, err
	}
	key, keyDigest, err := parseCanonicalP256SPKI(issuerSPKI)
	if err != nil || !constantTimeHexDigestEqual(value.IssuerKeyID, keyDigest) {
		return ServerBindingActiveStatusV1{}, fmt.Errorf("%w: active-status issuer key differs", ErrSignature)
	}
	r, s, err := parseP1363Signature(value.Signature)
	if err != nil {
		return ServerBindingActiveStatusV1{}, err
	}
	digest, err := ActiveStatusSigningDigest(value.Statement)
	if err != nil || !ecdsa.Verify(key, digest[:], r, s) {
		return ServerBindingActiveStatusV1{}, fmt.Errorf("%w: active-status verification failed", ErrSignature)
	}
	return value, nil
}

func parseCanonicalP256SPKI(document []byte) (*ecdsa.PublicKey, [sha256.Size]byte, error) {
	var zero [sha256.Size]byte
	if len(document) != canonicalP256SPKIBytes {
		return nil, zero, fmt.Errorf("%w: issuer SPKI shape is invalid", ErrSignature)
	}
	document = bytes.Clone(document)
	prefix, err := hex.DecodeString(canonicalP256SPKIPrefixHex)
	if err != nil || !bytes.HasPrefix(document, prefix) {
		return nil, zero, fmt.Errorf("%w: issuer SPKI shape is invalid", ErrSignature)
	}
	parsed, err := x509.ParsePKIXPublicKey(document)
	if err != nil {
		return nil, zero, fmt.Errorf("%w: issuer SPKI is not PKIX DER", ErrSignature)
	}
	key, ok := parsed.(*ecdsa.PublicKey)
	if !ok || key == nil || key.Curve != elliptic.P256() || key.X == nil || key.Y == nil ||
		key.X.Sign() <= 0 || key.Y.Sign() <= 0 || !elliptic.P256().IsOnCurve(key.X, key.Y) {
		return nil, zero, fmt.Errorf("%w: issuer key is not P-256", ErrSignature)
	}
	canonical, err := x509.MarshalPKIXPublicKey(key)
	if err != nil || !bytes.Equal(canonical, document) {
		return nil, zero, fmt.Errorf("%w: issuer SPKI is not canonical", ErrSignature)
	}
	return key, sha256.Sum256(document), nil
}

func validateP1363Signature(value string) error {
	_, _, err := parseP1363Signature(value)
	return err
}

func parseP1363Signature(value string) (*big.Int, *big.Int, error) {
	if len(value) != 86 {
		return nil, nil, fmt.Errorf("%w: signature length is invalid", ErrSignature)
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(value)
	if err != nil || len(decoded) != 64 || base64.RawURLEncoding.EncodeToString(decoded) != value {
		return nil, nil, fmt.Errorf("%w: signature is not strict unpadded P1363 base64url", ErrSignature)
	}
	r := new(big.Int).SetBytes(decoded[:32])
	s := new(big.Int).SetBytes(decoded[32:])
	order := elliptic.P256().Params().N
	halfOrder := new(big.Int).Rsh(new(big.Int).Set(order), 1)
	if r.Sign() <= 0 || s.Sign() <= 0 || r.Cmp(order) >= 0 || s.Cmp(order) >= 0 || s.Cmp(halfOrder) > 0 {
		return nil, nil, fmt.Errorf("%w: signature scalar is zero, out of range, or high-S", ErrSignature)
	}
	return r, s, nil
}

func constantTimeHexDigestEqual(encoded string, expected [sha256.Size]byte) bool {
	decoded, err := hex.DecodeString(encoded)
	return err == nil && len(decoded) == sha256.Size && subtle.ConstantTimeCompare(decoded, expected[:]) == 1
}
