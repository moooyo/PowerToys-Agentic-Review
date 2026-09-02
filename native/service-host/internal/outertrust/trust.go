package outertrust

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
)

const MaximumSPKIBytes = 4 * 1024

var (
	ErrUnavailable     = errors.New("compiled outer package trust is unavailable")
	ErrInvalid         = errors.New("compiled outer package trust is invalid")
	ErrInvalidEvidence = errors.New("compiled outer package trust evidence is invalid")
	ErrSignature       = errors.New("outer package signature was rejected by compiled trust")
)

type evidenceIssuer struct{ marker byte }

var productionEvidenceIssuer = &evidenceIssuer{marker: 1}

type evidenceState struct {
	issuer *evidenceIssuer
	spki   []byte
	digest [sha256.Size]byte
}

// Evidence is an opaque immutable capability backed only by the compiled outer signer key. Its
// zero value is invalid, and no caller-supplied key can construct it.
type Evidence struct {
	state *evidenceState
}

// Production loads the single compiled outer signer. It never reads environment variables,
// command-line arguments, runtime configuration, or package content.
func Production() (Evidence, error) {
	if compiledOuterSignerSPKIBase64URL == "" && compiledOuterSignerSPKISHA256 == "" {
		return Evidence{}, ErrUnavailable
	}
	if compiledOuterSignerSPKIBase64URL == "" || compiledOuterSignerSPKISHA256 == "" {
		return Evidence{}, ErrInvalid
	}
	return loadCompiled(
		compiledOuterSignerSPKIBase64URL,
		compiledOuterSignerSPKISHA256,
	)
}

func loadCompiled(encodedSPKI, expectedSHA256 string) (Evidence, error) {
	if !validSHA256(expectedSHA256) {
		return Evidence{}, ErrInvalid
	}
	spki, err := base64.RawURLEncoding.DecodeString(encodedSPKI)
	if err != nil || len(spki) == 0 || len(spki) > MaximumSPKIBytes ||
		base64.RawURLEncoding.EncodeToString(spki) != encodedSPKI {
		return Evidence{}, ErrInvalid
	}
	if err := ValidateSignerSPKI(spki); err != nil {
		return Evidence{}, ErrInvalid
	}
	digest := sha256.Sum256(spki)
	if subtle.ConstantTimeCompare(
		[]byte(hex.EncodeToString(digest[:])),
		[]byte(expectedSHA256),
	) != 1 {
		return Evidence{}, ErrInvalid
	}
	evidence := Evidence{state: &evidenceState{
		issuer: productionEvidenceIssuer,
		spki:   bytes.Clone(spki),
		digest: digest,
	}}
	if err := evidence.Validate(); err != nil {
		return Evidence{}, err
	}
	return evidence, nil
}

// ValidateSignerSPKI validates ordinary build-time bytes without minting trust evidence.
func ValidateSignerSPKI(document []byte) error {
	_, err := parseCanonicalP256SPKI(document)
	return err
}

// Validate rejects zero, forged, incomplete, or internally mutated trust evidence.
func (evidence Evidence) Validate() error {
	state := evidence.state
	if state == nil || state.issuer != productionEvidenceIssuer || len(state.spki) == 0 ||
		state.digest == ([sha256.Size]byte{}) || len(state.spki) > MaximumSPKIBytes {
		return ErrInvalidEvidence
	}
	if _, err := parseCanonicalP256SPKI(state.spki); err != nil || sha256.Sum256(state.spki) != state.digest {
		return ErrInvalidEvidence
	}
	return nil
}

// SignerKeyID returns the lowercase SHA-256 of the canonical compiled SPKI.
func (evidence Evidence) SignerKeyID() string {
	if evidence.Validate() != nil {
		return ""
	}
	return hex.EncodeToString(evidence.state.digest[:])
}

// Verify checks a canonical index and detached envelope with the compiled signer. Success is a
// signature fact only and is not installation or execution evidence.
func (evidence Evidence) Verify(indexDocument, envelopeDocument []byte) error {
	if evidence.Validate() != nil {
		return ErrInvalidEvidence
	}
	if err := outerpackage.VerifyDetachedSignature(
		indexDocument,
		envelopeDocument,
		bytes.Clone(evidence.state.spki),
	); err != nil {
		return ErrSignature
	}
	return nil
}

func parseCanonicalP256SPKI(document []byte) (*ecdsa.PublicKey, error) {
	if len(document) == 0 || len(document) > MaximumSPKIBytes {
		return nil, fmt.Errorf("%w: SPKI size is invalid", ErrInvalid)
	}
	parsed, err := x509.ParsePKIXPublicKey(document)
	if err != nil {
		return nil, fmt.Errorf("%w: SPKI is not PKIX public-key DER", ErrInvalid)
	}
	key, ok := parsed.(*ecdsa.PublicKey)
	if !ok || key == nil || key.Curve != elliptic.P256() || key.X == nil || key.Y == nil ||
		key.X.Sign() <= 0 || key.Y.Sign() <= 0 || !elliptic.P256().IsOnCurve(key.X, key.Y) {
		return nil, fmt.Errorf("%w: signer is not P-256", ErrInvalid)
	}
	canonical, err := x509.MarshalPKIXPublicKey(key)
	if err != nil || !bytes.Equal(canonical, document) {
		return nil, fmt.Errorf("%w: SPKI is not canonical", ErrInvalid)
	}
	return key, nil
}

func validSHA256(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			if character < 'a' || character > 'f' {
				return false
			}
		}
	}
	return true
}
