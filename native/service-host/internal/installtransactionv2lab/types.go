package installtransactionv2lab

import "errors"

const (
	SchemaVersion                 = uint32(2)
	MaximumTransactionRecordBytes = 96 * 1024
	SCMPolicyContractIdentifier   = SCMPolicyContractID(
		"agentic-review-windows-split-service-scm-policy-v1",
	)
)

var (
	ErrInvalid   = errors.New("invalid dormant split installer transaction v2 record")
	ErrCanonical = errors.New("dormant split installer transaction v2 document is not canonical")
	ErrLimit     = errors.New("dormant split installer transaction v2 document exceeds its size limit")
)

type TransactionID string
type PackageComponentID string
type EntityID string
type ReleaseID string
type SHA256 string
type FileID string
type DecimalUint64 string
type SCMPolicyContractID string
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
	PhaseStagingVerified              Phase = "STAGING_VERIFIED"
	PhaseInactivePackageVerified      Phase = "INACTIVE_PACKAGE_VERIFIED"
	PhaseQuiesced                     Phase = "QUIESCED"
	PhaseSCMMaintenanceFenced         Phase = "SCM_MAINTENANCE_FENCED"
	PhaseServicesStopped              Phase = "SERVICES_STOPPED"
	PhaseRootSwapInProgress           Phase = "ROOT_SWAP_IN_PROGRESS"
	PhaseDestinationVerified          Phase = "DESTINATION_VERIFIED"
	PhaseServiceConfigurationProgress Phase = "SERVICE_CONFIGURATION_IN_PROGRESS"
	PhaseServicesConfigured           Phase = "SERVICES_CONFIGURED"
	PhaseExecutorStarted              Phase = "EXECUTOR_STARTED"
	PhaseControlStarted               Phase = "CONTROL_STARTED"
	PhaseAuthenticatedDisabledReady   Phase = "AUTHENTICATED_DISABLED_READY"
	PhaseRollbackInProgress           Phase = "ROLLBACK_IN_PROGRESS"
	PhaseFailedClosed                 Phase = "FAILED_CLOSED"
)

type ActivationPolicyState string

const (
	ActivationNotApplicable ActivationPolicyState = "not-applicable"
	ActivationBlocked       ActivationPolicyState = "blocked"
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
	PlanNone                        ActionPlan = "none"
	PlanMaterializeInactive         ActionPlan = "materialize-inactive"
	PlanInitialForward              ActionPlan = "initial-forward"
	PlanUpgradeForward              ActionPlan = "upgrade-forward"
	PlanUpgradeRollback             ActionPlan = "upgrade-rollback"
	PlanSCMMaintenance              ActionPlan = "scm-maintenance"
	PlanStopServices                ActionPlan = "stop-services"
	PlanInitialServiceCreation      ActionPlan = "initial-service-creation"
	PlanStartCandidateServices      ActionPlan = "start-candidate-services"
	PlanStartPreviousServices       ActionPlan = "start-previous-services"
	PlanCandidateFinalPolicyBlocked ActionPlan = "candidate-final-policy-blocked"
	PlanPreviousFinalPolicyBlocked  ActionPlan = "previous-final-policy-blocked"
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

type ServiceRole string

const (
	RoleControl  ServiceRole = "control"
	RoleExecutor ServiceRole = "executor"
)

type TargetGeneration string

const (
	GenerationCandidate TargetGeneration = "candidate"
	GenerationPrevious  TargetGeneration = "previous"
)

type ActionKind string

const (
	ActionCreateCandidateRoot                   ActionKind = "create-candidate-root"
	ActionPopulateCandidateRoot                 ActionKind = "populate-candidate-root"
	ActionRenameDirectory                       ActionKind = "rename-directory"
	ActionClearControlFailureActions            ActionKind = "clear-control-failure-actions"
	ActionClearControlFailureActionsOnNonCrash  ActionKind = "clear-control-failure-actions-on-non-crash"
	ActionClearControlDelayedAutoStart          ActionKind = "clear-control-delayed-auto-start"
	ActionSetControlDemandStart                 ActionKind = "set-control-demand-start"
	ActionClearExecutorFailureActions           ActionKind = "clear-executor-failure-actions"
	ActionClearExecutorFailureActionsOnNonCrash ActionKind = "clear-executor-failure-actions-on-non-crash"
	ActionClearExecutorDelayedAutoStart         ActionKind = "clear-executor-delayed-auto-start"
	ActionSetExecutorDemandStart                ActionKind = "set-executor-demand-start"
	ActionStopControl                           ActionKind = "stop-control"
	ActionStopExecutor                          ActionKind = "stop-executor"
	ActionCreateDisabledExecutorService         ActionKind = "create-disabled-executor-service"
	ActionSetExecutorServiceSecurity            ActionKind = "set-executor-service-security"
	ActionSetExecutorDescription                ActionKind = "set-executor-description"
	ActionSetExecutorServiceSIDType             ActionKind = "set-executor-service-sid-type"
	ActionSetExecutorRequiredPrivileges         ActionKind = "set-executor-required-privileges"
	ActionSetExecutorPreshutdownPolicy          ActionKind = "set-executor-preshutdown-policy"
	ActionCreateDisabledControlService          ActionKind = "create-disabled-control-service"
	ActionSetControlServiceSecurity             ActionKind = "set-control-service-security"
	ActionSetControlDescription                 ActionKind = "set-control-description"
	ActionSetControlServiceSIDType              ActionKind = "set-control-service-sid-type"
	ActionSetControlRequiredPrivileges          ActionKind = "set-control-required-privileges"
	ActionSetControlPreshutdownPolicy           ActionKind = "set-control-preshutdown-policy"
	ActionStartExecutor                         ActionKind = "start-executor"
	ActionStartControl                          ActionKind = "start-control"
	ActionCandidateFinalPolicyUnavailable       ActionKind = "candidate-final-policy-unavailable"
	ActionPreviousFinalPolicyUnavailable        ActionKind = "previous-final-policy-unavailable"
)

type BlockedReason string

const (
	BlockedFailureActionsClearABI     BlockedReason = "failure-actions-clear-abi-unavailable"
	BlockedCreateIntermediateEvidence BlockedReason = "create-intermediate-dacl-evidence-unavailable"
	BlockedPreshutdownContract        BlockedReason = "preshutdown-contract-unavailable"
	BlockedPreferredNodeReadback      BlockedReason = "preferred-node-no-setting-readback-unavailable"
	BlockedStopProcessTreeEvidence    BlockedReason = "stop-process-tree-evidence-unavailable"
	BlockedStartReadinessEvidence     BlockedReason = "start-readiness-evidence-unavailable"
	BlockedDurableStore               BlockedReason = "durable-store-unavailable"
	BlockedNativeAdapter              BlockedReason = "native-adapter-unavailable"
	BlockedCandidateFinalPolicy       BlockedReason = "candidate-final-policy-unavailable"
	BlockedPreviousFinalPolicy        BlockedReason = "previous-final-policy-unavailable"
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

type BlockedCheckpoint struct {
	ActionKind           ActionKind      `json:"actionKind"`
	MissingPrerequisites []BlockedReason `json:"missingPrerequisites"`
	Ordinal              ActionOrdinal   `json:"ordinal"`
	Plan                 ActionPlan      `json:"plan"`
}

// PendingAction is a closed union of ordinary, non-authorizing action data.
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

type SCMAction struct {
	ActionKind       ActionKind          `json:"actionKind"`
	Ordinal          ActionOrdinal       `json:"ordinal"`
	PolicyContractID SCMPolicyContractID `json:"policyContractId"`
	Role             ServiceRole         `json:"role"`
}

func (SCMAction) isPendingAction()                    {}
func (action SCMAction) Kind() ActionKind             { return action.ActionKind }
func (action SCMAction) ActionOrdinal() ActionOrdinal { return action.Ordinal }

type SCMGenerationAction struct {
	ActionKind       ActionKind          `json:"actionKind"`
	Ordinal          ActionOrdinal       `json:"ordinal"`
	PolicyContractID SCMPolicyContractID `json:"policyContractId"`
	Role             ServiceRole         `json:"role"`
	TargetGeneration TargetGeneration    `json:"targetGeneration"`
}

func (SCMGenerationAction) isPendingAction()                    {}
func (action SCMGenerationAction) Kind() ActionKind             { return action.ActionKind }
func (action SCMGenerationAction) ActionOrdinal() ActionOrdinal { return action.Ordinal }

// TransactionRecord is an ordinary snapshot. Validation proves only syntax
// and internal consistency under the permanently blocked lab schema.
type TransactionRecord struct {
	ActionPlan             ActionPlan            `json:"actionPlan"`
	ActivationPolicyState  ActivationPolicyState `json:"activationPolicyState"`
	BlockedCheckpoint      *BlockedCheckpoint    `json:"blockedCheckpoint"`
	Candidate              CandidateGeneration   `json:"candidate"`
	CompletedActionOrdinal ActionOrdinal         `json:"completedActionOrdinal"`
	FailureCode            *FailureCode          `json:"failureCode"`
	InstallationID         PackageComponentID    `json:"installationId"`
	Mode                   Mode                  `json:"mode"`
	PendingAction          PendingAction         `json:"pendingAction"`
	Phase                  Phase                 `json:"phase"`
	SCMPolicyContractID    SCMPolicyContractID   `json:"scmPolicyContractId"`
	Previous               *PackageGeneration    `json:"previous"`
	RecordSequence         DecimalUint64         `json:"recordSequence"`
	RollbackCheckpoint     RollbackCheckpoint    `json:"rollbackCheckpoint"`
	TargetArchitecture     TargetArchitecture    `json:"targetArchitecture"`
	TransactionID          TransactionID         `json:"transactionId"`
	WorkerNodeID           EntityID              `json:"workerNodeId"`
}
