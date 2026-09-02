package installstorev2lab

import (
	"bytes"
	"encoding/json"
	"testing"

	recordv2 "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installtransactionv2lab"
)

const recordV2DigestDomainForTest = "AgenticReview split installer transaction record v2\x00"

func TestEntryRejectsRehashedInvalidOrNoncanonicalNestedRecord(t *testing.T) {
	validRecordDocument, err := recordv2.MarshalRecord(testRecord("1"))
	if err != nil {
		t.Fatal(err)
	}
	var validEnvelope struct {
		Record        json.RawMessage `json:"record"`
		RecordSHA256  recordv2.SHA256 `json:"recordSha256"`
		SchemaVersion uint32          `json:"schemaVersion"`
	}
	if err := json.Unmarshal(validRecordDocument, &validEnvelope); err != nil {
		t.Fatal(err)
	}
	mutations := []struct {
		name    string
		payload []byte
	}{
		{"invalid state", bytes.Replace(validEnvelope.Record, []byte(`"phase":"STAGING_VERIFIED"`), []byte(`"phase":"COMMITTED"`), 1)},
		{"unknown field", bytes.Replace(validEnvelope.Record, []byte(`{"actionPlan":`), []byte(`{"unknown":true,"actionPlan":`), 1)},
		{"duplicate field", bytes.Replace(validEnvelope.Record, []byte(`"actionPlan":"none"`), []byte(`"actionPlan":"none","actionPlan":"none"`), 1)},
		{"reordered fields", bytes.Replace(validEnvelope.Record,
			[]byte(`{"actionPlan":"none","activationPolicyState":"not-applicable",`),
			[]byte(`{"activationPolicyState":"not-applicable","actionPlan":"none",`), 1)},
		{"escaped key", bytes.Replace(validEnvelope.Record, []byte(`"actionPlan"`), []byte(`"action\u0050lan"`), 1)},
	}
	predecessor, err := MarshalPredecessorDocument(testPredecessor())
	if err != nil {
		t.Fatal(err)
	}
	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			if bytes.Equal(mutation.payload, validEnvelope.Record) {
				t.Fatal("fixture mutation did not change the nested payload")
			}
			recordDocument, err := marshalCanonicalValue(struct {
				Record        json.RawMessage `json:"record"`
				RecordSHA256  SHA256          `json:"recordSha256"`
				SchemaVersion uint32          `json:"schemaVersion"`
			}{
				Record: mutation.payload, RecordSHA256: digestCanonical(recordV2DigestDomainForTest, mutation.payload),
				SchemaVersion: recordv2.SchemaVersion,
			}, MaximumNestedRecordBytes)
			if err != nil {
				t.Fatal(err)
			}
			document := rehashedEntryDocument(t, predecessor, recordDocument)
			if _, err := ParseEntryDocument(document); err == nil {
				t.Fatal("entry parser accepted a rehashed invalid or noncanonical nested record")
			}
		})
	}
}

func TestEntryRejectsRehashedNoncanonicalNestedPredecessor(t *testing.T) {
	payload, err := marshalCanonicalValue(testPredecessor(), MaximumPredecessorDocumentBytes)
	if err != nil {
		t.Fatal(err)
	}
	mutations := []struct {
		name    string
		payload []byte
	}{
		{"unknown field", bytes.Replace(payload, []byte(`{"headDocumentSha256":`), []byte(`{"unknown":true,"headDocumentSha256":`), 1)},
		{"duplicate field", bytes.Replace(payload, []byte(`"sourceSchemaVersion":1`), []byte(`"sourceSchemaVersion":1,"sourceSchemaVersion":1`), 1)},
		{"reordered fields", bytes.Replace(payload,
			[]byte(`{"headDocumentSha256":"`+string(testPredecessor().HeadDocumentSHA256)+`","inventorySha256":"`+string(testPredecessor().InventorySHA256)+`",`),
			[]byte(`{"inventorySha256":"`+string(testPredecessor().InventorySHA256)+`","headDocumentSha256":"`+string(testPredecessor().HeadDocumentSHA256)+`",`), 1)},
		{"escaped key", bytes.Replace(payload, []byte(`"transactionId"`), []byte(`"transaction\u0049d"`), 1)},
	}
	recordDocument, err := recordv2.MarshalRecord(testRecord("1"))
	if err != nil {
		t.Fatal(err)
	}
	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			if bytes.Equal(mutation.payload, payload) {
				t.Fatal("fixture mutation did not change the nested predecessor")
			}
			predecessorDocument, err := marshalCanonicalValue(predecessorDocumentWire{
				Predecessor: mutation.payload, PredecessorSHA256: digestCanonical(predecessorDigestDomain, mutation.payload),
				SchemaVersion: SchemaVersion,
			}, MaximumPredecessorDocumentBytes)
			if err != nil {
				t.Fatal(err)
			}
			document := rehashedEntryDocument(t, predecessorDocument, recordDocument)
			if _, err := ParseEntryDocument(document); err == nil {
				t.Fatal("entry parser accepted a rehashed noncanonical nested predecessor")
			}
		})
	}
}

func rehashedEntryDocument(t *testing.T, predecessorDocument, recordDocument []byte) []byte {
	t.Helper()
	payload, err := marshalCanonicalValue(entryWire{
		PredecessorDocument: predecessorDocument,
		PreviousEntrySHA256: nil,
		RecordDocument:      recordDocument,
	}, MaximumEntryDocumentBytes)
	if err != nil {
		t.Fatal(err)
	}
	document, err := marshalCanonicalValue(entryDocumentWire{
		Entry: payload, EntrySHA256: digestCanonical(entryDigestDomain, payload), SchemaVersion: SchemaVersion,
	}, MaximumEntryDocumentBytes)
	if err != nil {
		t.Fatal(err)
	}
	return document
}
