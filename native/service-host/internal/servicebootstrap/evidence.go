package servicebootstrap

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"hash"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peerverify"
)

type evidenceIssuer struct {
	marker byte
}

var successfulEvidenceIssuer = &evidenceIssuer{marker: 1}

type evidenceState struct {
	issuer                      *evidenceIssuer
	options                     Options
	scmBeforeOpen               ServiceObservation
	scmAfterOpen                ServiceObservation
	stableWrapperFacts          peerverify.StableProcessFacts
	stableServiceHostFacts      peerverify.StableProcessFacts
	directParentProcessID       uint32
	serviceHostProcessDACL      DACLEvidence
	serviceHostPrimaryTokenDACL DACLEvidence
	winSWWrapperProcessDACL     DACLEvidence
	digest                      [sha256.Size]byte
}

// Evidence is an opaque, immutable snapshot issued only after the complete
// bootstrap transaction succeeds. Its zero value is invalid. Copies share
// immutable private state, while every getter returns a detached value.
type Evidence struct {
	state *evidenceState
}

func issueEvidence(
	options Options,
	scmBeforeOpen ServiceObservation,
	scmAfterOpen ServiceObservation,
	stableWrapperFacts peerverify.StableProcessFacts,
	stableServiceHostFacts peerverify.StableProcessFacts,
	directParentProcessID uint32,
	serviceHostProcessDACL DACLEvidence,
	serviceHostPrimaryTokenDACL DACLEvidence,
	winSWWrapperProcessDACL DACLEvidence,
) (Evidence, error) {
	state := &evidenceState{
		issuer:                      successfulEvidenceIssuer,
		options:                     options,
		scmBeforeOpen:               scmBeforeOpen,
		scmAfterOpen:                scmAfterOpen,
		stableWrapperFacts:          stableWrapperFacts,
		stableServiceHostFacts:      stableServiceHostFacts,
		directParentProcessID:       directParentProcessID,
		serviceHostProcessDACL:      cloneDACLEvidence(serviceHostProcessDACL),
		serviceHostPrimaryTokenDACL: cloneDACLEvidence(serviceHostPrimaryTokenDACL),
		winSWWrapperProcessDACL:     cloneDACLEvidence(winSWWrapperProcessDACL),
	}
	state.digest = digestEvidenceState(state)
	evidence := Evidence{state: state}
	if err := evidence.Validate(); err != nil {
		return Evidence{}, err
	}
	return evidence, nil
}

// Validate rejects zero, unissued, incomplete, internally inconsistent, or
// mutated evidence. It reconstructs every policy from the captured options.
func (e Evidence) Validate() error {
	state := e.state
	if state == nil || state.issuer != successfulEvidenceIssuer ||
		state.digest == ([sha256.Size]byte{}) {
		return invalidEvidenceError("evidence was not issued by a successful bootstrap", nil)
	}
	if err := validateOptions(state.options); err != nil {
		return invalidEvidenceError("captured bootstrap options are invalid", err)
	}
	if err := validateSCMObservation(state.scmBeforeOpen); err != nil {
		return invalidEvidenceError("SCM observation before wrapper acquisition is invalid", err)
	}
	if err := validateSCMObservation(state.scmAfterOpen); err != nil {
		return invalidEvidenceError("SCM observation after wrapper acquisition is invalid", err)
	}
	if state.scmBeforeOpen != state.scmAfterOpen {
		return invalidEvidenceError("SCM observations are not stable", ErrWrapperUnstable)
	}
	if err := validateStableProcessFacts(state.stableWrapperFacts, "WinSW wrapper"); err != nil {
		return invalidEvidenceError("captured wrapper facts are invalid", err)
	}
	if state.stableWrapperFacts.ProcessID != state.scmBeforeOpen.ProcessID {
		return invalidEvidenceError("captured wrapper PID differs from SCM", ErrWrapperUnstable)
	}
	if err := validateStableProcessFacts(state.stableServiceHostFacts, "current ServiceHost"); err != nil {
		return invalidEvidenceError("captured ServiceHost facts are invalid", err)
	}
	if state.stableServiceHostFacts.ProcessID == state.stableWrapperFacts.ProcessID {
		return invalidEvidenceError("ServiceHost and WinSW wrapper have the same PID", ErrParentMismatch)
	}
	if err := validateDirectParent(
		state.stableServiceHostFacts,
		state.stableWrapperFacts,
		state.directParentProcessID,
	); err != nil {
		return invalidEvidenceError("captured process lineage is invalid", err)
	}
	processPolicy, tokenPolicy, err := serviceDACLPolicies(
		state.options.OwnServiceSID,
		state.options.PeerServiceSID,
	)
	if err != nil {
		return invalidEvidenceError("captured service identities cannot reconstruct DACL policy", err)
	}
	if err := validateDACL(state.serviceHostProcessDACL, processPolicy); err != nil {
		return invalidEvidenceError("captured ServiceHost process DACL is invalid", err)
	}
	if err := validateDACL(state.serviceHostPrimaryTokenDACL, tokenPolicy); err != nil {
		return invalidEvidenceError("captured ServiceHost primary-token DACL is invalid", err)
	}
	if err := validateDACL(state.winSWWrapperProcessDACL, processPolicy); err != nil {
		return invalidEvidenceError("captured WinSW wrapper process DACL is invalid", err)
	}
	if digestEvidenceState(state) != state.digest {
		return invalidEvidenceError("captured authorization facts differ from their sealed digest", nil)
	}
	return nil
}

// Digest returns the deterministic digest of every captured authorization
// fact. Diagnostic path text is not observed by this evidence and is absent.
func (e Evidence) Digest() ([sha256.Size]byte, error) {
	if err := e.Validate(); err != nil {
		return [sha256.Size]byte{}, err
	}
	return e.state.digest, nil
}

func (e Evidence) issuedState() *evidenceState {
	if e.state == nil || e.state.issuer != successfulEvidenceIssuer {
		return nil
	}
	return e.state
}

func (e Evidence) Options() Options {
	if state := e.issuedState(); state != nil {
		return state.options
	}
	return Options{}
}

func (e Evidence) ServiceName() string    { return e.Options().ServiceName }
func (e Evidence) OwnServiceSID() string  { return e.Options().OwnServiceSID }
func (e Evidence) PeerServiceSID() string { return e.Options().PeerServiceSID }

func (e Evidence) SCMBeforeOpen() ServiceObservation {
	if state := e.issuedState(); state != nil {
		return state.scmBeforeOpen
	}
	return ServiceObservation{}
}

func (e Evidence) SCMAfterOpen() ServiceObservation {
	if state := e.issuedState(); state != nil {
		return state.scmAfterOpen
	}
	return ServiceObservation{}
}

func (e Evidence) StableWrapperFacts() peerverify.StableProcessFacts {
	if state := e.issuedState(); state != nil {
		return state.stableWrapperFacts
	}
	return peerverify.StableProcessFacts{}
}

func (e Evidence) StableServiceHostFacts() peerverify.StableProcessFacts {
	if state := e.issuedState(); state != nil {
		return state.stableServiceHostFacts
	}
	return peerverify.StableProcessFacts{}
}

func (e Evidence) DirectParentProcessID() uint32 {
	if state := e.issuedState(); state != nil {
		return state.directParentProcessID
	}
	return 0
}

func (e Evidence) ServiceHostProcessDACL() DACLEvidence {
	if state := e.issuedState(); state != nil {
		return cloneDACLEvidence(state.serviceHostProcessDACL)
	}
	return DACLEvidence{}
}

func (e Evidence) ServiceHostPrimaryTokenDACL() DACLEvidence {
	if state := e.issuedState(); state != nil {
		return cloneDACLEvidence(state.serviceHostPrimaryTokenDACL)
	}
	return DACLEvidence{}
}

func (e Evidence) WinSWWrapperProcessDACL() DACLEvidence {
	if state := e.issuedState(); state != nil {
		return cloneDACLEvidence(state.winSWWrapperProcessDACL)
	}
	return DACLEvidence{}
}

func validateStableProcessFacts(facts peerverify.StableProcessFacts, label string) error {
	if facts.ProcessID == 0 {
		return fmt.Errorf("%w: %s PID is zero", ErrWrapperUnstable, label)
	}
	if facts.CreationTime.IsZero() {
		return fmt.Errorf("%w: %s creation time is zero", ErrWrapperUnstable, label)
	}
	if facts.StartKey.Available && facts.StartKey.SequenceNumber == 0 {
		return fmt.Errorf("%w: %s process start key is zero", ErrWrapperUnstable, label)
	}
	if !facts.StartKey.Available && facts.StartKey.SequenceNumber != 0 {
		return fmt.Errorf("%w: %s unavailable process start key contains a sequence number", ErrWrapperUnstable, label)
	}
	return nil
}

func invalidEvidenceError(message string, cause error) error {
	if cause != nil {
		return fmt.Errorf("%w: %s: %w", ErrInvalidEvidence, message, cause)
	}
	return fmt.Errorf("%w: %s", ErrInvalidEvidence, message)
}

func digestEvidenceState(state *evidenceState) [sha256.Size]byte {
	encoder := evidenceDigestEncoder{hash: sha256.New()}
	encoder.text("agentic-review/service-bootstrap-evidence/v1")
	encoder.text(state.options.ServiceName)
	encoder.text(state.options.OwnServiceSID)
	encoder.text(state.options.PeerServiceSID)
	encodeServiceObservation(&encoder, state.scmBeforeOpen)
	encodeServiceObservation(&encoder, state.scmAfterOpen)
	encodeStableProcessFacts(&encoder, state.stableWrapperFacts)
	encodeStableProcessFacts(&encoder, state.stableServiceHostFacts)
	encoder.u32(state.directParentProcessID)
	encodeDACLEvidence(&encoder, state.serviceHostProcessDACL)
	encodeDACLEvidence(&encoder, state.serviceHostPrimaryTokenDACL)
	encodeDACLEvidence(&encoder, state.winSWWrapperProcessDACL)
	var result [sha256.Size]byte
	copy(result[:], encoder.hash.Sum(nil))
	return result
}

func encodeServiceObservation(encoder *evidenceDigestEncoder, observation ServiceObservation) {
	encoder.u32(uint32(observation.State))
	encoder.u32(observation.ProcessID)
}

func encodeStableProcessFacts(encoder *evidenceDigestEncoder, facts peerverify.StableProcessFacts) {
	encoder.u32(facts.ProcessID)
	encoder.time(facts.CreationTime)
	encoder.boolean(facts.StartKey.Available)
	encoder.u64(facts.StartKey.SequenceNumber)
}

func encodeDACLEvidence(encoder *evidenceDigestEncoder, evidence DACLEvidence) {
	encoder.u16(evidence.Control)
	encoder.boolean(evidence.Present)
	encoder.boolean(evidence.Protected)
	encoder.boolean(evidence.Null)
	encoder.boolean(evidence.Defaulted)
	encoder.u64(uint64(len(evidence.AccessRules)))
	for _, entry := range evidence.AccessRules {
		encoder.text(entry.SID)
		encoder.u32(entry.Mask)
		encoder.u8(entry.ACEType)
		encoder.u8(entry.Flags)
	}
}

type evidenceDigestEncoder struct {
	hash hash.Hash
}

func (encoder *evidenceDigestEncoder) u8(value uint8) {
	_, _ = encoder.hash.Write([]byte{value})
}

func (encoder *evidenceDigestEncoder) u16(value uint16) {
	var buffer [2]byte
	binary.LittleEndian.PutUint16(buffer[:], value)
	_, _ = encoder.hash.Write(buffer[:])
}

func (encoder *evidenceDigestEncoder) u32(value uint32) {
	var buffer [4]byte
	binary.LittleEndian.PutUint32(buffer[:], value)
	_, _ = encoder.hash.Write(buffer[:])
}

func (encoder *evidenceDigestEncoder) u64(value uint64) {
	var buffer [8]byte
	binary.LittleEndian.PutUint64(buffer[:], value)
	_, _ = encoder.hash.Write(buffer[:])
}

func (encoder *evidenceDigestEncoder) i64(value int64) {
	encoder.u64(uint64(value))
}

func (encoder *evidenceDigestEncoder) bytes(value []byte) {
	encoder.u64(uint64(len(value)))
	_, _ = encoder.hash.Write(value)
}

func (encoder *evidenceDigestEncoder) text(value string) {
	encoder.bytes([]byte(value))
}

func (encoder *evidenceDigestEncoder) boolean(value bool) {
	if value {
		encoder.u8(1)
		return
	}
	encoder.u8(0)
}

func (encoder *evidenceDigestEncoder) time(value time.Time) {
	encoder.i64(value.Unix())
	encoder.u32(uint32(value.Nanosecond()))
}
