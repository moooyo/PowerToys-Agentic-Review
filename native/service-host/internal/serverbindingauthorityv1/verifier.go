package serverbindingauthorityv1

import (
	"bytes"
	"crypto/sha256"
	"time"
)

type verifierIssuerSeal struct{ marker byte }

var productionVerifierIssuer = &verifierIssuerSeal{marker: 1}

type trustedClock struct {
	now func() time.Time
}

type verifierState struct {
	issuer *verifierIssuerSeal
	spki   []byte
	keyID  [sha256.Size]byte
	clock  *trustedClock
}

// Verifier is opaque compiled trust. Its zero value is invalid, and no public API accepts a key
// or clock that could construct one.
type Verifier struct {
	state *verifierState
}

// ProductionVerifier remains unavailable until a separately reviewed signed trust profile exists.
func ProductionVerifier() (Verifier, error) {
	return Verifier{}, ErrUnavailable
}

// Validate rejects zero, forged, incomplete, or internally inconsistent verifier state.
func (verifier Verifier) Validate() error {
	state := verifier.state
	if state == nil || state.issuer != productionVerifierIssuer || state.clock == nil ||
		state.clock.now == nil || len(state.spki) != canonicalP256SPKIBytes ||
		state.keyID == ([sha256.Size]byte{}) {
		return ErrInvalidVerifier
	}
	_, digest, err := parseCanonicalP256SPKI(state.spki)
	if err != nil || digest != state.keyID {
		return ErrInvalidVerifier
	}
	return nil
}

// VerifyReceipt verifies a historical receipt only with this opaque trust source. The returned
// value remains ordinary data and is not current-status evidence.
func (verifier Verifier) VerifyReceipt(document []byte) (ServerBindingReceiptV1, error) {
	if err := verifier.Validate(); err != nil {
		return ServerBindingReceiptV1{}, err
	}
	return VerifyReceiptWithSPKI(document, bytes.Clone(verifier.state.spki))
}

func (clock *trustedClock) read() (time.Time, error) {
	if clock == nil || clock.now == nil {
		return time.Time{}, ErrInvalidVerifier
	}
	now := clock.now()
	if now.IsZero() {
		return time.Time{}, ErrInvalidVerifier
	}
	return now, nil
}
