package installtransaction

import "strings"

const testTransactionID = TransactionID("123e4567-e89b-42d3-a456-426614174000")

func testRoot(digit byte) RootIdentity {
	return RootIdentity{
		FileID:                   FileID(strings.Repeat(string(digit), 32)),
		SecurityDescriptorSHA256: SHA256(strings.Repeat(string(digit), 64)),
		VolumeSerialNumber:       "123456789",
	}
}

func testCandidateRoots() *CandidateRootSet {
	installation := testRoot('1')
	metadata := testRoot('2')
	trusted := testRoot('3')
	return &CandidateRootSet{
		Installation:         &installation,
		Metadata:             &metadata,
		TrustedConfiguration: &trusted,
	}
}

func testPreviousGeneration() *PackageGeneration {
	return &PackageGeneration{
		PackageID: "worker-package-previous",
		ReleaseID: "worker-2026.09.01.1",
		Roots: RootSet{
			Installation:         testRoot('4'),
			Metadata:             testRoot('5'),
			TrustedConfiguration: testRoot('6'),
		},
		SignedIndexSHA256: SHA256(strings.Repeat("7", 64)),
	}
}

func testStagingRecord(mode Mode) TransactionRecord {
	record := TransactionRecord{
		ActionPlan:            PlanNone,
		ActivationPolicyState: ActivationNotApplicable,
		Candidate: CandidateGeneration{
			PackageID:         "worker-package-next",
			ReleaseID:         "worker-2026.09.02.1",
			Roots:             nil,
			SignedIndexSHA256: SHA256(strings.Repeat("8", 64)),
		},
		CompletedActionOrdinal: 0,
		FailureCode:            nil,
		InstallationID:         "installation-node-001",
		Mode:                   mode,
		PendingAction:          nil,
		Phase:                  PhaseStagingVerified,
		Previous:               nil,
		RecordSequence:         "1",
		RollbackCheckpoint:     RollbackNotApplicable,
		TargetArchitecture:     ArchitectureAMD64,
		TransactionID:          testTransactionID,
		WorkerNodeID:           "powertoys-node:01",
	}
	if mode == ModeUpgrade {
		record.Previous = testPreviousGeneration()
	}
	return record
}

func testFullRecord(mode Mode, phase Phase) TransactionRecord {
	record := testStagingRecord(mode)
	record.Candidate.Roots = testCandidateRoots()
	record.Phase = phase
	record.RecordSequence = "20"
	return record
}

func testMaterializeRecord(cursor ActionOrdinal, pending bool) TransactionRecord {
	record := testStagingRecord(ModeInitial)
	record.ActionPlan = PlanMaterializeInactive
	record.RecordSequence = "2"
	record.CompletedActionOrdinal = cursor
	switch cursor {
	case 0:
		record.Candidate.Roots = nil
	case 1, 2:
		metadata := testRoot('2')
		record.Candidate.Roots = &CandidateRootSet{Metadata: &metadata}
	case 3, 4:
		metadata := testRoot('2')
		installation := testRoot('1')
		record.Candidate.Roots = &CandidateRootSet{Metadata: &metadata, Installation: &installation}
	case 5:
		record.Candidate.Roots = testCandidateRoots()
	}
	if pending {
		record.PendingAction, _ = expectedAction(record, record.ActionPlan, cursor+1)
	}
	return record
}

func testPlanRecord(mode Mode, phase Phase, plan ActionPlan, cursor ActionOrdinal, pending bool) TransactionRecord {
	record := testFullRecord(mode, phase)
	record.ActionPlan = plan
	record.CompletedActionOrdinal = cursor
	if pending {
		record.PendingAction, _ = expectedAction(record, plan, cursor+1)
	}
	return record
}

func cloneTestRecord(record TransactionRecord) TransactionRecord {
	result := record
	if record.Candidate.Roots != nil {
		roots := *record.Candidate.Roots
		roots.Installation = cloneTestRootPointer(roots.Installation)
		roots.Metadata = cloneTestRootPointer(roots.Metadata)
		roots.TrustedConfiguration = cloneTestRootPointer(roots.TrustedConfiguration)
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
	return result
}

func cloneTestRootPointer(root *RootIdentity) *RootIdentity {
	if root == nil {
		return nil
	}
	result := *root
	return &result
}
