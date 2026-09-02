package installtransactionv2lab

import (
	"reflect"
	"testing"
)

func TestValidClosedStateMatrix(t *testing.T) {
	failure := FailureSCMUnproved
	failed := testFullRecord(ModeUpgrade, PhaseFailedClosed)
	failed.FailureCode = &failure
	records := []TransactionRecord{
		testStagingRecord(ModeInitial),
		testStagingRecord(ModeUpgrade),
		testMaterializeRecord(0, true),
		testMaterializeRecord(1, false),
		testPlanRecord(ModeInitial, PhaseRootSwapInProgress, PlanInitialForward, 0, true),
		testPlanRecord(ModeUpgrade, PhaseRootSwapInProgress, PlanUpgradeForward, 0, true),
		testPlanRecord(ModeUpgrade, PhaseQuiesced, PlanSCMMaintenance, 0, false),
		testPlanRecord(ModeInitial, PhaseServiceConfigurationProgress, PlanInitialServiceCreation, 0, false),
		testPlanRecord(ModeInitial, PhaseServicesConfigured, PlanStartCandidateServices, 0, false),
		testPlanRecord(ModeUpgrade, PhaseSCMMaintenanceFenced, PlanStopServices, 0, false),
		testCandidateFinalBlockedRecord(),
		testPreviousFinalBlockedRecord(),
		failed,
	}
	for index, record := range records {
		if err := ValidateRecord(record); err != nil {
			t.Errorf("record %d rejected: %v", index, err)
		}
	}
}

func TestSuccessPhasesAndAppliedActivationDoNotExistInAcceptedGraph(t *testing.T) {
	record := testFullRecord(ModeInitial, Phase("COMMITTED"))
	if err := ValidateRecord(record); err == nil {
		t.Fatal("validator accepted COMMITTED")
	}
	record.Phase = Phase("ROLLED_BACK")
	if err := ValidateRecord(record); err == nil {
		t.Fatal("validator accepted ROLLED_BACK")
	}
	record = testCandidateFinalBlockedRecord()
	record.ActivationPolicyState = ActivationPolicyState("applied")
	if err := ValidateRecord(record); err == nil {
		t.Fatal("validator accepted applied activation")
	}
}

func TestBlockedCheckpointIsUniquelyDerived(t *testing.T) {
	record := testPlanRecord(ModeUpgrade, PhaseQuiesced, PlanSCMMaintenance, 0, false)
	want, err := derivedBlockedCheckpoint(record)
	if err != nil || want == nil || !blockedCheckpointsEqual(record.BlockedCheckpoint, want) {
		t.Fatalf("derived blocker = (%+v, %v), want %+v", want, err, record.BlockedCheckpoint)
	}
	mutations := []struct {
		name   string
		mutate func(*TransactionRecord)
	}{
		{name: "missing", mutate: func(value *TransactionRecord) { value.BlockedCheckpoint = nil }},
		{name: "wrong kind", mutate: func(value *TransactionRecord) { value.BlockedCheckpoint.ActionKind = ActionStopControl }},
		{name: "wrong ordinal", mutate: func(value *TransactionRecord) { value.BlockedCheckpoint.Ordinal = 2 }},
		{name: "wrong plan", mutate: func(value *TransactionRecord) { value.BlockedCheckpoint.Plan = PlanStopServices }},
		{name: "missing prerequisite", mutate: func(value *TransactionRecord) {
			value.BlockedCheckpoint.MissingPrerequisites = value.BlockedCheckpoint.MissingPrerequisites[1:]
		}},
		{name: "reordered prerequisites", mutate: func(value *TransactionRecord) {
			values := value.BlockedCheckpoint.MissingPrerequisites
			values[0], values[1] = values[1], values[0]
		}},
		{name: "duplicate prerequisite", mutate: func(value *TransactionRecord) {
			value.BlockedCheckpoint.MissingPrerequisites = append(
				value.BlockedCheckpoint.MissingPrerequisites,
				value.BlockedCheckpoint.MissingPrerequisites[0],
			)
		}},
	}
	for _, test := range mutations {
		t.Run(test.name, func(t *testing.T) {
			mutated := cloneTestRecord(record)
			test.mutate(&mutated)
			if err := ValidateRecord(mutated); err == nil {
				t.Fatal("validator accepted caller-selected blocker")
			}
		})
	}
}

func TestEverySCMPlanStopsBeforePublishingOrdinalOne(t *testing.T) {
	records := []TransactionRecord{
		testPlanRecord(ModeUpgrade, PhaseQuiesced, PlanSCMMaintenance, 0, false),
		testPlanRecord(ModeUpgrade, PhaseSCMMaintenanceFenced, PlanStopServices, 0, false),
		testPlanRecord(ModeInitial, PhaseServiceConfigurationProgress, PlanInitialServiceCreation, 0, false),
		testPlanRecord(ModeInitial, PhaseServicesConfigured, PlanStartCandidateServices, 0, false),
	}
	previousStart := testPlanRecord(ModeUpgrade, PhaseRollbackInProgress, PlanStartPreviousServices, 0, false)
	previousStart.RollbackCheckpoint = RollbackRootsRestored
	previousStart.BlockedCheckpoint, _ = derivedBlockedCheckpoint(previousStart)
	records = append(records, previousStart)

	for _, record := range records {
		if err := ValidateRecord(record); err != nil {
			t.Fatalf("blocked plan %s rejected: %v", record.ActionPlan, err)
		}
		action, err := expectedAction(record, record.ActionPlan, 1)
		if err != nil {
			t.Fatal(err)
		}
		mutated := cloneTestRecord(record)
		mutated.PendingAction = action
		mutated.BlockedCheckpoint = nil
		if err := ValidateRecord(mutated); err == nil {
			t.Fatalf("validator accepted pending SCM action for %s", record.ActionPlan)
		}
		mutated = cloneTestRecord(record)
		mutated.CompletedActionOrdinal = 1
		mutated.BlockedCheckpoint = nil
		if err := ValidateRecord(mutated); err == nil {
			t.Fatalf("validator accepted a cursor beyond blocked ordinal for %s", record.ActionPlan)
		}
	}
}

func TestBlockedPrerequisiteSetsCoverEveryDeferredBoundary(t *testing.T) {
	tests := []struct {
		record TransactionRecord
		want   []BlockedReason
	}{
		{testPlanRecord(ModeUpgrade, PhaseQuiesced, PlanSCMMaintenance, 0, false), []BlockedReason{
			BlockedDurableStore, BlockedNativeAdapter, BlockedPreferredNodeReadback,
			BlockedFailureActionsClearABI,
		}},
		{testPlanRecord(ModeUpgrade, PhaseSCMMaintenanceFenced, PlanStopServices, 0, false), []BlockedReason{
			BlockedDurableStore, BlockedNativeAdapter, BlockedPreferredNodeReadback,
			BlockedStopProcessTreeEvidence,
		}},
		{testPlanRecord(ModeInitial, PhaseServiceConfigurationProgress, PlanInitialServiceCreation, 0, false), []BlockedReason{
			BlockedDurableStore, BlockedNativeAdapter, BlockedPreferredNodeReadback,
			BlockedCreateIntermediateEvidence, BlockedFailureActionsClearABI, BlockedPreshutdownContract,
		}},
		{testPlanRecord(ModeInitial, PhaseServicesConfigured, PlanStartCandidateServices, 0, false), []BlockedReason{
			BlockedDurableStore, BlockedNativeAdapter, BlockedPreferredNodeReadback,
			BlockedStartReadinessEvidence,
		}},
		{testCandidateFinalBlockedRecord(), []BlockedReason{
			BlockedDurableStore, BlockedNativeAdapter, BlockedPreferredNodeReadback,
			BlockedCandidateFinalPolicy,
		}},
		{testPreviousFinalBlockedRecord(), []BlockedReason{
			BlockedDurableStore, BlockedNativeAdapter, BlockedPreferredNodeReadback,
			BlockedPreviousFinalPolicy,
		}},
	}
	for _, test := range tests {
		if !reflect.DeepEqual(test.record.BlockedCheckpoint.MissingPrerequisites, test.want) {
			t.Errorf("%s blockers = %v, want %v", test.record.ActionPlan,
				test.record.BlockedCheckpoint.MissingPrerequisites, test.want)
		}
	}
}

func TestFailedClosedIsTheOnlyTerminalShape(t *testing.T) {
	failure := FailureJournalCorrupt
	record := testFullRecord(ModeInitial, PhaseFailedClosed)
	record.FailureCode = &failure
	if err := ValidateRecord(record); err != nil {
		t.Fatal(err)
	}
	record.ActionPlan = PlanCandidateFinalPolicyBlocked
	record.ActivationPolicyState = ActivationBlocked
	record.BlockedCheckpoint, _ = derivedBlockedCheckpoint(record)
	if err := ValidateRecord(record); err == nil {
		t.Fatal("FAILED_CLOSED retained a blocked action plan")
	}
}
