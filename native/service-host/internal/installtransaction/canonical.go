package installtransaction

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

const (
	activeHeadDigestDomain = "AgenticReview split installer active head v1\x00"
	recordDigestDomain     = "AgenticReview split installer transaction record v1\x00"
)

type transactionRecordWire struct {
	ActionPlan             ActionPlan            `json:"actionPlan"`
	ActivationPolicyState  ActivationPolicyState `json:"activationPolicyState"`
	Candidate              CandidateGeneration   `json:"candidate"`
	CompletedActionOrdinal ActionOrdinal         `json:"completedActionOrdinal"`
	FailureCode            *FailureCode          `json:"failureCode"`
	InstallationID         PackageComponentID    `json:"installationId"`
	Mode                   Mode                  `json:"mode"`
	PendingAction          json.RawMessage       `json:"pendingAction"`
	Phase                  Phase                 `json:"phase"`
	Previous               *PackageGeneration    `json:"previous"`
	RecordSequence         DecimalUint64         `json:"recordSequence"`
	RollbackCheckpoint     RollbackCheckpoint    `json:"rollbackCheckpoint"`
	TargetArchitecture     TargetArchitecture    `json:"targetArchitecture"`
	TransactionID          TransactionID         `json:"transactionId"`
	WorkerNodeID           EntityID              `json:"workerNodeId"`
}

type activeHeadDocument struct {
	Head          ActiveHead `json:"head"`
	HeadSHA256    SHA256     `json:"headSha256"`
	SchemaVersion uint32     `json:"schemaVersion"`
}

type transactionDocumentWire struct {
	Record        json.RawMessage `json:"record"`
	RecordSHA256  SHA256          `json:"recordSha256"`
	SchemaVersion uint32          `json:"schemaVersion"`
}

// MarshalActiveHead validates and encodes one canonical active-head document.
func MarshalActiveHead(head ActiveHead) ([]byte, error) {
	if !validTransactionID(head.TransactionID) {
		return nil, fmt.Errorf("%w: active-head transaction ID is invalid", ErrInvalid)
	}
	payload, err := marshalCanonicalValue(head, MaximumActiveHeadBytes)
	if err != nil {
		return nil, err
	}
	document := activeHeadDocument{
		Head:          head,
		HeadSHA256:    digestCanonical(activeHeadDigestDomain, payload),
		SchemaVersion: SchemaVersion,
	}
	return marshalCanonicalValue(document, MaximumActiveHeadBytes)
}

// ParseActiveHead accepts only the exact bounded canonical head document and verifies its digest.
func ParseActiveHead(document []byte) (ActiveHead, error) {
	if err := validateDocumentBytes(document, MaximumActiveHeadBytes); err != nil {
		return ActiveHead{}, err
	}
	var envelope activeHeadDocument
	if err := decodeStrict(document, &envelope); err != nil {
		return ActiveHead{}, fmt.Errorf("%w: active head is not strict JSON", ErrInvalid)
	}
	if envelope.SchemaVersion != SchemaVersion || !validTransactionID(envelope.Head.TransactionID) ||
		!validSHA256(envelope.HeadSHA256) {
		return ActiveHead{}, fmt.Errorf("%w: active-head fields are invalid", ErrInvalid)
	}
	payload, err := marshalCanonicalValue(envelope.Head, MaximumActiveHeadBytes)
	if err != nil || digestCanonical(activeHeadDigestDomain, payload) != envelope.HeadSHA256 {
		return ActiveHead{}, fmt.Errorf("%w: active-head digest is invalid", ErrInvalid)
	}
	canonical, err := MarshalActiveHead(envelope.Head)
	if err != nil {
		return ActiveHead{}, err
	}
	if !bytes.Equal(canonical, document) {
		return ActiveHead{}, ErrCanonical
	}
	return envelope.Head, nil
}

// MarshalRecord validates and encodes one canonical transaction-record document.
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

// ParseRecord accepts only the exact bounded canonical record document and verifies its digest.
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
		Candidate:              record.Candidate,
		CompletedActionOrdinal: record.CompletedActionOrdinal,
		FailureCode:            record.FailureCode,
		InstallationID:         record.InstallationID,
		Mode:                   record.Mode,
		PendingAction:          pending,
		Phase:                  record.Phase,
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
		Candidate:              wire.Candidate,
		CompletedActionOrdinal: wire.CompletedActionOrdinal,
		FailureCode:            wire.FailureCode,
		InstallationID:         wire.InstallationID,
		Mode:                   wire.Mode,
		PendingAction:          pending,
		Phase:                  wire.Phase,
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
	case PolicyAction:
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
	case ActionApplyCandidateExecutorPolicy, ActionApplyCandidateControlPolicy,
		ActionApplyPreviousExecutorPolicy, ActionApplyPreviousControlPolicy:
		var action PolicyAction
		if err := decodeStrict(document, &action); err != nil {
			return nil, fmt.Errorf("%w: policy action is invalid", ErrInvalid)
		}
		return action, nil
	default:
		return nil, fmt.Errorf("%w: pending action kind is unknown", ErrInvalid)
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
