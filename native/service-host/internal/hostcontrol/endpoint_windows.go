//go:build windows

package hostcontrol

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"runtime"
	"sync"
	"time"
	"unsafe"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/launchguard"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winprocess"
	"golang.org/x/sys/windows"
)

const (
	pipeAccessDuplex          uint32 = 0x00000003
	fileFlagFirstPipeInstance uint32 = 0x00080000
	fileFlagOverlapped        uint32 = 0x40000000
	pipeRejectRemoteClients   uint32 = 0x00000008
	maximumServerInstances    uint32 = 1
	operationPollInterval            = 25 * time.Millisecond
)

const (
	serverOpenMode = pipeAccessDuplex |
		fileFlagFirstPipeInstance |
		fileFlagOverlapped |
		readControl
	serverPipeMode = pipeRejectRemoteClients
)

// Listener owns one already-created Named Pipe server handle and its pending
// overlapped ConnectNamedPipe operation. Accept is single-use.
type Listener struct {
	mu      sync.Mutex
	closeMu sync.Mutex
	active  activityGroup

	handle     windows.Handle
	event      windows.Handle
	overlapped windows.Overlapped
	pipeName   string
	options    Options
	deadline   time.Time

	pending   bool
	connected bool
	accepting bool
	consumed  bool
	closing   bool
	terminal  error
}

// Connection is the exclusive byte stream accepted for one retained Node
// process. It permits one active reader and one active writer. Accidental value
// copies share its private handle-owner state, so Close remains single-owner;
// RuntimeBootstrap authority stays bound to the exact returned pointer.
type Connection struct {
	state *connectionState
}

type connectionState struct {
	mu      sync.Mutex
	closeMu sync.Mutex
	active  activityGroup

	handle    windows.Handle
	options   Options
	evidence  VerificationEvidence
	bootstrap localrpc.CommittedRuntimeBootstrap
	closing   bool
	terminal  error

	readGate  chan struct{}
	writeGate chan struct{}

	cancelIO    func(windows.Handle) error
	disconnect  func(windows.Handle) error
	closeHandle func(windows.Handle) error
}

// Prepare creates the only pipe instance and starts ConnectNamedPipe before
// the caller launches Node.
func Prepare(options Options) (*Listener, error) {
	if err := validateOptions(options); err != nil {
		return nil, err
	}
	pipeName, err := generatePipeName(rand.Reader)
	if err != nil {
		return nil, err
	}
	return prepareWindowsListener(options, pipeName)
}

func prepareWindowsListener(options Options, pipeName string) (_ *Listener, resultErr error) {
	sddl := securityDescriptorString(options.OwnServiceSID)
	securityDescriptor, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return nil, fmt.Errorf("create HostControl security descriptor: %w", err)
	}
	if err := validateWindowsSecurityDescriptor(securityDescriptor, options.OwnServiceSID); err != nil {
		return nil, err
	}
	securityAttributes := &windows.SecurityAttributes{
		Length:             uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		SecurityDescriptor: securityDescriptor,
		InheritHandle:      0,
	}
	name, err := windows.UTF16PtrFromString(pipeName)
	if err != nil {
		return nil, fmt.Errorf("encode HostControl pipe name: %w", err)
	}

	handle, err := windows.CreateNamedPipe(
		name,
		serverOpenMode,
		serverPipeMode,
		maximumServerInstances,
		pipeBufferBytes,
		pipeBufferBytes,
		0,
		securityAttributes,
	)
	runtime.KeepAlive(securityDescriptor)
	if err != nil {
		return nil, fmt.Errorf("create HostControl named-pipe server: %w", err)
	}
	keepHandle := false
	defer func() {
		if !keepHandle {
			resultErr = errors.Join(resultErr, closeRejectedHandle("close rejected HostControl pipe", handle))
		}
	}()

	evidence, err := readWindowsDACL(handle)
	if err != nil {
		return nil, fmt.Errorf("read back HostControl pipe DACL: %w", err)
	}
	if err := validateDACL(evidence, options.OwnServiceSID); err != nil {
		return nil, fmt.Errorf("validate HostControl pipe DACL: %w", err)
	}

	event, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		return nil, fmt.Errorf("create HostControl connect event: %w", err)
	}
	keepEvent := false
	defer func() {
		if !keepEvent {
			resultErr = errors.Join(resultErr, closeRejectedHandle("close rejected HostControl connect event", event))
		}
	}()

	listener := &Listener{
		handle:   handle,
		event:    event,
		pipeName: pipeName,
		options:  options,
		deadline: time.Now().Add(options.ConnectTimeout),
	}
	listener.overlapped.HEvent = event
	connectErr := windows.ConnectNamedPipe(handle, &listener.overlapped)
	switch {
	case connectErr == nil:
		listener.connected = true
	case errors.Is(connectErr, windows.ERROR_IO_PENDING):
		listener.pending = true
	case errors.Is(connectErr, windows.ERROR_PIPE_CONNECTED):
		listener.connected = true
	default:
		return nil, fmt.Errorf("start HostControl ConnectNamedPipe before Node launch: %w", connectErr)
	}

	keepHandle = true
	keepEvent = true
	return listener, nil
}

// PipeName returns public rendezvous metadata for the fixed Node launch
// argument. Knowledge of this value never authenticates a client.
func (l *Listener) PipeName() string {
	if l == nil {
		return ""
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.pipeName
}

// Accept claims the guarded Node's launch-bound bootstrap before observing the
// connection, verifies the retained Node, completes the RuntimeBootstrapV1
// exchange, and raises the root Job process limit. Failures before pipe-handle
// transfer return a nil Connection. After transfer, Accept terminates Node and
// tries to close the Connection; if that close fails, it returns the still-owning
// Connection with the joined primary and cleanup errors.
func (l *Listener) Accept(
	ctx context.Context,
	node *launchguard.GuardedNodeProcess,
) (*Connection, error) {
	if ctx == nil {
		return nil, errors.New("HostControl accept context is required")
	}
	if node == nil {
		return nil, errors.New("guarded Node process is required")
	}
	if cause := context.Cause(ctx); cause != nil {
		return nil, cause
	}
	finish, err := l.beginAccept()
	if err != nil {
		return nil, err
	}
	claimedNode, bootstrap, err := launchguard.ClaimHostControlLaunch(node)
	if err != nil {
		finish()
		claimErr := fmt.Errorf("claim guarded Node HostControl launch binding: %w", err)
		return rejectAcceptFailure(nil, claimErr, node, func() {
			l.markTerminal(claimErr)
		}, l.Close)
	}

	connection, err := l.acceptConnected(ctx, claimedNode)
	finish()
	if err != nil {
		return rejectAcceptFailure(nil, err, claimedNode, func() {
			l.markTerminal(err)
		}, l.Close)
	}

	bootstrapContext, cancelBootstrap := context.WithDeadline(ctx, l.deadline)
	committedBootstrap, err := completeRuntimeBootstrap(
		bootstrapContext, connection, claimedNode, connection.Evidence(), bootstrap,
	)
	cancelBootstrap()
	if err != nil {
		return rejectPostTransferAcceptFailure(connection, err, claimedNode)
	}
	connection.setCommittedRuntimeBootstrap(committedBootstrap)
	return connection, nil
}

// rejectPostTransferAcceptFailure is the sole cleanup path after the listener
// has transferred its pipe handle into a Connection. It preserves the exact
// Connection owner whenever Close cannot consume that handle.
func rejectPostTransferAcceptFailure(
	connection *Connection,
	primary error,
	node interface{ Terminate() error },
) (*Connection, error) {
	if connection == nil || connection.state == nil {
		return rejectAcceptFailure(nil, errors.Join(primary, ErrClosed), node, func() {}, func() error {
			return ErrClosed
		})
	}
	return rejectAcceptFailure(connection, primary, node, func() {
		connection.markTerminal(primary)
	}, connection.Close)
}

func (l *Listener) beginAccept() (func(), error) {
	if l == nil {
		return nil, ErrClosed
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.handle == 0 || l.closing {
		return nil, ErrClosed
	}
	if l.terminal != nil {
		return nil, l.terminal
	}
	if l.accepting || l.consumed {
		return nil, ErrAlreadyAccepted
	}
	l.accepting = true
	return l.active.begin(), nil
}

func (l *Listener) acceptConnected(ctx context.Context, node winprocess.NodeProcess) (*Connection, error) {
	if err := l.waitForConnect(ctx); err != nil {
		return nil, err
	}
	evidence, err := verifyConnectedNode(l.pipeName, listenerPIDObserver{listener: l}, node)
	if err != nil {
		return nil, err
	}

	l.mu.Lock()
	if l.closing || l.handle == 0 {
		l.mu.Unlock()
		return nil, ErrClosed
	}
	if l.terminal != nil {
		err := l.terminal
		l.mu.Unlock()
		return nil, err
	}
	event := l.event
	l.mu.Unlock()
	if event != 0 {
		if err := windows.CloseHandle(event); err != nil {
			return nil, fmt.Errorf("close completed HostControl connect event: %w", err)
		}
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closing || l.handle == 0 {
		if l.event == event {
			l.event = 0
		}
		return nil, ErrClosed
	}
	if l.terminal != nil {
		if l.event == event {
			l.event = 0
		}
		return nil, l.terminal
	}
	if l.event == event {
		l.event = 0
	}
	handle := l.handle
	l.handle = 0
	l.pending = false
	l.connected = false
	l.consumed = true
	return newConnection(handle, l.options, evidence), nil
}

func (l *Listener) waitForConnect(ctx context.Context) error {
	for {
		l.mu.Lock()
		if l.closing || l.handle == 0 {
			l.mu.Unlock()
			return ErrClosed
		}
		if l.terminal != nil {
			err := l.terminal
			l.mu.Unlock()
			return err
		}
		if l.connected {
			l.mu.Unlock()
			return nil
		}
		handle := l.handle
		event := l.event
		overlapped := &l.overlapped
		deadline := l.deadline
		l.mu.Unlock()

		if cause := context.Cause(ctx); cause != nil {
			return errors.Join(cause, cancelAndComplete(handle, overlapped))
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return errors.Join(ErrConnectTimeout, cancelAndComplete(handle, overlapped))
		}
		wait := operationPollInterval
		if remaining < wait {
			wait = remaining
		}
		status, err := windows.WaitForSingleObject(event, durationMilliseconds(wait))
		if err != nil {
			return errors.Join(fmt.Errorf("wait for HostControl client: %w", err), cancelAndComplete(handle, overlapped))
		}
		switch status {
		case windows.WAIT_OBJECT_0:
			var transferred uint32
			if err := windows.GetOverlappedResult(handle, overlapped, &transferred, false); err != nil {
				return fmt.Errorf("complete HostControl ConnectNamedPipe: %w", err)
			}
			l.mu.Lock()
			l.pending = false
			l.connected = true
			l.mu.Unlock()
			return nil
		case uint32(windows.WAIT_TIMEOUT):
			continue
		default:
			return errors.Join(
				fmt.Errorf("HostControl connect wait returned status 0x%x", status),
				cancelAndComplete(handle, overlapped),
			)
		}
	}
}

func (l *Listener) markTerminal(cause error) {
	if l == nil || cause == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.terminal == nil {
		l.terminal = cause
	}
	if l.handle != 0 {
		if err := windows.CancelIoEx(l.handle, nil); err != nil && !errors.Is(err, windows.ERROR_NOT_FOUND) {
			l.terminal = errors.Join(l.terminal, fmt.Errorf("cancel HostControl listener I/O after failure: %w", err))
		}
	}
}

// Close cancels pending connect work and retains every original handle after
// a failed native close so callers can retry.
func (l *Listener) Close() error {
	if l == nil {
		return nil
	}
	l.closeMu.Lock()
	defer l.closeMu.Unlock()

	l.mu.Lock()
	if l.handle == 0 && l.event == 0 {
		l.mu.Unlock()
		return nil
	}
	l.closing = true
	handle := l.handle
	l.mu.Unlock()

	var cancelErr error
	if handle != 0 {
		cancelErr = windows.CancelIoEx(handle, nil)
		if errors.Is(cancelErr, windows.ERROR_NOT_FOUND) {
			cancelErr = nil
		}
	}
	if !l.active.wait(l.options.CloseTimeout) {
		return errors.Join(cancelErr, ErrCloseTimeout)
	}
	if cancelErr != nil {
		return fmt.Errorf("cancel HostControl listener I/O: %w", cancelErr)
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	handle = l.handle
	event := l.event
	pending := l.pending
	connected := l.connected
	if pending && handle != 0 {
		if err := cancelAndComplete(handle, &l.overlapped); err != nil {
			return fmt.Errorf("complete cancelled HostControl connect: %w", err)
		}
		l.pending = false
	}
	if event != 0 {
		if err := windows.CloseHandle(event); err != nil {
			return fmt.Errorf("close HostControl listener event: %w", err)
		}
		if l.event == event {
			l.event = 0
		}
	}
	if connected && handle != 0 {
		if err := disconnectPipe(handle); err != nil {
			return fmt.Errorf("disconnect rejected HostControl client: %w", err)
		}
		l.connected = false
	}
	if handle != 0 {
		if err := windows.CloseHandle(handle); err != nil {
			return fmt.Errorf("close HostControl listener handle: %w", err)
		}
		if l.handle == handle {
			l.handle = 0
		}
	}
	return nil
}

type listenerPIDObserver struct {
	listener *Listener
}

func (o listenerPIDObserver) ClientProcessID() (uint32, error) {
	if o.listener == nil {
		return 0, ErrClosed
	}
	o.listener.mu.Lock()
	defer o.listener.mu.Unlock()
	if o.listener.handle == 0 || o.listener.closing {
		return 0, ErrClosed
	}
	var processID uint32
	if err := windows.GetNamedPipeClientProcessId(o.listener.handle, &processID); err != nil {
		return 0, err
	}
	if processID == 0 {
		return 0, errors.New("Windows returned a zero HostControl client PID")
	}
	return processID, nil
}

func newConnection(
	handle windows.Handle,
	options Options,
	evidence VerificationEvidence,
) *Connection {
	state := &connectionState{
		handle:    handle,
		options:   options,
		evidence:  evidence,
		readGate:  make(chan struct{}, 1),
		writeGate: make(chan struct{}, 1),
		cancelIO: func(handle windows.Handle) error {
			return windows.CancelIoEx(handle, nil)
		},
		disconnect:  disconnectPipe,
		closeHandle: windows.CloseHandle,
	}
	state.readGate <- struct{}{}
	state.writeGate <- struct{}{}
	return &Connection{state: state}
}

// Evidence returns immutable detached verification observations.
func (c *Connection) Evidence() VerificationEvidence {
	if c == nil || c.state == nil {
		return VerificationEvidence{}
	}
	state := c.state
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.evidence
}

// CommittedRuntimeBootstrap returns opaque authority for this exact accepted connection.
func (c *Connection) CommittedRuntimeBootstrap() localrpc.CommittedRuntimeBootstrap {
	if c == nil || c.state == nil {
		return localrpc.CommittedRuntimeBootstrap{}
	}
	state := c.state
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.bootstrap
}

func (c *Connection) setCommittedRuntimeBootstrap(bootstrap localrpc.CommittedRuntimeBootstrap) {
	if c == nil || c.state == nil {
		return
	}
	state := c.state
	state.mu.Lock()
	defer state.mu.Unlock()
	state.bootstrap = bootstrap
}

func (c *Connection) Read(buffer []byte) (int, error) {
	if c == nil {
		return 0, ErrClosed
	}
	return c.ReadContext(context.Background(), buffer)
}

// ReadContext performs one overlapped byte-stream read.
func (c *Connection) ReadContext(ctx context.Context, buffer []byte) (int, error) {
	if c == nil || c.state == nil {
		return 0, ErrClosed
	}
	if ctx == nil {
		return 0, errors.New("HostControl read context is required")
	}
	state := c.state
	operationContext, cancel := context.WithTimeout(ctx, state.options.IOTimeout)
	defer cancel()
	if len(buffer) == 0 {
		return 0, nil
	}
	if err := acquireGate(operationContext, state.readGate); err != nil {
		return 0, normalizeContextError(err)
	}
	defer releaseGate(state.readGate)

	transferred, finish, err := c.performOverlapped(operationContext, func(
		handle windows.Handle,
		overlapped *windows.Overlapped,
		done *uint32,
	) error {
		return windows.ReadFile(handle, buffer, done, overlapped)
	})
	defer finish()
	runtime.KeepAlive(buffer)
	if err != nil {
		err = c.normalizeOperationError(err, true, transferred)
		c.markTerminal(err)
		return int(transferred), err
	}
	if transferred > uint32(len(buffer)) {
		err := errors.New("HostControl read returned an invalid byte count")
		c.markTerminal(err)
		return 0, err
	}
	return int(transferred), nil
}

func (c *Connection) Write(buffer []byte) (int, error) {
	if c == nil {
		return 0, ErrClosed
	}
	return c.WriteContext(context.Background(), buffer)
}

// WriteContext performs one overlapped byte-stream write.
func (c *Connection) WriteContext(ctx context.Context, buffer []byte) (int, error) {
	if c == nil || c.state == nil {
		return 0, ErrClosed
	}
	if ctx == nil {
		return 0, errors.New("HostControl write context is required")
	}
	state := c.state
	operationContext, cancel := context.WithTimeout(ctx, state.options.IOTimeout)
	defer cancel()
	if len(buffer) == 0 {
		return 0, nil
	}
	if err := acquireGate(operationContext, state.writeGate); err != nil {
		return 0, normalizeContextError(err)
	}
	defer releaseGate(state.writeGate)

	transferred, finish, err := c.performOverlapped(operationContext, func(
		handle windows.Handle,
		overlapped *windows.Overlapped,
		done *uint32,
	) error {
		return windows.WriteFile(handle, buffer, done, overlapped)
	})
	defer finish()
	runtime.KeepAlive(buffer)
	if err != nil {
		err = c.normalizeOperationError(err, false, transferred)
		c.markTerminal(err)
		return int(transferred), err
	}
	if transferred > uint32(len(buffer)) {
		err := errors.New("HostControl write returned an invalid byte count")
		c.markTerminal(err)
		return 0, err
	}
	return int(transferred), nil
}

func (c *Connection) performOverlapped(
	ctx context.Context,
	start func(windows.Handle, *windows.Overlapped, *uint32) error,
) (transferred uint32, finish func(), resultErr error) {
	finish = func() {}
	if c == nil || c.state == nil {
		return 0, finish, ErrClosed
	}
	state := c.state
	if cause := context.Cause(ctx); cause != nil {
		return 0, finish, cause
	}
	event, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		return 0, finish, fmt.Errorf("create HostControl I/O event: %w", err)
	}
	defer func() {
		if cleanupErr := closeRejectedHandle("close HostControl I/O event", event); cleanupErr != nil {
			resultErr = errors.Join(resultErr, cleanupErr)
		}
	}()
	overlapped := windows.Overlapped{HEvent: event}

	state.mu.Lock()
	if err := c.stateErrorLocked(); err != nil {
		state.mu.Unlock()
		return 0, finish, err
	}
	if cause := context.Cause(ctx); cause != nil {
		state.mu.Unlock()
		return 0, finish, cause
	}
	finish = state.active.begin()
	handle := state.handle
	startErr := start(handle, &overlapped, &transferred)
	state.mu.Unlock()

	if startErr == nil || !errors.Is(startErr, windows.ERROR_IO_PENDING) {
		return transferred, finish, startErr
	}
	for {
		if cause := context.Cause(ctx); cause != nil {
			return transferred, finish, errors.Join(cause, cancelAndCompleteWithCount(handle, &overlapped, &transferred))
		}
		status, waitErr := windows.WaitForSingleObject(event, durationMilliseconds(operationPollInterval))
		if waitErr != nil {
			return transferred, finish, errors.Join(
				fmt.Errorf("wait for HostControl overlapped I/O: %w", waitErr),
				cancelAndCompleteWithCount(handle, &overlapped, &transferred),
			)
		}
		switch status {
		case windows.WAIT_OBJECT_0:
			return transferred, finish, windows.GetOverlappedResult(handle, &overlapped, &transferred, false)
		case uint32(windows.WAIT_TIMEOUT):
			continue
		default:
			return transferred, finish, errors.Join(
				fmt.Errorf("HostControl overlapped I/O wait returned status 0x%x", status),
				cancelAndCompleteWithCount(handle, &overlapped, &transferred),
			)
		}
	}
}

func (c *Connection) stateErrorLocked() error {
	if c == nil || c.state == nil {
		return ErrClosed
	}
	state := c.state
	if state.handle == 0 || state.closing {
		return ErrClosed
	}
	return state.terminal
}

func (c *Connection) normalizeOperationError(err error, reading bool, transferred uint32) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return ErrIOTimeout
	}
	if errors.Is(err, windows.ERROR_OPERATION_ABORTED) {
		if c == nil || c.state == nil {
			return ErrClosed
		}
		state := c.state
		state.mu.Lock()
		stateErr := c.stateErrorLocked()
		state.mu.Unlock()
		if stateErr != nil {
			return stateErr
		}
	}
	if err == windows.ERROR_BROKEN_PIPE ||
		err == windows.ERROR_NO_DATA ||
		err == windows.ERROR_PIPE_NOT_CONNECTED {
		if reading && transferred == 0 {
			return io.EOF
		}
		if !reading {
			return io.ErrClosedPipe
		}
	}
	return err
}

func (c *Connection) markTerminal(cause error) {
	if c == nil || c.state == nil || cause == nil {
		return
	}
	state := c.state
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.terminal == nil {
		state.terminal = cause
	}
	if state.handle != 0 && !state.closing {
		if err := state.cancelIO(state.handle); err != nil && !errors.Is(err, windows.ERROR_NOT_FOUND) {
			state.terminal = errors.Join(state.terminal, fmt.Errorf("cancel HostControl I/O after failure: %w", err))
		}
	}
}

// Close cancels and drains active I/O. A failed DisconnectNamedPipe or
// CloseHandle leaves the original handle stored for a later retry. Calls made
// through copied Connection values share the same close attempt and handle.
func (c *Connection) Close() error {
	if c == nil || c.state == nil {
		return nil
	}
	state := c.state
	state.closeMu.Lock()
	defer state.closeMu.Unlock()

	state.mu.Lock()
	if state.handle == 0 {
		state.mu.Unlock()
		return nil
	}
	state.closing = true
	handle := state.handle
	state.mu.Unlock()

	cancelErr := state.cancelIO(handle)
	if errors.Is(cancelErr, windows.ERROR_NOT_FOUND) {
		cancelErr = nil
	}
	if !state.active.wait(state.options.CloseTimeout) {
		return errors.Join(cancelErr, ErrCloseTimeout)
	}
	if cancelErr != nil {
		return fmt.Errorf("cancel HostControl connection I/O: %w", cancelErr)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.handle != handle {
		return ErrClosed
	}
	disconnectErr := state.disconnect(handle)
	if errors.Is(disconnectErr, windows.ERROR_PIPE_NOT_CONNECTED) ||
		errors.Is(disconnectErr, windows.ERROR_NO_DATA) {
		disconnectErr = nil
	}
	if disconnectErr != nil {
		return fmt.Errorf("disconnect HostControl connection: %w", disconnectErr)
	}
	if err := state.closeHandle(handle); err != nil {
		return fmt.Errorf("close HostControl connection handle: %w", err)
	}
	state.handle = 0
	return nil
}

func validateWindowsSecurityDescriptor(
	descriptor *windows.SECURITY_DESCRIPTOR,
	ownServiceSID string,
) error {
	if descriptor == nil || !descriptor.IsValid() {
		return errors.New("HostControl security descriptor is missing or invalid")
	}
	evidence, err := daclEvidenceFromDescriptor(descriptor)
	if err != nil {
		return fmt.Errorf("inspect HostControl security descriptor: %w", err)
	}
	return validateDACL(evidence, ownServiceSID)
}

func readWindowsDACL(handle windows.Handle) (daclEvidence, error) {
	descriptor, err := windows.GetSecurityInfo(
		handle,
		windows.SE_KERNEL_OBJECT,
		windows.DACL_SECURITY_INFORMATION,
	)
	if err != nil {
		return daclEvidence{}, err
	}
	if descriptor == nil {
		return daclEvidence{}, errors.New("GetSecurityInfo returned no HostControl security descriptor")
	}
	defer runtime.KeepAlive(descriptor)
	return daclEvidenceFromDescriptor(descriptor)
}

func daclEvidenceFromDescriptor(descriptor *windows.SECURITY_DESCRIPTOR) (daclEvidence, error) {
	if descriptor == nil || !descriptor.IsValid() {
		return daclEvidence{}, errors.New("HostControl security descriptor is missing or invalid")
	}
	control, _, err := descriptor.Control()
	if err != nil {
		return daclEvidence{}, err
	}
	evidence := daclEvidence{
		Control:   uint16(control),
		Present:   control&windows.SE_DACL_PRESENT != 0,
		Protected: control&windows.SE_DACL_PROTECTED != 0,
	}
	dacl, defaulted, err := descriptor.DACL()
	if errors.Is(err, windows.ERROR_OBJECT_NOT_FOUND) {
		return evidence, nil
	}
	if err != nil {
		return daclEvidence{}, err
	}
	evidence.Null = dacl == nil
	evidence.Defaulted = defaulted
	if dacl == nil {
		return evidence, nil
	}
	evidence.Entries = make([]accessEntry, 0, int(dacl.AceCount))
	for index := uint32(0); index < uint32(dacl.AceCount); index++ {
		entry, err := readWindowsAllowedACE(dacl, index)
		if err != nil {
			return daclEvidence{}, err
		}
		evidence.Entries = append(evidence.Entries, entry)
	}
	return evidence, nil
}

func readWindowsAllowedACE(acl *windows.ACL, index uint32) (accessEntry, error) {
	var ace *windows.ACCESS_ALLOWED_ACE
	if err := windows.GetAce(acl, index, &ace); err != nil {
		return accessEntry{}, err
	}
	if ace == nil {
		return accessEntry{}, fmt.Errorf("HostControl DACL ACE %d is null", index)
	}
	sidOffset := int(unsafe.Offsetof(ace.SidStart))
	if int(ace.Header.AceSize) < sidOffset+8 {
		return accessEntry{}, fmt.Errorf("HostControl DACL ACE %d is too small for a SID", index)
	}
	sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
	if !sid.IsValid() || sid.String() == "" {
		return accessEntry{}, fmt.Errorf("HostControl DACL ACE %d has an invalid SID", index)
	}
	if int(ace.Header.AceSize) != sidOffset+sid.Len() {
		return accessEntry{}, fmt.Errorf("HostControl DACL ACE %d has a noncanonical size", index)
	}
	return accessEntry{
		SID:     sid.String(),
		Mask:    uint32(ace.Mask),
		ACEType: ace.Header.AceType,
		Flags:   ace.Header.AceFlags,
	}, nil
}

func cancelAndComplete(handle windows.Handle, overlapped *windows.Overlapped) error {
	var transferred uint32
	return cancelAndCompleteWithCount(handle, overlapped, &transferred)
}

func cancelAndCompleteWithCount(
	handle windows.Handle,
	overlapped *windows.Overlapped,
	transferred *uint32,
) error {
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

func disconnectPipe(handle windows.Handle) error {
	err := windows.DisconnectNamedPipe(handle)
	if errors.Is(err, windows.ERROR_PIPE_NOT_CONNECTED) || errors.Is(err, windows.ERROR_NO_DATA) {
		return nil
	}
	return err
}

func acquireGate(ctx context.Context, gate chan struct{}) error {
	select {
	case <-ctx.Done():
		return context.Cause(ctx)
	case <-gate:
		return nil
	}
}

func releaseGate(gate chan struct{}) {
	gate <- struct{}{}
}

func normalizeContextError(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return ErrIOTimeout
	}
	return err
}

func durationMilliseconds(value time.Duration) uint32 {
	if value <= 0 {
		return 0
	}
	milliseconds := (value + time.Millisecond - 1) / time.Millisecond
	if milliseconds > time.Duration(^uint32(0)) {
		return ^uint32(0)
	}
	return uint32(milliseconds)
}

func closeRejectedHandle(label string, handle windows.Handle) error {
	if handle == 0 {
		return nil
	}
	var failures []error
	for attempt := 1; attempt <= 3; attempt++ {
		if err := windows.CloseHandle(handle); err != nil {
			failures = append(failures, fmt.Errorf("%s attempt %d: %w", label, attempt, err))
			continue
		}
		return errors.Join(failures...)
	}
	return errors.Join(failures...)
}

var (
	_ io.ReadWriteCloser = (*Connection)(nil)
	_ clientPIDObserver  = listenerPIDObserver{}
)
