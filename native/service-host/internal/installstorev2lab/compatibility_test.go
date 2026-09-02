package installstorev2lab

import (
	"bytes"
	"strings"
	"testing"

	v1 "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installtransaction"
	recordv2 "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installtransactionv2lab"
)

func TestV1AndV2HeadDocumentsRejectEachOther(t *testing.T) {
	if TransactionsRootPath != v1.TransactionsRoot || WriterLockPath != v1.WriterLockPath ||
		ActiveHeadPath != v1.ActiveHeadPath || ActiveHeadTemporaryPath != v1.ActiveHeadTemporaryPath {
		t.Fatalf("store fixed ownership paths drifted from v1: %q %q %q %q",
			TransactionsRootPath, WriterLockPath, ActiveHeadPath, ActiveHeadTemporaryPath)
	}
	if MaximumNestedRecordBytes != recordv2.MaximumTransactionRecordBytes {
		t.Fatalf("nested record limit = %d, want ADR 0020 limit %d",
			MaximumNestedRecordBytes, recordv2.MaximumTransactionRecordBytes)
	}
	v1Document, err := v1.MarshalActiveHead(v1.ActiveHead{TransactionID: v1.TransactionID(testTransactionID)})
	if err != nil {
		t.Fatal(err)
	}
	v2Document, err := MarshalHeadDocument(testHead())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseHeadDocument(v1Document); err == nil {
		t.Fatal("v2 head parser accepted a canonical v1 head")
	}
	if _, err := v1.ParseActiveHead(v2Document); err == nil {
		t.Fatal("v1 head parser accepted a canonical v2 head")
	}
}

func TestEntryParserRejectsCanonicalV1RecordAsNestedDocument(t *testing.T) {
	v1Record := v1.TransactionRecord{
		ActionPlan:            v1.PlanNone,
		ActivationPolicyState: v1.ActivationNotApplicable,
		Candidate: v1.CandidateGeneration{
			PackageID:         "worker-package-next",
			ReleaseID:         "worker-2026.09.03.1",
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
	payload, err := marshalCanonicalValue(entryWire{
		PredecessorDocument: []byte("null"),
		PreviousEntrySHA256: nil,
		RecordDocument:      v1Document,
	}, MaximumEntryDocumentBytes)
	if err != nil {
		t.Fatal(err)
	}
	document, err := marshalCanonicalValue(entryDocumentWire{
		Entry: payload, EntrySHA256: digestCanonical(entryDigestDomain, payload), SchemaVersion: SchemaVersion,
	}, MaximumEntryDocumentBytes)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseEntryDocument(document); err == nil {
		t.Fatal("entry parser accepted a canonical v1 record as TransactionDocumentV2")
	}
	if _, err := v1.ParseRecord(document); err == nil {
		t.Fatal("v1 record parser accepted a v2 WAL entry")
	}
	versionOnly := bytes.Replace(document, []byte(`"schemaVersion":2`), []byte(`"schemaVersion":1`), 1)
	if _, err := ParseEntryDocument(versionOnly); err == nil {
		t.Fatal("entry parser accepted a relabeled schema-v1 outer document")
	}
}
