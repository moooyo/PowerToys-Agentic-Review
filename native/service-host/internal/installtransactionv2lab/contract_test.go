package installtransactionv2lab

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
	assertFrozenFields(t, reflect.TypeOf(BlockedCheckpoint{}), []frozenField{
		{"ActionKind", reflect.TypeOf(ActionKind("")), `json:"actionKind"`},
		{"MissingPrerequisites", reflect.TypeOf([]BlockedReason(nil)), `json:"missingPrerequisites"`},
		{"Ordinal", reflect.TypeOf(ActionOrdinal(0)), `json:"ordinal"`},
		{"Plan", reflect.TypeOf(ActionPlan("")), `json:"plan"`},
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
	assertFrozenFields(t, reflect.TypeOf(SCMAction{}), []frozenField{
		{"ActionKind", reflect.TypeOf(ActionKind("")), `json:"actionKind"`},
		{"Ordinal", reflect.TypeOf(ActionOrdinal(0)), `json:"ordinal"`},
		{"PolicyContractID", reflect.TypeOf(SCMPolicyContractID("")), `json:"policyContractId"`},
		{"Role", reflect.TypeOf(ServiceRole("")), `json:"role"`},
	})
	assertFrozenFields(t, reflect.TypeOf(SCMGenerationAction{}), []frozenField{
		{"ActionKind", reflect.TypeOf(ActionKind("")), `json:"actionKind"`},
		{"Ordinal", reflect.TypeOf(ActionOrdinal(0)), `json:"ordinal"`},
		{"PolicyContractID", reflect.TypeOf(SCMPolicyContractID("")), `json:"policyContractId"`},
		{"Role", reflect.TypeOf(ServiceRole("")), `json:"role"`},
		{"TargetGeneration", reflect.TypeOf(TargetGeneration("")), `json:"targetGeneration"`},
	})
	recordFields := []frozenField{
		{"ActionPlan", reflect.TypeOf(ActionPlan("")), `json:"actionPlan"`},
		{"ActivationPolicyState", reflect.TypeOf(ActivationPolicyState("")), `json:"activationPolicyState"`},
		{"BlockedCheckpoint", reflect.TypeOf((*BlockedCheckpoint)(nil)), `json:"blockedCheckpoint"`},
		{"Candidate", reflect.TypeOf(CandidateGeneration{}), `json:"candidate"`},
		{"CompletedActionOrdinal", reflect.TypeOf(ActionOrdinal(0)), `json:"completedActionOrdinal"`},
		{"FailureCode", reflect.TypeOf((*FailureCode)(nil)), `json:"failureCode"`},
		{"InstallationID", reflect.TypeOf(PackageComponentID("")), `json:"installationId"`},
		{"Mode", reflect.TypeOf(Mode("")), `json:"mode"`},
		{"PendingAction", reflect.TypeOf((*PendingAction)(nil)).Elem(), `json:"pendingAction"`},
		{"Phase", reflect.TypeOf(Phase("")), `json:"phase"`},
		{"SCMPolicyContractID", reflect.TypeOf(SCMPolicyContractID("")), `json:"scmPolicyContractId"`},
		{"Previous", reflect.TypeOf((*PackageGeneration)(nil)), `json:"previous"`},
		{"RecordSequence", reflect.TypeOf(DecimalUint64("")), `json:"recordSequence"`},
		{"RollbackCheckpoint", reflect.TypeOf(RollbackCheckpoint("")), `json:"rollbackCheckpoint"`},
		{"TargetArchitecture", reflect.TypeOf(TargetArchitecture("")), `json:"targetArchitecture"`},
		{"TransactionID", reflect.TypeOf(TransactionID("")), `json:"transactionId"`},
		{"WorkerNodeID", reflect.TypeOf(EntityID("")), `json:"workerNodeId"`},
	}
	assertFrozenFields(t, reflect.TypeOf(TransactionRecord{}), recordFields)
	wireFields := append([]frozenField(nil), recordFields...)
	wireFields[8].typeOf = reflect.TypeOf(json.RawMessage{})
	assertFrozenFields(t, reflect.TypeOf(transactionRecordWire{}), wireFields)
	assertFrozenFields(t, reflect.TypeOf(transactionDocumentWire{}), []frozenField{
		{"Record", reflect.TypeOf(json.RawMessage{}), `json:"record"`},
		{"RecordSHA256", reflect.TypeOf(SHA256("")), `json:"recordSha256"`},
		{"SchemaVersion", reflect.TypeOf(uint32(0)), `json:"schemaVersion"`},
	})
}

func TestPendingActionInterfaceIsSealed(t *testing.T) {
	typeOf := reflect.TypeOf((*PendingAction)(nil)).Elem()
	want := map[string]bool{"ActionOrdinal": false, "Kind": false, "isPendingAction": false}
	if typeOf.NumMethod() != len(want) {
		t.Fatalf("PendingAction method count=%d, want %d", typeOf.NumMethod(), len(want))
	}
	for index := 0; index < typeOf.NumMethod(); index++ {
		want[typeOf.Method(index).Name] = true
	}
	for name, found := range want {
		if !found {
			t.Errorf("PendingAction method %s is absent", name)
		}
	}
}

func TestPublicFunctionSignaturesAndScalarKindsAreFrozen(t *testing.T) {
	functions := []struct {
		name string
		got  any
		want any
	}{
		{"MarshalRecord", MarshalRecord, func(TransactionRecord) ([]byte, error) { return nil, nil }},
		{"ParseRecord", ParseRecord, func([]byte) (TransactionRecord, error) { return TransactionRecord{}, nil }},
		{"ValidateRecord", ValidateRecord, func(TransactionRecord) error { return nil }},
	}
	for _, function := range functions {
		if reflect.TypeOf(function.got) != reflect.TypeOf(function.want) {
			t.Errorf("%s type=%v, want %v", function.name, reflect.TypeOf(function.got), reflect.TypeOf(function.want))
		}
	}
	stringTypes := []any{
		TransactionID(""), PackageComponentID(""), EntityID(""), ReleaseID(""), SHA256(""),
		FileID(""), DecimalUint64(""), SCMPolicyContractID(""), Mode(""),
		TargetArchitecture(""), Phase(""), ActivationPolicyState(""), RollbackCheckpoint(""),
		ActionPlan(""), FailureCode(""), Direction(""), ServiceRole(""), TargetGeneration(""),
		ActionKind(""), BlockedReason(""), CandidateRootSlot(""), RootSlot(""),
	}
	for _, value := range stringTypes {
		if reflect.TypeOf(value).Kind() != reflect.String {
			t.Errorf("%T underlying kind=%v, want string", value, reflect.TypeOf(value).Kind())
		}
	}
	if reflect.TypeOf(ActionOrdinal(0)).Kind() != reflect.Uint8 {
		t.Fatalf("ActionOrdinal underlying kind=%v, want uint8", reflect.TypeOf(ActionOrdinal(0)).Kind())
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
