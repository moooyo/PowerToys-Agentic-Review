package installstorev2lab

type expectedHeadSchema uint8

const (
	expectedHeadSchemaInvalid expectedHeadSchema = iota
	expectedHeadSchemaV1
	expectedHeadSchemaV2
)

type entryResidueKind uint8

const (
	entryResidueNone entryResidueKind = iota
	entryResidueMigrationStagingEmpty
	entryResidueMigrationStagingWALEmpty
	entryResidueMigrationStagingEntryTemporary
	entryResidueMigrationStagingEntryFinal
	entryResidueCurrentTailEntryTemporary
	entryResidueCurrentTailFinalSuccessor
	entryResidueMigrationCanonicalGenesis
	entryResidueSelectedV1RecordTemporary
)

type recoveryResidueShape uint8

const (
	recoveryResidueUntrusted recoveryResidueShape = iota
	recoveryResidueCleanV1
	recoveryResidueA
	recoveryResidueB
	recoveryResidueC
	recoveryResidueD
	recoveryResidueE
	recoveryResidueV
)

// residueObservation contains only facts a future native verifier would have
// to prove. It is package-private ordinary data and grants no cleanup authority.
type residueObservation struct {
	expectedSchema                   expectedHeadSchema
	authoritativeHeadValid           bool
	selectedDocumentValid            bool
	namespacePhysicalFactsExact      bool
	entryResidue                     entryResidueKind
	entryResidueCount                uint64
	headTemporaryCount               uint64
	stagingPhysicalShapeExact        bool
	entryTemporaryPhysicalExact      bool
	currentTailFinalSuccessorExact   bool
	migrationGenesisExact            bool
	selectedV1TemporaryPhysicalExact bool
}

func classifyRecoveryResidue(observation residueObservation) recoveryResidueShape {
	if (observation.expectedSchema != expectedHeadSchemaV1 &&
		observation.expectedSchema != expectedHeadSchemaV2) ||
		!observation.authoritativeHeadValid || !observation.selectedDocumentValid ||
		!observation.namespacePhysicalFactsExact || observation.entryResidueCount > 1 ||
		observation.headTemporaryCount > 1 || !residueProofsAreClosed(observation) {
		return recoveryResidueUntrusted
	}

	switch observation.entryResidue {
	case entryResidueNone:
		if observation.entryResidueCount != 0 {
			return recoveryResidueUntrusted
		}
		if observation.headTemporaryCount == 1 {
			return recoveryResidueE
		}
		if observation.expectedSchema == expectedHeadSchemaV2 {
			return recoveryResidueD
		}
		return recoveryResidueCleanV1

	case entryResidueMigrationStagingEmpty,
		entryResidueMigrationStagingWALEmpty,
		entryResidueMigrationStagingEntryTemporary,
		entryResidueMigrationStagingEntryFinal:
		if observation.expectedSchema == expectedHeadSchemaV1 && observation.entryResidueCount == 1 &&
			observation.headTemporaryCount == 0 && observation.stagingPhysicalShapeExact {
			return recoveryResidueA
		}

	case entryResidueCurrentTailEntryTemporary:
		if observation.expectedSchema == expectedHeadSchemaV2 && observation.entryResidueCount == 1 &&
			observation.headTemporaryCount == 0 && observation.entryTemporaryPhysicalExact {
			return recoveryResidueB
		}

	case entryResidueCurrentTailFinalSuccessor:
		if observation.expectedSchema == expectedHeadSchemaV2 && observation.entryResidueCount == 1 &&
			observation.headTemporaryCount <= 1 && observation.currentTailFinalSuccessorExact {
			return recoveryResidueC
		}

	case entryResidueMigrationCanonicalGenesis:
		if observation.expectedSchema == expectedHeadSchemaV1 && observation.entryResidueCount == 1 &&
			observation.headTemporaryCount <= 1 && observation.migrationGenesisExact {
			return recoveryResidueC
		}

	case entryResidueSelectedV1RecordTemporary:
		if observation.expectedSchema == expectedHeadSchemaV1 && observation.entryResidueCount == 1 &&
			observation.headTemporaryCount == 0 && observation.selectedV1TemporaryPhysicalExact {
			return recoveryResidueV
		}
	}
	return recoveryResidueUntrusted
}

func residueProofsAreClosed(observation residueObservation) bool {
	staging := observation.stagingPhysicalShapeExact
	temporary := observation.entryTemporaryPhysicalExact
	finalSuccessor := observation.currentTailFinalSuccessorExact
	genesis := observation.migrationGenesisExact
	v1Temporary := observation.selectedV1TemporaryPhysicalExact
	switch observation.entryResidue {
	case entryResidueNone:
		return observation.entryResidueCount == 0 &&
			!staging && !temporary && !finalSuccessor && !genesis && !v1Temporary
	case entryResidueMigrationStagingEmpty,
		entryResidueMigrationStagingWALEmpty,
		entryResidueMigrationStagingEntryTemporary,
		entryResidueMigrationStagingEntryFinal:
		return observation.entryResidueCount == 1 &&
			staging && !temporary && !finalSuccessor && !genesis && !v1Temporary
	case entryResidueCurrentTailEntryTemporary:
		return observation.entryResidueCount == 1 &&
			!staging && temporary && !finalSuccessor && !genesis && !v1Temporary
	case entryResidueCurrentTailFinalSuccessor:
		return observation.entryResidueCount == 1 &&
			!staging && !temporary && finalSuccessor && !genesis && !v1Temporary
	case entryResidueMigrationCanonicalGenesis:
		return observation.entryResidueCount == 1 &&
			!staging && !temporary && !finalSuccessor && genesis && !v1Temporary
	case entryResidueSelectedV1RecordTemporary:
		return observation.entryResidueCount == 1 &&
			!staging && !temporary && !finalSuccessor && !genesis && v1Temporary
	default:
		return false
	}
}

type recoveryCrashState uint8

const (
	recoveryStateInvalid recoveryCrashState = iota
	recoveryStateCleanV1
	recoveryStateAuthoritativeV2
	recoveryStateAuthoritativeV2Adopted
	recoveryStateHeadTemporaryOnly
	recoveryStateHeadTemporaryDeleted
	recoveryStateEntryTemporary
	recoveryStateEntryTemporaryDeleted
	recoveryStateExistingFinalSuccessor
	recoveryStateExistingFinalSuccessorWithHeadTemporary
	recoveryStateExistingFinalHeadTemporaryDeleted
	recoveryStateExistingFinalSuccessorDeleted
	recoveryStateV1RecordTemporary
	recoveryStateV1RecordTemporaryDeleted
	recoveryStateMigrationStagingEmpty
	recoveryStateMigrationStagingWALEmpty
	recoveryStateMigrationStagingWALDeleted
	recoveryStateMigrationStagingEntryTemporary
	recoveryStateMigrationStagingEntryTemporaryDeleted
	recoveryStateMigrationStagingEntryFinal
	recoveryStateMigrationStagingEntryFinalDeleted
	recoveryStateMigrationStagingDeleted
	recoveryStateMigrationCanonicalGenesis
	recoveryStateMigrationCanonicalGenesisWithHeadTemporary
	recoveryStateMigrationCanonicalHeadTemporaryDeleted
	recoveryStateMigrationCanonicalVerified
	recoveryStateMigrationRenamedBack
)

type recoveryOperation uint8

const (
	recoveryOperationNone recoveryOperation = iota
	recoveryOperationReflushReopenAndDescribeV2Tail
	recoveryOperationDeleteHeadTemporary
	recoveryOperationFlushTransactionsAndReclassify
	recoveryOperationDeleteEntryTemporary
	recoveryOperationDeleteExistingFinalSuccessor
	recoveryOperationFlushWALAndReclassify
	recoveryOperationDeleteV1RecordTemporary
	recoveryOperationFlushV1TransactionAndReclassify
	recoveryOperationDeleteStagingEntryTemporary
	recoveryOperationDeleteStagingFinalEntry
	recoveryOperationFlushAndReopenStagingWAL
	recoveryOperationDeleteStagingWALDirectory
	recoveryOperationFlushAndReopenStagingDirectory
	recoveryOperationDeleteStagingDirectory
	recoveryOperationFlushTransactionsToCleanV1
	recoveryOperationFlushAndReopenMigrationCanonical
	recoveryOperationRenameMigrationCanonicalBackToStaging
	recoveryOperationFlushAndReopenRenamedStaging
)

type recoveryTransition struct {
	operation recoveryOperation
	next      recoveryCrashState
	terminal  bool
}

// nextRecoveryTransition is a pure crash-cut model. It never performs the
// operation it describes and never produces a cleanup or effect capability.
func nextRecoveryTransition(state recoveryCrashState) recoveryTransition {
	switch state {
	case recoveryStateCleanV1, recoveryStateAuthoritativeV2Adopted:
		return recoveryTransition{operation: recoveryOperationNone, next: state, terminal: true}
	case recoveryStateAuthoritativeV2:
		return recoveryTransition{
			operation: recoveryOperationReflushReopenAndDescribeV2Tail,
			next:      recoveryStateAuthoritativeV2Adopted,
		}
	case recoveryStateHeadTemporaryOnly:
		return recoveryTransition{operation: recoveryOperationDeleteHeadTemporary, next: recoveryStateHeadTemporaryDeleted}
	case recoveryStateHeadTemporaryDeleted:
		return recoveryTransition{operation: recoveryOperationFlushTransactionsAndReclassify, next: recoveryStateInvalid}
	case recoveryStateEntryTemporary:
		return recoveryTransition{operation: recoveryOperationDeleteEntryTemporary, next: recoveryStateEntryTemporaryDeleted}
	case recoveryStateEntryTemporaryDeleted:
		return recoveryTransition{operation: recoveryOperationFlushWALAndReclassify, next: recoveryStateInvalid}
	case recoveryStateExistingFinalSuccessorWithHeadTemporary:
		return recoveryTransition{operation: recoveryOperationDeleteHeadTemporary, next: recoveryStateExistingFinalHeadTemporaryDeleted}
	case recoveryStateExistingFinalHeadTemporaryDeleted:
		return recoveryTransition{operation: recoveryOperationFlushTransactionsAndReclassify, next: recoveryStateExistingFinalSuccessor}
	case recoveryStateExistingFinalSuccessor:
		return recoveryTransition{operation: recoveryOperationDeleteExistingFinalSuccessor, next: recoveryStateExistingFinalSuccessorDeleted}
	case recoveryStateExistingFinalSuccessorDeleted:
		return recoveryTransition{operation: recoveryOperationFlushWALAndReclassify, next: recoveryStateInvalid}
	case recoveryStateV1RecordTemporary:
		return recoveryTransition{operation: recoveryOperationDeleteV1RecordTemporary, next: recoveryStateV1RecordTemporaryDeleted}
	case recoveryStateV1RecordTemporaryDeleted:
		return recoveryTransition{operation: recoveryOperationFlushV1TransactionAndReclassify, next: recoveryStateInvalid}
	case recoveryStateMigrationStagingEntryTemporary:
		return recoveryTransition{operation: recoveryOperationDeleteStagingEntryTemporary, next: recoveryStateMigrationStagingEntryTemporaryDeleted}
	case recoveryStateMigrationStagingEntryTemporaryDeleted:
		return recoveryTransition{operation: recoveryOperationFlushAndReopenStagingWAL, next: recoveryStateMigrationStagingWALEmpty}
	case recoveryStateMigrationStagingEntryFinal:
		return recoveryTransition{operation: recoveryOperationDeleteStagingFinalEntry, next: recoveryStateMigrationStagingEntryFinalDeleted}
	case recoveryStateMigrationStagingEntryFinalDeleted:
		return recoveryTransition{operation: recoveryOperationFlushAndReopenStagingWAL, next: recoveryStateMigrationStagingWALEmpty}
	case recoveryStateMigrationStagingWALEmpty:
		return recoveryTransition{operation: recoveryOperationDeleteStagingWALDirectory, next: recoveryStateMigrationStagingWALDeleted}
	case recoveryStateMigrationStagingWALDeleted:
		return recoveryTransition{operation: recoveryOperationFlushAndReopenStagingDirectory, next: recoveryStateMigrationStagingEmpty}
	case recoveryStateMigrationStagingEmpty:
		return recoveryTransition{operation: recoveryOperationDeleteStagingDirectory, next: recoveryStateMigrationStagingDeleted}
	case recoveryStateMigrationStagingDeleted:
		return recoveryTransition{operation: recoveryOperationFlushTransactionsToCleanV1, next: recoveryStateCleanV1}
	case recoveryStateMigrationCanonicalGenesisWithHeadTemporary:
		return recoveryTransition{operation: recoveryOperationDeleteHeadTemporary, next: recoveryStateMigrationCanonicalHeadTemporaryDeleted}
	case recoveryStateMigrationCanonicalHeadTemporaryDeleted:
		return recoveryTransition{operation: recoveryOperationFlushTransactionsAndReclassify, next: recoveryStateMigrationCanonicalGenesis}
	case recoveryStateMigrationCanonicalGenesis:
		return recoveryTransition{operation: recoveryOperationFlushAndReopenMigrationCanonical, next: recoveryStateMigrationCanonicalVerified}
	case recoveryStateMigrationCanonicalVerified:
		return recoveryTransition{
			operation: recoveryOperationRenameMigrationCanonicalBackToStaging,
			next:      recoveryStateMigrationRenamedBack,
		}
	case recoveryStateMigrationRenamedBack:
		return recoveryTransition{
			operation: recoveryOperationFlushAndReopenRenamedStaging,
			next:      recoveryStateMigrationStagingEntryFinal,
		}
	default:
		return recoveryTransition{operation: recoveryOperationNone, next: recoveryStateInvalid, terminal: true}
	}
}
