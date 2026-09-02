package installtransaction

import (
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"testing"
)

func TestNextReductionPublishesOnlyDeterministicInPlanIntent(t *testing.T) {
	tests := []struct {
		name   string
		record TransactionRecord
	}{
		{name: "materialize", record: testMaterializeRecord(1, false)},
		{name: "initial forward", record: testPlanRecord(ModeInitial, PhaseRootSwapInProgress, PlanInitialForward, 1, false)},
		{name: "upgrade forward", record: testPlanRecord(ModeUpgrade, PhaseRootSwapInProgress, PlanUpgradeForward, 1, false)},
		{name: "upgrade rollback", record: testPlanRecord(ModeUpgrade, PhaseRollbackInProgress, PlanUpgradeRollback, 1, false)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			before := cloneTestRecord(test.record)
			wantAction, err := expectedAction(test.record, test.record.ActionPlan, test.record.CompletedActionOrdinal+1)
			if err != nil {
				t.Fatal(err)
			}
			got, err := nextReduction(test.record)
			if err != nil {
				t.Fatal(err)
			}
			requireReductionDisposition(t, got, reductionPublishNextRecord)
			if got.next.RecordSequence != incrementedForTest(t, test.record.RecordSequence) ||
				got.next.CompletedActionOrdinal != test.record.CompletedActionOrdinal ||
				got.next.ActionPlan != test.record.ActionPlan ||
				!pendingActionsEqual(got.next.PendingAction, wantAction) {
				t.Fatalf("next reduction = %#v, want the next in-plan intent", got.next)
			}
			if !reflect.DeepEqual(test.record, before) {
				t.Fatal("nextReduction mutated its input")
			}
		})
	}
}

func TestNextReductionKeepsExternalPhaseAndPolicyGatesClosed(t *testing.T) {
	rollback := testFullRecord(ModeUpgrade, PhaseRollbackInProgress)
	rollback.RollbackCheckpoint = RollbackRootsRestored
	policy := policyRecordForTest(PlanCandidateActivationPolicy, 1, false)
	rollbackPolicy := policyRecordForTest(PlanRollbackActivationPolicy, 1, false)
	tests := []struct {
		name        string
		record      TransactionRecord
		requirement evidenceRequirement
	}{
		{name: "staging entry", record: testStagingRecord(ModeInitial), requirement: evidenceRequirementPhaseTransition},
		{name: "quiesce", record: testFullRecord(ModeInitial, PhaseInactivePackageVerified), requirement: evidenceRequirementPhaseTransition},
		{name: "maintenance fence", record: testFullRecord(ModeInitial, PhaseQuiesced), requirement: evidenceRequirementPhaseTransition},
		{name: "stop services", record: testFullRecord(ModeInitial, PhaseSCMMaintenanceFenced), requirement: evidenceRequirementPhaseTransition},
		{name: "root plan entry", record: testFullRecord(ModeInitial, PhaseServicesStopped), requirement: evidenceRequirementPhaseTransition},
		{name: "destination", record: testFullRecord(ModeInitial, PhaseRootSwapInProgress), requirement: evidenceRequirementPhaseTransition},
		{name: "executor start", record: testFullRecord(ModeInitial, PhaseDestinationVerified), requirement: evidenceRequirementPhaseTransition},
		{name: "control start", record: testFullRecord(ModeInitial, PhaseExecutorStarted), requirement: evidenceRequirementPhaseTransition},
		{name: "disabled readiness", record: testFullRecord(ModeInitial, PhaseControlStarted), requirement: evidenceRequirementPhaseTransition},
		{name: "commit", record: testFullRecord(ModeInitial, PhaseAuthenticatedDisabledReady), requirement: evidenceRequirementPhaseTransition},
		{name: "rollback restart", record: rollback, requirement: evidenceRequirementPhaseTransition},
		{name: "candidate policy", record: policy, requirement: evidenceRequirementSCMPolicyContract},
		{name: "rollback policy", record: rollbackPolicy, requirement: evidenceRequirementSCMPolicyContract},
		{name: "pending action", record: testMaterializeRecord(0, true), requirement: evidenceRequirementPendingAction},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := nextReduction(test.record)
			if err != nil {
				t.Fatal(err)
			}
			requireReductionDisposition(t, got, reductionAcquireExternalEvidence)
			if got.requirement != test.requirement || got.next != (TransactionRecord{}) || got.retry != nil {
				t.Fatalf("gate reduction = %#v, want requirement %d", got, test.requirement)
			}
		})
	}
}

func TestTerminalRecordsAbsorbEveryObservation(t *testing.T) {
	committed := testFullRecord(ModeInitial, PhaseCommitted)
	committed.ActivationPolicyState = ActivationApplied
	rolledBack := testFullRecord(ModeUpgrade, PhaseRolledBack)
	rolledBack.ActivationPolicyState = ActivationApplied
	rolledBack.RollbackCheckpoint = RollbackAuthenticatedDisabledReady
	failed := testFullRecord(ModeInitial, PhaseFailedClosed)
	failure := FailureRevalidationFailed
	failed.FailureCode = &failure
	observations := []actionObservation{
		createCandidateObservation{state: candidateCreationVerified, root: testRoot('9')},
		populateCandidateObservation{state: candidatePopulationVerified, root: testRoot('9')},
		renameObservation{},
	}
	for _, record := range []TransactionRecord{committed, rolledBack, failed} {
		for _, observation := range observations {
			got, err := reduceObservation(record, observation)
			if err != nil {
				t.Fatal(err)
			}
			requireReductionDisposition(t, got, reductionTerminal)
		}
		got, err := nextReduction(record)
		if err != nil {
			t.Fatal(err)
		}
		requireReductionDisposition(t, got, reductionTerminal)
	}
}

func TestCreateObservationRecordsOnlyTheExpectedFreshIdentity(t *testing.T) {
	tests := []struct {
		name    string
		cursor  ActionOrdinal
		slot    CandidateRootSlot
		root    RootIdentity
		ordinal ActionOrdinal
	}{
		{name: "metadata", cursor: 0, slot: SlotMetadataCandidate, root: testRoot('2'), ordinal: 1},
		{name: "installation", cursor: 2, slot: SlotInstallationCandidate, root: testRoot('1'), ordinal: 3},
		{name: "trusted configuration", cursor: 4, slot: SlotTrustedConfigurationCandidate, root: testRoot('3'), ordinal: 5},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			record := testMaterializeRecord(test.cursor, true)
			before := cloneTestRecord(record)
			got, err := reduceObservation(record, createCandidateObservation{
				state: candidateCreationVerified,
				root:  test.root,
			})
			if err != nil {
				t.Fatal(err)
			}
			requireReductionDisposition(t, got, reductionPublishNextRecord)
			if got.next.CompletedActionOrdinal != test.ordinal || got.next.PendingAction != nil ||
				got.next.RecordSequence != incrementedForTest(t, record.RecordSequence) {
				t.Fatalf("create completion = %#v", got.next)
			}
			root, ok := candidateRoot(got.next.Candidate.Roots, test.slot)
			if !ok || root != test.root {
				t.Fatalf("created root = (%#v, %v), want %#v", root, ok, test.root)
			}
			if !reflect.DeepEqual(record, before) {
				t.Fatal("create reduction mutated its input")
			}
		})
	}
}

func TestCreateObservationRetriesOrFailsClosedWithoutPublishing(t *testing.T) {
	record := testMaterializeRecord(0, true)
	retry, err := reduceObservation(record, createCandidateObservation{state: candidateCreationAbsent})
	if err != nil {
		t.Fatal(err)
	}
	requireReductionDisposition(t, retry, reductionRetryEffect)
	if !pendingActionsEqual(retry.retry, record.PendingAction) || retry.next != (TransactionRecord{}) {
		t.Fatalf("retry = %#v", retry)
	}

	ambiguous, err := reduceObservation(record, createCandidateObservation{state: candidateCreationAmbiguous})
	if err != nil {
		t.Fatal(err)
	}
	requireOutOfBandFailure(t, ambiguous, FailureRootIdentityAmbiguous)

	duplicateRecord := testMaterializeRecord(2, true)
	duplicate, err := reduceObservation(duplicateRecord, createCandidateObservation{
		state: candidateCreationVerified,
		root:  testRoot('2'),
	})
	if err != nil {
		t.Fatal(err)
	}
	requireOutOfBandFailure(t, duplicate, FailureRootIdentityAmbiguous)

	wrongVolume := testRoot('1')
	wrongVolume.VolumeSerialNumber = "987654321"
	volumeRecord := testMaterializeRecord(2, true)
	volume, err := reduceObservation(volumeRecord, createCandidateObservation{
		state: candidateCreationVerified,
		root:  wrongVolume,
	})
	if err != nil {
		t.Fatal(err)
	}
	requireOutOfBandFailure(t, volume, FailureRootIdentityAmbiguous)
}

func TestPopulateObservationCompletesEveryMaterializationOrdinal(t *testing.T) {
	tests := []struct {
		cursor       ActionOrdinal
		resultCursor ActionOrdinal
		resultPhase  Phase
		resultPlan   ActionPlan
	}{
		{cursor: 1, resultCursor: 2, resultPhase: PhaseStagingVerified, resultPlan: PlanMaterializeInactive},
		{cursor: 3, resultCursor: 4, resultPhase: PhaseStagingVerified, resultPlan: PlanMaterializeInactive},
		{cursor: 5, resultCursor: 0, resultPhase: PhaseInactivePackageVerified, resultPlan: PlanNone},
	}
	for _, test := range tests {
		t.Run(fmt.Sprintf("ordinal-%d", test.cursor+1), func(t *testing.T) {
			record := testMaterializeRecord(test.cursor, true)
			action := record.PendingAction.(PopulateCandidateAction)
			before := cloneTestRecord(record)
			got, err := reduceObservation(record, populateCandidateObservation{
				state: candidatePopulationVerified,
				root:  action.ExpectedRoot,
			})
			if err != nil {
				t.Fatal(err)
			}
			requireReductionDisposition(t, got, reductionPublishNextRecord)
			if got.next.CompletedActionOrdinal != test.resultCursor || got.next.Phase != test.resultPhase ||
				got.next.ActionPlan != test.resultPlan || got.next.PendingAction != nil ||
				!sameCandidateRootSet(got.next.Candidate.Roots, record.Candidate.Roots) {
				t.Fatalf("populate completion = %#v", got.next)
			}
			if !reflect.DeepEqual(record, before) {
				t.Fatal("populate reduction mutated its input")
			}
		})
	}
}

func TestPopulateObservationRequiresTheRecordedIdentity(t *testing.T) {
	record := testMaterializeRecord(1, true)
	action := record.PendingAction.(PopulateCandidateAction)
	retry, err := reduceObservation(record, populateCandidateObservation{
		state: candidatePopulationRetryable,
		root:  action.ExpectedRoot,
	})
	if err != nil {
		t.Fatal(err)
	}
	requireReductionDisposition(t, retry, reductionRetryEffect)

	mismatch, err := reduceObservation(record, populateCandidateObservation{
		state: candidatePopulationVerified,
		root:  testRoot('9'),
	})
	if err != nil {
		t.Fatal(err)
	}
	requireOutOfBandFailure(t, mismatch, FailureRootIdentityAmbiguous)

	ambiguous, err := reduceObservation(record, populateCandidateObservation{state: candidatePopulationAmbiguous})
	if err != nil {
		t.Fatal(err)
	}
	requireOutOfBandFailure(t, ambiguous, FailureRevalidationFailed)
}

func TestRenameObservationCoversEveryFixedRootPlanOrdinal(t *testing.T) {
	plans := []struct {
		name  string
		mode  Mode
		phase Phase
		plan  ActionPlan
		last  ActionOrdinal
	}{
		{name: "initial forward", mode: ModeInitial, phase: PhaseRootSwapInProgress, plan: PlanInitialForward, last: 3},
		{name: "upgrade forward", mode: ModeUpgrade, phase: PhaseRootSwapInProgress, plan: PlanUpgradeForward, last: 5},
		{name: "upgrade rollback", mode: ModeUpgrade, phase: PhaseRollbackInProgress, plan: PlanUpgradeRollback, last: 4},
	}
	for _, plan := range plans {
		for ordinal := ActionOrdinal(1); ordinal <= plan.last; ordinal++ {
			t.Run(fmt.Sprintf("%s-%d", plan.name, ordinal), func(t *testing.T) {
				record := testPlanRecord(plan.mode, plan.phase, plan.plan, ordinal-1, true)
				action := record.PendingAction.(RenameAction)
				retry, err := reduceObservation(record, renameObservation{
					from:       presentRootObservation(action.ExpectedRoot),
					to:         absentRootObservation(),
					durability: renameDurabilityNotApplicable,
				})
				if err != nil {
					t.Fatal(err)
				}
				requireReductionDisposition(t, retry, reductionRetryEffect)
				if !pendingActionsEqual(retry.retry, record.PendingAction) {
					t.Fatal("rename retry changed the pending action")
				}

				completed, err := reduceObservation(record, renameObservation{
					from:       absentRootObservation(),
					to:         presentRootObservation(action.ExpectedRoot),
					durability: renameDurabilityProved,
				})
				if err != nil {
					t.Fatal(err)
				}
				if plan.plan == PlanUpgradeRollback && ordinal == plan.last {
					requireReductionDisposition(t, completed, reductionAcquireExternalEvidence)
					if completed.requirement != evidenceRequirementRollbackRoots {
						t.Fatalf("rollback final requirement = %d", completed.requirement)
					}
					return
				}
				requireReductionDisposition(t, completed, reductionPublishNextRecord)
				if completed.next.PendingAction != nil ||
					completed.next.RecordSequence != incrementedForTest(t, record.RecordSequence) {
					t.Fatalf("rename completion = %#v", completed.next)
				}
				if ordinal < plan.last {
					if completed.next.CompletedActionOrdinal != ordinal || completed.next.ActionPlan != plan.plan {
						t.Fatalf("non-final rename completion = %#v", completed.next)
					}
				} else if completed.next.CompletedActionOrdinal != 0 || completed.next.ActionPlan != PlanNone {
					t.Fatalf("final rename completion = %#v", completed.next)
				}
			})
		}
	}
}

func TestRenameObservationFailsClosedForEveryAmbiguousPlacement(t *testing.T) {
	record := testPlanRecord(ModeInitial, PhaseRootSwapInProgress, PlanInitialForward, 0, true)
	action := record.PendingAction.(RenameAction)
	other := testRoot('9')
	tests := []struct {
		name        string
		observation renameObservation
		failure     FailureCode
		wantError   bool
	}{
		{name: "both", observation: renameObservation{from: presentRootObservation(action.ExpectedRoot), to: presentRootObservation(action.ExpectedRoot), durability: renameDurabilityProved}, failure: FailureRootIdentityAmbiguous},
		{name: "neither", observation: renameObservation{from: absentRootObservation(), to: absentRootObservation(), durability: renameDurabilityNotApplicable}, failure: FailureRootIdentityAmbiguous},
		{name: "different source", observation: renameObservation{from: presentRootObservation(other), to: absentRootObservation(), durability: renameDurabilityNotApplicable}, failure: FailureRootIdentityAmbiguous},
		{name: "different destination", observation: renameObservation{from: absentRootObservation(), to: presentRootObservation(other), durability: renameDurabilityProved}, failure: FailureRootIdentityAmbiguous},
		{name: "source inaccessible", observation: renameObservation{from: rootSlotObservation{state: rootSlotInaccessible}, to: absentRootObservation(), durability: renameDurabilityNotApplicable}, failure: FailureRootIdentityAmbiguous},
		{name: "destination inaccessible", observation: renameObservation{from: absentRootObservation(), to: rootSlotObservation{state: rootSlotInaccessible}, durability: renameDurabilityProved}, failure: FailureRootIdentityAmbiguous},
		{name: "flush unproved", observation: renameObservation{from: absentRootObservation(), to: presentRootObservation(action.ExpectedRoot), durability: renameDurabilityUnproved}, failure: FailureDurabilityUnproved},
		{name: "missing flush proof", observation: renameObservation{from: absentRootObservation(), to: presentRootObservation(action.ExpectedRoot), durability: renameDurabilityNotApplicable}, failure: FailureDurabilityUnproved},
		{name: "invalid absent payload", observation: renameObservation{from: rootSlotObservation{state: rootSlotAbsent, root: other}, to: absentRootObservation(), durability: renameDurabilityNotApplicable}, failure: FailureRootIdentityAmbiguous, wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := reduceObservation(record, test.observation)
			if test.wantError != (err != nil) {
				t.Fatalf("error = %v, wantError=%v", err, test.wantError)
			}
			requireOutOfBandFailure(t, got, test.failure)
		})
	}
}

func TestPolicyActionsAlwaysRequireTheDeferredSCMPolicyContract(t *testing.T) {
	for _, plan := range []ActionPlan{PlanCandidateActivationPolicy, PlanRollbackActivationPolicy} {
		for ordinal := ActionOrdinal(1); ordinal <= 2; ordinal++ {
			t.Run(fmt.Sprintf("%s-%d", plan, ordinal), func(t *testing.T) {
				record := policyRecordForTest(plan, ordinal-1, true)
				before := cloneTestRecord(record)
				next, err := nextReduction(record)
				if err != nil {
					t.Fatal(err)
				}
				requireReductionDisposition(t, next, reductionAcquireExternalEvidence)
				if next.requirement != evidenceRequirementSCMPolicyContract {
					t.Fatalf("pending policy next requirement = %d", next.requirement)
				}
				for _, observation := range []actionObservation{
					nil,
					createCandidateObservation{state: candidateCreationAbsent},
					populateCandidateObservation{state: candidatePopulationAmbiguous},
					renameObservation{},
				} {
					got, err := reduceObservation(record, observation)
					if err != nil {
						t.Fatal(err)
					}
					requireReductionDisposition(t, got, reductionAcquireExternalEvidence)
					if got.requirement != evidenceRequirementSCMPolicyContract || got.next != (TransactionRecord{}) {
						t.Fatalf("policy reduction = %#v", got)
					}
				}
				direct, err := completePendingAction(record, "", RootIdentity{})
				if err != nil {
					t.Fatal(err)
				}
				requireReductionDisposition(t, direct, reductionAcquireExternalEvidence)
				if direct.requirement != evidenceRequirementSCMPolicyContract || !reflect.DeepEqual(record, before) {
					t.Fatal("policy action was completed or its input was mutated")
				}
			})
		}
	}
}

func TestSequenceOverflowNeverWrapsOrPublishes(t *testing.T) {
	const maximum = DecimalUint64("18446744073709551615")
	pending := testMaterializeRecord(0, true)
	pending.RecordSequence = maximum
	got, err := reduceObservation(pending, createCandidateObservation{
		state: candidateCreationVerified,
		root:  testRoot('2'),
	})
	if err != nil {
		t.Fatal(err)
	}
	requireOutOfBandFailure(t, got, FailureDurabilityUnproved)

	continuation := testMaterializeRecord(1, false)
	continuation.RecordSequence = maximum
	got, err = nextReduction(continuation)
	if err != nil {
		t.Fatal(err)
	}
	requireOutOfBandFailure(t, got, FailureDurabilityUnproved)
}

func TestReducerRejectsObservationTypeConfusionAndMalformedRecords(t *testing.T) {
	record := testMaterializeRecord(0, true)
	tests := []actionObservation{
		populateCandidateObservation{state: candidatePopulationVerified, root: testRoot('2')},
		renameObservation{},
		&createCandidateObservation{state: candidateCreationVerified, root: testRoot('2')},
	}
	for _, observation := range tests {
		got, err := reduceObservation(record, observation)
		if !errors.Is(err, ErrInvalid) {
			t.Fatalf("observation %T error = %v, want ErrInvalid", observation, err)
		}
		requireOutOfBandFailure(t, got, FailureRootIdentityAmbiguous)
	}

	invalid := testMaterializeRecord(0, true)
	invalid.WorkerNodeID = ""
	got, err := reduceObservation(invalid, createCandidateObservation{state: candidateCreationAbsent})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid record error = %v", err)
	}
	requireOutOfBandFailure(t, got, FailureJournalCorrupt)
}

func TestEveryActionRejectsEveryOtherObservationVariant(t *testing.T) {
	createRecord := testMaterializeRecord(0, true)
	populateRecord := testMaterializeRecord(1, true)
	renameRecord := testPlanRecord(ModeInitial, PhaseRootSwapInProgress, PlanInitialForward, 0, true)
	policyRecord := policyRecordForTest(PlanCandidateActivationPolicy, 0, true)
	populateAction := populateRecord.PendingAction.(PopulateCandidateAction)
	renameAction := renameRecord.PendingAction.(RenameAction)
	records := []TransactionRecord{createRecord, populateRecord, renameRecord, policyRecord}
	observations := []actionObservation{
		createCandidateObservation{state: candidateCreationAbsent},
		populateCandidateObservation{state: candidatePopulationRetryable, root: populateAction.ExpectedRoot},
		renameObservation{
			from:       presentRootObservation(renameAction.ExpectedRoot),
			to:         absentRootObservation(),
			durability: renameDurabilityNotApplicable,
		},
	}
	for recordIndex, record := range records {
		for observationIndex, observation := range observations {
			got, err := reduceObservation(record, observation)
			if recordIndex == len(records)-1 {
				if err != nil {
					t.Fatalf("policy pair %d returned %v", observationIndex, err)
				}
				requireReductionDisposition(t, got, reductionAcquireExternalEvidence)
				if got.requirement != evidenceRequirementSCMPolicyContract {
					t.Fatalf("policy pair requirement = %d", got.requirement)
				}
				continue
			}
			if recordIndex == observationIndex {
				if err != nil {
					t.Fatalf("matching pair %d returned %v", recordIndex, err)
				}
				requireReductionDisposition(t, got, reductionRetryEffect)
				continue
			}
			if !errors.Is(err, ErrInvalid) {
				t.Fatalf("pair %d/%d error = %v, want ErrInvalid", recordIndex, observationIndex, err)
			}
			requireReductionDisposition(t, got, reductionFailedClosedOutOfBand)
		}
	}
}

func TestSuccessorBindingRejectsEveryIdentityAndSequenceMutation(t *testing.T) {
	record := testMaterializeRecord(1, true)
	action := record.PendingAction.(PopulateCandidateAction)
	reduced, err := reduceObservation(record, populateCandidateObservation{
		state: candidatePopulationVerified,
		root:  action.ExpectedRoot,
	})
	if err != nil {
		t.Fatal(err)
	}
	baseline := reduced.next
	tests := []struct {
		name   string
		mutate func(*TransactionRecord)
	}{
		{name: "transaction", mutate: func(value *TransactionRecord) { value.TransactionID = "223e4567-e89b-42d3-a456-426614174000" }},
		{name: "installation", mutate: func(value *TransactionRecord) { value.InstallationID = "installation-node-002" }},
		{name: "worker", mutate: func(value *TransactionRecord) { value.WorkerNodeID = "powertoys-node:02" }},
		{name: "architecture", mutate: func(value *TransactionRecord) { value.TargetArchitecture = ArchitectureARM64 }},
		{name: "activation", mutate: func(value *TransactionRecord) { value.ActivationPolicyState = ActivationPending }},
		{name: "rollback checkpoint", mutate: func(value *TransactionRecord) { value.RollbackCheckpoint = RollbackRootsRestored }},
		{name: "failure code", mutate: func(value *TransactionRecord) { failure := FailureRevalidationFailed; value.FailureCode = &failure }},
		{name: "candidate package", mutate: func(value *TransactionRecord) { value.Candidate.PackageID = "worker-package-other" }},
		{name: "candidate release", mutate: func(value *TransactionRecord) { value.Candidate.ReleaseID = "worker-2026.09.02.2" }},
		{name: "candidate index", mutate: func(value *TransactionRecord) { value.Candidate.SignedIndexSHA256 = SHA256(repeatedForTest('9', 64)) }},
		{name: "existing root", mutate: func(value *TransactionRecord) { value.Candidate.Roots.Metadata = rootPointerForTest(testRoot('9')) }},
		{name: "same sequence", mutate: func(value *TransactionRecord) { value.RecordSequence = record.RecordSequence }},
		{name: "sequence gap", mutate: func(value *TransactionRecord) { value.RecordSequence = "4" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := cloneTransactionRecord(baseline)
			test.mutate(&value)
			if err := validateSuccessorBindings(record, value, "", RootIdentity{}); !errors.Is(err, ErrInvalid) {
				t.Fatalf("binding validation error = %v, want ErrInvalid", err)
			}
		})
	}

	upgrade := testPlanRecord(ModeUpgrade, PhaseRootSwapInProgress, PlanUpgradeForward, 0, true)
	rename := upgrade.PendingAction.(RenameAction)
	upgradeResult, err := reduceObservation(upgrade, renameObservation{
		from:       absentRootObservation(),
		to:         presentRootObservation(rename.ExpectedRoot),
		durability: renameDurabilityProved,
	})
	if err != nil {
		t.Fatal(err)
	}
	mutated := cloneTransactionRecord(upgradeResult.next)
	mutated.Previous.PackageID = "other-previous"
	if err := validateSuccessorBindings(upgrade, mutated, "", RootIdentity{}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("previous generation mutation error = %v", err)
	}
}

func TestReducerOutputsDoNotAliasRecordStorage(t *testing.T) {
	record := testMaterializeRecord(2, true)
	before := cloneTestRecord(record)
	created, err := reduceObservation(record, createCandidateObservation{
		state: candidateCreationVerified,
		root:  testRoot('1'),
	})
	if err != nil {
		t.Fatal(err)
	}
	created.next.Candidate.Roots.Metadata.FileID = FileID(repeatedForTest('9', 32))
	created.next.Candidate.Roots.Installation.FileID = FileID(repeatedForTest('8', 32))
	if !reflect.DeepEqual(record, before) {
		t.Fatal("mutating the successor changed the input record")
	}

	upgrade := testPlanRecord(ModeUpgrade, PhaseRootSwapInProgress, PlanUpgradeForward, 0, true)
	action := upgrade.PendingAction.(RenameAction)
	result, err := reduceObservation(upgrade, renameObservation{
		from:       absentRootObservation(),
		to:         presentRootObservation(action.ExpectedRoot),
		durability: renameDurabilityProved,
	})
	if err != nil {
		t.Fatal(err)
	}
	previousPackage := upgrade.Previous.PackageID
	result.next.Previous.PackageID = "mutated-previous"
	if upgrade.Previous.PackageID != previousPackage {
		t.Fatal("successor aliases the previous-generation pointer")
	}
}

func policyRecordForTest(plan ActionPlan, cursor ActionOrdinal, pending bool) TransactionRecord {
	if plan == PlanCandidateActivationPolicy {
		record := testPlanRecord(ModeInitial, PhaseCommitted, plan, cursor, pending)
		record.ActivationPolicyState = ActivationPending
		return record
	}
	record := testPlanRecord(ModeUpgrade, PhaseRollbackInProgress, plan, cursor, pending)
	record.ActivationPolicyState = ActivationPending
	record.RollbackCheckpoint = RollbackAuthenticatedDisabledReady
	return record
}

func presentRootObservation(root RootIdentity) rootSlotObservation {
	return rootSlotObservation{state: rootSlotPresent, root: root}
}

func absentRootObservation() rootSlotObservation {
	return rootSlotObservation{state: rootSlotAbsent}
}

func incrementedForTest(t *testing.T, value DecimalUint64) DecimalUint64 {
	t.Helper()
	parsed, err := strconv.ParseUint(string(value), 10, 64)
	if err != nil || parsed == ^uint64(0) {
		t.Fatalf("cannot increment test sequence %q", value)
	}
	return DecimalUint64(strconv.FormatUint(parsed+1, 10))
}

func requireReductionDisposition(t *testing.T, got reduction, want reductionDisposition) {
	t.Helper()
	if got.disposition != want {
		t.Fatalf("reduction disposition = %d, want %d: %#v", got.disposition, want, got)
	}
}

func requireOutOfBandFailure(t *testing.T, got reduction, want FailureCode) {
	t.Helper()
	requireReductionDisposition(t, got, reductionFailedClosedOutOfBand)
	if got.failure != want || got.next != (TransactionRecord{}) || got.retry != nil || got.requirement != 0 {
		t.Fatalf("out-of-band failure = %#v, want code %s without a record", got, want)
	}
}

func rootPointerForTest(value RootIdentity) *RootIdentity { return &value }

func repeatedForTest(value byte, count int) string {
	result := make([]byte, count)
	for index := range result {
		result[index] = value
	}
	return string(result)
}
