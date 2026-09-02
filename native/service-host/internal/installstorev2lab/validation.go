package installstorev2lab

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"unicode/utf8"
)

var transactionIDPattern = regexp.MustCompile(
	`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
)

func validateHead(head Head) error {
	if !validSHA256(head.EntrySHA256) || !validV2Sequence(head.RecordSequence) ||
		!validTransactionID(head.TransactionID) {
		return fmt.Errorf("%w: head fields are invalid", ErrInvalid)
	}
	return nil
}

func validatePredecessor(predecessor Predecessor) error {
	if !validSHA256(predecessor.HeadDocumentSHA256) ||
		!validSHA256(predecessor.InventorySHA256) ||
		!validSHA256(predecessor.RecordDocumentSHA256) ||
		!validDecimalUint64(predecessor.RecordSequence) ||
		predecessor.SourceSchemaVersion != 1 ||
		!validTransactionID(predecessor.TransactionID) {
		return fmt.Errorf("%w: predecessor fields are invalid", ErrInvalid)
	}
	return nil
}

func validateInventoryEntry(entry V1InventoryEntry) error {
	if !validSHA256(entry.RecordDocumentSHA256) || !validDecimalUint64(entry.RecordSequence) ||
		!validTransactionID(entry.TransactionID) ||
		(entry.TerminalDisposition != TerminalCommittedApplied &&
			entry.TerminalDisposition != TerminalRolledBackApplied) {
		return fmt.Errorf("%w: v1 inventory entry is invalid", ErrInvalid)
	}
	return nil
}

func validateEntryBindings(entry Entry) error {
	recordSequence := DecimalUint64(entry.RecordDocument.RecordSequence)
	transactionID := TransactionID(entry.RecordDocument.TransactionID)
	if !validV2Sequence(recordSequence) || !validTransactionID(transactionID) {
		return fmt.Errorf("%w: nested transaction identity is invalid", ErrInvalid)
	}
	sequence, err := strconv.ParseUint(string(recordSequence), 10, 64)
	if err != nil || sequence == 0 {
		return fmt.Errorf("%w: nested record sequence is invalid", ErrInvalid)
	}
	if sequence == 1 {
		if entry.PreviousEntrySHA256 != nil {
			return fmt.Errorf("%w: sequence one cannot name a previous entry", ErrInvalid)
		}
		if entry.PredecessorDocument != nil &&
			(entry.PredecessorDocument.TransactionID == transactionID ||
				entry.PredecessorDocument.SourceSchemaVersion != 1) {
			return fmt.Errorf("%w: sequence-one predecessor is invalid", ErrInvalid)
		}
		return nil
	}
	if entry.PredecessorDocument != nil || entry.PreviousEntrySHA256 == nil ||
		!validSHA256(*entry.PreviousEntrySHA256) {
		return fmt.Errorf("%w: successor linkage is invalid", ErrInvalid)
	}
	return nil
}

func validateDocumentBytes(document []byte, maximum uint64) error {
	if len(document) == 0 {
		return fmt.Errorf("%w: document is empty", ErrInvalid)
	}
	if uint64(len(document)) > maximum {
		return ErrLimit
	}
	if bytes.HasPrefix(document, []byte{0xef, 0xbb, 0xbf}) || !utf8.Valid(document) {
		return fmt.Errorf("%w: document must be UTF-8 without a BOM", ErrInvalid)
	}
	return nil
}

func decodeStrict(document []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("trailing JSON value")
		}
		return err
	}
	return nil
}

func marshalCanonicalValue(value any, maximum uint64) ([]byte, error) {
	document, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("%w: canonical JSON encoding failed", ErrInvalid)
	}
	if uint64(len(document)) > maximum {
		return nil, ErrLimit
	}
	return document, nil
}

func digestCanonical(domain string, document []byte) SHA256 {
	hash := sha256.New()
	_, _ = hash.Write([]byte(domain))
	_, _ = hash.Write(document)
	return SHA256(fmt.Sprintf("%x", hash.Sum(nil)))
}

func validSHA256(value SHA256) bool {
	return len(value) == sha256.Size*2 && validLowerHex(string(value))
}

func validLowerHex(value string) bool {
	for _, character := range []byte(value) {
		if character >= '0' && character <= '9' || character >= 'a' && character <= 'f' {
			continue
		}
		return false
	}
	return true
}

func validTransactionID(value TransactionID) bool {
	return transactionIDPattern.MatchString(string(value))
}

func validDecimalUint64(value DecimalUint64) bool {
	if value == "" || value == "0" || value[0] == '0' {
		return false
	}
	parsed, err := strconv.ParseUint(string(value), 10, 64)
	return err == nil && parsed != 0 && strconv.FormatUint(parsed, 10) == string(value)
}

func validV2Sequence(value DecimalUint64) bool {
	if !validDecimalUint64(value) {
		return false
	}
	parsed, err := strconv.ParseUint(string(value), 10, 64)
	return err == nil && parsed <= MaximumV2Entries
}

func validateNamespaceBounds(bounds namespaceBounds) error {
	if bounds.legacyTransactionDirectories > MaximumLegacyTransactionDirectories ||
		bounds.currentV2TransactionDirectories > MaximumCurrentV2TransactionDirectories ||
		bounds.legacyTransactionDirectories+bounds.currentV2TransactionDirectories >
			MaximumCanonicalTransactionDirectories ||
		bounds.migrationStagingDirectories > MaximumMigrationStagingDirectories ||
		bounds.v2Entries > MaximumV2Entries ||
		bounds.aggregateDocumentBytes > MaximumAggregateDocumentBytes ||
		bounds.retainedHandles > MaximumRetainedHandles ||
		bounds.documentBuffers > MaximumDocumentBuffers ||
		bounds.liveWorkingSetBytes > MaximumLiveWorkingSetBytes ||
		bounds.recoverySeconds > MaximumRecoverySeconds {
		return ErrLimit
	}
	return nil
}

type namespaceBounds struct {
	legacyTransactionDirectories    uint64
	currentV2TransactionDirectories uint64
	migrationStagingDirectories     uint64
	v2Entries                       uint64
	aggregateDocumentBytes          uint64
	retainedHandles                 uint64
	documentBuffers                 uint64
	liveWorkingSetBytes             uint64
	recoverySeconds                 uint64
}
