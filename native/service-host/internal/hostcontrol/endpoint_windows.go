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
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winprocess"
	"golang.org/x/sys/windows"
)

const (
	pipeAccessDuplex             uint32 = 0x00000003
	fileFlagFirstPipeInstance    uint32 = 0x00080000
	fileFlagOverlapped           uint32 = 0x40000000
	pipeRejectRemoteClients      uint32 = 0x00000008
	maximumServerInstances       uint32 = 1
	operationPollInterval               = 25 * time.Millisecond
	maximumOperationCleanupGrace        = 5 * time.Second
)

var (
	errHostControlIOUnresolvedFatal = errors.New("HostControl native I/O ownership is unresolved; the current ServiceHost process must exit")
	windowsHostControlQuarantine    = &hostControlLifetimeQuarantine{}
)

type hostControlCancelOperationFunc func(windows.Handle, *windows.Overlapped) error
type hostControlCreateEventFunc func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error)
type hostControlGetResultFunc func(windows.Handle, *windows.Overlapped, *uint32, bool) error
type hostControlReadFunc func(windows.Handle, []byte, *uint32, *windows.Overlapped) error
type hostControlWaitFunc func(windows.Handle, uint32) (uint32, error)
type hostControlWriteFunc func(windows.Handle, []byte, *uint32, *windows.Overlapped) error

type hostControlLifetimeQuarantine struct {
	mu       sync.RWMutex
	poisoned atomic.Bool
	owners   []any
	fatal    error
}

func (quarantine *hostControlLifetimeQuarantine) retain(owner any, cause error) error {
	if quarantine == nil || owner == nil {
		return errors.Join(errHostControlIOUnresolvedFatal, cause)
	}
	result := errors.Join(errHostControlIOUnresolvedFatal, cause)
	quarantine.poisoned.Store(true)
	quarantine.mu.Lock()
	quarantine.owners = append(quarantine.owners, owner)
	quarantine.fatal = errors.Join(quarantine.fatal, result)
	quarantine.mu.Unlock()
	return result
}

func (quarantine *hostControlLifetimeQuarantine) fatalError() error {
	if quarantine == nil {
		return errHostControlIOUnresolvedFatal
	}
	quarantine.mu.RLock()
	defer quarantine.mu.RUnlock()
	if quarantine.fatal == nil && quarantine.poisoned.Load() {
		return errHostControlIOUnresolvedFatal
	}
	return quarantine.fatal
}

type hostControlNativeRelease func(poison bool)

func (quarantine *hostControlLifetimeQuarantine) beginNativeUse() (hostControlNativeRelease, error) {
	if quarantine == nil {
		return func(bool) {}, errHostControlIOUnresolvedFatal
	}
	if quarantine.poisoned.Load() {
		return func(bool) {}, quarantine.fatalError()
	}
	quarantine.mu.RLock()
	if quarantine.fatal != nil || quarantine.poisoned.Load() {
		fatal := quarantine.fatal
		quarantine.mu.RUnlock()
		return func(bool) {}, errors.Join(errHostControlIOUnresolvedFatal, fatal)
	}
	return func(poison bool) {
		if poison {
			quarantine.poisoned.Store(true)
		}
		quarantine.mu.RUnlock()
	}, nil
}

func (quarantine *hostControlLifetimeQuarantine) count() int {
	if quarantine == nil {
		return 0
	}
	quarantine.mu.RLock()
	defer quarantine.mu.RUnlock()
	return len(quarantine.owners)
}

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
	mu       sync.Mutex
	closeMu  sync.Mutex
	settleMu sync.Mutex
	active   activityGroup

	handle     windows.Handle
	event      windows.Handle
	overlapped windows.Overlapped
	pipeName   string
	options    Options
	deadline   time.Time

	pending       bool
	connected     bool
	accepting     bool
	consumed      bool
	closing       bool
	terminal      error
	fatal         error
	quarantined   bool
	connectPinned bool
	connectPinner runtime.Pinner
	quarantine    *hostControlLifetimeQuarantine
	cleanupGrace  time.Duration

	cancelOperation     hostControlCancelOperationFunc
	clientProcessID     func(windows.Handle, *uint32) error
	connectCloseHandle  func(windows.Handle) error
	getOverlappedResult hostControlGetResultFunc
	waitForSingleObject hostControlWaitFunc
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
	publish activityGroup

	handle       windows.Handle
	options      Options
	evidence     VerificationEvidence
	bootstrap    localrpc.CommittedRuntimeBootstrap
	closing      bool
	terminal     error
	fatal        error
	quarantined  bool
	operations   map[*hostControlOperation]struct{}
	quarantine   *hostControlLifetimeQuarantine
	cleanupGrace time.Duration

	readGate  chan struct{}
	writeGate chan struct{}

	cancelIO            func(windows.Handle) error
	disconnect          func(windows.Handle) error
	closeHandle         func(windows.Handle) error
	cancelOperation     hostControlCancelOperationFunc
	createEvent         hostControlCreateEventFunc
	getOverlappedResult hostControlGetResultFunc
	readFile            hostControlReadFunc
	waitForSingleObject hostControlWaitFunc
	writeFile           hostControlWriteFunc
}

type hostControlOperation struct {
	state       *connectionState
	handle      windows.Handle
	buffer      []byte
	event       windows.Handle
	overlapped  windows.Overlapped
	transferred uint32
	finish      func()
	reading     bool

	pinner           runtime.Pinner
	pinned           bool
	submitted        bool
	completed        bool
	quarantined      bool
	pipeTombstoned   bool
	eventTombstoned  bool
	forcedQuarantine atomic.Bool
	cancelRequested  atomic.Bool
}

// Prepare creates the only pipe instance and starts ConnectNamedPipe before
// the caller launches Node.
func Prepare(options Options) (*Listener, error) {
	if fatal := windowsHostControlQuarantine.fatalError(); fatal != nil {
		return nil, fatal
	}
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

	releaseNative, gateErr := windowsHostControlQuarantine.beginNativeUse()
	if gateErr != nil {
		return nil, gateErr
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
	releaseNative((err != nil && handle != 0) || (err == nil && (handle == 0 || handle == windows.InvalidHandle)))
	runtime.KeepAlive(securityDescriptor)
	if err != nil {
		if handle != 0 {
			return nil, errors.Join(
				fmt.Errorf("create HostControl named-pipe server: %w", err),
				windowsHostControlQuarantine.retain(
					&hostControlDetachedHandleOwner{kind: "untrusted HostControl pipe output", value: handle},
					err,
				),
			)
		}
		return nil, fmt.Errorf("create HostControl named-pipe server: %w", err)
	}
	if handle == 0 || handle == windows.InvalidHandle {
		return nil, windowsHostControlQuarantine.retain(
			&hostControlDetachedHandleOwner{kind: "invalid HostControl pipe output", value: handle},
			windows.ERROR_INVALID_HANDLE,
		)
	}
	keepHandle := false
	defer func() {
		if !keepHandle {
			resultErr = errors.Join(
				resultErr,
				closeRejectedHostControlHandle("close rejected HostControl pipe", handle, windowsHostControlQuarantine),
			)
		}
	}()

	releaseNative, gateErr = windowsHostControlQuarantine.beginNativeUse()
	if gateErr != nil {
		keepHandle = true
		return nil, windowsHostControlQuarantine.retain(
			&hostControlDetachedHandleOwner{kind: "HostControl pipe", value: handle},
			gateErr,
		)
	}
	evidence, err := readWindowsDACL(handle)
	invalidDACLHandle := errors.Is(err, windows.ERROR_INVALID_HANDLE)
	releaseNative(invalidDACLHandle)
	if err != nil {
		wrapped := fmt.Errorf("read back HostControl pipe DACL: %w", err)
		if invalidDACLHandle {
			keepHandle = true
			return nil, errors.Join(
				wrapped,
				windowsHostControlQuarantine.retain(
					&hostControlDetachedHandleOwner{kind: "invalid HostControl pipe after DACL read", value: handle},
					wrapped,
				),
			)
		}
		return nil, wrapped
	}
	if err := validateDACL(evidence, options.OwnServiceSID); err != nil {
		return nil, fmt.Errorf("validate HostControl pipe DACL: %w", err)
	}

	releaseNative, gateErr = windowsHostControlQuarantine.beginNativeUse()
	if gateErr != nil {
		keepHandle = true
		return nil, windowsHostControlQuarantine.retain(
			&hostControlDetachedHandleOwner{kind: "HostControl pipe", value: handle},
			gateErr,
		)
	}
	event, err := windows.CreateEvent(nil, 1, 0, nil)
	releaseNative((err != nil && event != 0) || (err == nil && (event == 0 || event == windows.InvalidHandle)))
	if err != nil {
		if event != 0 {
			keepHandle = true
			return nil, errors.Join(
				fmt.Errorf("create HostControl connect event: %w", err),
				windowsHostControlQuarantine.retain(
					&hostControlDetachedHandleOwner{kind: "untrusted HostControl connect event output", value: event},
					err,
				),
				windowsHostControlQuarantine.retain(
					&hostControlDetachedHandleOwner{kind: "HostControl pipe retained after event creation failure", value: handle},
					err,
				),
			)
		}
		return nil, fmt.Errorf("create HostControl connect event: %w", err)
	}
	if event == 0 || event == windows.InvalidHandle {
		keepHandle = true
		return nil, errors.Join(
			windowsHostControlQuarantine.retain(
				&hostControlDetachedHandleOwner{kind: "invalid HostControl connect event output", value: event},
				windows.ERROR_INVALID_HANDLE,
			),
			windowsHostControlQuarantine.retain(
				&hostControlDetachedHandleOwner{kind: "HostControl pipe retained after invalid event output", value: handle},
				windows.ERROR_INVALID_HANDLE,
			),
		)
	}
	keepEvent := false
	defer func() {
		if !keepEvent {
			resultErr = errors.Join(
				resultErr,
				closeRejectedHostControlHandle("close rejected HostControl connect event", event, windowsHostControlQuarantine),
			)
		}
	}()

	listener := &Listener{
		handle:              handle,
		event:               event,
		pipeName:            pipeName,
		options:             options,
		deadline:            time.Now().Add(options.ConnectTimeout),
		quarantine:          windowsHostControlQuarantine,
		cleanupGrace:        operationCleanupGrace(options.CloseTimeout),
		cancelOperation:     windows.CancelIoEx,
		clientProcessID:     windows.GetNamedPipeClientProcessId,
		connectCloseHandle:  windows.CloseHandle,
		getOverlappedResult: windows.GetOverlappedResult,
		waitForSingleObject: windows.WaitForSingleObject,
	}
	listener.overlapped.HEvent = event
	listener.connectPinner.Pin(&listener.overlapped)
	listener.connectPinned = true
	releaseNative, gateErr = windowsHostControlQuarantine.beginNativeUse()
	if gateErr != nil {
		listener.quarantined = true
		listener.fatal = listener.quarantine.retain(listener, gateErr)
		keepHandle = true
		keepEvent = true
		return nil, listener.fatal
	}
	connectErr := windows.ConnectNamedPipe(handle, &listener.overlapped)
	releaseNative(errors.Is(connectErr, windows.ERROR_INVALID_HANDLE))
	switch {
	case connectErr == nil:
		listener.connected = true
	case errors.Is(connectErr, windows.ERROR_IO_PENDING):
		listener.pending = true
	case errors.Is(connectErr, windows.ERROR_PIPE_CONNECTED):
		listener.connected = true
	default:
		if errors.Is(connectErr, windows.ERROR_INVALID_HANDLE) {
			listener.quarantined = true
			listener.fatal = listener.quarantine.retain(listener, connectErr)
			keepHandle = true
			keepEvent = true
			return nil, errors.Join(
				fmt.Errorf("start HostControl ConnectNamedPipe before Node launch: %w", connectErr),
				listener.fatal,
			)
		}
		listener.connectPinner.Unpin()
		listener.connectPinned = false
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

// Accept validates one explicit launch-bound bootstrap before observing the
// connection, verifies the retained Node, completes the RuntimeBootstrapV1
// exchange, and raises the root Job process limit. Failures before pipe-handle
// transfer return a nil Connection. After transfer, Accept terminates and then
// closes Node before trying to close the Connection; if that close fails, it
// returns the still-owning Connection with the joined primary and cleanup
// errors.
func (l *Listener) Accept(
	ctx context.Context,
	node winprocess.NodeProcess,
	bootstrap ...localrpc.LaunchRuntimeBootstrap,
) (*Connection, error) {
	if isNilInterface(node) {
		return nil, errors.New("Node process is required")
	}
	if ctx == nil {
		return rejectAcceptFailure(
			nil,
			errors.New("HostControl accept context is required"),
			node,
			func() {},
			l.Close,
		)
	}
	if l == nil {
		return rejectAcceptFailure(nil, ErrClosed, node, func() {}, l.Close)
	}
	if cause := context.Cause(ctx); cause != nil {
		return rejectAcceptFailure(nil, cause, node, func() {
			l.markTerminal(cause)
		}, l.Close)
	}
	if fatal := l.quarantineOrDefault().fatalError(); fatal != nil {
		acceptErr := l.quarantineConnect(fatal, false, false)
		return rejectAcceptFailure(nil, acceptErr, node, func() {}, l.Close)
	}
	finish, err := l.beginAccept()
	if err != nil {
		return rejectAcceptFailure(nil, err, node, func() {
			l.markTerminal(err)
		}, l.Close)
	}
	boundBootstrap, err := resolveLaunchRuntimeBootstrap(bootstrap)
	if err != nil {
		finish()
		bootstrapErr := fmt.Errorf("resolve HostControl launch bootstrap binding: %w", err)
		return rejectAcceptFailure(nil, bootstrapErr, node, func() {
			l.markTerminal(bootstrapErr)
		}, l.Close)
	}

	connection, err := l.acceptConnected(ctx, node)
	finish()
	if err != nil {
		return rejectAcceptFailure(nil, err, node, func() {
			l.markTerminal(err)
		}, l.Close)
	}

	bootstrapContext, cancelBootstrap := boundedBootstrapContext(
		ctx,
		l.deadline,
		l.options.IOTimeout,
	)
	committedBootstrap, err := completeRuntimeBootstrap(
		bootstrapContext, connection, node, connection.Evidence(), boundBootstrap,
	)
	cancelBootstrap()
	if err != nil {
		return rejectPostTransferAcceptFailure(connection, err, node)
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
	node interface {
		Terminate() error
		Close() error
	},
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
	if l.fatal != nil || l.quarantined {
		return nil, errors.Join(errHostControlIOUnresolvedFatal, l.fatal)
	}
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
	defer l.mu.Unlock()
	if l.closing || l.handle == 0 {
		return nil, ErrClosed
	}
	if l.terminal != nil {
		return nil, l.terminal
	}
	if l.fatal != nil || l.quarantined || l.event != 0 || l.pending {
		return nil, errors.Join(errHostControlIOUnresolvedFatal, l.fatal)
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
		if fatal := l.quarantineOrDefault().fatalError(); fatal != nil {
			return l.quarantineConnect(fatal, false, false)
		}
		l.mu.Lock()
		if l.fatal != nil || l.quarantined {
			fatal := l.fatal
			l.mu.Unlock()
			return errors.Join(errHostControlIOUnresolvedFatal, fatal)
		}
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
			return l.releaseConnectEvent()
		}
		event := l.event
		deadline := l.deadline
		l.mu.Unlock()

		if cause := context.Cause(ctx); cause != nil {
			return l.cancelPendingConnect(cause)
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return l.cancelPendingConnect(ErrConnectTimeout)
		}
		wait := operationPollInterval
		if remaining < wait {
			wait = remaining
		}
		waitForSingleObject := l.waitForSingleObject
		if waitForSingleObject == nil {
			waitForSingleObject = windows.WaitForSingleObject
		}
		releaseNative, gateErr := l.quarantineOrDefault().beginNativeUse()
		if gateErr != nil {
			return l.quarantineConnect(gateErr, false, false)
		}
		status, err := waitForSingleObject(event, durationMilliseconds(wait))
		releaseNative(errors.Is(err, windows.ERROR_INVALID_HANDLE))
		runtime.KeepAlive(l)
		if err != nil {
			if errors.Is(err, windows.ERROR_INVALID_HANDLE) {
				return l.quarantineConnect(err, false, true)
			}
			return l.cancelPendingConnect(fmt.Errorf("wait for HostControl client: %w", err))
		}
		switch status {
		case windows.WAIT_OBJECT_0:
			return l.completePendingConnect()
		case uint32(windows.WAIT_TIMEOUT):
			continue
		default:
			return l.cancelPendingConnect(
				fmt.Errorf("HostControl connect wait returned status 0x%x", status),
			)
		}
	}
}

func (l *Listener) completePendingConnect() error {
	l.settleMu.Lock()
	defer l.settleMu.Unlock()
	l.mu.Lock()
	if l.fatal != nil || l.quarantined {
		fatal := l.fatal
		l.mu.Unlock()
		return errors.Join(errHostControlIOUnresolvedFatal, fatal)
	}
	if !l.pending || l.handle == 0 || l.event == 0 {
		l.mu.Unlock()
		return errors.New("HostControl connect completion state is invalid")
	}
	handle := l.handle
	overlapped := &l.overlapped
	getResult := l.getOverlappedResult
	if getResult == nil {
		getResult = windows.GetOverlappedResult
	}
	l.mu.Unlock()

	var transferred uint32
	releaseNative, gateErr := l.quarantineOrDefault().beginNativeUse()
	if gateErr != nil {
		return l.quarantineConnect(gateErr, false, false)
	}
	completionErr := getResult(handle, overlapped, &transferred, false)
	runtime.KeepAlive(l)
	completed, classifiedErr := classifyHostControlConnectCompletion(completionErr)
	releaseNative(!completed)
	if !completed {
		return l.quarantineConnect(classifiedErr, errors.Is(classifiedErr, windows.ERROR_INVALID_HANDLE), false)
	}
	l.mu.Lock()
	l.pending = false
	if classifiedErr == nil || errors.Is(classifiedErr, windows.ERROR_PIPE_CONNECTED) {
		l.connected = true
	}
	l.mu.Unlock()
	releaseErr := l.releaseConnectEventHeld()
	if classifiedErr != nil && !errors.Is(classifiedErr, windows.ERROR_PIPE_CONNECTED) {
		return errors.Join(fmt.Errorf("complete HostControl ConnectNamedPipe: %w", classifiedErr), releaseErr)
	}
	return releaseErr
}

func (l *Listener) cancelPendingConnect(cause error) error {
	l.settleMu.Lock()
	defer l.settleMu.Unlock()
	l.mu.Lock()
	if l.fatal != nil || l.quarantined {
		fatal := l.fatal
		l.mu.Unlock()
		return errors.Join(cause, errHostControlIOUnresolvedFatal, fatal)
	}
	if !l.pending {
		l.mu.Unlock()
		return errors.Join(cause, l.releaseConnectEventHeld())
	}
	handle := l.handle
	event := l.event
	overlapped := &l.overlapped
	cancelOperation := l.cancelOperation
	if cancelOperation == nil {
		cancelOperation = windows.CancelIoEx
	}
	l.mu.Unlock()

	releaseNative, gateErr := l.quarantineOrDefault().beginNativeUse()
	if gateErr != nil {
		return errors.Join(cause, l.quarantineConnect(gateErr, false, false))
	}
	cancelErr := cancelOperation(handle, overlapped)
	releaseNative(errors.Is(cancelErr, windows.ERROR_INVALID_HANDLE))
	runtime.KeepAlive(l)
	if errors.Is(cancelErr, windows.ERROR_INVALID_HANDLE) {
		return errors.Join(cause, l.quarantineConnect(cancelErr, true, false))
	}
	if errors.Is(cancelErr, windows.ERROR_NOT_FOUND) {
		cancelErr = nil
	}
	waitForSingleObject := l.waitForSingleObject
	if waitForSingleObject == nil {
		waitForSingleObject = windows.WaitForSingleObject
	}
	releaseNative, gateErr = l.quarantineOrDefault().beginNativeUse()
	if gateErr != nil {
		return errors.Join(cause, cancelErr, l.quarantineConnect(gateErr, false, false))
	}
	status, waitErr := waitForSingleObject(event, durationMilliseconds(l.cleanupGrace))
	releaseNative(waitErr != nil || status != windows.WAIT_OBJECT_0)
	runtime.KeepAlive(l)
	if waitErr != nil {
		return errors.Join(cause, cancelErr, l.quarantineConnect(waitErr, false, errors.Is(waitErr, windows.ERROR_INVALID_HANDLE)))
	}
	if status != windows.WAIT_OBJECT_0 {
		waitFailure := ErrCloseTimeout
		if status != uint32(windows.WAIT_TIMEOUT) {
			waitFailure = fmt.Errorf("wait for cancelled HostControl connect returned status 0x%x", status)
		}
		return errors.Join(cause, cancelErr, l.quarantineConnect(waitFailure, false, false))
	}

	getResult := l.getOverlappedResult
	if getResult == nil {
		getResult = windows.GetOverlappedResult
	}
	var transferred uint32
	releaseNative, gateErr = l.quarantineOrDefault().beginNativeUse()
	if gateErr != nil {
		return errors.Join(cause, cancelErr, l.quarantineConnect(gateErr, false, false))
	}
	completionErr := getResult(handle, overlapped, &transferred, false)
	runtime.KeepAlive(l)
	completed, classifiedErr := classifyHostControlConnectCompletion(completionErr)
	releaseNative(!completed)
	if !completed {
		return errors.Join(cause, cancelErr, l.quarantineConnect(classifiedErr, errors.Is(classifiedErr, windows.ERROR_INVALID_HANDLE), false))
	}
	if errors.Is(classifiedErr, windows.ERROR_OPERATION_ABORTED) {
		classifiedErr = nil
	}
	l.mu.Lock()
	l.pending = false
	l.mu.Unlock()
	releaseErr := l.releaseConnectEventHeld()
	return errors.Join(cause, cancelErr, classifiedErr, releaseErr)
}

func (l *Listener) releaseConnectEvent() error {
	l.settleMu.Lock()
	defer l.settleMu.Unlock()
	return l.releaseConnectEventHeld()
}

func (l *Listener) releaseConnectEventHeld() error {
	l.mu.Lock()
	if l.fatal != nil || l.quarantined {
		fatal := l.fatal
		l.mu.Unlock()
		return errors.Join(errHostControlIOUnresolvedFatal, fatal)
	}
	if l.pending {
		l.mu.Unlock()
		return errors.New("HostControl connect event is still pending")
	}
	event := l.event
	closeHandle := l.connectCloseHandle
	if closeHandle == nil {
		closeHandle = windows.CloseHandle
	}
	if event != 0 {
		l.event = 0
	}
	l.mu.Unlock()
	if event != 0 {
		owner := &hostControlDetachedHandleOwner{kind: "HostControl connect event", value: event}
		quarantine := l.quarantineOrDefault()
		releaseNative, gateErr := quarantine.beginNativeUse()
		if gateErr != nil {
			return errors.Join(
				quarantine.retain(owner, gateErr),
				l.quarantineConnect(gateErr, false, false),
			)
		}
		err := closeHandle(event)
		releaseNative(err != nil)
		if err != nil {
			wrapped := fmt.Errorf("close completed HostControl connect event: %w", err)
			return errors.Join(
				quarantine.retain(owner, wrapped),
				l.quarantineConnect(wrapped, false, true),
			)
		}
	}
	l.mu.Lock()
	if l.connectPinned {
		l.connectPinner.Unpin()
		l.connectPinned = false
	}
	l.mu.Unlock()
	return nil
}

func (l *Listener) quarantineConnect(cause error, pipeTombstoned bool, eventTombstoned bool) error {
	if cause == nil {
		cause = errors.New("HostControl connect ownership is unresolved")
	}
	quarantine := l.quarantineOrDefault()
	quarantine.poisoned.Store(true)
	l.mu.Lock()
	if pipeTombstoned {
		l.handle = 0
	}
	if eventTombstoned {
		l.event = 0
	}
	l.quarantined = true
	l.closing = true
	l.fatal = errors.Join(l.fatal, errHostControlIOUnresolvedFatal, cause)
	localFatal := l.fatal
	l.mu.Unlock()
	retained := quarantine.retain(l, errors.Join(cause, localFatal))
	l.mu.Lock()
	l.fatal = errors.Join(l.fatal, retained)
	result := l.fatal
	l.mu.Unlock()
	return result
}

func (l *Listener) quarantineOrDefault() *hostControlLifetimeQuarantine {
	if l != nil && l.quarantine != nil {
		return l.quarantine
	}
	return windowsHostControlQuarantine
}

func (l *Listener) markTerminal(cause error) {
	if l == nil || cause == nil {
		return
	}
	l.mu.Lock()
	if l.fatal != nil || l.quarantined {
		l.mu.Unlock()
		return
	}
	if l.terminal == nil {
		l.terminal = cause
	}
	if l.handle != 0 {
		cancelOperation := l.cancelOperation
		if cancelOperation == nil {
			cancelOperation = windows.CancelIoEx
		}
		releaseNative, gateErr := l.quarantineOrDefault().beginNativeUse()
		if gateErr != nil {
			l.mu.Unlock()
			_ = l.quarantineConnect(gateErr, false, false)
			return
		}
		err := cancelOperation(l.handle, nil)
		releaseNative(errors.Is(err, windows.ERROR_INVALID_HANDLE))
		if err != nil && !errors.Is(err, windows.ERROR_NOT_FOUND) {
			l.terminal = errors.Join(l.terminal, fmt.Errorf("cancel HostControl listener I/O after failure: %w", err))
			if errors.Is(err, windows.ERROR_INVALID_HANDLE) {
				l.mu.Unlock()
				_ = l.quarantineConnect(err, true, false)
				return
			}
		}
	}
	l.mu.Unlock()
}

// Close cancels pending connect work. A raw handle is removed from its callable
// slot before CloseHandle; any close failure quarantines that consumed owner.
func (l *Listener) Close() error {
	if l == nil {
		return nil
	}
	l.closeMu.Lock()
	defer l.closeMu.Unlock()

	l.mu.Lock()
	if l.fatal != nil || l.quarantined {
		fatal := l.fatal
		l.mu.Unlock()
		return errors.Join(errHostControlIOUnresolvedFatal, fatal)
	}
	l.mu.Unlock()
	if fatal := l.quarantineOrDefault().fatalError(); fatal != nil {
		return l.quarantineConnect(fatal, false, false)
	}
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
		cancelOperation := l.cancelOperation
		if cancelOperation == nil {
			cancelOperation = windows.CancelIoEx
		}
		releaseNative, gateErr := l.quarantineOrDefault().beginNativeUse()
		if gateErr != nil {
			return l.quarantineConnect(gateErr, false, false)
		}
		cancelErr = cancelOperation(handle, nil)
		releaseNative(errors.Is(cancelErr, windows.ERROR_INVALID_HANDLE))
		if errors.Is(cancelErr, windows.ERROR_INVALID_HANDLE) {
			return l.quarantineConnect(
				fmt.Errorf("cancel HostControl listener I/O: %w", cancelErr),
				true,
				false,
			)
		}
		if errors.Is(cancelErr, windows.ERROR_NOT_FOUND) {
			cancelErr = nil
		}
	}
	if !l.active.wait(l.options.CloseTimeout) {
		l.mu.Lock()
		pending := l.pending
		l.mu.Unlock()
		if pending {
			return errors.Join(cancelErr, l.quarantineConnect(ErrCloseTimeout, false, false))
		}
		return errors.Join(cancelErr, ErrCloseTimeout)
	}

	l.mu.Lock()
	pending := l.pending
	event := l.event
	l.mu.Unlock()
	if pending {
		if err := l.cancelPendingConnect(nil); err != nil {
			return errors.Join(cancelErr, err)
		}
	} else if event != 0 {
		if err := l.releaseConnectEvent(); err != nil {
			return errors.Join(cancelErr, err)
		}
	}
	if cancelErr != nil {
		return fmt.Errorf("cancel HostControl listener I/O: %w", cancelErr)
	}

	l.mu.Lock()
	if l.fatal != nil || l.quarantined {
		fatal := l.fatal
		l.mu.Unlock()
		return errors.Join(errHostControlIOUnresolvedFatal, fatal)
	}
	handle = l.handle
	connected := l.connected
	if l.pending || l.event != 0 || l.connectPinned {
		l.mu.Unlock()
		return l.quarantineConnect(
			errors.New("HostControl close observed unresolved connect ownership"),
			false,
			false,
		)
	}
	if connected && handle != 0 {
		releaseNative, gateErr := l.quarantineOrDefault().beginNativeUse()
		if gateErr != nil {
			l.mu.Unlock()
			return l.quarantineConnect(gateErr, false, false)
		}
		err := disconnectPipe(handle)
		releaseNative(errors.Is(err, windows.ERROR_INVALID_HANDLE))
		if err != nil {
			l.mu.Unlock()
			if errors.Is(err, windows.ERROR_INVALID_HANDLE) {
				return l.quarantineConnect(err, true, false)
			}
			return fmt.Errorf("disconnect rejected HostControl client: %w", err)
		}
		l.connected = false
	}
	if handle != 0 {
		closeHandle := l.connectCloseHandle
		if closeHandle == nil {
			closeHandle = windows.CloseHandle
		}
		owner := &hostControlDetachedHandleOwner{kind: "HostControl listener pipe", value: handle}
		quarantine := l.quarantineOrDefault()
		l.handle = 0
		releaseNative, gateErr := quarantine.beginNativeUse()
		if gateErr != nil {
			l.mu.Unlock()
			return errors.Join(
				quarantine.retain(owner, gateErr),
				l.quarantineConnect(gateErr, true, false),
			)
		}
		err := closeHandle(handle)
		releaseNative(err != nil)
		if err != nil {
			l.mu.Unlock()
			wrapped := fmt.Errorf("close HostControl listener handle: %w", err)
			return errors.Join(
				quarantine.retain(owner, wrapped),
				l.quarantineConnect(wrapped, true, false),
			)
		}
	}
	l.mu.Unlock()
	return nil
}

type listenerPIDObserver struct {
	listener *Listener
}

func (o listenerPIDObserver) ClientProcessID() (uint32, error) {
	if o.listener == nil {
		return 0, ErrClosed
	}
	listener := o.listener
	listener.mu.Lock()
	if listener.fatal != nil || listener.quarantined {
		fatal := listener.fatal
		listener.mu.Unlock()
		return 0, errors.Join(errHostControlIOUnresolvedFatal, fatal)
	}
	if listener.handle == 0 || listener.closing {
		listener.mu.Unlock()
		return 0, ErrClosed
	}
	handle := listener.handle
	releaseNative, gateErr := listener.quarantineOrDefault().beginNativeUse()
	if gateErr != nil {
		listener.mu.Unlock()
		return 0, listener.quarantineConnect(gateErr, false, false)
	}
	var processID uint32
	clientProcessID := listener.clientProcessID
	if clientProcessID == nil {
		clientProcessID = windows.GetNamedPipeClientProcessId
	}
	err := clientProcessID(handle, &processID)
	invalidHandle := errors.Is(err, windows.ERROR_INVALID_HANDLE)
	releaseNative(invalidHandle)
	if err != nil {
		listener.mu.Unlock()
		if invalidHandle {
			return 0, listener.quarantineConnect(err, true, false)
		}
		return 0, err
	}
	if processID == 0 {
		listener.mu.Unlock()
		return 0, errors.New("Windows returned a zero HostControl client PID")
	}
	listener.mu.Unlock()
	return processID, nil
}

func newConnection(
	handle windows.Handle,
	options Options,
	evidence VerificationEvidence,
) *Connection {
	state := &connectionState{
		handle:       handle,
		options:      options,
		evidence:     evidence,
		readGate:     make(chan struct{}, 1),
		writeGate:    make(chan struct{}, 1),
		operations:   make(map[*hostControlOperation]struct{}),
		quarantine:   windowsHostControlQuarantine,
		cleanupGrace: operationCleanupGrace(options.CloseTimeout),
		cancelIO: func(handle windows.Handle) error {
			return windows.CancelIoEx(handle, nil)
		},
		disconnect:          disconnectPipe,
		closeHandle:         windows.CloseHandle,
		cancelOperation:     windows.CancelIoEx,
		createEvent:         windows.CreateEvent,
		getOverlappedResult: windows.GetOverlappedResult,
		readFile:            windows.ReadFile,
		waitForSingleObject: windows.WaitForSingleObject,
		writeFile:           windows.WriteFile,
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
	if c == nil || c.state == nil {
		return 0, ErrClosed
	}
	readContext, cancelRead := context.WithTimeoutCause(
		context.Background(),
		c.state.options.IOTimeout,
		ErrIOTimeout,
	)
	defer cancelRead()
	return c.ReadContext(readContext, buffer)
}

// ReadContext performs one overlapped byte-stream read bounded only by ctx.
func (c *Connection) ReadContext(ctx context.Context, buffer []byte) (int, error) {
	if c == nil || c.state == nil {
		return 0, ErrClosed
	}
	if ctx == nil {
		return 0, errors.New("HostControl read context is required")
	}
	state := c.state
	if len(buffer) == 0 {
		return 0, nil
	}
	if err := acquireGate(ctx, state.readGate); err != nil {
		return 0, err
	}
	defer releaseGate(state.readGate)

	finishPublication := state.publish.begin()
	transferred, err := c.performOverlapped(ctx, buffer, true)
	if cause := context.Cause(ctx); cause != nil {
		err = errors.Join(cause, err)
		return transferred, c.markTerminalAfterPublication(err, finishPublication)
	}
	if err != nil {
		err = c.normalizeOperationError(err, true, uint32(transferred))
		return transferred, c.markTerminalAfterPublication(err, finishPublication)
	}
	finishPublication()
	return transferred, state.currentFailure()
}

func boundedBootstrapContext(
	parent context.Context,
	listenerDeadline time.Time,
	ioTimeout time.Duration,
) (context.Context, context.CancelFunc) {
	listenerContext, cancelListener := context.WithDeadline(parent, listenerDeadline)
	bootstrapContext, cancelIO := context.WithTimeoutCause(listenerContext, ioTimeout, ErrIOTimeout)
	return bootstrapContext, func() {
		cancelIO()
		cancelListener()
	}
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

	finishPublication := state.publish.begin()
	transferred, err := c.performOverlapped(operationContext, buffer, false)
	if cause := context.Cause(operationContext); cause != nil {
		err = errors.Join(cause, err)
	}
	if err != nil {
		err = c.normalizeOperationError(err, false, uint32(transferred))
		return transferred, c.markTerminalAfterPublication(err, finishPublication)
	}
	finishPublication()
	return transferred, state.currentFailure()
}

func (c *Connection) performOverlapped(
	ctx context.Context,
	callerBuffer []byte,
	reading bool,
) (transferred int, resultErr error) {
	if c == nil || c.state == nil {
		return 0, ErrClosed
	}
	state := c.state
	if fatal := state.quarantineOrDefault().fatalError(); fatal != nil {
		return 0, state.quarantineOwner(state, fatal, false)
	}
	if cause := context.Cause(ctx); cause != nil {
		return 0, cause
	}
	if len(callerBuffer) == 0 {
		return 0, nil
	}
	defer runtime.KeepAlive(callerBuffer)

	handle, finish, err := state.beginOperation()
	if err != nil {
		return 0, err
	}
	event, err := state.createOperationEvent()
	if err != nil {
		finish()
		return 0, err
	}
	operation := newHostControlOperation(state, handle, callerBuffer, event, finish, reading)
	defer func() {
		var lifecycleErr error
		if operation.completed && !operation.forcedQuarantine.Load() {
			lifecycleErr = state.releaseCompletedOperation(operation)
		} else {
			lifecycleErr = state.quarantineIncompleteOperation(operation, resultErr)
		}
		if lifecycleErr != nil {
			resultErr = errors.Join(resultErr, lifecycleErr)
		}
	}()
	if cause := context.Cause(ctx); cause != nil {
		return 0, cause
	}

	startErr := state.submitOperation(operation)
	if !operation.submitted {
		return 0, startErr
	}
	if startErr == nil {
		completed, completionErr := state.completeOperation(operation)
		operation.completed = completed
		if !completed {
			return 0, completionErr
		}
		count, countErr := publishCompletedOperation(operation, callerBuffer)
		return count, joinHostControlErrors(completionErr, countErr)
	}
	if !errors.Is(startErr, windows.ERROR_IO_PENDING) {
		if operation.forcedQuarantine.Load() {
			operation.completed = false
			return 0, startErr
		}
		operation.completed = true
		count, countErr := publishCompletedOperation(operation, callerBuffer)
		return count, joinHostControlErrors(startErr, countErr)
	}

	for {
		if cause := context.Cause(ctx); cause != nil {
			completed, completionErr := state.cancelAndComplete(operation, state.cleanupGrace)
			operation.completed = completed
			if !completed {
				return 0, errors.Join(cause, completionErr)
			}
			count, countErr := publishCompletedOperation(operation, callerBuffer)
			return count, joinHostControlErrors(cause, completionErr, countErr)
		}
		if operation.cancelRequested.Load() {
			completed, completionErr := state.cancelAndComplete(operation, state.cleanupGrace)
			operation.completed = completed
			if !completed {
				return 0, errors.Join(ErrClosed, completionErr)
			}
			count, countErr := publishCompletedOperation(operation, callerBuffer)
			return count, joinHostControlErrors(ErrClosed, completionErr, countErr)
		}
		status, waitErr := state.waitForOperation(operation, operationPollInterval)
		if waitErr != nil {
			operation.completed = false
			return 0, fmt.Errorf("wait for HostControl overlapped I/O: %w", waitErr)
		}
		switch status {
		case windows.WAIT_OBJECT_0:
			completed, completionErr := state.completeOperation(operation)
			operation.completed = completed
			if !completed {
				return 0, completionErr
			}
			count, countErr := publishCompletedOperation(operation, callerBuffer)
			return count, joinHostControlErrors(completionErr, countErr)
		case uint32(windows.WAIT_TIMEOUT):
			continue
		default:
			operation.completed = false
			return 0, fmt.Errorf("HostControl overlapped I/O wait returned status 0x%x", status)
		}
	}
}

func newHostControlOperation(
	state *connectionState,
	handle windows.Handle,
	callerBuffer []byte,
	event windows.Handle,
	finish func(),
	reading bool,
) *hostControlOperation {
	kernelBuffer := make([]byte, len(callerBuffer))
	if !reading {
		copy(kernelBuffer, callerBuffer)
	}
	operation := &hostControlOperation{
		state:     state,
		handle:    handle,
		buffer:    kernelBuffer,
		event:     event,
		finish:    finish,
		reading:   reading,
		completed: true,
	}
	operation.overlapped.HEvent = event
	operation.pinner.Pin(&operation.overlapped)
	operation.pinner.Pin(&operation.buffer[0])
	operation.pinned = true
	return operation
}

func (state *connectionState) beginOperation() (windows.Handle, func(), error) {
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.fatal != nil || state.quarantined {
		return 0, func() {}, errors.Join(errHostControlIOUnresolvedFatal, state.fatal)
	}
	if state.handle == 0 || state.closing {
		return 0, func() {}, ErrClosed
	}
	if state.terminal != nil {
		return 0, func() {}, state.terminal
	}
	return state.handle, state.active.begin(), nil
}

func (state *connectionState) createOperationEvent() (windows.Handle, error) {
	releaseNative, gateErr := state.quarantineOrDefault().beginNativeUse()
	if gateErr != nil {
		return 0, state.quarantineOwner(state, gateErr, false)
	}
	createEvent := state.createEvent
	if createEvent == nil {
		createEvent = windows.CreateEvent
	}
	event, callErr := createEvent(nil, 1, 0, nil)
	releaseNative((callErr != nil && event != 0) || (callErr == nil && (event == 0 || event == windows.InvalidHandle)))
	if callErr != nil {
		if event != 0 {
			owner := &hostControlRawHandleOwner{state: state, kind: "untrusted HostControl I/O event", value: event}
			return 0, errors.Join(callErr, state.quarantineOwner(owner, callErr, false))
		}
		return 0, callErr
	}
	if event == 0 {
		return 0, errors.New("CreateEvent returned a null HostControl I/O event")
	}
	if event == windows.InvalidHandle {
		owner := &hostControlRawHandleOwner{state: state, kind: "invalid HostControl I/O event", value: event}
		return 0, state.quarantineOwner(owner, windows.ERROR_INVALID_HANDLE, false)
	}
	return event, nil
}

func (state *connectionState) submitOperation(operation *hostControlOperation) error {
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.fatal != nil || state.quarantined {
		operation.forcedQuarantine.Store(true)
		return errors.Join(errHostControlIOUnresolvedFatal, state.fatal)
	}
	if state.handle == 0 || state.handle != operation.handle || state.closing || state.terminal != nil {
		return ErrClosed
	}
	state.operations[operation] = struct{}{}
	operation.submitted = true
	operation.completed = false
	releaseNative, gateErr := state.quarantineOrDefault().beginNativeUse()
	if gateErr != nil {
		operation.forcedQuarantine.Store(true)
		state.markFatalLocked(gateErr)
		return gateErr
	}
	var err error
	if operation.reading {
		readFile := state.readFile
		if readFile == nil {
			readFile = windows.ReadFile
		}
		err = readFile(operation.handle, operation.buffer, &operation.transferred, &operation.overlapped)
	} else {
		writeFile := state.writeFile
		if writeFile == nil {
			writeFile = windows.WriteFile
		}
		err = writeFile(operation.handle, operation.buffer, &operation.transferred, &operation.overlapped)
	}
	runtime.KeepAlive(operation)
	releaseNative(errors.Is(err, windows.ERROR_INVALID_HANDLE))
	if errors.Is(err, windows.ERROR_INVALID_HANDLE) {
		operation.pipeTombstoned = true
		operation.forcedQuarantine.Store(true)
		if state.handle == operation.handle {
			state.handle = 0
		}
		state.markFatalLocked(err)
	}
	return err
}

func (state *connectionState) waitForOperation(
	operation *hostControlOperation,
	timeout time.Duration,
) (uint32, error) {
	waitForSingleObject := state.waitForSingleObject
	if waitForSingleObject == nil {
		waitForSingleObject = windows.WaitForSingleObject
	}
	releaseNative, gateErr := state.quarantineOrDefault().beginNativeUse()
	if gateErr != nil {
		operation.forcedQuarantine.Store(true)
		state.mergeFatal(gateErr)
		return 0, gateErr
	}
	status, err := waitForSingleObject(operation.event, durationMilliseconds(timeout))
	releaseNative(err != nil || (status != windows.WAIT_OBJECT_0 && status != uint32(windows.WAIT_TIMEOUT)))
	runtime.KeepAlive(operation)
	if errors.Is(err, windows.ERROR_INVALID_HANDLE) {
		operation.eventTombstoned = true
		operation.forcedQuarantine.Store(true)
		state.mergeFatal(err)
	}
	return status, err
}

func (state *connectionState) completeOperation(
	operation *hostControlOperation,
) (bool, error) {
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.fatal != nil || state.handle == 0 || state.handle != operation.handle || operation.pipeTombstoned {
		operation.forcedQuarantine.Store(true)
		if state.fatal != nil {
			return false, state.fatal
		}
		return false, errHostControlIOUnresolvedFatal
	}
	releaseNative, gateErr := state.quarantineOrDefault().beginNativeUse()
	if gateErr != nil {
		operation.forcedQuarantine.Store(true)
		state.markFatalLocked(gateErr)
		return false, gateErr
	}
	getResult := state.getOverlappedResult
	if getResult == nil {
		getResult = windows.GetOverlappedResult
	}
	err := getResult(operation.handle, &operation.overlapped, &operation.transferred, false)
	runtime.KeepAlive(operation)
	completed, classifiedErr := classifyHostControlStreamCompletion(err)
	releaseNative(!completed)
	if errors.Is(classifiedErr, windows.ERROR_INVALID_HANDLE) {
		operation.pipeTombstoned = true
		operation.forcedQuarantine.Store(true)
		if state.handle == operation.handle {
			state.handle = 0
		}
		state.markFatalLocked(classifiedErr)
	}
	return completed, classifiedErr
}

func (state *connectionState) cancelAndComplete(
	operation *hostControlOperation,
	timeout time.Duration,
) (bool, error) {
	state.mu.Lock()
	if state.fatal != nil || state.handle == 0 || state.handle != operation.handle || operation.pipeTombstoned {
		operation.forcedQuarantine.Store(true)
		fatal := state.fatal
		state.mu.Unlock()
		return false, errors.Join(errHostControlIOUnresolvedFatal, fatal)
	}
	cancelOperation := state.cancelOperation
	if cancelOperation == nil {
		cancelOperation = windows.CancelIoEx
	}
	releaseNative, gateErr := state.quarantineOrDefault().beginNativeUse()
	if gateErr != nil {
		operation.forcedQuarantine.Store(true)
		state.markFatalLocked(gateErr)
		state.mu.Unlock()
		return false, gateErr
	}
	cancelErr := cancelOperation(operation.handle, &operation.overlapped)
	releaseNative(errors.Is(cancelErr, windows.ERROR_INVALID_HANDLE))
	runtime.KeepAlive(operation)
	if errors.Is(cancelErr, windows.ERROR_INVALID_HANDLE) {
		operation.pipeTombstoned = true
		operation.forcedQuarantine.Store(true)
		if state.handle == operation.handle {
			state.handle = 0
		}
		state.markFatalLocked(cancelErr)
		state.mu.Unlock()
		return false, cancelErr
	}
	state.mu.Unlock()
	if errors.Is(cancelErr, windows.ERROR_NOT_FOUND) {
		cancelErr = nil
	}
	completed, completionErr := state.waitForTerminalCompletion(operation, timeout)
	if completed && errors.Is(completionErr, windows.ERROR_OPERATION_ABORTED) {
		completionErr = nil
	}
	return completed, errors.Join(cancelErr, completionErr)
}

func (state *connectionState) waitForTerminalCompletion(
	operation *hostControlOperation,
	timeout time.Duration,
) (bool, error) {
	status, waitErr := state.waitForOperation(operation, timeout)
	if waitErr != nil {
		return false, waitErr
	}
	switch status {
	case windows.WAIT_OBJECT_0:
		return state.completeOperation(operation)
	case uint32(windows.WAIT_TIMEOUT):
		return false, ErrCloseTimeout
	default:
		return false, fmt.Errorf("wait for cancelled HostControl I/O returned status 0x%x", status)
	}
}

func (state *connectionState) releaseCompletedOperation(operation *hostControlOperation) error {
	closeHandle := state.closeHandle
	if closeHandle == nil {
		closeHandle = windows.CloseHandle
	}
	event := operation.event
	operation.event = 0
	owner := &hostControlDetachedHandleOwner{kind: "HostControl I/O event", value: event}
	quarantine := state.quarantineOrDefault()
	releaseNative, gateErr := quarantine.beginNativeUse()
	if gateErr != nil {
		operation.forcedQuarantine.Store(true)
		return errors.Join(
			quarantine.retain(owner, gateErr),
			state.quarantineOperation(operation, gateErr),
		)
	}
	eventCloseErr := closeHandle(event)
	releaseNative(eventCloseErr != nil)
	runtime.KeepAlive(operation)
	if eventCloseErr != nil {
		operation.eventTombstoned = true
		operation.forcedQuarantine.Store(true)
		wrapped := fmt.Errorf("close HostControl I/O event: %w", eventCloseErr)
		return errors.Join(
			quarantine.retain(owner, wrapped),
			state.quarantineOperation(operation, wrapped),
		)
	}
	state.mu.Lock()
	_, registered := state.operations[operation]
	if operation.submitted && registered {
		delete(state.operations, operation)
	}
	var invariantErr error
	if operation.submitted && !registered {
		invariantErr = errors.New("HostControl I/O completion ownership changed")
		state.markFatalLocked(invariantErr)
	}
	state.mu.Unlock()
	if invariantErr != nil {
		operation.forcedQuarantine.Store(true)
		return state.quarantineOperation(operation, invariantErr)
	}

	operation.pinner.Unpin()
	operation.pinned = false
	operation.finish()
	operation.finish = nil
	operation.buffer = nil
	operation.state = nil
	return nil
}

func (state *connectionState) quarantineIncompleteOperation(
	operation *hostControlOperation,
	cause error,
) error {
	if cause == nil {
		cause = errors.New("HostControl I/O completion state is unknown")
	}
	return state.quarantineOperation(operation, cause)
}

func (state *connectionState) quarantineOperation(
	operation *hostControlOperation,
	cause error,
) error {
	quarantine := state.quarantineOrDefault()
	quarantine.poisoned.Store(true)
	state.mu.Lock()
	if operation.pipeTombstoned && state.handle == operation.handle {
		state.handle = 0
	}
	if !operation.quarantined {
		operation.quarantined = true
		state.markFatalLocked(cause)
	}
	localFatal := state.fatal
	state.mu.Unlock()
	retained := quarantine.retain(operation, errors.Join(cause, localFatal))
	state.mergeFatal(retained)
	return state.currentFailure()
}

func (state *connectionState) quarantineOwner(owner any, cause error, pipeTombstoned bool) error {
	quarantine := state.quarantineOrDefault()
	quarantine.poisoned.Store(true)
	state.mu.Lock()
	if pipeTombstoned {
		state.handle = 0
	}
	state.markFatalLocked(cause)
	localFatal := state.fatal
	state.mu.Unlock()
	retained := quarantine.retain(owner, errors.Join(cause, localFatal))
	state.mergeFatal(retained)
	return state.currentFailure()
}

func (state *connectionState) quarantineOrDefault() *hostControlLifetimeQuarantine {
	if state.quarantine != nil {
		return state.quarantine
	}
	return windowsHostControlQuarantine
}

func (state *connectionState) markFatalLocked(cause error) error {
	state.quarantined = true
	state.closing = true
	state.fatal = errors.Join(state.fatal, errHostControlIOUnresolvedFatal, cause)
	for operation := range state.operations {
		operation.forcedQuarantine.Store(true)
		operation.cancelRequested.Store(true)
	}
	return state.fatal
}

func (state *connectionState) mergeFatal(cause error) {
	if cause == nil {
		return
	}
	state.mu.Lock()
	state.markFatalLocked(cause)
	state.mu.Unlock()
}

func (state *connectionState) currentFailure() error {
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.fatal != nil {
		return state.fatal
	}
	return state.terminal
}

func classifyHostControlConnectCompletion(err error) (bool, error) {
	if err == nil ||
		errors.Is(err, windows.ERROR_OPERATION_ABORTED) ||
		errors.Is(err, windows.ERROR_PIPE_CONNECTED) ||
		errors.Is(err, windows.ERROR_BROKEN_PIPE) ||
		errors.Is(err, windows.ERROR_NO_DATA) ||
		errors.Is(err, windows.ERROR_PIPE_NOT_CONNECTED) {
		return true, err
	}
	return false, err
}

func classifyHostControlStreamCompletion(err error) (bool, error) {
	if err == nil ||
		errors.Is(err, windows.ERROR_OPERATION_ABORTED) ||
		errors.Is(err, windows.ERROR_BROKEN_PIPE) ||
		errors.Is(err, windows.ERROR_NO_DATA) ||
		errors.Is(err, windows.ERROR_PIPE_NOT_CONNECTED) {
		return true, err
	}
	return false, err
}

func publishCompletedOperation(
	operation *hostControlOperation,
	callerBuffer []byte,
) (int, error) {
	if operation.transferred > uint32(len(callerBuffer)) {
		return 0, errors.New("HostControl I/O returned an invalid byte count")
	}
	count := int(operation.transferred)
	if operation.reading && count > 0 {
		copy(callerBuffer[:count], operation.buffer[:count])
	}
	return count, nil
}

func joinHostControlErrors(values ...error) error {
	nonNil := make([]error, 0, len(values))
	for _, value := range values {
		if value != nil {
			nonNil = append(nonNil, value)
		}
	}
	switch len(nonNil) {
	case 0:
		return nil
	case 1:
		return nonNil[0]
	default:
		return errors.Join(nonNil...)
	}
}

type hostControlRawHandleOwner struct {
	state *connectionState
	kind  string
	value windows.Handle
}

type hostControlDetachedHandleOwner struct {
	kind  string
	value windows.Handle
}

func (c *Connection) stateErrorLocked() error {
	if c == nil || c.state == nil {
		return ErrClosed
	}
	state := c.state
	if state.fatal != nil || state.quarantined {
		return errors.Join(errHostControlIOUnresolvedFatal, state.fatal)
	}
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

func (c *Connection) markTerminal(cause error) error {
	return c.markTerminalAfterPublication(cause, nil)
}

func (c *Connection) markTerminalAfterPublication(cause error, finishPublication func()) error {
	finish := func() {
		if finishPublication != nil {
			finishPublication()
			finishPublication = nil
		}
	}
	if c == nil || c.state == nil || cause == nil {
		finish()
		return cause
	}
	state := c.state
	state.mu.Lock()
	if state.fatal != nil || state.quarantined {
		fatal := state.fatal
		state.mu.Unlock()
		finish()
		return errors.Join(cause, errHostControlIOUnresolvedFatal, fatal)
	}
	if state.terminal == nil {
		state.terminal = cause
	} else if state.terminal != cause {
		state.terminal = errors.Join(state.terminal, cause)
	}
	for operation := range state.operations {
		operation.cancelRequested.Store(true)
	}
	if state.handle != 0 && !state.closing {
		releaseNative, gateErr := state.quarantineOrDefault().beginNativeUse()
		if gateErr != nil {
			state.markFatalLocked(gateErr)
			localFatal := state.fatal
			state.mu.Unlock()
			retained := state.quarantineOrDefault().retain(state, localFatal)
			state.mergeFatal(retained)
			finish()
			return state.currentFailure()
		}
		cancelErr := state.cancelIO(state.handle)
		releaseNative(errors.Is(cancelErr, windows.ERROR_INVALID_HANDLE))
		if cancelErr != nil && !errors.Is(cancelErr, windows.ERROR_NOT_FOUND) {
			wrapped := fmt.Errorf("cancel HostControl I/O after failure: %w", cancelErr)
			state.terminal = errors.Join(state.terminal, wrapped)
			if errors.Is(cancelErr, windows.ERROR_INVALID_HANDLE) {
				state.handle = 0
				state.markFatalLocked(wrapped)
				localFatal := state.fatal
				state.mu.Unlock()
				retained := state.quarantineOrDefault().retain(state, localFatal)
				state.mergeFatal(retained)
				finish()
				return state.currentFailure()
			}
		}
	}
	result := state.terminal
	state.mu.Unlock()
	finish()
	deadline := time.Now().Add(state.options.CloseTimeout)
	if !state.active.wait(time.Until(deadline)) {
		if failure := state.currentFailure(); errors.Is(failure, errHostControlIOUnresolvedFatal) {
			return errors.Join(result, failure)
		}
		return errors.Join(
			result,
			state.quarantineOwner(
				state,
				errors.New("HostControl terminal publication did not settle active I/O"),
				false,
			),
		)
	}
	if !state.publish.wait(time.Until(deadline)) {
		if failure := state.currentFailure(); errors.Is(failure, errHostControlIOUnresolvedFatal) {
			return errors.Join(result, failure)
		}
		return errors.Join(
			result,
			state.quarantineOwner(
				state,
				errors.New("HostControl terminal error publication did not settle"),
				false,
			),
		)
	}
	return state.currentFailure()
}

// Close cancels and drains active I/O. DisconnectNamedPipe failures preserve a
// callable handle for retry. A CloseHandle attempt consumes the callable slot,
// and any close failure quarantines the detached owner. Copied Connection values
// share the same close state.
func (c *Connection) Close() error {
	if c == nil || c.state == nil {
		return nil
	}
	state := c.state
	state.closeMu.Lock()
	defer state.closeMu.Unlock()

	state.mu.Lock()
	if state.fatal != nil || state.quarantined {
		fatal := state.fatal
		state.mu.Unlock()
		return errors.Join(errHostControlIOUnresolvedFatal, fatal)
	}
	state.mu.Unlock()
	if fatal := state.quarantineOrDefault().fatalError(); fatal != nil {
		return state.quarantineOwner(state, fatal, false)
	}
	state.mu.Lock()
	if state.handle == 0 {
		state.mu.Unlock()
		return nil
	}
	state.closing = true
	handle := state.handle
	for operation := range state.operations {
		operation.cancelRequested.Store(true)
	}
	state.mu.Unlock()

	releaseNative, gateErr := state.quarantineOrDefault().beginNativeUse()
	if gateErr != nil {
		return state.quarantineOwner(state, gateErr, false)
	}
	cancelErr := state.cancelIO(handle)
	releaseNative(errors.Is(cancelErr, windows.ERROR_INVALID_HANDLE))
	if errors.Is(cancelErr, windows.ERROR_INVALID_HANDLE) {
		return state.quarantineOwner(state, fmt.Errorf("cancel HostControl connection I/O: %w", cancelErr), true)
	}
	if errors.Is(cancelErr, windows.ERROR_NOT_FOUND) {
		cancelErr = nil
	}
	if !state.active.wait(state.options.CloseTimeout) {
		state.mu.Lock()
		fatal := state.fatal
		state.mu.Unlock()
		if fatal != nil {
			return errors.Join(cancelErr, fatal)
		}
		return errors.Join(cancelErr, state.quarantineOwner(state, ErrCloseTimeout, false))
	}
	if cancelErr != nil {
		return fmt.Errorf("cancel HostControl connection I/O: %w", cancelErr)
	}
	state.mu.Lock()
	if state.fatal != nil || state.quarantined {
		fatal := state.fatal
		state.mu.Unlock()
		return errors.Join(errHostControlIOUnresolvedFatal, fatal)
	}
	if state.handle != handle {
		state.mu.Unlock()
		return ErrClosed
	}
	if len(state.operations) != 0 {
		state.mu.Unlock()
		return state.quarantineOwner(
			state,
			errors.New("HostControl close observed unreleased I/O operations"),
			false,
		)
	}
	releaseNative, gateErr = state.quarantineOrDefault().beginNativeUse()
	if gateErr != nil {
		state.mu.Unlock()
		return state.quarantineOwner(state, gateErr, false)
	}
	disconnectErr := state.disconnect(handle)
	releaseNative(errors.Is(disconnectErr, windows.ERROR_INVALID_HANDLE))
	if errors.Is(disconnectErr, windows.ERROR_PIPE_NOT_CONNECTED) ||
		errors.Is(disconnectErr, windows.ERROR_NO_DATA) {
		disconnectErr = nil
	}
	if disconnectErr != nil {
		state.mu.Unlock()
		if errors.Is(disconnectErr, windows.ERROR_INVALID_HANDLE) {
			return state.quarantineOwner(
				state,
				fmt.Errorf("disconnect HostControl connection: %w", disconnectErr),
				true,
			)
		}
		return fmt.Errorf("disconnect HostControl connection: %w", disconnectErr)
	}
	owner := &hostControlRawHandleOwner{state: state, kind: "HostControl connection pipe", value: handle}
	state.handle = 0
	releaseNative, gateErr = state.quarantineOrDefault().beginNativeUse()
	if gateErr != nil {
		state.mu.Unlock()
		return state.quarantineOwner(owner, gateErr, true)
	}
	closeErr := state.closeHandle(handle)
	releaseNative(closeErr != nil)
	if closeErr != nil {
		state.mu.Unlock()
		return state.quarantineOwner(
			owner,
			fmt.Errorf("close HostControl connection handle: %w", closeErr),
			true,
		)
	}
	state.mu.Unlock()
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

func operationCleanupGrace(closeTimeout time.Duration) time.Duration {
	if closeTimeout <= 0 {
		return time.Second
	}
	return min(closeTimeout, maximumOperationCleanupGrace)
}

func closeRejectedHostControlHandle(
	label string,
	handle windows.Handle,
	quarantine *hostControlLifetimeQuarantine,
) error {
	return closeRejectedHostControlHandleUsing(label, handle, quarantine, windows.CloseHandle)
}

func closeRejectedHostControlHandleUsing(
	label string,
	handle windows.Handle,
	quarantine *hostControlLifetimeQuarantine,
	closeHandle func(windows.Handle) error,
) error {
	if handle == 0 {
		return nil
	}
	owner := &hostControlDetachedHandleOwner{kind: label, value: handle}
	if handle == windows.InvalidHandle {
		return quarantine.retain(owner, windows.ERROR_INVALID_HANDLE)
	}
	releaseNative, gateErr := quarantine.beginNativeUse()
	if gateErr != nil {
		return quarantine.retain(owner, gateErr)
	}
	closeErr := closeHandle(handle)
	releaseNative(closeErr != nil)
	if closeErr == nil {
		return nil
	}
	failure := fmt.Errorf("%s: %w", label, closeErr)
	return errors.Join(failure, quarantine.retain(owner, failure))
}

var (
	_ io.ReadWriteCloser = (*Connection)(nil)
	_ clientPIDObserver  = listenerPIDObserver{}
)
