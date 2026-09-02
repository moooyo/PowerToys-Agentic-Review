package installtransaction

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

const testRecordPayloadGolden = `{"actionPlan":"none","activationPolicyState":"not-applicable","candidate":{"packageId":"worker-package-next","releaseId":"worker-2026.09.02.1","roots":null,"signedIndexSha256":"8888888888888888888888888888888888888888888888888888888888888888"},"completedActionOrdinal":0,"failureCode":null,"installationId":"installation-node-001","mode":"initial","pendingAction":null,"phase":"STAGING_VERIFIED","previous":null,"recordSequence":"1","rollbackCheckpoint":"not-applicable","targetArchitecture":"amd64","transactionId":"123e4567-e89b-42d3-a456-426614174000","workerNodeId":"powertoys-node:01"}`

func TestCanonicalActiveHeadGolden(t *testing.T) {
	head := ActiveHead{TransactionID: testTransactionID}
	document, err := MarshalActiveHead(head)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"head":{"transactionId":"123e4567-e89b-42d3-a456-426614174000"},"headSha256":"5bd7cb1abcb49b6378f69fc80109c89e07d039f73590174e7025e8fad0fae694","schemaVersion":1}`
	if string(document) != want {
		t.Fatalf("MarshalActiveHead = %q, want %q", document, want)
	}
	parsed, err := ParseActiveHead(document)
	if err != nil || parsed != head {
		t.Fatalf("ParseActiveHead = (%+v, %v), want %+v", parsed, err, head)
	}
}

func TestCanonicalTransactionRecordGolden(t *testing.T) {
	record := testStagingRecord(ModeInitial)
	document, err := MarshalRecord(record)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"record":` + testRecordPayloadGolden + `,"recordSha256":"47f8f8733c5af33107edc677cf52e0aaabbf8693b7c11e14f3857e3373d827a6","schemaVersion":1}`
	if string(document) != want {
		t.Fatalf("MarshalRecord = %q, want %q", document, want)
	}
	parsed, err := ParseRecord(document)
	if err != nil || !reflect.DeepEqual(parsed, record) {
		t.Fatalf("ParseRecord = (%+v, %v), want %+v", parsed, err, record)
	}
}

func TestParsersRejectEncodingShapeDigestAndCanonicalAttacks(t *testing.T) {
	head, err := MarshalActiveHead(ActiveHead{TransactionID: testTransactionID})
	if err != nil {
		t.Fatal(err)
	}
	record, err := MarshalRecord(testStagingRecord(ModeInitial))
	if err != nil {
		t.Fatal(err)
	}
	reorderedRecord := []byte(`{"schemaVersion":1,"record":` + testRecordPayloadGolden +
		`,"recordSha256":"47f8f8733c5af33107edc677cf52e0aaabbf8693b7c11e14f3857e3373d827a6"}`)
	tests := []struct {
		name  string
		parse func([]byte) error
		value []byte
	}{
		{name: "head BOM", parse: parseHeadError, value: append([]byte{0xef, 0xbb, 0xbf}, head...)},
		{name: "head unknown field", parse: parseHeadError, value: bytes.Replace(head, []byte(`,"schemaVersion":1}`), []byte(`,"schemaVersion":1,"unknown":true}`), 1)},
		{name: "head duplicate field", parse: parseHeadError, value: bytes.Replace(head, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":1,"schemaVersion":1`), 1)},
		{name: "head whitespace", parse: parseHeadError, value: append([]byte(" "), head...)},
		{name: "head trailing JSON", parse: parseHeadError, value: append(append([]byte(nil), head...), []byte(`{}`)...)},
		{name: "head wrong digest", parse: parseHeadError, value: bytes.Replace(head, []byte("5bd7"), []byte("0bd7"), 1)},
		{name: "head invalid UTF-8", parse: parseHeadError, value: []byte{0xff}},
		{name: "record BOM", parse: parseRecordError, value: append([]byte{0xef, 0xbb, 0xbf}, record...)},
		{name: "record unknown field", parse: parseRecordError, value: bytes.Replace(record, []byte(`,"schemaVersion":1}`), []byte(`,"schemaVersion":1,"unknown":true}`), 1)},
		{name: "record duplicate field", parse: parseRecordError, value: bytes.Replace(record, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":1,"schemaVersion":1`), 1)},
		{name: "record member order", parse: parseRecordError, value: reorderedRecord},
		{name: "record trailing JSON", parse: parseRecordError, value: append(append([]byte(nil), record...), []byte(`null`)...)},
		{name: "record wrong digest", parse: parseRecordError, value: bytes.Replace(record, []byte("47f8"), []byte("07f8"), 1)},
		{name: "record invalid UTF-8", parse: parseRecordError, value: []byte{0xff}},
		{name: "head oversized", parse: parseHeadError, value: bytes.Repeat([]byte{'x'}, MaximumActiveHeadBytes+1)},
		{name: "record oversized", parse: parseRecordError, value: bytes.Repeat([]byte{'x'}, MaximumTransactionRecordBytes+1)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := test.parse(test.value); err == nil {
				t.Fatal("parser accepted invalid document")
			}
		})
	}
}

func TestPendingActionCanonicalUnionRoundTripsEveryVariant(t *testing.T) {
	materializeCreate := testMaterializeRecord(0, true)
	materializePopulate := testMaterializeRecord(1, true)
	rename := testPlanRecord(ModeInitial, PhaseRootSwapInProgress, PlanInitialForward, 0, true)
	policy := testPlanRecord(ModeInitial, PhaseCommitted, PlanCandidateActivationPolicy, 0, true)
	policy.ActivationPolicyState = ActivationPending
	for _, record := range []TransactionRecord{materializeCreate, materializePopulate, rename, policy} {
		document, err := MarshalRecord(record)
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := ParseRecord(document)
		if err != nil || !pendingActionsEqual(parsed.PendingAction, record.PendingAction) {
			t.Fatalf("pending action round trip = (%#v, %v), want %#v", parsed.PendingAction, err, record.PendingAction)
		}
	}
}

func TestPendingActionUnionRejectsCrossVariantUnknownAndNoncanonicalFields(t *testing.T) {
	policy := testPlanRecord(ModeInitial, PhaseCommitted, PlanCandidateActivationPolicy, 0, true)
	policy.ActivationPolicyState = ActivationPending
	payload, err := marshalCanonicalValue(policy, MaximumTransactionRecordBytes)
	if err != nil {
		t.Fatal(err)
	}
	action := `{"actionKind":"apply-candidate-executor-policy","ordinal":1}`
	tests := []struct {
		name        string
		replacement string
		canonical   bool
	}{
		{name: "policy slot", replacement: `{"actionKind":"apply-candidate-executor-policy","ordinal":1,"slot":"metadata-candidate"}`},
		{name: "policy direction", replacement: `{"actionKind":"apply-candidate-executor-policy","direction":"forward","ordinal":1}`},
		{name: "unknown kind", replacement: `{"actionKind":"other","ordinal":1}`},
		{name: "duplicate ordinal", replacement: `{"actionKind":"apply-candidate-executor-policy","ordinal":1,"ordinal":1}`, canonical: true},
		{name: "noncanonical order", replacement: `{"ordinal":1,"actionKind":"apply-candidate-executor-policy"}`, canonical: true},
		{name: "noncanonical actionKind escape", replacement: `{"actionKind":"apply-candidate-\u0065xecutor-policy","ordinal":1}`, canonical: true},
	}
	canonicalDigest := recordPayloadDigestForTest(payload)
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			mutated := bytes.Replace(payload, []byte(action), []byte(test.replacement), 1)
			if bytes.Equal(mutated, payload) {
				t.Fatal("fixture action was not replaced")
			}
			document := wrapRecordPayloadWithDigestForTest(mutated, canonicalDigest)
			_, err := ParseRecord(document)
			if err == nil {
				t.Fatal("ParseRecord accepted an invalid pending-action union")
			}
			if test.canonical && !errors.Is(err, ErrCanonical) {
				t.Fatalf("ParseRecord returned %v, want ErrCanonical", err)
			}
		})
	}
}

func TestPendingActionUnionRejectsFieldsFromOtherVariants(t *testing.T) {
	create := testMaterializeRecord(0, true)
	populate := testMaterializeRecord(1, true)
	rename := testPlanRecord(ModeInitial, PhaseRootSwapInProgress, PlanInitialForward, 0, true)
	policy := testPlanRecord(ModeInitial, PhaseCommitted, PlanCandidateActivationPolicy, 0, true)
	policy.ActivationPolicyState = ActivationPending
	tests := []struct {
		name        string
		record      TransactionRecord
		action      string
		replacement string
	}{
		{
			name:        "create receives populate identity",
			record:      create,
			action:      `{"actionKind":"create-candidate-root","direction":"forward","ordinal":1,"toSlot":"metadata-candidate"}`,
			replacement: `{"actionKind":"create-candidate-root","direction":"forward","expectedRoot":{"fileId":"22222222222222222222222222222222","securityDescriptorSha256":"2222222222222222222222222222222222222222222222222222222222222222","volumeSerialNumber":"123456789"},"ordinal":1,"toSlot":"metadata-candidate"}`,
		},
		{
			name:        "populate receives rename slot",
			record:      populate,
			action:      `{"actionKind":"populate-candidate-root","direction":"forward","expectedRoot":{"fileId":"22222222222222222222222222222222","securityDescriptorSha256":"2222222222222222222222222222222222222222222222222222222222222222","volumeSerialNumber":"123456789"},"ordinal":2,"slot":"metadata-candidate"}`,
			replacement: `{"actionKind":"populate-candidate-root","direction":"forward","expectedRoot":{"fileId":"22222222222222222222222222222222","securityDescriptorSha256":"2222222222222222222222222222222222222222222222222222222222222222","volumeSerialNumber":"123456789"},"fromSlot":"metadata-candidate","ordinal":2,"slot":"metadata-candidate"}`,
		},
		{
			name:        "rename receives candidate slot",
			record:      rename,
			action:      `{"actionKind":"rename-directory","direction":"forward","expectedRoot":{"fileId":"22222222222222222222222222222222","securityDescriptorSha256":"2222222222222222222222222222222222222222222222222222222222222222","volumeSerialNumber":"123456789"},"fromSlot":"metadata-candidate","ordinal":1,"toSlot":"metadata-final"}`,
			replacement: `{"actionKind":"rename-directory","direction":"forward","expectedRoot":{"fileId":"22222222222222222222222222222222","securityDescriptorSha256":"2222222222222222222222222222222222222222222222222222222222222222","volumeSerialNumber":"123456789"},"fromSlot":"metadata-candidate","ordinal":1,"slot":"metadata-candidate","toSlot":"metadata-final"}`,
		},
		{
			name:        "policy receives direction",
			record:      policy,
			action:      `{"actionKind":"apply-candidate-executor-policy","ordinal":1}`,
			replacement: `{"actionKind":"apply-candidate-executor-policy","direction":"forward","ordinal":1}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload, err := marshalCanonicalValue(test.record, MaximumTransactionRecordBytes)
			if err != nil {
				t.Fatal(err)
			}
			mutated := bytes.Replace(payload, []byte(test.action), []byte(test.replacement), 1)
			if bytes.Equal(mutated, payload) {
				t.Fatal("fixture action was not replaced")
			}
			if _, err := ParseRecord(wrapRecordPayloadForTest(mutated)); err == nil {
				t.Fatal("ParseRecord accepted a cross-variant field")
			}
		})
	}
}

func TestCanonicalMarshalRejectsInvalidDataAndConcreteActionPointers(t *testing.T) {
	if _, err := MarshalActiveHead(ActiveHead{TransactionID: "invalid"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("MarshalActiveHead returned %v, want ErrInvalid", err)
	}
	record := testMaterializeRecord(0, true)
	action := record.PendingAction.(CreateCandidateAction)
	record.PendingAction = &action
	if _, err := MarshalRecord(record); !errors.Is(err, ErrInvalid) {
		t.Fatalf("MarshalRecord returned %v, want ErrInvalid", err)
	}
}

func TestCanonicalOperationsDoNotMutateInput(t *testing.T) {
	record := testMaterializeRecord(3, true)
	before := cloneTestRecord(record)
	if _, err := MarshalRecord(record); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(record, before) {
		t.Fatal("MarshalRecord mutated its input")
	}
	document, err := MarshalRecord(testStagingRecord(ModeInitial))
	if err != nil {
		t.Fatal(err)
	}
	copyBefore := append([]byte(nil), document...)
	if _, err := ParseRecord(document); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(document, copyBefore) {
		t.Fatal("ParseRecord mutated its input")
	}
}

func parseHeadError(document []byte) error {
	_, err := ParseActiveHead(document)
	return err
}

func parseRecordError(document []byte) error {
	_, err := ParseRecord(document)
	return err
}

func wrapRecordPayloadForTest(payload []byte) []byte {
	return wrapRecordPayloadWithDigestForTest(payload, recordPayloadDigestForTest(payload))
}

func wrapRecordPayloadWithDigestForTest(payload []byte, digest string) []byte {
	return []byte(fmt.Sprintf(`{"record":%s,"recordSha256":"%s","schemaVersion":1}`, payload, digest))
}

func recordPayloadDigestForTest(payload []byte) string {
	digest := sha256.Sum256(append([]byte("AgenticReview split installer transaction record v1\x00"), payload...))
	return hex.EncodeToString(digest[:])
}

func TestGoldenFixtureHasExpectedDomainSeparatedDigest(t *testing.T) {
	digest := sha256.Sum256([]byte("AgenticReview split installer transaction record v1\x00" + testRecordPayloadGolden))
	if got := hex.EncodeToString(digest[:]); got != "47f8f8733c5af33107edc677cf52e0aaabbf8693b7c11e14f3857e3373d827a6" {
		t.Fatalf("record fixture digest = %s", got)
	}
	if !strings.Contains(testRecordPayloadGolden, `"pendingAction":null`) {
		t.Fatal("record golden does not lock the null pending action")
	}
}
