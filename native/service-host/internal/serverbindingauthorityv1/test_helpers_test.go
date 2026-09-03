package serverbindingauthorityv1

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"math/big"
	"sync/atomic"
	"testing"
	"time"
)

type testClock struct {
	milliseconds atomic.Int64
}

func newTestClock(now time.Time) *testClock {
	clock := &testClock{}
	clock.Set(now)
	return clock
}

func (clock *testClock) Now() time.Time {
	return time.UnixMilli(clock.milliseconds.Load()).UTC()
}

func (clock *testClock) Set(now time.Time) {
	clock.milliseconds.Store(now.UnixMilli())
}

type testAuthority struct {
	private  *ecdsa.PrivateKey
	spki     []byte
	verifier Verifier
	clock    *testClock
}

func newTestAuthority(t *testing.T, now time.Time) testAuthority {
	t.Helper()
	private, err := ecdsa.GenerateKey(elliptic.P256(), cryptorand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	spki, err := x509.MarshalPKIXPublicKey(&private.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	clock := newTestClock(now)
	return testAuthority{
		private:  private,
		spki:     spki,
		verifier: newTestVerifier(t, spki, clock.Now),
		clock:    clock,
	}
}

// newTestVerifier is intentionally test-only and package-private. Production has no caller-key
// trust constructor.
func newTestVerifier(t *testing.T, spki []byte, now func() time.Time) Verifier {
	t.Helper()
	_, digest, err := parseCanonicalP256SPKI(spki)
	if err != nil {
		t.Fatal(err)
	}
	verifier := Verifier{state: &verifierState{
		issuer: productionVerifierIssuer,
		spki:   append([]byte(nil), spki...),
		keyID:  digest,
		clock:  &trustedClock{now: now},
	}}
	if err := verifier.Validate(); err != nil {
		t.Fatal(err)
	}
	return verifier
}

func testReceiptStatement() ServerBindingReceiptStatementV1 {
	return ServerBindingReceiptStatementV1{
		BindingID:            "a8f7033b-d65c-4f70-8d37-83c8b1b3706d",
		BindingRevision:      BindingRevision,
		BoundAt:              "2026-09-03T00:00:00.000Z",
		CertificateDERSHA256: repeatHex("1"),
		EnrollmentGeneration: EnrollmentGeneration,
		InstallationID:       "installation-node-001",
		StatementType:        ReceiptStatementType,
		WorkerNodeID:         "worker-node:001",
	}
}

func testExpectation() ActiveStatusExpectation {
	return ActiveStatusExpectation{
		BindingID:            "a8f7033b-d65c-4f70-8d37-83c8b1b3706d",
		BindingRevision:      BindingRevision,
		CertificateDERSHA256: repeatHex("1"),
		EnrollmentGeneration: EnrollmentGeneration,
		InstallationID:       "installation-node-001",
		ReceiptSHA256:        repeatHex("2"),
		RecordDocumentSHA256: repeatHex("3"),
		WorkerNodeID:         "worker-node:001",
	}
}

func testActiveStatusStatement(
	nonce string,
	issuedAt time.Time,
	expiresAt time.Time,
) ServerBindingActiveStatusStatementV1 {
	expected := testExpectation()
	return ServerBindingActiveStatusStatementV1{
		BindingID:               expected.BindingID,
		BindingRevision:         expected.BindingRevision,
		CertificateDERSHA256:    expected.CertificateDERSHA256,
		ChallengeNonceBase64URL: nonce,
		EnrollmentGeneration:    expected.EnrollmentGeneration,
		ExpiresAt:               expiresAt.UTC().Format(canonicalUTCMillisecondsLayout),
		InstallationID:          expected.InstallationID,
		IssuedAt:                issuedAt.UTC().Format(canonicalUTCMillisecondsLayout),
		ReceiptSHA256:           expected.ReceiptSHA256,
		RecordDocumentSHA256:    expected.RecordDocumentSHA256,
		StatementType:           ActiveStatusStatementType,
		WorkerNodeID:            expected.WorkerNodeID,
	}
}

func signReceipt(
	t *testing.T,
	private *ecdsa.PrivateKey,
	spki []byte,
	statement ServerBindingReceiptStatementV1,
) (ServerBindingReceiptV1, []byte) {
	t.Helper()
	digest, err := ReceiptSigningDigest(statement)
	if err != nil {
		t.Fatal(err)
	}
	value := ServerBindingReceiptV1{
		Algorithm:     SignatureAlgorithm,
		Issuer:        Issuer,
		IssuerKeyID:   mustIssuerKeyID(t, spki),
		ProfileID:     ReceiptProfileID,
		SchemaVersion: SchemaVersion,
		Signature:     signP1363LowS(t, private, digest),
		Statement:     statement,
	}
	document, err := MarshalReceiptCanonical(value)
	if err != nil {
		t.Fatal(err)
	}
	return value, document
}

func signActiveStatus(
	t *testing.T,
	private *ecdsa.PrivateKey,
	spki []byte,
	statement ServerBindingActiveStatusStatementV1,
) (ServerBindingActiveStatusV1, []byte) {
	t.Helper()
	digest, err := ActiveStatusSigningDigest(statement)
	if err != nil {
		t.Fatal(err)
	}
	value := ServerBindingActiveStatusV1{
		Algorithm:     SignatureAlgorithm,
		Issuer:        Issuer,
		IssuerKeyID:   mustIssuerKeyID(t, spki),
		ProfileID:     ActiveStatusProfileID,
		SchemaVersion: SchemaVersion,
		Signature:     signP1363LowS(t, private, digest),
		Statement:     statement,
	}
	document, err := MarshalActiveStatusCanonical(value)
	if err != nil {
		t.Fatal(err)
	}
	return value, document
}

func signP1363LowS(t *testing.T, private *ecdsa.PrivateKey, digest [sha256.Size]byte) string {
	t.Helper()
	r, s, err := ecdsa.Sign(cryptorand.Reader, private, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	order := elliptic.P256().Params().N
	halfOrder := new(big.Int).Rsh(new(big.Int).Set(order), 1)
	if s.Cmp(halfOrder) > 0 {
		s.Sub(order, s)
	}
	encoded := make([]byte, 64)
	r.FillBytes(encoded[:32])
	s.FillBytes(encoded[32:])
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func mustIssuerKeyID(t *testing.T, spki []byte) string {
	t.Helper()
	value, err := DeriveIssuerKeyID(spki)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func repeatHex(character string) string {
	result := ""
	for len(result) < 64 {
		result += character
	}
	return result
}
