package installtransactionv2lab

// actionObservation is package-private ordinary data supplied by a future
// composition only after it has acquired fresh opaque evidence. It is not
// evidence itself and cannot authorize an effect or a journal write.
type actionObservation interface {
	isActionObservation()
}

type candidateCreationState uint8

const (
	candidateCreationUnknown candidateCreationState = iota
	candidateCreationAbsent
	candidateCreationVerified
	candidateCreationAmbiguous
)

type createCandidateObservation struct {
	state candidateCreationState
	root  RootIdentity
}

func (createCandidateObservation) isActionObservation() {}

type candidatePopulationState uint8

const (
	candidatePopulationUnknown candidatePopulationState = iota
	candidatePopulationRetryable
	candidatePopulationVerified
	candidatePopulationAmbiguous
)

type populateCandidateObservation struct {
	state candidatePopulationState
	root  RootIdentity
}

func (populateCandidateObservation) isActionObservation() {}

type rootSlotObservationState uint8

const (
	rootSlotUnknown rootSlotObservationState = iota
	rootSlotAbsent
	rootSlotPresent
	rootSlotInaccessible
)

type rootSlotObservation struct {
	state rootSlotObservationState
	root  RootIdentity
}

type renameDurabilityState uint8

const (
	renameDurabilityUnknown renameDurabilityState = iota
	renameDurabilityNotApplicable
	renameDurabilityProved
	renameDurabilityUnproved
)

type renameObservation struct {
	from       rootSlotObservation
	to         rootSlotObservation
	durability renameDurabilityState
}

func (renameObservation) isActionObservation() {}

type scmObservationState uint8

const (
	scmObservationUnknown scmObservationState = iota
	scmObservationExactBefore
	scmObservationExactTarget
	scmObservationUnproved
)

type scmObservationClassification uint8

const (
	scmClassificationUnknown scmObservationClassification = iota
	scmClassificationExactBefore
	scmClassificationExactTarget
	scmClassificationUnproved
)

// scmActionObservation is constructible only inside this package. A future
// native boundary may produce it only after a complete fresh pair readback of
// QueryServiceConfigW, every required QueryServiceConfig2W class,
// QueryServiceStatusEx, owner/group/DACL, normalized ACEs, dependent topology,
// and the action-specific process-tree or readiness evidence.
type scmActionObservation struct {
	actionKind     ActionKind
	ordinal        ActionOrdinal
	plan           ActionPlan
	recordSHA256   SHA256
	recordSequence DecimalUint64
	state          scmObservationState
	transactionID  TransactionID
}

func (scmActionObservation) isActionObservation() {}

type reductionDisposition uint8

const (
	reductionUnknown reductionDisposition = iota
	reductionPublishNextRecord
	reductionRetryEffect
	reductionAcquireExternalEvidence
	reductionBlocked
	reductionTerminal
	reductionFailedClosedOutOfBand
)

type evidenceRequirement uint8

const (
	evidenceRequirementUnknown evidenceRequirement = iota
	evidenceRequirementPendingAction
	evidenceRequirementPhaseTransition
	evidenceRequirementRollbackRoots
)

// reduction is package-private planning data. It never grants filesystem or
// SCM authority. A future durable store must publish and reverify next before
// any separate adapter may receive an opaque intent permit.
type reduction struct {
	disposition reductionDisposition
	next        TransactionRecord
	retry       PendingAction
	requirement evidenceRequirement
	blocked     *BlockedCheckpoint
	failure     FailureCode
}
