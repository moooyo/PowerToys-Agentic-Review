//go:build windows

package winpipe

import (
	"context"
	"errors"
	"fmt"
	"io"
	"runtime"
	"sync"
	"time"
	"unsafe"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/framing"
	"golang.org/x/sys/windows"
)

const overlappedPollMilliseconds = 25

type endpointCloseMode uint8

const (
	endpointCloseModeNone endpointCloseMode = iota
	endpointCloseModeAbortive
	endpointCloseModeFlush
)

// Endpoint is a connected named-pipe endpoint. Copies share one private state
// and therefore one raw handle owner, operation set, and close result.
type Endpoint struct {
	state *endpointState
}

type endpointMetadata struct {
	pipeName               string
	maximumFrameBytes      uint32
	server                 bool
	connected              bool
	ownServiceSID          string
	peerServiceSID         string
	serverSecurityVerified bool
}

type endpointState struct {
	handle                 windows.Handle
	pipeName               string
	maximumFrameBytes      uint32
	server                 bool
	connected              bool
	ownServiceSID          string
	peerServiceSID         string
	serverSecurityVerified bool

	stateMu          sync.Mutex
	closed           bool
	closing          bool
	quarantined      bool
	terminal         error
	fatal            error
	active           endpointActivity
	closeOnce        sync.Once
	abortiveOnce     sync.Once
	closeMode        endpointCloseMode
	closeErr         error
	flushErr         error
	closeDone        chan struct{}
	abortWaitDone    chan struct{}
	abortWaitErr     error
	abortWaitStarted bool
	closeCompleted   bool
	activeFlush      *endpointFlushOwner
	operations       map[*endpointOperation]struct{}
	quarantine       *endpointLifetimeQuarantine
	cleanupGrace     time.Duration
	closeGrace       time.Duration
	abortiveClose    chan struct{}

	readGate  chan struct{}
	writeGate chan struct{}

	cancelIO            endpointCancelFunc
	closeHandle         endpointCloseHandleFunc
	connectPipe         endpointConnectFunc
	createEvent         endpointCreateEventFunc
	disconnect          endpointDisconnectFunc
	flushBuffers        endpointFlushFunc
	getOverlappedResult endpointGetResultFunc
	readFile            endpointReadFunc
	waitForSingleObject endpointWaitFunc
	writeFile           endpointWriteFunc
}

// Accept creates the only server instance and waits for one client. The caller
// must independently verify the connected peer before exchanging frames.
func Accept(ctx context.Context, options ServerOptions) (*Endpoint, error) {
	if ctx == nil {
		return nil, errors.New("named-pipe accept context is required")
	}
	if cause := context.Cause(ctx); cause != nil {
		return nil, cause
	}
	if fatal := windowsEndpointLifetimeQuarantine.fatalError(); fatal != nil {
		return nil, fatal
	}

	sddl, err := validateServerOptions(options)
	if err != nil {
		return nil, err
	}
	ownSID, err := windows.StringToSid(options.OwnServiceSID)
	if err != nil || ownSID == nil || !ownSID.IsValid() || ownSID.String() != options.OwnServiceSID {
		return nil, invalidOptions("own SID is not accepted by Windows as a canonical SID")
	}
	peerSID, err := windows.StringToSid(options.PeerServiceSID)
	if err != nil || peerSID == nil || !peerSID.IsValid() || peerSID.String() != options.PeerServiceSID {
		return nil, invalidOptions("peer SID is not accepted by Windows as a canonical SID")
	}

	securityDescriptor, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return nil, fmt.Errorf("create named-pipe security descriptor: %w", err)
	}
	if err := validateSecurityDescriptor(securityDescriptor, options.OwnServiceSID, options.PeerServiceSID); err != nil {
		return nil, err
	}
	securityAttributes := &windows.SecurityAttributes{
		Length:             uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		SecurityDescriptor: securityDescriptor,
		InheritHandle:      0,
	}
	name, err := windows.UTF16PtrFromString(options.PipeName)
	if err != nil {
		return nil, invalidOptions("pipe name is not valid UTF-16")
	}

	releaseNative, gateErr := windowsEndpointLifetimeQuarantine.beginNativeUse()
	if gateErr != nil {
		return nil, gateErr
	}
	handle, err := windows.CreateNamedPipe(
		name,
		serverOpenMode,
		serverPipeMode,
		maximumServerInstances,
		options.MaximumFrameBytes,
		options.MaximumFrameBytes,
		0,
		securityAttributes,
	)
	releaseNative()
	runtime.KeepAlive(securityDescriptor)
	runtime.KeepAlive(ownSID)
	runtime.KeepAlive(peerSID)
	handle, err = adoptEndpointHandleOutput(
		"named-pipe server",
		handle,
		err,
		windowsEndpointLifetimeQuarantine,
	)
	if err != nil {
		return nil, fmt.Errorf("create named-pipe server: %w", err)
	}

	securityEvidence, err := readBackCreatedServerSecurity(
		handle,
		options.OwnServiceSID,
		options.PeerServiceSID,
	)
	if err != nil {
		cleanupErr := rejectUnattestedServerHandle(
			handle,
			err,
			windows.CloseHandle,
			windowsEndpointLifetimeQuarantine,
		)
		return nil, errors.Join(fmt.Errorf("verify created named-pipe server security: %w", err), cleanupErr)
	}

	endpoint := newEndpoint(handle, endpointMetadata{
		pipeName:               options.PipeName,
		maximumFrameBytes:      options.MaximumFrameBytes,
		server:                 true,
		ownServiceSID:          securityEvidence.ownServiceSID,
		peerServiceSID:         securityEvidence.peerServiceSID,
		serverSecurityVerified: securityEvidence.protected,
	})
	if err := endpoint.connect(ctx); err != nil {
		if errors.Is(err, ErrIOUnresolvedFatal) {
			return nil, errors.Join(err, windowsEndpointLifetimeQuarantine.retain(endpoint.state, err))
		}
		closeErr := endpoint.Close()
		return nil, errors.Join(err, closeErr)
	}
	commit, fatal := windowsEndpointLifetimeQuarantine.beginNativeUse()
	if fatal != nil {
		endpoint.state.markFatal(fatal)
		return nil, errors.Join(fatal, windowsEndpointLifetimeQuarantine.retain(endpoint.state, fatal))
	}
	defer commit()
	return endpoint, nil
}

// Dial waits for the Control-owned instance and opens it with only the rights
// granted to the Executor service SID.
func Dial(ctx context.Context, options ClientOptions) (*Endpoint, error) {
	if ctx == nil {
		return nil, errors.New("named-pipe dial context is required")
	}
	if err := validateClientOptions(options); err != nil {
		return nil, err
	}
	if fatal := windowsEndpointLifetimeQuarantine.fatalError(); fatal != nil {
		return nil, fatal
	}
	name, err := windows.UTF16PtrFromString(options.PipeName)
	if err != nil {
		return nil, invalidOptions("pipe name is not valid UTF-16")
	}

	for {
		if fatal := windowsEndpointLifetimeQuarantine.fatalError(); fatal != nil {
			return nil, fatal
		}
		if cause := context.Cause(ctx); cause != nil {
			return nil, cause
		}
		releaseNative, gateErr := windowsEndpointLifetimeQuarantine.beginNativeUse()
		if gateErr != nil {
			return nil, gateErr
		}
		handle, openErr := windows.CreateFile(
			name,
			clientDesiredAccess,
			0,
			nil,
			windows.OPEN_EXISTING,
			clientOpenFlags,
			0,
		)
		releaseNative()
		handle, openErr = adoptEndpointHandleOutput(
			"named-pipe client",
			handle,
			openErr,
			windowsEndpointLifetimeQuarantine,
		)
		if errors.Is(openErr, ErrIOUnresolvedFatal) {
			return nil, openErr
		}
		if openErr == nil {
			setStatePermit, fatal := windowsEndpointLifetimeQuarantine.beginNativeUse()
			if fatal != nil {
				return nil, errors.Join(
					fatal,
					windowsEndpointLifetimeQuarantine.retain(
						&endpointRawHandleOwner{kind: "named-pipe client acquired during process fatal state", value: handle},
						fatal,
					),
				)
			}
			readMode := pipeReadModeMessage | pipeWait
			stateErr := windows.SetNamedPipeHandleState(handle, &readMode, nil, nil)
			setStatePermit()
			if stateErr != nil {
				if errors.Is(stateErr, windows.ERROR_INVALID_HANDLE) {
					fatal := windowsEndpointLifetimeQuarantine.retain(
						&endpointRawHandleOwner{kind: "invalid named-pipe client handle", value: handle},
						stateErr,
					)
					return nil, errors.Join(fmt.Errorf("set named-pipe client message mode: %w", stateErr), fatal)
				}
				closeErr := consumeEndpointHandleOnce(
					"close rejected named-pipe client handle",
					handle,
					windows.CloseHandle,
					windowsEndpointLifetimeQuarantine,
				)
				return nil, errors.Join(
					fmt.Errorf("set named-pipe client message mode: %w", stateErr),
					closeErr,
				)
			}
			if cause := context.Cause(ctx); cause != nil {
				return nil, errors.Join(
					cause,
					consumeEndpointHandleOnce(
						"close canceled named-pipe client handle",
						handle,
						windows.CloseHandle,
						windowsEndpointLifetimeQuarantine,
					),
				)
			}
			commit, fatal := windowsEndpointLifetimeQuarantine.beginNativeUse()
			if fatal != nil {
				return nil, errors.Join(
					fatal,
					windowsEndpointLifetimeQuarantine.retain(
						&endpointRawHandleOwner{kind: "named-pipe client acquired before process fatal state", value: handle},
						fatal,
					),
				)
			}
			defer commit()
			return newEndpoint(handle, endpointMetadata{
				pipeName:          options.PipeName,
				maximumFrameBytes: options.MaximumFrameBytes,
				connected:         true,
			}), nil
		}
		if !errors.Is(openErr, windows.ERROR_FILE_NOT_FOUND) &&
			!errors.Is(openErr, windows.ERROR_PIPE_BUSY) {
			return nil, fmt.Errorf("open named-pipe client: %w", openErr)
		}
		if err := waitForRetry(ctx); err != nil {
			return nil, err
		}
	}
}

func newEndpoint(handle windows.Handle, metadata endpointMetadata) *Endpoint {
	state := &endpointState{
		handle:                 handle,
		pipeName:               metadata.pipeName,
		maximumFrameBytes:      metadata.maximumFrameBytes,
		server:                 metadata.server,
		connected:              metadata.connected,
		ownServiceSID:          metadata.ownServiceSID,
		peerServiceSID:         metadata.peerServiceSID,
		serverSecurityVerified: metadata.serverSecurityVerified,
		readGate:               make(chan struct{}, 1),
		writeGate:              make(chan struct{}, 1),
		operations:             make(map[*endpointOperation]struct{}),
		quarantine:             windowsEndpointLifetimeQuarantine,
		cleanupGrace:           endpointOperationCleanupGrace,
		closeGrace:             endpointCloseGrace,
		abortiveClose:          make(chan struct{}),
		closeDone:              make(chan struct{}),
		abortWaitDone:          make(chan struct{}),
	}
	state.readGate <- struct{}{}
	state.writeGate <- struct{}{}
	return &Endpoint{state: state}
}

func (e *Endpoint) currentState() (*endpointState, error) {
	if e == nil || e.state == nil {
		return nil, ErrClosed
	}
	if fatal := e.state.quarantineOrDefault().fatalError(); fatal != nil {
		e.state.markFatal(fatal)
		return nil, fatal
	}
	return e.state, nil
}

func validateSecurityDescriptor(
	descriptor *windows.SECURITY_DESCRIPTOR,
	expectedOwnServiceSID string,
	expectedPeerServiceSID string,
) error {
	evidence, err := endpointSecurityEvidenceFromDescriptor(descriptor)
	if err != nil {
		return err
	}
	_, err = validateCreatedServerSecurity(evidence, expectedOwnServiceSID, expectedPeerServiceSID)
	return err
}

func waitForRetry(ctx context.Context) error {
	timer := time.NewTimer(overlappedPollMilliseconds * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return context.Cause(ctx)
	case <-timer.C:
		return nil
	}
}

func (e *Endpoint) connect(ctx context.Context) error {
	_, err := e.performOverlapped(ctx, endpointOperationConnect, nil)
	if errors.Is(err, ErrIOUnresolvedFatal) {
		wrapped := fmt.Errorf("connect named-pipe server: %w", err)
		e.markFailed(wrapped)
		return wrapped
	}
	if errors.Is(err, windows.ERROR_PIPE_CONNECTED) {
		return e.markConnected()
	}
	if err != nil {
		err = e.normalizeOperationError(err, false)
		wrapped := fmt.Errorf("connect named-pipe server: %w", err)
		e.markFailed(wrapped)
		return wrapped
	}
	return e.markConnected()
}

func (e *Endpoint) markConnected() error {
	state, err := e.currentState()
	if err != nil {
		return err
	}
	state.stateMu.Lock()
	defer state.stateMu.Unlock()
	if err := state.stateErrorLocked(); err != nil {
		return err
	}
	if !state.server || state.connected {
		return errors.New("named-pipe server connection state is invalid")
	}
	state.connected = true
	return nil
}

func (e *Endpoint) ReadFrame(ctx context.Context) ([]byte, error) {
	state, stateErr := e.currentState()
	if stateErr != nil {
		return nil, stateErr
	}
	if ctx == nil {
		return nil, errors.New("named-pipe read context is required")
	}
	if err := acquire(ctx, state.readGate); err != nil {
		return nil, err
	}
	defer release(state.readGate)

	buffer := make([]byte, int(state.maximumFrameBytes))
	transferred, err := e.performOverlapped(ctx, endpointOperationRead, buffer)
	runtime.KeepAlive(buffer)
	if errors.Is(err, windows.ERROR_MORE_DATA) {
		wrapped := errors.Join(fmt.Errorf("read named-pipe frame: %w", framing.ErrFrameTooLarge), err)
		e.markFailed(wrapped)
		return nil, wrapped
	}
	if err != nil {
		if transferred == 0 && isExactNamedPipeReadEOF(err) {
			return nil, io.EOF
		}
		err = e.normalizeOperationError(err, true)
		wrapped := fmt.Errorf("read named-pipe frame: %w", err)
		e.markFailed(wrapped)
		return nil, wrapped
	}
	if transferred > uint32(len(buffer)) {
		wrapped := errors.New("read named-pipe frame returned an invalid byte count")
		e.markFailed(wrapped)
		return nil, wrapped
	}

	value := append([]byte(nil), buffer[:transferred]...)
	if _, err := framing.ValidateFrame(value, state.maximumFrameBytes); err != nil {
		wrapped := fmt.Errorf("validate named-pipe frame: %w", err)
		e.markFailed(wrapped)
		return nil, wrapped
	}
	return value, nil
}

func isExactNamedPipeReadEOF(err error) bool {
	return err == windows.ERROR_BROKEN_PIPE ||
		err == windows.ERROR_NO_DATA ||
		err == windows.ERROR_PIPE_NOT_CONNECTED
}

func (e *Endpoint) WriteFrame(ctx context.Context, value []byte) error {
	state, stateErr := e.currentState()
	if stateErr != nil {
		return stateErr
	}
	if ctx == nil {
		return errors.New("named-pipe write context is required")
	}
	if err := acquire(ctx, state.writeGate); err != nil {
		return err
	}
	defer release(state.writeGate)

	kernelBuffer := append([]byte(nil), value...)
	if _, err := framing.ValidateFrame(kernelBuffer, state.maximumFrameBytes); err != nil {
		wrapped := fmt.Errorf("validate named-pipe frame: %w", err)
		e.markFailed(wrapped)
		return wrapped
	}
	transferred, err := e.performOverlapped(ctx, endpointOperationWrite, kernelBuffer)
	if err != nil {
		err = e.normalizeOperationError(err, false)
		wrapped := fmt.Errorf("write named-pipe frame: %w", err)
		e.markFailed(wrapped)
		return wrapped
	}
	if transferred != uint32(len(value)) {
		wrapped := fmt.Errorf("write named-pipe frame: %w", io.ErrShortWrite)
		e.markFailed(wrapped)
		return wrapped
	}
	return nil
}

func acquire(ctx context.Context, gate chan struct{}) error {
	select {
	case <-ctx.Done():
		return context.Cause(ctx)
	case <-gate:
		return nil
	}
}

func release(gate chan struct{}) {
	gate <- struct{}{}
}

func (e *Endpoint) markFailed(cause error) {
	if cause == nil {
		return
	}
	state, err := e.currentState()
	if err != nil {
		return
	}
	state.stateMu.Lock()
	defer state.stateMu.Unlock()
	if state.closed || state.fatal != nil || state.terminal != nil {
		return
	}
	state.terminal = cause
	state.connected = false
}

func (e *Endpoint) normalizeOperationError(err error, reading bool) error {
	if errors.Is(err, ErrIOUnresolvedFatal) {
		return err
	}
	if errors.Is(err, windows.ERROR_OPERATION_ABORTED) {
		state, stateErr := e.currentState()
		if stateErr != nil {
			return stateErr
		}
		state.stateMu.Lock()
		stateErr = state.stateErrorLocked()
		state.stateMu.Unlock()
		if stateErr != nil {
			return stateErr
		}
	}
	if errors.Is(err, windows.ERROR_BROKEN_PIPE) ||
		errors.Is(err, windows.ERROR_NO_DATA) ||
		errors.Is(err, windows.ERROR_PIPE_NOT_CONNECTED) {
		if reading {
			return io.EOF
		}
		return io.ErrClosedPipe
	}
	return err
}

func (state *endpointState) stateErrorLocked() error {
	if state.fatal != nil {
		return state.fatal
	}
	if state.closed || state.closing || state.handle == 0 {
		return ErrClosed
	}
	return state.terminal
}

type endpointCloseSnapshot struct {
	handle     windows.Handle
	server     bool
	closeGrace time.Duration
	terminal   error
}

type endpointFlushOwner struct {
	state     *endpointState
	handle    windows.Handle
	done      chan endpointFlushResult
	finish    func()
	started   bool
	canceled  bool
	completed bool
}

type endpointFlushResult struct {
	err               error
	nativeStarted     bool
	admissionCanceled bool
}

// FlushThenClose is the server's consume-once graceful close. It proves that
// the client consumed every successful write before disconnecting and closing
// the server handle. A blocked flush is quarantined rather than raced by Close.
func (e *Endpoint) FlushThenClose(ctx context.Context) error {
	if e == nil || e.state == nil {
		return ErrClosed
	}
	state := e.state
	state.stateMu.Lock()
	server := state.server
	mode := state.closeMode
	done := state.closeDoneLocked()
	abortWaitStarted := state.abortWaitStarted
	abortWaitDone := state.abortWaitDoneLocked()
	localFatal := state.fatal
	state.stateMu.Unlock()
	if mode != endpointCloseModeNone {
		if abortWaitStarted {
			<-abortWaitDone
			<-done
			return state.completedFlushCloseResult(mode)
		}
		if localFatal != nil {
			if mode == endpointCloseModeAbortive {
				return errors.Join(ErrFlushInterrupted, localFatal)
			}
			return localFatal
		}
		return state.waitForFlushCloseResult(ctx, mode, done)
	}
	if localFatal != nil {
		return localFatal
	}
	if fatal := state.quarantineOrDefault().fatalError(); fatal != nil {
		state.markFatal(fatal)
		return fatal
	}
	if !server {
		return ErrFlushServerOnly
	}
	if ctx == nil {
		return ErrFlushDeadline
	}
	if _, ok := ctx.Deadline(); !ok {
		return ErrFlushDeadline
	}
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}

	state.stateMu.Lock()
	mode = state.closeMode
	done = state.closeDoneLocked()
	selected := false
	if mode == endpointCloseModeNone {
		if state.fatal != nil {
			fatal := state.fatal
			state.stateMu.Unlock()
			return fatal
		}
		if state.closed || state.closing || state.handle == 0 {
			state.stateMu.Unlock()
			return ErrClosed
		}
		state.closeMode = endpointCloseModeFlush
		mode = endpointCloseModeFlush
		selected = true
	}
	state.stateMu.Unlock()
	if !selected {
		return state.waitForFlushCloseResult(ctx, mode, done)
	}
	abortive := state.abortiveCloseChannel()
	state.closeOnce.Do(func() {
		defer state.publishCloseCompletion(done)
		state.flushErr, state.closeErr = state.flushThenClose(ctx, abortive)
	})
	return state.completedFlushCloseResult(mode)
}

// Close is bounded and consumes the raw pipe handle at most once. An
// ErrIOUnresolvedFatal result requires the current ServiceHost process to exit.
func (e *Endpoint) Close() error {
	if e == nil || e.state == nil {
		return nil
	}
	state := e.state
	state.signalAbortiveClose()
	state.stateMu.Lock()
	done := state.closeDoneLocked()
	mode := state.closeMode
	selected := false
	if mode == endpointCloseModeNone {
		state.closeMode = endpointCloseModeAbortive
		mode = endpointCloseModeAbortive
		selected = true
	}
	closeGrace := state.closeGrace
	if closeGrace <= 0 {
		closeGrace = endpointCloseGrace
	}
	fatal := state.fatal
	abortWaitStarted := state.abortWaitStarted
	abortWaitDone := state.abortWaitDoneLocked()
	state.stateMu.Unlock()
	if selected {
		state.closeOnce.Do(func() {
			defer state.publishCloseCompletion(done)
			if fatal != nil {
				state.closeErr = fatal
				return
			}
			state.closeErr = state.close()
		})
		return state.completedCloseResult()
	}
	if abortWaitStarted {
		<-abortWaitDone
		return state.abortiveWaitResult()
	}
	if fatal != nil {
		return fatal
	}
	if mode == endpointCloseModeFlush {
		timer := time.NewTimer(closeGrace)
		defer timer.Stop()
		select {
		case <-done:
			return state.completedCloseResult()
		case <-timer.C:
			select {
			case <-done:
				return state.completedCloseResult()
			default:
			}
			return state.finalizeAbortiveWaitTimeout()
		}
	}
	<-done
	return state.completedCloseResult()
}

func (state *endpointState) closeDoneLocked() chan struct{} {
	if state.closeDone == nil {
		state.closeDone = make(chan struct{})
	}
	return state.closeDone
}

func (state *endpointState) publishCloseCompletion(done chan struct{}) {
	state.stateMu.Lock()
	if state.closeCompleted {
		state.stateMu.Unlock()
		return
	}
	if !state.abortWaitStarted {
		state.closeCompleted = true
		state.activeFlush = nil
		close(done)
		state.stateMu.Unlock()
		return
	}
	abortDone := state.abortWaitDoneLocked()
	state.stateMu.Unlock()

	<-abortDone
	state.stateMu.Lock()
	if !state.closeCompleted {
		state.closeCompleted = true
		state.activeFlush = nil
		close(done)
	}
	state.stateMu.Unlock()
}

func (state *endpointState) abortWaitDoneLocked() chan struct{} {
	if state.abortWaitDone == nil {
		state.abortWaitDone = make(chan struct{})
	}
	return state.abortWaitDone
}

func (state *endpointState) finalizeAbortiveWaitTimeout() error {
	cause := errors.Join(
		ErrCloseTimeout,
		errors.New("abortive close did not interrupt graceful named-pipe close"),
	)
	state.stateMu.Lock()
	if state.closeCompleted {
		state.stateMu.Unlock()
		return state.completedCloseResult()
	}
	owner := state.activeFlush
	closeDone := state.closeDoneLocked()
	state.stateMu.Unlock()
	if owner == nil {
		return state.finalizeStateAbortiveWait(cause)
	}
	canceled, completed, fatal := state.quarantineOrDefault().cancelOrRetainFlush(owner, cause)
	if completed || canceled {
		if canceled && owner.finish != nil {
			owner.finish()
		}
		<-closeDone
		return state.completedCloseResult()
	}
	if fatal == nil {
		fatal = state.quarantineCloseState(owner, cause)
	} else {
		state.markFatal(fatal)
	}
	return state.publishAbortiveWaitResult(fatal)
}

func (state *endpointState) completedAbortiveWaitResult() (error, bool) {
	state.stateMu.Lock()
	started := state.abortWaitStarted
	done := state.abortWaitDoneLocked()
	state.stateMu.Unlock()
	if !started {
		return nil, false
	}
	<-done
	return state.abortiveWaitResult(), true
}

func (state *endpointState) abortiveWaitResult() error {
	state.stateMu.Lock()
	defer state.stateMu.Unlock()
	return state.abortWaitErr
}

func (state *endpointState) completedCloseResult() error {
	if abortiveErr, exists := state.completedAbortiveWaitResult(); exists {
		return abortiveErr
	}
	return state.closeErr
}

func (state *endpointState) publishAbortiveWaitResult(result error) error {
	state.stateMu.Lock()
	if state.closeCompleted {
		state.stateMu.Unlock()
		return state.completedCloseResult()
	}
	if state.abortWaitStarted {
		done := state.abortWaitDoneLocked()
		state.stateMu.Unlock()
		<-done
		return state.abortiveWaitResult()
	}
	state.abortWaitStarted = true
	done := state.abortWaitDoneLocked()
	state.abortWaitErr = result
	close(done)
	state.stateMu.Unlock()
	return result
}

func (state *endpointState) finalizeStateAbortiveWait(cause error) error {
	state.stateMu.Lock()
	if state.closeCompleted {
		state.stateMu.Unlock()
		return state.completedCloseResult()
	}
	if state.abortWaitStarted {
		done := state.abortWaitDoneLocked()
		state.stateMu.Unlock()
		<-done
		return state.abortiveWaitResult()
	}
	state.abortWaitStarted = true
	done := state.abortWaitDoneLocked()
	state.stateMu.Unlock()
	retained := state.quarantineOwner(state, cause)
	result := errors.Join(state.markFatal(retained), retained)
	state.stateMu.Lock()
	state.abortWaitErr = result
	close(done)
	state.stateMu.Unlock()
	return result
}

func (state *endpointState) waitForFlushCloseResult(
	ctx context.Context,
	mode endpointCloseMode,
	done <-chan struct{},
) error {
	select {
	case <-done:
		return state.completedFlushCloseResult(mode)
	default:
	}
	if ctx == nil {
		return ErrFlushDeadline
	}
	if _, ok := ctx.Deadline(); !ok {
		return ErrFlushDeadline
	}
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	select {
	case <-done:
		return state.completedFlushCloseResult(mode)
	case <-ctx.Done():
		select {
		case <-done:
			return state.completedFlushCloseResult(mode)
		default:
		}
		return context.Cause(ctx)
	}
}

func (state *endpointState) flushCloseResult(mode endpointCloseMode) error {
	if mode != endpointCloseModeFlush {
		return errors.Join(ErrFlushInterrupted, state.closeErr)
	}
	return errors.Join(state.flushErr, state.closeErr)
}

func (state *endpointState) completedFlushCloseResult(mode endpointCloseMode) error {
	result := state.flushCloseResult(mode)
	if abortiveErr, exists := state.completedAbortiveWaitResult(); exists {
		return errors.Join(result, abortiveErr)
	}
	return result
}

func (state *endpointState) close() error {
	snapshot, done, err := state.beginClose()
	if done || err != nil {
		return err
	}
	if !state.active.wait(snapshot.closeGrace) {
		cause := errors.Join(ErrCloseTimeout, errors.New("active named-pipe operation did not reach terminal completion"))
		return state.quarantineCloseState(state, cause)
	}
	return state.consumeAfterDrain(snapshot)
}

func (state *endpointState) flushThenClose(
	ctx context.Context,
	abortive <-chan struct{},
) (error, error) {
	snapshot, done, err := state.beginClose()
	if done || err != nil {
		return nil, err
	}
	if waitErr := state.active.waitContext(ctx, abortive); waitErr != nil {
		if errors.Is(waitErr, ErrFlushInterrupted) {
			if state.active.wait(snapshot.closeGrace) {
				return waitErr, state.consumeAfterDrain(snapshot)
			}
			cause := errors.Join(
				ErrCloseTimeout,
				waitErr,
				errors.New("active named-pipe operation did not stop after abortive close"),
			)
			return waitErr, state.finalizeStateAbortiveWait(cause)
		}
		if state.active.idle() {
			return waitErr, state.consumeAfterDrain(snapshot)
		}
		cause := errors.Join(waitErr, errors.New("active named-pipe operation outlived the graceful-close deadline"))
		if errors.Is(waitErr, context.DeadlineExceeded) {
			cause = errors.Join(ErrCloseTimeout, cause)
		}
		return waitErr, state.finalizeStateAbortiveWait(cause)
	}
	if cause := context.Cause(ctx); cause != nil {
		return cause, state.consumeAfterDrain(snapshot)
	}
	if snapshot.terminal != nil {
		return snapshot.terminal, state.consumeAfterDrain(snapshot)
	}
	select {
	case <-abortive:
		return ErrFlushInterrupted, state.consumeAfterDrain(snapshot)
	default:
	}
	flushErr, fatalErr := state.flushServer(ctx, abortive, snapshot.handle)
	if fatalErr != nil {
		return flushErr, fatalErr
	}
	return flushErr, state.consumeAfterDrain(snapshot)
}

func (state *endpointState) beginClose() (endpointCloseSnapshot, bool, error) {
	state.stateMu.Lock()
	defer state.stateMu.Unlock()
	if state.fatal != nil {
		return endpointCloseSnapshot{}, true, state.fatal
	}
	if state.handle == 0 {
		state.closed = true
		state.closing = true
		state.connected = false
		return endpointCloseSnapshot{}, true, nil
	}
	state.closed = true
	state.closing = true
	state.connected = false
	handle := state.handle
	server := state.server
	closeGrace := state.closeGrace
	if closeGrace <= 0 {
		closeGrace = endpointCloseGrace
	}
	return endpointCloseSnapshot{
		handle:     handle,
		server:     server,
		closeGrace: closeGrace,
		terminal:   state.terminal,
	}, false, nil
}

func (state *endpointState) consumeAfterDrain(snapshot endpointCloseSnapshot) error {
	handle := snapshot.handle
	state.stateMu.Lock()
	if state.fatal != nil || state.quarantined {
		fatal := errors.Join(state.fatal, ErrIOUnresolvedFatal)
		state.stateMu.Unlock()
		return fatal
	}
	if state.handle != handle {
		state.stateMu.Unlock()
		cause := errors.New("named-pipe handle ownership changed during close")
		return errors.Join(state.markFatal(cause), state.quarantineOwner(state, cause))
	}
	if len(state.operations) != 0 {
		state.stateMu.Unlock()
		cause := errors.New("named-pipe operations remained registered after drain")
		return errors.Join(state.markFatal(cause), state.quarantineOwner(state, cause))
	}
	state.stateMu.Unlock()

	quarantine := state.quarantineOrDefault()
	releaseNative, gateErr := quarantine.beginNativeUse()
	if gateErr != nil {
		return errors.Join(state.markFatal(gateErr), quarantine.retain(state, gateErr))
	}
	var disconnectErr error
	if snapshot.server {
		disconnect := state.disconnect
		if disconnect == nil {
			disconnect = windows.DisconnectNamedPipe
		}
		disconnectErr = disconnect(handle)
		if errors.Is(disconnectErr, windows.ERROR_PIPE_NOT_CONNECTED) ||
			errors.Is(disconnectErr, windows.ERROR_NO_DATA) {
			disconnectErr = nil
		}
		if errors.Is(disconnectErr, windows.ERROR_INVALID_HANDLE) {
			state.stateMu.Lock()
			if state.handle == handle {
				state.handle = 0
			}
			state.stateMu.Unlock()
			releaseNative()
			fatal := quarantine.retain(
				&endpointRawHandleOwner{kind: "named-pipe endpoint handle", value: handle},
				disconnectErr,
			)
			return state.markFatal(fatal)
		}
	}

	closeHandle := state.closeHandle
	if closeHandle == nil {
		closeHandle = windows.CloseHandle
	}
	state.stateMu.Lock()
	if state.handle == handle {
		state.handle = 0
	}
	state.stateMu.Unlock()
	closeErr := closeHandle(handle)
	releaseNative()
	if closeErr != nil {
		fatal := quarantine.retain(
			&endpointRawHandleOwner{kind: "close named-pipe endpoint handle", value: handle},
			fmt.Errorf("close named-pipe endpoint handle: %w", closeErr),
		)
		return errors.Join(disconnectErr, state.markFatal(fatal))
	}
	return disconnectErr
}

func (state *endpointState) flushServer(
	ctx context.Context,
	abortive <-chan struct{},
	handle windows.Handle,
) (error, error) {
	quarantine := state.quarantineOrDefault()
	flush := state.flushBuffers
	if flush == nil {
		flush = windows.FlushFileBuffers
	}
	owner := &endpointFlushOwner{
		state:  state,
		handle: handle,
		done:   make(chan endpointFlushResult, 1),
	}
	owner.finish = state.active.begin()
	if gateErr := quarantine.registerFlush(owner); gateErr != nil {
		owner.finish()
		return nil, state.quarantineCloseState(state, gateErr)
	}
	state.stateMu.Lock()
	state.activeFlush = owner
	state.stateMu.Unlock()
	go func() {
		flushErr := quarantine.beginFlush(owner)
		nativeStarted := flushErr == nil
		admissionCanceled := errors.Is(flushErr, errEndpointFlushAdmissionCanceled)
		if flushErr == nil {
			flushErr = flush(handle)
			_ = quarantine.markFlushCompleted(owner)
		}
		owner.finish()
		owner.done <- endpointFlushResult{
			err:               flushErr,
			nativeStarted:     nativeStarted,
			admissionCanceled: admissionCanceled,
		}
		runtime.KeepAlive(owner)
	}()
	select {
	case result := <-owner.done:
		return state.finishFlush(ctx, quarantine, owner, handle, result)
	case <-ctx.Done():
		select {
		case result := <-owner.done:
			return state.finishFlush(ctx, quarantine, owner, handle, result)
		default:
		}
		cause := context.Cause(ctx)
		if errors.Is(cause, context.DeadlineExceeded) {
			cause = errors.Join(ErrCloseTimeout, cause)
		}
		return state.interruptRegisteredFlush(ctx, quarantine, owner, handle, context.Cause(ctx), cause)
	case <-abortive:
		select {
		case result := <-owner.done:
			return state.finishFlush(ctx, quarantine, owner, handle, result)
		default:
		}
		return state.interruptRegisteredFlush(ctx, quarantine, owner, handle, ErrFlushInterrupted, ErrFlushInterrupted)
	}
}

func (state *endpointState) finishFlush(
	ctx context.Context,
	quarantine *endpointLifetimeQuarantine,
	owner *endpointFlushOwner,
	handle windows.Handle,
	result endpointFlushResult,
) (error, error) {
	concurrentFatal := quarantine.completeFlush(owner)
	if !result.nativeStarted {
		if result.admissionCanceled && concurrentFatal == nil {
			if cause := context.Cause(ctx); cause != nil {
				return cause, nil
			}
			return ErrFlushInterrupted, nil
		}
		fatal := errors.Join(result.err, concurrentFatal)
		if fatal == nil {
			fatal = errors.New("named-pipe flush failed before native-use admission")
		}
		return nil, errors.Join(fatal, state.markFatal(fatal))
	}
	flushErr := result.err
	var semanticErr error
	var invalidHandleErr error
	if flushErr == nil {
		if cause := context.Cause(ctx); cause != nil {
			semanticErr = cause
		}
	} else if errors.Is(flushErr, windows.ERROR_INVALID_HANDLE) {
		state.stateMu.Lock()
		if state.handle == handle {
			state.handle = 0
		}
		state.stateMu.Unlock()
		invalidHandleErr = fmt.Errorf("flush named-pipe server before close: %w", flushErr)
		semanticErr = invalidHandleErr
	} else if errors.Is(flushErr, windows.ERROR_BROKEN_PIPE) ||
		errors.Is(flushErr, windows.ERROR_NO_DATA) ||
		errors.Is(flushErr, windows.ERROR_PIPE_NOT_CONNECTED) {
		semanticErr = errors.Join(io.ErrClosedPipe, fmt.Errorf("flush named-pipe server before close: %w", flushErr))
	} else {
		semanticErr = fmt.Errorf("flush named-pipe server before close: %w", flushErr)
	}

	if invalidHandleErr != nil {
		localFatal := state.markFatal(invalidHandleErr)
		retained := quarantine.retainFlush(owner, invalidHandleErr)
		return semanticErr, errors.Join(concurrentFatal, localFatal, retained)
	}
	if concurrentFatal != nil {
		state.markFatal(concurrentFatal)
		return semanticErr, concurrentFatal
	}
	return semanticErr, nil
}

func (state *endpointState) interruptRegisteredFlush(
	ctx context.Context,
	quarantine *endpointLifetimeQuarantine,
	owner *endpointFlushOwner,
	handle windows.Handle,
	semanticCause error,
	retentionCause error,
) (error, error) {
	canceled, completed, fatal := quarantine.cancelOrRetainFlush(owner, retentionCause)
	if completed {
		result := <-owner.done
		return state.finishFlush(ctx, quarantine, owner, handle, result)
	}
	if fatal != nil {
		state.markFatal(fatal)
		return semanticCause, state.publishAbortiveWaitResult(fatal)
	}
	if !canceled {
		cause := errors.New("named-pipe flush interruption lost its registered owner")
		return semanticCause, state.quarantineCloseState(owner, cause)
	}
	if owner.finish == nil {
		cause := errors.New("canceled named-pipe flush has no activity owner")
		return semanticCause, state.quarantineCloseState(owner, cause)
	}
	owner.finish()
	return semanticCause, nil
}

func (state *endpointState) quarantineCloseState(owner any, cause error) error {
	fatal := state.markFatal(cause)
	return errors.Join(fatal, state.quarantineOwner(owner, cause))
}

func (state *endpointState) abortiveCloseChannel() chan struct{} {
	state.stateMu.Lock()
	defer state.stateMu.Unlock()
	if state.abortiveClose == nil {
		state.abortiveClose = make(chan struct{})
	}
	return state.abortiveClose
}

func (state *endpointState) signalAbortiveClose() {
	abortive := state.abortiveCloseChannel()
	state.abortiveOnce.Do(func() { close(abortive) })
}

// Attestation returns an immutable value snapshot of this concrete endpoint's
// validated construction metadata. The snapshot proves that connection setup
// completed and the local endpoint was live at this method's linearization
// point; it does not prove that the remote process remains live afterward.
func (e *Endpoint) Attestation() (EndpointAttestation, error) {
	if e == nil || e.state == nil {
		return EndpointAttestation{}, ErrClosed
	}
	state := e.state
	state.stateMu.Lock()
	releaseNative, gateErr := state.quarantineOrDefault().beginNativeUse()
	if gateErr != nil {
		state.markFatalLocked(gateErr)
		state.stateMu.Unlock()
		return EndpointAttestation{}, gateErr
	}
	defer func() {
		releaseNative()
		state.stateMu.Unlock()
	}()
	if err := state.stateErrorLocked(); err != nil {
		return EndpointAttestation{}, err
	}
	if !state.connected {
		return EndpointAttestation{}, errors.Join(ErrClosed, errors.New("named-pipe connection establishment is incomplete"))
	}

	side := EndpointSideClient
	if state.server {
		side = EndpointSideServer
	}
	attestation := sealEndpointAttestation(EndpointAttestation{
		pipeName:               state.pipeName,
		maximumFrameBytes:      state.maximumFrameBytes,
		localSide:              side,
		connected:              state.connected,
		ownServiceSID:          state.ownServiceSID,
		peerServiceSID:         state.peerServiceSID,
		serverSecurityVerified: state.serverSecurityVerified,
	})
	if !attestation.Valid() {
		return EndpointAttestation{}, errors.New("named-pipe endpoint attestation metadata is incomplete")
	}
	return attestation, nil
}

// LocalSide returns the locally owned end of this live concrete endpoint.
func (e *Endpoint) LocalSide() (EndpointSide, error) {
	state, err := e.currentState()
	if err != nil {
		return EndpointSideUnknown, err
	}
	state.stateMu.Lock()
	defer state.stateMu.Unlock()
	if err := state.stateErrorLocked(); err != nil {
		return EndpointSideUnknown, err
	}
	if state.server {
		return EndpointSideServer, nil
	}
	return EndpointSideClient, nil
}

// GetNamedPipeClientProcessID returns one kernel observation. It must be
// repeated around independent process-handle acquisition by the peer verifier.
func (e *Endpoint) GetNamedPipeClientProcessID() (uint32, error) {
	return e.observeProcessID("client", windows.GetNamedPipeClientProcessId)
}

// GetNamedPipeServerProcessID returns one kernel observation. It must be
// repeated around independent process-handle acquisition by the peer verifier.
func (e *Endpoint) GetNamedPipeServerProcessID() (uint32, error) {
	return e.observeProcessID("server", windows.GetNamedPipeServerProcessId)
}

func (e *Endpoint) observeProcessID(
	name string,
	observe func(windows.Handle, *uint32) error,
) (uint32, error) {
	state, stateErr := e.currentState()
	if stateErr != nil {
		return 0, stateErr
	}
	state.stateMu.Lock()
	if err := state.stateErrorLocked(); err != nil {
		state.stateMu.Unlock()
		return 0, err
	}
	releaseNative, gateErr := state.quarantineOrDefault().beginNativeUse()
	if gateErr != nil {
		state.markFatalLocked(gateErr)
		state.stateMu.Unlock()
		return 0, gateErr
	}
	finish := state.active.begin()
	handle := state.handle
	defer finish()

	var processID uint32
	err := observe(handle, &processID)
	if errors.Is(err, windows.ERROR_INVALID_HANDLE) {
		if state.handle == handle {
			state.handle = 0
		}
		state.markFatalLocked(err)
	}
	releaseNative()
	state.stateMu.Unlock()
	if err != nil {
		if errors.Is(err, windows.ERROR_INVALID_HANDLE) {
			fatal := state.quarantineOwner(
				&endpointRawHandleOwner{kind: "invalid named-pipe endpoint handle", value: handle},
				err,
			)
			return 0, errors.Join(fmt.Errorf("observe named-pipe %s process ID: %w", name, err), fatal)
		}
		return 0, fmt.Errorf("observe named-pipe %s process ID: %w", name, err)
	}
	if processID == 0 {
		return 0, fmt.Errorf("observe named-pipe %s process ID: Windows returned zero", name)
	}
	return processID, nil
}

var _ ProcessIDObserver = (*Endpoint)(nil)
