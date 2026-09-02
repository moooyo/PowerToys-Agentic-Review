package installtransaction

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

// ValidateRecord proves only syntax and internal state-matrix consistency.
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
		!validDecimalUint64(record.RecordSequence) {
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
		return fmt.Errorf("%w: record sequence 1 is reserved for the initial staging snapshot", ErrInvalid)
	}
	if record.Phase == PhaseFailedClosed {
		return validateFailedClosedRecord(record)
	}
	if record.FailureCode != nil {
		return fmt.Errorf("%w: failure code is present outside FAILED_CLOSED", ErrInvalid)
	}
	return validateActiveRecord(record)
}

func firstAuthoritativeRecord(record TransactionRecord) bool {
	return record.Phase == PhaseStagingVerified && record.ActionPlan == PlanNone &&
		record.ActivationPolicyState == ActivationNotApplicable && record.Candidate.Roots == nil &&
		record.CompletedActionOrdinal == 0 && record.PendingAction == nil && record.FailureCode == nil &&
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

	case PhaseInactivePackageVerified, PhaseQuiesced, PhaseSCMMaintenanceFenced, PhaseServicesStopped:
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
		expectedPlan := PlanInitialForward
		if record.Mode == ModeUpgrade {
			expectedPlan = PlanUpgradeForward
		}
		if record.ActionPlan != expectedPlan {
			return invalidState(record, "root-swap plan does not match mode")
		}
		return validatePlanCursor(record)

	case PhaseDestinationVerified, PhaseExecutorStarted, PhaseControlStarted, PhaseAuthenticatedDisabledReady:
		return requireIdleForwardRecord(record)

	case PhaseCommitted:
		if !completeCandidateRoots(record.Candidate.Roots) ||
			record.RollbackCheckpoint != RollbackNotApplicable {
			return invalidState(record, "committed fields are inconsistent")
		}
		switch record.ActivationPolicyState {
		case ActivationPending:
			if record.ActionPlan != PlanCandidateActivationPolicy {
				return invalidState(record, "committed pending record lacks candidate policy plan")
			}
			return validatePlanCursor(record)
		case ActivationApplied:
			if record.ActionPlan != PlanNone || !zeroCursor(record) {
				return invalidState(record, "committed applied record retains a plan")
			}
			return nil
		default:
			return invalidState(record, "committed activation state is invalid")
		}

	case PhaseRollbackInProgress:
		return validateRollbackRecord(record)

	case PhaseRolledBack:
		if record.Mode != ModeUpgrade || !completeCandidateRoots(record.Candidate.Roots) ||
			record.ActivationPolicyState != ActivationApplied ||
			record.RollbackCheckpoint != RollbackAuthenticatedDisabledReady ||
			record.ActionPlan != PlanNone || !zeroCursor(record) {
			return invalidState(record, "rolled-back terminal fields are inconsistent")
		}
		return nil

	default:
		return invalidState(record, "phase is not admitted")
	}
}

func requireIdleForwardRecord(record TransactionRecord) error {
	if !completeCandidateRoots(record.Candidate.Roots) ||
		record.ActivationPolicyState != ActivationNotApplicable ||
		record.RollbackCheckpoint != RollbackNotApplicable ||
		record.ActionPlan != PlanNone || !zeroCursor(record) {
		return invalidState(record, "forward checkpoint fields are inconsistent")
	}
	return nil
}

func validateRollbackRecord(record TransactionRecord) error {
	if record.Mode != ModeUpgrade || !completeCandidateRoots(record.Candidate.Roots) {
		return invalidState(record, "rollback requires a complete upgrade record")
	}
	switch record.ActionPlan {
	case PlanUpgradeRollback:
		if record.ActivationPolicyState != ActivationNotApplicable ||
			record.RollbackCheckpoint != RollbackNotApplicable {
			return invalidState(record, "root rollback fields are inconsistent")
		}
		return validatePlanCursor(record)
	case PlanRollbackActivationPolicy:
		if record.ActivationPolicyState != ActivationPending ||
			record.RollbackCheckpoint != RollbackAuthenticatedDisabledReady {
			return invalidState(record, "rollback policy fields are inconsistent")
		}
		return validatePlanCursor(record)
	case PlanNone:
		if record.ActivationPolicyState != ActivationNotApplicable || !zeroCursor(record) ||
			(record.RollbackCheckpoint != RollbackRootsRestored &&
				record.RollbackCheckpoint != RollbackExecutorStarted &&
				record.RollbackCheckpoint != RollbackControlStarted &&
				record.RollbackCheckpoint != RollbackAuthenticatedDisabledReady) {
			return invalidState(record, "rollback checkpoint fields are inconsistent")
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
	if record.Mode == ModeInitial && record.RollbackCheckpoint != RollbackNotApplicable {
		return invalidState(record, "initial failure retains a rollback checkpoint")
	}
	if record.ActionPlan == PlanNone {
		if !zeroCursor(record) || record.ActivationPolicyState != ActivationNotApplicable {
			return invalidState(record, "idle failure retains invalid cursor or activation state")
		}
		if record.Candidate.Roots == nil {
			if record.RollbackCheckpoint != RollbackNotApplicable {
				return invalidState(record, "empty failure retains a rollback checkpoint")
			}
			return nil
		}
		if !completeCandidateRoots(record.Candidate.Roots) {
			return invalidState(record, "idle failure retains partial candidate roots")
		}
		if record.RollbackCheckpoint == RollbackNotApplicable {
			return nil
		}
		if record.Mode != ModeUpgrade ||
			(record.RollbackCheckpoint != RollbackRootsRestored &&
				record.RollbackCheckpoint != RollbackExecutorStarted &&
				record.RollbackCheckpoint != RollbackControlStarted &&
				record.RollbackCheckpoint != RollbackAuthenticatedDisabledReady) {
			return invalidState(record, "idle failure retains an invalid rollback checkpoint")
		}
		return nil
	}
	if err := validateFailedPlanCompatibility(record); err != nil {
		return err
	}
	if record.ActionPlan == PlanMaterializeInactive {
		if err := validateMaterializeShape(record); err != nil {
			return err
		}
	} else if !completeCandidateRoots(record.Candidate.Roots) {
		return invalidState(record, "non-materialization failure lacks complete candidate roots")
	}
	return validatePlanCursor(record)
}

func validateFailedPlanCompatibility(record TransactionRecord) error {
	switch record.ActionPlan {
	case PlanMaterializeInactive, PlanInitialForward:
		if record.Mode != ModeInitial && record.ActionPlan == PlanInitialForward {
			return invalidState(record, "initial forward failure has upgrade mode")
		}
		if record.ActivationPolicyState != ActivationNotApplicable ||
			record.RollbackCheckpoint != RollbackNotApplicable {
			return invalidState(record, "forward failure retains invalid policy or rollback fields")
		}
	case PlanUpgradeForward, PlanUpgradeRollback:
		if record.Mode != ModeUpgrade || record.ActivationPolicyState != ActivationNotApplicable {
			return invalidState(record, "upgrade plan failure fields are inconsistent")
		}
		if record.ActionPlan == PlanUpgradeForward && record.RollbackCheckpoint != RollbackNotApplicable ||
			record.ActionPlan == PlanUpgradeRollback && record.RollbackCheckpoint != RollbackNotApplicable {
			return invalidState(record, "root plan failure retains a rollback checkpoint")
		}
	case PlanCandidateActivationPolicy:
		return invalidState(record, "committed candidate policy cannot become FAILED_CLOSED")
	case PlanRollbackActivationPolicy:
		if record.Mode != ModeUpgrade || record.ActivationPolicyState != ActivationPending ||
			record.RollbackCheckpoint != RollbackAuthenticatedDisabledReady {
			return invalidState(record, "rollback policy failure fields are inconsistent")
		}
	default:
		return invalidState(record, "failure retains an unknown plan")
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
	if record.CompletedActionOrdinal == 0 && record.PendingAction == nil {
		return invalidState(record, "active plan cursor zero lacks ordinal-1 intent")
	}
	if record.PendingAction == nil {
		if record.CompletedActionOrdinal < 1 {
			return invalidState(record, "active plan lacks a completed cursor")
		}
		if _, err := expectedAction(record, record.ActionPlan, record.CompletedActionOrdinal+1); err != nil {
			return invalidState(record, "next plan action cannot be derived")
		}
		return nil
	}
	expected, err := expectedAction(record, record.ActionPlan, record.CompletedActionOrdinal+1)
	if err != nil || !pendingActionsEqual(record.PendingAction, expected) {
		return invalidState(record, "pending action does not match the fixed plan")
	}
	return nil
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
		PhaseDestinationVerified, PhaseExecutorStarted, PhaseControlStarted,
		PhaseAuthenticatedDisabledReady, PhaseCommitted, PhaseRollbackInProgress,
		PhaseRolledBack, PhaseFailedClosed:
		return true
	default:
		return false
	}
}

func validActivationPolicyState(value ActivationPolicyState) bool {
	return value == ActivationNotApplicable || value == ActivationPending || value == ActivationApplied
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
		PlanUpgradeRollback, PlanCandidateActivationPolicy, PlanRollbackActivationPolicy:
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
