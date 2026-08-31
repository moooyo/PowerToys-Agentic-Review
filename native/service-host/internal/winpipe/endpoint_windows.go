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

// Endpoint is a connected named-pipe endpoint. Copies share one private state
// and therefore one raw handle owner, operation set, and close result.
type Endpoint struct {
	state *endpointState
}

type endpointState struct {
	handle            windows.Handle
	maximumFrameBytes uint32
	server            bool

	stateMu   sync.Mutex
	closed    bool
	terminal  error
	active    sync.WaitGroup
	closeOnce sync.Once
	closeErr  error

	readGate  chan struct{}
	writeGate chan struct{}

	cancelIO    func(windows.Handle, *windows.Overlapped) error
	disconnect  func(windows.Handle) error
	closeHandle func(windows.Handle) error
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

	sddl, err := validateServerOptions(options)
	if err != nil {
		return nil, err
	}
	peerSID, err := windows.StringToSid(options.PeerServiceSID)
	if err != nil || peerSID == nil || !peerSID.IsValid() || peerSID.String() != options.PeerServiceSID {
		return nil, invalidOptions("peer SID is not accepted by Windows as a canonical SID")
	}

	securityDescriptor, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return nil, fmt.Errorf("create named-pipe security descriptor: %w", err)
	}
	if err := validateSecurityDescriptor(securityDescriptor); err != nil {
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
	runtime.KeepAlive(securityDescriptor)
	runtime.KeepAlive(peerSID)
	if err != nil {
		return nil, fmt.Errorf("create named-pipe server: %w", err)
	}

	endpoint := newEndpoint(handle, options.MaximumFrameBytes, true)
	if err := endpoint.connect(ctx); err != nil {
		closeErr := endpoint.Close()
		return nil, errors.Join(err, closeErr)
	}
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
	name, err := windows.UTF16PtrFromString(options.PipeName)
	if err != nil {
		return nil, invalidOptions("pipe name is not valid UTF-16")
	}

	for {
		if cause := context.Cause(ctx); cause != nil {
			return nil, cause
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
		if openErr == nil {
			readMode := pipeReadModeMessage | pipeWait
			if stateErr := windows.SetNamedPipeHandleState(handle, &readMode, nil, nil); stateErr != nil {
				closeErr := windows.CloseHandle(handle)
				return nil, errors.Join(
					fmt.Errorf("set named-pipe client message mode: %w", stateErr),
					closeErr,
				)
			}
			if cause := context.Cause(ctx); cause != nil {
				return nil, errors.Join(cause, windows.CloseHandle(handle))
			}
			return newEndpoint(handle, options.MaximumFrameBytes, false), nil
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

func newEndpoint(handle windows.Handle, maximumFrameBytes uint32, server bool) *Endpoint {
	state := &endpointState{
		handle:            handle,
		maximumFrameBytes: maximumFrameBytes,
		server:            server,
		readGate:          make(chan struct{}, 1),
		writeGate:         make(chan struct{}, 1),
	}
	state.readGate <- struct{}{}
	state.writeGate <- struct{}{}
	return &Endpoint{state: state}
}

func (e *Endpoint) currentState() (*endpointState, error) {
	if e == nil || e.state == nil {
		return nil, ErrClosed
	}
	return e.state, nil
}

func validateSecurityDescriptor(descriptor *windows.SECURITY_DESCRIPTOR) error {
	if descriptor == nil || !descriptor.IsValid() {
		return errors.New("named-pipe security descriptor is missing or invalid")
	}
	control, _, err := descriptor.Control()
	if err != nil {
		return fmt.Errorf("read named-pipe security descriptor control: %w", err)
	}
	required := windows.SECURITY_DESCRIPTOR_CONTROL(
		windows.SE_DACL_PRESENT | windows.SE_DACL_PROTECTED | windows.SE_SELF_RELATIVE,
	)
	if control&required != required {
		return errors.New("named-pipe security descriptor lacks a protected DACL")
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		return fmt.Errorf("read named-pipe security descriptor DACL: %w", err)
	}
	if dacl == nil {
		return errors.New("named-pipe security descriptor has a null DACL")
	}
	return nil
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
	_, err := e.performOverlapped(ctx, func(handle windows.Handle, overlapped *windows.Overlapped, _ *uint32) error {
		return windows.ConnectNamedPipe(handle, overlapped)
	})
	if errors.Is(err, windows.ERROR_PIPE_CONNECTED) {
		return nil
	}
	if err != nil {
		err = e.normalizeOperationError(err, false)
		wrapped := fmt.Errorf("connect named-pipe server: %w", err)
		e.markFailed(wrapped)
		return wrapped
	}
	return nil
}

func (e *Endpoint) ReadFrame(ctx context.Context) ([]byte, error) {
	state, stateErr := e.currentState()
	if stateErr != nil {
		return nil, ErrClosed
	}
	if ctx == nil {
		return nil, errors.New("named-pipe read context is required")
	}
	if err := acquire(ctx, state.readGate); err != nil {
		return nil, err
	}
	defer release(state.readGate)

	buffer := make([]byte, int(state.maximumFrameBytes))
	transferred, err := e.performOverlapped(ctx, func(handle windows.Handle, overlapped *windows.Overlapped, done *uint32) error {
		return windows.ReadFile(handle, buffer, done, overlapped)
	})
	runtime.KeepAlive(buffer)
	if errors.Is(err, windows.ERROR_MORE_DATA) {
		wrapped := fmt.Errorf("read named-pipe frame: %w", framing.ErrFrameTooLarge)
		e.markFailed(wrapped)
		return nil, wrapped
	}
	if err != nil {
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

func (e *Endpoint) WriteFrame(ctx context.Context, value []byte) error {
	state, stateErr := e.currentState()
	if stateErr != nil {
		return ErrClosed
	}
	if ctx == nil {
		return errors.New("named-pipe write context is required")
	}
	if err := acquire(ctx, state.writeGate); err != nil {
		return err
	}
	defer release(state.writeGate)

	if _, err := framing.ValidateFrame(value, state.maximumFrameBytes); err != nil {
		wrapped := fmt.Errorf("validate named-pipe frame: %w", err)
		e.markFailed(wrapped)
		return wrapped
	}
	transferred, err := e.performOverlapped(ctx, func(handle windows.Handle, overlapped *windows.Overlapped, done *uint32) error {
		return windows.WriteFile(handle, value, done, overlapped)
	})
	runtime.KeepAlive(value)
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

func (e *Endpoint) performOverlapped(
	ctx context.Context,
	start func(windows.Handle, *windows.Overlapped, *uint32) error,
) (uint32, error) {
	state, stateErr := e.currentState()
	if stateErr != nil {
		return 0, stateErr
	}
	if cause := context.Cause(ctx); cause != nil {
		return 0, cause
	}
	event, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		return 0, fmt.Errorf("create overlapped event: %w", err)
	}
	defer windows.CloseHandle(event)

	overlapped := windows.Overlapped{HEvent: event}
	var transferred uint32
	state.stateMu.Lock()
	if stateErr := state.stateErrorLocked(); stateErr != nil {
		state.stateMu.Unlock()
		return 0, stateErr
	}
	if cause := context.Cause(ctx); cause != nil {
		state.stateMu.Unlock()
		return 0, cause
	}
	state.active.Add(1)
	handle := state.handle
	startErr := start(handle, &overlapped, &transferred)
	state.stateMu.Unlock()
	defer state.active.Done()

	if startErr == nil || !errors.Is(startErr, windows.ERROR_IO_PENDING) {
		return transferred, startErr
	}
	for {
		if cause := context.Cause(ctx); cause != nil {
			cleanupErr := cancelAndComplete(handle, &overlapped, &transferred)
			if cleanupErr != nil {
				return transferred, errors.Join(cause, cleanupErr)
			}
			return transferred, cause
		}

		waitResult, waitErr := windows.WaitForSingleObject(event, overlappedPollMilliseconds)
		if waitErr != nil {
			cleanupErr := cancelAndComplete(handle, &overlapped, &transferred)
			return transferred, errors.Join(fmt.Errorf("wait for overlapped I/O: %w", waitErr), cleanupErr)
		}
		switch waitResult {
		case windows.WAIT_OBJECT_0:
			return transferred, windows.GetOverlappedResult(handle, &overlapped, &transferred, false)
		case uint32(windows.WAIT_TIMEOUT):
			continue
		default:
			cleanupErr := cancelAndComplete(handle, &overlapped, &transferred)
			return transferred, errors.Join(
				fmt.Errorf("wait for overlapped I/O returned status %#x", waitResult),
				cleanupErr,
			)
		}
	}
}

func cancelAndComplete(handle windows.Handle, overlapped *windows.Overlapped, transferred *uint32) error {
	cancelErr := windows.CancelIoEx(handle, overlapped)
	if errors.Is(cancelErr, windows.ERROR_NOT_FOUND) {
		cancelErr = nil
	}
	completionErr := windows.GetOverlappedResult(handle, overlapped, transferred, true)
	if errors.Is(completionErr, windows.ERROR_OPERATION_ABORTED) {
		completionErr = nil
	}
	return errors.Join(cancelErr, completionErr)
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
	if state.closed || state.terminal != nil {
		return
	}
	state.terminal = cause
	if err := windows.CancelIoEx(state.handle, nil); err != nil && !errors.Is(err, windows.ERROR_NOT_FOUND) {
		state.terminal = errors.Join(state.terminal, fmt.Errorf("cancel named-pipe I/O after failure: %w", err))
	}
}

func (e *Endpoint) normalizeOperationError(err error, reading bool) error {
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
	if state.closed {
		return ErrClosed
	}
	return state.terminal
}

func (e *Endpoint) Close() error {
	if e == nil {
		return nil
	}
	state, stateErr := e.currentState()
	if stateErr != nil {
		return stateErr
	}
	state.closeOnce.Do(func() {
		state.stateMu.Lock()
		state.closed = true
		handle := state.handle
		cancelIO := state.cancelIO
		if cancelIO == nil {
			cancelIO = windows.CancelIoEx
		}
		cancelErr := cancelIO(handle, nil)
		if errors.Is(cancelErr, windows.ERROR_NOT_FOUND) {
			cancelErr = nil
		}
		state.stateMu.Unlock()

		state.active.Wait()
		var disconnectErr error
		if state.server {
			disconnect := state.disconnect
			if disconnect == nil {
				disconnect = windows.DisconnectNamedPipe
			}
			disconnectErr = disconnect(handle)
			if errors.Is(disconnectErr, windows.ERROR_PIPE_NOT_CONNECTED) ||
				errors.Is(disconnectErr, windows.ERROR_NO_DATA) {
				disconnectErr = nil
			}
		}
		closeHandle := state.closeHandle
		if closeHandle == nil {
			closeHandle = windows.CloseHandle
		}
		closeErr := closeHandle(handle)
		state.stateMu.Lock()
		if closeErr == nil {
			state.handle = 0
		}
		state.closeErr = errors.Join(cancelErr, disconnectErr, closeErr)
		state.stateMu.Unlock()
	})
	return state.closeErr
}

// LocalSide returns the locally owned end of this live concrete endpoint.
func (e *Endpoint) LocalSide() (EndpointSide, error) {
	state, err := e.currentState()
	if err != nil {
		return EndpointSideUnknown, err
	}
	state.stateMu.Lock()
	defer state.stateMu.Unlock()
	if state.handle == 0 {
		return EndpointSideUnknown, ErrClosed
	}
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
	state.active.Add(1)
	handle := state.handle
	state.stateMu.Unlock()
	defer state.active.Done()

	var processID uint32
	if err := observe(handle, &processID); err != nil {
		return 0, fmt.Errorf("observe named-pipe %s process ID: %w", name, err)
	}
	if processID == 0 {
		return 0, fmt.Errorf("observe named-pipe %s process ID: Windows returned zero", name)
	}
	return processID, nil
}

var _ ProcessIDObserver = (*Endpoint)(nil)
