//go:build windows

package winpipe

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sys/windows"
)

const (
	endpointOperationCleanupGrace = 2 * time.Second
	endpointCloseGrace            = 3 * time.Second
)

type endpointCancelFunc func(windows.Handle, *windows.Overlapped) error
type endpointCloseHandleFunc func(windows.Handle) error
type endpointConnectFunc func(windows.Handle, *windows.Overlapped) error
type endpointCreateEventFunc func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error)
type endpointDisconnectFunc func(windows.Handle) error
type endpointGetResultFunc func(windows.Handle, *windows.Overlapped, *uint32, bool) error
type endpointReadFunc func(windows.Handle, []byte, *uint32, *windows.Overlapped) error
type endpointWaitFunc func(windows.Handle, uint32) (uint32, error)
type endpointWriteFunc func(windows.Handle, []byte, *uint32, *windows.Overlapped) error

type endpointOperationKind uint8

const (
	endpointOperationConnect endpointOperationKind = iota + 1
	endpointOperationRead
	endpointOperationWrite
)

type endpointActivity struct {
	mu      sync.Mutex
	count   int
	drained chan struct{}
}

func (activity *endpointActivity) begin() func() {
	activity.mu.Lock()
	if activity.count == 0 {
		activity.drained = make(chan struct{})
	}
	activity.count++
	activity.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			activity.mu.Lock()
			activity.count--
			if activity.count == 0 {
				close(activity.drained)
			}
			activity.mu.Unlock()
		})
	}
}

func (activity *endpointActivity) wait(timeout time.Duration) bool {
	activity.mu.Lock()
	if activity.count == 0 {
		activity.mu.Unlock()
		return true
	}
	drained := activity.drained
	activity.mu.Unlock()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-drained:
		return true
	case <-timer.C:
		return false
	}
}

type endpointLifetimeQuarantine struct {
	mu     sync.RWMutex
	owners []any
	fatal  error
}

var windowsEndpointLifetimeQuarantine = &endpointLifetimeQuarantine{}

func (quarantine *endpointLifetimeQuarantine) retain(owner any, cause error) error {
	if quarantine == nil {
		return errors.Join(ErrIOUnresolvedFatal, cause, errors.New("named-pipe process-lifetime quarantine is unavailable"))
	}
	if owner == nil {
		return errors.Join(ErrIOUnresolvedFatal, cause, errors.New("named-pipe quarantine owner is unavailable"))
	}
	result := errors.Join(ErrIOUnresolvedFatal, cause)
	quarantine.mu.Lock()
	quarantine.owners = append(quarantine.owners, owner)
	quarantine.fatal = errors.Join(quarantine.fatal, result)
	quarantine.mu.Unlock()
	return result
}

func (quarantine *endpointLifetimeQuarantine) count() int {
	if quarantine == nil {
		return 0
	}
	quarantine.mu.RLock()
	defer quarantine.mu.RUnlock()
	return len(quarantine.owners)
}

func (quarantine *endpointLifetimeQuarantine) fatalError() error {
	if quarantine == nil {
		return ErrIOUnresolvedFatal
	}
	quarantine.mu.RLock()
	defer quarantine.mu.RUnlock()
	return quarantine.fatal
}

func (quarantine *endpointLifetimeQuarantine) beginNativeUse() (func(), error) {
	if quarantine == nil {
		return func() {}, ErrIOUnresolvedFatal
	}
	quarantine.mu.RLock()
	if quarantine.fatal != nil {
		fatal := quarantine.fatal
		quarantine.mu.RUnlock()
		return func() {}, fatal
	}
	return quarantine.mu.RUnlock, nil
}

type endpointRawHandleOwner struct {
	kind  string
	value windows.Handle
}

func adoptEndpointHandleOutput(
	label string,
	handle windows.Handle,
	callErr error,
	quarantine *endpointLifetimeQuarantine,
) (windows.Handle, error) {
	if callErr != nil {
		if handle != 0 && handle != windows.InvalidHandle {
			return 0, errors.Join(
				callErr,
				quarantine.retain(
					&endpointRawHandleOwner{kind: "untrusted " + label + " output", value: handle},
					fmt.Errorf("%s returned a handle together with an error", label),
				),
			)
		}
		return 0, callErr
	}
	if handle == 0 {
		return 0, fmt.Errorf("%s returned a null handle without an error", label)
	}
	if handle == windows.InvalidHandle {
		return 0, quarantine.retain(
			&endpointRawHandleOwner{kind: "invalid " + label + " output", value: handle},
			fmt.Errorf("%s returned INVALID_HANDLE_VALUE without an error", label),
		)
	}
	return handle, nil
}

func consumeEndpointHandleOnce(
	label string,
	handle windows.Handle,
	closeHandle endpointCloseHandleFunc,
	quarantine *endpointLifetimeQuarantine,
) error {
	if handle == 0 {
		return nil
	}
	owner := &endpointRawHandleOwner{kind: label, value: handle}
	if handle == windows.InvalidHandle {
		return quarantine.retain(owner, windows.ERROR_INVALID_HANDLE)
	}
	if closeHandle == nil {
		return quarantine.retain(owner, fmt.Errorf("%s close operation is unavailable", label))
	}
	releaseNative, gateErr := quarantine.beginNativeUse()
	if gateErr != nil {
		return quarantine.retain(owner, errors.Join(gateErr, fmt.Errorf("%s was not consumed after process fatal state", label)))
	}
	err := closeHandle(handle)
	releaseNative()
	if err != nil {
		return quarantine.retain(owner, fmt.Errorf("%s: %w", label, err))
	}
	return nil
}

// endpointOperation is heap-owned and pinned before Windows can retain its
// OVERLAPPED or buffer pointers. An unresolved operation is never finalized.
type endpointOperation struct {
	state       *endpointState
	kind        endpointOperationKind
	handle      windows.Handle
	buffer      []byte
	event       windows.Handle
	overlapped  windows.Overlapped
	transferred uint32
	finish      func()

	pinner           runtime.Pinner
	pinned           bool
	submitted        bool
	completed        bool
	quarantined      bool
	pipeTombstoned   bool
	eventTombstoned  bool
	forcedQuarantine atomic.Bool
}

func newEndpointOperation(
	state *endpointState,
	kind endpointOperationKind,
	handle windows.Handle,
	buffer []byte,
	event windows.Handle,
	finish func(),
) *endpointOperation {
	operation := &endpointOperation{
		state:     state,
		kind:      kind,
		handle:    handle,
		buffer:    buffer,
		event:     event,
		finish:    finish,
		completed: true,
	}
	operation.overlapped.HEvent = event
	operation.pinner.Pin(&operation.overlapped)
	if len(operation.buffer) != 0 {
		operation.pinner.Pin(&operation.buffer[0])
	}
	operation.pinned = true
	return operation
}

func (state *endpointState) beginOperation() (windows.Handle, func(), error) {
	state.stateMu.Lock()
	defer state.stateMu.Unlock()
	if fatal := state.quarantineOrDefault().fatalError(); fatal != nil {
		state.markFatalLocked(fatal)
		return 0, func() {}, fatal
	}
	if err := state.stateErrorLocked(); err != nil {
		return 0, func() {}, err
	}
	if state.handle == 0 || state.closing {
		return 0, func() {}, ErrClosed
	}
	return state.handle, state.active.begin(), nil
}

func (state *endpointState) createOperationEvent() (windows.Handle, error) {
	releaseNative, gateErr := state.quarantineOrDefault().beginNativeUse()
	if gateErr != nil {
		state.markFatal(gateErr)
		return 0, gateErr
	}
	createEvent := state.createEvent
	if createEvent == nil {
		createEvent = windows.CreateEvent
	}
	event, callErr := createEvent(nil, 1, 0, nil)
	releaseNative()
	if callErr != nil {
		if event != 0 && event != windows.InvalidHandle {
			fatal := state.quarantineOwner(
				&endpointRawHandleOwner{kind: "untrusted named-pipe I/O event output", value: event},
				errors.New("CreateEvent returned a handle together with an error"),
			)
			state.markFatal(fatal)
			return 0, errors.Join(callErr, fatal, state.quarantineOwner(state, fatal))
		}
		return 0, callErr
	}
	if event == 0 {
		return 0, errors.New("CreateEvent returned a null handle without an error")
	}
	if event == windows.InvalidHandle {
		fatal := state.quarantineOwner(
			&endpointRawHandleOwner{kind: "invalid named-pipe I/O event output", value: event},
			windows.ERROR_INVALID_HANDLE,
		)
		state.markFatal(fatal)
		return 0, errors.Join(fatal, state.quarantineOwner(state, fatal))
	}
	return event, nil
}

func (state *endpointState) submitOperation(operation *endpointOperation) error {
	state.stateMu.Lock()
	defer state.stateMu.Unlock()
	if err := state.stateErrorLocked(); err != nil {
		return err
	}
	if state.handle == 0 || state.handle != operation.handle || state.closing {
		return ErrClosed
	}
	releaseNative, gateErr := state.quarantineOrDefault().beginNativeUse()
	if gateErr != nil {
		operation.forcedQuarantine.Store(true)
		state.markFatalLocked(gateErr)
		return gateErr
	}
	defer releaseNative()
	if state.operations == nil {
		state.operations = make(map[*endpointOperation]struct{})
	}
	state.operations[operation] = struct{}{}
	operation.submitted = true
	operation.completed = false

	var err error
	switch operation.kind {
	case endpointOperationConnect:
		connectPipe := state.connectPipe
		if connectPipe == nil {
			connectPipe = windows.ConnectNamedPipe
		}
		err = connectPipe(operation.handle, &operation.overlapped)
	case endpointOperationRead:
		readFile := state.readFile
		if readFile == nil {
			readFile = windows.ReadFile
		}
		err = readFile(operation.handle, operation.buffer, &operation.transferred, &operation.overlapped)
	case endpointOperationWrite:
		writeFile := state.writeFile
		if writeFile == nil {
			writeFile = windows.WriteFile
		}
		err = writeFile(operation.handle, operation.buffer, &operation.transferred, &operation.overlapped)
	default:
		err = errors.New("unknown named-pipe overlapped operation")
	}
	runtime.KeepAlive(operation)
	if errors.Is(err, windows.ERROR_INVALID_HANDLE) {
		operation.pipeTombstoned = true
		state.handle = 0
		state.markFatalLocked(err)
	}
	return err
}

func (state *endpointState) releaseCompletedOperation(operation *endpointOperation) error {
	closeHandle := state.closeHandle
	if closeHandle == nil {
		closeHandle = windows.CloseHandle
	}
	event := operation.event
	operation.event = 0
	eventCloseErr := consumeEndpointHandleOnce(
		"close named-pipe overlapped event",
		event,
		closeHandle,
		state.quarantineOrDefault(),
	)

	state.stateMu.Lock()
	_, registered := state.operations[operation]
	if operation.submitted && registered {
		delete(state.operations, operation)
	}
	var invariantErr error
	if operation.submitted && !registered {
		invariantErr = errors.New("named-pipe overlapped completion ownership changed")
	}
	if eventCloseErr != nil || invariantErr != nil {
		state.markFatalLocked(errors.Join(eventCloseErr, invariantErr))
	}
	state.stateMu.Unlock()

	operation.pinner.Unpin()
	operation.pinned = false
	operation.finish()
	operation.finish = nil
	if eventCloseErr != nil || invariantErr != nil {
		return errors.Join(
			eventCloseErr,
			invariantErr,
			state.quarantineOwner(operation, errors.Join(eventCloseErr, invariantErr)),
		)
	}
	operation.buffer = nil
	operation.state = nil
	return nil
}

func (state *endpointState) quarantineIncompleteOperation(operation *endpointOperation, cause error) error {
	state.stateMu.Lock()
	if operation.pipeTombstoned && state.handle == operation.handle {
		state.handle = 0
	}
	if !operation.quarantined {
		operation.quarantined = true
		state.markFatalLocked(cause)
	}
	state.stateMu.Unlock()
	if cause == nil {
		cause = errors.New("named-pipe overlapped completion state is unknown")
	}
	return state.quarantineOwner(operation, cause)
}

func (state *endpointState) quarantineOrDefault() *endpointLifetimeQuarantine {
	if state.quarantine != nil {
		return state.quarantine
	}
	return windowsEndpointLifetimeQuarantine
}

func (state *endpointState) quarantineOwner(owner any, cause error) error {
	return state.quarantineOrDefault().retain(owner, cause)
}

func (state *endpointState) markFatal(cause error) error {
	state.stateMu.Lock()
	defer state.stateMu.Unlock()
	return state.markFatalLocked(cause)
}

func (state *endpointState) markFatalLocked(cause error) error {
	if cause == nil {
		cause = errors.New("named-pipe native ownership is unresolved")
	}
	state.quarantined = true
	state.closed = true
	state.closing = true
	state.connected = false
	state.fatal = errors.Join(state.fatal, ErrIOUnresolvedFatal, cause)
	for operation := range state.operations {
		operation.forcedQuarantine.Store(true)
	}
	return state.fatal
}

func (state *endpointState) stopCause() error {
	if fatal := state.quarantineOrDefault().fatalError(); fatal != nil {
		state.markFatal(fatal)
		return fatal
	}
	state.stateMu.Lock()
	defer state.stateMu.Unlock()
	if state.fatal != nil {
		return state.fatal
	}
	if state.closing || state.closed {
		return ErrClosed
	}
	return state.terminal
}

func (state *endpointState) completeOperation(operation *endpointOperation) (bool, error) {
	state.stateMu.Lock()
	defer state.stateMu.Unlock()
	if state.fatal != nil || state.handle == 0 || state.handle != operation.handle || operation.pipeTombstoned {
		operation.forcedQuarantine.Store(true)
		if state.fatal != nil {
			return false, state.fatal
		}
		return false, ErrIOUnresolvedFatal
	}
	releaseNative, gateErr := state.quarantineOrDefault().beginNativeUse()
	if gateErr != nil {
		operation.forcedQuarantine.Store(true)
		state.markFatalLocked(gateErr)
		return false, gateErr
	}
	defer releaseNative()
	getResult := state.getOverlappedResult
	if getResult == nil {
		getResult = windows.GetOverlappedResult
	}
	err := getResult(operation.handle, &operation.overlapped, &operation.transferred, false)
	runtime.KeepAlive(operation)
	completed, classifiedErr := classifyEndpointCompletion(operation.kind, err)
	if errors.Is(classifiedErr, windows.ERROR_INVALID_HANDLE) {
		operation.pipeTombstoned = true
		if state.handle == operation.handle {
			state.handle = 0
		}
		state.markFatalLocked(classifiedErr)
	}
	return completed, classifiedErr
}

func (state *endpointState) cancelAndComplete(
	operation *endpointOperation,
	timeout time.Duration,
) (bool, error) {
	state.stateMu.Lock()
	if state.fatal != nil || state.handle == 0 || state.handle != operation.handle || operation.pipeTombstoned {
		operation.forcedQuarantine.Store(true)
		fatal := state.fatal
		state.stateMu.Unlock()
		if fatal != nil {
			return false, fatal
		}
		return false, ErrIOUnresolvedFatal
	}
	releaseNative, gateErr := state.quarantineOrDefault().beginNativeUse()
	if gateErr != nil {
		operation.forcedQuarantine.Store(true)
		state.markFatalLocked(gateErr)
		state.stateMu.Unlock()
		return false, gateErr
	}
	cancelIO := state.cancelIO
	if cancelIO == nil {
		cancelIO = windows.CancelIoEx
	}
	cancelErr := cancelIO(operation.handle, &operation.overlapped)
	runtime.KeepAlive(operation)
	if errors.Is(cancelErr, windows.ERROR_INVALID_HANDLE) {
		operation.pipeTombstoned = true
		if state.handle == operation.handle {
			state.handle = 0
		}
		state.markFatalLocked(cancelErr)
		releaseNative()
		state.stateMu.Unlock()
		return false, cancelErr
	}
	releaseNative()
	state.stateMu.Unlock()
	if errors.Is(cancelErr, windows.ERROR_NOT_FOUND) {
		cancelErr = nil
	}
	completed, completionErr := state.waitForTerminalCompletion(operation, timeout)
	if completed && errors.Is(completionErr, windows.ERROR_OPERATION_ABORTED) {
		completionErr = nil
	}
	return completed, errors.Join(cancelErr, completionErr)
}

func (state *endpointState) waitForTerminalCompletion(
	operation *endpointOperation,
	timeout time.Duration,
) (bool, error) {
	waitForSingleObject := state.waitForSingleObject
	if waitForSingleObject == nil {
		waitForSingleObject = windows.WaitForSingleObject
	}
	status, waitErr := waitForSingleObject(operation.event, endpointDurationMilliseconds(timeout))
	runtime.KeepAlive(operation)
	if waitErr != nil {
		if errors.Is(waitErr, windows.ERROR_INVALID_HANDLE) {
			operation.eventTombstoned = true
			state.markFatal(waitErr)
		}
		return false, waitErr
	}
	switch status {
	case windows.WAIT_OBJECT_0:
		return state.completeOperation(operation)
	case uint32(windows.WAIT_TIMEOUT):
		return false, ErrCloseTimeout
	default:
		return false, fmt.Errorf("wait for canceled named-pipe I/O returned status 0x%x", status)
	}
}

func classifyEndpointCompletion(kind endpointOperationKind, err error) (bool, error) {
	if err == nil ||
		errors.Is(err, windows.ERROR_OPERATION_ABORTED) ||
		errors.Is(err, windows.ERROR_BROKEN_PIPE) ||
		errors.Is(err, windows.ERROR_NO_DATA) ||
		errors.Is(err, windows.ERROR_PIPE_NOT_CONNECTED) ||
		kind == endpointOperationRead && errors.Is(err, windows.ERROR_MORE_DATA) {
		return true, err
	}
	return false, err
}

func endpointDurationMilliseconds(value time.Duration) uint32 {
	if value <= 0 {
		return 1
	}
	milliseconds := (value + time.Millisecond - 1) / time.Millisecond
	if milliseconds > time.Duration(^uint32(0)) {
		return ^uint32(0)
	}
	return uint32(milliseconds)
}

func (e *Endpoint) performOverlapped(
	ctx context.Context,
	kind endpointOperationKind,
	buffer []byte,
) (transferred uint32, resultErr error) {
	state, err := e.currentState()
	if err != nil {
		return 0, err
	}
	if cause := context.Cause(ctx); cause != nil {
		return 0, cause
	}
	handle, finish, err := state.beginOperation()
	if err != nil {
		return 0, err
	}
	event, err := state.createOperationEvent()
	if err != nil {
		finish()
		return 0, err
	}
	operation := newEndpointOperation(state, kind, handle, buffer, event, finish)
	defer func() {
		var lifecycleErr error
		if operation.completed && !operation.forcedQuarantine.Load() {
			lifecycleErr = state.releaseCompletedOperation(operation)
		} else {
			lifecycleErr = state.quarantineIncompleteOperation(operation, resultErr)
		}
		resultErr = errors.Join(resultErr, lifecycleErr)
	}()
	if cause := context.Cause(ctx); cause != nil {
		return 0, cause
	}

	startErr := state.submitOperation(operation)
	if !operation.submitted {
		return 0, startErr
	}
	if startErr == nil {
		operation.completed = true
		return operation.transferred, nil
	}
	if !errors.Is(startErr, windows.ERROR_IO_PENDING) {
		if errors.Is(startErr, windows.ERROR_INVALID_HANDLE) {
			operation.completed = false
			return 0, startErr
		}
		operation.completed = true
		return operation.transferred, startErr
	}

	waitForSingleObject := state.waitForSingleObject
	if waitForSingleObject == nil {
		waitForSingleObject = windows.WaitForSingleObject
	}
	for {
		if cause := context.Cause(ctx); cause != nil {
			completed, completionErr := state.cancelAndComplete(operation, state.cleanupGrace)
			operation.completed = completed
			return operation.transferred, errors.Join(cause, completionErr)
		}
		if stopCause := state.stopCause(); stopCause != nil {
			if errors.Is(stopCause, ErrIOUnresolvedFatal) {
				operation.completed = false
				return 0, stopCause
			}
			completed, completionErr := state.cancelAndComplete(operation, state.cleanupGrace)
			operation.completed = completed
			return operation.transferred, errors.Join(stopCause, completionErr)
		}
		status, waitErr := waitForSingleObject(operation.event, overlappedPollMilliseconds)
		runtime.KeepAlive(operation)
		if waitErr != nil {
			if errors.Is(waitErr, windows.ERROR_INVALID_HANDLE) {
				operation.eventTombstoned = true
				state.markFatal(waitErr)
			}
			operation.completed = false
			return 0, fmt.Errorf("wait for named-pipe overlapped I/O: %w", waitErr)
		}
		switch status {
		case windows.WAIT_OBJECT_0:
			completed, completionErr := state.completeOperation(operation)
			operation.completed = completed
			return operation.transferred, completionErr
		case uint32(windows.WAIT_TIMEOUT):
			continue
		default:
			operation.completed = false
			return 0, fmt.Errorf("named-pipe overlapped I/O wait returned status 0x%x", status)
		}
	}
}
