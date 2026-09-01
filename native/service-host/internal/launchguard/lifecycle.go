package launchguard

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"sync"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winprocess"
)

type lifetimeQuarantine struct {
	mu        sync.RWMutex
	owners    []any
	fatal     error
	epoch     uint64
	attempted bool
}

type rejectedLaunchOwner struct {
	guard *guardState
	node  winprocess.NodeProcess
}

func (quarantine *lifetimeQuarantine) retain(owner any, cause error) error {
	if quarantine == nil || owner == nil {
		return errors.Join(ErrCleanupFatal, cause, errors.New("launch guard quarantine is unavailable"))
	}
	result := errors.Join(ErrCleanupFatal, cause)
	quarantine.mu.Lock()
	quarantine.owners = append(quarantine.owners, owner)
	quarantine.fatal = errors.Join(quarantine.fatal, result)
	quarantine.epoch++
	quarantine.mu.Unlock()
	return result
}

type guardLaunchPermit struct {
	quarantine            *lifetimeQuarantine
	epoch                 uint64
	platformCleanupStatus func() error
	commitPlatformHealthy func(func()) error
}

func (quarantine *lifetimeQuarantine) beginLaunch(
	platformCleanupStatus func() error,
	commitPlatformHealthy func(func()) error,
) (*guardLaunchPermit, error) {
	if quarantine == nil || platformCleanupStatus == nil || commitPlatformHealthy == nil {
		return nil, ErrCleanupFatal
	}
	quarantine.mu.Lock()
	defer quarantine.mu.Unlock()
	if quarantine.fatal != nil {
		return nil, quarantine.fatal
	}
	if quarantine.attempted {
		return nil, ErrConsumed
	}
	if fatal := platformCleanupStatus(); fatal != nil {
		return nil, errors.Join(ErrCleanupFatal, fatal)
	}
	quarantine.attempted = true
	return &guardLaunchPermit{
		quarantine:            quarantine,
		epoch:                 quarantine.epoch,
		platformCleanupStatus: platformCleanupStatus,
		commitPlatformHealthy: commitPlatformHealthy,
	}, nil
}

func (permit *guardLaunchPermit) check() error {
	if permit == nil || permit.quarantine == nil || permit.platformCleanupStatus == nil {
		return ErrCleanupFatal
	}
	permit.quarantine.mu.RLock()
	defer permit.quarantine.mu.RUnlock()
	if permit.quarantine.fatal != nil || permit.quarantine.epoch != permit.epoch {
		return errors.Join(ErrCleanupFatal, permit.quarantine.fatal)
	}
	if fatal := permit.platformCleanupStatus(); fatal != nil {
		return errors.Join(ErrCleanupFatal, fatal)
	}
	return nil
}

func (permit *guardLaunchPermit) commit(commit func()) error {
	if permit == nil || permit.quarantine == nil || permit.platformCleanupStatus == nil ||
		permit.commitPlatformHealthy == nil || commit == nil {
		return ErrCleanupFatal
	}
	permit.quarantine.mu.Lock()
	defer permit.quarantine.mu.Unlock()
	if permit.quarantine.fatal != nil || permit.quarantine.epoch != permit.epoch {
		return errors.Join(ErrCleanupFatal, permit.quarantine.fatal)
	}
	if err := permit.commitPlatformHealthy(commit); err != nil {
		return errors.Join(ErrCleanupFatal, err)
	}
	return nil
}

func (quarantine *lifetimeQuarantine) fatalError() error {
	if quarantine == nil {
		return ErrCleanupFatal
	}
	quarantine.mu.RLock()
	defer quarantine.mu.RUnlock()
	return quarantine.fatal
}

func (quarantine *lifetimeQuarantine) acquisitionStatus() error {
	if quarantine == nil {
		return ErrCleanupFatal
	}
	quarantine.mu.RLock()
	defer quarantine.mu.RUnlock()
	if quarantine.fatal != nil {
		return quarantine.fatal
	}
	if quarantine.attempted {
		return ErrConsumed
	}
	return nil
}

// VerifyUnchanged rehashes every guarded file and reinspects every retained
// directory without consuming the one-shot launch authority.
func (guard *Guard) VerifyUnchanged(ctx context.Context) error {
	if guard == nil || guard.state == nil {
		return ErrInvalidAuthority
	}
	if ctx == nil {
		return authorityError("launch guard reinspection context is required", nil)
	}
	state := guard.state
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.closed || state.consumed || state.launchTried {
		return ErrConsumed
	}
	if state.terminal != nil {
		return state.terminal
	}
	verifier, err := state.deps.newAuthenticodeVerifier()
	if err != nil || verifier == nil {
		return authorityError("construct fresh Authenticode verifier for final reinspection", err)
	}
	if err := state.verifyResourcesLocked(ctx, verifier); err != nil {
		state.terminal = err
		return err
	}
	return nil
}

// LaunchNode binds a fixed-factory bootstrap to the retained preflight facts,
// then consumes the guard and launches exactly the selected Node executable
// and role bundle. A binding rejection leaves the guard available for retry.
func (guard *Guard) LaunchNode(
	ctx context.Context,
	hostControlPipeName string,
	bootstrap localrpc.RuntimeBootstrapV1,
) (*GuardedNodeProcess, error) {
	if guard == nil || guard.state == nil {
		return nil, ErrInvalidAuthority
	}
	if ctx == nil {
		return nil, authorityError("Node launch context is required", nil)
	}
	state := guard.state
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.closed || state.consumed || state.launchTried {
		return nil, ErrConsumed
	}
	if state.terminal != nil {
		return nil, state.terminal
	}
	boundBootstrap, err := localrpc.BindRuntimeBootstrapToLaunch(
		bootstrap,
		cloneAuthority(state.authority).bootstrapOptions,
	)
	if err != nil {
		return nil, fmt.Errorf("bind RuntimeBootstrapV1 to guarded Node launch: %w", err)
	}
	permit, err := state.deps.quarantine.beginLaunch(
		state.deps.platformCleanupStatus,
		state.deps.commitPlatformHealthy,
	)
	if err != nil {
		state.terminal = err
		return nil, err
	}
	if fatal := permit.check(); fatal != nil {
		state.terminal = fatal
		return nil, fatal
	}
	state.launchTried = true
	verifier, err := state.deps.newAuthenticodeVerifier()
	if err != nil || verifier == nil {
		state.terminal = authorityError("construct fresh Authenticode verifier before launch", err)
		return nil, errors.Join(state.terminal, state.closeResourcesLocked())
	}
	if err := state.verifyResourcesLocked(ctx, verifier); err != nil {
		state.terminal = err
		return nil, errors.Join(err, state.closeResourcesLocked())
	}
	spec, err := state.nodeLaunchSpec(hostControlPipeName)
	if err != nil {
		state.terminal = err
		return nil, errors.Join(err, state.closeResourcesLocked())
	}
	if err := permit.check(); err != nil {
		state.terminal = err
		return nil, errors.Join(err, state.closeResourcesLocked())
	}
	if cause := context.Cause(ctx); cause != nil {
		state.terminal = cause
		return nil, errors.Join(cause, state.closeResourcesLocked())
	}
	node, launchErr := state.deps.launchNode(spec)
	if launchErr != nil || node == nil {
		if launchErr == nil {
			launchErr = errors.New("raw Node launcher returned nil")
		}
		state.terminal = launchErr
		return nil, state.rejectLaunchedNodeLocked(node, launchErr)
	}
	postVerifier, postVerifierErr := state.deps.newAuthenticodeVerifier()
	postErr := postVerifierErr
	if postErr == nil && postVerifier == nil {
		postErr = errors.New("fresh post-launch Authenticode verifier is nil")
	}
	if postErr == nil {
		postErr = state.verifyResourcesLocked(ctx, postVerifier)
	}
	if postErr != nil {
		state.terminal = postErr
		return nil, state.rejectLaunchedNodeLocked(node, postErr)
	}
	if cause := context.Cause(ctx); cause != nil {
		state.terminal = cause
		return nil, state.rejectLaunchedNodeLocked(node, cause)
	}
	var guarded *GuardedNodeProcess
	if err := permit.commit(func() {
		state.consumed = true
		guarded = &GuardedNodeProcess{state: &guardedNodeProcessState{
			inner:          node,
			guard:          state,
			permit:         permit,
			bootstrap:      boundBootstrap,
			bootstrapBound: true,
		}}
	}); err != nil {
		state.terminal = err
		return nil, state.rejectLaunchedNodeLocked(node, err)
	}
	return guarded, nil
}

func launchRuntimeBootstrapRole(role config.Role) (localrpc.Role, error) {
	switch role {
	case config.RoleControl:
		return localrpc.RoleControl, nil
	case config.RoleExecutor:
		return localrpc.RoleExecutor, nil
	default:
		return "", ErrInvalidAuthority
	}
}

func (state *guardState) rejectLaunchedNodeLocked(
	node winprocess.NodeProcess,
	cause error,
) error {
	if node == nil {
		if errors.Is(cause, winprocess.ErrLaunchCleanupFatal) {
			owner := &rejectedLaunchOwner{guard: state}
			fatal := state.deps.quarantine.retain(owner, cause)
			state.terminal = fatal
			state.closed = true
			state.consumed = true
			return fatal
		}
		return errors.Join(cause, state.closeResourcesLocked())
	}
	terminateErr := node.Terminate()
	closeErr := node.Close()
	if closeErr != nil {
		owner := &rejectedLaunchOwner{guard: state, node: node}
		fatal := state.deps.quarantine.retain(owner, errors.Join(cause, terminateErr, closeErr))
		state.terminal = fatal
		state.closed = true
		state.consumed = true
		return fatal
	}
	return errors.Join(cause, terminateErr, state.closeResourcesLocked())
}

// Close consumes an unlaunched guard. A launched guard is owned by the
// returned NodeProcess and cannot be closed through an alias.
func (guard *Guard) Close() error {
	if guard == nil || guard.state == nil {
		return nil
	}
	state := guard.state
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.consumed {
		return ErrConsumed
	}
	if state.closed {
		return state.terminal
	}
	return state.closeResourcesLocked()
}

func (state *guardState) verifyResourcesLocked(
	ctx context.Context,
	verifier authenticode.Verifier,
) error {
	if state == nil || state.closed || len(state.files) == 0 || len(state.directories) == 0 {
		return ErrInvalidAuthority
	}
	if ctx == nil {
		return authorityError("guarded resource verification context is required", nil)
	}
	for index := range state.directories {
		if cause := context.Cause(ctx); cause != nil {
			return cause
		}
		resource := &state.directories[index]
		if err := resource.handle.VerifyUnchanged(); err != nil {
			return errors.Join(ErrChanged, fmt.Errorf("reinspect guarded directory %s: %w", resource.path, err))
		}
		object, err := objectFromHandle(resource.path, resource.handle.Evidence(), resource.handle.ReinspectSecurity)
		if err != nil || !sameObject(object, resource.object) {
			return errors.Join(ErrChanged, fmt.Errorf("guarded directory evidence changed for %s: %w", resource.path, err))
		}
		if _, err := resource.handle.ReinspectDataStreams(); err != nil {
			return errors.Join(ErrChanged, fmt.Errorf("guarded directory streams changed for %s: %w", resource.path, err))
		}
		caseSensitive, err := resource.handle.ReinspectCaseSensitivity()
		if err != nil || caseSensitive {
			return errors.Join(ErrChanged, fmt.Errorf("guarded directory case mode changed for %s: %w", resource.path, err))
		}
		if resource.enumeration != nil {
			current, err := resource.handle.Enumerate(resource.enumOptions)
			if err != nil || !reflect.DeepEqual(current, *resource.enumeration) {
				return errors.Join(ErrChanged, fmt.Errorf("guarded directory entries changed for %s: %w", resource.path, err))
			}
		}
	}
	for _, file := range state.files {
		if cause := context.Cause(ctx); cause != nil {
			return cause
		}
		if err := verifyRetainedFile(file, state.authority.signerPin, verifier); err != nil {
			return err
		}
	}
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	return nil
}

func (state *guardState) nodeLaunchSpec(hostControlPipeName string) (winprocess.NodeLaunchSpec, error) {
	configuration := state.authority.configuration
	memory, err := strconv.ParseUint(configuration.Limits.RootJobMaximumMemoryBytes, 10, 64)
	if err != nil {
		return winprocess.NodeLaunchSpec{}, authorityError("parse root Job memory limit", err)
	}
	role := winprocess.RoleControl
	if state.authority.role == "executor" {
		role = winprocess.RoleExecutor
	}
	return winprocess.NodeLaunchSpec{
		ExecutablePath:      configuration.Node.ExecutablePath,
		BundlePath:          configuration.Node.BundlePath,
		WorkingDirectory:    configuration.Node.WorkingDirectory,
		HostControlPipeName: hostControlPipeName,
		Role:                role,
		OwnServiceSID:       configuration.OwnService.SID,
		PeerServiceSID:      configuration.PeerService.SID,
		Environment:         cloneConfig(configuration).Node.Environment,
		MaximumProcesses:    configuration.Limits.RootJobMaximumProcesses,
		MaximumMemoryBytes:  memory,
		ShutdownTimeout: time.Duration(
			configuration.Limits.ForceTerminationReserveMilliseconds,
		) * time.Millisecond,
	}, nil
}

func (state *guardState) closeResourcesLocked() error {
	if state == nil || state.closed {
		if state == nil {
			return nil
		}
		return state.terminal
	}
	var result error
	for index := len(state.files) - 1; index >= 0; index-- {
		resource := state.files[index]
		if resource.handle == nil {
			continue
		}
		if err := resource.handle.Close(); err != nil {
			result = errors.Join(result, state.deps.quarantine.retain(resource.handle, fmt.Errorf("close guarded file %s: %w", resource.file.AbsolutePath, err)))
		}
		state.files[index].handle = nil
	}
	for index := len(state.directories) - 1; index >= 0; index-- {
		resource := state.directories[index]
		if resource.handle == nil {
			continue
		}
		if err := resource.handle.Close(); err != nil {
			result = errors.Join(result, state.deps.quarantine.retain(resource.handle, fmt.Errorf("close guarded directory %s: %w", resource.path, err)))
		}
		state.directories[index].handle = nil
	}
	state.files = nil
	state.directories = nil
	state.closed = true
	if result != nil {
		state.terminal = errors.Join(state.terminal, result)
	}
	return result
}

// ClaimHostControlLaunch atomically transfers the launch-bound bootstrap to a
// private Node adapter that alone may activate the root Job. Production callers
// are restricted to HostControl by architecture tests.
func ClaimHostControlLaunch(
	process *GuardedNodeProcess,
) (HostControlNodeProcess, localrpc.LaunchRuntimeBootstrap, error) {
	state, err := guardedNodeState(process)
	if err != nil {
		return nil, localrpc.LaunchRuntimeBootstrap{}, err
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	state.guard.mu.Lock()
	guardClosed := state.guard.closed
	guardTerminal := state.guard.terminal
	state.guard.mu.Unlock()
	if state.hostControlClaimed || state.shutdownStarted || state.released || state.terminal != nil ||
		guardClosed || guardTerminal != nil || !state.bootstrapBound {
		return nil, localrpc.LaunchRuntimeBootstrap{}, errors.Join(
			ErrHostControlClaim,
			state.terminal,
			guardTerminal,
		)
	}
	var bootstrap localrpc.LaunchRuntimeBootstrap
	if err := state.permit.commit(func() {
		state.hostControlClaimed = true
		state.bootstrapBound = false
		bootstrap = state.bootstrap
		state.bootstrap = localrpc.LaunchRuntimeBootstrap{}
	}); err != nil {
		return nil, localrpc.LaunchRuntimeBootstrap{}, errors.Join(ErrHostControlClaim, err)
	}
	return &claimedGuardedNodeProcess{owner: process}, bootstrap, nil
}

type claimedGuardedNodeProcess struct {
	owner *GuardedNodeProcess
}

func (process *GuardedNodeProcess) ProcessID() uint32 {
	state, err := guardedNodeState(process)
	if err != nil {
		return 0
	}
	return state.inner.ProcessID()
}

func (process *GuardedNodeProcess) StableIdentity() winprocess.NodeIdentity {
	state, err := guardedNodeState(process)
	if err != nil {
		return winprocess.NodeIdentity{}
	}
	return state.inner.StableIdentity()
}

func (process *GuardedNodeProcess) ObserveIdentity() (winprocess.NodeIdentity, error) {
	state, err := guardedNodeState(process)
	if err != nil {
		return winprocess.NodeIdentity{}, err
	}
	return state.inner.ObserveIdentity()
}

func (process *GuardedNodeProcess) RootJobActiveProcessCount() (uint32, error) {
	state, err := guardedNodeState(process)
	if err != nil {
		return 0, err
	}
	return state.inner.RootJobActiveProcessCount()
}

// ActivateAfterHostControl rejects direct activation. HostControl receives a
// private claimed adapter whose activation attempt is one-shot.
func (*GuardedNodeProcess) ActivateAfterHostControl() error {
	return ErrHostControlClaim
}

func (process *GuardedNodeProcess) TakeStandardIO() (*winprocess.NodeStandardIO, error) {
	state, err := guardedNodeState(process)
	if err != nil {
		return nil, err
	}
	return state.inner.TakeStandardIO()
}

func (process *GuardedNodeProcess) Wait() (uint32, error) {
	return process.WaitContext(context.Background())
}

func (process *GuardedNodeProcess) WaitContext(ctx context.Context) (uint32, error) {
	state, err := guardedNodeState(process)
	if err != nil {
		return 0, err
	}
	state.mu.Lock()
	if state.terminal != nil {
		err := state.terminal
		state.mu.Unlock()
		return 0, err
	}
	inner := state.inner
	state.mu.Unlock()
	exitCode, waitErr := inner.WaitContext(ctx)
	return exitCode, process.releaseAfterDrain(waitErr)
}

func (process *GuardedNodeProcess) Terminate() error {
	inner, done, err := process.beginShutdown()
	if err != nil {
		return err
	}
	if done {
		return process.releaseAfterDrain(nil)
	}
	return process.releaseAfterDrain(inner.Terminate())
}

func (process *GuardedNodeProcess) Close() error {
	inner, done, err := process.beginShutdown()
	if err != nil {
		return err
	}
	if done {
		return process.releaseAfterDrain(nil)
	}
	closeErr := inner.Close()
	if closeErr == nil {
		process.state.mu.Lock()
		process.state.nodeClosed = true
		process.state.mu.Unlock()
	}
	return process.releaseAfterDrain(closeErr)
}

func (process *GuardedNodeProcess) beginShutdown() (winprocess.NodeProcess, bool, error) {
	state, err := guardedNodeState(process)
	if err != nil {
		return nil, false, err
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.terminal != nil {
		return nil, false, state.terminal
	}
	if state.nodeClosed {
		return nil, true, nil
	}
	state.shutdownStarted = true
	return state.inner, false, nil
}

func (process *GuardedNodeProcess) releaseAfterDrain(operationErr error) error {
	state, err := guardedNodeState(process)
	if err != nil {
		return errors.Join(operationErr, err)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	state.guard.mu.Lock()
	guardTerminal := state.guard.terminal
	state.guard.mu.Unlock()
	if state.terminal != nil {
		return errors.Join(state.terminal, guardTerminal)
	}
	if operationErr != nil {
		operationErr = errors.Join(guardTerminal, operationErr)
		if errors.Is(operationErr, winprocess.ErrLaunchCleanupFatal) {
			owner := &rejectedLaunchOwner{guard: state.guard, node: process}
			state.terminal = state.guard.deps.quarantine.retain(owner, operationErr)
			state.guard.mu.Lock()
			state.guard.terminal = errors.Join(state.guard.terminal, state.terminal)
			state.guard.closed = true
			state.guard.mu.Unlock()
			return state.terminal
		}
		return operationErr
	}
	if state.released {
		return nil
	}
	state.guard.mu.Lock()
	closeErr := state.guard.closeResourcesLocked()
	state.guard.mu.Unlock()
	if closeErr == nil {
		state.released = true
	}
	return closeErr
}

func guardedNodeState(process *GuardedNodeProcess) (*guardedNodeProcessState, error) {
	if process == nil || process.state == nil || process.state.guard == nil || process.state.permit == nil ||
		isNilNodeProcess(process.state.inner) {
		return nil, ErrInvalidAuthority
	}
	return process.state, nil
}

func isNilNodeProcess(process winprocess.NodeProcess) bool {
	if process == nil {
		return true
	}
	value := reflect.ValueOf(process)
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return value.IsNil()
	default:
		return false
	}
}

func (process *claimedGuardedNodeProcess) ProcessID() uint32 {
	return process.owner.ProcessID()
}

func (process *claimedGuardedNodeProcess) StableIdentity() winprocess.NodeIdentity {
	return process.owner.StableIdentity()
}

func (process *claimedGuardedNodeProcess) ObserveIdentity() (winprocess.NodeIdentity, error) {
	return process.owner.ObserveIdentity()
}

func (process *claimedGuardedNodeProcess) RootJobActiveProcessCount() (uint32, error) {
	return process.owner.RootJobActiveProcessCount()
}

func (process *claimedGuardedNodeProcess) ActivateAfterHostControl() error {
	return ErrHostControlClaim
}

func (process *claimedGuardedNodeProcess) ActivateAndCommitRuntimeBootstrap(
	ctx context.Context,
	pending *localrpc.PendingRuntimeBootstrapCommit,
) (localrpc.CommittedRuntimeBootstrap, error) {
	if ctx == nil || pending == nil {
		return localrpc.CommittedRuntimeBootstrap{}, ErrHostControlClaim
	}
	state, err := guardedNodeState(process.owner)
	if err != nil {
		return localrpc.CommittedRuntimeBootstrap{}, err
	}
	state.mu.Lock()
	if !state.hostControlClaimed || state.activationAttempted || state.shutdownStarted ||
		state.released || state.terminal != nil {
		err := errors.Join(ErrHostControlClaim, state.terminal)
		state.mu.Unlock()
		return localrpc.CommittedRuntimeBootstrap{}, err
	}
	var committed localrpc.CommittedRuntimeBootstrap
	var operationErr error
	if err := state.permit.commit(func() {
		state.activationAttempted = true
		if cause := context.Cause(ctx); cause != nil {
			operationErr = cause
			return
		}
		if err := state.inner.ActivateAfterHostControl(); err != nil {
			operationErr = err
			return
		}
		if cause := context.Cause(ctx); cause != nil {
			operationErr = cause
			return
		}
		committed, operationErr = pending.Commit(ctx)
	}); err != nil {
		state.mu.Unlock()
		return localrpc.CommittedRuntimeBootstrap{}, errors.Join(ErrHostControlClaim, err)
	}
	state.mu.Unlock()
	return committed, operationErr
}

func (process *claimedGuardedNodeProcess) TakeStandardIO() (*winprocess.NodeStandardIO, error) {
	return process.owner.TakeStandardIO()
}

func (process *claimedGuardedNodeProcess) Wait() (uint32, error) {
	return process.owner.Wait()
}

func (process *claimedGuardedNodeProcess) WaitContext(ctx context.Context) (uint32, error) {
	return process.owner.WaitContext(ctx)
}

func (process *claimedGuardedNodeProcess) Terminate() error {
	return process.owner.Terminate()
}

func (process *claimedGuardedNodeProcess) Close() error {
	return process.owner.Close()
}

var (
	_ winprocess.NodeProcess = (*GuardedNodeProcess)(nil)
	_ winprocess.NodeProcess = (*claimedGuardedNodeProcess)(nil)
	_ HostControlNodeProcess = (*claimedGuardedNodeProcess)(nil)
)
