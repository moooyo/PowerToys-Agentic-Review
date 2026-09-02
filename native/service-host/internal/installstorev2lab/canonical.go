package installstorev2lab

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"

	recordv2 "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installtransactionv2lab"
)

const (
	headDigestDomain        = "AgenticReview split installer active head v2\x00"
	predecessorDigestDomain = "AgenticReview split installer transaction predecessor v2\x00"
	inventoryDigestDomain   = "AgenticReview split installer v1 migration inventory v2\x00"
	entryDigestDomain       = "AgenticReview split installer transaction WAL entry v2\x00"
)

// Entry wraps one complete canonical ADR 0020 transaction document.
type Entry struct {
	PredecessorDocument *Predecessor
	PreviousEntrySHA256 *SHA256
	RecordDocument      recordv2.TransactionRecord
}

type headDocumentWire struct {
	Head          json.RawMessage `json:"head"`
	HeadSHA256    SHA256          `json:"headSha256"`
	SchemaVersion uint32          `json:"schemaVersion"`
}

type predecessorDocumentWire struct {
	Predecessor       json.RawMessage `json:"predecessor"`
	PredecessorSHA256 SHA256          `json:"predecessorSha256"`
	SchemaVersion     uint32          `json:"schemaVersion"`
}

type entryWire struct {
	PredecessorDocument json.RawMessage `json:"predecessorDocument"`
	PreviousEntrySHA256 *SHA256         `json:"previousEntrySha256"`
	RecordDocument      json.RawMessage `json:"recordDocument"`
}

type entryDocumentWire struct {
	Entry         json.RawMessage `json:"entry"`
	EntrySHA256   SHA256          `json:"entrySha256"`
	SchemaVersion uint32          `json:"schemaVersion"`
}

// MarshalHeadDocument validates and encodes one canonical v2 head document.
func MarshalHeadDocument(head Head) ([]byte, error) {
	if err := validateHead(head); err != nil {
		return nil, err
	}
	payload, err := marshalCanonicalValue(head, MaximumHeadDocumentBytes)
	if err != nil {
		return nil, err
	}
	document := headDocumentWire{
		Head:          payload,
		HeadSHA256:    digestCanonical(headDigestDomain, payload),
		SchemaVersion: SchemaVersion,
	}
	return marshalCanonicalValue(document, MaximumHeadDocumentBytes)
}

// ParseHeadDocument accepts only one exact bounded canonical v2 head document.
func ParseHeadDocument(document []byte) (Head, error) {
	if err := validateDocumentBytes(document, MaximumHeadDocumentBytes); err != nil {
		return Head{}, err
	}
	var envelope headDocumentWire
	if err := decodeStrict(document, &envelope); err != nil ||
		envelope.SchemaVersion != SchemaVersion || !validSHA256(envelope.HeadSHA256) {
		return Head{}, fmt.Errorf("%w: head document is invalid", ErrInvalid)
	}
	var head Head
	if err := decodeStrict(envelope.Head, &head); err != nil || validateHead(head) != nil {
		return Head{}, fmt.Errorf("%w: head payload is invalid", ErrInvalid)
	}
	payload, err := marshalCanonicalValue(head, MaximumHeadDocumentBytes)
	if err != nil || !bytes.Equal(payload, envelope.Head) ||
		digestCanonical(headDigestDomain, payload) != envelope.HeadSHA256 {
		return Head{}, fmt.Errorf("%w: head payload or digest is invalid", ErrInvalid)
	}
	canonical, err := MarshalHeadDocument(head)
	if err != nil {
		return Head{}, err
	}
	if !bytes.Equal(canonical, document) {
		return Head{}, ErrCanonical
	}
	return head, nil
}

// MarshalPredecessorDocument validates and encodes one canonical v1 binding.
func MarshalPredecessorDocument(predecessor Predecessor) ([]byte, error) {
	if err := validatePredecessor(predecessor); err != nil {
		return nil, err
	}
	payload, err := marshalCanonicalValue(predecessor, MaximumPredecessorDocumentBytes)
	if err != nil {
		return nil, err
	}
	document := predecessorDocumentWire{
		Predecessor:       payload,
		PredecessorSHA256: digestCanonical(predecessorDigestDomain, payload),
		SchemaVersion:     SchemaVersion,
	}
	return marshalCanonicalValue(document, MaximumPredecessorDocumentBytes)
}

// ParsePredecessorDocument accepts only one exact canonical predecessor document.
func ParsePredecessorDocument(document []byte) (Predecessor, error) {
	if err := validateDocumentBytes(document, MaximumPredecessorDocumentBytes); err != nil {
		return Predecessor{}, err
	}
	var envelope predecessorDocumentWire
	if err := decodeStrict(document, &envelope); err != nil ||
		envelope.SchemaVersion != SchemaVersion || !validSHA256(envelope.PredecessorSHA256) {
		return Predecessor{}, fmt.Errorf("%w: predecessor document is invalid", ErrInvalid)
	}
	var predecessor Predecessor
	if err := decodeStrict(envelope.Predecessor, &predecessor); err != nil ||
		validatePredecessor(predecessor) != nil {
		return Predecessor{}, fmt.Errorf("%w: predecessor payload is invalid", ErrInvalid)
	}
	payload, err := marshalCanonicalValue(predecessor, MaximumPredecessorDocumentBytes)
	if err != nil || !bytes.Equal(payload, envelope.Predecessor) ||
		digestCanonical(predecessorDigestDomain, payload) != envelope.PredecessorSHA256 {
		return Predecessor{}, fmt.Errorf("%w: predecessor payload or digest is invalid", ErrInvalid)
	}
	canonical, err := MarshalPredecessorDocument(predecessor)
	if err != nil {
		return Predecessor{}, err
	}
	if !bytes.Equal(canonical, document) {
		return Predecessor{}, ErrCanonical
	}
	return predecessor, nil
}

// MarshalV1Inventory sorts a detached copy, rejects duplicates, and returns
// the canonical inventory and its domain-separated digest.
func MarshalV1Inventory(entries []V1InventoryEntry) ([]byte, SHA256, error) {
	if len(entries) == 0 {
		return nil, "", fmt.Errorf("%w: v1 inventory is empty", ErrInvalid)
	}
	if uint64(len(entries)) > MaximumLegacyTransactionDirectories {
		return nil, "", ErrLimit
	}
	detached := append([]V1InventoryEntry(nil), entries...)
	for _, entry := range detached {
		if err := validateInventoryEntry(entry); err != nil {
			return nil, "", err
		}
	}
	sort.Slice(detached, func(left, right int) bool {
		return string(detached[left].TransactionID) < string(detached[right].TransactionID)
	})
	for index := 1; index < len(detached); index++ {
		if detached[index-1].TransactionID == detached[index].TransactionID {
			return nil, "", fmt.Errorf("%w: v1 inventory contains a duplicate transaction", ErrInvalid)
		}
	}
	document, err := marshalCanonicalValue(detached, MaximumV1InventoryDocumentBytes)
	if err != nil {
		return nil, "", err
	}
	return document, digestCanonical(inventoryDigestDomain, document), nil
}

// ParseV1Inventory accepts only the exact sorted canonical inventory array.
func ParseV1Inventory(document []byte) ([]V1InventoryEntry, SHA256, error) {
	if err := validateDocumentBytes(document, MaximumV1InventoryDocumentBytes); err != nil {
		return nil, "", err
	}
	entries, err := decodeV1InventoryBounded(document)
	if err != nil {
		if errors.Is(err, ErrLimit) {
			return nil, "", err
		}
		return nil, "", fmt.Errorf("%w: v1 inventory is invalid", ErrInvalid)
	}
	canonical, digest, err := MarshalV1Inventory(entries)
	if err != nil {
		return nil, "", err
	}
	if !bytes.Equal(canonical, document) {
		return nil, "", ErrCanonical
	}
	return append([]V1InventoryEntry(nil), entries...), digest, nil
}

func decodeV1InventoryBounded(document []byte) ([]V1InventoryEntry, error) {
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.DisallowUnknownFields()
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('[') {
		return nil, fmt.Errorf("inventory is not an array")
	}
	entries := make([]V1InventoryEntry, 0)
	for decoder.More() {
		if uint64(len(entries)) >= MaximumLegacyTransactionDirectories {
			return nil, ErrLimit
		}
		var entry V1InventoryEntry
		if err := decoder.Decode(&entry); err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim(']') {
		return nil, fmt.Errorf("inventory array is not closed")
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, fmt.Errorf("inventory has a trailing value")
		}
		return nil, err
	}
	return entries, nil
}

// MarshalEntryDocument validates and encodes one canonical append-only entry.
func MarshalEntryDocument(entry Entry) ([]byte, error) {
	recordDocument, err := recordv2.MarshalRecord(entry.RecordDocument)
	if err != nil {
		return nil, fmt.Errorf("%w: nested ADR 0020 record is invalid", ErrInvalid)
	}
	if len(recordDocument) > MaximumNestedRecordBytes {
		return nil, ErrLimit
	}
	if err := validateEntryBindings(entry); err != nil {
		return nil, err
	}
	predecessorDocument := json.RawMessage("null")
	if entry.PredecessorDocument != nil {
		predecessorDocument, err = MarshalPredecessorDocument(*entry.PredecessorDocument)
		if err != nil {
			return nil, err
		}
	}
	var previous *SHA256
	if entry.PreviousEntrySHA256 != nil {
		value := *entry.PreviousEntrySHA256
		previous = &value
	}
	payload, err := marshalCanonicalValue(entryWire{
		PredecessorDocument: predecessorDocument,
		PreviousEntrySHA256: previous,
		RecordDocument:      recordDocument,
	}, MaximumEntryDocumentBytes)
	if err != nil {
		return nil, err
	}
	document := entryDocumentWire{
		Entry:         payload,
		EntrySHA256:   digestCanonical(entryDigestDomain, payload),
		SchemaVersion: SchemaVersion,
	}
	return marshalCanonicalValue(document, MaximumEntryDocumentBytes)
}

// ParseEntryDocument validates each nested canonical document before rebuilding
// the outer entry and requiring exact byte equality.
func ParseEntryDocument(document []byte) (Entry, error) {
	if err := validateDocumentBytes(document, MaximumEntryDocumentBytes); err != nil {
		return Entry{}, err
	}
	var envelope entryDocumentWire
	if err := decodeStrict(document, &envelope); err != nil ||
		envelope.SchemaVersion != SchemaVersion || !validSHA256(envelope.EntrySHA256) {
		return Entry{}, fmt.Errorf("%w: entry document is invalid", ErrInvalid)
	}
	var wire entryWire
	if err := decodeStrict(envelope.Entry, &wire); err != nil || len(wire.RecordDocument) == 0 {
		return Entry{}, fmt.Errorf("%w: entry payload is invalid", ErrInvalid)
	}
	var predecessor *Predecessor
	if bytes.Equal(wire.PredecessorDocument, []byte("null")) {
		predecessor = nil
	} else {
		value, err := ParsePredecessorDocument(wire.PredecessorDocument)
		if err != nil {
			return Entry{}, err
		}
		reencoded, err := MarshalPredecessorDocument(value)
		if err != nil || !bytes.Equal(reencoded, wire.PredecessorDocument) {
			return Entry{}, fmt.Errorf("%w: nested predecessor changed on re-encode", ErrInvalid)
		}
		predecessor = &value
	}
	if len(wire.RecordDocument) > MaximumNestedRecordBytes {
		return Entry{}, ErrLimit
	}
	record, err := recordv2.ParseRecord(wire.RecordDocument)
	if err != nil {
		return Entry{}, fmt.Errorf("%w: nested ADR 0020 record is invalid", ErrInvalid)
	}
	reencodedRecord, err := recordv2.MarshalRecord(record)
	if err != nil || !bytes.Equal(reencodedRecord, wire.RecordDocument) {
		return Entry{}, fmt.Errorf("%w: nested ADR 0020 record changed on re-encode", ErrInvalid)
	}
	entry := Entry{
		PredecessorDocument: predecessor,
		PreviousEntrySHA256: wire.PreviousEntrySHA256,
		RecordDocument:      record,
	}
	if err := validateEntryBindings(entry); err != nil {
		return Entry{}, err
	}
	payload, err := marshalCanonicalValue(wire, MaximumEntryDocumentBytes)
	if err != nil || !bytes.Equal(payload, envelope.Entry) ||
		digestCanonical(entryDigestDomain, payload) != envelope.EntrySHA256 {
		return Entry{}, fmt.Errorf("%w: entry payload or digest is invalid", ErrInvalid)
	}
	canonical, err := MarshalEntryDocument(entry)
	if err != nil {
		return Entry{}, err
	}
	if !bytes.Equal(canonical, document) {
		return Entry{}, ErrCanonical
	}
	return entry, nil
}
