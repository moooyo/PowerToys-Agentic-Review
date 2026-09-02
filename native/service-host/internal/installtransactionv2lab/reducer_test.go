package installtransactionv2lab

import (
	"reflect"
	"testing"
)

func TestBlockedRecordsNeverPublishAnSCMIntent(t *testing.T) {
	records := []TransactionRecord{
		testPlanRecord(ModeUpgrade, PhaseQuiesced, PlanSCMMaintenance, 0, false),
		testPlanRecord(ModeUpgrade, PhaseSCMMaintenanceFenced, PlanStopServices, 0, false),
		testPlanRecord(ModeInitial, PhaseServiceConfigurationProgress, PlanInitialServiceCreation, 0, false),
		testPlanRecord(ModeInitial, PhaseServicesConfigured, PlanStartCandidateServices, 0, false),
		testCandidateFinalBlockedRecord(),
		testPreviousFinalBlockedRecord(),
	}
	for _, record := range records {
		result, err := nextReduction(record)
		if err != nil || result.disposition != reductionBlocked || result.blocked == nil ||
			!blockedCheckpointsEqual(result.blocked, record.BlockedCheckpoint) || result.next != (TransactionRecord{}) ||
			result.retry != nil {
			t.Fatalf("%s reduction = (%+v, %v)", record.ActionPlan, result, err)
		}
		result.blocked.MissingPrerequisites[0] = BlockedCandidateFinalPolicy
		if reflect.DeepEqual(result.blocked.MissingPrerequisites,
			record.BlockedCheckpoint.MissingPrerequisites) {
			t.Fatal("blocked reduction aliases the record prerequisite slice")
		}
	}
}

func TestFilesystemReducerRetainsWriteAheadOrdering(t *testing.T) {
	record := testMaterializeRecord(1, false)
	result, err := nextReduction(record)
	if err != nil || result.disposition != reductionPublishNextRecord || result.next.PendingAction == nil {
		t.Fatalf("nextReduction = (%+v, %v)", result, err)
	}
	if result.next.RecordSequence != "3" || result.next.CompletedActionOrdinal != 1 ||
		result.next.PendingAction.ActionOrdinal() != 2 {
		t.Fatalf("published record = %+v", result.next)
	}
	if record.PendingAction != nil || record.RecordSequence != "2" {
		t.Fatal("nextReduction mutated its input")
	}
}

func TestSCMObservationBindingIncludesTransactionAndRecordDigest(t *testing.T) {
	record := testFullRecord(ModeUpgrade, PhaseSCMMaintenanceFenced)
	record.ActionPlan = PlanStopServices
	record.PendingAction, _ = expectedAction(record, record.ActionPlan, 1)
	digest, err := canonicalRecordPayloadDigest(record)
	if err != nil {
		t.Fatal(err)
	}
	observation := scmActionObservation{
		actionKind:     record.PendingAction.Kind(),
		ordinal:        record.PendingAction.ActionOrdinal(),
		plan:           record.ActionPlan,
		recordSHA256:   digest,
		recordSequence: record.RecordSequence,
		state:          scmObservationExactBefore,
		transactionID:  record.TransactionID,
	}
	if got := classifySCMObservation(record, record.PendingAction, observation); got != scmClassificationExactBefore {
		t.Fatalf("exact binding classification = %v", got)
	}

	mutations := []struct {
		name   string
		mutate func(*scmActionObservation)
	}{
		{name: "transaction", mutate: func(value *scmActionObservation) {
			value.transactionID = "123e4567-e89b-42d3-a456-426614174001"
		}},
		{name: "record digest", mutate: func(value *scmActionObservation) {
			value.recordSHA256 = SHA256("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
		}},
		{name: "sequence", mutate: func(value *scmActionObservation) { value.recordSequence = "21" }},
		{name: "plan", mutate: func(value *scmActionObservation) { value.plan = PlanSCMMaintenance }},
		{name: "ordinal", mutate: func(value *scmActionObservation) { value.ordinal = 2 }},
		{name: "kind", mutate: func(value *scmActionObservation) { value.actionKind = ActionStopExecutor }},
	}
	for _, test := range mutations {
		t.Run(test.name, func(t *testing.T) {
			mutated := observation
			test.mutate(&mutated)
			if got := classifySCMObservation(record, record.PendingAction, mutated); got != scmClassificationUnproved {
				t.Fatalf("mismatched observation classification = %v", got)
			}
		})
	}

	plain := record.PendingAction.(SCMAction)
	wrongRole := plain
	wrongRole.Role = RoleExecutor
	wrongContract := plain
	wrongContract.PolicyContractID = "other-contract"
	var typedNil *SCMAction
	for _, mismatched := range []PendingAction{nil, typedNil, &plain, wrongRole, wrongContract} {
		if got := classifySCMObservation(record, mismatched, observation); got != scmClassificationUnproved {
			t.Fatalf("mismatched action %#v classification = %v", mismatched, got)
		}
	}
	filesystemRecord := testMaterializeRecord(0, true)
	filesystemDigest, err := canonicalRecordPayloadDigest(filesystemRecord)
	if err != nil {
		t.Fatal(err)
	}
	filesystemObservation := scmActionObservation{
		actionKind:     filesystemRecord.PendingAction.Kind(),
		ordinal:        filesystemRecord.PendingAction.ActionOrdinal(),
		plan:           filesystemRecord.ActionPlan,
		recordSHA256:   filesystemDigest,
		recordSequence: filesystemRecord.RecordSequence,
		state:          scmObservationExactTarget,
		transactionID:  filesystemRecord.TransactionID,
	}
	if got := classifySCMObservation(
		filesystemRecord, filesystemRecord.PendingAction, filesystemObservation,
	); got != scmClassificationUnproved {
		t.Fatalf("filesystem action SCM classification = %v", got)
	}

	startRecord := testFullRecord(ModeUpgrade, PhaseServicesConfigured)
	startRecord.ActionPlan = PlanStartCandidateServices
	startRecord.PendingAction, _ = expectedAction(startRecord, startRecord.ActionPlan, 1)
	startDigest, err := canonicalRecordPayloadDigest(startRecord)
	if err != nil {
		t.Fatal(err)
	}
	startObservation := scmActionObservation{
		actionKind:     ActionStartExecutor,
		ordinal:        1,
		plan:           startRecord.ActionPlan,
		recordSHA256:   startDigest,
		recordSequence: startRecord.RecordSequence,
		state:          scmObservationExactBefore,
		transactionID:  startRecord.TransactionID,
	}
	driftedStart := startRecord.PendingAction.(SCMGenerationAction)
	driftedStart.TargetGeneration = GenerationPrevious
	if got := classifySCMObservation(startRecord, driftedStart, startObservation); got != scmClassificationUnproved {
		t.Fatalf("target-generation drift classification = %v", got)
	}
}

func TestSCMObservationStatesHaveConservativeRecoveryMeaning(t *testing.T) {
	record := testFullRecord(ModeUpgrade, PhaseSCMMaintenanceFenced)
	record.ActionPlan = PlanStopServices
	record.PendingAction, _ = expectedAction(record, record.ActionPlan, 1)
	digest, err := canonicalRecordPayloadDigest(record)
	if err != nil {
		t.Fatal(err)
	}
	base := scmActionObservation{
		actionKind:     record.PendingAction.Kind(),
		ordinal:        1,
		plan:           record.ActionPlan,
		recordSHA256:   digest,
		recordSequence: record.RecordSequence,
		transactionID:  record.TransactionID,
	}
	for _, test := range []struct {
		state scmObservationState
		want  scmObservationClassification
	}{
		{scmObservationExactBefore, scmClassificationExactBefore},
		{scmObservationExactTarget, scmClassificationExactTarget},
		{scmObservationUnproved, scmClassificationUnproved},
		{scmObservationUnknown, scmClassificationUnproved},
	} {
		observation := base
		observation.state = test.state
		if got := classifySCMObservation(record, record.PendingAction, observation); got != test.want {
			t.Errorf("state %d classification=%d, want %d", test.state, got, test.want)
		}
	}
}

func TestIdleObservationRequiresPhaseTransitionEvidence(t *testing.T) {
	record := testFullRecord(ModeInitial, PhaseDestinationVerified)
	result, err := reduceObservation(record, nil)
	if err != nil || result.disposition != reductionAcquireExternalEvidence ||
		result.requirement != evidenceRequirementPhaseTransition {
		t.Fatalf("idle observation reduction = (%+v, %v)", result, err)
	}
}

func TestFailedClosedIsReducerTerminal(t *testing.T) {
	failure := FailureJournalCorrupt
	record := testFullRecord(ModeInitial, PhaseFailedClosed)
	record.FailureCode = &failure
	result, err := nextReduction(record)
	if err != nil || result.disposition != reductionTerminal {
		t.Fatalf("failed-closed reduction = (%+v, %v)", result, err)
	}
}
