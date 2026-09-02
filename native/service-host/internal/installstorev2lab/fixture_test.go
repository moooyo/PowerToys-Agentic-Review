package installstorev2lab

import (
	"fmt"
	"strings"

	recordv2 "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installtransactionv2lab"
)

const (
	testTransactionID          = TransactionID("123e4567-e89b-42d3-a456-426614174000")
	testPredecessorTransaction = TransactionID("223e4567-e89b-42d3-a456-426614174001")
)

func testRecord(sequence string) recordv2.TransactionRecord {
	record := recordv2.TransactionRecord{
		ActionPlan:            recordv2.PlanNone,
		ActivationPolicyState: recordv2.ActivationNotApplicable,
		BlockedCheckpoint:     nil,
		Candidate: recordv2.CandidateGeneration{
			PackageID:         "worker-package-next",
			ReleaseID:         "worker-2026.09.03.1",
			Roots:             nil,
			SignedIndexSHA256: recordv2.SHA256(strings.Repeat("8", 64)),
		},
		CompletedActionOrdinal: 0,
		FailureCode:            nil,
		InstallationID:         "installation-node-001",
		Mode:                   recordv2.ModeInitial,
		PendingAction:          nil,
		Phase:                  recordv2.PhaseStagingVerified,
		SCMPolicyContractID:    recordv2.SCMPolicyContractIdentifier,
		Previous:               nil,
		RecordSequence:         recordv2.DecimalUint64(sequence),
		RollbackCheckpoint:     recordv2.RollbackNotApplicable,
		TargetArchitecture:     recordv2.ArchitectureAMD64,
		TransactionID:          recordv2.TransactionID(testTransactionID),
		WorkerNodeID:           "powertoys-node:01",
	}
	if sequence != "1" {
		record.ActionPlan = recordv2.PlanMaterializeInactive
		record.PendingAction = recordv2.CreateCandidateAction{
			ActionKind: recordv2.ActionCreateCandidateRoot,
			Direction:  recordv2.DirectionForward,
			Ordinal:    1,
			ToSlot:     recordv2.SlotMetadataCandidate,
		}
	}
	return record
}

func testHead() Head {
	return Head{
		EntrySHA256:    SHA256(strings.Repeat("a", 64)),
		RecordSequence: "1",
		TransactionID:  testTransactionID,
	}
}

func testPredecessor() Predecessor {
	return Predecessor{
		HeadDocumentSHA256:   SHA256(strings.Repeat("1", 64)),
		InventorySHA256:      SHA256(strings.Repeat("2", 64)),
		RecordDocumentSHA256: SHA256(strings.Repeat("3", 64)),
		RecordSequence:       "9",
		SourceSchemaVersion:  1,
		TransactionID:        testPredecessorTransaction,
	}
}

func testInventoryEntry(index int) V1InventoryEntry {
	disposition := TerminalCommittedApplied
	if index%2 != 0 {
		disposition = TerminalRolledBackApplied
	}
	return V1InventoryEntry{
		RecordDocumentSHA256: SHA256(fmt.Sprintf("%064x", index+1)),
		RecordSequence:       DecimalUint64(fmt.Sprintf("%d", index+1)),
		TerminalDisposition:  disposition,
		TransactionID:        TransactionID(fmt.Sprintf("00000000-0000-4000-8000-%012x", index+1)),
	}
}
