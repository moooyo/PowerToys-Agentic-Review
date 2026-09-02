package installtransactionv2lab

import (
	"fmt"
	"strconv"
)

func nextReduction(record TransactionRecord) (reduction, error) {
	if err := ValidateRecord(record); err != nil {
		return failedClosedOutOfBand(FailureJournalCorrupt), err
	}
	if record.Phase == PhaseFailedClosed {
		return reduction{disposition: reductionTerminal}, nil
	}
	if record.BlockedCheckpoint != nil {
		return reduction{
			disposition: reductionBlocked,
			blocked:     cloneBlockedCheckpoint(record.BlockedCheckpoint),
		}, nil
	}
	if record.PendingAction != nil {
		return acquireExternalEvidence(evidenceRequirementPendingAction), nil
	}
	if record.ActionPlan == PlanNone {
		return acquireExternalEvidence(evidenceRequirementPhaseTransition), nil
	}
	action, err := expectedAction(record, record.ActionPlan, record.CompletedActionOrdinal+1)
	if err != nil {
		return failedClosedOutOfBand(FailureJournalCorrupt), err
	}
	return publishIntent(record, action)
}

func reduceObservation(record TransactionRecord, observation actionObservation) (reduction, error) {
	if err := ValidateRecord(record); err != nil {
		return failedClosedOutOfBand(FailureJournalCorrupt), err
	}
	if record.Phase == PhaseFailedClosed {
		return reduction{disposition: reductionTerminal}, nil
	}
	if record.BlockedCheckpoint != nil {
		return reduction{
			disposition: reductionBlocked,
			blocked:     cloneBlockedCheckpoint(record.BlockedCheckpoint),
		}, nil
	}
	if record.PendingAction == nil {
		return acquireExternalEvidence(evidenceRequirementPhaseTransition), nil
	}
	if observation == nil {
		return acquireExternalEvidence(evidenceRequirementPendingAction), nil
	}

	switch action := record.PendingAction.(type) {
	case CreateCandidateAction:
		value, ok := observation.(createCandidateObservation)
		if !ok {
			return observationTypeFailure(action)
		}
		return reduceCreateObservation(record, action, value)
	case PopulateCandidateAction:
		value, ok := observation.(populateCandidateObservation)
		if !ok {
			return observationTypeFailure(action)
		}
		return reducePopulateObservation(record, action, value)
	case RenameAction:
		value, ok := observation.(renameObservation)
		if !ok {
			return observationTypeFailure(action)
		}
		return reduceRenameObservation(record, action, value)
	case SCMAction, SCMGenerationAction:
		return failedClosedOutOfBand(FailureJournalCorrupt),
			fmt.Errorf("%w: SCM pending action is unreachable in the blocked schema", ErrInvalid)
	default:
		return failedClosedOutOfBand(FailureJournalCorrupt),
			fmt.Errorf("%w: pending action has an unrecognized concrete type", ErrInvalid)
	}
}

func reduceCreateObservation(
	record TransactionRecord,
	action CreateCandidateAction,
	observation createCandidateObservation,
) (reduction, error) {
	switch observation.state {
	case candidateCreationAbsent:
		if observation.root != (RootIdentity{}) {
			return invalidObservation(FailureRootIdentityAmbiguous, "absent candidate carries an identity")
		}
		return retryPendingAction(record), nil
	case candidateCreationVerified:
		if !validRootIdentity(observation.root) {
			return invalidObservation(FailureRootIdentityAmbiguous, "candidate identity is invalid")
		}
		return completePendingAction(record, action.ToSlot, observation.root)
	case candidateCreationAmbiguous:
		if observation.root != (RootIdentity{}) {
			return invalidObservation(FailureRootIdentityAmbiguous, "ambiguous candidate carries an identity")
		}
		return failedClosedOutOfBand(FailureRootIdentityAmbiguous), nil
	default:
		return invalidObservation(FailureRootIdentityAmbiguous, "candidate observation state is invalid")
	}
}

func reducePopulateObservation(
	record TransactionRecord,
	action PopulateCandidateAction,
	observation populateCandidateObservation,
) (reduction, error) {
	if observation.state == candidatePopulationAmbiguous {
		if observation.root != (RootIdentity{}) {
			return invalidObservation(FailureRevalidationFailed, "ambiguous population carries an identity")
		}
		return failedClosedOutOfBand(FailureRevalidationFailed), nil
	}
	if observation.state != candidatePopulationRetryable &&
		observation.state != candidatePopulationVerified {
		return invalidObservation(FailureRevalidationFailed, "population observation state is invalid")
	}
	if observation.root != action.ExpectedRoot {
		return failedClosedOutOfBand(FailureRootIdentityAmbiguous), nil
	}
	if observation.state == candidatePopulationRetryable {
		return retryPendingAction(record), nil
	}
	return completePendingAction(record, "", RootIdentity{})
}

func reduceRenameObservation(
	record TransactionRecord,
	action RenameAction,
	observation renameObservation,
) (reduction, error) {
	if err := validateRootSlotObservation(observation.from); err != nil {
		return invalidObservation(FailureRootIdentityAmbiguous, "rename source observation is invalid")
	}
	if err := validateRootSlotObservation(observation.to); err != nil {
		return invalidObservation(FailureRootIdentityAmbiguous, "rename destination observation is invalid")
	}
	fromMatches := observation.from.state == rootSlotPresent && observation.from.root == action.ExpectedRoot
	toMatches := observation.to.state == rootSlotPresent && observation.to.root == action.ExpectedRoot
	if fromMatches && observation.to.state == rootSlotAbsent &&
		observation.durability == renameDurabilityNotApplicable {
		return retryPendingAction(record), nil
	}
	if observation.from.state == rootSlotAbsent && toMatches {
		if observation.durability != renameDurabilityProved {
			return failedClosedOutOfBand(FailureDurabilityUnproved), nil
		}
		if record.ActionPlan == PlanUpgradeRollback && action.Ordinal == planLastOrdinal(record.ActionPlan) {
			return acquireExternalEvidence(evidenceRequirementRollbackRoots), nil
		}
		return completePendingAction(record, "", RootIdentity{})
	}
	return failedClosedOutOfBand(FailureRootIdentityAmbiguous), nil
}

func classifySCMObservation(
	record TransactionRecord,
	action PendingAction,
	observation scmActionObservation,
) scmObservationClassification {
	if !scmActionValue(record.PendingAction) || !scmActionValue(action) ||
		!pendingActionsEqual(record.PendingAction, action) {
		return scmClassificationUnproved
	}
	recordSHA256, err := canonicalRecordPayloadDigest(record)
	if err != nil {
		return scmClassificationUnproved
	}
	if observation.transactionID != record.TransactionID || observation.recordSHA256 != recordSHA256 ||
		observation.recordSequence != record.RecordSequence || observation.plan != record.ActionPlan ||
		observation.ordinal != action.ActionOrdinal() || observation.actionKind != action.Kind() {
		return scmClassificationUnproved
	}
	switch observation.state {
	case scmObservationExactBefore:
		return scmClassificationExactBefore
	case scmObservationExactTarget:
		return scmClassificationExactTarget
	case scmObservationUnproved:
		return scmClassificationUnproved
	default:
		return scmClassificationUnproved
	}
}

func scmActionValue(action PendingAction) bool {
	switch action.(type) {
	case SCMAction, SCMGenerationAction:
		return true
	default:
		return false
	}
}

func publishIntent(record TransactionRecord, action PendingAction) (reduction, error) {
	next := cloneTransactionRecord(record)
	next.PendingAction = clonePendingAction(action)
	next.BlockedCheckpoint = nil
	sequence, ok := incrementSequence(record.RecordSequence)
	if !ok {
		return failedClosedOutOfBand(FailureDurabilityUnproved), nil
	}
	next.RecordSequence = sequence
	if err := validateSuccessorBindings(record, next, "", RootIdentity{}); err != nil {
		return failedClosedOutOfBand(FailureJournalCorrupt), err
	}
	return reduction{disposition: reductionPublishNextRecord, next: next}, nil
}

func completePendingAction(
	record TransactionRecord,
	createdSlot CandidateRootSlot,
	createdRoot RootIdentity,
) (reduction, error) {
	action := record.PendingAction
	if action == nil {
		return failedClosedOutOfBand(FailureJournalCorrupt),
			fmt.Errorf("%w: pending action is absent", ErrInvalid)
	}
	ordinal := action.ActionOrdinal()
	last := planLastOrdinal(record.ActionPlan)
	if last == 0 || ordinal != record.CompletedActionOrdinal+1 || ordinal > last {
		return failedClosedOutOfBand(FailureJournalCorrupt),
			fmt.Errorf("%w: pending action cursor is inconsistent", ErrInvalid)
	}

	next := cloneTransactionRecord(record)
	if createdSlot != "" {
		if err := setCreatedCandidateRoot(&next, createdSlot, createdRoot); err != nil {
			return failedClosedOutOfBand(FailureRootIdentityAmbiguous), err
		}
		if err := validateRootIdentitySet(next); err != nil {
			return failedClosedOutOfBand(FailureRootIdentityAmbiguous), nil
		}
	}
	next.PendingAction = nil
	next.BlockedCheckpoint = nil
	if ordinal < last {
		next.CompletedActionOrdinal = ordinal
		switch record.ActionPlan {
		case PlanStartCandidateServices:
			next.Phase = PhaseExecutorStarted
		case PlanStartPreviousServices:
			next.RollbackCheckpoint = RollbackExecutorStarted
		}
	} else {
		next.CompletedActionOrdinal = 0
		next.ActionPlan = PlanNone
		switch record.ActionPlan {
		case PlanMaterializeInactive:
			next.Phase = PhaseInactivePackageVerified
		case PlanInitialForward, PlanUpgradeForward:
			next.Phase = PhaseRootSwapInProgress
		case PlanUpgradeRollback:
			return acquireExternalEvidence(evidenceRequirementRollbackRoots), nil
		case PlanSCMMaintenance:
			next.Phase = PhaseSCMMaintenanceFenced
		case PlanStopServices:
			next.Phase = PhaseServicesStopped
		case PlanInitialServiceCreation:
			next.Phase = PhaseServicesConfigured
		case PlanStartCandidateServices:
			next.Phase = PhaseControlStarted
		case PlanStartPreviousServices:
			next.RollbackCheckpoint = RollbackControlStarted
		default:
			return failedClosedOutOfBand(FailureJournalCorrupt),
				fmt.Errorf("%w: action plan completion is unsupported", ErrInvalid)
		}
	}

	sequence, ok := incrementSequence(record.RecordSequence)
	if !ok {
		return failedClosedOutOfBand(FailureDurabilityUnproved), nil
	}
	next.RecordSequence = sequence
	checkpoint, err := derivedBlockedCheckpoint(next)
	if err != nil {
		return failedClosedOutOfBand(FailureJournalCorrupt), err
	}
	next.BlockedCheckpoint = checkpoint
	if err := validateSuccessorBindings(record, next, createdSlot, createdRoot); err != nil {
		return failedClosedOutOfBand(FailureJournalCorrupt), err
	}
	return reduction{disposition: reductionPublishNextRecord, next: next}, nil
}

func setCreatedCandidateRoot(
	record *TransactionRecord,
	slot CandidateRootSlot,
	root RootIdentity,
) error {
	if record == nil || !validRootIdentity(root) {
		return fmt.Errorf("%w: created root input is invalid", ErrInvalid)
	}
	if record.Candidate.Roots == nil {
		record.Candidate.Roots = &CandidateRootSet{}
	}
	var target **RootIdentity
	switch slot {
	case SlotMetadataCandidate:
		target = &record.Candidate.Roots.Metadata
	case SlotInstallationCandidate:
		target = &record.Candidate.Roots.Installation
	case SlotTrustedConfigurationCandidate:
		target = &record.Candidate.Roots.TrustedConfiguration
	default:
		return fmt.Errorf("%w: created candidate slot is invalid", ErrInvalid)
	}
	if *target != nil {
		return fmt.Errorf("%w: created candidate slot already has an identity", ErrInvalid)
	}
	copy := root
	*target = &copy
	return nil
}

func validateSuccessorBindings(
	before TransactionRecord,
	after TransactionRecord,
	createdSlot CandidateRootSlot,
	createdRoot RootIdentity,
) error {
	if err := ValidateRecord(after); err != nil {
		return err
	}
	expectedSequence, ok := incrementSequence(before.RecordSequence)
	if !ok || after.RecordSequence != expectedSequence {
		return fmt.Errorf("%w: successor sequence is not exactly one greater", ErrInvalid)
	}
	if before.TransactionID != after.TransactionID || before.InstallationID != after.InstallationID ||
		before.WorkerNodeID != after.WorkerNodeID || before.Mode != after.Mode ||
		before.TargetArchitecture != after.TargetArchitecture ||
		before.SCMPolicyContractID != after.SCMPolicyContractID ||
		!samePackageGeneration(before.Previous, after.Previous) ||
		!sameFailureCode(before.FailureCode, after.FailureCode) ||
		before.Candidate.PackageID != after.Candidate.PackageID ||
		before.Candidate.ReleaseID != after.Candidate.ReleaseID ||
		before.Candidate.SignedIndexSHA256 != after.Candidate.SignedIndexSHA256 {
		return fmt.Errorf("%w: successor changed an immutable transaction binding", ErrInvalid)
	}
	if createdSlot == "" {
		if !sameCandidateRootSet(before.Candidate.Roots, after.Candidate.Roots) {
			return fmt.Errorf("%w: successor changed candidate root identities", ErrInvalid)
		}
		return nil
	}
	if !validRootIdentity(createdRoot) ||
		!sameCandidateRootSetExcept(before.Candidate.Roots, after.Candidate.Roots, createdSlot, createdRoot) {
		return fmt.Errorf("%w: successor changed candidate roots outside the observed creation", ErrInvalid)
	}
	return nil
}

func sameCandidateRootSetExcept(
	before *CandidateRootSet,
	after *CandidateRootSet,
	slot CandidateRootSlot,
	root RootIdentity,
) bool {
	beforeValues := candidateRootValues(before)
	afterValues := candidateRootValues(after)
	index := -1
	switch slot {
	case SlotInstallationCandidate:
		index = 0
	case SlotMetadataCandidate:
		index = 1
	case SlotTrustedConfigurationCandidate:
		index = 2
	default:
		return false
	}
	if beforeValues[index] != nil || afterValues[index] == nil || *afterValues[index] != root {
		return false
	}
	for candidateIndex := range beforeValues {
		if candidateIndex != index && !sameRootPointer(beforeValues[candidateIndex], afterValues[candidateIndex]) {
			return false
		}
	}
	return true
}

func candidateRootValues(roots *CandidateRootSet) [3]*RootIdentity {
	if roots == nil {
		return [3]*RootIdentity{}
	}
	return [3]*RootIdentity{roots.Installation, roots.Metadata, roots.TrustedConfiguration}
}

func sameCandidateRootSet(left, right *CandidateRootSet) bool {
	leftValues := candidateRootValues(left)
	rightValues := candidateRootValues(right)
	for index := range leftValues {
		if !sameRootPointer(leftValues[index], rightValues[index]) {
			return false
		}
	}
	return true
}

func sameRootPointer(left, right *RootIdentity) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func samePackageGeneration(left, right *PackageGeneration) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func sameFailureCode(left, right *FailureCode) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func cloneTransactionRecord(record TransactionRecord) TransactionRecord {
	result := record
	if record.Candidate.Roots != nil {
		roots := *record.Candidate.Roots
		roots.Installation = cloneRootPointer(roots.Installation)
		roots.Metadata = cloneRootPointer(roots.Metadata)
		roots.TrustedConfiguration = cloneRootPointer(roots.TrustedConfiguration)
		result.Candidate.Roots = &roots
	}
	if record.Previous != nil {
		previous := *record.Previous
		result.Previous = &previous
	}
	if record.FailureCode != nil {
		failure := *record.FailureCode
		result.FailureCode = &failure
	}
	result.PendingAction = clonePendingAction(record.PendingAction)
	result.BlockedCheckpoint = cloneBlockedCheckpoint(record.BlockedCheckpoint)
	return result
}

func cloneRootPointer(root *RootIdentity) *RootIdentity {
	if root == nil {
		return nil
	}
	copy := *root
	return &copy
}

func clonePendingAction(action PendingAction) PendingAction {
	switch value := action.(type) {
	case nil:
		return nil
	case CreateCandidateAction:
		return value
	case PopulateCandidateAction:
		return value
	case RenameAction:
		return value
	case SCMAction:
		return value
	case SCMGenerationAction:
		return value
	default:
		return nil
	}
}

func validateRootSlotObservation(value rootSlotObservation) error {
	switch value.state {
	case rootSlotAbsent:
		if value.root != (RootIdentity{}) {
			return fmt.Errorf("absent root slot carries an identity")
		}
		return nil
	case rootSlotPresent:
		if !validRootIdentity(value.root) {
			return fmt.Errorf("present root slot identity is invalid")
		}
		return nil
	case rootSlotUnknown, rootSlotInaccessible:
		if value.root != (RootIdentity{}) {
			return fmt.Errorf("unproved root slot carries an identity")
		}
		return nil
	default:
		return fmt.Errorf("root slot state is invalid")
	}
}

func incrementSequence(value DecimalUint64) (DecimalUint64, bool) {
	parsed, err := strconv.ParseUint(string(value), 10, 64)
	if err != nil || parsed == ^uint64(0) {
		return "", false
	}
	return DecimalUint64(strconv.FormatUint(parsed+1, 10)), true
}

func retryPendingAction(record TransactionRecord) reduction {
	return reduction{
		disposition: reductionRetryEffect,
		retry:       clonePendingAction(record.PendingAction),
	}
}

func acquireExternalEvidence(requirement evidenceRequirement) reduction {
	return reduction{
		disposition: reductionAcquireExternalEvidence,
		requirement: requirement,
	}
}

func failedClosedOutOfBand(code FailureCode) reduction {
	return reduction{
		disposition: reductionFailedClosedOutOfBand,
		failure:     code,
	}
}

func invalidObservation(code FailureCode, reason string) (reduction, error) {
	return failedClosedOutOfBand(code), fmt.Errorf("%w: %s", ErrInvalid, reason)
}

func observationTypeFailure(action PendingAction) (reduction, error) {
	return invalidObservation(FailureRevalidationFailed,
		fmt.Sprintf("observation does not match pending action %s", action.Kind()))
}
