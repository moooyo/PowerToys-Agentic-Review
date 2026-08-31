package localrpc

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strconv"
	"sync"
	"time"
)

const (
	ArmArwxShutdownControlFinalMessageType  = 14
	ArmArwxShutdownExecutorFinalMessageType = 15
	armArwxShutdownMinimumFrameBytes        = 48
	armArwxShutdownNilCorrelationID         = "00000000-0000-0000-0000-000000000000"
)

var (
	ErrArwxShutdownInvalid     = errors.New("invalid ArmArwxShutdownV1 claim")
	ErrArwxShutdownUnavailable = errors.New("ArmArwxShutdownV1 is unavailable")
	ErrArwxShutdownActive      = errors.New("local RPC work is active during ArmArwxShutdownV1")
	ErrArwxShutdownArmed       = errors.New("ArmArwxShutdownV1 already made the session terminal")
)

// ArmArwxShutdownV1 binds a role-local final frame receipt to the committed bootstrap session.
// FinalSequence is a canonical uint64 decimal string so JSON never loses precision.
type ArmArwxShutdownV1 struct {
	BootstrapID         string `json:"bootstrapId"`
	ShutdownID          string `json:"shutdownId"`
	RemainingShutdownMS int    `json:"remainingShutdownMs"`
	FinalMessageType    int    `json:"finalMessageType"`
	FinalSequence       string `json:"finalSequence"`
	FinalCorrelationID  string `json:"finalCorrelationId"`
	FinalFrameBytes     int    `json:"finalFrameBytes"`
	FinalFrameSHA256    string `json:"finalFrameSha256"`
}

// ArmArwxShutdownResultV1 is the exact success echo produced by ServiceHost.
type ArmArwxShutdownResultV1 struct {
	Armed               bool   `json:"armed"`
	BootstrapID         string `json:"bootstrapId"`
	ShutdownID          string `json:"shutdownId"`
	RemainingShutdownMS int    `json:"remainingShutdownMs"`
	FinalMessageType    int    `json:"finalMessageType"`
	FinalSequence       string `json:"finalSequence"`
	FinalCorrelationID  string `json:"finalCorrelationId"`
	FinalFrameBytes     int    `json:"finalFrameBytes"`
	FinalFrameSHA256    string `json:"finalFrameSha256"`
}

// ArwxShutdownAuthorization is opaque evidence saved before the Arm response write. It becomes
// usable only after that exact response is written successfully.
type ArwxShutdownAuthorization struct {
	state *arwxShutdownAuthorizationState
}

type arwxShutdownAuthorizationState struct {
	mu           sync.Mutex
	binding      committedRuntimeBootstrapBinding
	claim        ArmArwxShutdownV1
	deadline     time.Time
	acknowledged bool
	failed       bool
}

type arwxShutdownGate struct {
	mu            sync.Mutex
	binding       committedRuntimeBootstrapBinding
	serveBound    bool
	attempted     bool
	authorization ArwxShutdownAuthorization
}

func newArwxShutdownGate(
	committed CommittedRuntimeBootstrap,
	role Role,
) (*arwxShutdownGate, error) {
	binding, err := consumeCommittedRuntimeBootstrap(committed, role)
	if err != nil {
		return nil, err
	}
	return &arwxShutdownGate{binding: binding}, nil
}

func (gate *arwxShutdownGate) bindServeStreams(input io.ReadCloser, output io.WriteCloser) error {
	if gate == nil {
		return ErrArwxShutdownUnavailable
	}
	gate.mu.Lock()
	defer gate.mu.Unlock()
	if gate.serveBound || !sameInterfaceInstance(gate.binding.channel, input) ||
		!sameInterfaceInstance(gate.binding.channel, output) {
		gate.attempted = true
		return ErrArwxShutdownUnavailable
	}
	gate.serveBound = true
	return nil
}

func (gate *arwxShutdownGate) prepare(
	claim ArmArwxShutdownV1,
	deadline time.Time,
) (ArmArwxShutdownResultV1, ArwxShutdownAuthorization, error) {
	if gate == nil {
		return ArmArwxShutdownResultV1{}, ArwxShutdownAuthorization{}, ErrArwxShutdownUnavailable
	}
	gate.mu.Lock()
	defer gate.mu.Unlock()
	if !gate.serveBound || gate.attempted {
		return ArmArwxShutdownResultV1{}, ArwxShutdownAuthorization{}, ErrArwxShutdownUnavailable
	}
	gate.attempted = true
	if err := validateArmArwxShutdownClaim(claim, gate.binding); err != nil {
		return ArmArwxShutdownResultV1{}, ArwxShutdownAuthorization{}, err
	}
	if !time.Now().Before(deadline) {
		return ArmArwxShutdownResultV1{}, ArwxShutdownAuthorization{}, ErrIOTimeout
	}
	state := &arwxShutdownAuthorizationState{
		binding:  gate.binding,
		claim:    claim,
		deadline: deadline,
	}
	authorization := ArwxShutdownAuthorization{state: state}
	gate.authorization = authorization
	return armArwxShutdownResult(claim), authorization, nil
}

func (gate *arwxShutdownGate) authorizationEvidence() (ArwxShutdownAuthorization, bool) {
	if gate == nil {
		return ArwxShutdownAuthorization{}, false
	}
	gate.mu.Lock()
	authorization := gate.authorization
	gate.mu.Unlock()
	if authorization.state == nil {
		return ArwxShutdownAuthorization{}, false
	}
	authorization.state.mu.Lock()
	if authorization.state.failed || !authorization.state.acknowledged {
		authorization.state.mu.Unlock()
		return ArwxShutdownAuthorization{}, false
	}
	valid := time.Now().Before(authorization.state.deadline)
	if !valid {
		authorization.state.failed = true
	}
	authorization.state.mu.Unlock()
	return authorization, valid
}

func (gate *arwxShutdownGate) armedDeadline() (time.Time, bool) {
	if gate == nil {
		return time.Time{}, false
	}
	gate.mu.Lock()
	authorization := gate.authorization
	gate.mu.Unlock()
	if authorization.state == nil {
		return time.Time{}, false
	}
	state := authorization.state
	state.mu.Lock()
	defer state.mu.Unlock()
	if !state.acknowledged || state.failed {
		return time.Time{}, false
	}
	if !time.Now().Before(state.deadline) {
		state.failed = true
		return time.Time{}, false
	}
	return state.deadline, true
}

func (gate *arwxShutdownGate) failCurrentAuthorization() {
	if gate == nil {
		return
	}
	gate.mu.Lock()
	authorization := gate.authorization
	gate.mu.Unlock()
	failArwxShutdownAuthorization(authorization)
}

func markArwxShutdownAcknowledged(authorization ArwxShutdownAuthorization) bool {
	if authorization.state == nil {
		return false
	}
	state := authorization.state
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.failed || state.acknowledged || !time.Now().Before(state.deadline) {
		state.failed = true
		return false
	}
	state.acknowledged = true
	return true
}

func failArwxShutdownAuthorization(authorization ArwxShutdownAuthorization) {
	if authorization.state == nil {
		return
	}
	authorization.state.mu.Lock()
	authorization.state.failed = true
	authorization.state.mu.Unlock()
}

func validateArmArwxShutdownClaim(
	claim ArmArwxShutdownV1,
	binding committedRuntimeBootstrapBinding,
) error {
	if claim.BootstrapID != binding.bootstrapID {
		return ErrArwxShutdownInvalid
	}
	return validateArmArwxShutdownSyntax(
		claim,
		binding.role,
		binding.maximumFrameBytes,
		binding.maximumRemainingShutdownMS,
	)
}

func validateArmArwxShutdownSyntax(
	claim ArmArwxShutdownV1,
	role Role,
	maximumFrameBytes int,
	maximumRemainingShutdownMS int,
) error {
	expectedMessageType := ArmArwxShutdownControlFinalMessageType
	if role == RoleExecutor {
		expectedMessageType = ArmArwxShutdownExecutorFinalMessageType
	}
	sequence, err := strconv.ParseUint(claim.FinalSequence, 10, 64)
	if err != nil || sequence == 0 || strconv.FormatUint(sequence, 10) != claim.FinalSequence ||
		!runtimeBootstrapUUIDV4.MatchString(claim.BootstrapID) ||
		!runtimeBootstrapUUIDV4.MatchString(claim.ShutdownID) ||
		claim.RemainingShutdownMS < 1 ||
		claim.RemainingShutdownMS > maximumRemainingShutdownMS ||
		claim.FinalMessageType != expectedMessageType ||
		claim.FinalCorrelationID != armArwxShutdownNilCorrelationID ||
		claim.FinalFrameBytes < armArwxShutdownMinimumFrameBytes ||
		claim.FinalFrameBytes > maximumFrameBytes ||
		!validRuntimeBootstrapDigest(claim.FinalFrameSHA256) {
		return ErrArwxShutdownInvalid
	}
	return nil
}

func armArwxShutdownResult(claim ArmArwxShutdownV1) ArmArwxShutdownResultV1 {
	return ArmArwxShutdownResultV1{
		Armed: true, BootstrapID: claim.BootstrapID, ShutdownID: claim.ShutdownID,
		RemainingShutdownMS: claim.RemainingShutdownMS,
		FinalMessageType:    claim.FinalMessageType, FinalSequence: claim.FinalSequence,
		FinalCorrelationID: claim.FinalCorrelationID, FinalFrameBytes: claim.FinalFrameBytes,
		FinalFrameSHA256: claim.FinalFrameSHA256,
	}
}

func marshalArmArwxShutdownResult(requestID string, result ArmArwxShutdownResultV1) ([]byte, error) {
	body, err := MarshalCanonicalJSON(map[string]any{
		"armed": result.Armed, "bootstrapId": result.BootstrapID,
		"shutdownId": result.ShutdownID, "remainingShutdownMs": result.RemainingShutdownMS,
		"finalMessageType": result.FinalMessageType, "finalSequence": result.FinalSequence,
		"finalCorrelationId": result.FinalCorrelationID, "finalFrameBytes": result.FinalFrameBytes,
		"finalFrameSha256": result.FinalFrameSHA256,
	}, MaximumArmArwxShutdownBytes)
	if err != nil {
		return nil, err
	}
	document, err := marshalCanonicalSuccessResponse(requestID, json.RawMessage(body))
	if err != nil || len(document) > MaximumArmArwxShutdownBytes {
		return nil, ErrInvalidHandlerResult
	}
	return document, nil
}

func sameInterfaceInstance(left, right any) bool {
	if left == nil || right == nil {
		return false
	}
	leftValue := reflect.ValueOf(left)
	rightValue := reflect.ValueOf(right)
	if leftValue.Type() != rightValue.Type() || !leftValue.Type().Comparable() {
		return false
	}
	return leftValue.Interface() == rightValue.Interface()
}

func decodeArmArwxShutdownResult(document []byte) (ArmArwxShutdownResultV1, error) {
	if !hasExactObjectKeys(document, MaximumArmArwxShutdownBytes,
		"armed", "bootstrapId", "finalCorrelationId", "finalFrameBytes", "finalFrameSha256",
		"finalMessageType", "finalSequence", "remainingShutdownMs", "shutdownId",
	) {
		return ArmArwxShutdownResultV1{}, ErrArwxShutdownInvalid
	}
	var result ArmArwxShutdownResultV1
	if err := decodeExact(bytes.Clone(document), &result); err != nil || !result.Armed {
		return ArmArwxShutdownResultV1{}, ErrArwxShutdownInvalid
	}
	return result, nil
}

func validateArmArwxShutdownResultEcho(
	document []byte,
	expected ArmArwxShutdownResultV1,
) error {
	actual, err := decodeArmArwxShutdownResult(document)
	if err != nil || actual != expected {
		return fmt.Errorf("%w: result echo", ErrArwxShutdownInvalid)
	}
	return nil
}
