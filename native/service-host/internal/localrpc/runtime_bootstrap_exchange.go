package localrpc

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"reflect"
	"sync"
)

var ErrRuntimeBootstrapExchange = errors.New("RuntimeBootstrapV1 exchange failed")

// RuntimeBootstrapChannel is the context-aware byte stream used for the first HostControl
// exchange and the subsequent local RPC session. Each method must return after its context is
// cancelled and must stop using the supplied buffer before it returns.
type RuntimeBootstrapChannel interface {
	ReadContext(context.Context, []byte) (int, error)
	WriteContext(context.Context, []byte) (int, error)
}

// PendingRuntimeBootstrapCommit is an opaque, single-use post-activation commit bound to the
// exact bootstrap bytes, role, and channel that produced a validated readiness acknowledgement.
type PendingRuntimeBootstrapCommit struct {
	state *pendingRuntimeBootstrapCommitState
}

type pendingRuntimeBootstrapCommitState struct {
	mu        sync.Mutex
	channel   RuntimeBootstrapChannel
	document  []byte
	role      Role
	attempted bool
}

// CommittedRuntimeBootstrap is opaque, copy-safe authority for the exact role and channel that
// completed the three-stage bootstrap exchange. A local RPC server may consume it only once.
type CommittedRuntimeBootstrap struct {
	state *committedRuntimeBootstrapState
}

type committedRuntimeBootstrapState struct {
	mu              sync.Mutex
	channel         RuntimeBootstrapChannel
	bootstrap       RuntimeBootstrapV1
	digest          [32]byte
	operationPolicy runtimeOperationPolicy
	consumed        bool
}

type committedRuntimeBootstrapBinding struct {
	channel                    RuntimeBootstrapChannel
	role                       Role
	bootstrapID                string
	bootstrapSHA256            [32]byte
	maximumFrameBytes          int
	maximumRemainingShutdownMS int
	operationPolicy            runtimeOperationPolicy
}

type runtimeOperationPolicy struct {
	claimAllowed bool
}

type foundationRoleConfig struct {
	ExecutionEnabled  bool `json:"executionEnabled"`
	FoundationVersion int  `json:"foundationVersion"`
	Role              Role `json:"role"`
}

// BeginRuntimeBootstrapExchange sends one canonical bootstrap frame and validates exactly one
// readiness acknowledgement. The caller must activate the retained Node and then call Commit.
func BeginRuntimeBootstrapExchange(
	ctx context.Context,
	channel RuntimeBootstrapChannel,
	bound LaunchRuntimeBootstrap,
) (*PendingRuntimeBootstrapCommit, error) {
	bootstrap, document, err := consumeLaunchRuntimeBootstrapIssuance(bound)
	if err != nil {
		return nil, errors.Join(ErrRuntimeBootstrapExchange, err)
	}
	if ctx == nil {
		return nil, fmt.Errorf("%w: context is required", ErrRuntimeBootstrapExchange)
	}
	if isNilRuntimeBootstrapChannel(channel) {
		return nil, fmt.Errorf("%w: channel is required", ErrRuntimeBootstrapExchange)
	}
	if cause := context.Cause(ctx); cause != nil {
		return nil, errors.Join(ErrRuntimeBootstrapExchange, cause)
	}
	writer := runtimeBootstrapContextWriter{ctx: ctx, channel: channel}
	if err := WriteFrame(writer, document, RuntimeBootstrapMaximumBytes); err != nil {
		return nil, errors.Join(ErrRuntimeBootstrapExchange, fmt.Errorf("write bootstrap frame: %w", err))
	}
	reader := runtimeBootstrapContextReader{ctx: ctx, channel: channel}
	ackDocument, err := ReadFrame(reader, RuntimeBootstrapMaximumBytes)
	if err != nil {
		return nil, errors.Join(ErrRuntimeBootstrapExchange, fmt.Errorf("read bootstrap acknowledgement: %w", err))
	}
	if cause := context.Cause(ctx); cause != nil {
		return nil, errors.Join(ErrRuntimeBootstrapExchange, cause)
	}
	if err := ValidateRuntimeBootstrapAck(ackDocument, document, bootstrap.Role); err != nil {
		return nil, errors.Join(ErrRuntimeBootstrapExchange, err)
	}
	return &PendingRuntimeBootstrapCommit{
		state: &pendingRuntimeBootstrapCommitState{
			channel:  channel,
			document: document,
			role:     bootstrap.Role,
		},
	}, nil
}

// Commit sends the exact post-activation commit once and returns channel-bound session authority.
// A failed attempt cannot be retried.
func (pending *PendingRuntimeBootstrapCommit) Commit(
	ctx context.Context,
) (CommittedRuntimeBootstrap, error) {
	if pending == nil || pending.state == nil || ctx == nil {
		return CommittedRuntimeBootstrap{}, fmt.Errorf("%w: pending commit and context are required", ErrRuntimeBootstrapExchange)
	}
	state := pending.state
	state.mu.Lock()
	if state.attempted || isNilRuntimeBootstrapChannel(state.channel) {
		state.mu.Unlock()
		return CommittedRuntimeBootstrap{}, fmt.Errorf("%w: commit is not available", ErrRuntimeBootstrapExchange)
	}
	state.attempted = true
	channel := state.channel
	document := bytes.Clone(state.document)
	role := state.role
	state.channel = nil
	state.document = nil
	state.mu.Unlock()

	if cause := context.Cause(ctx); cause != nil {
		return CommittedRuntimeBootstrap{}, errors.Join(ErrRuntimeBootstrapExchange, cause)
	}
	bootstrap, err := DecodeRuntimeBootstrap(document)
	if err != nil {
		return CommittedRuntimeBootstrap{}, errors.Join(ErrRuntimeBootstrapExchange, err)
	}
	operationPolicy, err := deriveRuntimeOperationPolicy(bootstrap)
	if err != nil {
		return CommittedRuntimeBootstrap{}, errors.Join(ErrRuntimeBootstrapExchange, err)
	}
	commitDocument, err := EncodeRuntimeBootstrapCommit(document, role)
	if err != nil {
		return CommittedRuntimeBootstrap{}, errors.Join(ErrRuntimeBootstrapExchange, err)
	}
	writer := runtimeBootstrapContextWriter{ctx: ctx, channel: channel}
	if err := WriteFrame(writer, commitDocument, RuntimeBootstrapMaximumBytes); err != nil {
		return CommittedRuntimeBootstrap{}, errors.Join(ErrRuntimeBootstrapExchange, fmt.Errorf("write bootstrap commit: %w", err))
	}
	if cause := context.Cause(ctx); cause != nil {
		return CommittedRuntimeBootstrap{}, errors.Join(ErrRuntimeBootstrapExchange, cause)
	}
	digest := sha256.Sum256(document)
	return CommittedRuntimeBootstrap{state: &committedRuntimeBootstrapState{
		channel:         channel,
		bootstrap:       bootstrap,
		digest:          digest,
		operationPolicy: operationPolicy,
	}}, nil
}

func deriveRuntimeOperationPolicy(bootstrap RuntimeBootstrapV1) (runtimeOperationPolicy, error) {
	expected, err := foundationRoleConfigJSON(bootstrap.Role)
	if err != nil || !bytes.Equal(bootstrap.roleConfigJSON, []byte(expected)) {
		return runtimeOperationPolicy{}, fmt.Errorf(
			"%w: committed roleConfig does not match the exact foundation configuration",
			ErrRuntimeBootstrapBinding,
		)
	}
	var config foundationRoleConfig
	if err := decodeExact(bootstrap.roleConfigJSON, &config); err != nil ||
		config.FoundationVersion != 1 || config.Role != bootstrap.Role {
		return runtimeOperationPolicy{}, fmt.Errorf(
			"%w: committed roleConfig policy is invalid",
			ErrRuntimeBootstrapBinding,
		)
	}
	return runtimeOperationPolicy{
		claimAllowed: bootstrap.Role == RoleControl && config.ExecutionEnabled,
	}, nil
}

func consumeCommittedRuntimeBootstrap(
	committed CommittedRuntimeBootstrap,
	role Role,
) (committedRuntimeBootstrapBinding, error) {
	if committed.state == nil || !validRuntimeBootstrapRole(role) {
		return committedRuntimeBootstrapBinding{}, ErrRuntimeBootstrapBinding
	}
	state := committed.state
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.consumed || isNilRuntimeBootstrapChannel(state.channel) || state.bootstrap.Role != role {
		return committedRuntimeBootstrapBinding{}, ErrRuntimeBootstrapBinding
	}
	state.consumed = true
	return committedRuntimeBootstrapBinding{
		channel:                    state.channel,
		role:                       state.bootstrap.Role,
		bootstrapID:                state.bootstrap.BootstrapID,
		bootstrapSHA256:            state.digest,
		maximumFrameBytes:          state.bootstrap.ARWX.MaximumFrameBytes,
		maximumRemainingShutdownMS: state.bootstrap.Shutdown.GracefulTimeoutMS - state.bootstrap.Shutdown.ForceTerminationReserveMS,
		operationPolicy:            state.operationPolicy,
	}, nil
}

type runtimeBootstrapContextReader struct {
	ctx     context.Context
	channel RuntimeBootstrapChannel
}

func (reader runtimeBootstrapContextReader) Read(buffer []byte) (int, error) {
	return reader.channel.ReadContext(reader.ctx, buffer)
}

type runtimeBootstrapContextWriter struct {
	ctx     context.Context
	channel RuntimeBootstrapChannel
}

func (writer runtimeBootstrapContextWriter) Write(buffer []byte) (int, error) {
	return writer.channel.WriteContext(writer.ctx, buffer)
}

func isNilRuntimeBootstrapChannel(channel RuntimeBootstrapChannel) bool {
	if channel == nil {
		return true
	}
	value := reflect.ValueOf(channel)
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return value.IsNil()
	default:
		return false
	}
}

var (
	_ io.Reader = runtimeBootstrapContextReader{}
	_ io.Writer = runtimeBootstrapContextWriter{}
)
