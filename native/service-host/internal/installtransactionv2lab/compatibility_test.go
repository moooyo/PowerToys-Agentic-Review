package installtransactionv2lab

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	v1 "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installtransaction"
)

func TestV1AndV2CanonicalRecordsRejectEachOther(t *testing.T) {
	v1Record := v1.TransactionRecord{
		ActionPlan:            v1.PlanNone,
		ActivationPolicyState: v1.ActivationNotApplicable,
		Candidate: v1.CandidateGeneration{
			PackageID:         "worker-package-next",
			ReleaseID:         "worker-2026.09.02.1",
			Roots:             nil,
			SignedIndexSHA256: v1.SHA256(strings.Repeat("8", 64)),
		},
		CompletedActionOrdinal: 0,
		FailureCode:            nil,
		InstallationID:         "installation-node-001",
		Mode:                   v1.ModeInitial,
		PendingAction:          nil,
		Phase:                  v1.PhaseStagingVerified,
		Previous:               nil,
		RecordSequence:         "1",
		RollbackCheckpoint:     v1.RollbackNotApplicable,
		TargetArchitecture:     v1.ArchitectureAMD64,
		TransactionID:          v1.TransactionID(testTransactionID),
		WorkerNodeID:           "powertoys-node:01",
	}
	v1Document, err := v1.MarshalRecord(v1Record)
	if err != nil {
		t.Fatal(err)
	}
	parsedV1, err := v1.ParseRecord(v1Document)
	if err != nil || !reflect.DeepEqual(parsedV1, v1Record) {
		t.Fatalf("v1 fixture is not self-validating: (%+v, %v)", parsedV1, err)
	}
	v1Payload := `{"actionPlan":"none","activationPolicyState":"not-applicable","candidate":{"packageId":"worker-package-next","releaseId":"worker-2026.09.02.1","roots":null,"signedIndexSha256":"8888888888888888888888888888888888888888888888888888888888888888"},"completedActionOrdinal":0,"failureCode":null,"installationId":"installation-node-001","mode":"initial","pendingAction":null,"phase":"STAGING_VERIFIED","previous":null,"recordSequence":"1","rollbackCheckpoint":"not-applicable","targetArchitecture":"amd64","transactionId":"123e4567-e89b-42d3-a456-426614174000","workerNodeId":"powertoys-node:01"}`
	v1Golden := `{"record":` + v1Payload + `,"recordSha256":"47f8f8733c5af33107edc677cf52e0aaabbf8693b7c11e14f3857e3373d827a6","schemaVersion":1}`
	if string(v1Document) != v1Golden {
		t.Fatalf("v1 canonical bytes changed: %q", v1Document)
	}

	v2Record := testStagingRecord(ModeInitial)
	v2Document, err := MarshalRecord(v2Record)
	if err != nil {
		t.Fatal(err)
	}
	parsedV2, err := ParseRecord(v2Document)
	if err != nil || !reflect.DeepEqual(parsedV2, v2Record) {
		t.Fatalf("v2 fixture is not self-validating: (%+v, %v)", parsedV2, err)
	}

	if _, err := ParseRecord(v1Document); err == nil {
		t.Fatal("v2 parser accepted a canonical v1 record")
	}
	if _, err := v1.ParseRecord(v2Document); err == nil {
		t.Fatal("v1 parser accepted a canonical v2 record")
	}
}

func TestV1PublicFunctionSignaturesRemainExact(t *testing.T) {
	tests := []struct {
		name string
		got  any
		want any
	}{
		{"MarshalActiveHead", v1.MarshalActiveHead, func(v1.ActiveHead) ([]byte, error) { return nil, nil }},
		{"ParseActiveHead", v1.ParseActiveHead, func([]byte) (v1.ActiveHead, error) { return v1.ActiveHead{}, nil }},
		{"MarshalRecord", v1.MarshalRecord, func(v1.TransactionRecord) ([]byte, error) { return nil, nil }},
		{"ParseRecord", v1.ParseRecord, func([]byte) (v1.TransactionRecord, error) { return v1.TransactionRecord{}, nil }},
		{"ValidateRecord", v1.ValidateRecord, func(v1.TransactionRecord) error { return nil }},
		{"ExpectedNextIntent", v1.ExpectedNextIntent, func(v1.TransactionRecord) (v1.NextIntent, error) {
			return v1.NextIntent{}, nil
		}},
	}
	for _, test := range tests {
		if reflect.TypeOf(test.got) != reflect.TypeOf(test.want) {
			t.Errorf("v1 %s type=%v, want %v", test.name, reflect.TypeOf(test.got), reflect.TypeOf(test.want))
		}
	}
}

func TestChangingOnlyVersionOrDigestDomainCannotBridgeSchemas(t *testing.T) {
	v2Document, err := MarshalRecord(testStagingRecord(ModeInitial))
	if err != nil {
		t.Fatal(err)
	}
	versionOnly := bytes.Replace(v2Document, []byte(`"schemaVersion":2`), []byte(`"schemaVersion":1`), 1)
	if _, err := v1.ParseRecord(versionOnly); err == nil {
		t.Fatal("v1 accepted a v2 record after only changing schemaVersion")
	}
	if _, err := ParseRecord(versionOnly); err == nil {
		t.Fatal("v2 accepted a v2 record labeled as schemaVersion 1")
	}

	v1Digest := digestCanonical("AgenticReview split installer transaction record v1\x00",
		[]byte(testRecordPayloadGolden))
	wrongDomain := bytes.Replace(v2Document,
		[]byte(`"recordSha256":"`+recordPayloadDigestForTest([]byte(testRecordPayloadGolden))+`"`),
		[]byte(`"recordSha256":"`+string(v1Digest)+`"`), 1)
	if _, err := ParseRecord(wrongDomain); err == nil {
		t.Fatal("v2 accepted a record digest from the v1 domain")
	}
	combined := []byte(`{"record":` + testRecordPayloadGolden + `,"recordSha256":"` +
		string(v1Digest) + `","schemaVersion":1}`)
	if _, err := v1.ParseRecord(combined); err == nil {
		t.Fatal("v1 accepted a v2 payload relabeled with version 1 and the v1 digest domain")
	}
	if _, err := ParseRecord(combined); err == nil {
		t.Fatal("v2 accepted a v2 payload relabeled with version 1 and the v1 digest domain")
	}
}

func TestV2WireTypesAreNotAliasesOfV1(t *testing.T) {
	if reflect.TypeOf(TransactionRecord{}) == reflect.TypeOf(v1.TransactionRecord{}) ||
		reflect.TypeOf((*PendingAction)(nil)).Elem() == reflect.TypeOf((*v1.PendingAction)(nil)).Elem() ||
		reflect.TypeOf(ActionPlan("")) == reflect.TypeOf(v1.ActionPlan("")) ||
		reflect.TypeOf(Phase("")) == reflect.TypeOf(v1.Phase("")) {
		t.Fatal("v2 wire contract aliases a v1 type")
	}
}

func TestPolicyActionUnionsDoNotCrossVersions(t *testing.T) {
	if _, err := parsePendingAction([]byte(`{"actionKind":"apply-candidate-executor-policy","ordinal":1}`)); err == nil {
		t.Fatal("v2 action codec accepted the v1 opaque policy action")
	}

	v1Record := v1.TransactionRecord{
		ActionPlan:            v1.PlanCandidateActivationPolicy,
		ActivationPolicyState: v1.ActivationPending,
		Candidate: v1.CandidateGeneration{
			PackageID:         "worker-package-next",
			ReleaseID:         "worker-2026.09.02.1",
			Roots:             v1CandidateRoots(),
			SignedIndexSHA256: v1.SHA256(strings.Repeat("8", 64)),
		},
		CompletedActionOrdinal: 0,
		InstallationID:         "installation-node-001",
		Mode:                   v1.ModeInitial,
		PendingAction: v1.PolicyAction{
			ActionKind: v1.ActionApplyCandidateExecutorPolicy,
			Ordinal:    1,
		},
		Phase:              v1.PhaseCommitted,
		RecordSequence:     "20",
		RollbackCheckpoint: v1.RollbackNotApplicable,
		TargetArchitecture: v1.ArchitectureAMD64,
		TransactionID:      v1.TransactionID(testTransactionID),
		WorkerNodeID:       "powertoys-node:01",
	}
	original, err := v1.MarshalRecord(v1Record)
	if err != nil {
		t.Fatal(err)
	}
	if parsed, err := v1.ParseRecord(original); err != nil || !reflect.DeepEqual(parsed, v1Record) {
		t.Fatalf("v1 policy fixture is not self-validating: (%+v, %v)", parsed, err)
	}
	payload, err := json.Marshal(v1Record)
	if err != nil {
		t.Fatal(err)
	}
	v2Action := `{"actionKind":"clear-control-failure-actions","ordinal":1,"policyContractId":"agentic-review-windows-split-service-scm-policy-v1","role":"control"}`
	mutated := bytes.Replace(payload,
		[]byte(`{"actionKind":"apply-candidate-executor-policy","ordinal":1}`),
		[]byte(v2Action), 1)
	if bytes.Equal(mutated, payload) {
		t.Fatal("v1 policy fixture action was not replaced")
	}
	digest := sha256.Sum256(append([]byte("AgenticReview split installer transaction record v1\x00"), mutated...))
	document := []byte(`{"record":` + string(mutated) + `,"recordSha256":"` +
		hex.EncodeToString(digest[:]) + `","schemaVersion":1}`)
	if _, err := v1.ParseRecord(document); err == nil {
		t.Fatal("v1 parser accepted a v2 SCM action in a v1 policy-plan record")
	}
}

func v1CandidateRoots() *v1.CandidateRootSet {
	installation := v1Root('1')
	metadata := v1Root('2')
	trusted := v1Root('3')
	return &v1.CandidateRootSet{
		Installation:         &installation,
		Metadata:             &metadata,
		TrustedConfiguration: &trusted,
	}
}

func v1Root(digit byte) v1.RootIdentity {
	return v1.RootIdentity{
		FileID:                   v1.FileID(strings.Repeat(string(digit), 32)),
		SecurityDescriptorSHA256: v1.SHA256(strings.Repeat(string(digit), 64)),
		VolumeSerialNumber:       "123456789",
	}
}
