package installtransactionv2lab

import "fmt"

func planLastOrdinal(plan ActionPlan) ActionOrdinal {
	switch plan {
	case PlanMaterializeInactive:
		return 6
	case PlanInitialForward:
		return 3
	case PlanUpgradeForward:
		return 5
	case PlanUpgradeRollback:
		return 4
	case PlanSCMMaintenance:
		return 8
	case PlanStopServices, PlanStartCandidateServices, PlanStartPreviousServices:
		return 2
	case PlanInitialServiceCreation:
		return 20
	case PlanCandidateFinalPolicyBlocked, PlanPreviousFinalPolicyBlocked:
		return 1
	default:
		return 0
	}
}

func expectedAction(record TransactionRecord, plan ActionPlan, ordinal ActionOrdinal) (PendingAction, error) {
	switch plan {
	case PlanMaterializeInactive:
		return expectedMaterializeAction(record, ordinal)
	case PlanInitialForward:
		return expectedInitialForwardAction(record, ordinal)
	case PlanUpgradeForward:
		return expectedUpgradeForwardAction(record, ordinal)
	case PlanUpgradeRollback:
		return expectedUpgradeRollbackAction(record, ordinal)
	case PlanSCMMaintenance:
		return expectedMaintenanceAction(ordinal)
	case PlanStopServices:
		return expectedStopAction(ordinal)
	case PlanInitialServiceCreation:
		return expectedInitialServiceAction(ordinal)
	case PlanStartCandidateServices:
		return expectedStartAction(ordinal, GenerationCandidate)
	case PlanStartPreviousServices:
		return expectedStartAction(ordinal, GenerationPrevious)
	default:
		return nil, fmt.Errorf("%w: action plan has no executable action", ErrInvalid)
	}
}

func expectedMaterializeAction(record TransactionRecord, ordinal ActionOrdinal) (PendingAction, error) {
	switch ordinal {
	case 1:
		return CreateCandidateAction{
			ActionKind: ActionCreateCandidateRoot,
			Direction:  DirectionForward,
			Ordinal:    ordinal,
			ToSlot:     SlotMetadataCandidate,
		}, nil
	case 2:
		root, ok := candidateRoot(record.Candidate.Roots, SlotMetadataCandidate)
		if !ok {
			return nil, fmt.Errorf("%w: metadata candidate identity is absent", ErrInvalid)
		}
		return PopulateCandidateAction{
			ActionKind:   ActionPopulateCandidateRoot,
			Direction:    DirectionForward,
			ExpectedRoot: root,
			Ordinal:      ordinal,
			Slot:         SlotMetadataCandidate,
		}, nil
	case 3:
		return CreateCandidateAction{
			ActionKind: ActionCreateCandidateRoot,
			Direction:  DirectionForward,
			Ordinal:    ordinal,
			ToSlot:     SlotInstallationCandidate,
		}, nil
	case 4:
		root, ok := candidateRoot(record.Candidate.Roots, SlotInstallationCandidate)
		if !ok {
			return nil, fmt.Errorf("%w: installation candidate identity is absent", ErrInvalid)
		}
		return PopulateCandidateAction{
			ActionKind:   ActionPopulateCandidateRoot,
			Direction:    DirectionForward,
			ExpectedRoot: root,
			Ordinal:      ordinal,
			Slot:         SlotInstallationCandidate,
		}, nil
	case 5:
		return CreateCandidateAction{
			ActionKind: ActionCreateCandidateRoot,
			Direction:  DirectionForward,
			Ordinal:    ordinal,
			ToSlot:     SlotTrustedConfigurationCandidate,
		}, nil
	case 6:
		root, ok := candidateRoot(record.Candidate.Roots, SlotTrustedConfigurationCandidate)
		if !ok {
			return nil, fmt.Errorf("%w: trusted-configuration candidate identity is absent", ErrInvalid)
		}
		return PopulateCandidateAction{
			ActionKind:   ActionPopulateCandidateRoot,
			Direction:    DirectionForward,
			ExpectedRoot: root,
			Ordinal:      ordinal,
			Slot:         SlotTrustedConfigurationCandidate,
		}, nil
	default:
		return nil, fmt.Errorf("%w: materialization ordinal is invalid", ErrInvalid)
	}
}

func expectedInitialForwardAction(record TransactionRecord, ordinal ActionOrdinal) (PendingAction, error) {
	switch ordinal {
	case 1:
		return candidateRename(record, ordinal, DirectionForward, SlotMetadataCandidate,
			RootSlotMetadataCandidate, RootSlotMetadataFinal)
	case 2:
		return candidateRename(record, ordinal, DirectionForward, SlotInstallationCandidate,
			RootSlotInstallationCandidate, RootSlotInstallationFinal)
	case 3:
		return candidateRename(record, ordinal, DirectionForward, SlotTrustedConfigurationCandidate,
			RootSlotTrustedConfigurationCandidate, RootSlotTrustedConfigurationFinal)
	default:
		return nil, fmt.Errorf("%w: initial forward ordinal is invalid", ErrInvalid)
	}
}

func expectedUpgradeForwardAction(record TransactionRecord, ordinal ActionOrdinal) (PendingAction, error) {
	switch ordinal {
	case 1:
		return candidateRename(record, ordinal, DirectionForward, SlotMetadataCandidate,
			RootSlotMetadataCandidate, RootSlotMetadataFinal)
	case 2:
		return previousRename(record, ordinal, DirectionForward, RootSlotInstallationFinal,
			RootSlotInstallationRollback, func(roots RootSet) RootIdentity { return roots.Installation })
	case 3:
		return previousRename(record, ordinal, DirectionForward, RootSlotTrustedConfigurationFinal,
			RootSlotTrustedConfigurationRollback, func(roots RootSet) RootIdentity { return roots.TrustedConfiguration })
	case 4:
		return candidateRename(record, ordinal, DirectionForward, SlotInstallationCandidate,
			RootSlotInstallationCandidate, RootSlotInstallationFinal)
	case 5:
		return candidateRename(record, ordinal, DirectionForward, SlotTrustedConfigurationCandidate,
			RootSlotTrustedConfigurationCandidate, RootSlotTrustedConfigurationFinal)
	default:
		return nil, fmt.Errorf("%w: upgrade forward ordinal is invalid", ErrInvalid)
	}
}

func expectedUpgradeRollbackAction(record TransactionRecord, ordinal ActionOrdinal) (PendingAction, error) {
	switch ordinal {
	case 1:
		return candidateRename(record, ordinal, DirectionRollback, SlotTrustedConfigurationCandidate,
			RootSlotTrustedConfigurationFinal, RootSlotTrustedConfigurationInactive)
	case 2:
		return candidateRename(record, ordinal, DirectionRollback, SlotInstallationCandidate,
			RootSlotInstallationFinal, RootSlotInstallationInactive)
	case 3:
		return previousRename(record, ordinal, DirectionRollback, RootSlotInstallationRollback,
			RootSlotInstallationFinal, func(roots RootSet) RootIdentity { return roots.Installation })
	case 4:
		return previousRename(record, ordinal, DirectionRollback, RootSlotTrustedConfigurationRollback,
			RootSlotTrustedConfigurationFinal, func(roots RootSet) RootIdentity { return roots.TrustedConfiguration })
	default:
		return nil, fmt.Errorf("%w: upgrade rollback ordinal is invalid", ErrInvalid)
	}
}

func expectedMaintenanceAction(ordinal ActionOrdinal) (PendingAction, error) {
	values := []struct {
		kind ActionKind
		role ServiceRole
	}{
		{ActionClearControlFailureActions, RoleControl},
		{ActionClearControlFailureActionsOnNonCrash, RoleControl},
		{ActionClearControlDelayedAutoStart, RoleControl},
		{ActionSetControlDemandStart, RoleControl},
		{ActionClearExecutorFailureActions, RoleExecutor},
		{ActionClearExecutorFailureActionsOnNonCrash, RoleExecutor},
		{ActionClearExecutorDelayedAutoStart, RoleExecutor},
		{ActionSetExecutorDemandStart, RoleExecutor},
	}
	return indexedSCMAction(values, ordinal, "maintenance")
}

func expectedStopAction(ordinal ActionOrdinal) (PendingAction, error) {
	values := []struct {
		kind ActionKind
		role ServiceRole
	}{
		{ActionStopControl, RoleControl},
		{ActionStopExecutor, RoleExecutor},
	}
	return indexedSCMAction(values, ordinal, "stop")
}

func expectedInitialServiceAction(ordinal ActionOrdinal) (PendingAction, error) {
	values := []struct {
		kind ActionKind
		role ServiceRole
	}{
		{ActionCreateDisabledExecutorService, RoleExecutor},
		{ActionSetExecutorServiceSecurity, RoleExecutor},
		{ActionSetExecutorDescription, RoleExecutor},
		{ActionSetExecutorServiceSIDType, RoleExecutor},
		{ActionSetExecutorRequiredPrivileges, RoleExecutor},
		{ActionClearExecutorDelayedAutoStart, RoleExecutor},
		{ActionClearExecutorFailureActions, RoleExecutor},
		{ActionClearExecutorFailureActionsOnNonCrash, RoleExecutor},
		{ActionSetExecutorPreshutdownPolicy, RoleExecutor},
		{ActionCreateDisabledControlService, RoleControl},
		{ActionSetControlServiceSecurity, RoleControl},
		{ActionSetControlDescription, RoleControl},
		{ActionSetControlServiceSIDType, RoleControl},
		{ActionSetControlRequiredPrivileges, RoleControl},
		{ActionClearControlDelayedAutoStart, RoleControl},
		{ActionClearControlFailureActions, RoleControl},
		{ActionClearControlFailureActionsOnNonCrash, RoleControl},
		{ActionSetControlPreshutdownPolicy, RoleControl},
		{ActionSetExecutorDemandStart, RoleExecutor},
		{ActionSetControlDemandStart, RoleControl},
	}
	return indexedSCMAction(values, ordinal, "initial service creation")
}

func indexedSCMAction(
	values []struct {
		kind ActionKind
		role ServiceRole
	},
	ordinal ActionOrdinal,
	name string,
) (PendingAction, error) {
	if ordinal == 0 || int(ordinal) > len(values) {
		return nil, fmt.Errorf("%w: %s ordinal is invalid", ErrInvalid, name)
	}
	value := values[int(ordinal)-1]
	return SCMAction{
		ActionKind:       value.kind,
		Ordinal:          ordinal,
		PolicyContractID: SCMPolicyContractIdentifier,
		Role:             value.role,
	}, nil
}

func expectedStartAction(ordinal ActionOrdinal, generation TargetGeneration) (PendingAction, error) {
	var kind ActionKind
	var role ServiceRole
	switch ordinal {
	case 1:
		kind, role = ActionStartExecutor, RoleExecutor
	case 2:
		kind, role = ActionStartControl, RoleControl
	default:
		return nil, fmt.Errorf("%w: start ordinal is invalid", ErrInvalid)
	}
	return SCMGenerationAction{
		ActionKind:       kind,
		Ordinal:          ordinal,
		PolicyContractID: SCMPolicyContractIdentifier,
		Role:             role,
		TargetGeneration: generation,
	}, nil
}

func derivedBlockedCheckpoint(record TransactionRecord) (*BlockedCheckpoint, error) {
	if record.ActionPlan == PlanCandidateFinalPolicyBlocked {
		return &BlockedCheckpoint{
			ActionKind: ActionCandidateFinalPolicyUnavailable,
			MissingPrerequisites: []BlockedReason{
				BlockedDurableStore,
				BlockedNativeAdapter,
				BlockedPreferredNodeReadback,
				BlockedCandidateFinalPolicy,
			},
			Ordinal: 1,
			Plan:    record.ActionPlan,
		}, nil
	}
	if record.ActionPlan == PlanPreviousFinalPolicyBlocked {
		return &BlockedCheckpoint{
			ActionKind: ActionPreviousFinalPolicyUnavailable,
			MissingPrerequisites: []BlockedReason{
				BlockedDurableStore,
				BlockedNativeAdapter,
				BlockedPreferredNodeReadback,
				BlockedPreviousFinalPolicy,
			},
			Ordinal: 1,
			Plan:    record.ActionPlan,
		}, nil
	}
	if record.ActionPlan == PlanNone || record.PendingAction != nil {
		return nil, nil
	}
	next := record.CompletedActionOrdinal + 1
	action, err := expectedAction(record, record.ActionPlan, next)
	if err != nil {
		return nil, err
	}
	missing := blockedPrerequisites(record.ActionPlan, action.Kind())
	if len(missing) == 0 {
		return nil, nil
	}
	return &BlockedCheckpoint{
		ActionKind:           action.Kind(),
		MissingPrerequisites: missing,
		Ordinal:              next,
		Plan:                 record.ActionPlan,
	}, nil
}

func blockedPrerequisites(plan ActionPlan, kind ActionKind) []BlockedReason {
	if plan != PlanSCMMaintenance && plan != PlanStopServices &&
		plan != PlanInitialServiceCreation && plan != PlanStartCandidateServices &&
		plan != PlanStartPreviousServices {
		return nil
	}
	missing := []BlockedReason{
		BlockedDurableStore,
		BlockedNativeAdapter,
		BlockedPreferredNodeReadback,
	}
	switch plan {
	case PlanSCMMaintenance:
		missing = append(missing, BlockedFailureActionsClearABI)
	case PlanStopServices:
		missing = append(missing, BlockedStopProcessTreeEvidence)
	case PlanInitialServiceCreation:
		missing = append(missing,
			BlockedCreateIntermediateEvidence,
			BlockedFailureActionsClearABI,
			BlockedPreshutdownContract,
		)
	case PlanStartCandidateServices, PlanStartPreviousServices:
		missing = append(missing, BlockedStartReadinessEvidence)
	}
	return missing
}

func candidateRename(
	record TransactionRecord,
	ordinal ActionOrdinal,
	direction Direction,
	candidateSlot CandidateRootSlot,
	from RootSlot,
	to RootSlot,
) (PendingAction, error) {
	root, ok := candidateRoot(record.Candidate.Roots, candidateSlot)
	if !ok {
		return nil, fmt.Errorf("%w: candidate root identity is absent", ErrInvalid)
	}
	return RenameAction{
		ActionKind:   ActionRenameDirectory,
		Direction:    direction,
		ExpectedRoot: root,
		FromSlot:     from,
		Ordinal:      ordinal,
		ToSlot:       to,
	}, nil
}

func previousRename(
	record TransactionRecord,
	ordinal ActionOrdinal,
	direction Direction,
	from RootSlot,
	to RootSlot,
	selectRoot func(RootSet) RootIdentity,
) (PendingAction, error) {
	if record.Previous == nil {
		return nil, fmt.Errorf("%w: previous generation is absent", ErrInvalid)
	}
	return RenameAction{
		ActionKind:   ActionRenameDirectory,
		Direction:    direction,
		ExpectedRoot: selectRoot(record.Previous.Roots),
		FromSlot:     from,
		Ordinal:      ordinal,
		ToSlot:       to,
	}, nil
}

func candidateRoot(roots *CandidateRootSet, slot CandidateRootSlot) (RootIdentity, bool) {
	if roots == nil {
		return RootIdentity{}, false
	}
	var root *RootIdentity
	switch slot {
	case SlotMetadataCandidate:
		root = roots.Metadata
	case SlotInstallationCandidate:
		root = roots.Installation
	case SlotTrustedConfigurationCandidate:
		root = roots.TrustedConfiguration
	default:
		return RootIdentity{}, false
	}
	if root == nil {
		return RootIdentity{}, false
	}
	return *root, true
}

func pendingActionsEqual(left, right PendingAction) bool {
	switch leftValue := left.(type) {
	case CreateCandidateAction:
		rightValue, ok := right.(CreateCandidateAction)
		return ok && leftValue == rightValue
	case PopulateCandidateAction:
		rightValue, ok := right.(PopulateCandidateAction)
		return ok && leftValue == rightValue
	case RenameAction:
		rightValue, ok := right.(RenameAction)
		return ok && leftValue == rightValue
	case SCMAction:
		rightValue, ok := right.(SCMAction)
		return ok && leftValue == rightValue
	case SCMGenerationAction:
		rightValue, ok := right.(SCMGenerationAction)
		return ok && leftValue == rightValue
	default:
		return false
	}
}
