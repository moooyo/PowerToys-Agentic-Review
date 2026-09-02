package installstorev2lab

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestHeadDocumentIsExactCanonicalAndDomainSeparated(t *testing.T) {
	head := testHead()
	document, err := MarshalHeadDocument(head)
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte(`{"entrySha256":"` + strings.Repeat("a", 64) + `","recordSequence":"1","transactionId":"123e4567-e89b-42d3-a456-426614174000"}`)
	hash := sha256.Sum256(append([]byte("AgenticReview split installer active head v2\x00"), payload...))
	want := `{"head":` + string(payload) + `,"headSha256":"` + hex.EncodeToString(hash[:]) + `","schemaVersion":2}`
	if string(document) != want {
		t.Fatalf("head document = %s, want %s", document, want)
	}
	parsed, err := ParseHeadDocument(document)
	if err != nil || parsed != head {
		t.Fatalf("ParseHeadDocument = (%+v, %v), want %+v", parsed, err, head)
	}
}

func TestHeadAndPredecessorRejectNoncanonicalOrMalformedDocuments(t *testing.T) {
	headDocument, err := MarshalHeadDocument(testHead())
	if err != nil {
		t.Fatal(err)
	}
	predecessorDocument, err := MarshalPredecessorDocument(testPredecessor())
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name  string
		parse func([]byte) error
		value []byte
	}{
		{"head whitespace", func(value []byte) error { _, err := ParseHeadDocument(value); return err }, append([]byte(" "), headDocument...)},
		{"head trailing", func(value []byte) error { _, err := ParseHeadDocument(value); return err }, append(append([]byte(nil), headDocument...), 'x')},
		{"head BOM", func(value []byte) error { _, err := ParseHeadDocument(value); return err }, append([]byte{0xef, 0xbb, 0xbf}, headDocument...)},
		{"head unknown", func(value []byte) error { _, err := ParseHeadDocument(value); return err }, bytes.Replace(headDocument, []byte(`,"schemaVersion":2}`), []byte(`,"unknown":1,"schemaVersion":2}`), 1)},
		{"head duplicate", func(value []byte) error { _, err := ParseHeadDocument(value); return err }, bytes.Replace(headDocument, []byte(`"recordSequence":"1"`), []byte(`"recordSequence":"1","recordSequence":"1"`), 1)},
		{"head null", func(value []byte) error { _, err := ParseHeadDocument(value); return err }, bytes.Replace(headDocument, []byte(`"recordSequence":"1"`), []byte(`"recordSequence":null`), 1)},
		{"head digest case", func(value []byte) error { _, err := ParseHeadDocument(value); return err }, bytes.Replace(headDocument, []byte(`"headSha256":"`), []byte(`"headSha256":"A`), 1)},
		{"predecessor whitespace", func(value []byte) error { _, err := ParsePredecessorDocument(value); return err }, append([]byte("\n"), predecessorDocument...)},
		{"predecessor unknown", func(value []byte) error { _, err := ParsePredecessorDocument(value); return err }, bytes.Replace(predecessorDocument, []byte(`,"schemaVersion":2}`), []byte(`,"extra":false,"schemaVersion":2}`), 1)},
		{"predecessor duplicate", func(value []byte) error { _, err := ParsePredecessorDocument(value); return err }, bytes.Replace(predecessorDocument, []byte(`"sourceSchemaVersion":1`), []byte(`"sourceSchemaVersion":1,"sourceSchemaVersion":1`), 1)},
		{"predecessor wrong source", func(value []byte) error { _, err := ParsePredecessorDocument(value); return err }, bytes.Replace(predecessorDocument, []byte(`"sourceSchemaVersion":1`), []byte(`"sourceSchemaVersion":2`), 1)},
		{"invalid UTF-8", func(value []byte) error { _, err := ParseHeadDocument(value); return err }, []byte{0xff}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := test.parse(test.value); err == nil {
				t.Fatal("malformed document was accepted")
			}
		})
	}
	if _, err := ParseHeadDocument(bytes.Repeat([]byte("x"), MaximumHeadDocumentBytes+1)); !errors.Is(err, ErrLimit) {
		t.Fatalf("oversized head error = %v, want ErrLimit", err)
	}
	if _, err := ParsePredecessorDocument(bytes.Repeat([]byte("x"), MaximumPredecessorDocumentBytes+1)); !errors.Is(err, ErrLimit) {
		t.Fatalf("oversized predecessor error = %v, want ErrLimit", err)
	}
}

func TestV1InventorySortsDetachedCopyAndRequiresCanonicalOrder(t *testing.T) {
	input := []V1InventoryEntry{testInventoryEntry(2), testInventoryEntry(0), testInventoryEntry(1)}
	original := append([]V1InventoryEntry(nil), input...)
	document, digest, err := MarshalV1Inventory(input)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(input, original) {
		t.Fatal("MarshalV1Inventory mutated its caller-owned slice")
	}
	if digest != digestCanonical(inventoryDigestDomain, document) {
		t.Fatalf("inventory digest = %s", digest)
	}
	parsed, parsedDigest, err := ParseV1Inventory(document)
	if err != nil || parsedDigest != digest || len(parsed) != len(input) {
		t.Fatalf("ParseV1Inventory = (%+v, %s, %v)", parsed, parsedDigest, err)
	}
	for index := 1; index < len(parsed); index++ {
		if parsed[index-1].TransactionID >= parsed[index].TransactionID {
			t.Fatal("parsed inventory is not strictly sorted")
		}
	}
	unsorted, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := ParseV1Inventory(unsorted); !errors.Is(err, ErrCanonical) {
		t.Fatalf("unsorted inventory error = %v, want ErrCanonical", err)
	}
	duplicate := []V1InventoryEntry{testInventoryEntry(0), testInventoryEntry(0)}
	if _, _, err := MarshalV1Inventory(duplicate); err == nil {
		t.Fatal("duplicate inventory was accepted")
	}
	invalid := testInventoryEntry(0)
	invalid.TerminalDisposition = "failed-closed"
	if _, _, err := MarshalV1Inventory([]V1InventoryEntry{invalid}); err == nil {
		t.Fatal("non-successful legacy terminal disposition was accepted")
	}
}

func TestV1InventoryRejectsStrictJSONAndCanonicalMutations(t *testing.T) {
	document, _, err := MarshalV1Inventory([]V1InventoryEntry{testInventoryEntry(0)})
	if err != nil {
		t.Fatal(err)
	}
	mutations := [][]byte{
		append([]byte(" "), document...),
		append(append([]byte(nil), document...), []byte("null")...),
		bytes.Replace(document, []byte(`{"recordDocumentSha256":`), []byte(`{"unknown":true,"recordDocumentSha256":`), 1),
		bytes.Replace(document, []byte(`"recordSequence":"1"`), []byte(`"recordSequence":"1","recordSequence":"1"`), 1),
		bytes.Replace(document, []byte(`"recordSequence":"1"`), []byte(`"recordSequence":null`), 1),
		bytes.Replace(document, []byte(`"recordDocumentSha256":"0`), []byte(`"recordDocumentSha256":"A`), 1),
		bytes.Replace(document,
			[]byte(`{"recordDocumentSha256":"`+strings.Repeat("0", 63)+`1","recordSequence":"1",`),
			[]byte(`{"recordSequence":"1","recordDocumentSha256":"`+strings.Repeat("0", 63)+`1",`), 1),
	}
	for index, mutation := range mutations {
		if bytes.Equal(mutation, document) {
			t.Fatalf("inventory mutation %d did not change the fixture", index)
		}
		if _, _, err := ParseV1Inventory(mutation); err == nil {
			t.Fatalf("inventory mutation %d was accepted", index)
		}
	}
}

func TestV1InventoryAccepts4096AndRejects4097(t *testing.T) {
	entries := make([]V1InventoryEntry, MaximumLegacyTransactionDirectories+1)
	for index := range entries {
		entries[index] = testInventoryEntry(index)
	}
	if _, _, err := MarshalV1Inventory(entries[:MaximumLegacyTransactionDirectories]); err != nil {
		t.Fatalf("maximum inventory rejected: %v", err)
	}
	if _, _, err := MarshalV1Inventory(entries); !errors.Is(err, ErrLimit) {
		t.Fatalf("oversized inventory error = %v, want ErrLimit", err)
	}
	if _, _, err := ParseV1Inventory(bytes.Repeat([]byte("x"), MaximumV1InventoryDocumentBytes+1)); !errors.Is(err, ErrLimit) {
		t.Fatalf("oversized inventory document error = %v, want ErrLimit", err)
	}
	nullFlood := []byte("[" + strings.Repeat("null,", int(MaximumLegacyTransactionDirectories)) + "null]")
	if len(nullFlood) >= MaximumV1InventoryDocumentBytes {
		t.Fatal("inventory count-bound fixture unexpectedly exceeds the byte ceiling")
	}
	if _, _, err := ParseV1Inventory(nullFlood); !errors.Is(err, ErrLimit) {
		t.Fatalf("inventory count overflow error = %v, want ErrLimit", err)
	}
	emptyObjectFlood := []byte("[" + strings.Repeat("{},", int(MaximumLegacyTransactionDirectories)) + "{}]")
	if len(emptyObjectFlood) >= MaximumV1InventoryDocumentBytes {
		t.Fatal("empty-object count-bound fixture unexpectedly exceeds the byte ceiling")
	}
	if _, _, err := ParseV1Inventory(emptyObjectFlood); !errors.Is(err, ErrLimit) {
		t.Fatalf("empty-object inventory overflow error = %v, want ErrLimit", err)
	}
}

func TestV2HeadAndEntrySequenceCeilingIs4096(t *testing.T) {
	head := testHead()
	head.RecordSequence = "4096"
	if _, err := MarshalHeadDocument(head); err != nil {
		t.Fatalf("maximum v2 head sequence rejected: %v", err)
	}
	head.RecordSequence = "4097"
	if _, err := MarshalHeadDocument(head); err == nil {
		t.Fatal("v2 head accepted sequence 4097")
	}
	previous := SHA256(strings.Repeat("c", 64))
	if _, err := MarshalEntryDocument(Entry{
		PreviousEntrySHA256: &previous,
		RecordDocument:      testRecord("4096"),
	}); err != nil {
		t.Fatalf("maximum v2 entry sequence rejected: %v", err)
	}
	if _, err := MarshalEntryDocument(Entry{
		PreviousEntrySHA256: &previous,
		RecordDocument:      testRecord("4097"),
	}); err == nil {
		t.Fatal("v2 entry accepted sequence 4097")
	}
}

func TestEntryNestsExactTypedDocumentsAndRejectsLinkageDrift(t *testing.T) {
	predecessor := testPredecessor()
	entry := Entry{PredecessorDocument: &predecessor, RecordDocument: testRecord("1")}
	document, err := MarshalEntryDocument(entry)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(document, []byte(`"recordDocument":"`)) ||
		!bytes.Contains(document, []byte(`"recordDocument":{"record":`)) ||
		!bytes.Contains(document, []byte(`"predecessorDocument":{"predecessor":`)) {
		t.Fatalf("entry does not embed nested canonical objects: %s", document)
	}
	parsed, err := ParseEntryDocument(document)
	if err != nil || parsed.PredecessorDocument == nil ||
		*parsed.PredecessorDocument != predecessor ||
		!reflect.DeepEqual(parsed.RecordDocument, entry.RecordDocument) {
		t.Fatalf("ParseEntryDocument = (%+v, %v)", parsed, err)
	}

	previous := SHA256(strings.Repeat("b", 64))
	successor := Entry{PreviousEntrySHA256: &previous, RecordDocument: testRecord("2")}
	if _, err := MarshalEntryDocument(successor); err != nil {
		t.Fatalf("valid successor rejected: %v", err)
	}
	badSequenceOne := entry
	badSequenceOne.PreviousEntrySHA256 = &previous
	if _, err := MarshalEntryDocument(badSequenceOne); err == nil {
		t.Fatal("sequence one accepted previousEntrySha256")
	}
	badSuccessor := successor
	badSuccessor.PredecessorDocument = &predecessor
	if _, err := MarshalEntryDocument(badSuccessor); err == nil {
		t.Fatal("later successor accepted predecessorDocument")
	}
	missingLink := Entry{RecordDocument: testRecord("2")}
	if _, err := MarshalEntryDocument(missingLink); err == nil {
		t.Fatal("later successor accepted missing previousEntrySha256")
	}
	reflexivePredecessor := predecessor
	reflexivePredecessor.TransactionID = testTransactionID
	if _, err := MarshalEntryDocument(Entry{
		PredecessorDocument: &reflexivePredecessor,
		RecordDocument:      testRecord("1"),
	}); err == nil {
		t.Fatal("migration genesis accepted a predecessor with the new transaction ID")
	}
}

func TestEntryRejectsNestedAndOuterCanonicalMutations(t *testing.T) {
	predecessor := testPredecessor()
	document, err := MarshalEntryDocument(Entry{
		PredecessorDocument: &predecessor,
		RecordDocument:      testRecord("1"),
	})
	if err != nil {
		t.Fatal(err)
	}
	mutations := [][]byte{
		append([]byte(" "), document...),
		bytes.Replace(document, []byte(`,"schemaVersion":2}`), []byte(`,"unknown":1,"schemaVersion":2}`), 1),
		bytes.Replace(document, []byte(`"previousEntrySha256":null`), []byte(`"previousEntrySha256":null,"previousEntrySha256":null`), 1),
		bytes.Replace(document, []byte(`"predecessorDocument":{`), []byte(`"predecessorDocument":{"extra":true,`), 1),
		bytes.Replace(document, []byte(`"recordDocument":{"record":{`), []byte(`"recordDocument":{"record":{"extra":true,`), 1),
		bytes.Replace(document, []byte(`"schemaVersion":2`), []byte(`"schemaVersion":null`), 1),
	}
	for index, mutation := range mutations {
		if _, err := ParseEntryDocument(mutation); err == nil {
			t.Fatalf("mutation %d was accepted", index)
		}
	}
	if _, err := ParseEntryDocument(bytes.Repeat([]byte("x"), MaximumEntryDocumentBytes+1)); !errors.Is(err, ErrLimit) {
		t.Fatalf("oversized entry error = %v, want ErrLimit", err)
	}
}
