package localrpc

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strconv"
	"sync"
	"time"

	arwxframing "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/framing"
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

type arwxShutdownAuthorizationState struct {
	mu               sync.Mutex
	binding          committedRuntimeBootstrapBinding
	claim            ArmArwxShutdownV1
	deadline         time.Time
	settlement       chan struct{}
	settlementClosed bool
	acknowledged     bool
	consumed         bool
	failed           bool
}

type arwxShutdownGate struct {
	mu                sync.Mutex
	binding           committedRuntimeBootstrapBinding
	serveBound        bool
	attempted         bool
	eofAttempted      bool
	requestedDeadline time.Time
	authorization     *arwxShutdownAuthorizationState
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

func (gate *arwxShutdownGate) bindServeStreams(
	input io.ReadCloser,
	output io.WriteCloser,
) (RuntimeBootstrapChannel, error) {
	if gate == nil {
		return nil, ErrArwxShutdownUnavailable
	}
	gate.mu.Lock()
	defer gate.mu.Unlock()
	if gate.serveBound || !sameInterfaceInstance(gate.binding.channel, input) ||
		!sameInterfaceInstance(gate.binding.channel, output) {
		gate.attempted = true
		return nil, ErrArwxShutdownUnavailable
	}
	gate.serveBound = true
	return gate.binding.channel, nil
}

func (gate *arwxShutdownGate) prepare(
	claim ArmArwxShutdownV1,
	deadline time.Time,
) (ArmArwxShutdownResultV1, *arwxShutdownAuthorizationState, error) {
	if gate == nil {
		return ArmArwxShutdownResultV1{}, nil, ErrArwxShutdownUnavailable
	}
	gate.mu.Lock()
	defer gate.mu.Unlock()
	if !gate.serveBound || gate.attempted || gate.eofAttempted {
		return ArmArwxShutdownResultV1{}, nil, ErrArwxShutdownUnavailable
	}
	gate.attempted = true
	if err := validateArmArwxShutdownClaim(claim, gate.binding); err != nil {
		return ArmArwxShutdownResultV1{}, nil, err
	}
	if !gate.requestedDeadline.IsZero() && gate.requestedDeadline.Before(deadline) {
		deadline = gate.requestedDeadline
	}
	if !time.Now().Before(deadline) {
		return ArmArwxShutdownResultV1{}, nil, ErrIOTimeout
	}
	state := &arwxShutdownAuthorizationState{
		binding:    gate.binding,
		claim:      claim,
		deadline:   deadline,
		settlement: make(chan struct{}),
	}
	gate.authorization = state
	return armArwxShutdownResult(claim), state, nil
}

func (gate *arwxShutdownGate) setRequestedDeadline(deadline time.Time) error {
	if gate == nil || deadline.IsZero() || !time.Now().Before(deadline) {
		return ErrShutdownNotificationInvalid
	}
	gate.mu.Lock()
	defer gate.mu.Unlock()
	if !gate.serveBound || gate.attempted || !gate.requestedDeadline.IsZero() {
		return ErrShutdownNotificationUnavailable
	}
	gate.requestedDeadline = deadline
	return nil
}

func (gate *arwxShutdownGate) authorizeEOF(
	ctx context.Context,
	finalFrame []byte,
) (time.Time, error) {
	if gate == nil {
		return time.Time{}, ErrArwxShutdownUnavailable
	}
	gate.mu.Lock()
	if gate.eofAttempted {
		gate.mu.Unlock()
		return time.Time{}, ErrArwxShutdownUnavailable
	}
	gate.eofAttempted = true
	authorization := gate.authorization
	gate.mu.Unlock()
	if authorization == nil {
		return time.Time{}, ErrArwxShutdownUnavailable
	}

	authorization.mu.Lock()
	if authorization.failed || authorization.consumed {
		authorization.mu.Unlock()
		return time.Time{}, ErrArwxShutdownUnavailable
	}
	authorization.consumed = true
	if cause := context.Cause(ctx); cause != nil {
		authorization.failLocked()
		authorization.mu.Unlock()
		return time.Time{}, cause
	}
	if !time.Now().Before(authorization.deadline) {
		authorization.failLocked()
		authorization.mu.Unlock()
		return time.Time{}, ErrIOTimeout
	}
	if len(finalFrame) < arwxframing.HeaderBytes ||
		len(finalFrame) != authorization.claim.FinalFrameBytes ||
		len(finalFrame) > authorization.binding.maximumFrameBytes {
		authorization.failLocked()
		authorization.mu.Unlock()
		return time.Time{}, fmt.Errorf("%w: final frame length", ErrArwxShutdownInvalid)
	}
	frameSnapshot := bytes.Clone(finalFrame)
	deadline := authorization.deadline
	settlement := authorization.settlement
	acknowledged := authorization.acknowledged
	authorization.mu.Unlock()

	if !acknowledged {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			authorization.fail()
			return time.Time{}, ErrIOTimeout
		}
		timer := time.NewTimer(remaining)
		defer timer.Stop()
		select {
		case <-settlement:
		case <-ctx.Done():
			authorization.fail()
			return time.Time{}, context.Cause(ctx)
		case <-timer.C:
			authorization.fail()
			return time.Time{}, ErrIOTimeout
		}
	}

	authorization.mu.Lock()
	defer authorization.mu.Unlock()
	if cause := context.Cause(ctx); cause != nil {
		authorization.failLocked()
		return time.Time{}, cause
	}
	if authorization.failed || !authorization.acknowledged {
		authorization.failLocked()
		return time.Time{}, ErrArwxShutdownUnavailable
	}
	if !time.Now().Before(authorization.deadline) {
		authorization.failLocked()
		return time.Time{}, ErrIOTimeout
	}
	if err := validateArwxShutdownFinalFrame(frameSnapshot, authorization.claim, authorization.binding); err != nil {
		authorization.failLocked()
		return time.Time{}, err
	}
	if cause := context.Cause(ctx); cause != nil {
		authorization.failLocked()
		return time.Time{}, cause
	}
	if !time.Now().Before(authorization.deadline) {
		authorization.failLocked()
		return time.Time{}, ErrIOTimeout
	}
	return authorization.deadline, nil
}

func (gate *arwxShutdownGate) armedDeadline() (time.Time, bool) {
	if gate == nil {
		return time.Time{}, false
	}
	gate.mu.Lock()
	authorization := gate.authorization
	gate.mu.Unlock()
	if authorization == nil {
		return time.Time{}, false
	}
	authorization.mu.Lock()
	defer authorization.mu.Unlock()
	if !authorization.acknowledged || authorization.failed {
		return time.Time{}, false
	}
	if !time.Now().Before(authorization.deadline) {
		authorization.failLocked()
		return time.Time{}, false
	}
	return authorization.deadline, true
}

func (gate *arwxShutdownGate) committedDeadline() (time.Time, bool) {
	if gate == nil {
		return time.Time{}, false
	}
	gate.mu.Lock()
	authorization := gate.authorization
	gate.mu.Unlock()
	if authorization == nil {
		return time.Time{}, false
	}
	authorization.mu.Lock()
	defer authorization.mu.Unlock()
	if !authorization.acknowledged || authorization.failed {
		return time.Time{}, false
	}
	return authorization.deadline, true
}

func (gate *arwxShutdownGate) lifecycleDeadline() (time.Time, bool) {
	if gate == nil {
		return time.Time{}, false
	}
	gate.mu.Lock()
	requested := gate.requestedDeadline
	authorization := gate.authorization
	gate.mu.Unlock()
	deadline := requested
	if authorization != nil {
		authorization.mu.Lock()
		armed := authorization.deadline
		authorization.mu.Unlock()
		if deadline.IsZero() || !armed.IsZero() && armed.Before(deadline) {
			deadline = armed
		}
	}
	return deadline, !deadline.IsZero()
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

func markArwxShutdownAcknowledged(authorization *arwxShutdownAuthorizationState) bool {
	if authorization == nil {
		return false
	}
	authorization.mu.Lock()
	defer authorization.mu.Unlock()
	if authorization.failed || authorization.acknowledged || !time.Now().Before(authorization.deadline) {
		authorization.failLocked()
		return false
	}
	authorization.acknowledged = true
	authorization.signalSettlementLocked()
	return true
}

func failArwxShutdownAuthorization(authorization *arwxShutdownAuthorizationState) {
	if authorization == nil {
		return
	}
	authorization.fail()
}

func (state *arwxShutdownAuthorizationState) fail() {
	state.mu.Lock()
	state.failLocked()
	state.mu.Unlock()
}

func (state *arwxShutdownAuthorizationState) failLocked() {
	state.failed = true
	state.signalSettlementLocked()
}

func (state *arwxShutdownAuthorizationState) signalSettlementLocked() {
	if state.settlementClosed {
		return
	}
	state.settlementClosed = true
	close(state.settlement)
}

func validateArwxShutdownFinalFrame(
	finalFrame []byte,
	claim ArmArwxShutdownV1,
	binding committedRuntimeBootstrapBinding,
) error {
	if err := validateArmArwxShutdownClaim(claim, binding); err != nil {
		return fmt.Errorf("%w: bootstrap binding", ErrArwxShutdownInvalid)
	}
	if len(finalFrame) != claim.FinalFrameBytes {
		return fmt.Errorf("%w: final frame length", ErrArwxShutdownInvalid)
	}
	header, err := arwxframing.ValidateFrame(finalFrame, uint32(binding.maximumFrameBytes))
	if err != nil {
		return fmt.Errorf("%w: final frame structure: %v", ErrArwxShutdownInvalid, err)
	}
	sequence, err := strconv.ParseUint(claim.FinalSequence, 10, 64)
	if err != nil || strconv.FormatUint(sequence, 10) != claim.FinalSequence {
		return fmt.Errorf("%w: final frame sequence claim", ErrArwxShutdownInvalid)
	}
	var nilCorrelationID [16]byte
	if int(header.MessageType) != claim.FinalMessageType || header.Sequence != sequence ||
		subtle.ConstantTimeCompare(header.CorrelationID[:], nilCorrelationID[:]) != 1 {
		return fmt.Errorf("%w: final frame header binding", ErrArwxShutdownInvalid)
	}
	expectedDigest, err := decodeDigest(claim.FinalFrameSHA256)
	if err != nil {
		return fmt.Errorf("%w: final frame digest claim", ErrArwxShutdownInvalid)
	}
	actualDigest := sha256.Sum256(finalFrame)
	if subtle.ConstantTimeCompare(actualDigest[:], expectedDigest[:]) != 1 {
		return fmt.Errorf("%w: final frame digest", ErrArwxShutdownInvalid)
	}
	return nil
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
