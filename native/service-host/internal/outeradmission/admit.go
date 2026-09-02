package outeradmission

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"reflect"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outertrust"
)

// Admit verifies one signed logical package plan using only the compiled outer trust key. It does
// not accept a caller-supplied key, verifier, callback, or preconstructed trust evidence.
func Admit(
	indexDocument []byte,
	envelopeDocument []byte,
	controlBootstrapDocument []byte,
	executorBootstrapDocument []byte,
) (SignedPackagePlan, error) {
	snapshot, err := cloneDocumentSnapshot(
		indexDocument,
		envelopeDocument,
		controlBootstrapDocument,
		executorBootstrapDocument,
	)
	if err != nil {
		return SignedPackagePlan{}, err
	}
	authority, err := outertrust.Production()
	if err != nil {
		if errors.Is(err, outertrust.ErrUnavailable) {
			return SignedPackagePlan{}, ErrUnavailable
		}
		return SignedPackagePlan{}, ErrInvalid
	}
	return admitSnapshot(snapshot, authority)
}

func cloneDocumentSnapshot(index, envelope, control, executor []byte) (documentSnapshot, error) {
	if len(index) == 0 || len(index) > outerpackage.MaximumIndexBytes ||
		len(envelope) == 0 || len(envelope) > outerpackage.MaximumEnvelopeBytes ||
		len(control) == 0 || len(control) > config.MaximumDocumentBytes ||
		len(executor) == 0 || len(executor) > config.MaximumDocumentBytes {
		return documentSnapshot{}, ErrInvalid
	}
	snapshot := documentSnapshot{
		index:    bytes.Clone(index),
		envelope: bytes.Clone(envelope),
		control:  bytes.Clone(control),
		executor: bytes.Clone(executor),
	}
	snapshot.indexSHA = sha256.Sum256(snapshot.index)
	snapshot.envelopeSHA = sha256.Sum256(snapshot.envelope)
	snapshot.controlSHA = sha256.Sum256(snapshot.control)
	snapshot.executorSHA = sha256.Sum256(snapshot.executor)
	return snapshot, nil
}

func admitSnapshot(snapshot documentSnapshot, authority signatureAuthority) (SignedPackagePlan, error) {
	index, control, executor, signerKeyID, err := validateSnapshot(snapshot, authority)
	if err != nil {
		return SignedPackagePlan{}, err
	}
	state := &planState{
		issuer:      successfulPlanIssuer,
		authority:   authority,
		documents:   cloneSnapshot(snapshot),
		index:       index,
		control:     cloneConfiguration(control),
		executor:    cloneConfiguration(executor),
		signerKeyID: signerKeyID,
	}
	state.digest = digestPlanState(state)
	plan := SignedPackagePlan{state: state}
	if err := plan.Validate(); err != nil {
		return SignedPackagePlan{}, err
	}
	return plan, nil
}

func validateSnapshot(
	snapshot documentSnapshot,
	authority signatureAuthority,
) (outerpackage.Index, config.Config, config.Config, string, error) {
	if nilInterface(authority) || authority.Validate() != nil || !snapshotUnchanged(snapshot) {
		return outerpackage.Index{}, config.Config{}, config.Config{}, "", ErrInvalid
	}
	beforeKeyID := authority.SignerKeyID()
	if !validSHA256(beforeKeyID) {
		return outerpackage.Index{}, config.Config{}, config.Config{}, "", ErrInvalid
	}
	if err := authority.Verify(snapshot.index, snapshot.envelope); err != nil ||
		authority.Validate() != nil || authority.SignerKeyID() != beforeKeyID || !snapshotUnchanged(snapshot) {
		return outerpackage.Index{}, config.Config{}, config.Config{}, "", ErrInvalid
	}
	index, err := outerpackage.ParseIndex(snapshot.index)
	if err != nil {
		return outerpackage.Index{}, config.Config{}, config.Config{}, "", ErrInvalid
	}
	envelope, err := outerpackage.ParseSignatureEnvelope(snapshot.envelope)
	if err != nil || envelope.SignerKeyID != beforeKeyID {
		return outerpackage.Index{}, config.Config{}, config.Config{}, "", ErrInvalid
	}
	control, err := config.Parse(snapshot.control)
	if err != nil {
		return outerpackage.Index{}, config.Config{}, config.Config{}, "", ErrInvalid
	}
	executor, err := config.Parse(snapshot.executor)
	if err != nil || !snapshotUnchanged(snapshot) {
		return outerpackage.Index{}, config.Config{}, config.Config{}, "", ErrInvalid
	}
	if err := bindBootstrapPair(index, control, executor, snapshot); err != nil {
		return outerpackage.Index{}, config.Config{}, config.Config{}, "", err
	}
	return index, cloneConfiguration(control), cloneConfiguration(executor), beforeKeyID, nil
}

// Validate reparses, reverifies, and rebinds every private byte snapshot held by the plan.
func (plan SignedPackagePlan) Validate() error {
	state := plan.state
	if state == nil || state.issuer != successfulPlanIssuer || nilInterface(state.authority) ||
		state.digest == ([sha256.Size]byte{}) || state.signerKeyID == "" {
		return ErrInvalidPlan
	}
	index, control, executor, signerKeyID, err := validateSnapshot(state.documents, state.authority)
	if err != nil || signerKeyID != state.signerKeyID ||
		!sameIndex(index, state.index) || !sameConfiguration(control, state.control) ||
		!sameConfiguration(executor, state.executor) || digestPlanState(state) != state.digest {
		return ErrInvalidPlan
	}
	return nil
}

// Index returns a detached copy of the signed canonical package index.
func (plan SignedPackagePlan) Index() outerpackage.Index {
	if plan.Validate() != nil {
		return outerpackage.Index{}
	}
	value, _ := outerpackage.ParseIndex(plan.state.documents.index)
	return value
}

// ControlConfiguration returns a detached copy of the canonical Control bootstrap.
func (plan SignedPackagePlan) ControlConfiguration() config.Config {
	if plan.Validate() != nil {
		return config.Config{}
	}
	value, _ := config.Parse(plan.state.documents.control)
	return value
}

// ExecutorConfiguration returns a detached copy of the canonical Executor bootstrap.
func (plan SignedPackagePlan) ExecutorConfiguration() config.Config {
	if plan.Validate() != nil {
		return config.Config{}
	}
	value, _ := config.Parse(plan.state.documents.executor)
	return value
}

// SignerKeyID returns the compiled outer signer SPKI digest used for admission.
func (plan SignedPackagePlan) SignerKeyID() string {
	if plan.Validate() != nil {
		return ""
	}
	return plan.state.signerKeyID
}

// IndexDocument returns a detached copy of the verified canonical index bytes.
func (plan SignedPackagePlan) IndexDocument() []byte {
	if plan.Validate() != nil {
		return nil
	}
	return bytes.Clone(plan.state.documents.index)
}

// ControlBootstrapDocument returns a detached copy of the bound Control bootstrap bytes.
func (plan SignedPackagePlan) ControlBootstrapDocument() []byte {
	if plan.Validate() != nil {
		return nil
	}
	return bytes.Clone(plan.state.documents.control)
}

// ExecutorBootstrapDocument returns a detached copy of the bound Executor bootstrap bytes.
func (plan SignedPackagePlan) ExecutorBootstrapDocument() []byte {
	if plan.Validate() != nil {
		return nil
	}
	return bytes.Clone(plan.state.documents.executor)
}

// MarshalJSON refuses to serialize a logical plan as a transferable authority token.
func (SignedPackagePlan) MarshalJSON() ([]byte, error) { return nil, ErrSerialization }

func cloneSnapshot(value documentSnapshot) documentSnapshot {
	value.index = bytes.Clone(value.index)
	value.envelope = bytes.Clone(value.envelope)
	value.control = bytes.Clone(value.control)
	value.executor = bytes.Clone(value.executor)
	return value
}

func snapshotUnchanged(value documentSnapshot) bool {
	return len(value.index) != 0 && len(value.envelope) != 0 && len(value.control) != 0 && len(value.executor) != 0 &&
		sha256.Sum256(value.index) == value.indexSHA && sha256.Sum256(value.envelope) == value.envelopeSHA &&
		sha256.Sum256(value.control) == value.controlSHA && sha256.Sum256(value.executor) == value.executorSHA
}

func cloneConfiguration(value config.Config) config.Config {
	document, err := config.MarshalCanonical(value)
	if err != nil {
		return config.Config{}
	}
	cloned, err := config.Parse(document)
	if err != nil {
		return config.Config{}
	}
	return cloned
}

func sameConfiguration(left, right config.Config) bool {
	leftDocument, leftErr := config.MarshalCanonical(left)
	rightDocument, rightErr := config.MarshalCanonical(right)
	return leftErr == nil && rightErr == nil && bytes.Equal(leftDocument, rightDocument)
}

func sameIndex(left, right outerpackage.Index) bool {
	leftDocument, leftErr := outerpackage.MarshalIndexCanonical(left)
	rightDocument, rightErr := outerpackage.MarshalIndexCanonical(right)
	return leftErr == nil && rightErr == nil && bytes.Equal(leftDocument, rightDocument)
}

func digestPlanState(state *planState) [sha256.Size]byte {
	digest := sha256.New()
	_, _ = digest.Write([]byte("AgenticReview signed outer package plan v1\x00"))
	_, _ = digest.Write(state.documents.indexSHA[:])
	_, _ = digest.Write(state.documents.envelopeSHA[:])
	_, _ = digest.Write(state.documents.controlSHA[:])
	_, _ = digest.Write(state.documents.executorSHA[:])
	_, _ = digest.Write([]byte(state.signerKeyID))
	var result [sha256.Size]byte
	copy(result[:], digest.Sum(nil))
	return result
}

func nilInterface(value any) bool {
	if value == nil {
		return true
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return reflected.IsNil()
	default:
		return false
	}
}

func validSHA256(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(value) == sha256.Size*2 && len(decoded) == sha256.Size && value == fmt.Sprintf("%x", decoded)
}
