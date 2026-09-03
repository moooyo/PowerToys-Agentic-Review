package serverbindingauthorityv1

import (
	"context"
	cryptorand "crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"sync/atomic"
	"time"
)

const (
	opaqueUnused uint32 = iota
	opaqueConsumed
	opaqueClosed
)

type challengeState struct {
	owner     *verifierState
	nonce     [32]byte
	lifecycle atomic.Uint32
}

// ChallengeState is opaque process-local state. Copies share one atomic lifecycle and cannot
// create an independent challenge.
type ChallengeState struct {
	state *challengeState
}

// NewChallenge creates one challenge with the operating-system CSPRNG and binds it to this exact
// verifier instance.
func (verifier Verifier) NewChallenge() (ChallengeState, error) {
	if err := verifier.Validate(); err != nil {
		return ChallengeState{}, err
	}
	state := &challengeState{owner: verifier.state}
	if _, err := cryptorand.Read(state.nonce[:]); err != nil {
		return ChallengeState{}, ErrInvalidChallenge
	}
	return ChallengeState{state: state}, nil
}

// NonceBase64URL returns the exact public nonce to send to the Server while the challenge is unused.
func (challenge ChallengeState) NonceBase64URL() (string, error) {
	if err := challenge.validateUnused(nil); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(challenge.state.nonce[:]), nil
}

// Close permanently invalidates an unused challenge.
func (challenge ChallengeState) Close() error {
	state := challenge.state
	if state == nil {
		return ErrInvalidChallenge
	}
	for {
		switch state.lifecycle.Load() {
		case opaqueUnused:
			if state.lifecycle.CompareAndSwap(opaqueUnused, opaqueClosed) {
				return nil
			}
		case opaqueClosed:
			return nil
		default:
			return ErrChallengeConsumed
		}
	}
}

// MarshalJSON prevents challenge state from becoming a transferable token.
func (ChallengeState) MarshalJSON() ([]byte, error) {
	return nil, ErrNotSerializable
}

func (challenge ChallengeState) validateUnused(owner *verifierState) error {
	state := challenge.state
	if state == nil || state.owner == nil || (owner != nil && state.owner != owner) ||
		(Verifier{state: state.owner}).Validate() != nil {
		return ErrInvalidChallenge
	}
	if state.lifecycle.Load() != opaqueUnused {
		return ErrChallengeConsumed
	}
	return nil
}

func (challenge ChallengeState) invalidate() {
	if challenge.state != nil {
		challenge.state.lifecycle.CompareAndSwap(opaqueUnused, opaqueClosed)
	}
}

type activeStatusEvidenceIssuerSeal struct{ marker byte }

var productionActiveStatusEvidenceIssuer = &activeStatusEvidenceIssuerSeal{marker: 1}

type activeStatusEvidenceState struct {
	issuer      *activeStatusEvidenceIssuerSeal
	owner       *verifierState
	challenge   *challengeState
	nonce       [32]byte
	expectation ActiveStatusExpectation
	expiresAt   time.Time
	clock       *trustedClock
	lifecycle   atomic.Uint32
}

// ActiveStatusEvidence is opaque one-shot freshness evidence. Copies share one atomic lifecycle.
type ActiveStatusEvidence struct {
	state *activeStatusEvidenceState
}

// VerifyActiveStatus verifies trust, exact binding context, fresh trusted time, and the original
// challenge before atomically consuming that challenge and minting one evidence value.
func (verifier Verifier) VerifyActiveStatus(
	ctx context.Context,
	document []byte,
	expected ActiveStatusExpectation,
	challenge ChallengeState,
) (ActiveStatusEvidence, error) {
	fail := func(err error) (ActiveStatusEvidence, error) {
		challenge.invalidate()
		return ActiveStatusEvidence{}, err
	}
	if ctx == nil {
		return fail(ErrCanceled)
	}
	if err := verifier.Validate(); err != nil {
		return fail(err)
	}
	if err := validateExpectation(expected); err != nil {
		return fail(ErrInvalidEvidence)
	}
	if err := challenge.validateUnused(verifier.state); err != nil {
		return fail(err)
	}
	if err := contextError(ctx); err != nil {
		return fail(err)
	}
	assertion, err := VerifyActiveStatusWithSPKI(document, verifier.state.spki)
	if err != nil {
		return fail(err)
	}
	if !activeStatusMatches(assertion.Statement, expected, challenge.state) {
		return fail(ErrInvalidEvidence)
	}
	now, err := verifier.state.clock.read()
	if err != nil {
		return fail(err)
	}
	expiresAt, err := validateActiveStatusTime(assertion.Statement, now)
	if err != nil {
		return fail(err)
	}
	if err := contextError(ctx); err != nil {
		return fail(err)
	}
	if !challenge.state.lifecycle.CompareAndSwap(opaqueUnused, opaqueConsumed) {
		return ActiveStatusEvidence{}, ErrChallengeConsumed
	}
	finalNow, err := verifier.state.clock.read()
	if err != nil || !finalNow.Before(expiresAt) {
		if err != nil {
			return ActiveStatusEvidence{}, err
		}
		return ActiveStatusEvidence{}, ErrExpired
	}
	if err := contextError(ctx); err != nil {
		return ActiveStatusEvidence{}, err
	}
	return ActiveStatusEvidence{state: &activeStatusEvidenceState{
		issuer:      productionActiveStatusEvidenceIssuer,
		owner:       verifier.state,
		challenge:   challenge.state,
		nonce:       challenge.state.nonce,
		expectation: expected,
		expiresAt:   expiresAt,
		clock:       verifier.state.clock,
	}}, nil
}

// Validate rechecks the original binding, challenge identity, cancellation, and strict expiry.
// Any failed check permanently invalidates unused evidence.
func (evidence ActiveStatusEvidence) Validate(
	ctx context.Context,
	expected ActiveStatusExpectation,
	challenge ChallengeState,
) error {
	if err := evidence.validateForUse(ctx, expected, challenge); err != nil {
		evidence.invalidate()
		return err
	}
	return nil
}

// Consume performs the final trusted-time and context recheck before atomically consuming evidence.
// It returns no transferable authority value.
func (evidence ActiveStatusEvidence) Consume(
	ctx context.Context,
	expected ActiveStatusExpectation,
	challenge ChallengeState,
) error {
	if err := evidence.validateForUse(ctx, expected, challenge); err != nil {
		evidence.invalidate()
		return err
	}
	state := evidence.state
	if !state.lifecycle.CompareAndSwap(opaqueUnused, opaqueConsumed) {
		return ErrEvidenceConsumed
	}
	finalNow, err := state.clock.read()
	if err != nil || !finalNow.Before(state.expiresAt) {
		if err != nil {
			return err
		}
		return ErrExpired
	}
	if err := contextError(ctx); err != nil {
		return err
	}
	return nil
}

// Close permanently invalidates unused evidence.
func (evidence ActiveStatusEvidence) Close() error {
	state := evidence.state
	if state == nil {
		return ErrInvalidEvidence
	}
	for {
		switch state.lifecycle.Load() {
		case opaqueUnused:
			if state.lifecycle.CompareAndSwap(opaqueUnused, opaqueClosed) {
				return nil
			}
		case opaqueClosed:
			return nil
		default:
			return ErrEvidenceConsumed
		}
	}
}

// MarshalJSON prevents evidence from becoming a transferable credential.
func (ActiveStatusEvidence) MarshalJSON() ([]byte, error) {
	return nil, ErrNotSerializable
}

func (evidence ActiveStatusEvidence) validateForUse(
	ctx context.Context,
	expected ActiveStatusExpectation,
	challenge ChallengeState,
) error {
	if ctx == nil {
		return ErrCanceled
	}
	state := evidence.state
	if state == nil || state.issuer != productionActiveStatusEvidenceIssuer || state.owner == nil ||
		state.challenge == nil || state.clock == nil || state.owner.clock != state.clock ||
		(Verifier{state: state.owner}).Validate() != nil || validateExpectation(expected) != nil ||
		expected != state.expectation || challenge.state != state.challenge ||
		state.challenge.owner != state.owner || state.challenge.lifecycle.Load() != opaqueConsumed ||
		subtle.ConstantTimeCompare(state.nonce[:], state.challenge.nonce[:]) != 1 || state.expiresAt.IsZero() {
		return ErrInvalidEvidence
	}
	if state.lifecycle.Load() != opaqueUnused {
		return ErrEvidenceConsumed
	}
	if err := contextError(ctx); err != nil {
		return err
	}
	now, err := state.clock.read()
	if err != nil {
		return err
	}
	if !now.Before(state.expiresAt) {
		return ErrExpired
	}
	return nil
}

func (evidence ActiveStatusEvidence) invalidate() {
	if evidence.state != nil {
		evidence.state.lifecycle.CompareAndSwap(opaqueUnused, opaqueClosed)
	}
}

func activeStatusMatches(
	statement ServerBindingActiveStatusStatementV1,
	expected ActiveStatusExpectation,
	challenge *challengeState,
) bool {
	if challenge == nil || statement.BindingID != expected.BindingID ||
		statement.BindingRevision != expected.BindingRevision ||
		statement.EnrollmentGeneration != expected.EnrollmentGeneration ||
		statement.InstallationID != expected.InstallationID || statement.WorkerNodeID != expected.WorkerNodeID ||
		!constantTimeStringEqual(statement.CertificateDERSHA256, expected.CertificateDERSHA256) ||
		!constantTimeStringEqual(statement.ReceiptSHA256, expected.ReceiptSHA256) ||
		!constantTimeStringEqual(statement.RecordDocumentSHA256, expected.RecordDocumentSHA256) {
		return false
	}
	nonce, err := base64.RawURLEncoding.Strict().DecodeString(statement.ChallengeNonceBase64URL)
	return err == nil && len(nonce) == len(challenge.nonce) &&
		subtle.ConstantTimeCompare(nonce, challenge.nonce[:]) == 1
}

func validateActiveStatusTime(
	statement ServerBindingActiveStatusStatementV1,
	now time.Time,
) (time.Time, error) {
	issuedAt, issuedErr := parseCanonicalUTCMilliseconds(statement.IssuedAt)
	expiresAt, expiresErr := parseCanonicalUTCMilliseconds(statement.ExpiresAt)
	if issuedErr != nil || expiresErr != nil || !expiresAt.After(issuedAt) ||
		expiresAt.Sub(issuedAt) > MaximumActiveStatusLifetime ||
		issuedAt.After(now.Add(MaximumClockSkew)) || !now.Before(expiresAt) {
		return time.Time{}, ErrExpired
	}
	return expiresAt, nil
}

func constantTimeStringEqual(left, right string) bool {
	return len(left) == len(right) && subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func contextError(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return errors.Join(ErrCanceled, err)
	}
	return nil
}
