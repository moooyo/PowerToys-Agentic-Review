package serverbindingauthorityv1

import (
	"bytes"
	"encoding/base64"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestCanonicalReceiptAndActiveStatusRoundTrip(t *testing.T) {
	authority := newTestAuthority(t, time.Date(2026, 9, 3, 0, 0, 1, 0, time.UTC))
	receipt, receiptDocument := signReceipt(t, authority.private, authority.spki, testReceiptStatement())
	if len(receiptDocument) > MaximumDocumentBytes || bytes.ContainsRune(receiptDocument, '\n') ||
		!bytes.HasPrefix(receiptDocument, []byte(`{"algorithm":`)) {
		t.Fatalf("receipt is not bounded canonical JSON: %q", receiptDocument)
	}
	parsedReceipt, err := ParseReceipt(receiptDocument)
	if err != nil || !reflect.DeepEqual(parsedReceipt, receipt) {
		t.Fatalf("receipt round trip = (%#v, %v)", parsedReceipt, err)
	}

	nonce := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0xab}, 32))
	statusStatement := testActiveStatusStatement(
		nonce,
		authority.clock.Now(),
		authority.clock.Now().Add(45*time.Second),
	)
	status, statusDocument := signActiveStatus(t, authority.private, authority.spki, statusStatement)
	parsedStatus, err := ParseActiveStatus(statusDocument)
	if err != nil || !reflect.DeepEqual(parsedStatus, status) {
		t.Fatalf("active-status round trip = (%#v, %v)", parsedStatus, err)
	}
}

func TestFrozenProtocolLimitsRemainLiteral(t *testing.T) {
	if MaximumDocumentBytes != 4096 || MaximumActiveStatusLifetime != 60*time.Second ||
		MaximumClockSkew != 5*time.Second || canonicalP256SPKIBytes != 91 {
		t.Fatalf(
			"protocol limits = document:%d lifetime:%s skew:%s SPKI:%d",
			MaximumDocumentBytes,
			MaximumActiveStatusLifetime,
			MaximumClockSkew,
			canonicalP256SPKIBytes,
		)
	}
}

func TestCanonicalUTCMillisecondsRejectsYearZero(t *testing.T) {
	receipt := testReceiptStatement()
	receipt.BoundAt = "0000-01-01T00:00:00.000Z"
	if _, err := marshalReceiptStatement(receipt); err == nil {
		t.Fatal("receipt accepted year zero in boundAt")
	}

	status := testActiveStatusStatement(
		base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0xab}, 32)),
		time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC),
		time.Date(2026, 9, 3, 0, 0, 45, 0, time.UTC),
	)
	status.IssuedAt = "0000-01-01T00:00:00.000Z"
	status.ExpiresAt = "0000-01-01T00:00:45.000Z"
	if _, err := marshalActiveStatusStatement(status); err == nil {
		t.Fatal("active status accepted year zero with an otherwise valid lifetime")
	}
}

func TestSigningPreimagesAndDigestsAreExactAndDistinct(t *testing.T) {
	receiptStatement := testReceiptStatement()
	receiptCanonical, err := marshalReceiptStatement(receiptStatement)
	if err != nil {
		t.Fatal(err)
	}
	receiptPreimage, err := ReceiptSigningPreimage(receiptStatement)
	if err != nil {
		t.Fatal(err)
	}
	wantReceipt := append([]byte(receiptSignatureDomain), receiptCanonical...)
	if !bytes.Equal(receiptPreimage, wantReceipt) || !bytes.Contains(receiptPreimage, []byte{0}) {
		t.Fatal("receipt signing preimage differs from the exact domain, NUL, and canonical statement")
	}
	receiptDigest, err := ReceiptSigningDigest(receiptStatement)
	if err != nil || receiptDigest == ([32]byte{}) {
		t.Fatalf("receipt digest = (%x, %v)", receiptDigest, err)
	}

	statusStatement := testActiveStatusStatement(
		base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0xab}, 32)),
		time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC),
		time.Date(2026, 9, 3, 0, 0, 45, 0, time.UTC),
	)
	statusCanonical, err := marshalActiveStatusStatement(statusStatement)
	if err != nil {
		t.Fatal(err)
	}
	statusPreimage, err := ActiveStatusSigningPreimage(statusStatement)
	if err != nil {
		t.Fatal(err)
	}
	wantStatus := append([]byte(activeStatusSignatureDomain), statusCanonical...)
	if !bytes.Equal(statusPreimage, wantStatus) || bytes.Equal(statusPreimage, receiptPreimage) {
		t.Fatal("active-status signing preimage is invalid or cross-type equal")
	}
	statusDigest, err := ActiveStatusSigningDigest(statusStatement)
	if err != nil || statusDigest == receiptDigest {
		t.Fatalf("active-status digest = (%x, %v)", statusDigest, err)
	}
}

func TestParsersRejectNoncanonicalEncodingAndClosedSchemaDrift(t *testing.T) {
	authority := newTestAuthority(t, time.Date(2026, 9, 3, 0, 0, 1, 0, time.UTC))
	_, document := signReceipt(t, authority.private, authority.spki, testReceiptStatement())
	algorithm := SignatureAlgorithm
	prefix := []byte(`{"algorithm":"` + algorithm + `","issuer":"` + Issuer + `"`)
	reorderedPrefix := []byte(`{"issuer":"` + Issuer + `","algorithm":"` + algorithm + `"`)
	candidates := [][]byte{
		nil,
		append([]byte{0xef, 0xbb, 0xbf}, document...),
		append(append([]byte(nil), document...), ' '),
		append([]byte(" "), document...),
		bytes.Replace(document, prefix, reorderedPrefix, 1),
		bytes.Replace(document, []byte(`{"algorithm":`), []byte(`{"algorithm":"`+algorithm+`","algorithm":`), 1),
		bytes.Replace(document, []byte(`{"algorithm":`), []byte(`{"unexpected":true,"algorithm":`), 1),
		bytes.Replace(document, []byte("worker-node"), []byte(`worker\u002dnode`), 1),
		bytes.Replace(document, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":null`), 1),
		{0xff},
		bytes.Repeat([]byte{' '}, MaximumDocumentBytes+1),
	}
	for index, candidate := range candidates {
		if _, err := ParseReceipt(candidate); err == nil {
			t.Errorf("noncanonical receipt %d was accepted: %q", index, candidate)
		}
	}
}

func TestStatementValidationPinsIdentifiersTimestampsAndLifetime(t *testing.T) {
	receipt := testReceiptStatement()
	invalidReceipts := []ServerBindingReceiptStatementV1{
		withReceiptBindingID(receipt, "A8F7033B-D65C-4F70-8D37-83C8B1B3706D"),
		withReceiptBindingID(receipt, "a8f7033b-d65c-5f70-8d37-83c8b1b3706d"),
		withReceiptInstallationID(receipt, "Install-01"),
		withReceiptInstallationID(receipt, "con"),
		withReceiptInstallationID(receipt, "com1.bin"),
		withReceiptInstallationID(receipt, "installation."),
		withReceiptWorkerNodeID(receipt, "-worker"),
		withReceiptWorkerNodeID(receipt, "worker node"),
		withReceiptBoundAt(receipt, "2026-09-03T00:00:00Z"),
		withReceiptBoundAt(receipt, "2026-02-30T00:00:00.000Z"),
	}
	for index, candidate := range invalidReceipts {
		if _, err := marshalReceiptStatement(candidate); err == nil {
			t.Errorf("invalid receipt statement %d was accepted", index)
		}
	}

	nonce := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0xab}, 32))
	issuedAt := time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC)
	valid := testActiveStatusStatement(nonce, issuedAt, issuedAt.Add(60*time.Second))
	if _, err := marshalActiveStatusStatement(valid); err != nil {
		t.Fatalf("60-second status was rejected: %v", err)
	}
	invalidStatuses := []ServerBindingActiveStatusStatementV1{
		withStatusExpiresAt(valid, valid.IssuedAt),
		withStatusExpiresAt(valid, issuedAt.Add(60*time.Second+time.Millisecond).Format(canonicalUTCMillisecondsLayout)),
		withStatusIssuedAt(valid, "2026-09-03T00:00:00Z"),
		withStatusNonce(valid, base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0xab}, 31))),
		withStatusNonce(valid, nonce+"="),
	}
	for index, candidate := range invalidStatuses {
		if _, err := marshalActiveStatusStatement(candidate); err == nil {
			t.Errorf("invalid active-status statement %d was accepted", index)
		}
	}
	if _, err := marshalReceiptStatement(ServerBindingReceiptStatementV1{
		BindingID: strings.Repeat("a", 36),
	}); err == nil {
		t.Fatal("partial ordinary data was accepted")
	}
}

func TestReceiptAndActiveStatusCannotCrossParse(t *testing.T) {
	authority := newTestAuthority(t, time.Date(2026, 9, 3, 0, 0, 1, 0, time.UTC))
	_, receiptDocument := signReceipt(t, authority.private, authority.spki, testReceiptStatement())
	nonce := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0xab}, 32))
	_, statusDocument := signActiveStatus(t, authority.private, authority.spki, testActiveStatusStatement(
		nonce, authority.clock.Now(), authority.clock.Now().Add(45*time.Second),
	))
	if _, err := ParseReceipt(statusDocument); err == nil {
		t.Fatal("receipt parser accepted active status")
	}
	if _, err := ParseActiveStatus(receiptDocument); err == nil {
		t.Fatal("active-status parser accepted receipt")
	}
}

func TestFixedFieldsRevisionGenerationAndDigestCaseRejectDrift(t *testing.T) {
	authority := newTestAuthority(t, time.Date(2026, 9, 3, 0, 0, 1, 0, time.UTC))
	receipt, _ := signReceipt(t, authority.private, authority.spki, testReceiptStatement())
	receiptMutations := []func(*ServerBindingReceiptV1){
		func(value *ServerBindingReceiptV1) { value.Algorithm = "ecdsa-p384-sha384" },
		func(value *ServerBindingReceiptV1) { value.Issuer = "agentic-review-other-issuer-v1" },
		func(value *ServerBindingReceiptV1) { value.ProfileID = ActiveStatusProfileID },
		func(value *ServerBindingReceiptV1) { value.SchemaVersion = 2 },
		func(value *ServerBindingReceiptV1) { value.IssuerKeyID = strings.Repeat("A", 64) },
		func(value *ServerBindingReceiptV1) { value.Statement.BindingRevision = 2 },
		func(value *ServerBindingReceiptV1) { value.Statement.EnrollmentGeneration = 2 },
		func(value *ServerBindingReceiptV1) { value.Statement.CertificateDERSHA256 = strings.Repeat("A", 64) },
		func(value *ServerBindingReceiptV1) { value.Statement.StatementType = ActiveStatusStatementType },
	}
	for index, mutate := range receiptMutations {
		candidate := receipt
		mutate(&candidate)
		if _, err := MarshalReceiptCanonical(candidate); err == nil {
			t.Errorf("fixed receipt mutation %d was accepted", index)
		}
	}

	status, _ := signActiveStatus(t, authority.private, authority.spki, testActiveStatusStatement(
		base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0xab}, 32)),
		time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC),
		time.Date(2026, 9, 3, 0, 0, 45, 0, time.UTC),
	))
	statusMutations := []func(*ServerBindingActiveStatusV1){
		func(value *ServerBindingActiveStatusV1) { value.Issuer = "agentic-review-other-issuer-v1" },
		func(value *ServerBindingActiveStatusV1) { value.ProfileID = ReceiptProfileID },
		func(value *ServerBindingActiveStatusV1) { value.SchemaVersion = 2 },
		func(value *ServerBindingActiveStatusV1) { value.Statement.BindingRevision = 2 },
		func(value *ServerBindingActiveStatusV1) { value.Statement.EnrollmentGeneration = 2 },
		func(value *ServerBindingActiveStatusV1) { value.Statement.ReceiptSHA256 = strings.Repeat("C", 64) },
		func(value *ServerBindingActiveStatusV1) {
			value.Statement.RecordDocumentSHA256 = strings.Repeat("D", 64)
		},
		func(value *ServerBindingActiveStatusV1) { value.Statement.StatementType = ReceiptStatementType },
	}
	for index, mutate := range statusMutations {
		candidate := status
		mutate(&candidate)
		if _, err := MarshalActiveStatusCanonical(candidate); err == nil {
			t.Errorf("fixed active-status mutation %d was accepted", index)
		}
	}
}

func withReceiptBindingID(value ServerBindingReceiptStatementV1, replacement string) ServerBindingReceiptStatementV1 {
	value.BindingID = replacement
	return value
}

func withReceiptInstallationID(value ServerBindingReceiptStatementV1, replacement string) ServerBindingReceiptStatementV1 {
	value.InstallationID = replacement
	return value
}

func withReceiptWorkerNodeID(value ServerBindingReceiptStatementV1, replacement string) ServerBindingReceiptStatementV1 {
	value.WorkerNodeID = replacement
	return value
}

func withReceiptBoundAt(value ServerBindingReceiptStatementV1, replacement string) ServerBindingReceiptStatementV1 {
	value.BoundAt = replacement
	return value
}

func withStatusExpiresAt(value ServerBindingActiveStatusStatementV1, replacement string) ServerBindingActiveStatusStatementV1 {
	value.ExpiresAt = replacement
	return value
}

func withStatusIssuedAt(value ServerBindingActiveStatusStatementV1, replacement string) ServerBindingActiveStatusStatementV1 {
	value.IssuedAt = replacement
	return value
}

func withStatusNonce(value ServerBindingActiveStatusStatementV1, replacement string) ServerBindingActiveStatusStatementV1 {
	value.ChallengeNonceBase64URL = replacement
	return value
}
