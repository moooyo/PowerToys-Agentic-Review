package installstorev2lab

import "errors"

const (
	SchemaVersion = uint32(2)

	MaximumHeadDocumentBytes        = 1024
	MaximumPredecessorDocumentBytes = 2 * 1024
	MaximumEntryDocumentBytes       = 128 * 1024
	MaximumNestedRecordBytes        = 96 * 1024
	MaximumPendingActionBytes       = 16 * 1024
	MaximumLegacyRecordBytes        = 64 * 1024
	MaximumV1InventoryDocumentBytes = 1024 * 1024

	MaximumLegacyTransactionDirectories    = uint64(4096)
	MaximumCurrentV2TransactionDirectories = uint64(1)
	MaximumCanonicalTransactionDirectories = uint64(4097)
	MaximumMigrationStagingDirectories     = uint64(1)
	MaximumV2Entries                       = uint64(4096)
	MaximumAggregateDocumentBytes          = uint64(806354944)
	MaximumRetainedHandles                 = uint64(64)
	MaximumDocumentBuffers                 = uint64(3)
	MaximumLiveWorkingSetBytes             = uint64(16 * 1024 * 1024)
	MaximumRecoverySeconds                 = uint64(10 * 60)

	TransactionsRootPath    = `C:\ProgramData\AgenticReview\Installer\Transactions`
	WriterLockPath          = TransactionsRootPath + `\writer-v1.lock`
	ActiveHeadPath          = TransactionsRootPath + `\active-head-v1.json`
	ActiveHeadTemporaryPath = ActiveHeadPath + `.tmp`
)

var (
	ErrInvalid                   = errors.New("invalid dormant cross-version installer store v2 document")
	ErrCanonical                 = errors.New("dormant cross-version installer store v2 document is not canonical")
	ErrLimit                     = errors.New("dormant cross-version installer store v2 limit exceeded")
	ErrUnavailable               = errors.New("dormant cross-version installer store v2 is unavailable")
	ErrCapabilityInvalid         = errors.New("dormant installer store capability is invalid")
	ErrCapabilityNotSerializable = errors.New("dormant installer store capability is not serializable")
)

type TransactionID string
type SHA256 string
type DecimalUint64 string

const scmPolicyContractIdentifier = "agentic-review-windows-split-service-scm-policy-v1"

type TerminalDisposition string

const (
	TerminalCommittedApplied  TerminalDisposition = "committed-applied"
	TerminalRolledBackApplied TerminalDisposition = "rolled-back-applied"
)

// Head selects one exact v2 WAL entry. It is ordinary, non-authorizing data.
type Head struct {
	EntrySHA256    SHA256        `json:"entrySha256"`
	RecordSequence DecimalUint64 `json:"recordSequence"`
	TransactionID  TransactionID `json:"transactionId"`
}

// Predecessor binds the complete successful v1 inventory used for migration.
// It is ordinary audit data and is not evidence or authority.
type Predecessor struct {
	HeadDocumentSHA256   SHA256        `json:"headDocumentSha256"`
	InventorySHA256      SHA256        `json:"inventorySha256"`
	RecordDocumentSHA256 SHA256        `json:"recordDocumentSha256"`
	RecordSequence       DecimalUint64 `json:"recordSequence"`
	SourceSchemaVersion  uint32        `json:"sourceSchemaVersion"`
	TransactionID        TransactionID `json:"transactionId"`
}

// V1InventoryEntry binds one successful canonical v1 transaction record.
type V1InventoryEntry struct {
	RecordDocumentSHA256 SHA256              `json:"recordDocumentSha256"`
	RecordSequence       DecimalUint64       `json:"recordSequence"`
	TerminalDisposition  TerminalDisposition `json:"terminalDisposition"`
	TransactionID        TransactionID       `json:"transactionId"`
}
