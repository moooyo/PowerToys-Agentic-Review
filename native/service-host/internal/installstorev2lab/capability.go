package installstorev2lab

type capabilityIssuerSeal struct {
	nonce byte
}

// preparedSuccessorState freezes the before-authority and complete proposed
// publication separately. No current lab function can construct this state.
type preparedSuccessorState struct {
	issuer                                *capabilityIssuerSeal
	storeGeneration                       uint64
	writerLockIdentitySHA256              SHA256
	currentHeadFileIdentitySHA256         SHA256
	currentSelectedDocumentIdentitySHA256 SHA256
	headParentIdentitySHA256              SHA256
	currentSelectedParentIdentitySHA256   SHA256
	nextEntryParentIdentitySHA256         SHA256
	currentExpectedHeadSchemaVersion      uint32
	currentHeadDocument                   []byte
	currentHeadDocumentSHA256             SHA256
	currentSelectedDocument               []byte
	currentSelectedDocumentSHA256         SHA256
	currentTransactionID                  TransactionID
	currentRecordSequence                 DecimalUint64
	nextTransactionID                     TransactionID
	nextRecordSequence                    DecimalUint64
	recordSchemaVersion                   uint32
	entrySchemaVersion                    uint32
	predecessorDocument                   []byte
	predecessorDocumentSHA256             SHA256
	previousEntrySHA256                   *SHA256
	nextRecordDocument                    []byte
	nextRecordDocumentSHA256              SHA256
	nextRecordSHA256                      SHA256
	nextEntryDocument                     []byte
	nextEntryDocumentSHA256               SHA256
	nextEntrySHA256                       SHA256
	nextHeadDocument                      []byte
	nextHeadDocumentSHA256                SHA256
	nextHeadSHA256                        SHA256
	scmPolicyContractID                   string
	blockedCheckpointDocument             []byte
	blockedCheckpointSHA256               SHA256
	actionPlan                            string
	hasPendingAction                      bool
	actionDocument                        []byte
	actionSHA256                          SHA256
	actionKind                            string
	actionOrdinal                         uint8
}

// durableIntentIdentity is the exact post-publication authority selected by
// the new head. It deliberately has no before-state fields.
type durableIntentIdentity struct {
	issuer                      *capabilityIssuerSeal
	storeGeneration             uint64
	writerLockIdentitySHA256    SHA256
	headFileIdentitySHA256      SHA256
	selectedEntryIdentitySHA256 SHA256
	headParentIdentitySHA256    SHA256
	entryParentIdentitySHA256   SHA256
	transactionID               TransactionID
	recordSequence              DecimalUint64
	recordSchemaVersion         uint32
	entrySchemaVersion          uint32
	headDocument                []byte
	headDocumentSHA256          SHA256
	headSHA256                  SHA256
	entryDocument               []byte
	entryDocumentSHA256         SHA256
	entrySHA256                 SHA256
	recordDocument              []byte
	recordDocumentSHA256        SHA256
	recordSHA256                SHA256
	scmPolicyContractID         string
	blockedCheckpointDocument   []byte
	blockedCheckpointSHA256     SHA256
	actionPlan                  string
	actionDocument              []byte
	actionSHA256                SHA256
	actionKind                  string
	actionOrdinal               uint8
}

type durableIntentPermitState struct {
	identity durableIntentIdentity
	consumed bool
}

type exactBeforeTokenState struct {
	identity                   durableIntentIdentity
	observationDocument        []byte
	observationSHA256          SHA256
	observationGeneration      uint64
	exclusionGeneration        uint64
	targetIdentitySHA256       []SHA256
	targetParentIdentitySHA256 []SHA256
	consumed                   bool
}

// PreparedSuccessor is reserved for a future sealed transition bridge. Its
// zero value is invalid and no constructor exists in this dormant package.
type PreparedSuccessor struct {
	state *preparedSuccessorState
}

// DurableIntentPermit is reserved for a future store publication result. Its
// zero value is invalid and the unavailable store never mints one.
type DurableIntentPermit struct {
	state *durableIntentPermitState
}

// ExactBeforeToken is reserved for a future action-specific native adapter.
// Its zero value is invalid and no generic constructor exists.
type ExactBeforeToken struct {
	state *exactBeforeTokenState
}

// Validate fails closed for every value until a separately reviewed sealed
// transition bridge and issuer exist.
func (PreparedSuccessor) Validate() error {
	return ErrCapabilityInvalid
}

// MarshalJSON prevents conversion of a prepared value into transferable data.
func (PreparedSuccessor) MarshalJSON() ([]byte, error) {
	return nil, ErrCapabilityNotSerializable
}

// Validate fails closed because this dormant store cannot mint a permit.
func (DurableIntentPermit) Validate() error {
	return ErrCapabilityInvalid
}

// MarshalJSON prevents conversion of a permit into transferable data.
func (DurableIntentPermit) MarshalJSON() ([]byte, error) {
	return nil, ErrCapabilityNotSerializable
}

// Validate fails closed because no action-specific native adapter exists.
func (ExactBeforeToken) Validate() error {
	return ErrCapabilityInvalid
}

// MarshalJSON prevents conversion of an exact-before token into transferable data.
func (ExactBeforeToken) MarshalJSON() ([]byte, error) {
	return nil, ErrCapabilityNotSerializable
}
