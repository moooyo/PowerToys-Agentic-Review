package installstorev2lab

import (
	"reflect"
	"testing"

	recordv2 "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installtransactionv2lab"
)

type frozenField struct {
	name   string
	typeOf reflect.Type
	tag    reflect.StructTag
}

func TestOrdinaryContractShapesAreExact(t *testing.T) {
	assertFields(t, reflect.TypeOf(Head{}), []frozenField{
		{"EntrySHA256", reflect.TypeOf(SHA256("")), `json:"entrySha256"`},
		{"RecordSequence", reflect.TypeOf(DecimalUint64("")), `json:"recordSequence"`},
		{"TransactionID", reflect.TypeOf(TransactionID("")), `json:"transactionId"`},
	})
	assertFields(t, reflect.TypeOf(Predecessor{}), []frozenField{
		{"HeadDocumentSHA256", reflect.TypeOf(SHA256("")), `json:"headDocumentSha256"`},
		{"InventorySHA256", reflect.TypeOf(SHA256("")), `json:"inventorySha256"`},
		{"RecordDocumentSHA256", reflect.TypeOf(SHA256("")), `json:"recordDocumentSha256"`},
		{"RecordSequence", reflect.TypeOf(DecimalUint64("")), `json:"recordSequence"`},
		{"SourceSchemaVersion", reflect.TypeOf(uint32(0)), `json:"sourceSchemaVersion"`},
		{"TransactionID", reflect.TypeOf(TransactionID("")), `json:"transactionId"`},
	})
	assertFields(t, reflect.TypeOf(V1InventoryEntry{}), []frozenField{
		{"RecordDocumentSHA256", reflect.TypeOf(SHA256("")), `json:"recordDocumentSha256"`},
		{"RecordSequence", reflect.TypeOf(DecimalUint64("")), `json:"recordSequence"`},
		{"TerminalDisposition", reflect.TypeOf(TerminalDisposition("")), `json:"terminalDisposition"`},
		{"TransactionID", reflect.TypeOf(TransactionID("")), `json:"transactionId"`},
	})
	assertFields(t, reflect.TypeOf(Entry{}), []frozenField{
		{"PredecessorDocument", reflect.TypeOf((*Predecessor)(nil)), ""},
		{"PreviousEntrySHA256", reflect.TypeOf((*SHA256)(nil)), ""},
		{"RecordDocument", reflect.TypeOf(recordv2.TransactionRecord{}), ""},
	})
}

func TestCapabilityTypesHaveOnlyOnePrivateStatePointer(t *testing.T) {
	types := []reflect.Type{
		reflect.TypeOf(PreparedSuccessor{}),
		reflect.TypeOf(DurableIntentPermit{}),
		reflect.TypeOf(ExactBeforeToken{}),
	}
	for _, typeOf := range types {
		if typeOf.NumField() != 1 {
			t.Fatalf("%s field count = %d, want 1", typeOf, typeOf.NumField())
		}
		field := typeOf.Field(0)
		if field.Name != "state" || field.PkgPath == "" || field.Type.Kind() != reflect.Pointer {
			t.Fatalf("%s field = %+v, want one unexported state pointer", typeOf, field)
		}
	}
}

func TestPrivateCapabilityBindingShapesAreExact(t *testing.T) {
	assertPrivateFieldNames(t, reflect.TypeOf(preparedSuccessorState{}), []string{
		"issuer", "storeGeneration", "writerLockIdentitySHA256", "currentHeadFileIdentitySHA256",
		"currentSelectedDocumentIdentitySHA256", "headParentIdentitySHA256",
		"currentSelectedParentIdentitySHA256", "nextEntryParentIdentitySHA256",
		"currentExpectedHeadSchemaVersion", "currentHeadDocument", "currentHeadDocumentSHA256",
		"currentSelectedDocument", "currentSelectedDocumentSHA256", "currentTransactionID",
		"currentRecordSequence", "nextTransactionID", "nextRecordSequence", "recordSchemaVersion",
		"entrySchemaVersion", "predecessorDocument", "predecessorDocumentSHA256", "previousEntrySHA256",
		"nextRecordDocument", "nextRecordDocumentSHA256", "nextRecordSHA256", "nextEntryDocument",
		"nextEntryDocumentSHA256", "nextEntrySHA256", "nextHeadDocument", "nextHeadDocumentSHA256",
		"nextHeadSHA256", "scmPolicyContractID", "blockedCheckpointDocument", "blockedCheckpointSHA256",
		"actionPlan", "hasPendingAction", "actionDocument", "actionSHA256", "actionKind", "actionOrdinal",
	})
	assertPrivateFieldNames(t, reflect.TypeOf(durableIntentIdentity{}), []string{
		"issuer", "storeGeneration", "writerLockIdentitySHA256", "headFileIdentitySHA256",
		"selectedEntryIdentitySHA256", "headParentIdentitySHA256", "entryParentIdentitySHA256",
		"transactionID", "recordSequence", "recordSchemaVersion", "entrySchemaVersion", "headDocument",
		"headDocumentSHA256", "headSHA256", "entryDocument", "entryDocumentSHA256", "entrySHA256",
		"recordDocument", "recordDocumentSHA256", "recordSHA256", "scmPolicyContractID",
		"blockedCheckpointDocument", "blockedCheckpointSHA256", "actionPlan", "actionDocument",
		"actionSHA256", "actionKind", "actionOrdinal",
	})
	assertPrivateFieldNames(t, reflect.TypeOf(durableIntentPermitState{}), []string{"identity", "consumed"})
	assertPrivateFieldNames(t, reflect.TypeOf(exactBeforeTokenState{}), []string{
		"identity", "observationDocument", "observationSHA256", "observationGeneration",
		"exclusionGeneration", "targetIdentitySHA256", "targetParentIdentitySHA256", "consumed",
	})
}

func TestPublicFunctionSignaturesAreExact(t *testing.T) {
	functions := []struct {
		name string
		got  any
		want any
	}{
		{"MarshalHeadDocument", MarshalHeadDocument, func(Head) ([]byte, error) { return nil, nil }},
		{"ParseHeadDocument", ParseHeadDocument, func([]byte) (Head, error) { return Head{}, nil }},
		{"MarshalPredecessorDocument", MarshalPredecessorDocument, func(Predecessor) ([]byte, error) { return nil, nil }},
		{"ParsePredecessorDocument", ParsePredecessorDocument, func([]byte) (Predecessor, error) { return Predecessor{}, nil }},
		{"MarshalV1Inventory", MarshalV1Inventory, func([]V1InventoryEntry) ([]byte, SHA256, error) { return nil, "", nil }},
		{"ParseV1Inventory", ParseV1Inventory, func([]byte) ([]V1InventoryEntry, SHA256, error) { return nil, "", nil }},
		{"MarshalEntryDocument", MarshalEntryDocument, func(Entry) ([]byte, error) { return nil, nil }},
		{"ParseEntryDocument", ParseEntryDocument, func([]byte) (Entry, error) { return Entry{}, nil }},
		{"OpenExclusive", OpenExclusive, func() (*exclusiveStore, error) { return nil, nil }},
	}
	for _, function := range functions {
		if reflect.TypeOf(function.got) != reflect.TypeOf(function.want) {
			t.Errorf("%s type = %v, want %v", function.name, reflect.TypeOf(function.got), reflect.TypeOf(function.want))
		}
	}
}

func assertFields(t *testing.T, typeOf reflect.Type, expected []frozenField) {
	t.Helper()
	if typeOf.NumField() != len(expected) {
		t.Fatalf("%s field count = %d, want %d", typeOf, typeOf.NumField(), len(expected))
	}
	for index, want := range expected {
		got := typeOf.Field(index)
		if got.Name != want.name || got.Type != want.typeOf || got.Tag != want.tag {
			t.Errorf("%s field %d = (%s, %v, %q), want (%s, %v, %q)",
				typeOf, index, got.Name, got.Type, got.Tag, want.name, want.typeOf, want.tag)
		}
	}
}

func assertPrivateFieldNames(t *testing.T, typeOf reflect.Type, expected []string) {
	t.Helper()
	if typeOf.NumField() != len(expected) {
		t.Fatalf("%s private field count = %d, want %d", typeOf, typeOf.NumField(), len(expected))
	}
	for index, name := range expected {
		field := typeOf.Field(index)
		if field.Name != name || field.PkgPath == "" {
			t.Errorf("%s private field %d = %+v, want unexported %s", typeOf, index, field, name)
		}
	}
}
