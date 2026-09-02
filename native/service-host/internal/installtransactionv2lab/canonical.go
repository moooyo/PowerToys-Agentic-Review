package installtransactionv2lab

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"unicode/utf8"
)

const recordDigestDomain = "AgenticReview split installer transaction record v2\x00"

type transactionRecordWire struct {
	ActionPlan             ActionPlan            `json:"actionPlan"`
	ActivationPolicyState  ActivationPolicyState `json:"activationPolicyState"`
	BlockedCheckpoint      *BlockedCheckpoint    `json:"blockedCheckpoint"`
	Candidate              CandidateGeneration   `json:"candidate"`
	CompletedActionOrdinal ActionOrdinal         `json:"completedActionOrdinal"`
	FailureCode            *FailureCode          `json:"failureCode"`
	InstallationID         PackageComponentID    `json:"installationId"`
	Mode                   Mode                  `json:"mode"`
	PendingAction          json.RawMessage       `json:"pendingAction"`
	Phase                  Phase                 `json:"phase"`
	SCMPolicyContractID    SCMPolicyContractID   `json:"scmPolicyContractId"`
	Previous               *PackageGeneration    `json:"previous"`
	RecordSequence         DecimalUint64         `json:"recordSequence"`
	RollbackCheckpoint     RollbackCheckpoint    `json:"rollbackCheckpoint"`
	TargetArchitecture     TargetArchitecture    `json:"targetArchitecture"`
	TransactionID          TransactionID         `json:"transactionId"`
	WorkerNodeID           EntityID              `json:"workerNodeId"`
}

type transactionDocumentWire struct {
	Record        json.RawMessage `json:"record"`
	RecordSHA256  SHA256          `json:"recordSha256"`
	SchemaVersion uint32          `json:"schemaVersion"`
}

// MarshalRecord validates and encodes one canonical dormant v2 record.
func MarshalRecord(record TransactionRecord) ([]byte, error) {
	if err := ValidateRecord(record); err != nil {
		return nil, err
	}
	wire, err := recordToWire(record)
	if err != nil {
		return nil, err
	}
	payload, err := marshalCanonicalValue(wire, MaximumTransactionRecordBytes)
	if err != nil {
		return nil, err
	}
	document := transactionDocumentWire{
		Record:        payload,
		RecordSHA256:  digestCanonical(recordDigestDomain, payload),
		SchemaVersion: SchemaVersion,
	}
	return marshalCanonicalValue(document, MaximumTransactionRecordBytes)
}

// ParseRecord accepts only an exact bounded canonical dormant v2 document.
func ParseRecord(document []byte) (TransactionRecord, error) {
	if err := validateDocumentBytes(document, MaximumTransactionRecordBytes); err != nil {
		return TransactionRecord{}, err
	}
	var envelope transactionDocumentWire
	if err := decodeStrict(document, &envelope); err != nil {
		return TransactionRecord{}, fmt.Errorf("%w: transaction record is not strict JSON", ErrInvalid)
	}
	if envelope.SchemaVersion != SchemaVersion || !validSHA256(envelope.RecordSHA256) {
		return TransactionRecord{}, fmt.Errorf("%w: transaction envelope is invalid", ErrInvalid)
	}
	record, err := recordFromWire(envelope.Record)
	if err != nil {
		return TransactionRecord{}, err
	}
	wire, err := recordToWire(record)
	if err != nil {
		return TransactionRecord{}, err
	}
	payload, err := marshalCanonicalValue(wire, MaximumTransactionRecordBytes)
	if err != nil || digestCanonical(recordDigestDomain, payload) != envelope.RecordSHA256 {
		return TransactionRecord{}, fmt.Errorf("%w: transaction-record digest is invalid", ErrInvalid)
	}
	if err := ValidateRecord(record); err != nil {
		return TransactionRecord{}, err
	}
	canonical, err := MarshalRecord(record)
	if err != nil {
		return TransactionRecord{}, err
	}
	if !bytes.Equal(canonical, document) {
		return TransactionRecord{}, ErrCanonical
	}
	return record, nil
}

func recordToWire(record TransactionRecord) (transactionRecordWire, error) {
	pending, err := marshalPendingAction(record.PendingAction)
	if err != nil {
		return transactionRecordWire{}, err
	}
	return transactionRecordWire{
		ActionPlan:             record.ActionPlan,
		ActivationPolicyState:  record.ActivationPolicyState,
		BlockedCheckpoint:      cloneBlockedCheckpoint(record.BlockedCheckpoint),
		Candidate:              record.Candidate,
		CompletedActionOrdinal: record.CompletedActionOrdinal,
		FailureCode:            record.FailureCode,
		InstallationID:         record.InstallationID,
		Mode:                   record.Mode,
		PendingAction:          pending,
		Phase:                  record.Phase,
		SCMPolicyContractID:    record.SCMPolicyContractID,
		Previous:               record.Previous,
		RecordSequence:         record.RecordSequence,
		RollbackCheckpoint:     record.RollbackCheckpoint,
		TargetArchitecture:     record.TargetArchitecture,
		TransactionID:          record.TransactionID,
		WorkerNodeID:           record.WorkerNodeID,
	}, nil
}

func recordFromWire(document []byte) (TransactionRecord, error) {
	var wire transactionRecordWire
	if err := decodeStrict(document, &wire); err != nil {
		return TransactionRecord{}, fmt.Errorf("%w: transaction-record object is invalid", ErrInvalid)
	}
	pending, err := parsePendingAction(wire.PendingAction)
	if err != nil {
		return TransactionRecord{}, err
	}
	return TransactionRecord{
		ActionPlan:             wire.ActionPlan,
		ActivationPolicyState:  wire.ActivationPolicyState,
		BlockedCheckpoint:      cloneBlockedCheckpoint(wire.BlockedCheckpoint),
		Candidate:              wire.Candidate,
		CompletedActionOrdinal: wire.CompletedActionOrdinal,
		FailureCode:            wire.FailureCode,
		InstallationID:         wire.InstallationID,
		Mode:                   wire.Mode,
		PendingAction:          pending,
		Phase:                  wire.Phase,
		SCMPolicyContractID:    wire.SCMPolicyContractID,
		Previous:               wire.Previous,
		RecordSequence:         wire.RecordSequence,
		RollbackCheckpoint:     wire.RollbackCheckpoint,
		TargetArchitecture:     wire.TargetArchitecture,
		TransactionID:          wire.TransactionID,
		WorkerNodeID:           wire.WorkerNodeID,
	}, nil
}

func marshalPendingAction(action PendingAction) (json.RawMessage, error) {
	if action == nil {
		return json.RawMessage("null"), nil
	}
	switch value := action.(type) {
	case CreateCandidateAction:
		return marshalCanonicalValue(value, MaximumTransactionRecordBytes)
	case PopulateCandidateAction:
		return marshalCanonicalValue(value, MaximumTransactionRecordBytes)
	case RenameAction:
		return marshalCanonicalValue(value, MaximumTransactionRecordBytes)
	case SCMAction:
		if !validSCMActionIdentity(value.ActionKind, value.Role, value.PolicyContractID) {
			return nil, fmt.Errorf("%w: SCM action identity is invalid", ErrInvalid)
		}
		return marshalCanonicalValue(value, MaximumTransactionRecordBytes)
	case SCMGenerationAction:
		if !validSCMGenerationActionIdentity(value) {
			return nil, fmt.Errorf("%w: generation-bound SCM action identity is invalid", ErrInvalid)
		}
		return marshalCanonicalValue(value, MaximumTransactionRecordBytes)
	default:
		return nil, fmt.Errorf("%w: pending action has an unrecognized concrete type", ErrInvalid)
	}
}

func parsePendingAction(document json.RawMessage) (PendingAction, error) {
	if len(document) == 0 {
		return nil, fmt.Errorf("%w: pendingAction is absent", ErrInvalid)
	}
	if bytes.Equal(document, []byte("null")) {
		return nil, nil
	}
	var tag struct {
		ActionKind ActionKind `json:"actionKind"`
	}
	if err := json.Unmarshal(document, &tag); err != nil || tag.ActionKind == "" {
		return nil, fmt.Errorf("%w: pending action tag is invalid", ErrInvalid)
	}
	switch tag.ActionKind {
	case ActionCreateCandidateRoot:
		var action CreateCandidateAction
		if err := decodeStrict(document, &action); err != nil {
			return nil, fmt.Errorf("%w: create-candidate action is invalid", ErrInvalid)
		}
		return action, nil
	case ActionPopulateCandidateRoot:
		var action PopulateCandidateAction
		if err := decodeStrict(document, &action); err != nil {
			return nil, fmt.Errorf("%w: populate-candidate action is invalid", ErrInvalid)
		}
		return action, nil
	case ActionRenameDirectory:
		var action RenameAction
		if err := decodeStrict(document, &action); err != nil {
			return nil, fmt.Errorf("%w: rename action is invalid", ErrInvalid)
		}
		return action, nil
	case ActionStartExecutor, ActionStartControl:
		var action SCMGenerationAction
		if err := decodeStrict(document, &action); err != nil {
			return nil, fmt.Errorf("%w: generation-bound SCM action is invalid", ErrInvalid)
		}
		if !validSCMGenerationActionIdentity(action) {
			return nil, fmt.Errorf("%w: generation-bound SCM action identity is invalid", ErrInvalid)
		}
		return action, nil
	default:
		if !plainSCMActionKind(tag.ActionKind) {
			return nil, fmt.Errorf("%w: pending action kind is unknown or blocked", ErrInvalid)
		}
		var action SCMAction
		if err := decodeStrict(document, &action); err != nil {
			return nil, fmt.Errorf("%w: SCM action is invalid", ErrInvalid)
		}
		if !validSCMActionIdentity(action.ActionKind, action.Role, action.PolicyContractID) {
			return nil, fmt.Errorf("%w: SCM action identity is invalid", ErrInvalid)
		}
		return action, nil
	}
}

func validSCMActionIdentity(kind ActionKind, role ServiceRole, contractID SCMPolicyContractID) bool {
	if contractID != SCMPolicyContractIdentifier {
		return false
	}
	switch kind {
	case ActionClearControlFailureActions,
		ActionClearControlFailureActionsOnNonCrash,
		ActionClearControlDelayedAutoStart,
		ActionSetControlDemandStart,
		ActionStopControl,
		ActionCreateDisabledControlService,
		ActionSetControlServiceSecurity,
		ActionSetControlDescription,
		ActionSetControlServiceSIDType,
		ActionSetControlRequiredPrivileges,
		ActionSetControlPreshutdownPolicy:
		return role == RoleControl
	case ActionClearExecutorFailureActions,
		ActionClearExecutorFailureActionsOnNonCrash,
		ActionClearExecutorDelayedAutoStart,
		ActionSetExecutorDemandStart,
		ActionStopExecutor,
		ActionCreateDisabledExecutorService,
		ActionSetExecutorServiceSecurity,
		ActionSetExecutorDescription,
		ActionSetExecutorServiceSIDType,
		ActionSetExecutorRequiredPrivileges,
		ActionSetExecutorPreshutdownPolicy:
		return role == RoleExecutor
	default:
		return false
	}
}

func validSCMGenerationActionIdentity(action SCMGenerationAction) bool {
	if action.PolicyContractID != SCMPolicyContractIdentifier ||
		(action.TargetGeneration != GenerationCandidate && action.TargetGeneration != GenerationPrevious) {
		return false
	}
	return action.ActionKind == ActionStartExecutor && action.Role == RoleExecutor ||
		action.ActionKind == ActionStartControl && action.Role == RoleControl
}

func plainSCMActionKind(kind ActionKind) bool {
	switch kind {
	case ActionClearControlFailureActions,
		ActionClearControlFailureActionsOnNonCrash,
		ActionClearControlDelayedAutoStart,
		ActionSetControlDemandStart,
		ActionClearExecutorFailureActions,
		ActionClearExecutorFailureActionsOnNonCrash,
		ActionClearExecutorDelayedAutoStart,
		ActionSetExecutorDemandStart,
		ActionStopControl,
		ActionStopExecutor,
		ActionCreateDisabledExecutorService,
		ActionSetExecutorServiceSecurity,
		ActionSetExecutorDescription,
		ActionSetExecutorServiceSIDType,
		ActionSetExecutorRequiredPrivileges,
		ActionSetExecutorPreshutdownPolicy,
		ActionCreateDisabledControlService,
		ActionSetControlServiceSecurity,
		ActionSetControlDescription,
		ActionSetControlServiceSIDType,
		ActionSetControlRequiredPrivileges,
		ActionSetControlPreshutdownPolicy:
		return true
	default:
		return false
	}
}

func marshalCanonicalValue(value any, maximum int) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, fmt.Errorf("%w: canonical JSON encoding failed", ErrInvalid)
	}
	document := buffer.Bytes()
	if len(document) == 0 || document[len(document)-1] != '\n' {
		return nil, fmt.Errorf("%w: canonical JSON delimiter is absent", ErrInvalid)
	}
	document = append([]byte(nil), document[:len(document)-1]...)
	if len(document) == 0 || len(document) > maximum {
		return nil, ErrLimit
	}
	return document, nil
}

func validateDocumentBytes(document []byte, maximum int) error {
	if len(document) == 0 || len(document) > maximum {
		return ErrLimit
	}
	if bytes.HasPrefix(document, []byte{0xef, 0xbb, 0xbf}) || !utf8.Valid(document) {
		return fmt.Errorf("%w: document encoding is invalid", ErrInvalid)
	}
	return nil
}

func decodeStrict(document []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON content")
	}
	return nil
}

func digestCanonical(domain string, document []byte) SHA256 {
	hash := sha256.New()
	_, _ = hash.Write([]byte(domain))
	_, _ = hash.Write(document)
	return SHA256(hex.EncodeToString(hash.Sum(nil)))
}

func canonicalRecordPayloadDigest(record TransactionRecord) (SHA256, error) {
	wire, err := recordToWire(record)
	if err != nil {
		return "", err
	}
	payload, err := marshalCanonicalValue(wire, MaximumTransactionRecordBytes)
	if err != nil {
		return "", err
	}
	return digestCanonical(recordDigestDomain, payload), nil
}

func cloneBlockedCheckpoint(value *BlockedCheckpoint) *BlockedCheckpoint {
	if value == nil {
		return nil
	}
	copy := *value
	copy.MissingPrerequisites = append([]BlockedReason(nil), value.MissingPrerequisites...)
	return &copy
}
