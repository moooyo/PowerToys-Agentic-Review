package installtransactionv2lab

import (
	"crypto/sha256"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var transactionIDPattern = regexp.MustCompile(
	`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
)

// ValidateRecord proves only syntax and internal blocked-lab consistency.
func ValidateRecord(record TransactionRecord) error {
	if !validTransactionID(record.TransactionID) ||
		!validPackageComponentID(string(record.InstallationID)) ||
		!validEntityID(string(record.WorkerNodeID)) ||
		!validArchitecture(record.TargetArchitecture) ||
		!validMode(record.Mode) ||
		!validPhase(record.Phase) ||
		!validActivationPolicyState(record.ActivationPolicyState) ||
		!validRollbackCheckpoint(record.RollbackCheckpoint) ||
		!validActionPlan(record.ActionPlan) ||
		!validDecimalUint64(record.RecordSequence) ||
		record.SCMPolicyContractID != SCMPolicyContractIdentifier {
		return fmt.Errorf("%w: top-level fields are invalid", ErrInvalid)
	}
	if err := validateCandidateGeneration(record.Candidate); err != nil {
		return err
	}
	if err := validateModeAndPrevious(record); err != nil {
		return err
	}
	if err := validateRootIdentitySet(record); err != nil {
		return err
	}
	if record.RecordSequence == "1" && !firstAuthoritativeRecord(record) {
		return fmt.Errorf("%w: sequence 1 is reserved for the initial staging snapshot", ErrInvalid)
	}
	if record.Phase == PhaseFailedClosed {
		return validateFailedClosedRecord(record)
	}
	if record.FailureCode != nil {
		return fmt.Errorf("%w: failure code is present outside FAILED_CLOSED", ErrInvalid)
	}
	if err := validateActiveRecord(record); err != nil {
		return err
	}
	return validateDerivedBlockedCheckpoint(record)
}

func firstAuthoritativeRecord(record TransactionRecord) bool {
	return record.Phase == PhaseStagingVerified &&
		record.ActionPlan == PlanNone &&
		record.ActivationPolicyState == ActivationNotApplicable &&
		record.BlockedCheckpoint == nil &&
		record.Candidate.Roots == nil &&
		record.CompletedActionOrdinal == 0 &&
		record.PendingAction == nil &&
		record.FailureCode == nil &&
		record.RollbackCheckpoint == RollbackNotApplicable
}

func validateActiveRecord(record TransactionRecord) error {
	switch record.Phase {
	case PhaseStagingVerified:
		if record.ActivationPolicyState != ActivationNotApplicable ||
			record.RollbackCheckpoint != RollbackNotApplicable {
			return invalidState(record, "staging fields are inconsistent")
		}
		switch record.ActionPlan {
		case PlanNone:
			if record.Candidate.Roots != nil || !zeroCursor(record) || record.RecordSequence != "1" {
				return invalidState(record, "initial staging record is not empty")
			}
			return nil
		case PlanMaterializeInactive:
			return validateMaterializePlan(record)
		default:
			return invalidState(record, "staging uses an invalid action plan")
		}

	case PhaseInactivePackageVerified:
		return requireIdleForwardRecord(record)

	case PhaseQuiesced:
		if record.Mode == ModeUpgrade && record.ActionPlan == PlanSCMMaintenance {
			return validateForwardPlan(record)
		}
		return requireIdleForwardRecord(record)

	case PhaseSCMMaintenanceFenced:
		if record.ActionPlan == PlanStopServices {
			return validateForwardPlan(record)
		}
		return requireIdleForwardRecord(record)

	case PhaseServicesStopped:
		return requireIdleForwardRecord(record)

	case PhaseRootSwapInProgress:
		if !completeCandidateRoots(record.Candidate.Roots) ||
			record.ActivationPolicyState != ActivationNotApplicable ||
			record.RollbackCheckpoint != RollbackNotApplicable {
			return invalidState(record, "root-swap fields are inconsistent")
		}
		if record.ActionPlan == PlanNone {
			if !zeroCursor(record) {
				return invalidState(record, "completed root plan retains a cursor")
			}
			return nil
		}
		expected := PlanInitialForward
		if record.Mode == ModeUpgrade {
			expected = PlanUpgradeForward
		}
		if record.ActionPlan != expected {
			return invalidState(record, "root-swap plan does not match mode")
		}
		return validatePlanCursor(record)

	case PhaseDestinationVerified:
		return requireIdleForwardRecord(record)

	case PhaseServiceConfigurationProgress:
		if record.Mode != ModeInitial || record.ActionPlan != PlanInitialServiceCreation {
			return invalidState(record, "service configuration requires the initial creation plan")
		}
		return validateForwardPlan(record)

	case PhaseServicesConfigured:
		if record.ActionPlan == PlanStartCandidateServices {
			return validateForwardPlan(record)
		}
		return requireIdleForwardRecord(record)

	case PhaseExecutorStarted:
		if record.ActionPlan != PlanStartCandidateServices || record.CompletedActionOrdinal != 1 {
			return invalidState(record, "Executor-start checkpoint has an invalid plan cursor")
		}
		return validateForwardPlan(record)

	case PhaseControlStarted:
		return requireIdleForwardRecord(record)

	case PhaseAuthenticatedDisabledReady:
		if record.ActionPlan != PlanCandidateFinalPolicyBlocked ||
			record.ActivationPolicyState != ActivationBlocked ||
			record.RollbackCheckpoint != RollbackNotApplicable || !zeroCursor(record) {
			return invalidState(record, "candidate final-policy checkpoint is not closed")
		}
		return requireCompleteCandidateRoots(record)

	case PhaseRollbackInProgress:
		return validateRollbackRecord(record)

	default:
		return invalidState(record, "phase is not admitted")
	}
}

func validateForwardPlan(record TransactionRecord) error {
	if record.ActivationPolicyState != ActivationNotApplicable ||
		record.RollbackCheckpoint != RollbackNotApplicable {
		return invalidState(record, "forward action plan fields are inconsistent")
	}
	if err := requireCompleteCandidateRoots(record); err != nil {
		return err
	}
	return validatePlanCursor(record)
}

func requireIdleForwardRecord(record TransactionRecord) error {
	if err := requireCompleteCandidateRoots(record); err != nil {
		return err
	}
	if record.ActivationPolicyState != ActivationNotApplicable ||
		record.RollbackCheckpoint != RollbackNotApplicable ||
		record.ActionPlan != PlanNone || !zeroCursor(record) {
		return invalidState(record, "forward checkpoint fields are inconsistent")
	}
	return nil
}

func requireCompleteCandidateRoots(record TransactionRecord) error {
	if !completeCandidateRoots(record.Candidate.Roots) {
		return invalidState(record, "checkpoint lacks complete candidate roots")
	}
	return nil
}

func validateRollbackRecord(record TransactionRecord) error {
	if record.Mode != ModeUpgrade {
		return invalidState(record, "rollback requires upgrade mode")
	}
	if err := requireCompleteCandidateRoots(record); err != nil {
		return err
	}
	switch record.ActionPlan {
	case PlanUpgradeRollback:
		if record.ActivationPolicyState != ActivationNotApplicable ||
			record.RollbackCheckpoint != RollbackNotApplicable {
			return invalidState(record, "root rollback fields are inconsistent")
		}
		return validatePlanCursor(record)

	case PlanStartPreviousServices:
		if record.ActivationPolicyState != ActivationNotApplicable ||
			(record.RollbackCheckpoint != RollbackRootsRestored &&
				record.RollbackCheckpoint != RollbackExecutorStarted) {
			return invalidState(record, "previous service-start fields are inconsistent")
		}
		if record.CompletedActionOrdinal == 0 && record.RollbackCheckpoint != RollbackRootsRestored ||
			record.CompletedActionOrdinal == 1 && record.RollbackCheckpoint != RollbackExecutorStarted {
			return invalidState(record, "previous service-start cursor does not match checkpoint")
		}
		return validatePlanCursor(record)

	case PlanPreviousFinalPolicyBlocked:
		if record.ActivationPolicyState != ActivationBlocked ||
			record.RollbackCheckpoint != RollbackAuthenticatedDisabledReady || !zeroCursor(record) {
			return invalidState(record, "previous final-policy checkpoint is not closed")
		}
		return nil

	case PlanNone:
		if record.ActivationPolicyState != ActivationNotApplicable || !zeroCursor(record) ||
			(record.RollbackCheckpoint != RollbackRootsRestored &&
				record.RollbackCheckpoint != RollbackExecutorStarted &&
				record.RollbackCheckpoint != RollbackControlStarted) {
			return invalidState(record, "idle rollback checkpoint is inconsistent")
		}
		return nil

	default:
		return invalidState(record, "rollback uses an invalid action plan")
	}
}

func validateFailedClosedRecord(record TransactionRecord) error {
	if record.FailureCode == nil || !validFailureCode(*record.FailureCode) {
		return invalidState(record, "FAILED_CLOSED requires a fixed failure code")
	}
	if record.ActionPlan != PlanNone || record.ActivationPolicyState != ActivationNotApplicable ||
		record.BlockedCheckpoint != nil || !zeroCursor(record) {
		return invalidState(record, "FAILED_CLOSED cannot retain executable or blocked-plan data")
	}
	if record.Mode == ModeInitial && record.RollbackCheckpoint != RollbackNotApplicable {
		return invalidState(record, "initial failure retains a rollback checkpoint")
	}
	if record.Candidate.Roots != nil && !completeCandidateRoots(record.Candidate.Roots) {
		return invalidState(record, "failure retains partial candidate roots")
	}
	if record.RollbackCheckpoint != RollbackNotApplicable &&
		(record.Mode != ModeUpgrade ||
			(record.RollbackCheckpoint != RollbackRootsRestored &&
				record.RollbackCheckpoint != RollbackExecutorStarted &&
				record.RollbackCheckpoint != RollbackControlStarted &&
				record.RollbackCheckpoint != RollbackAuthenticatedDisabledReady)) {
		return invalidState(record, "failure retains an invalid rollback checkpoint")
	}
	return nil
}

func validateDerivedBlockedCheckpoint(record TransactionRecord) error {
	expected, err := derivedBlockedCheckpoint(record)
	if err != nil {
		return invalidState(record, "blocked checkpoint cannot be derived")
	}
	if expected == nil {
		if record.BlockedCheckpoint != nil {
			return invalidState(record, "caller supplied an unearned blocked checkpoint")
		}
		if record.ActivationPolicyState == ActivationBlocked {
			return invalidState(record, "blocked activation lacks a derived checkpoint")
		}
		return nil
	}
	if record.PendingAction != nil || !blockedCheckpointsEqual(record.BlockedCheckpoint, expected) {
		return invalidState(record, "blocked checkpoint does not match the exact next plan action")
	}
	finalPolicy := containsBlockedReason(expected.MissingPrerequisites, BlockedCandidateFinalPolicy) ||
		containsBlockedReason(expected.MissingPrerequisites, BlockedPreviousFinalPolicy)
	if finalPolicy != (record.ActivationPolicyState == ActivationBlocked) {
		return invalidState(record, "activation state does not match the derived blocker")
	}
	return nil
}

func validateMaterializePlan(record TransactionRecord) error {
	if record.ActionPlan != PlanMaterializeInactive ||
		record.ActivationPolicyState != ActivationNotApplicable ||
		record.RollbackCheckpoint != RollbackNotApplicable {
		return invalidState(record, "materialization fields are inconsistent")
	}
	if err := validateMaterializeShape(record); err != nil {
		return err
	}
	return validatePlanCursor(record)
}

func validateMaterializeShape(record TransactionRecord) error {
	roots := record.Candidate.Roots
	switch record.CompletedActionOrdinal {
	case 0:
		if roots != nil {
			return invalidState(record, "materialization cursor zero has candidate identities")
		}
	case 1, 2:
		if roots == nil || roots.Metadata == nil || roots.Installation != nil || roots.TrustedConfiguration != nil {
			return invalidState(record, "materialization metadata shape is invalid")
		}
	case 3, 4:
		if roots == nil || roots.Metadata == nil || roots.Installation == nil || roots.TrustedConfiguration != nil {
			return invalidState(record, "materialization installation shape is invalid")
		}
	case 5:
		if !completeCandidateRoots(roots) {
			return invalidState(record, "materialization trusted-configuration shape is invalid")
		}
	default:
		return invalidState(record, "materialization cursor is outside the active plan")
	}
	return nil
}

func validatePlanCursor(record TransactionRecord) error {
	last := planLastOrdinal(record.ActionPlan)
	if last == 0 || record.CompletedActionOrdinal >= last {
		return invalidState(record, "active plan cursor is outside the plan")
	}
	if first := firstBlockedOrdinal(record.ActionPlan); first != 0 &&
		record.CompletedActionOrdinal >= first {
		return invalidState(record, "record crossed a blocked plan ordinal")
	}
	next := record.CompletedActionOrdinal + 1
	expected, err := expectedAction(record, record.ActionPlan, next)
	if err != nil {
		return invalidState(record, "next plan action cannot be derived")
	}
	if len(blockedPrerequisites(record.ActionPlan, expected.Kind())) != 0 {
		if record.PendingAction != nil {
			return invalidState(record, "blocked action was serialized as pending")
		}
		return nil
	}
	if record.CompletedActionOrdinal == 0 && record.PendingAction == nil {
		return invalidState(record, "active plan cursor zero lacks ordinal-1 intent")
	}
	if record.PendingAction == nil {
		return nil
	}
	if !pendingActionsEqual(record.PendingAction, expected) {
		return invalidState(record, "pending action does not match the fixed plan")
	}
	return nil
}

func firstBlockedOrdinal(plan ActionPlan) ActionOrdinal {
	switch plan {
	case PlanSCMMaintenance, PlanStopServices, PlanInitialServiceCreation,
		PlanStartCandidateServices, PlanStartPreviousServices,
		PlanCandidateFinalPolicyBlocked, PlanPreviousFinalPolicyBlocked:
		return 1
	default:
		return 0
	}
}

func blockedCheckpointsEqual(left, right *BlockedCheckpoint) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	if left.ActionKind != right.ActionKind || left.Ordinal != right.Ordinal ||
		left.Plan != right.Plan || len(left.MissingPrerequisites) != len(right.MissingPrerequisites) {
		return false
	}
	for index := range left.MissingPrerequisites {
		if left.MissingPrerequisites[index] != right.MissingPrerequisites[index] {
			return false
		}
	}
	return true
}

func containsBlockedReason(values []BlockedReason, expected BlockedReason) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func validateCandidateGeneration(candidate CandidateGeneration) error {
	if !validPackageComponentID(string(candidate.PackageID)) ||
		!validReleaseID(string(candidate.ReleaseID)) || !validSHA256(candidate.SignedIndexSHA256) {
		return fmt.Errorf("%w: candidate generation identity is invalid", ErrInvalid)
	}
	if candidate.Roots == nil {
		return nil
	}
	for _, root := range []*RootIdentity{
		candidate.Roots.Installation,
		candidate.Roots.Metadata,
		candidate.Roots.TrustedConfiguration,
	} {
		if root != nil && !validRootIdentity(*root) {
			return fmt.Errorf("%w: candidate root identity is invalid", ErrInvalid)
		}
	}
	return nil
}

func validateModeAndPrevious(record TransactionRecord) error {
	switch record.Mode {
	case ModeInitial:
		if record.Previous != nil {
			return fmt.Errorf("%w: initial transaction has a previous generation", ErrInvalid)
		}
	case ModeUpgrade:
		if record.Previous == nil || !validPackageGeneration(*record.Previous) {
			return fmt.Errorf("%w: upgrade transaction lacks a valid previous generation", ErrInvalid)
		}
		if record.Previous.PackageID == record.Candidate.PackageID {
			return fmt.Errorf("%w: upgrade reuses the previous metadata package ID", ErrInvalid)
		}
	default:
		return fmt.Errorf("%w: transaction mode is invalid", ErrInvalid)
	}
	return nil
}

func validPackageGeneration(generation PackageGeneration) bool {
	return validPackageComponentID(string(generation.PackageID)) &&
		validReleaseID(string(generation.ReleaseID)) && validSHA256(generation.SignedIndexSHA256) &&
		validRootIdentity(generation.Roots.Installation) && validRootIdentity(generation.Roots.Metadata) &&
		validRootIdentity(generation.Roots.TrustedConfiguration)
}

func validateRootIdentitySet(record TransactionRecord) error {
	roots := make([]RootIdentity, 0, 6)
	if record.Candidate.Roots != nil {
		for _, root := range []*RootIdentity{
			record.Candidate.Roots.Installation,
			record.Candidate.Roots.Metadata,
			record.Candidate.Roots.TrustedConfiguration,
		} {
			if root != nil {
				roots = append(roots, *root)
			}
		}
	}
	if record.Previous != nil {
		roots = append(roots, record.Previous.Roots.Installation, record.Previous.Roots.Metadata,
			record.Previous.Roots.TrustedConfiguration)
	}
	seen := make(map[string]struct{}, len(roots))
	var volume DecimalUint64
	for _, root := range roots {
		if !validRootIdentity(root) {
			return fmt.Errorf("%w: root identity is invalid", ErrInvalid)
		}
		if volume == "" {
			volume = root.VolumeSerialNumber
		} else if root.VolumeSerialNumber != volume {
			return fmt.Errorf("%w: roots do not share one volume", ErrInvalid)
		}
		key := string(root.VolumeSerialNumber) + "\x00" + string(root.FileID)
		if _, duplicate := seen[key]; duplicate {
			return fmt.Errorf("%w: root filesystem identity is reused", ErrInvalid)
		}
		seen[key] = struct{}{}
	}
	return nil
}

func validRootIdentity(root RootIdentity) bool {
	return len(root.FileID) == 32 && validLowerHex(string(root.FileID)) &&
		validSHA256(root.SecurityDescriptorSHA256) && validDecimalUint64(root.VolumeSerialNumber)
}

func completeCandidateRoots(roots *CandidateRootSet) bool {
	return roots != nil && roots.Installation != nil && roots.Metadata != nil &&
		roots.TrustedConfiguration != nil
}

func zeroCursor(record TransactionRecord) bool {
	return record.CompletedActionOrdinal == 0 && record.PendingAction == nil
}

func invalidState(record TransactionRecord, reason string) error {
	return fmt.Errorf("%w: phase %s: %s", ErrInvalid, record.Phase, reason)
}

func validTransactionID(value TransactionID) bool {
	return transactionIDPattern.MatchString(string(value))
}

func validArchitecture(value TargetArchitecture) bool {
	return value == ArchitectureAMD64 || value == ArchitectureARM64
}

func validMode(value Mode) bool { return value == ModeInitial || value == ModeUpgrade }

func validPhase(value Phase) bool {
	switch value {
	case PhaseStagingVerified, PhaseInactivePackageVerified, PhaseQuiesced,
		PhaseSCMMaintenanceFenced, PhaseServicesStopped, PhaseRootSwapInProgress,
		PhaseDestinationVerified, PhaseServiceConfigurationProgress, PhaseServicesConfigured,
		PhaseExecutorStarted, PhaseControlStarted, PhaseAuthenticatedDisabledReady,
		PhaseRollbackInProgress, PhaseFailedClosed:
		return true
	default:
		return false
	}
}

func validActivationPolicyState(value ActivationPolicyState) bool {
	return value == ActivationNotApplicable || value == ActivationBlocked
}

func validRollbackCheckpoint(value RollbackCheckpoint) bool {
	switch value {
	case RollbackNotApplicable, RollbackRootsRestored, RollbackExecutorStarted,
		RollbackControlStarted, RollbackAuthenticatedDisabledReady:
		return true
	default:
		return false
	}
}

func validActionPlan(value ActionPlan) bool {
	switch value {
	case PlanNone, PlanMaterializeInactive, PlanInitialForward, PlanUpgradeForward,
		PlanUpgradeRollback, PlanSCMMaintenance, PlanStopServices, PlanInitialServiceCreation,
		PlanStartCandidateServices, PlanStartPreviousServices, PlanCandidateFinalPolicyBlocked,
		PlanPreviousFinalPolicyBlocked:
		return true
	default:
		return false
	}
}

func validFailureCode(value FailureCode) bool {
	switch value {
	case FailureJournalCorrupt, FailureNamespaceAmbiguous, FailureDurabilityUnproved,
		FailureRootIdentityAmbiguous, FailureRevalidationFailed, FailureSCMUnproved,
		FailureReadinessUnproved:
		return true
	default:
		return false
	}
}

func validSHA256(value SHA256) bool {
	return len(value) == sha256.Size*2 && validLowerHex(string(value))
}

func validLowerHex(value string) bool {
	for _, character := range value {
		if character < '0' || character > '9' {
			if character < 'a' || character > 'f' {
				return false
			}
		}
	}
	return true
}

func validDecimalUint64(value DecimalUint64) bool {
	if value == "" || value == "0" || value[0] == '0' {
		return false
	}
	parsed, err := strconv.ParseUint(string(value), 10, 64)
	return err == nil && parsed != 0 && strconv.FormatUint(parsed, 10) == string(value)
}

func validEntityID(value string) bool {
	if len(value) == 0 || len(value) > 128 || !asciiAlphaNumeric(value[0]) {
		return false
	}
	for _, character := range []byte(value[1:]) {
		if asciiAlphaNumeric(character) || strings.ContainsRune("._:-", rune(character)) {
			continue
		}
		return false
	}
	return true
}

func validReleaseID(value string) bool {
	if len(value) == 0 || len(value) > 128 || !asciiAlphaNumeric(value[0]) {
		return false
	}
	for _, character := range []byte(value[1:]) {
		if asciiAlphaNumeric(character) || strings.ContainsRune("._+-", rune(character)) {
			continue
		}
		return false
	}
	return true
}

func validPackageComponentID(value string) bool {
	if len(value) == 0 || len(value) > 128 ||
		!(value[0] >= 'a' && value[0] <= 'z' || value[0] >= '0' && value[0] <= '9') ||
		invalidPathComponent(value) {
		return false
	}
	for _, character := range []byte(value[1:]) {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' ||
			strings.ContainsRune("._+-", rune(character)) {
			continue
		}
		return false
	}
	return true
}

func invalidPathComponent(component string) bool {
	if component == "" || component == "." || component == ".." || strings.HasSuffix(component, ".") ||
		strings.HasSuffix(component, " ") || strings.ContainsAny(component, `<>"|?*`) {
		return true
	}
	base := strings.ToUpper(strings.SplitN(component, ".", 2)[0])
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
		base == "CONIN$" || base == "CONOUT$" || base == "CLOCK$" {
		return true
	}
	return len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) &&
		base[3] >= '1' && base[3] <= '9'
}

func asciiAlphaNumeric(value byte) bool {
	return value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z' ||
		value >= '0' && value <= '9'
}
