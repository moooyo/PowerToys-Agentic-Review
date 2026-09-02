package installtransaction

import "errors"

const (
	SchemaVersion                 = uint32(1)
	MaximumActiveHeadBytes        = 1024
	MaximumTransactionRecordBytes = 64 * 1024

	InstallerRoot             = `C:\ProgramData\AgenticReview\Installer`
	TransactionsRoot          = InstallerRoot + `\Transactions`
	WriterLockPath            = TransactionsRoot + `\writer-v1.lock`
	ActiveHeadPath            = TransactionsRoot + `\active-head-v1.json`
	ActiveHeadTemporaryPath   = TransactionsRoot + `\active-head-v1.json.tmp`
	TransactionRecordFileName = `record-v1.json`
	TransactionTemporaryName  = `record-v1.json.tmp`
)

var (
	ErrInvalid   = errors.New("invalid split installer transaction record")
	ErrCanonical = errors.New("split installer transaction document is not canonical")
	ErrLimit     = errors.New("split installer transaction document exceeds its size limit")
)

type TransactionID string
type PackageComponentID string
type EntityID string
type ReleaseID string
type SHA256 string
type FileID string
type DecimalUint64 string
type ActionOrdinal uint8

type Mode string

const (
	ModeInitial Mode = "initial"
	ModeUpgrade Mode = "upgrade"
)

type TargetArchitecture string

const (
	ArchitectureAMD64 TargetArchitecture = "amd64"
	ArchitectureARM64 TargetArchitecture = "arm64"
)

type Phase string

const (
	PhaseStagingVerified            Phase = "STAGING_VERIFIED"
	PhaseInactivePackageVerified    Phase = "INACTIVE_PACKAGE_VERIFIED"
	PhaseQuiesced                   Phase = "QUIESCED"
	PhaseSCMMaintenanceFenced       Phase = "SCM_MAINTENANCE_FENCED"
	PhaseServicesStopped            Phase = "SERVICES_STOPPED"
	PhaseRootSwapInProgress         Phase = "ROOT_SWAP_IN_PROGRESS"
	PhaseDestinationVerified        Phase = "DESTINATION_VERIFIED"
	PhaseExecutorStarted            Phase = "EXECUTOR_STARTED"
	PhaseControlStarted             Phase = "CONTROL_STARTED"
	PhaseAuthenticatedDisabledReady Phase = "AUTHENTICATED_DISABLED_READY"
	PhaseCommitted                  Phase = "COMMITTED"
	PhaseRollbackInProgress         Phase = "ROLLBACK_IN_PROGRESS"
	PhaseRolledBack                 Phase = "ROLLED_BACK"
	PhaseFailedClosed               Phase = "FAILED_CLOSED"
)

type ActivationPolicyState string

const (
	ActivationNotApplicable ActivationPolicyState = "not-applicable"
	ActivationPending       ActivationPolicyState = "pending"
	ActivationApplied       ActivationPolicyState = "applied"
)

type RollbackCheckpoint string

const (
	RollbackNotApplicable              RollbackCheckpoint = "not-applicable"
	RollbackRootsRestored              RollbackCheckpoint = "roots-restored"
	RollbackExecutorStarted            RollbackCheckpoint = "executor-started"
	RollbackControlStarted             RollbackCheckpoint = "control-started"
	RollbackAuthenticatedDisabledReady RollbackCheckpoint = "authenticated-disabled-ready"
)

type ActionPlan string

const (
	PlanNone                      ActionPlan = "none"
	PlanMaterializeInactive       ActionPlan = "materialize-inactive"
	PlanInitialForward            ActionPlan = "initial-forward"
	PlanUpgradeForward            ActionPlan = "upgrade-forward"
	PlanUpgradeRollback           ActionPlan = "upgrade-rollback"
	PlanCandidateActivationPolicy ActionPlan = "candidate-activation-policy"
	PlanRollbackActivationPolicy  ActionPlan = "rollback-activation-policy"
)

type FailureCode string

const (
	FailureJournalCorrupt        FailureCode = "JOURNAL_CORRUPT"
	FailureNamespaceAmbiguous    FailureCode = "NAMESPACE_AMBIGUOUS"
	FailureDurabilityUnproved    FailureCode = "DURABILITY_UNPROVED"
	FailureRootIdentityAmbiguous FailureCode = "ROOT_IDENTITY_AMBIGUOUS"
	FailureRevalidationFailed    FailureCode = "REVALIDATION_FAILED"
	FailureSCMUnproved           FailureCode = "SCM_UNPROVED"
	FailureReadinessUnproved     FailureCode = "READINESS_UNPROVED"
)

type Direction string

const (
	DirectionForward  Direction = "forward"
	DirectionRollback Direction = "rollback"
)

type ActionKind string

const (
	ActionCreateCandidateRoot          ActionKind = "create-candidate-root"
	ActionPopulateCandidateRoot        ActionKind = "populate-candidate-root"
	ActionRenameDirectory              ActionKind = "rename-directory"
	ActionApplyCandidateExecutorPolicy ActionKind = "apply-candidate-executor-policy"
	ActionApplyCandidateControlPolicy  ActionKind = "apply-candidate-control-policy"
	ActionApplyPreviousExecutorPolicy  ActionKind = "apply-previous-executor-policy"
	ActionApplyPreviousControlPolicy   ActionKind = "apply-previous-control-policy"
)

type CandidateRootSlot string

const (
	SlotMetadataCandidate             CandidateRootSlot = "metadata-candidate"
	SlotInstallationCandidate         CandidateRootSlot = "installation-candidate"
	SlotTrustedConfigurationCandidate CandidateRootSlot = "trusted-configuration-candidate"
)

type RootSlot string

const (
	RootSlotMetadataFinal                 RootSlot = "metadata-final"
	RootSlotMetadataCandidate             RootSlot = "metadata-candidate"
	RootSlotInstallationFinal             RootSlot = "installation-final"
	RootSlotInstallationCandidate         RootSlot = "installation-candidate"
	RootSlotInstallationRollback          RootSlot = "installation-rollback"
	RootSlotInstallationInactive          RootSlot = "installation-inactive"
	RootSlotTrustedConfigurationFinal     RootSlot = "trusted-configuration-final"
	RootSlotTrustedConfigurationCandidate RootSlot = "trusted-configuration-candidate"
	RootSlotTrustedConfigurationRollback  RootSlot = "trusted-configuration-rollback"
	RootSlotTrustedConfigurationInactive  RootSlot = "trusted-configuration-inactive"
)

// ActiveHead selects one transaction. It is ordinary, non-authorizing data.
type ActiveHead struct {
	TransactionID TransactionID `json:"transactionId"`
}

type RootIdentity struct {
	FileID                   FileID        `json:"fileId"`
	SecurityDescriptorSHA256 SHA256        `json:"securityDescriptorSha256"`
	VolumeSerialNumber       DecimalUint64 `json:"volumeSerialNumber"`
}

type CandidateRootSet struct {
	Installation         *RootIdentity `json:"installation"`
	Metadata             *RootIdentity `json:"metadata"`
	TrustedConfiguration *RootIdentity `json:"trustedConfiguration"`
}

type RootSet struct {
	Installation         RootIdentity `json:"installation"`
	Metadata             RootIdentity `json:"metadata"`
	TrustedConfiguration RootIdentity `json:"trustedConfiguration"`
}

type CandidateGeneration struct {
	PackageID         PackageComponentID `json:"packageId"`
	ReleaseID         ReleaseID          `json:"releaseId"`
	Roots             *CandidateRootSet  `json:"roots"`
	SignedIndexSHA256 SHA256             `json:"signedIndexSha256"`
}

type PackageGeneration struct {
	PackageID         PackageComponentID `json:"packageId"`
	ReleaseID         ReleaseID          `json:"releaseId"`
	Roots             RootSet            `json:"roots"`
	SignedIndexSHA256 SHA256             `json:"signedIndexSha256"`
}

// PendingAction is a closed tagged union of fixed, non-authorizing action descriptions.
type PendingAction interface {
	Kind() ActionKind
	ActionOrdinal() ActionOrdinal
	isPendingAction()
}

type CreateCandidateAction struct {
	ActionKind ActionKind        `json:"actionKind"`
	Direction  Direction         `json:"direction"`
	Ordinal    ActionOrdinal     `json:"ordinal"`
	ToSlot     CandidateRootSlot `json:"toSlot"`
}

func (CreateCandidateAction) isPendingAction()                    {}
func (action CreateCandidateAction) Kind() ActionKind             { return action.ActionKind }
func (action CreateCandidateAction) ActionOrdinal() ActionOrdinal { return action.Ordinal }

type PopulateCandidateAction struct {
	ActionKind   ActionKind        `json:"actionKind"`
	Direction    Direction         `json:"direction"`
	ExpectedRoot RootIdentity      `json:"expectedRoot"`
	Ordinal      ActionOrdinal     `json:"ordinal"`
	Slot         CandidateRootSlot `json:"slot"`
}

func (PopulateCandidateAction) isPendingAction()                    {}
func (action PopulateCandidateAction) Kind() ActionKind             { return action.ActionKind }
func (action PopulateCandidateAction) ActionOrdinal() ActionOrdinal { return action.Ordinal }

type RenameAction struct {
	ActionKind   ActionKind    `json:"actionKind"`
	Direction    Direction     `json:"direction"`
	ExpectedRoot RootIdentity  `json:"expectedRoot"`
	FromSlot     RootSlot      `json:"fromSlot"`
	Ordinal      ActionOrdinal `json:"ordinal"`
	ToSlot       RootSlot      `json:"toSlot"`
}

func (RenameAction) isPendingAction()                    {}
func (action RenameAction) Kind() ActionKind             { return action.ActionKind }
func (action RenameAction) ActionOrdinal() ActionOrdinal { return action.Ordinal }

type PolicyAction struct {
	ActionKind ActionKind    `json:"actionKind"`
	Ordinal    ActionOrdinal `json:"ordinal"`
}

func (PolicyAction) isPendingAction()                    {}
func (action PolicyAction) Kind() ActionKind             { return action.ActionKind }
func (action PolicyAction) ActionOrdinal() ActionOrdinal { return action.Ordinal }

// TransactionRecord is an ordinary snapshot. Validation proves only internal consistency.
type TransactionRecord struct {
	ActionPlan             ActionPlan            `json:"actionPlan"`
	ActivationPolicyState  ActivationPolicyState `json:"activationPolicyState"`
	Candidate              CandidateGeneration   `json:"candidate"`
	CompletedActionOrdinal ActionOrdinal         `json:"completedActionOrdinal"`
	FailureCode            *FailureCode          `json:"failureCode"`
	InstallationID         PackageComponentID    `json:"installationId"`
	Mode                   Mode                  `json:"mode"`
	PendingAction          PendingAction         `json:"pendingAction"`
	Phase                  Phase                 `json:"phase"`
	Previous               *PackageGeneration    `json:"previous"`
	RecordSequence         DecimalUint64         `json:"recordSequence"`
	RollbackCheckpoint     RollbackCheckpoint    `json:"rollbackCheckpoint"`
	TargetArchitecture     TargetArchitecture    `json:"targetArchitecture"`
	TransactionID          TransactionID         `json:"transactionId"`
	WorkerNodeID           EntityID              `json:"workerNodeId"`
}

type NextIntentDisposition string

const (
	NextIntentAction NextIntentDisposition = "action"
	// NextIntentNone means no new intent publication is derivable from the record alone. It never
	// means that an existing pending action is authorized to run or that an external gate passed.
	NextIntentNone     NextIntentDisposition = "none"
	NextIntentTerminal NextIntentDisposition = "terminal"
)

// NextIntent describes the only next intent shape admitted by a valid record.
// It performs no transition and grants no permission to execute the action.
type NextIntent struct {
	Disposition           NextIntentDisposition
	Plan                  ActionPlan
	Phase                 Phase
	ActivationPolicyState ActivationPolicyState
	Action                PendingAction
}
