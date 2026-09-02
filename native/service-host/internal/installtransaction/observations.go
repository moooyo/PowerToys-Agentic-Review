package installtransaction

// actionObservation is a package-private, closed description of a fresh fact supplied by a future
// installer composition. These values are ordinary testable data. They are not evidence and cannot
// authorize an effect, a journal write, installation, service control, Claim, or execution.
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

// candidateCreationVerified means a future platform boundary has already proved an empty,
// exact-ACL, same-volume candidate directory and supplied its freshly observed identity.
type createCandidateObservation struct {
	state candidateCreationState
	root  RootIdentity
}

func (createCandidateObservation) isActionObservation() {}

type candidatePopulationState uint8

const (
	candidatePopulationUnknown candidatePopulationState = iota
	// candidatePopulationRetryable means bounded handle-relative cleanup proved the same recorded
	// candidate root is empty and safe to populate again.
	candidatePopulationRetryable
	candidatePopulationVerified
	candidatePopulationAmbiguous
)

// candidatePopulationVerified is an abstract package-private fact. A future composition may create
// it only after consuming opaque staged and candidate-verification evidence in the same process.
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

type reductionDisposition uint8

const (
	reductionUnknown reductionDisposition = iota
	reductionPublishNextRecord
	reductionRetryEffect
	reductionAcquireExternalEvidence
	reductionTerminal
	reductionFailedClosedOutOfBand
)

type evidenceRequirement uint8

const (
	evidenceRequirementUnknown evidenceRequirement = iota
	evidenceRequirementPendingAction
	evidenceRequirementPhaseTransition
	evidenceRequirementSCMPolicyContract
	evidenceRequirementRollbackRoots
)

// reduction is ordinary, package-private planning data. A next record still requires the future
// durable journal publication protocol before any effect may begin.
type reduction struct {
	disposition reductionDisposition
	next        TransactionRecord
	retry       PendingAction
	requirement evidenceRequirement
	failure     FailureCode
}
