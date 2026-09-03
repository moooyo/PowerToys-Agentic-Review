package outerpackage

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

const signatureDomain = "AgenticReview outer package index signature v1\x00"

// MarshalSignatureEnvelopeCanonical validates and serializes a detached signature envelope.
func MarshalSignatureEnvelopeCanonical(value SignatureEnvelope) ([]byte, error) {
	if _, _, err := validateSignatureEnvelope(value); err != nil {
		return nil, err
	}
	return marshalCanonical(value, MaximumEnvelopeBytes)
}

// ParseSignatureEnvelope accepts only the canonical detached signature representation.
func ParseSignatureEnvelope(document []byte) (SignatureEnvelope, error) {
	var parsed SignatureEnvelope
	err := parseStrictCanonical(document, MaximumEnvelopeBytes, &parsed, func() ([]byte, error) {
		return MarshalSignatureEnvelopeCanonical(parsed)
	})
	if err != nil {
		return SignatureEnvelope{}, err
	}
	return parsed, nil
}

// SigningDigest returns the domain-separated SHA-256 digest for canonical package-index bytes.
// It performs no private-key operation.
func SigningDigest(indexDocument []byte) ([sha256.Size]byte, error) {
	index, err := ParseIndex(indexDocument)
	if err != nil {
		return [sha256.Size]byte{}, err
	}
	if index.SchemaVersion != IndexSchemaVersion || index.ProfileID != IndexProfileID {
		return [sha256.Size]byte{}, fmt.Errorf("%w: package index profile has no signature policy", ErrSignature)
	}
	digest := sha256.New()
	_, _ = digest.Write([]byte(signatureDomain))
	_, _ = digest.Write(indexDocument)
	var result [sha256.Size]byte
	copy(result[:], digest.Sum(nil))
	return result, nil
}

// VerifyDetachedSignature verifies the canonical index and envelope with one trusted P-256 SPKI.
// The trusted key parameter is not self-authenticating and must eventually come only from a
// compiled outertrust adapter. Success is not production installation evidence.
func VerifyDetachedSignature(indexDocument, envelopeDocument, trustedSPKI []byte) error {
	envelope, err := ParseSignatureEnvelope(envelopeDocument)
	if err != nil {
		return err
	}
	indexDigest := sha256.Sum256(indexDocument)
	if subtle.ConstantTimeCompare(
		[]byte(envelope.IndexSHA256),
		[]byte(hex.EncodeToString(indexDigest[:])),
	) != 1 {
		return fmt.Errorf("%w: envelope index digest differs", ErrSignature)
	}
	key, keyID, err := parseTrustedP256SPKI(trustedSPKI)
	if err != nil || subtle.ConstantTimeCompare([]byte(envelope.SignerKeyID), []byte(keyID)) != 1 {
		return fmt.Errorf("%w: trusted signer key is invalid or mismatched", ErrSignature)
	}
	r, s, err := validateSignatureEnvelope(envelope)
	if err != nil {
		return err
	}
	digest, err := SigningDigest(indexDocument)
	if err != nil || !ecdsa.Verify(key, digest[:], r, s) {
		return fmt.Errorf("%w: P-256 signature verification failed", ErrSignature)
	}
	return nil
}

func validateSignatureEnvelope(value SignatureEnvelope) (*big.Int, *big.Int, error) {
	if value.SchemaVersion != SignatureSchemaVersion || value.Algorithm != SignatureAlgorithm ||
		!validSHA256(value.IndexSHA256) || !validSHA256(value.SignerKeyID) {
		return nil, nil, fmt.Errorf("%w: signature envelope fields are invalid", ErrSignature)
	}
	encoded, err := base64.RawURLEncoding.DecodeString(value.Signature)
	if err != nil || len(encoded) != 64 || base64.RawURLEncoding.EncodeToString(encoded) != value.Signature {
		return nil, nil, fmt.Errorf("%w: signature is not canonical 64-byte base64url", ErrSignature)
	}
	r := new(big.Int).SetBytes(encoded[:32])
	s := new(big.Int).SetBytes(encoded[32:])
	order := elliptic.P256().Params().N
	halfOrder := new(big.Int).Rsh(new(big.Int).Set(order), 1)
	if r.Sign() <= 0 || s.Sign() <= 0 || r.Cmp(order) >= 0 || s.Cmp(order) >= 0 || s.Cmp(halfOrder) > 0 {
		return nil, nil, fmt.Errorf("%w: signature scalars are zero, out of range, or high-S", ErrSignature)
	}
	return r, s, nil
}

func parseTrustedP256SPKI(document []byte) (*ecdsa.PublicKey, string, error) {
	if len(document) == 0 || len(document) > 4*1024 {
		return nil, "", ErrSignature
	}
	parsed, err := x509.ParsePKIXPublicKey(document)
	if err != nil {
		return nil, "", ErrSignature
	}
	key, ok := parsed.(*ecdsa.PublicKey)
	if !ok || key == nil || key.Curve != elliptic.P256() || key.X == nil || key.Y == nil ||
		key.X.Sign() <= 0 || key.Y.Sign() <= 0 || !elliptic.P256().IsOnCurve(key.X, key.Y) {
		return nil, "", ErrSignature
	}
	canonical, err := x509.MarshalPKIXPublicKey(key)
	if err != nil || !bytes.Equal(canonical, document) {
		return nil, "", ErrSignature
	}
	digest := sha256.Sum256(document)
	return key, hex.EncodeToString(digest[:]), nil
}
