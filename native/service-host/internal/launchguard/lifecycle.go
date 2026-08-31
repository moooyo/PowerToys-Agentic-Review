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

// LaunchNode consumes the guard and launches exactly the Node executable and
// role bundle selected by preflight. The only caller input is a per-launch
// HostControl rendezvous name validated by winprocess.
func (guard *Guard) LaunchNode(
	ctx context.Context,
	hostControlPipeName string,
) (winprocess.NodeProcess, error) {
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
	var guarded winprocess.NodeProcess
	if err := permit.commit(func() {
		state.consumed = true
		guarded = &guardedNodeProcess{inner: node, guard: state}
	}); err != nil {
		state.terminal = err
		return nil, state.rejectLaunchedNodeLocked(node, err)
	}
	return guarded, nil
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

type guardedNodeProcess struct {
	inner    winprocess.NodeProcess
	guard    *guardState
	mu       sync.Mutex
	released bool
	terminal error
}

func (process *guardedNodeProcess) ProcessID() uint32 { return process.inner.ProcessID() }
func (process *guardedNodeProcess) StableIdentity() winprocess.NodeIdentity {
	return process.inner.StableIdentity()
}
func (process *guardedNodeProcess) ObserveIdentity() (winprocess.NodeIdentity, error) {
	return process.inner.ObserveIdentity()
}
func (process *guardedNodeProcess) RootJobActiveProcessCount() (uint32, error) {
	return process.inner.RootJobActiveProcessCount()
}
func (process *guardedNodeProcess) ActivateAfterHostControl() error {
	return process.inner.ActivateAfterHostControl()
}
func (process *guardedNodeProcess) TakeStandardIO() (*winprocess.NodeStandardIO, error) {
	return process.inner.TakeStandardIO()
}
func (process *guardedNodeProcess) Wait() (uint32, error) {
	return process.WaitContext(context.Background())
}
func (process *guardedNodeProcess) WaitContext(ctx context.Context) (uint32, error) {
	exitCode, err := process.inner.WaitContext(ctx)
	return exitCode, process.releaseAfterDrain(err)
}
func (process *guardedNodeProcess) Terminate() error {
	return process.releaseAfterDrain(process.inner.Terminate())
}
func (process *guardedNodeProcess) Close() error {
	return process.releaseAfterDrain(process.inner.Close())
}

func (process *guardedNodeProcess) releaseAfterDrain(operationErr error) error {
	process.mu.Lock()
	defer process.mu.Unlock()
	if process.terminal != nil {
		return process.terminal
	}
	if operationErr != nil {
		if errors.Is(operationErr, winprocess.ErrLaunchCleanupFatal) {
			owner := &rejectedLaunchOwner{guard: process.guard, node: process.inner}
			process.terminal = process.guard.deps.quarantine.retain(owner, operationErr)
			process.guard.mu.Lock()
			process.guard.terminal = process.terminal
			process.guard.closed = true
			process.guard.mu.Unlock()
			return process.terminal
		}
		return operationErr
	}
	if process.released {
		return nil
	}
	process.guard.mu.Lock()
	closeErr := process.guard.closeResourcesLocked()
	process.guard.mu.Unlock()
	if closeErr == nil {
		process.released = true
	}
	return closeErr
}

var _ winprocess.NodeProcess = (*guardedNodeProcess)(nil)
