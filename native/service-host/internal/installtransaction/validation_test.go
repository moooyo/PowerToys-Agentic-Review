package installtransaction

import (
	"errors"
	"testing"
)

func TestValidateRecordAcceptsCompleteStateMatrix(t *testing.T) {
	tests := []struct {
		name   string
		record TransactionRecord
	}{
		{name: "initial staging", record: testStagingRecord(ModeInitial)},
		{name: "upgrade staging", record: testStagingRecord(ModeUpgrade)},
	}

	for cursor := ActionOrdinal(0); cursor < 6; cursor++ {
		tests = append(tests, struct {
			name   string
			record TransactionRecord
		}{name: "materialize pending cursor " + string(rune('0'+cursor)), record: testMaterializeRecord(cursor, true)})
		if cursor > 0 {
			tests = append(tests, struct {
				name   string
				record TransactionRecord
			}{name: "materialize completed cursor " + string(rune('0'+cursor)), record: testMaterializeRecord(cursor, false)})
		}
	}

	for _, mode := range []Mode{ModeInitial, ModeUpgrade} {
		for _, phase := range []Phase{
			PhaseInactivePackageVerified,
			PhaseQuiesced,
			PhaseSCMMaintenanceFenced,
			PhaseServicesStopped,
			PhaseDestinationVerified,
			PhaseExecutorStarted,
			PhaseControlStarted,
			PhaseAuthenticatedDisabledReady,
		} {
			tests = append(tests, struct {
				name   string
				record TransactionRecord
			}{name: string(mode) + " " + string(phase), record: testFullRecord(mode, phase)})
		}
	}

	appendPlanStates := func(name string, record TransactionRecord, last ActionOrdinal) {
		for cursor := ActionOrdinal(0); cursor < last; cursor++ {
			pendingRecord := cloneTestRecord(record)
			pendingRecord.CompletedActionOrdinal = cursor
			pendingRecord.PendingAction, _ = expectedAction(pendingRecord, pendingRecord.ActionPlan, cursor+1)
			tests = append(tests, struct {
				name   string
				record TransactionRecord
			}{name: name + " pending " + string(rune('0'+cursor)), record: pendingRecord})
			if cursor > 0 {
				completedRecord := cloneTestRecord(record)
				completedRecord.CompletedActionOrdinal = cursor
				tests = append(tests, struct {
					name   string
					record TransactionRecord
				}{name: name + " completed " + string(rune('0'+cursor)), record: completedRecord})
			}
		}
	}

	initialForward := testPlanRecord(ModeInitial, PhaseRootSwapInProgress, PlanInitialForward, 0, false)
	appendPlanStates("initial forward", initialForward, 3)
	upgradeForward := testPlanRecord(ModeUpgrade, PhaseRootSwapInProgress, PlanUpgradeForward, 0, false)
	appendPlanStates("upgrade forward", upgradeForward, 5)
	tests = append(tests,
		struct {
			name   string
			record TransactionRecord
		}{name: "initial forward complete", record: testFullRecord(ModeInitial, PhaseRootSwapInProgress)},
		struct {
			name   string
			record TransactionRecord
		}{name: "upgrade forward complete", record: testFullRecord(ModeUpgrade, PhaseRootSwapInProgress)},
	)

	committedPending := testPlanRecord(ModeInitial, PhaseCommitted, PlanCandidateActivationPolicy, 0, false)
	committedPending.ActivationPolicyState = ActivationPending
	appendPlanStates("candidate policy", committedPending, 2)
	committedApplied := testFullRecord(ModeInitial, PhaseCommitted)
	committedApplied.ActivationPolicyState = ActivationApplied
	tests = append(tests, struct {
		name   string
		record TransactionRecord
	}{name: "committed applied", record: committedApplied})

	rollbackRoot := testPlanRecord(ModeUpgrade, PhaseRollbackInProgress, PlanUpgradeRollback, 0, false)
	appendPlanStates("upgrade rollback", rollbackRoot, 4)
	for _, checkpoint := range []RollbackCheckpoint{
		RollbackRootsRestored,
		RollbackExecutorStarted,
		RollbackControlStarted,
		RollbackAuthenticatedDisabledReady,
	} {
		record := testFullRecord(ModeUpgrade, PhaseRollbackInProgress)
		record.RollbackCheckpoint = checkpoint
		tests = append(tests, struct {
			name   string
			record TransactionRecord
		}{name: "rollback " + string(checkpoint), record: record})
	}
	rollbackPolicy := testPlanRecord(ModeUpgrade, PhaseRollbackInProgress, PlanRollbackActivationPolicy, 0, false)
	rollbackPolicy.ActivationPolicyState = ActivationPending
	rollbackPolicy.RollbackCheckpoint = RollbackAuthenticatedDisabledReady
	appendPlanStates("rollback policy", rollbackPolicy, 2)
	rolledBack := testFullRecord(ModeUpgrade, PhaseRolledBack)
	rolledBack.ActivationPolicyState = ActivationApplied
	rolledBack.RollbackCheckpoint = RollbackAuthenticatedDisabledReady
	tests = append(tests, struct {
		name   string
		record TransactionRecord
	}{name: "rolled back", record: rolledBack})

	failure := FailureRevalidationFailed
	failedStaging := testStagingRecord(ModeInitial)
	failedStaging.Phase = PhaseFailedClosed
	failedStaging.RecordSequence = "2"
	failedStaging.FailureCode = &failure
	failedForward := testFullRecord(ModeInitial, PhaseFailedClosed)
	failedForward.FailureCode = &failure
	failedMaterialize := testMaterializeRecord(3, true)
	failedMaterialize.Phase = PhaseFailedClosed
	failedMaterialize.FailureCode = &failure
	failedRollback := cloneTestRecord(rollbackPolicy)
	failedRollback.Phase = PhaseFailedClosed
	failedRollback.PendingAction, _ = expectedAction(failedRollback, failedRollback.ActionPlan, 1)
	failedRollback.FailureCode = &failure
	tests = append(tests,
		struct {
			name   string
			record TransactionRecord
		}{name: "failed staging", record: failedStaging},
		struct {
			name   string
			record TransactionRecord
		}{name: "failed forward idle", record: failedForward},
		struct {
			name   string
			record TransactionRecord
		}{name: "failed materialize", record: failedMaterialize},
		struct {
			name   string
			record TransactionRecord
		}{name: "failed rollback policy", record: failedRollback},
	)

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := ValidateRecord(test.record); err != nil {
				t.Fatalf("ValidateRecord returned %v", err)
			}
		})
	}
}

func TestValidateRecordRejectsInvalidStateAndIdentityCombinations(t *testing.T) {
	base := testFullRecord(ModeInitial, PhaseInactivePackageVerified)
	invalidFailure := FailureCode("OTHER")
	failure := FailureRevalidationFailed
	tests := []struct {
		name   string
		mutate func(*TransactionRecord)
	}{
		{name: "transaction UUID", mutate: func(value *TransactionRecord) { value.TransactionID = "not-a-uuid" }},
		{name: "installation ID", mutate: func(value *TransactionRecord) { value.InstallationID = "CON" }},
		{name: "worker node ID", mutate: func(value *TransactionRecord) { value.WorkerNodeID = " bad" }},
		{name: "architecture", mutate: func(value *TransactionRecord) { value.TargetArchitecture = "x86" }},
		{name: "mode", mutate: func(value *TransactionRecord) { value.Mode = "other" }},
		{name: "phase", mutate: func(value *TransactionRecord) { value.Phase = "OTHER" }},
		{name: "activation", mutate: func(value *TransactionRecord) { value.ActivationPolicyState = "other" }},
		{name: "rollback checkpoint", mutate: func(value *TransactionRecord) { value.RollbackCheckpoint = "other" }},
		{name: "plan", mutate: func(value *TransactionRecord) { value.ActionPlan = "other" }},
		{name: "record sequence zero", mutate: func(value *TransactionRecord) { value.RecordSequence = "0" }},
		{name: "record sequence leading zero", mutate: func(value *TransactionRecord) { value.RecordSequence = "020" }},
		{name: "package ID", mutate: func(value *TransactionRecord) { value.Candidate.PackageID = "UPPER" }},
		{name: "release ID", mutate: func(value *TransactionRecord) { value.Candidate.ReleaseID = "bad/release" }},
		{name: "index digest", mutate: func(value *TransactionRecord) { value.Candidate.SignedIndexSHA256 = "abc" }},
		{name: "root file ID", mutate: func(value *TransactionRecord) { value.Candidate.Roots.Metadata.FileID = "ABC" }},
		{name: "root security digest", mutate: func(value *TransactionRecord) { value.Candidate.Roots.Metadata.SecurityDescriptorSHA256 = "abc" }},
		{name: "root volume", mutate: func(value *TransactionRecord) { value.Candidate.Roots.Metadata.VolumeSerialNumber = "0" }},
		{name: "cross volume", mutate: func(value *TransactionRecord) { value.Candidate.Roots.Metadata.VolumeSerialNumber = "2" }},
		{name: "root alias", mutate: func(value *TransactionRecord) {
			value.Candidate.Roots.Metadata.FileID = value.Candidate.Roots.Installation.FileID
		}},
		{name: "initial previous", mutate: func(value *TransactionRecord) { value.Previous = testPreviousGeneration() }},
		{name: "missing full roots", mutate: func(value *TransactionRecord) { value.Candidate.Roots.TrustedConfiguration = nil }},
		{name: "failure outside terminal", mutate: func(value *TransactionRecord) { value.FailureCode = &failure }},
		{name: "non-idle checkpoint", mutate: func(value *TransactionRecord) { value.RollbackCheckpoint = RollbackRootsRestored }},
		{name: "non-idle plan", mutate: func(value *TransactionRecord) { value.ActionPlan = PlanInitialForward }},
		{name: "unknown failure code", mutate: func(value *TransactionRecord) { value.Phase = PhaseFailedClosed; value.FailureCode = &invalidFailure }},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			record := cloneTestRecord(base)
			test.mutate(&record)
			if err := ValidateRecord(record); !errors.Is(err, ErrInvalid) {
				t.Fatalf("ValidateRecord returned %v, want ErrInvalid", err)
			}
		})
	}
}

func TestValidateRecordRejectsMaterializationShapeAndCursorAttacks(t *testing.T) {
	tests := []struct {
		name   string
		record func() TransactionRecord
	}{
		{name: "active cursor zero without intent", record: func() TransactionRecord { return testMaterializeRecord(0, false) }},
		{name: "cursor at last ordinal", record: func() TransactionRecord {
			record := testMaterializeRecord(5, false)
			record.CompletedActionOrdinal = 6
			return record
		}},
		{name: "metadata filled before create", record: func() TransactionRecord {
			record := testMaterializeRecord(0, true)
			metadata := testRoot('2')
			record.Candidate.Roots = &CandidateRootSet{Metadata: &metadata}
			return record
		}},
		{name: "installation filled before create", record: func() TransactionRecord {
			record := testMaterializeRecord(1, false)
			installation := testRoot('1')
			record.Candidate.Roots.Installation = &installation
			return record
		}},
		{name: "trusted filled before create", record: func() TransactionRecord {
			record := testMaterializeRecord(3, false)
			trusted := testRoot('3')
			record.Candidate.Roots.TrustedConfiguration = &trusted
			return record
		}},
		{name: "populate expected identity changed", record: func() TransactionRecord {
			record := testMaterializeRecord(1, true)
			action := record.PendingAction.(PopulateCandidateAction)
			action.ExpectedRoot = testRoot('9')
			record.PendingAction = action
			return record
		}},
		{name: "pending ordinal skipped", record: func() TransactionRecord {
			record := testMaterializeRecord(1, true)
			action := record.PendingAction.(PopulateCandidateAction)
			action.Ordinal = 3
			record.PendingAction = action
			return record
		}},
		{name: "pending pointer concrete type", record: func() TransactionRecord {
			record := testMaterializeRecord(0, true)
			action := record.PendingAction.(CreateCandidateAction)
			record.PendingAction = &action
			return record
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := ValidateRecord(test.record()); !errors.Is(err, ErrInvalid) {
				t.Fatalf("ValidateRecord returned %v, want ErrInvalid", err)
			}
		})
	}
}

func TestValidateRecordRejectsCommitRollbackAndFailureAttacks(t *testing.T) {
	failure := FailureSCMUnproved
	tests := []struct {
		name   string
		record func() TransactionRecord
	}{
		{name: "committed not applicable", record: func() TransactionRecord { return testFullRecord(ModeInitial, PhaseCommitted) }},
		{name: "committed pending without plan", record: func() TransactionRecord {
			record := testFullRecord(ModeInitial, PhaseCommitted)
			record.ActivationPolicyState = ActivationPending
			return record
		}},
		{name: "committed applied with plan", record: func() TransactionRecord {
			record := testPlanRecord(ModeInitial, PhaseCommitted, PlanCandidateActivationPolicy, 0, true)
			record.ActivationPolicyState = ActivationApplied
			return record
		}},
		{name: "initial rollback", record: func() TransactionRecord {
			record := testFullRecord(ModeInitial, PhaseRollbackInProgress)
			record.RollbackCheckpoint = RollbackRootsRestored
			return record
		}},
		{name: "rollback missing checkpoint", record: func() TransactionRecord { return testFullRecord(ModeUpgrade, PhaseRollbackInProgress) }},
		{name: "rollback policy without pending activation", record: func() TransactionRecord {
			record := testPlanRecord(ModeUpgrade, PhaseRollbackInProgress, PlanRollbackActivationPolicy, 0, true)
			record.RollbackCheckpoint = RollbackAuthenticatedDisabledReady
			return record
		}},
		{name: "rolled back not applied", record: func() TransactionRecord {
			record := testFullRecord(ModeUpgrade, PhaseRolledBack)
			record.RollbackCheckpoint = RollbackAuthenticatedDisabledReady
			return record
		}},
		{name: "failed without code", record: func() TransactionRecord { return testFullRecord(ModeInitial, PhaseFailedClosed) }},
		{name: "failed idle partial roots", record: func() TransactionRecord {
			record := testFullRecord(ModeInitial, PhaseFailedClosed)
			record.Candidate.Roots.TrustedConfiguration = nil
			record.FailureCode = &failure
			return record
		}},
		{name: "failed idle applied", record: func() TransactionRecord {
			record := testFullRecord(ModeInitial, PhaseFailedClosed)
			record.ActivationPolicyState = ActivationApplied
			record.FailureCode = &failure
			return record
		}},
		{name: "committed policy converted to failed", record: func() TransactionRecord {
			record := testPlanRecord(ModeInitial, PhaseFailedClosed, PlanCandidateActivationPolicy, 0, true)
			record.ActivationPolicyState = ActivationPending
			record.FailureCode = &failure
			return record
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := ValidateRecord(test.record()); !errors.Is(err, ErrInvalid) {
				t.Fatalf("ValidateRecord returned %v, want ErrInvalid", err)
			}
		})
	}
}

func TestValidateRecordReservesSequenceOneForInitialStagingSnapshot(t *testing.T) {
	failure := FailureRevalidationFailed
	failed := testStagingRecord(ModeInitial)
	failed.Phase = PhaseFailedClosed
	failed.FailureCode = &failure
	materialize := testMaterializeRecord(0, true)
	materialize.RecordSequence = "1"
	later := testFullRecord(ModeInitial, PhaseInactivePackageVerified)
	later.RecordSequence = "1"
	for name, record := range map[string]TransactionRecord{
		"active plan":   materialize,
		"later phase":   later,
		"failed closed": failed,
	} {
		t.Run(name, func(t *testing.T) {
			if err := ValidateRecord(record); !errors.Is(err, ErrInvalid) {
				t.Fatalf("ValidateRecord returned %v, want ErrInvalid", err)
			}
		})
	}
}
