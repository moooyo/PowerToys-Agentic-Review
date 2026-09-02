package installtransaction

import (
	"errors"
	"reflect"
	"testing"
)

func TestExpectedNextIntentDerivesOnlyUnambiguousFixedActions(t *testing.T) {
	rollbackReady := testFullRecord(ModeUpgrade, PhaseRollbackInProgress)
	rollbackReady.RollbackCheckpoint = RollbackAuthenticatedDisabledReady
	upgradeForward := testPlanRecord(ModeUpgrade, PhaseRootSwapInProgress, PlanUpgradeForward, 1, false)
	tests := []struct {
		name       string
		record     TransactionRecord
		plan       ActionPlan
		phase      Phase
		activation ActivationPolicyState
		action     PendingAction
	}{
		{
			name:       "materialization entry",
			record:     testStagingRecord(ModeInitial),
			plan:       PlanMaterializeInactive,
			phase:      PhaseStagingVerified,
			activation: ActivationNotApplicable,
			action: CreateCandidateAction{
				ActionKind: ActionCreateCandidateRoot,
				Direction:  DirectionForward,
				Ordinal:    1,
				ToSlot:     SlotMetadataCandidate,
			},
		},
		{
			name:       "materialization next ordinal",
			record:     testMaterializeRecord(1, false),
			plan:       PlanMaterializeInactive,
			phase:      PhaseStagingVerified,
			activation: ActivationNotApplicable,
			action: PopulateCandidateAction{
				ActionKind:   ActionPopulateCandidateRoot,
				Direction:    DirectionForward,
				ExpectedRoot: testRoot('2'),
				Ordinal:      2,
				Slot:         SlotMetadataCandidate,
			},
		},
		{
			name:       "initial root plan entry",
			record:     testFullRecord(ModeInitial, PhaseServicesStopped),
			plan:       PlanInitialForward,
			phase:      PhaseRootSwapInProgress,
			activation: ActivationNotApplicable,
			action: RenameAction{
				ActionKind:   ActionRenameDirectory,
				Direction:    DirectionForward,
				ExpectedRoot: testRoot('2'),
				FromSlot:     RootSlotMetadataCandidate,
				Ordinal:      1,
				ToSlot:       RootSlotMetadataFinal,
			},
		},
		{
			name:       "upgrade root next ordinal",
			record:     upgradeForward,
			plan:       PlanUpgradeForward,
			phase:      PhaseRootSwapInProgress,
			activation: ActivationNotApplicable,
			action: RenameAction{
				ActionKind:   ActionRenameDirectory,
				Direction:    DirectionForward,
				ExpectedRoot: testRoot('4'),
				FromSlot:     RootSlotInstallationFinal,
				Ordinal:      2,
				ToSlot:       RootSlotInstallationRollback,
			},
		},
		{
			name:       "initial commit and policy entry",
			record:     testFullRecord(ModeInitial, PhaseAuthenticatedDisabledReady),
			plan:       PlanCandidateActivationPolicy,
			phase:      PhaseCommitted,
			activation: ActivationPending,
			action: PolicyAction{
				ActionKind: ActionApplyCandidateExecutorPolicy,
				Ordinal:    1,
			},
		},
		{
			name:       "rollback policy entry",
			record:     rollbackReady,
			plan:       PlanRollbackActivationPolicy,
			phase:      PhaseRollbackInProgress,
			activation: ActivationPending,
			action: PolicyAction{
				ActionKind: ActionApplyPreviousExecutorPolicy,
				Ordinal:    1,
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			before := cloneTestRecord(test.record)
			result, err := ExpectedNextIntent(test.record)
			if err != nil {
				t.Fatal(err)
			}
			if result.Disposition != NextIntentAction || result.Plan != test.plan ||
				result.Phase != test.phase || result.ActivationPolicyState != test.activation ||
				!pendingActionsEqual(result.Action, test.action) {
				t.Fatalf("ExpectedNextIntent = %#v, want plan=%s phase=%s activation=%s action=%#v",
					result, test.plan, test.phase, test.activation, test.action)
			}
			if !reflect.DeepEqual(test.record, before) {
				t.Fatal("ExpectedNextIntent mutated its input")
			}
		})
	}
}

func TestExpectedNextIntentReturnsNoneForPendingExternalGateAndUpgradeDecision(t *testing.T) {
	pending := testMaterializeRecord(1, true)
	tests := []struct {
		name   string
		record TransactionRecord
	}{
		{name: "durable pending action is not a new intent", record: pending},
		{name: "external readiness gate", record: testFullRecord(ModeInitial, PhaseExecutorStarted)},
		{name: "upgrade services stopped requires direction decision", record: testFullRecord(ModeUpgrade, PhaseServicesStopped)},
		{name: "upgrade ready requires commit or rollback decision", record: testFullRecord(ModeUpgrade, PhaseAuthenticatedDisabledReady)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result, err := ExpectedNextIntent(test.record)
			if err != nil {
				t.Fatal(err)
			}
			if result.Disposition != NextIntentNone || result.Action != nil {
				t.Fatalf("ExpectedNextIntent = %#v, want no new intent", result)
			}
		})
	}
}

func TestExpectedNextIntentReturnsTerminalWithoutInterpretingRetainedFailureCursor(t *testing.T) {
	committed := testFullRecord(ModeInitial, PhaseCommitted)
	committed.ActivationPolicyState = ActivationApplied
	rolledBack := testFullRecord(ModeUpgrade, PhaseRolledBack)
	rolledBack.ActivationPolicyState = ActivationApplied
	rolledBack.RollbackCheckpoint = RollbackAuthenticatedDisabledReady
	failure := FailureDurabilityUnproved
	failed := testMaterializeRecord(3, true)
	failed.Phase = PhaseFailedClosed
	failed.FailureCode = &failure
	for _, record := range []TransactionRecord{committed, rolledBack, failed} {
		result, err := ExpectedNextIntent(record)
		if err != nil {
			t.Fatal(err)
		}
		if result.Disposition != NextIntentTerminal || result.Action != nil || result.Plan != "" {
			t.Fatalf("ExpectedNextIntent = %#v, want terminal without interpreted cursor", result)
		}
	}
}

func TestExpectedNextIntentRejectsInvalidRecord(t *testing.T) {
	record := testMaterializeRecord(0, false)
	if _, err := ExpectedNextIntent(record); !errors.Is(err, ErrInvalid) {
		t.Fatalf("ExpectedNextIntent returned %v, want ErrInvalid", err)
	}
}
