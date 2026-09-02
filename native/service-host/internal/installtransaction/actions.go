package installtransaction

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
	case PlanCandidateActivationPolicy, PlanRollbackActivationPolicy:
		return 2
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
	case PlanCandidateActivationPolicy:
		return expectedCandidatePolicyAction(ordinal)
	case PlanRollbackActivationPolicy:
		return expectedRollbackPolicyAction(ordinal)
	default:
		return nil, fmt.Errorf("%w: action plan has no actions", ErrInvalid)
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

func expectedCandidatePolicyAction(ordinal ActionOrdinal) (PendingAction, error) {
	switch ordinal {
	case 1:
		return PolicyAction{ActionKind: ActionApplyCandidateExecutorPolicy, Ordinal: ordinal}, nil
	case 2:
		return PolicyAction{ActionKind: ActionApplyCandidateControlPolicy, Ordinal: ordinal}, nil
	default:
		return nil, fmt.Errorf("%w: candidate policy ordinal is invalid", ErrInvalid)
	}
}

func expectedRollbackPolicyAction(ordinal ActionOrdinal) (PendingAction, error) {
	switch ordinal {
	case 1:
		return PolicyAction{ActionKind: ActionApplyPreviousExecutorPolicy, Ordinal: ordinal}, nil
	case 2:
		return PolicyAction{ActionKind: ActionApplyPreviousControlPolicy, Ordinal: ordinal}, nil
	default:
		return nil, fmt.Errorf("%w: rollback policy ordinal is invalid", ErrInvalid)
	}
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
	case PolicyAction:
		rightValue, ok := right.(PolicyAction)
		return ok && leftValue == rightValue
	default:
		return false
	}
}

// ExpectedNextIntent derives the only next WAL intent without mutating the record or performing I/O.
func ExpectedNextIntent(record TransactionRecord) (NextIntent, error) {
	if err := ValidateRecord(record); err != nil {
		return NextIntent{}, err
	}
	if terminalRecord(record) {
		return NextIntent{Disposition: NextIntentTerminal}, nil
	}
	if record.PendingAction != nil {
		return NextIntent{Disposition: NextIntentNone}, nil
	}
	if record.ActionPlan != PlanNone {
		next := record.CompletedActionOrdinal + 1
		action, err := expectedAction(record, record.ActionPlan, next)
		if err != nil {
			return NextIntent{}, err
		}
		return NextIntent{
			Disposition:           NextIntentAction,
			Plan:                  record.ActionPlan,
			Phase:                 record.Phase,
			ActivationPolicyState: record.ActivationPolicyState,
			Action:                action,
		}, nil
	}

	switch record.Phase {
	case PhaseStagingVerified:
		action, err := expectedAction(record, PlanMaterializeInactive, 1)
		if err != nil {
			return NextIntent{}, err
		}
		return NextIntent{
			Disposition:           NextIntentAction,
			Plan:                  PlanMaterializeInactive,
			Phase:                 PhaseStagingVerified,
			ActivationPolicyState: ActivationNotApplicable,
			Action:                action,
		}, nil
	case PhaseServicesStopped:
		if record.Mode == ModeUpgrade {
			return NextIntent{Disposition: NextIntentNone}, nil
		}
		plan := PlanInitialForward
		action, err := expectedAction(record, plan, 1)
		if err != nil {
			return NextIntent{}, err
		}
		return NextIntent{
			Disposition:           NextIntentAction,
			Plan:                  plan,
			Phase:                 PhaseRootSwapInProgress,
			ActivationPolicyState: ActivationNotApplicable,
			Action:                action,
		}, nil
	case PhaseAuthenticatedDisabledReady:
		if record.Mode == ModeUpgrade {
			return NextIntent{Disposition: NextIntentNone}, nil
		}
		action, err := expectedAction(record, PlanCandidateActivationPolicy, 1)
		if err != nil {
			return NextIntent{}, err
		}
		return NextIntent{
			Disposition:           NextIntentAction,
			Plan:                  PlanCandidateActivationPolicy,
			Phase:                 PhaseCommitted,
			ActivationPolicyState: ActivationPending,
			Action:                action,
		}, nil
	case PhaseRollbackInProgress:
		if record.RollbackCheckpoint == RollbackAuthenticatedDisabledReady &&
			record.ActivationPolicyState == ActivationNotApplicable {
			action, err := expectedAction(record, PlanRollbackActivationPolicy, 1)
			if err != nil {
				return NextIntent{}, err
			}
			return NextIntent{
				Disposition:           NextIntentAction,
				Plan:                  PlanRollbackActivationPolicy,
				Phase:                 PhaseRollbackInProgress,
				ActivationPolicyState: ActivationPending,
				Action:                action,
			}, nil
		}
	}
	return NextIntent{Disposition: NextIntentNone}, nil
}

func terminalRecord(record TransactionRecord) bool {
	return record.Phase == PhaseFailedClosed || record.Phase == PhaseRolledBack ||
		record.Phase == PhaseCommitted && record.ActivationPolicyState == ActivationApplied
}
