package installstorev2lab

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	recordv2 "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installtransactionv2lab"
)

func TestCapabilityZeroValuesAreInvalidAndNotSerializable(t *testing.T) {
	values := []struct {
		name      string
		validate  func() error
		serialize func() error
	}{
		{"prepared", func() error { return (PreparedSuccessor{}).Validate() }, func() error { _, err := json.Marshal(PreparedSuccessor{}); return err }},
		{"permit", func() error { return (DurableIntentPermit{}).Validate() }, func() error { _, err := json.Marshal(DurableIntentPermit{}); return err }},
		{"exact-before", func() error { return (ExactBeforeToken{}).Validate() }, func() error { _, err := json.Marshal(ExactBeforeToken{}); return err }},
	}
	for _, value := range values {
		t.Run(value.name, func(t *testing.T) {
			if err := value.validate(); !errors.Is(err, ErrCapabilityInvalid) {
				t.Fatalf("zero validation error = %v", err)
			}
			if err := value.serialize(); !errors.Is(err, ErrCapabilityNotSerializable) {
				t.Fatalf("serialization error = %v", err)
			}
		})
	}
}

func TestCapabilityValidationHasNoHandBuiltSuccessPath(t *testing.T) {
	digest := SHA256(strings.Repeat("a", 64))
	prepared := PreparedSuccessor{state: &preparedSuccessorState{
		issuer: &capabilityIssuerSeal{nonce: 1}, storeGeneration: 1,
		writerLockIdentitySHA256: digest, nextTransactionID: testTransactionID,
		nextRecordSequence: "1", nextHeadSHA256: digest, nextEntrySHA256: digest,
		nextRecordSHA256: digest, actionSHA256: digest,
	}}
	permit := DurableIntentPermit{state: &durableIntentPermitState{identity: durableIntentIdentity{
		issuer: &capabilityIssuerSeal{nonce: 1}, storeGeneration: 1,
		writerLockIdentitySHA256: digest, transactionID: testTransactionID,
		recordSequence: "1", headSHA256: digest, entrySHA256: digest, recordSHA256: digest,
	}}}
	token := ExactBeforeToken{state: &exactBeforeTokenState{
		identity: permit.state.identity, observationSHA256: digest, observationGeneration: 1,
		exclusionGeneration: 1, targetIdentitySHA256: []SHA256{digest},
	}}
	for name, validate := range map[string]func() error{
		"prepared":     prepared.Validate,
		"permit":       permit.Validate,
		"exact-before": token.Validate,
	} {
		if err := validate(); !errors.Is(err, ErrCapabilityInvalid) {
			t.Errorf("hand-built %s validation error = %v, want ErrCapabilityInvalid", name, err)
		}
	}
}

func TestStoreLifecycleIsAlwaysUnavailableAndNeverMints(t *testing.T) {
	store, err := OpenExclusive()
	if store != nil || !errors.Is(err, ErrUnavailable) {
		t.Fatalf("OpenExclusive = (%v, %v), want (nil, ErrUnavailable)", store, err)
	}
	var unavailable *exclusiveStore
	if err := unavailable.Recover(); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Recover error = %v", err)
	}
	permit, err := unavailable.PublishSuccessor(PreparedSuccessor{})
	if !errors.Is(err, ErrUnavailable) || permit.state != nil {
		t.Fatalf("PublishSuccessor = (%+v, %v), want zero permit and ErrUnavailable", permit, err)
	}
	if err := unavailable.Close(); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Close error = %v", err)
	}
}

func TestPublishSuccessorAcceptsOnlyPreparedCapability(t *testing.T) {
	method, ok := reflect.TypeOf((*exclusiveStore)(nil)).MethodByName("PublishSuccessor")
	if !ok {
		t.Fatal("PublishSuccessor method is absent")
	}
	want := reflect.TypeOf(func(*exclusiveStore, PreparedSuccessor) (DurableIntentPermit, error) {
		return DurableIntentPermit{}, nil
	})
	if method.Type != want {
		t.Fatalf("PublishSuccessor type = %v, want %v", method.Type, want)
	}
	for _, forbidden := range []reflect.Type{
		reflect.TypeOf([]byte(nil)),
		reflect.TypeOf(recordv2.TransactionRecord{}),
		reflect.TypeOf(Entry{}),
	} {
		if method.Type.In(1) == forbidden {
			t.Fatalf("PublishSuccessor accepts forbidden raw input %v", forbidden)
		}
	}
}
