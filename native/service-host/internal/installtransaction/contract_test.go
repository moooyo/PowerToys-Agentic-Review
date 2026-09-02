package installtransaction

import (
	"encoding/json"
	"reflect"
	"testing"
)

type frozenField struct {
	name   string
	typeOf reflect.Type
	tag    reflect.StructTag
}

func TestCanonicalStructShapesAreFrozen(t *testing.T) {
	assertFrozenFields(t, reflect.TypeOf(ActiveHead{}), []frozenField{
		{"TransactionID", reflect.TypeOf(TransactionID("")), `json:"transactionId"`},
	})
	assertFrozenFields(t, reflect.TypeOf(activeHeadDocument{}), []frozenField{
		{"Head", reflect.TypeOf(ActiveHead{}), `json:"head"`},
		{"HeadSHA256", reflect.TypeOf(SHA256("")), `json:"headSha256"`},
		{"SchemaVersion", reflect.TypeOf(uint32(0)), `json:"schemaVersion"`},
	})
	assertFrozenFields(t, reflect.TypeOf(transactionDocumentWire{}), []frozenField{
		{"Record", reflect.TypeOf(json.RawMessage{}), `json:"record"`},
		{"RecordSHA256", reflect.TypeOf(SHA256("")), `json:"recordSha256"`},
		{"SchemaVersion", reflect.TypeOf(uint32(0)), `json:"schemaVersion"`},
	})
	assertFrozenFields(t, reflect.TypeOf(RootIdentity{}), []frozenField{
		{"FileID", reflect.TypeOf(FileID("")), `json:"fileId"`},
		{"SecurityDescriptorSHA256", reflect.TypeOf(SHA256("")), `json:"securityDescriptorSha256"`},
		{"VolumeSerialNumber", reflect.TypeOf(DecimalUint64("")), `json:"volumeSerialNumber"`},
	})
	assertFrozenFields(t, reflect.TypeOf(CandidateRootSet{}), []frozenField{
		{"Installation", reflect.TypeOf((*RootIdentity)(nil)), `json:"installation"`},
		{"Metadata", reflect.TypeOf((*RootIdentity)(nil)), `json:"metadata"`},
		{"TrustedConfiguration", reflect.TypeOf((*RootIdentity)(nil)), `json:"trustedConfiguration"`},
	})
	assertFrozenFields(t, reflect.TypeOf(RootSet{}), []frozenField{
		{"Installation", reflect.TypeOf(RootIdentity{}), `json:"installation"`},
		{"Metadata", reflect.TypeOf(RootIdentity{}), `json:"metadata"`},
		{"TrustedConfiguration", reflect.TypeOf(RootIdentity{}), `json:"trustedConfiguration"`},
	})
	assertFrozenFields(t, reflect.TypeOf(CandidateGeneration{}), []frozenField{
		{"PackageID", reflect.TypeOf(PackageComponentID("")), `json:"packageId"`},
		{"ReleaseID", reflect.TypeOf(ReleaseID("")), `json:"releaseId"`},
		{"Roots", reflect.TypeOf((*CandidateRootSet)(nil)), `json:"roots"`},
		{"SignedIndexSHA256", reflect.TypeOf(SHA256("")), `json:"signedIndexSha256"`},
	})
	assertFrozenFields(t, reflect.TypeOf(PackageGeneration{}), []frozenField{
		{"PackageID", reflect.TypeOf(PackageComponentID("")), `json:"packageId"`},
		{"ReleaseID", reflect.TypeOf(ReleaseID("")), `json:"releaseId"`},
		{"Roots", reflect.TypeOf(RootSet{}), `json:"roots"`},
		{"SignedIndexSHA256", reflect.TypeOf(SHA256("")), `json:"signedIndexSha256"`},
	})
	assertFrozenFields(t, reflect.TypeOf(CreateCandidateAction{}), []frozenField{
		{"ActionKind", reflect.TypeOf(ActionKind("")), `json:"actionKind"`},
		{"Direction", reflect.TypeOf(Direction("")), `json:"direction"`},
		{"Ordinal", reflect.TypeOf(ActionOrdinal(0)), `json:"ordinal"`},
		{"ToSlot", reflect.TypeOf(CandidateRootSlot("")), `json:"toSlot"`},
	})
	assertFrozenFields(t, reflect.TypeOf(PopulateCandidateAction{}), []frozenField{
		{"ActionKind", reflect.TypeOf(ActionKind("")), `json:"actionKind"`},
		{"Direction", reflect.TypeOf(Direction("")), `json:"direction"`},
		{"ExpectedRoot", reflect.TypeOf(RootIdentity{}), `json:"expectedRoot"`},
		{"Ordinal", reflect.TypeOf(ActionOrdinal(0)), `json:"ordinal"`},
		{"Slot", reflect.TypeOf(CandidateRootSlot("")), `json:"slot"`},
	})
	assertFrozenFields(t, reflect.TypeOf(RenameAction{}), []frozenField{
		{"ActionKind", reflect.TypeOf(ActionKind("")), `json:"actionKind"`},
		{"Direction", reflect.TypeOf(Direction("")), `json:"direction"`},
		{"ExpectedRoot", reflect.TypeOf(RootIdentity{}), `json:"expectedRoot"`},
		{"FromSlot", reflect.TypeOf(RootSlot("")), `json:"fromSlot"`},
		{"Ordinal", reflect.TypeOf(ActionOrdinal(0)), `json:"ordinal"`},
		{"ToSlot", reflect.TypeOf(RootSlot("")), `json:"toSlot"`},
	})
	assertFrozenFields(t, reflect.TypeOf(PolicyAction{}), []frozenField{
		{"ActionKind", reflect.TypeOf(ActionKind("")), `json:"actionKind"`},
		{"Ordinal", reflect.TypeOf(ActionOrdinal(0)), `json:"ordinal"`},
	})
	recordFields := []frozenField{
		{"ActionPlan", reflect.TypeOf(ActionPlan("")), `json:"actionPlan"`},
		{"ActivationPolicyState", reflect.TypeOf(ActivationPolicyState("")), `json:"activationPolicyState"`},
		{"Candidate", reflect.TypeOf(CandidateGeneration{}), `json:"candidate"`},
		{"CompletedActionOrdinal", reflect.TypeOf(ActionOrdinal(0)), `json:"completedActionOrdinal"`},
		{"FailureCode", reflect.TypeOf((*FailureCode)(nil)), `json:"failureCode"`},
		{"InstallationID", reflect.TypeOf(PackageComponentID("")), `json:"installationId"`},
		{"Mode", reflect.TypeOf(Mode("")), `json:"mode"`},
		{"PendingAction", reflect.TypeOf((*PendingAction)(nil)).Elem(), `json:"pendingAction"`},
		{"Phase", reflect.TypeOf(Phase("")), `json:"phase"`},
		{"Previous", reflect.TypeOf((*PackageGeneration)(nil)), `json:"previous"`},
		{"RecordSequence", reflect.TypeOf(DecimalUint64("")), `json:"recordSequence"`},
		{"RollbackCheckpoint", reflect.TypeOf(RollbackCheckpoint("")), `json:"rollbackCheckpoint"`},
		{"TargetArchitecture", reflect.TypeOf(TargetArchitecture("")), `json:"targetArchitecture"`},
		{"TransactionID", reflect.TypeOf(TransactionID("")), `json:"transactionId"`},
		{"WorkerNodeID", reflect.TypeOf(EntityID("")), `json:"workerNodeId"`},
	}
	assertFrozenFields(t, reflect.TypeOf(TransactionRecord{}), recordFields)
	wireFields := append([]frozenField(nil), recordFields...)
	wireFields[7].typeOf = reflect.TypeOf(json.RawMessage{})
	assertFrozenFields(t, reflect.TypeOf(transactionRecordWire{}), wireFields)
	assertFrozenFields(t, reflect.TypeOf(NextIntent{}), []frozenField{
		{"Disposition", reflect.TypeOf(NextIntentDisposition("")), ""},
		{"Plan", reflect.TypeOf(ActionPlan("")), ""},
		{"Phase", reflect.TypeOf(Phase("")), ""},
		{"ActivationPolicyState", reflect.TypeOf(ActivationPolicyState("")), ""},
		{"Action", reflect.TypeOf((*PendingAction)(nil)).Elem(), ""},
	})
}

func TestPendingActionInterfaceMethodSetIsSealed(t *testing.T) {
	typeOf := reflect.TypeOf((*PendingAction)(nil)).Elem()
	want := map[string]bool{"ActionOrdinal": false, "Kind": false, "isPendingAction": false}
	if typeOf.NumMethod() != len(want) {
		t.Fatalf("PendingAction method count=%d, want %d", typeOf.NumMethod(), len(want))
	}
	for index := 0; index < typeOf.NumMethod(); index++ {
		method := typeOf.Method(index)
		if _, exists := want[method.Name]; !exists {
			t.Fatalf("PendingAction exposes unexpected method %s", method.Name)
		}
		want[method.Name] = true
	}
	for name, found := range want {
		if !found {
			t.Errorf("PendingAction method %s is absent", name)
		}
	}
}

func assertFrozenFields(t *testing.T, typeOf reflect.Type, expected []frozenField) {
	t.Helper()
	if typeOf.NumField() != len(expected) {
		t.Fatalf("%s field count=%d, want %d", typeOf.Name(), typeOf.NumField(), len(expected))
	}
	for index, want := range expected {
		got := typeOf.Field(index)
		if got.Name != want.name || got.Type != want.typeOf || got.Tag != want.tag {
			t.Errorf("%s field %d=(%s, %v, %q), want (%s, %v, %q)",
				typeOf.Name(), index, got.Name, got.Type, got.Tag, want.name, want.typeOf, want.tag)
		}
	}
}
