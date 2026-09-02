package installtransactionv2lab

import "testing"

func TestSCMActionPlansMatchADR0016(t *testing.T) {
	tests := []struct {
		name  string
		plan  ActionPlan
		kinds []ActionKind
		roles []ServiceRole
	}{
		{
			name: "maintenance",
			plan: PlanSCMMaintenance,
			kinds: []ActionKind{
				ActionClearControlFailureActions,
				ActionClearControlFailureActionsOnNonCrash,
				ActionClearControlDelayedAutoStart,
				ActionSetControlDemandStart,
				ActionClearExecutorFailureActions,
				ActionClearExecutorFailureActionsOnNonCrash,
				ActionClearExecutorDelayedAutoStart,
				ActionSetExecutorDemandStart,
			},
			roles: []ServiceRole{
				RoleControl, RoleControl, RoleControl, RoleControl,
				RoleExecutor, RoleExecutor, RoleExecutor, RoleExecutor,
			},
		},
		{
			name:  "stop",
			plan:  PlanStopServices,
			kinds: []ActionKind{ActionStopControl, ActionStopExecutor},
			roles: []ServiceRole{RoleControl, RoleExecutor},
		},
		{
			name: "initial service creation",
			plan: PlanInitialServiceCreation,
			kinds: []ActionKind{
				ActionCreateDisabledExecutorService,
				ActionSetExecutorServiceSecurity,
				ActionSetExecutorDescription,
				ActionSetExecutorServiceSIDType,
				ActionSetExecutorRequiredPrivileges,
				ActionClearExecutorDelayedAutoStart,
				ActionClearExecutorFailureActions,
				ActionClearExecutorFailureActionsOnNonCrash,
				ActionSetExecutorPreshutdownPolicy,
				ActionCreateDisabledControlService,
				ActionSetControlServiceSecurity,
				ActionSetControlDescription,
				ActionSetControlServiceSIDType,
				ActionSetControlRequiredPrivileges,
				ActionClearControlDelayedAutoStart,
				ActionClearControlFailureActions,
				ActionClearControlFailureActionsOnNonCrash,
				ActionSetControlPreshutdownPolicy,
				ActionSetExecutorDemandStart,
				ActionSetControlDemandStart,
			},
			roles: []ServiceRole{
				RoleExecutor, RoleExecutor, RoleExecutor, RoleExecutor, RoleExecutor,
				RoleExecutor, RoleExecutor, RoleExecutor, RoleExecutor,
				RoleControl, RoleControl, RoleControl, RoleControl, RoleControl,
				RoleControl, RoleControl, RoleControl, RoleControl,
				RoleExecutor, RoleControl,
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			record := testFullRecord(ModeUpgrade, PhaseQuiesced)
			if test.plan == PlanInitialServiceCreation {
				record = testFullRecord(ModeInitial, PhaseServiceConfigurationProgress)
			}
			if planLastOrdinal(test.plan) != ActionOrdinal(len(test.kinds)) ||
				len(test.roles) != len(test.kinds) {
				t.Fatal("fixture length differs from plan length")
			}
			for index, kind := range test.kinds {
				ordinal := ActionOrdinal(index + 1)
				action, err := expectedAction(record, test.plan, ordinal)
				if err != nil {
					t.Fatalf("ordinal %d returned %v", ordinal, err)
				}
				value, ok := action.(SCMAction)
				if !ok || value.ActionKind != kind || value.Ordinal != ordinal ||
					value.Role != test.roles[index] || value.PolicyContractID != SCMPolicyContractIdentifier {
					t.Fatalf("ordinal %d = %#v", ordinal, action)
				}
			}
		})
	}
}

func TestStartPlansAreExecutorThenControlAndGenerationBound(t *testing.T) {
	for _, test := range []struct {
		plan       ActionPlan
		generation TargetGeneration
	}{
		{PlanStartCandidateServices, GenerationCandidate},
		{PlanStartPreviousServices, GenerationPrevious},
	} {
		record := testFullRecord(ModeUpgrade, PhaseServicesConfigured)
		for index, expected := range []struct {
			kind ActionKind
			role ServiceRole
		}{{ActionStartExecutor, RoleExecutor}, {ActionStartControl, RoleControl}} {
			ordinal := ActionOrdinal(index + 1)
			action, err := expectedAction(record, test.plan, ordinal)
			value, ok := action.(SCMGenerationAction)
			if err != nil || !ok || value.ActionKind != expected.kind || value.Role != expected.role ||
				value.Ordinal != ordinal || value.TargetGeneration != test.generation ||
				value.PolicyContractID != SCMPolicyContractIdentifier {
				t.Fatalf("%s ordinal %d = (%#v, %v)", test.plan, ordinal, action, err)
			}
		}
	}
}

func TestFilesystemPlansRetainADR0015OrdinalsWithIndependentTypes(t *testing.T) {
	if planLastOrdinal(PlanMaterializeInactive) != 6 ||
		planLastOrdinal(PlanInitialForward) != 3 ||
		planLastOrdinal(PlanUpgradeForward) != 5 ||
		planLastOrdinal(PlanUpgradeRollback) != 4 {
		t.Fatal("filesystem plan ordinals differ from ADR 0015")
	}
	materialize := testMaterializeRecord(0, false)
	action, err := expectedAction(materialize, PlanMaterializeInactive, 1)
	if err != nil || action != (CreateCandidateAction{
		ActionKind: ActionCreateCandidateRoot,
		Direction:  DirectionForward,
		Ordinal:    1,
		ToSlot:     SlotMetadataCandidate,
	}) {
		t.Fatalf("materialize ordinal 1 = (%#v, %v)", action, err)
	}
	initial := testFullRecord(ModeInitial, PhaseRootSwapInProgress)
	action, err = expectedAction(initial, PlanInitialForward, 1)
	want := RenameAction{
		ActionKind:   ActionRenameDirectory,
		Direction:    DirectionForward,
		ExpectedRoot: testRoot('2'),
		FromSlot:     RootSlotMetadataCandidate,
		Ordinal:      1,
		ToSlot:       RootSlotMetadataFinal,
	}
	if err != nil || action != want {
		t.Fatalf("initial forward ordinal 1 = (%#v, %v), want %#v", action, err, want)
	}
}

func TestNoExecutableFinalPolicyPlanExists(t *testing.T) {
	record := testCandidateFinalBlockedRecord()
	if _, err := expectedAction(record, PlanCandidateFinalPolicyBlocked, 1); err == nil {
		t.Fatal("candidate final-policy plan exposed an executable action")
	}
	record = testPreviousFinalBlockedRecord()
	if _, err := expectedAction(record, PlanPreviousFinalPolicyBlocked, 1); err == nil {
		t.Fatal("previous final-policy plan exposed an executable action")
	}
}
