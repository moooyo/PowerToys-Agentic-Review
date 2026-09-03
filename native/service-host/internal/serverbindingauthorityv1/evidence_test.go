package serverbindingauthorityv1

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestProductionVerifierAndOpaqueZeroValuesFailClosed(t *testing.T) {
	verifier, err := ProductionVerifier()
	if !errors.Is(err, ErrUnavailable) || verifier.state != nil {
		t.Fatalf("ProductionVerifier = (%#v, %v), want zero and ErrUnavailable", verifier, err)
	}
	if err := (Verifier{}).Validate(); !errors.Is(err, ErrInvalidVerifier) {
		t.Fatalf("zero verifier validation = %v", err)
	}
	if _, err := (Verifier{}).NewChallenge(); !errors.Is(err, ErrInvalidVerifier) {
		t.Fatalf("zero verifier NewChallenge = %v", err)
	}
	if _, err := json.Marshal(ChallengeState{}); !errors.Is(err, ErrNotSerializable) {
		t.Fatalf("zero challenge serialization = %v", err)
	}
	if _, err := json.Marshal(ActiveStatusEvidence{}); !errors.Is(err, ErrNotSerializable) {
		t.Fatalf("zero evidence serialization = %v", err)
	}
	if err := (ActiveStatusEvidence{}).Validate(
		context.Background(), testExpectation(), ChallengeState{},
	); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("zero evidence validation = %v", err)
	}
	for _, value := range []any{Verifier{}, ChallengeState{}, ActiveStatusEvidence{}} {
		typeOf := reflect.TypeOf(value)
		for index := 0; index < typeOf.NumField(); index++ {
			if typeOf.Field(index).IsExported() {
				t.Fatalf("%s field %s is exported", typeOf.Name(), typeOf.Field(index).Name)
			}
		}
	}
}

func TestChallengeUsesCSPRNGAndCopiesShareOneLifecycle(t *testing.T) {
	authority := newTestAuthority(t, time.Date(2026, 9, 3, 0, 0, 1, 0, time.UTC))
	first, err := authority.verifier.NewChallenge()
	if err != nil {
		t.Fatal(err)
	}
	second, err := authority.verifier.NewChallenge()
	if err != nil {
		t.Fatal(err)
	}
	firstNonce, err := first.NonceBase64URL()
	if err != nil || len(firstNonce) != 43 {
		t.Fatalf("first nonce = (%q, %v)", firstNonce, err)
	}
	secondNonce, err := second.NonceBase64URL()
	if err != nil || len(secondNonce) != 43 || firstNonce == secondNonce {
		t.Fatalf("second nonce = (%q, %v)", secondNonce, err)
	}
	copyOfFirst := first
	if err := copyOfFirst.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := first.NonceBase64URL(); !errors.Is(err, ErrChallengeConsumed) {
		t.Fatalf("closed challenge copy left original usable: %v", err)
	}
}

func TestConcurrentDoubleMintConsumesChallengeExactlyOnce(t *testing.T) {
	authority := newTestAuthority(t, time.Date(2026, 9, 3, 0, 0, 1, 0, time.UTC))
	challenge, document := signedStatusForNewChallenge(t, authority, authority.clock.Now(), authority.clock.Now().Add(45*time.Second))
	const attempts = 24
	results := make([]ActiveStatusEvidence, attempts)
	errorsByAttempt := make([]error, attempts)
	var wait sync.WaitGroup
	wait.Add(attempts)
	for index := 0; index < attempts; index++ {
		go func(index int) {
			defer wait.Done()
			results[index], errorsByAttempt[index] = authority.verifier.VerifyActiveStatus(
				context.Background(), document, testExpectation(), challenge,
			)
		}(index)
	}
	wait.Wait()
	successes := 0
	var evidence ActiveStatusEvidence
	for index, err := range errorsByAttempt {
		if err == nil {
			successes++
			evidence = results[index]
		}
	}
	if successes != 1 {
		t.Fatalf("successful concurrent mints = %d, want 1; errors=%v", successes, errorsByAttempt)
	}
	if _, err := authority.verifier.VerifyActiveStatus(
		context.Background(), document, testExpectation(), challenge,
	); err == nil {
		t.Fatal("raw assertion replay minted evidence from a consumed challenge")
	}
	if err := evidence.Validate(context.Background(), testExpectation(), challenge); err != nil {
		t.Fatalf("minted evidence validation failed: %v", err)
	}
}

func TestAssertionRequiresOriginalChallengeAndExactVerifier(t *testing.T) {
	authority := newTestAuthority(t, time.Date(2026, 9, 3, 0, 0, 1, 0, time.UTC))
	original, document := signedStatusForNewChallenge(t, authority, authority.clock.Now(), authority.clock.Now().Add(45*time.Second))
	replacement, err := authority.verifier.NewChallenge()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := authority.verifier.VerifyActiveStatus(
		context.Background(), document, testExpectation(), replacement,
	); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("new-challenge mismatch = %v", err)
	}
	if _, err := replacement.NonceBase64URL(); !errors.Is(err, ErrChallengeConsumed) {
		t.Fatalf("failed verification did not invalidate replacement challenge: %v", err)
	}
	secondVerifier := newTestVerifier(t, authority.spki, authority.clock.Now)
	if _, err := secondVerifier.VerifyActiveStatus(
		context.Background(), document, testExpectation(), original,
	); !errors.Is(err, ErrInvalidChallenge) {
		t.Fatalf("second verifier accepted the first verifier's challenge: %v", err)
	}
	if _, err := authority.verifier.VerifyActiveStatus(
		context.Background(), document, testExpectation(), ChallengeState{},
	); !errors.Is(err, ErrInvalidChallenge) {
		t.Fatalf("assertion plus copied public nonce without opaque state returned %v", err)
	}
}

func TestEvidenceCopiesConsumeExactlyOnce(t *testing.T) {
	authority := newTestAuthority(t, time.Date(2026, 9, 3, 0, 0, 1, 0, time.UTC))
	evidence, challenge := mintTestEvidence(t, authority, authority.clock.Now(), authority.clock.Now().Add(45*time.Second))
	const attempts = 24
	errorsByAttempt := make([]error, attempts)
	var wait sync.WaitGroup
	wait.Add(attempts)
	for index := 0; index < attempts; index++ {
		copyOfEvidence := evidence
		go func(index int, candidate ActiveStatusEvidence) {
			defer wait.Done()
			errorsByAttempt[index] = candidate.Consume(context.Background(), testExpectation(), challenge)
		}(index, copyOfEvidence)
	}
	wait.Wait()
	successes := 0
	for _, err := range errorsByAttempt {
		if err == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("successful evidence consumes = %d, want 1; errors=%v", successes, errorsByAttempt)
	}
	if err := evidence.Validate(context.Background(), testExpectation(), challenge); !errors.Is(err, ErrEvidenceConsumed) {
		t.Fatalf("consumed evidence validated again: %v", err)
	}
}

func TestCancellationCloseAndFailedValidationInvalidateOpaqueState(t *testing.T) {
	now := time.Date(2026, 9, 3, 0, 0, 1, 0, time.UTC)
	authority := newTestAuthority(t, now)
	challenge, document := signedStatusForNewChallenge(t, authority, now, now.Add(45*time.Second))
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := authority.verifier.VerifyActiveStatus(
		canceled, document, testExpectation(), challenge,
	); !errors.Is(err, ErrCanceled) {
		t.Fatalf("canceled mint = %v", err)
	}
	if _, err := challenge.NonceBase64URL(); !errors.Is(err, ErrChallengeConsumed) {
		t.Fatalf("canceled mint left challenge usable: %v", err)
	}

	evidence, evidenceChallenge := mintTestEvidence(t, authority, now, now.Add(45*time.Second))
	wrong := testExpectation()
	wrong.WorkerNodeID = "worker-other"
	if err := evidence.Validate(context.Background(), wrong, evidenceChallenge); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("wrong-context validation = %v", err)
	}
	if err := evidence.Validate(context.Background(), testExpectation(), evidenceChallenge); !errors.Is(err, ErrEvidenceConsumed) {
		t.Fatalf("failed validation left evidence usable: %v", err)
	}

	closedEvidence, closedChallenge := mintTestEvidence(t, authority, now, now.Add(45*time.Second))
	if err := closedEvidence.Close(); err != nil {
		t.Fatal(err)
	}
	if err := closedEvidence.Consume(context.Background(), testExpectation(), closedChallenge); !errors.Is(err, ErrEvidenceConsumed) {
		t.Fatalf("closed evidence consumed: %v", err)
	}
}

func TestEvidenceCannotBeHeldPastSignedExpiry(t *testing.T) {
	issuedAt := time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC)
	expiresAt := issuedAt.Add(45 * time.Second)
	authority := newTestAuthority(t, expiresAt.Add(-time.Millisecond))
	evidence, challenge := mintTestEvidence(t, authority, issuedAt, expiresAt)
	authority.clock.Set(expiresAt)
	if err := evidence.Validate(context.Background(), testExpectation(), challenge); !errors.Is(err, ErrExpired) {
		t.Fatalf("evidence validated at exact expiry: %v", err)
	}

	authority.clock.Set(expiresAt.Add(-time.Millisecond))
	secondEvidence, secondChallenge := mintTestEvidence(t, authority, issuedAt, expiresAt)
	authority.clock.Set(expiresAt)
	if err := secondEvidence.Consume(
		context.Background(), testExpectation(), secondChallenge,
	); !errors.Is(err, ErrExpired) {
		t.Fatalf("evidence consumed at exact expiry: %v", err)
	}
}

func TestConsumeRechecksExpiryAndCancellationAfterAtomicConsumption(t *testing.T) {
	issuedAt := time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC)
	expiresAt := issuedAt.Add(45 * time.Second)
	authority := newTestAuthority(t, expiresAt.Add(-time.Millisecond))
	evidence, challenge := mintTestEvidence(t, authority, issuedAt, expiresAt)
	var expiryReads atomic.Int32
	authority.verifier.state.clock.now = func() time.Time {
		if expiryReads.Add(1) == 1 {
			return expiresAt.Add(-time.Millisecond)
		}
		return expiresAt
	}
	if err := evidence.Consume(
		context.Background(), testExpectation(), challenge,
	); !errors.Is(err, ErrExpired) {
		t.Fatalf("post-CAS expiry recheck = %v", err)
	}
	if err := evidence.Consume(
		context.Background(), testExpectation(), challenge,
	); !errors.Is(err, ErrEvidenceConsumed) {
		t.Fatalf("failed post-CAS expiry left evidence reusable: %v", err)
	}

	cancelAuthority := newTestAuthority(t, issuedAt.Add(time.Second))
	cancelEvidence, cancelChallenge := mintTestEvidence(
		t, cancelAuthority, issuedAt, expiresAt,
	)
	ctx, cancel := context.WithCancel(context.Background())
	var cancellationReads atomic.Int32
	cancelAuthority.verifier.state.clock.now = func() time.Time {
		if cancellationReads.Add(1) == 2 {
			cancel()
		}
		return issuedAt.Add(time.Second)
	}
	if err := cancelEvidence.Consume(
		ctx, testExpectation(), cancelChallenge,
	); !errors.Is(err, ErrCanceled) {
		t.Fatalf("post-CAS cancellation recheck = %v", err)
	}
	if err := cancelEvidence.Consume(
		context.Background(), testExpectation(), cancelChallenge,
	); !errors.Is(err, ErrEvidenceConsumed) {
		t.Fatalf("failed post-CAS cancellation left evidence reusable: %v", err)
	}
}

func TestMintRechecksExpiryAndCancellationAfterChallengeConsumption(t *testing.T) {
	issuedAt := time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC)
	expiresAt := issuedAt.Add(45 * time.Second)
	authority := newTestAuthority(t, expiresAt.Add(-time.Millisecond))
	challenge, document := signedStatusForNewChallenge(t, authority, issuedAt, expiresAt)
	var expiryReads atomic.Int32
	authority.verifier.state.clock.now = func() time.Time {
		if expiryReads.Add(1) == 1 {
			return expiresAt.Add(-time.Millisecond)
		}
		return expiresAt
	}
	if _, err := authority.verifier.VerifyActiveStatus(
		context.Background(), document, testExpectation(), challenge,
	); !errors.Is(err, ErrExpired) {
		t.Fatalf("post-CAS mint expiry recheck = %v", err)
	}
	if _, err := challenge.NonceBase64URL(); !errors.Is(err, ErrChallengeConsumed) {
		t.Fatalf("post-CAS mint expiry left challenge reusable: %v", err)
	}

	cancelAuthority := newTestAuthority(t, issuedAt.Add(time.Second))
	cancelChallenge, cancelDocument := signedStatusForNewChallenge(
		t, cancelAuthority, issuedAt, expiresAt,
	)
	ctx, cancel := context.WithCancel(context.Background())
	var cancellationReads atomic.Int32
	cancelAuthority.verifier.state.clock.now = func() time.Time {
		if cancellationReads.Add(1) == 2 {
			cancel()
		}
		return issuedAt.Add(time.Second)
	}
	if _, err := cancelAuthority.verifier.VerifyActiveStatus(
		ctx, cancelDocument, testExpectation(), cancelChallenge,
	); !errors.Is(err, ErrCanceled) {
		t.Fatalf("post-CAS mint cancellation recheck = %v", err)
	}
	if _, err := cancelChallenge.NonceBase64URL(); !errors.Is(err, ErrChallengeConsumed) {
		t.Fatalf("post-CAS mint cancellation left challenge reusable: %v", err)
	}
}

func TestActiveStatusTrustedTimePinsSkewAndStrictExpiry(t *testing.T) {
	now := time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC)
	authority := newTestAuthority(t, now)
	challenge, document := signedStatusForNewChallenge(t, authority, now.Add(MaximumClockSkew), now.Add(45*time.Second))
	if _, err := authority.verifier.VerifyActiveStatus(
		context.Background(), document, testExpectation(), challenge,
	); err != nil {
		t.Fatalf("status at maximum future skew was rejected: %v", err)
	}
	lateChallenge, lateDocument := signedStatusForNewChallenge(
		t, authority, now.Add(MaximumClockSkew+time.Millisecond), now.Add(45*time.Second),
	)
	if _, err := authority.verifier.VerifyActiveStatus(
		context.Background(), lateDocument, testExpectation(), lateChallenge,
	); !errors.Is(err, ErrExpired) {
		t.Fatalf("status beyond maximum future skew = %v", err)
	}
}

func signedStatusForNewChallenge(
	t *testing.T,
	authority testAuthority,
	issuedAt time.Time,
	expiresAt time.Time,
) (ChallengeState, []byte) {
	t.Helper()
	challenge, err := authority.verifier.NewChallenge()
	if err != nil {
		t.Fatal(err)
	}
	nonce, err := challenge.NonceBase64URL()
	if err != nil {
		t.Fatal(err)
	}
	_, document := signActiveStatus(
		t, authority.private, authority.spki, testActiveStatusStatement(nonce, issuedAt, expiresAt),
	)
	return challenge, document
}

func mintTestEvidence(
	t *testing.T,
	authority testAuthority,
	issuedAt time.Time,
	expiresAt time.Time,
) (ActiveStatusEvidence, ChallengeState) {
	t.Helper()
	challenge, document := signedStatusForNewChallenge(t, authority, issuedAt, expiresAt)
	evidence, err := authority.verifier.VerifyActiveStatus(
		context.Background(), document, testExpectation(), challenge,
	)
	if err != nil {
		t.Fatal(err)
	}
	return evidence, challenge
}
