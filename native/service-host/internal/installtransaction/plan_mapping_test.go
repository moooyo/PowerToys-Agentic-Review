package installtransaction

import "testing"

func TestFixedActionPlansMatchADR0015(t *testing.T) {
	materialize := []PendingAction{
		CreateCandidateAction{ActionKind: ActionCreateCandidateRoot, Direction: DirectionForward, Ordinal: 1, ToSlot: SlotMetadataCandidate},
		PopulateCandidateAction{ActionKind: ActionPopulateCandidateRoot, Direction: DirectionForward, ExpectedRoot: testRoot('2'), Ordinal: 2, Slot: SlotMetadataCandidate},
		CreateCandidateAction{ActionKind: ActionCreateCandidateRoot, Direction: DirectionForward, Ordinal: 3, ToSlot: SlotInstallationCandidate},
		PopulateCandidateAction{ActionKind: ActionPopulateCandidateRoot, Direction: DirectionForward, ExpectedRoot: testRoot('1'), Ordinal: 4, Slot: SlotInstallationCandidate},
		CreateCandidateAction{ActionKind: ActionCreateCandidateRoot, Direction: DirectionForward, Ordinal: 5, ToSlot: SlotTrustedConfigurationCandidate},
		PopulateCandidateAction{ActionKind: ActionPopulateCandidateRoot, Direction: DirectionForward, ExpectedRoot: testRoot('3'), Ordinal: 6, Slot: SlotTrustedConfigurationCandidate},
	}
	for index, want := range materialize {
		ordinal := ActionOrdinal(index + 1)
		record := testMaterializeRecord(ordinal-1, false)
		assertExpectedAction(t, "materialize-inactive", record, PlanMaterializeInactive, ordinal, want)
	}

	initial := testFullRecord(ModeInitial, PhaseRootSwapInProgress)
	for index, want := range []PendingAction{
		RenameAction{ActionKind: ActionRenameDirectory, Direction: DirectionForward, ExpectedRoot: testRoot('2'), FromSlot: RootSlotMetadataCandidate, Ordinal: 1, ToSlot: RootSlotMetadataFinal},
		RenameAction{ActionKind: ActionRenameDirectory, Direction: DirectionForward, ExpectedRoot: testRoot('1'), FromSlot: RootSlotInstallationCandidate, Ordinal: 2, ToSlot: RootSlotInstallationFinal},
		RenameAction{ActionKind: ActionRenameDirectory, Direction: DirectionForward, ExpectedRoot: testRoot('3'), FromSlot: RootSlotTrustedConfigurationCandidate, Ordinal: 3, ToSlot: RootSlotTrustedConfigurationFinal},
	} {
		assertExpectedAction(t, "initial-forward", initial, PlanInitialForward, ActionOrdinal(index+1), want)
	}

	upgrade := testFullRecord(ModeUpgrade, PhaseRootSwapInProgress)
	for index, want := range []PendingAction{
		RenameAction{ActionKind: ActionRenameDirectory, Direction: DirectionForward, ExpectedRoot: testRoot('2'), FromSlot: RootSlotMetadataCandidate, Ordinal: 1, ToSlot: RootSlotMetadataFinal},
		RenameAction{ActionKind: ActionRenameDirectory, Direction: DirectionForward, ExpectedRoot: testRoot('4'), FromSlot: RootSlotInstallationFinal, Ordinal: 2, ToSlot: RootSlotInstallationRollback},
		RenameAction{ActionKind: ActionRenameDirectory, Direction: DirectionForward, ExpectedRoot: testRoot('6'), FromSlot: RootSlotTrustedConfigurationFinal, Ordinal: 3, ToSlot: RootSlotTrustedConfigurationRollback},
		RenameAction{ActionKind: ActionRenameDirectory, Direction: DirectionForward, ExpectedRoot: testRoot('1'), FromSlot: RootSlotInstallationCandidate, Ordinal: 4, ToSlot: RootSlotInstallationFinal},
		RenameAction{ActionKind: ActionRenameDirectory, Direction: DirectionForward, ExpectedRoot: testRoot('3'), FromSlot: RootSlotTrustedConfigurationCandidate, Ordinal: 5, ToSlot: RootSlotTrustedConfigurationFinal},
	} {
		assertExpectedAction(t, "upgrade-forward", upgrade, PlanUpgradeForward, ActionOrdinal(index+1), want)
	}

	for index, want := range []PendingAction{
		RenameAction{ActionKind: ActionRenameDirectory, Direction: DirectionRollback, ExpectedRoot: testRoot('3'), FromSlot: RootSlotTrustedConfigurationFinal, Ordinal: 1, ToSlot: RootSlotTrustedConfigurationInactive},
		RenameAction{ActionKind: ActionRenameDirectory, Direction: DirectionRollback, ExpectedRoot: testRoot('1'), FromSlot: RootSlotInstallationFinal, Ordinal: 2, ToSlot: RootSlotInstallationInactive},
		RenameAction{ActionKind: ActionRenameDirectory, Direction: DirectionRollback, ExpectedRoot: testRoot('4'), FromSlot: RootSlotInstallationRollback, Ordinal: 3, ToSlot: RootSlotInstallationFinal},
		RenameAction{ActionKind: ActionRenameDirectory, Direction: DirectionRollback, ExpectedRoot: testRoot('6'), FromSlot: RootSlotTrustedConfigurationRollback, Ordinal: 4, ToSlot: RootSlotTrustedConfigurationFinal},
	} {
		assertExpectedAction(t, "upgrade-rollback", upgrade, PlanUpgradeRollback, ActionOrdinal(index+1), want)
	}

	for index, want := range []PendingAction{
		PolicyAction{ActionKind: ActionApplyCandidateExecutorPolicy, Ordinal: 1},
		PolicyAction{ActionKind: ActionApplyCandidateControlPolicy, Ordinal: 2},
	} {
		assertExpectedAction(t, "candidate-policy", initial, PlanCandidateActivationPolicy, ActionOrdinal(index+1), want)
	}
	for index, want := range []PendingAction{
		PolicyAction{ActionKind: ActionApplyPreviousExecutorPolicy, Ordinal: 1},
		PolicyAction{ActionKind: ActionApplyPreviousControlPolicy, Ordinal: 2},
	} {
		assertExpectedAction(t, "rollback-policy", upgrade, PlanRollbackActivationPolicy, ActionOrdinal(index+1), want)
	}
}

func assertExpectedAction(
	t *testing.T,
	name string,
	record TransactionRecord,
	plan ActionPlan,
	ordinal ActionOrdinal,
	want PendingAction,
) {
	t.Helper()
	got, err := expectedAction(record, plan, ordinal)
	if err != nil {
		t.Fatalf("%s ordinal %d returned %v", name, ordinal, err)
	}
	if !pendingActionsEqual(got, want) {
		t.Fatalf("%s ordinal %d = %#v, want %#v", name, ordinal, got, want)
	}
}
