package installtransactionv2lab

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

const testRecordPayloadGolden = `{"actionPlan":"none","activationPolicyState":"not-applicable","blockedCheckpoint":null,"candidate":{"packageId":"worker-package-next","releaseId":"worker-2026.09.02.1","roots":null,"signedIndexSha256":"8888888888888888888888888888888888888888888888888888888888888888"},"completedActionOrdinal":0,"failureCode":null,"installationId":"installation-node-001","mode":"initial","pendingAction":null,"phase":"STAGING_VERIFIED","scmPolicyContractId":"agentic-review-windows-split-service-scm-policy-v1","previous":null,"recordSequence":"1","rollbackCheckpoint":"not-applicable","targetArchitecture":"amd64","transactionId":"123e4567-e89b-42d3-a456-426614174000","workerNodeId":"powertoys-node:01"}`

func TestCanonicalTransactionRecordGolden(t *testing.T) {
	record := testStagingRecord(ModeInitial)
	document, err := MarshalRecord(record)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(recordDigestDomain + testRecordPayloadGolden))
	want := `{"record":` + testRecordPayloadGolden + `,"recordSha256":"` +
		hex.EncodeToString(digest[:]) + `","schemaVersion":2}`
	if string(document) != want {
		t.Fatalf("MarshalRecord = %q, want %q", document, want)
	}
	parsed, err := ParseRecord(document)
	if err != nil || !reflect.DeepEqual(parsed, record) {
		t.Fatalf("ParseRecord = (%+v, %v), want %+v", parsed, err, record)
	}
}

func TestCanonicalBlockedCheckpointsRoundTripWithoutAliases(t *testing.T) {
	for _, record := range []TransactionRecord{
		testPlanRecord(ModeUpgrade, PhaseQuiesced, PlanSCMMaintenance, 0, false),
		testPlanRecord(ModeInitial, PhaseServiceConfigurationProgress, PlanInitialServiceCreation, 0, false),
		testPlanRecord(ModeInitial, PhaseServicesConfigured, PlanStartCandidateServices, 0, false),
		testCandidateFinalBlockedRecord(),
		testPreviousFinalBlockedRecord(),
	} {
		document, err := MarshalRecord(record)
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := ParseRecord(document)
		if err != nil || !reflect.DeepEqual(parsed, record) {
			t.Fatalf("blocked round trip = (%+v, %v), want %+v", parsed, err, record)
		}
		before := append([]byte(nil), document...)
		record.BlockedCheckpoint.MissingPrerequisites[0] = BlockedCandidateFinalPolicy
		parsed.BlockedCheckpoint.MissingPrerequisites[0] = BlockedPreviousFinalPolicy
		if !bytes.Equal(document, before) {
			t.Fatal("mutating blocker aliases changed canonical input bytes")
		}
	}
}

func TestParsersRejectEncodingShapeDigestAndCanonicalAttacks(t *testing.T) {
	record, err := MarshalRecord(testStagingRecord(ModeInitial))
	if err != nil {
		t.Fatal(err)
	}
	reordered := []byte(`{"schemaVersion":2,"record":` + testRecordPayloadGolden +
		`,"recordSha256":"` + recordPayloadDigestForTest([]byte(testRecordPayloadGolden)) + `"}`)
	tests := []struct {
		name  string
		value []byte
	}{
		{name: "BOM", value: append([]byte{0xef, 0xbb, 0xbf}, record...)},
		{name: "unknown envelope field", value: bytes.Replace(record, []byte(`,"schemaVersion":2}`), []byte(`,"schemaVersion":2,"unknown":true}`), 1)},
		{name: "duplicate envelope field", value: bytes.Replace(record, []byte(`"schemaVersion":2`), []byte(`"schemaVersion":2,"schemaVersion":2`), 1)},
		{name: "unknown record field", value: bytes.Replace(record, []byte(`"workerNodeId":"powertoys-node:01"`), []byte(`"workerNodeId":"powertoys-node:01","unknown":true`), 1)},
		{name: "duplicate record field", value: bytes.Replace(record, []byte(`"workerNodeId":"powertoys-node:01"`), []byte(`"workerNodeId":"powertoys-node:01","workerNodeId":"powertoys-node:01"`), 1)},
		{name: "member order", value: reordered},
		{name: "leading whitespace", value: append([]byte(" "), record...)},
		{name: "trailing JSON", value: append(append([]byte(nil), record...), []byte(`{}`)...)},
		{name: "wrong digest", value: bytes.Replace(record, []byte(`"recordSha256":"`), []byte(`"recordSha256":"0`), 1)},
		{name: "wrong version", value: bytes.Replace(record, []byte(`"schemaVersion":2`), []byte(`"schemaVersion":1`), 1)},
		{name: "null version", value: bytes.Replace(record, []byte(`"schemaVersion":2`), []byte(`"schemaVersion":null`), 1)},
		{name: "invalid UTF-8", value: []byte{0xff}},
		{name: "oversized", value: bytes.Repeat([]byte{'x'}, MaximumTransactionRecordBytes+1)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := ParseRecord(test.value); err == nil {
				t.Fatal("ParseRecord accepted invalid document")
			}
		})
	}
}

func TestPendingActionCanonicalUnionRoundTripsEveryExecutableVariant(t *testing.T) {
	records := []TransactionRecord{
		testMaterializeRecord(0, true),
		testMaterializeRecord(1, true),
		testPlanRecord(ModeInitial, PhaseRootSwapInProgress, PlanInitialForward, 0, true),
	}
	for _, record := range records {
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

func TestCanonicalMarshalAndParseDoNotMutateInputs(t *testing.T) {
	record := testCandidateFinalBlockedRecord()
	before := cloneTestRecord(record)
	document, err := MarshalRecord(record)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(record, before) {
		t.Fatal("MarshalRecord mutated its input")
	}
	copyBefore := append([]byte(nil), document...)
	parsed, err := ParseRecord(document)
	if err != nil {
		t.Fatal(err)
	}
	parsed.BlockedCheckpoint.MissingPrerequisites[0] = BlockedPreviousFinalPolicy
	if !bytes.Equal(document, copyBefore) {
		t.Fatal("ParseRecord returned an alias into input bytes")
	}
	second, err := ParseRecord(document)
	if err != nil || !reflect.DeepEqual(second, before) {
		t.Fatal("mutating parsed blocker changed a later parse")
	}
}

func TestCanonicalRejectsActionPointersAndCrossVariantFields(t *testing.T) {
	record := testMaterializeRecord(0, true)
	action := record.PendingAction.(CreateCandidateAction)
	record.PendingAction = &action
	if _, err := MarshalRecord(record); !errors.Is(err, ErrInvalid) {
		t.Fatalf("MarshalRecord returned %v, want ErrInvalid", err)
	}

	blocked := testPlanRecord(ModeUpgrade, PhaseQuiesced, PlanSCMMaintenance, 0, false)
	payload, err := marshalCanonicalValue(blocked, MaximumTransactionRecordBytes)
	if err != nil {
		t.Fatal(err)
	}
	mutated := bytes.Replace(payload, []byte(`"pendingAction":null`),
		[]byte(`"pendingAction":{"actionKind":"clear-control-failure-actions","ordinal":1,"policyContractId":"agentic-review-windows-split-service-scm-policy-v1","role":"control","targetGeneration":"candidate"}`), 1)
	if bytes.Equal(mutated, payload) {
		t.Fatal("fixture pending action was not replaced")
	}
	if _, err := ParseRecord(wrapRecordPayloadForTest(mutated)); err == nil {
		t.Fatal("ParseRecord accepted fields from another action variant")
	}
}

func TestSCMActionCodecsRecognizeExactShapesButRecordsRemainBlocked(t *testing.T) {
	record := testPlanRecord(ModeUpgrade, PhaseQuiesced, PlanSCMMaintenance, 0, false)
	plain, err := expectedAction(record, record.ActionPlan, 1)
	if err != nil {
		t.Fatal(err)
	}
	start, err := expectedAction(record, PlanStartCandidateServices, 1)
	if err != nil {
		t.Fatal(err)
	}
	for _, action := range []PendingAction{plain, start} {
		document, err := marshalPendingAction(action)
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := parsePendingAction(document)
		if err != nil || !pendingActionsEqual(parsed, action) {
			t.Fatalf("action codec = (%#v, %v), want %#v", parsed, err, action)
		}
	}

	plainDocument, _ := marshalPendingAction(plain)
	withGeneration := bytes.Replace(plainDocument, []byte(`,"role":"control"}`),
		[]byte(`,"role":"control","targetGeneration":"candidate"}`), 1)
	if _, err := parsePendingAction(withGeneration); err == nil {
		t.Fatal("plain SCM action accepted a generation field")
	}
	startDocument, _ := marshalPendingAction(start)
	withoutGeneration := bytes.Replace(startDocument, []byte(`,"targetGeneration":"candidate"`), nil, 1)
	if _, err := parsePendingAction(withoutGeneration); err == nil {
		t.Fatal("generation-bound SCM action accepted a missing generation")
	}
	for _, test := range []struct {
		name  string
		value []byte
	}{
		{"wrong role", bytes.Replace(plainDocument, []byte(`"role":"control"`), []byte(`"role":"executor"`), 1)},
		{"wrong contract", bytes.Replace(plainDocument,
			[]byte(`"policyContractId":"agentic-review-windows-split-service-scm-policy-v1"`),
			[]byte(`"policyContractId":"other"`), 1)},
		{"null contract", bytes.Replace(plainDocument,
			[]byte(`"policyContractId":"agentic-review-windows-split-service-scm-policy-v1"`),
			[]byte(`"policyContractId":null`), 1)},
		{"uppercase contract", bytes.Replace(plainDocument,
			[]byte(`"policyContractId":"agentic-review-windows-split-service-scm-policy-v1"`),
			[]byte(`"policyContractId":"AGENTIC-REVIEW-WINDOWS-SPLIT-SERVICE-SCM-POLICY-V1"`), 1)},
		{"wrong generation", bytes.Replace(startDocument,
			[]byte(`"targetGeneration":"candidate"`), []byte(`"targetGeneration":"other"`), 1)},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := parsePendingAction(test.value); err == nil {
				t.Fatal("action codec accepted invalid SCM identity")
			}
		})
	}

	mutated := cloneTestRecord(record)
	mutated.PendingAction = plain
	mutated.BlockedCheckpoint = nil
	wire, err := recordToWire(mutated)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := marshalCanonicalValue(wire, MaximumTransactionRecordBytes)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseRecord(wrapRecordPayloadForTest(payload)); err == nil {
		t.Fatal("record parser accepted an exact blocked SCM action as pending")
	}
}

func wrapRecordPayloadForTest(payload []byte) []byte {
	return []byte(fmt.Sprintf(`{"record":%s,"recordSha256":"%s","schemaVersion":2}`,
		payload, recordPayloadDigestForTest(payload)))
}

func recordPayloadDigestForTest(payload []byte) string {
	digest := sha256.Sum256(append([]byte(recordDigestDomain), payload...))
	return hex.EncodeToString(digest[:])
}

func TestGoldenLocksPolicyContractAndNullPendingAction(t *testing.T) {
	if !strings.Contains(testRecordPayloadGolden,
		`"scmPolicyContractId":"agentic-review-windows-split-service-scm-policy-v1"`) {
		t.Fatal("golden does not lock the SCM policy contract")
	}
	if !strings.Contains(testRecordPayloadGolden, `"pendingAction":null`) ||
		!strings.Contains(testRecordPayloadGolden, `"blockedCheckpoint":null`) {
		t.Fatal("golden does not lock null action and checkpoint fields")
	}
}
