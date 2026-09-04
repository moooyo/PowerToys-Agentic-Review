//go:build windows

package hostcontrol

import (
	"bytes"
	"context"
	"errors"
	"io"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
	"golang.org/x/sys/windows"
)

var windowsContractQuarantineRoots struct {
	sync.Mutex
	values []*hostControlLifetimeQuarantine
}

func rootWindowsContractQuarantine(quarantine *hostControlLifetimeQuarantine) {
	windowsContractQuarantineRoots.Lock()
	windowsContractQuarantineRoots.values = append(windowsContractQuarantineRoots.values, quarantine)
	windowsContractQuarantineRoots.Unlock()
}

func quarantineRetainsHandle(quarantine *hostControlLifetimeQuarantine, handle windows.Handle) bool {
	quarantine.mu.RLock()
	defer quarantine.mu.RUnlock()
	for _, owner := range quarantine.owners {
		switch retained := owner.(type) {
		case *hostControlDetachedHandleOwner:
			if retained.value == handle {
				return true
			}
		case *hostControlRawHandleOwner:
			if retained.value == handle {
				return true
			}
		}
	}
	return false
}

func TestWindowsPipeContractIsByteModeFirstInstanceAndRemoteRejecting(t *testing.T) {
	wantOpenMode := pipeAccessDuplex | fileFlagFirstPipeInstance | fileFlagOverlapped | readControl
	if serverOpenMode != wantOpenMode {
		t.Fatalf("server open mode = 0x%x, want 0x%x", serverOpenMode, wantOpenMode)
	}
	if serverPipeMode != pipeRejectRemoteClients {
		t.Fatalf("server pipe mode = 0x%x, want byte-mode PIPE_REJECT_REMOTE_CLIENTS", serverPipeMode)
	}
	if maximumServerInstances != 1 {
		t.Fatalf("server instances = %d, want 1", maximumServerInstances)
	}
	var _ io.ReadWriteCloser = (*Connection)(nil)
}

func TestWindowsReadEOFNormalizationRequiresExactZeroBytePipeEOF(t *testing.T) {
	connection := &Connection{}
	cleanupFailure := errors.New("cleanup failed")
	for _, pipeErr := range []error{
		windows.ERROR_BROKEN_PIPE,
		windows.ERROR_NO_DATA,
		windows.ERROR_PIPE_NOT_CONNECTED,
	} {
		if normalized := connection.normalizeOperationError(pipeErr, true, 0); normalized != io.EOF {
			t.Fatalf("exact zero-byte pipe error normalized to %v, want literal EOF", normalized)
		}
		for _, mutation := range []struct {
			name        string
			err         error
			transferred uint32
		}{
			{name: "wrapped", err: errors.Join(pipeErr)},
			{name: "cleanup", err: errors.Join(pipeErr, cleanupFailure)},
			{name: "transferred", err: pipeErr, transferred: 1},
		} {
			t.Run(mutation.name, func(t *testing.T) {
				normalized := connection.normalizeOperationError(
					mutation.err,
					true,
					mutation.transferred,
				)
				if normalized == io.EOF {
					t.Fatal("mutated pipe failure normalized to literal EOF")
				}
				if mutation.name == "cleanup" && !errors.Is(normalized, cleanupFailure) {
					t.Fatalf("cleanup failure was lost: %v", normalized)
				}
			})
		}
	}
}

func TestWindowsConnectionZeroValueIsClosed(t *testing.T) {
	var connection Connection
	if evidence := connection.Evidence(); evidence != (VerificationEvidence{}) {
		t.Fatalf("zero Connection evidence = %+v", evidence)
	}
	if bootstrap := connection.CommittedRuntimeBootstrap(); bootstrap != (localrpc.CommittedRuntimeBootstrap{}) {
		t.Fatal("zero Connection returned committed bootstrap authority")
	}
	if _, err := connection.ReadContext(context.Background(), make([]byte, 1)); !errors.Is(err, ErrClosed) {
		t.Fatalf("zero Connection ReadContext error = %v, want ErrClosed", err)
	}
	if _, err := connection.WriteContext(context.Background(), []byte{1}); !errors.Is(err, ErrClosed) {
		t.Fatalf("zero Connection WriteContext error = %v, want ErrClosed", err)
	}
	if _, err := connection.Read(make([]byte, 1)); !errors.Is(err, ErrClosed) {
		t.Fatalf("zero Connection Read error = %v, want ErrClosed", err)
	}
	if _, err := connection.Write([]byte{1}); !errors.Is(err, ErrClosed) {
		t.Fatalf("zero Connection Write error = %v, want ErrClosed", err)
	}
	if err := connection.normalizeOperationError(windows.ERROR_OPERATION_ABORTED, true, 0); !errors.Is(err, ErrClosed) {
		t.Fatalf("zero Connection operation error = %v, want ErrClosed", err)
	}
	connection.markTerminal(errors.New("ignored terminal cause"))
	connection.setCommittedRuntimeBootstrap(localrpc.CommittedRuntimeBootstrap{})
	if err := connection.Close(); err != nil {
		t.Fatalf("zero Connection Close error = %v", err)
	}
}

func TestWindowsBootstrapContextUsesEarlierListenerOrIODeadline(t *testing.T) {
	now := time.Now()
	listenerLater := now.Add(time.Second)
	ioContext, cancelIO := boundedBootstrapContext(
		context.Background(),
		listenerLater,
		25*time.Millisecond,
	)
	ioDeadline, ok := ioContext.Deadline()
	if !ok || !ioDeadline.Before(listenerLater) {
		cancelIO()
		t.Fatalf("I/O-bounded bootstrap deadline = %v, want before %v", ioDeadline, listenerLater)
	}
	cancelIO()

	listenerEarlier := time.Now().Add(50 * time.Millisecond)
	listenerContext, cancelListener := boundedBootstrapContext(
		context.Background(),
		listenerEarlier,
		time.Second,
	)
	listenerDeadline, ok := listenerContext.Deadline()
	if !ok || !listenerDeadline.Equal(listenerEarlier) {
		cancelListener()
		t.Fatalf("listener-bounded bootstrap deadline = %v, want %v", listenerDeadline, listenerEarlier)
	}
	cancelListener()
}

func TestWindowsAcceptEarlyFailuresTerminateAndCloseProvidedNode(t *testing.T) {
	tests := []struct {
		name        string
		listener    *Listener
		ctx         context.Context
		wantPrimary error
	}{
		{
			name:     "cancelled entry",
			listener: &Listener{},
			ctx: func() context.Context {
				ctx, cancel := context.WithCancelCause(context.Background())
				cancel(context.Canceled)
				return ctx
			}(),
			wantPrimary: context.Canceled,
		},
		{name: "nil context", listener: &Listener{}, ctx: nil},
		{name: "begin accept failure", listener: &Listener{}, ctx: context.Background(), wantPrimary: ErrClosed},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			node := newFakeRetainedNode(testNodeIdentity())
			owner, err := test.listener.Accept(test.ctx, node)
			primaryMatches := test.wantPrimary == nil || errors.Is(err, test.wantPrimary)
			if owner != nil || !primaryMatches || !node.terminated || !node.closed {
				t.Fatalf(
					"Accept = (%p, %v), terminated=%v closed=%v, want nil owner with primary %v",
					owner,
					err,
					node.terminated,
					node.closed,
					test.wantPrimary,
				)
			}
		})
	}
}

func TestWindowsReadContextUsesCallerDeadlineWhileReadUsesDefaultTimeout(t *testing.T) {
	const handle = windows.Handle(77)
	options := Options{IOTimeout: 20 * time.Millisecond, CloseTimeout: time.Second}
	connection := newConnection(handle, options, VerificationEvidence{})
	<-connection.state.readGate
	defer releaseGate(connection.state.readGate)

	ctx, cancel := context.WithCancelCause(context.Background())
	contextResult := make(chan error, 1)
	go func() {
		_, err := connection.ReadContext(ctx, make([]byte, 1))
		contextResult <- err
	}()
	select {
	case err := <-contextResult:
		t.Fatalf("ReadContext used Options.IOTimeout instead of caller context: %v", err)
	case <-time.After(4 * options.IOTimeout):
	}
	cause := errors.New("caller stopped HostControl read")
	cancel(cause)
	select {
	case err := <-contextResult:
		if !errors.Is(err, cause) || errors.Is(err, ErrIOTimeout) {
			t.Fatalf("ReadContext cancellation error = %v, want only caller cause", err)
		}
	case <-time.After(time.Second):
		t.Fatal("ReadContext did not observe caller cancellation")
	}

	readResult := make(chan error, 1)
	go func() {
		_, err := connection.Read(make([]byte, 1))
		readResult <- err
	}()
	select {
	case err := <-readResult:
		if !errors.Is(err, ErrIOTimeout) {
			t.Fatalf("Read default timeout error = %v, want ErrIOTimeout", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Read did not apply Options.IOTimeout")
	}
}

func TestWindowsConnectionOperationsUsePinnedBounceBuffers(t *testing.T) {
	t.Run("read publishes only after completion", func(t *testing.T) {
		const pipeHandle = windows.Handle(800)
		const eventHandle = windows.Handle(801)
		quarantine := &hostControlLifetimeQuarantine{}
		connection := newInjectedIOConnection(pipeHandle, eventHandle, quarantine)
		caller := []byte{0x11}
		var operation *hostControlOperation
		connection.state.readFile = func(
			handle windows.Handle,
			kernelBuffer []byte,
			_ *uint32,
			overlapped *windows.Overlapped,
		) error {
			operation = onlyHostControlOperation(connection.state)
			if handle != pipeHandle || overlapped != &operation.overlapped || &kernelBuffer[0] == &caller[0] {
				return errors.New("ReadFile did not receive the operation-owned buffer")
			}
			return windows.ERROR_IO_PENDING
		}
		connection.state.waitForSingleObject = func(handle windows.Handle, _ uint32) (uint32, error) {
			if handle != eventHandle {
				return 0, errors.New("unexpected read event")
			}
			runtime.GC()
			return windows.WAIT_OBJECT_0, nil
		}
		connection.state.getOverlappedResult = func(
			handle windows.Handle,
			overlapped *windows.Overlapped,
			transferred *uint32,
			wait bool,
		) error {
			if handle != pipeHandle || wait || overlapped != &operation.overlapped {
				return errors.New("unexpected read completion arguments")
			}
			operation.buffer[0] = 0x7a
			*transferred = 1
			return nil
		}
		closeCalls := 0
		connection.state.closeHandle = func(handle windows.Handle) error {
			closeCalls++
			if handle != eventHandle {
				return errors.New("unexpected completed read handle")
			}
			return nil
		}

		count, err := connection.ReadContext(context.Background(), caller)
		if err != nil || count != 1 || caller[0] != 0x7a {
			t.Fatalf("ReadContext = (%d, %v), caller=%x", count, err, caller)
		}
		if operation == nil || operation.pinned || operation.buffer != nil ||
			closeCalls != 1 || quarantine.count() != 0 || len(connection.state.operations) != 0 {
			t.Fatalf("completed read operation=%#v close=%d quarantine=%d active=%d", operation, closeCalls, quarantine.count(), len(connection.state.operations))
		}
	})

	t.Run("write clones before submission", func(t *testing.T) {
		const pipeHandle = windows.Handle(810)
		const eventHandle = windows.Handle(811)
		quarantine := &hostControlLifetimeQuarantine{}
		connection := newInjectedIOConnection(pipeHandle, eventHandle, quarantine)
		caller := []byte{0x21}
		var operation *hostControlOperation
		connection.state.writeFile = func(
			_ windows.Handle,
			kernelBuffer []byte,
			_ *uint32,
			_ *windows.Overlapped,
		) error {
			operation = onlyHostControlOperation(connection.state)
			if &kernelBuffer[0] == &caller[0] || kernelBuffer[0] != 0x21 {
				return errors.New("WriteFile did not receive a cloned buffer")
			}
			caller[0] = 0x44
			if kernelBuffer[0] != 0x21 {
				return errors.New("caller mutation changed submitted write bytes")
			}
			return windows.ERROR_IO_PENDING
		}
		connection.state.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
			return windows.WAIT_OBJECT_0, nil
		}
		connection.state.getOverlappedResult = func(
			_ windows.Handle,
			_ *windows.Overlapped,
			transferred *uint32,
			_ bool,
		) error {
			*transferred = 1
			return nil
		}
		connection.state.closeHandle = func(windows.Handle) error { return nil }

		count, err := connection.WriteContext(context.Background(), caller)
		if err != nil || count != 1 || caller[0] != 0x44 {
			t.Fatalf("WriteContext = (%d, %v), caller=%x", count, err, caller)
		}
		if operation == nil || operation.pinned || quarantine.count() != 0 {
			t.Fatalf("completed write operation=%#v quarantine=%d", operation, quarantine.count())
		}
	})
}

func TestWindowsConnectionCancellationQuarantinesUnresolvedOperationWithoutLateCallerWrite(t *testing.T) {
	const pipeHandle = windows.Handle(820)
	const eventHandle = windows.Handle(821)
	quarantine := &hostControlLifetimeQuarantine{}
	connection := newInjectedIOConnection(pipeHandle, eventHandle, quarantine)
	connection.state.cleanupGrace = 10 * time.Millisecond
	caller := []byte{0x31}
	started := make(chan struct{})
	releasePoll := make(chan struct{})
	var startOnce sync.Once
	var operation *hostControlOperation
	connection.state.readFile = func(
		_ windows.Handle,
		_ []byte,
		_ *uint32,
		_ *windows.Overlapped,
	) error {
		operation = onlyHostControlOperation(connection.state)
		return windows.ERROR_IO_PENDING
	}
	connection.state.waitForSingleObject = func(_ windows.Handle, milliseconds uint32) (uint32, error) {
		if milliseconds == durationMilliseconds(connection.state.cleanupGrace) {
			return uint32(windows.WAIT_TIMEOUT), nil
		}
		startOnce.Do(func() { close(started) })
		<-releasePoll
		return uint32(windows.WAIT_TIMEOUT), nil
	}
	cancelCalls := 0
	connection.state.cancelOperation = func(handle windows.Handle, overlapped *windows.Overlapped) error {
		cancelCalls++
		if handle != pipeHandle || operation == nil || overlapped != &operation.overlapped {
			return errors.New("cancel did not target the exact read")
		}
		return nil
	}
	closeCalls := 0
	connection.state.closeHandle = func(windows.Handle) error { closeCalls++; return nil }

	ctx, cancel := context.WithCancelCause(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := connection.ReadContext(ctx, caller)
		result <- err
	}()
	<-started
	cause := errors.New("read cancelled")
	cancel(cause)
	close(releasePoll)
	select {
	case err := <-result:
		if !errors.Is(err, cause) || !errors.Is(err, ErrCloseTimeout) ||
			!errors.Is(err, errHostControlIOUnresolvedFatal) {
			t.Fatalf("unresolved cancellation error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("unresolved cancellation did not return within cleanup grace")
	}
	if operation == nil || !operation.pinned || !operation.quarantined ||
		connection.state.handle != pipeHandle || closeCalls != 0 || cancelCalls != 1 || quarantine.count() != 1 {
		t.Fatalf("operation=%#v handle=%d close=%d cancel=%d quarantine=%d", operation, connection.state.handle, closeCalls, cancelCalls, quarantine.count())
	}
	operation.buffer[0] = 0x99
	runtime.GC()
	if caller[0] != 0x31 {
		t.Fatalf("late completion changed caller buffer to %x", caller)
	}
	if err := connection.Close(); !errors.Is(err, errHostControlIOUnresolvedFatal) || closeCalls != 0 {
		t.Fatalf("Close after unresolved read = %v, close calls=%d", err, closeCalls)
	}
}

func TestWindowsConnectionCancellationCompletionAndInvalidHandle(t *testing.T) {
	t.Run("cancel failure with confirmed completion", func(t *testing.T) {
		cancelFailure := errors.New("CancelIoEx failed")
		quarantine := &hostControlLifetimeQuarantine{}
		connection := newInjectedIOConnection(830, 831, quarantine)
		started := make(chan struct{})
		releasePoll := make(chan struct{})
		var once sync.Once
		connection.state.readFile = func(windows.Handle, []byte, *uint32, *windows.Overlapped) error {
			return windows.ERROR_IO_PENDING
		}
		connection.state.waitForSingleObject = func(_ windows.Handle, milliseconds uint32) (uint32, error) {
			if milliseconds == durationMilliseconds(connection.state.cleanupGrace) {
				return windows.WAIT_OBJECT_0, nil
			}
			once.Do(func() { close(started) })
			<-releasePoll
			return uint32(windows.WAIT_TIMEOUT), nil
		}
		connection.state.cancelOperation = func(windows.Handle, *windows.Overlapped) error { return cancelFailure }
		connection.state.getOverlappedResult = func(windows.Handle, *windows.Overlapped, *uint32, bool) error {
			return windows.ERROR_OPERATION_ABORTED
		}
		connection.state.closeHandle = func(windows.Handle) error { return nil }

		ctx, cancel := context.WithCancelCause(context.Background())
		result := make(chan error, 1)
		go func() { _, err := connection.ReadContext(ctx, make([]byte, 1)); result <- err }()
		<-started
		cause := errors.New("caller cancelled")
		cancel(cause)
		close(releasePoll)
		if err := <-result; !errors.Is(err, cause) || !errors.Is(err, cancelFailure) ||
			errors.Is(err, errHostControlIOUnresolvedFatal) {
			t.Fatalf("confirmed cancellation error = %v", err)
		}
		if quarantine.count() != 0 || len(connection.state.operations) != 0 {
			t.Fatalf("confirmed cancellation quarantine=%d operations=%d", quarantine.count(), len(connection.state.operations))
		}
	})

	t.Run("invalid handle", func(t *testing.T) {
		quarantine := &hostControlLifetimeQuarantine{}
		connection := newInjectedIOConnection(840, 841, quarantine)
		started := make(chan struct{})
		releasePoll := make(chan struct{})
		var once sync.Once
		connection.state.readFile = func(windows.Handle, []byte, *uint32, *windows.Overlapped) error {
			return windows.ERROR_IO_PENDING
		}
		connection.state.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
			once.Do(func() { close(started) })
			<-releasePoll
			return uint32(windows.WAIT_TIMEOUT), nil
		}
		connection.state.cancelOperation = func(windows.Handle, *windows.Overlapped) error {
			return windows.ERROR_INVALID_HANDLE
		}
		closeCalls := 0
		connection.state.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
		ctx, cancel := context.WithCancel(context.Background())
		result := make(chan error, 1)
		go func() { _, err := connection.ReadContext(ctx, make([]byte, 1)); result <- err }()
		<-started
		cancel()
		close(releasePoll)
		if err := <-result; !errors.Is(err, windows.ERROR_INVALID_HANDLE) ||
			!errors.Is(err, errHostControlIOUnresolvedFatal) {
			t.Fatalf("invalid-handle cancellation error = %v", err)
		}
		if connection.state.handle != 0 || closeCalls != 0 || quarantine.count() != 1 {
			t.Fatalf("invalid handle state=%d close=%d quarantine=%d", connection.state.handle, closeCalls, quarantine.count())
		}
	})
}

func TestWindowsConnectionEOFRequiresCleanOperationAndTerminalPublication(t *testing.T) {
	closeFailure := errors.New("event close failed")
	cancelFailure := errors.New("cancel peer operations failed")
	tests := []struct {
		name           string
		pending        bool
		eventCloseErr  error
		terminalCancel error
		want           error
		wantFatal      bool
	}{
		{name: "clean immediate"},
		{name: "clean pending", pending: true},
		{name: "event cleanup failure", eventCloseErr: closeFailure, want: closeFailure, wantFatal: true},
		{name: "terminal cancellation failure", terminalCancel: cancelFailure, want: cancelFailure},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			quarantine := &hostControlLifetimeQuarantine{}
			connection := newInjectedIOConnection(850, 851, quarantine)
			connection.state.readFile = func(windows.Handle, []byte, *uint32, *windows.Overlapped) error {
				if test.pending {
					return windows.ERROR_IO_PENDING
				}
				return windows.ERROR_BROKEN_PIPE
			}
			connection.state.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
				return windows.WAIT_OBJECT_0, nil
			}
			connection.state.getOverlappedResult = func(windows.Handle, *windows.Overlapped, *uint32, bool) error {
				return windows.ERROR_BROKEN_PIPE
			}
			connection.state.closeHandle = func(windows.Handle) error { return test.eventCloseErr }
			connection.state.cancelIO = func(windows.Handle) error {
				if test.terminalCancel != nil {
					return test.terminalCancel
				}
				return windows.ERROR_NOT_FOUND
			}

			count, err := connection.ReadContext(context.Background(), make([]byte, 1))
			if test.want == nil {
				if count != 0 || err != io.EOF {
					t.Fatalf("clean EOF = (%d, %T %v), want literal EOF", count, err, err)
				}
				return
			}
			if count != 0 || err == io.EOF || !errors.Is(err, test.want) {
				t.Fatalf("unclean EOF = (%d, %T %v), want %v", count, err, err, test.want)
			}
			if test.wantFatal != errors.Is(err, errHostControlIOUnresolvedFatal) {
				t.Fatalf("unclean EOF fatal=%v, want %v: %v", errors.Is(err, errHostControlIOUnresolvedFatal), test.wantFatal, err)
			}
			if test.eventCloseErr != nil && (quarantine.count() != 2 || !quarantineRetainsHandle(quarantine, 851)) {
				t.Fatalf("event close quarantine=%d retained event=%v", quarantine.count(), quarantineRetainsHandle(quarantine, 851))
			}
		})
	}
}

func TestWindowsConnectionCloseSettlesExactPendingOperation(t *testing.T) {
	const pipeHandle = windows.Handle(860)
	const eventHandle = windows.Handle(861)
	quarantine := &hostControlLifetimeQuarantine{}
	connection := newInjectedIOConnection(pipeHandle, eventHandle, quarantine)
	pollStarted := make(chan struct{})
	releasePoll := make(chan struct{})
	var once sync.Once
	connection.state.readFile = func(windows.Handle, []byte, *uint32, *windows.Overlapped) error {
		return windows.ERROR_IO_PENDING
	}
	connection.state.waitForSingleObject = func(_ windows.Handle, milliseconds uint32) (uint32, error) {
		if milliseconds == durationMilliseconds(connection.state.cleanupGrace) {
			return windows.WAIT_OBJECT_0, nil
		}
		once.Do(func() { close(pollStarted) })
		<-releasePoll
		return uint32(windows.WAIT_TIMEOUT), nil
	}
	connection.state.cancelOperation = func(windows.Handle, *windows.Overlapped) error { return nil }
	connection.state.getOverlappedResult = func(windows.Handle, *windows.Overlapped, *uint32, bool) error {
		return windows.ERROR_OPERATION_ABORTED
	}
	connection.state.cancelIO = func(windows.Handle) error { return nil }
	connection.state.disconnect = func(windows.Handle) error { return nil }
	eventCloseCalls := 0
	pipeCloseCalls := 0
	connection.state.closeHandle = func(handle windows.Handle) error {
		switch handle {
		case eventHandle:
			eventCloseCalls++
		case pipeHandle:
			pipeCloseCalls++
		default:
			return errors.New("unexpected close handle")
		}
		return nil
	}
	readResult := make(chan error, 1)
	go func() { _, err := connection.ReadContext(context.Background(), make([]byte, 1)); readResult <- err }()
	<-pollStarted
	closeResult := make(chan error, 1)
	go func() { closeResult <- connection.Close() }()
	close(releasePoll)
	if err := <-readResult; !errors.Is(err, ErrClosed) {
		t.Fatalf("read interrupted by Close = %v", err)
	}
	if err := <-closeResult; err != nil {
		t.Fatalf("Close with exact pending read = %v", err)
	}
	if eventCloseCalls != 1 || pipeCloseCalls != 1 || quarantine.count() != 0 || connection.state.handle != 0 {
		t.Fatalf("event close=%d pipe close=%d quarantine=%d handle=%d", eventCloseCalls, pipeCloseCalls, quarantine.count(), connection.state.handle)
	}
}

func TestWindowsPendingConnectCancellationIsBoundedAndPinned(t *testing.T) {
	t.Run("confirmed cancellation", func(t *testing.T) {
		quarantine := &hostControlLifetimeQuarantine{}
		listener := newInjectedPendingListener(870, 871, quarantine)
		listener.cancelOperation = func(windows.Handle, *windows.Overlapped) error { return nil }
		listener.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) { return windows.WAIT_OBJECT_0, nil }
		listener.getOverlappedResult = func(windows.Handle, *windows.Overlapped, *uint32, bool) error {
			return windows.ERROR_OPERATION_ABORTED
		}
		closeCalls := 0
		listener.connectCloseHandle = func(windows.Handle) error { closeCalls++; return nil }
		ctx, cancel := context.WithCancelCause(context.Background())
		cause := errors.New("connect cancelled")
		cancel(cause)
		if err := listener.waitForConnect(ctx); !errors.Is(err, cause) || errors.Is(err, errHostControlIOUnresolvedFatal) {
			t.Fatalf("confirmed connect cancellation = %v", err)
		}
		if listener.pending || listener.event != 0 || listener.connectPinned || closeCalls != 1 || quarantine.count() != 0 {
			t.Fatalf("pending=%v event=%d pinned=%v close=%d quarantine=%d", listener.pending, listener.event, listener.connectPinned, closeCalls, quarantine.count())
		}
	})

	t.Run("unresolved cancellation", func(t *testing.T) {
		quarantine := &hostControlLifetimeQuarantine{}
		listener := newInjectedPendingListener(880, 881, quarantine)
		listener.cancelOperation = func(windows.Handle, *windows.Overlapped) error { return nil }
		listener.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
			return uint32(windows.WAIT_TIMEOUT), nil
		}
		closeCalls := 0
		listener.connectCloseHandle = func(windows.Handle) error { closeCalls++; return nil }
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if err := listener.waitForConnect(ctx); !errors.Is(err, ErrCloseTimeout) ||
			!errors.Is(err, errHostControlIOUnresolvedFatal) {
			t.Fatalf("unresolved connect cancellation = %v", err)
		}
		if !listener.connectPinned || !listener.quarantined || listener.handle != 880 ||
			listener.event != 881 || closeCalls != 0 || quarantine.count() != 1 {
			t.Fatalf("pinned=%v quarantined=%v handle=%d event=%d close=%d owners=%d", listener.connectPinned, listener.quarantined, listener.handle, listener.event, closeCalls, quarantine.count())
		}
		if err := listener.Close(); !errors.Is(err, errHostControlIOUnresolvedFatal) || closeCalls != 0 {
			t.Fatalf("Close after unresolved connect = %v, close calls=%d", err, closeCalls)
		}
	})

	t.Run("invalid handle cancellation", func(t *testing.T) {
		quarantine := &hostControlLifetimeQuarantine{}
		listener := newInjectedPendingListener(890, 891, quarantine)
		listener.cancelOperation = func(windows.Handle, *windows.Overlapped) error {
			return windows.ERROR_INVALID_HANDLE
		}
		waitCalls := 0
		listener.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
			waitCalls++
			return windows.WAIT_OBJECT_0, nil
		}
		closeCalls := 0
		listener.connectCloseHandle = func(windows.Handle) error { closeCalls++; return nil }
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if err := listener.waitForConnect(ctx); !errors.Is(err, windows.ERROR_INVALID_HANDLE) ||
			!errors.Is(err, errHostControlIOUnresolvedFatal) {
			t.Fatalf("invalid connect cancellation = %v", err)
		}
		if listener.handle != 0 || !listener.connectPinned || waitCalls != 0 || closeCalls != 0 || quarantine.count() != 1 {
			t.Fatalf("handle=%d pinned=%v wait=%d close=%d owners=%d", listener.handle, listener.connectPinned, waitCalls, closeCalls, quarantine.count())
		}
	})

	t.Run("event close failure", func(t *testing.T) {
		closeFailure := errors.New("connect event close failed")
		quarantine := &hostControlLifetimeQuarantine{}
		listener := newInjectedPendingListener(900, 901, quarantine)
		listener.cancelOperation = func(windows.Handle, *windows.Overlapped) error { return nil }
		listener.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) { return windows.WAIT_OBJECT_0, nil }
		listener.getOverlappedResult = func(windows.Handle, *windows.Overlapped, *uint32, bool) error {
			return windows.ERROR_OPERATION_ABORTED
		}
		closeCalls := 0
		listener.connectCloseHandle = func(windows.Handle) error {
			closeCalls++
			return closeFailure
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if err := listener.waitForConnect(ctx); !errors.Is(err, closeFailure) ||
			!errors.Is(err, errHostControlIOUnresolvedFatal) {
			t.Fatalf("connect event cleanup error = %v", err)
		}
		if listener.event != 0 || !listener.connectPinned || closeCalls != 1 || quarantine.count() != 2 ||
			!quarantineRetainsHandle(quarantine, 901) {
			t.Fatalf("event=%d pinned=%v close=%d owners=%d", listener.event, listener.connectPinned, closeCalls, quarantine.count())
		}
		if err := listener.Close(); !errors.Is(err, errHostControlIOUnresolvedFatal) || closeCalls != 1 {
			t.Fatalf("Close after consumed event failure = %v, close calls=%d", err, closeCalls)
		}
	})
}

func TestWindowsProcessFatalGatePreventsLaterNativeUse(t *testing.T) {
	quarantine := &hostControlLifetimeQuarantine{}
	fatalCause := errors.New("earlier HostControl operation unresolved")
	_ = quarantine.retain(&hostControlDetachedHandleOwner{kind: "earlier", value: 910}, fatalCause)
	connection := newInjectedIOConnection(911, 912, quarantine)
	createCalls := 0
	connection.state.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
		createCalls++
		return 912, nil
	}
	closeCalls := 0
	connection.state.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
	if _, err := connection.ReadContext(context.Background(), make([]byte, 1)); !errors.Is(err, fatalCause) || !errors.Is(err, errHostControlIOUnresolvedFatal) {
		t.Fatalf("read after process fatal = %v", err)
	}
	if createCalls != 0 {
		t.Fatalf("process fatal allowed %d CreateEvent calls", createCalls)
	}
	if err := connection.Close(); !errors.Is(err, errHostControlIOUnresolvedFatal) || closeCalls != 0 {
		t.Fatalf("Close after process fatal = %v, close calls=%d", err, closeCalls)
	}
}

func TestWindowsNativeGatePoisonClosesAdmissionBeforeFatalPublication(t *testing.T) {
	quarantine := &hostControlLifetimeQuarantine{}
	releaseNative, err := quarantine.beginNativeUse()
	if err != nil {
		t.Fatalf("begin native use = %v", err)
	}
	releaseNative(true)
	if _, err := quarantine.beginNativeUse(); !errors.Is(err, errHostControlIOUnresolvedFatal) {
		t.Fatalf("native admission after poison = %v", err)
	}
	cause := errors.New("publish retained owner")
	if err := quarantine.retain(&hostControlDetachedHandleOwner{kind: "test", value: 920}, cause); !errors.Is(err, cause) {
		t.Fatalf("publish quarantine cause = %v", err)
	}
}

func TestWindowsStreamCompletionRejectsConnectOnlyStatus(t *testing.T) {
	if completed, err := classifyHostControlStreamCompletion(windows.ERROR_PIPE_CONNECTED); completed || !errors.Is(err, windows.ERROR_PIPE_CONNECTED) {
		t.Fatalf("stream completion = (%v, %v), want unresolved ERROR_PIPE_CONNECTED", completed, err)
	}
	if completed, err := classifyHostControlConnectCompletion(windows.ERROR_PIPE_CONNECTED); !completed || !errors.Is(err, windows.ERROR_PIPE_CONNECTED) {
		t.Fatalf("connect completion = (%v, %v), want terminal ERROR_PIPE_CONNECTED", completed, err)
	}
}

func TestWindowsReadQuarantinesConnectOnlyCompletionWithoutUnpinning(t *testing.T) {
	quarantine := &hostControlLifetimeQuarantine{}
	connection := newInjectedIOConnection(925, 926, quarantine)
	var operation *hostControlOperation
	connection.state.readFile = func(windows.Handle, []byte, *uint32, *windows.Overlapped) error {
		operation = onlyHostControlOperation(connection.state)
		return windows.ERROR_IO_PENDING
	}
	connection.state.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
		return windows.WAIT_OBJECT_0, nil
	}
	connection.state.getOverlappedResult = func(windows.Handle, *windows.Overlapped, *uint32, bool) error {
		return windows.ERROR_PIPE_CONNECTED
	}
	connection.state.closeHandle = func(windows.Handle) error {
		t.Fatal("unresolved stream completion closed its event")
		return nil
	}

	if _, err := connection.ReadContext(context.Background(), make([]byte, 1)); !errors.Is(err, windows.ERROR_PIPE_CONNECTED) || !errors.Is(err, errHostControlIOUnresolvedFatal) {
		t.Fatalf("connect-only stream completion = %v", err)
	}
	if operation == nil || !operation.pinned || !operation.quarantined || quarantine.count() != 1 {
		t.Fatalf("operation=%#v pinned/quarantine=%v/%d", operation, operation != nil && operation.pinned, quarantine.count())
	}
}

func TestWindowsInvalidClientPIDHandleTombstonesBeforeCleanup(t *testing.T) {
	const handle = windows.Handle(930)
	quarantine := &hostControlLifetimeQuarantine{}
	rootWindowsContractQuarantine(quarantine)
	cancelCalls, closeCalls := 0, 0
	listener := &Listener{
		handle:     handle,
		options:    Options{CloseTimeout: time.Second},
		quarantine: quarantine,
		clientProcessID: func(windows.Handle, *uint32) error {
			return windows.ERROR_INVALID_HANDLE
		},
		cancelOperation: func(windows.Handle, *windows.Overlapped) error {
			cancelCalls++
			return nil
		},
		connectCloseHandle: func(windows.Handle) error {
			closeCalls++
			return nil
		},
	}
	if _, err := (listenerPIDObserver{listener: listener}).ClientProcessID(); !errors.Is(err, windows.ERROR_INVALID_HANDLE) || !errors.Is(err, errHostControlIOUnresolvedFatal) {
		t.Fatalf("invalid client PID handle error = %v", err)
	}
	if listener.handle != 0 || quarantine.count() != 1 {
		t.Fatalf("invalid PID handle=%d quarantine=%d", listener.handle, quarantine.count())
	}
	if err := listener.Close(); !errors.Is(err, errHostControlIOUnresolvedFatal) || cancelCalls != 0 || closeCalls != 0 {
		t.Fatalf("Close after invalid PID handle = %v, calls=%d/%d", err, cancelCalls, closeCalls)
	}
}

func TestWindowsCleanEOFWaitsForConcurrentTerminalPublication(t *testing.T) {
	quarantine := &hostControlLifetimeQuarantine{}
	connection := newInjectedIOConnection(940, 941, quarantine)
	connection.state.readFile = func(windows.Handle, []byte, *uint32, *windows.Overlapped) error {
		return windows.ERROR_BROKEN_PIPE
	}
	connection.state.closeHandle = func(windows.Handle) error { return nil }
	finishPeerPublication := connection.state.publish.begin()
	result := make(chan error, 1)
	go func() {
		_, err := connection.ReadContext(context.Background(), make([]byte, 1))
		result <- err
	}()

	deadline := time.Now().Add(time.Second)
	for {
		connection.state.mu.Lock()
		publishedEOF := connection.state.terminal == io.EOF
		connection.state.mu.Unlock()
		if publishedEOF {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("clean EOF was not published")
		}
		runtime.Gosched()
	}
	select {
	case err := <-result:
		t.Fatalf("clean EOF escaped before peer publication: %v", err)
	case <-time.After(20 * time.Millisecond):
	}

	cleanupFailure := errors.New("peer cancellation cleanup failed")
	connection.state.mu.Lock()
	connection.state.terminal = errors.Join(connection.state.terminal, cleanupFailure)
	connection.state.mu.Unlock()
	finishPeerPublication()
	select {
	case err := <-result:
		if err == io.EOF || !errors.Is(err, cleanupFailure) {
			t.Fatalf("EOF after peer publication = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("EOF did not finish after peer publication")
	}
}

func TestWindowsListenerCloseHandleFailureIsConsumedOnce(t *testing.T) {
	const handle = windows.Handle(950)
	closeFailure := errors.New("listener CloseHandle failed")
	quarantine := &hostControlLifetimeQuarantine{}
	rootWindowsContractQuarantine(quarantine)
	cancelCalls, closeCalls := 0, 0
	listener := &Listener{
		handle:     handle,
		options:    Options{CloseTimeout: time.Second},
		quarantine: quarantine,
		cancelOperation: func(windows.Handle, *windows.Overlapped) error {
			cancelCalls++
			return windows.ERROR_NOT_FOUND
		},
		connectCloseHandle: func(windows.Handle) error {
			closeCalls++
			return closeFailure
		},
	}
	if err := listener.Close(); !errors.Is(err, closeFailure) || !errors.Is(err, errHostControlIOUnresolvedFatal) {
		t.Fatalf("listener CloseHandle failure = %v", err)
	}
	if listener.handle != 0 || quarantine.count() == 0 || !quarantineRetainsHandle(quarantine, handle) ||
		cancelCalls != 1 || closeCalls != 1 {
		t.Fatalf("consumed listener handle=%d quarantine=%d calls=%d/%d", listener.handle, quarantine.count(), cancelCalls, closeCalls)
	}
	if err := listener.Close(); !errors.Is(err, errHostControlIOUnresolvedFatal) || cancelCalls != 1 || closeCalls != 1 {
		t.Fatalf("repeated listener Close = %v, calls=%d/%d", err, cancelCalls, closeCalls)
	}
}

func TestWindowsRejectedHandleCloseFailureIsAttemptedOnce(t *testing.T) {
	const handle = windows.Handle(960)
	closeFailure := errors.New("rejected handle CloseHandle failed")
	quarantine := &hostControlLifetimeQuarantine{}
	closeCalls := 0
	err := closeRejectedHostControlHandleUsing(
		"close rejected test handle",
		handle,
		quarantine,
		func(got windows.Handle) error {
			closeCalls++
			if got != handle {
				t.Fatalf("close handle = %d, want %d", got, handle)
			}
			return closeFailure
		},
	)
	if !errors.Is(err, closeFailure) || !errors.Is(err, errHostControlIOUnresolvedFatal) || closeCalls != 1 || quarantine.count() != 1 {
		t.Fatalf("rejected close = %v, calls=%d quarantine=%d", err, closeCalls, quarantine.count())
	}
	if _, gateErr := quarantine.beginNativeUse(); !errors.Is(gateErr, errHostControlIOUnresolvedFatal) || closeCalls != 1 {
		t.Fatalf("native use after rejected close = %v, close calls=%d", gateErr, closeCalls)
	}
}

func newInjectedIOConnection(
	pipeHandle windows.Handle,
	eventHandle windows.Handle,
	quarantine *hostControlLifetimeQuarantine,
) *Connection {
	rootWindowsContractQuarantine(quarantine)
	connection := newConnection(
		pipeHandle,
		Options{IOTimeout: time.Second, CloseTimeout: 100 * time.Millisecond},
		VerificationEvidence{},
	)
	connection.state.quarantine = quarantine
	connection.state.cleanupGrace = 20 * time.Millisecond
	connection.state.cancelIO = func(windows.Handle) error { return windows.ERROR_NOT_FOUND }
	connection.state.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
		return eventHandle, nil
	}
	return connection
}

func onlyHostControlOperation(state *connectionState) *hostControlOperation {
	for operation := range state.operations {
		return operation
	}
	return nil
}

func newInjectedPendingListener(
	pipeHandle windows.Handle,
	eventHandle windows.Handle,
	quarantine *hostControlLifetimeQuarantine,
) *Listener {
	rootWindowsContractQuarantine(quarantine)
	listener := &Listener{
		handle:       pipeHandle,
		event:        eventHandle,
		pending:      true,
		deadline:     time.Now().Add(time.Second),
		options:      Options{CloseTimeout: 100 * time.Millisecond},
		quarantine:   quarantine,
		cleanupGrace: 20 * time.Millisecond,
	}
	listener.overlapped.HEvent = eventHandle
	listener.connectPinner.Pin(&listener.overlapped)
	listener.connectPinned = true
	return listener
}

func TestWindowsFailedAcceptCleanupReturnsCopySafeFatalOwner(t *testing.T) {
	const handle = windows.Handle(123)
	connection := newConnection(handle, Options{CloseTimeout: time.Second}, VerificationEvidence{})
	quarantine := &hostControlLifetimeQuarantine{}
	rootWindowsContractQuarantine(quarantine)
	connection.state.quarantine = quarantine
	closeFailure := errors.New("injected CloseHandle failure")
	primary := errors.New("bootstrap failed")
	cancelCalls := 0
	disconnectCalls := 0
	closeCalls := 0
	connection.state.cancelIO = func(got windows.Handle) error {
		cancelCalls++
		if got != handle {
			t.Fatalf("cancel handle = %d, want %d", got, handle)
		}
		return nil
	}
	connection.state.disconnect = func(got windows.Handle) error {
		disconnectCalls++
		if got != handle {
			t.Fatalf("disconnect handle = %d, want %d", got, handle)
		}
		return nil
	}
	connection.state.closeHandle = func(got windows.Handle) error {
		closeCalls++
		if got != handle {
			t.Fatalf("close handle = %d, want %d", got, handle)
		}
		return closeFailure
	}
	node := newFakeRetainedNode(testNodeIdentity())

	owner, err := rejectAcceptFailure(connection, primary, node, func() {
		connection.markTerminal(primary)
	}, connection.Close)
	if owner == nil {
		t.Fatal("failed cleanup discarded the Connection owner")
	}
	if owner != connection || owner.state != connection.state {
		t.Fatalf("failed cleanup returned owner %p with state %p, want %p/%p", owner, owner.state, connection, connection.state)
	}
	if !node.terminated || !errors.Is(err, primary) || !errors.Is(err, closeFailure) {
		t.Fatalf("failed cleanup terminated=%v error=%v", node.terminated, err)
	}
	if connection.state.handle != 0 || cancelCalls != 2 || disconnectCalls != 1 || closeCalls != 1 ||
		quarantine.count() != 1 || !quarantineRetainsHandle(quarantine, handle) ||
		!errors.Is(err, errHostControlIOUnresolvedFatal) {
		t.Fatalf(
			"failed cleanup handle=%d calls cancel/disconnect/close=%d/%d/%d",
			connection.state.handle,
			cancelCalls,
			disconnectCalls,
			closeCalls,
		)
	}

	copy := *owner
	if err := copy.Close(); !errors.Is(err, errHostControlIOUnresolvedFatal) || !errors.Is(err, closeFailure) {
		t.Fatalf("Close through copied fatal owner = %v", err)
	}
	if connection.state.handle != 0 || cancelCalls != 2 || disconnectCalls != 1 || closeCalls != 1 {
		t.Fatalf(
			"fatal owner reused handle=%d calls cancel/disconnect/close=%d/%d/%d",
			connection.state.handle,
			cancelCalls,
			disconnectCalls,
			closeCalls,
		)
	}
	if err := owner.Close(); !errors.Is(err, errHostControlIOUnresolvedFatal) {
		t.Fatalf("repeated Close through original fatal owner = %v", err)
	}
	if cancelCalls != 2 || disconnectCalls != 1 || closeCalls != 1 {
		t.Fatalf("fatal Close repeated native calls: %d/%d/%d", cancelCalls, disconnectCalls, closeCalls)
	}
}

func TestWindowsCopiedCloseTimeoutsShareActivityDrain(t *testing.T) {
	const handle = windows.Handle(456)
	connection := newConnection(handle, Options{CloseTimeout: 10 * time.Millisecond}, VerificationEvidence{})
	quarantine := &hostControlLifetimeQuarantine{}
	rootWindowsContractQuarantine(quarantine)
	connection.state.quarantine = quarantine
	finish := connection.state.active.begin()
	connection.state.active.mu.Lock()
	drained := connection.state.active.drained
	connection.state.active.mu.Unlock()
	connection.state.cancelIO = func(windows.Handle) error { return windows.ERROR_NOT_FOUND }
	connection.state.disconnect = func(windows.Handle) error { return nil }
	var closeCalls atomic.Int32
	connection.state.closeHandle = func(windows.Handle) error {
		closeCalls.Add(1)
		return nil
	}

	first := *connection
	second := *connection
	results := make(chan error, 2)
	go func() { results <- first.Close() }()
	go func() { results <- second.Close() }()
	for range 2 {
		if err := <-results; !errors.Is(err, ErrCloseTimeout) {
			t.Fatalf("copied Close error = %v, want ErrCloseTimeout", err)
		}
	}
	connection.state.active.mu.Lock()
	if connection.state.active.drained != drained {
		connection.state.active.mu.Unlock()
		t.Fatal("copied Close timeouts replaced the shared activity drain")
	}
	connection.state.active.mu.Unlock()
	if closeCalls.Load() != 0 || connection.state.handle != handle || quarantine.count() != 1 {
		t.Fatalf("timed Close retained handle=%d close calls=%d quarantine=%d", connection.state.handle, closeCalls.Load(), quarantine.count())
	}

	finish()
	if err := second.Close(); !errors.Is(err, errHostControlIOUnresolvedFatal) {
		t.Fatalf("Close after fatal activity timeout = %v", err)
	}
	if connection.state.handle != handle || closeCalls.Load() != 0 {
		t.Fatalf("fatal retry touched handle=%d close calls=%d", connection.state.handle, closeCalls.Load())
	}
	if err := first.Close(); !errors.Is(err, errHostControlIOUnresolvedFatal) || closeCalls.Load() != 0 {
		t.Fatalf("repeated copied fatal Close = %v, close calls=%d", err, closeCalls.Load())
	}
}

func TestWindowsConnectionDisconnectFailureCanRetryBeforeHandleConsumption(t *testing.T) {
	const handle = windows.Handle(600)
	disconnectFailure := errors.New("injected disconnect failure")
	connection := newConnection(handle, Options{CloseTimeout: time.Second}, VerificationEvidence{})
	cancelCalls := 0
	disconnectCalls := 0
	closeCalls := 0
	connection.state.cancelIO = func(windows.Handle) error { cancelCalls++; return windows.ERROR_NOT_FOUND }
	connection.state.disconnect = func(windows.Handle) error {
		disconnectCalls++
		if disconnectCalls == 1 {
			return disconnectFailure
		}
		return nil
	}
	connection.state.closeHandle = func(windows.Handle) error { closeCalls++; return nil }

	copy := *connection
	if err := connection.Close(); !errors.Is(err, disconnectFailure) {
		t.Fatalf("first Close error = %v, want %v", err, disconnectFailure)
	}
	if connection.state.handle != handle || copy.state != connection.state || closeCalls != 0 {
		t.Fatalf("disconnect failure state=%p/%p handle=%d close=%d", connection.state, copy.state, connection.state.handle, closeCalls)
	}
	if err := copy.Close(); err != nil {
		t.Fatalf("copied retry before handle consumption = %v", err)
	}
	if connection.state.handle != 0 || cancelCalls != 2 || disconnectCalls != 2 || closeCalls != 1 {
		t.Fatalf("retry handle=%d calls cancel/disconnect/close=%d/%d/%d", connection.state.handle, cancelCalls, disconnectCalls, closeCalls)
	}
	if err := connection.Close(); err != nil || cancelCalls != 2 || disconnectCalls != 2 || closeCalls != 1 {
		t.Fatalf("idempotent Close = %v, calls=%d/%d/%d", err, cancelCalls, disconnectCalls, closeCalls)
	}
}

func TestWindowsConnectionCloseHandleFailureIsConsumedOnce(t *testing.T) {
	for _, closeFailure := range []error{errors.New("injected CloseHandle failure"), windows.ERROR_INVALID_HANDLE} {
		t.Run(closeFailure.Error(), func(t *testing.T) {
			const handle = windows.Handle(700)
			quarantine := &hostControlLifetimeQuarantine{}
			rootWindowsContractQuarantine(quarantine)
			connection := newConnection(handle, Options{CloseTimeout: time.Second}, VerificationEvidence{})
			connection.state.quarantine = quarantine
			cancelCalls, disconnectCalls, closeCalls := 0, 0, 0
			connection.state.cancelIO = func(windows.Handle) error { cancelCalls++; return windows.ERROR_NOT_FOUND }
			connection.state.disconnect = func(windows.Handle) error { disconnectCalls++; return nil }
			connection.state.closeHandle = func(windows.Handle) error { closeCalls++; return closeFailure }

			copy := *connection
			if err := connection.Close(); !errors.Is(err, closeFailure) || !errors.Is(err, errHostControlIOUnresolvedFatal) {
				t.Fatalf("CloseHandle failure = %v", err)
			}
			if connection.state.handle != 0 || quarantine.count() != 1 ||
				!quarantineRetainsHandle(quarantine, handle) || cancelCalls != 1 || disconnectCalls != 1 || closeCalls != 1 {
				t.Fatalf("consumed close handle=%d quarantine=%d calls=%d/%d/%d", connection.state.handle, quarantine.count(), cancelCalls, disconnectCalls, closeCalls)
			}
			if err := copy.Close(); !errors.Is(err, errHostControlIOUnresolvedFatal) || cancelCalls != 1 || disconnectCalls != 1 || closeCalls != 1 {
				t.Fatalf("copied fatal Close = %v, calls=%d/%d/%d", err, cancelCalls, disconnectCalls, closeCalls)
			}
		})
	}
}

func TestWindowsPostTransferFailureStagesUseActualConnectionOwner(t *testing.T) {
	deadlineCause := errors.New("startup deadline expired")
	tests := []struct {
		name          string
		configure     func(*fakeRetainedNode, *fakeRuntimeBootstrapChannel, context.CancelCauseFunc)
		wantActivated bool
	}{
		{
			name: "bootstrap write",
			configure: func(_ *fakeRetainedNode, channel *fakeRuntimeBootstrapChannel, _ context.CancelCauseFunc) {
				channel.failWriteCall = 1
			},
		},
		{
			name: "bootstrap acknowledgement",
			configure: func(_ *fakeRetainedNode, channel *fakeRuntimeBootstrapChannel, _ context.CancelCauseFunc) {
				channel.input = bytes.NewReader(nil)
			},
		},
		{
			name: "bootstrap acknowledgement deadline",
			configure: func(_ *fakeRetainedNode, channel *fakeRuntimeBootstrapChannel, cancel context.CancelCauseFunc) {
				channel.onReadCall = func(call int) {
					if call == 2 {
						cancel(deadlineCause)
					}
				}
			},
		},
		{
			name: "pre-activation identity",
			configure: func(node *fakeRetainedNode, _ *fakeRuntimeBootstrapChannel, _ context.CancelCauseFunc) {
				node.observations[0].StartKeySequenceNumber++
			},
		},
		{
			name: "pre-activation deadline",
			configure: func(node *fakeRetainedNode, _ *fakeRuntimeBootstrapChannel, cancel context.CancelCauseFunc) {
				node.onObserve = func(observation int) {
					if observation == 2 {
						cancel(deadlineCause)
					}
				}
			},
		},
		{
			name: "activation",
			configure: func(node *fakeRetainedNode, _ *fakeRuntimeBootstrapChannel, _ context.CancelCauseFunc) {
				node.activationError = errors.New("activation failed")
			},
		},
		{
			name: "pre-commit deadline",
			configure: func(node *fakeRetainedNode, _ *fakeRuntimeBootstrapChannel, cancel context.CancelCauseFunc) {
				node.onActivate = func() { cancel(deadlineCause) }
			},
			wantActivated: true,
		},
		{
			name: "commit write",
			configure: func(_ *fakeRetainedNode, channel *fakeRuntimeBootstrapChannel, _ context.CancelCauseFunc) {
				channel.failWriteCall = 3
			},
			wantActivated: true,
		},
		{
			name: "commit completion deadline",
			configure: func(_ *fakeRetainedNode, channel *fakeRuntimeBootstrapChannel, cancel context.CancelCauseFunc) {
				channel.onWriteCall = func(call int) {
					if call == 4 {
						cancel(deadlineCause)
					}
				}
			},
			wantActivated: true,
		},
	}

	for index, test := range tests {
		for _, closeFails := range []bool{false, true} {
			closeName := "close succeeds"
			if closeFails {
				closeName = "close fails"
			}
			t.Run(test.name+"/"+closeName, func(t *testing.T) {
				bootstrap, bootstrapDocument := hostControlBootstrapForTest(t)
				events := []string{}
				channel := hostControlBootstrapChannelForTest(t, bootstrapDocument, &events)
				node := newFakeRetainedNode(testNodeIdentity())
				node.events = &events
				ctx, cancel := context.WithCancelCause(context.Background())
				t.Cleanup(func() { cancel(nil) })
				test.configure(node, channel, cancel)

				_, primary := completeRuntimeBootstrap(
					ctx,
					channel,
					node,
					VerificationEvidence{NodeIdentity: node.stable},
					bootstrap,
				)
				if primary == nil {
					t.Fatal("completeRuntimeBootstrap unexpectedly succeeded")
				}
				if node.activated != test.wantActivated {
					t.Fatalf("Node activated = %v, want %v", node.activated, test.wantActivated)
				}

				handle := windows.Handle(1_000 + index)
				connection := newConnection(
					handle,
					Options{CloseTimeout: time.Second},
					VerificationEvidence{},
				)
				quarantine := &hostControlLifetimeQuarantine{}
				rootWindowsContractQuarantine(quarantine)
				connection.state.quarantine = quarantine
				closeFailure := errors.New("injected post-transfer close failure")
				cancelCalls := 0
				disconnectCalls := 0
				closeCalls := 0
				connection.state.cancelIO = func(got windows.Handle) error {
					if !node.terminated {
						t.Fatal("Connection I/O was cancelled before Node termination")
					}
					if got != handle {
						t.Fatalf("cancel handle = %d, want %d", got, handle)
					}
					cancelCalls++
					return nil
				}
				connection.state.disconnect = func(got windows.Handle) error {
					if got != handle {
						t.Fatalf("disconnect handle = %d, want %d", got, handle)
					}
					disconnectCalls++
					return nil
				}
				connection.state.closeHandle = func(got windows.Handle) error {
					if got != handle {
						t.Fatalf("close handle = %d, want %d", got, handle)
					}
					closeCalls++
					if closeFails {
						return closeFailure
					}
					return nil
				}

				owner, resultErr := rejectPostTransferAcceptFailure(connection, primary, node)
				if !node.terminated || !errors.Is(resultErr, primary) ||
					!errors.Is(connection.state.terminal, primary) {
					t.Fatalf(
						"post-transfer cleanup terminated=%v terminal=%v result=%v",
						node.terminated,
						connection.state.terminal,
						resultErr,
					)
				}
				if cancelCalls != 2 || disconnectCalls != 1 || closeCalls != 1 {
					t.Fatalf(
						"cleanup calls cancel/disconnect/close=%d/%d/%d",
						cancelCalls,
						disconnectCalls,
						closeCalls,
					)
				}
				if closeFails {
					if owner == nil || owner != connection || owner.state != connection.state ||
						connection.state.handle != 0 || quarantine.count() != 1 || !quarantineRetainsHandle(quarantine, handle) ||
						!errors.Is(resultErr, closeFailure) || !errors.Is(resultErr, errHostControlIOUnresolvedFatal) {
						var ownerState *connectionState
						if owner != nil {
							ownerState = owner.state
						}
						t.Fatalf(
							"failed close owner=%p state=%p handle=%d result=%v",
							owner,
							ownerState,
							connection.state.handle,
							resultErr,
						)
					}
					copy := *owner
					if retryErr := copy.Close(); !errors.Is(retryErr, errHostControlIOUnresolvedFatal) ||
						cancelCalls != 2 || disconnectCalls != 1 || closeCalls != 1 {
						t.Fatalf("fatal copied Close = %v, calls=%d/%d/%d", retryErr, cancelCalls, disconnectCalls, closeCalls)
					}
				} else if owner != nil || connection.state.handle != 0 || resultErr != primary {
					t.Fatalf(
						"successful close owner=%p handle=%d result=%v",
						owner,
						connection.state.handle,
						resultErr,
					)
				}
			})
		}
	}
}
