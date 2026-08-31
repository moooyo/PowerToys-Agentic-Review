//go:build windows

package winprocess

import (
	"context"
	"errors"
	"fmt"
	"io"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

var (
	testQuarantineMu    sync.Mutex
	testPinnedLifetimes []*processLifetimeQuarantine
)

func retainTestQuarantine(quarantine *processLifetimeQuarantine) {
	testQuarantineMu.Lock()
	testPinnedLifetimes = append(testPinnedLifetimes, quarantine)
	testQuarantineMu.Unlock()
}

func TestWindowsStandardIOStreamContracts(t *testing.T) {
	var _ NodeStandardInput = (*windowsStandardIOStream)(nil)
	var _ NodeStandardOutput = (*windowsStandardIOStream)(nil)
	var _ io.ReadCloser = (*windowsStandardIOStream)(nil)
	var _ io.WriteCloser = (*windowsStandardIOStream)(nil)
}

func TestPreparedStandardIOPipeSecurityIsProtectedAndExact(t *testing.T) {
	for _, parentReads := range []bool{false, true} {
		prepared, err := prepareStandardIOPipeSecurity(testOwnServiceSID, parentReads)
		if err != nil {
			t.Fatal(err)
		}
		control, _, err := prepared.descriptor.Control()
		if err != nil {
			t.Fatal(err)
		}
		dacl, defaulted, err := prepared.descriptor.DACL()
		if err != nil {
			t.Fatal(err)
		}
		evidence := daclEvidence{control: uint16(control), nullDACL: dacl == nil, defaulted: defaulted}
		if dacl != nil {
			for index := uint32(0); index < uint32(dacl.AceCount); index++ {
				entry, err := readAllowedACE(dacl, index)
				if err != nil {
					t.Fatal(err)
				}
				evidence.entries = append(evidence.entries, entry)
			}
		}
		if err := validateProtectedDACL(evidence, prepared.policy); err != nil {
			t.Fatalf("parentReads=%v security descriptor: %v", parentReads, err)
		}
	}
}

func TestWindowsStandardIOPipeCloseFailureIsConsumedOnceAndPoisons(t *testing.T) {
	closeFailure := errors.New("injected CloseHandle failure")
	const pipeHandle = windows.Handle(123)
	quarantine := &processLifetimeQuarantine{}
	stream := newWindowsStandardIOStream(pipeHandle, "test-stdout", true, false, time.Second)
	stream.quarantine = quarantine
	stream.disconnect = func(windows.Handle) error { return nil }
	closeCalls := 0
	stream.closeHandle = func(handle windows.Handle) error {
		closeCalls++
		if handle != pipeHandle {
			return errors.New("unexpected pipe handle")
		}
		return closeFailure
	}

	if err := stream.Close(); !errors.Is(err, closeFailure) || !errors.Is(err, ErrLaunchCleanupFatal) {
		t.Fatalf("first Close error = %v", err)
	}
	if err := stream.Close(); !errors.Is(err, ErrLaunchCleanupFatal) {
		t.Fatalf("poisoned Close error = %v", err)
	}
	if closeCalls != 1 || stream.handle != 0 || !stream.quarantined || quarantine.count() != 1 {
		t.Fatalf("close calls=%d handle=%d poisoned=%v quarantine=%d", closeCalls, stream.handle, stream.quarantined, quarantine.count())
	}
}

func TestWindowsStandardIOCloseTimeoutDoesNotConsumeRawHandle(t *testing.T) {
	const pipeHandle = windows.Handle(456)
	stream := newWindowsStandardIOStream(pipeHandle, "test-stdin", false, true, time.Millisecond)
	stream.disconnect = func(windows.Handle) error { return nil }
	closeCalls := 0
	stream.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
	finish := stream.active.begin()

	if err := stream.Close(); !errors.Is(err, ErrStandardIOCloseTimeout) {
		t.Fatalf("Close with active preparation error = %v", err)
	}
	if closeCalls != 0 || stream.handle != pipeHandle {
		t.Fatalf("timed-out Close calls=%d handle=%d", closeCalls, stream.handle)
	}
	finish()
	if err := stream.Close(); err != nil {
		t.Fatalf("Close after drain error = %v", err)
	}
	if closeCalls != 1 || stream.handle != 0 {
		t.Fatalf("drained Close calls=%d handle=%d", closeCalls, stream.handle)
	}
}

func TestWindowsStandardIOReadUsesPinnedBounceBufferAndReapsTerminalOperation(t *testing.T) {
	const pipeHandle = windows.Handle(700)
	const eventHandle = windows.Handle(701)
	quarantine := &processLifetimeQuarantine{}
	stream := newWindowsStandardIOStream(pipeHandle, "test-stdout", true, false, time.Second)
	stream.quarantine = quarantine
	stream.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
		return eventHandle, nil
	}
	caller := []byte{0}
	var kernelByte *byte
	var operation *windowsStandardIOOperation
	stream.readFile = func(
		handle windows.Handle,
		buffer []byte,
		transferred *uint32,
		overlapped *windows.Overlapped,
	) error {
		kernelByte = &buffer[0]
		operation = stream.activeOperation
		if handle != pipeHandle || overlapped != &operation.overlapped || kernelByte == &caller[0] {
			return errors.New("ReadFile did not receive the operation-owned bounce buffer")
		}
		return windows.ERROR_IO_PENDING
	}
	stream.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
		runtime.GC()
		for range 32 {
			_ = make([]byte, 64*1024)
		}
		return windows.WAIT_OBJECT_0, nil
	}
	stream.getOverlappedResult = func(
		handle windows.Handle,
		overlapped *windows.Overlapped,
		transferred *uint32,
		wait bool,
	) error {
		if handle != pipeHandle || wait || overlapped != &operation.overlapped {
			return errors.New("unexpected GetOverlappedResult arguments")
		}
		*kernelByte = 0x7a
		*transferred = 1
		return nil
	}
	closeCalls := 0
	stream.closeHandle = func(handle windows.Handle) error {
		closeCalls++
		if handle != eventHandle {
			return errors.New("unexpected event handle")
		}
		return nil
	}

	count, err := stream.ReadContext(context.Background(), caller)
	if err != nil || count != 1 || caller[0] != 0x7a {
		t.Fatalf("ReadContext=(%d,%v) caller=%x", count, err, caller)
	}
	if closeCalls != 1 || quarantine.count() != 0 || operation.pinned || stream.activeOperation != nil {
		t.Fatalf("close calls=%d quarantine=%d pinned=%v active=%v", closeCalls, quarantine.count(), operation.pinned, stream.activeOperation)
	}
	if !stream.active.wait(time.Millisecond) {
		t.Fatal("terminal operation did not release activity")
	}
}

func TestWindowsStandardIOWriteClonesCallerBufferBeforeSubmission(t *testing.T) {
	stream := newWindowsStandardIOStream(windows.Handle(720), "test-stdin", false, true, time.Second)
	stream.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
		return windows.Handle(721), nil
	}
	caller := []byte{0x21}
	stream.writeFile = func(_ windows.Handle, kernel []byte, _ *uint32, _ *windows.Overlapped) error {
		if &kernel[0] == &caller[0] || kernel[0] != 0x21 {
			return errors.New("WriteFile did not receive a cloned bounce buffer")
		}
		caller[0] = 0x44
		if kernel[0] != 0x21 {
			return errors.New("caller mutation changed the submitted bounce buffer")
		}
		return windows.ERROR_IO_PENDING
	}
	stream.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
		return windows.WAIT_OBJECT_0, nil
	}
	stream.getOverlappedResult = func(_ windows.Handle, _ *windows.Overlapped, count *uint32, _ bool) error {
		*count = 1
		return nil
	}
	stream.closeHandle = func(windows.Handle) error { return nil }
	if count, err := stream.Write(caller); count != 1 || err != nil {
		t.Fatalf("Write = (%d, %v)", count, err)
	}
	if caller[0] != 0x44 {
		t.Fatalf("caller buffer = %x", caller)
	}
}

func TestWindowsStandardIOEventCloseFailureIsConsumedOnceAndPoisons(t *testing.T) {
	const pipeHandle = windows.Handle(750)
	const eventHandle = windows.Handle(751)
	closeFailure := errors.New("event CloseHandle failure")
	quarantine := &processLifetimeQuarantine{}
	stream := newWindowsStandardIOStream(pipeHandle, "test-stdout", true, false, time.Second)
	stream.quarantine = quarantine
	stream.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
		return eventHandle, nil
	}
	stream.readFile = func(windows.Handle, []byte, *uint32, *windows.Overlapped) error {
		return windows.ERROR_IO_PENDING
	}
	stream.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
		return windows.WAIT_OBJECT_0, nil
	}
	stream.getOverlappedResult = func(_ windows.Handle, _ *windows.Overlapped, count *uint32, _ bool) error {
		*count = 1
		return nil
	}
	closeCalls := 0
	stream.closeHandle = func(handle windows.Handle) error {
		closeCalls++
		if handle != eventHandle {
			return errors.New("unexpected handle")
		}
		return closeFailure
	}

	if count, err := stream.Read(make([]byte, 1)); count != 1 || !errors.Is(err, closeFailure) ||
		!errors.Is(err, ErrLaunchCleanupFatal) {
		t.Fatalf("Read with event close failure = (%d, %v)", count, err)
	}
	if closeCalls != 1 || !stream.quarantined || quarantine.count() != 2 {
		t.Fatalf("close calls=%d poisoned=%v quarantine=%d", closeCalls, stream.quarantined, quarantine.count())
	}
	if _, err := stream.Read(make([]byte, 1)); !errors.Is(err, ErrLaunchCleanupFatal) {
		t.Fatalf("Read after event close poison = %v", err)
	}
	if closeCalls != 1 {
		t.Fatalf("event handle was retried %d times", closeCalls)
	}
}

func TestWindowsOverlappedTerminalClassification(t *testing.T) {
	for _, err := range []error{
		nil,
		windows.ERROR_OPERATION_ABORTED,
		windows.ERROR_BROKEN_PIPE,
		windows.ERROR_NO_DATA,
		windows.ERROR_PIPE_NOT_CONNECTED,
	} {
		if completed, got := classifyOverlappedCompletion(err); !completed || !errors.Is(got, err) {
			t.Fatalf("terminal classification for %v = (%v, %v)", err, completed, got)
		}
	}
	for _, err := range []error{
		windows.ERROR_IO_INCOMPLETE,
		windows.ERROR_INVALID_HANDLE,
		windows.ERROR_INVALID_PARAMETER,
		windows.ERROR_IO_PENDING,
		windows.ERROR_MORE_DATA,
	} {
		if completed, got := classifyOverlappedCompletion(err); completed || !errors.Is(got, err) {
			t.Fatalf("unknown classification for %v = (%v, %v)", err, completed, got)
		}
	}
}

func TestWindowsStandardIOReadEOFNormalizationRequiresExactZeroBytePipeError(t *testing.T) {
	stream := newWindowsStandardIOStream(windows.Handle(790), "test-stdout", true, false, time.Second)
	cleanupFailure := errors.New("cleanup failed")
	for _, pipeErr := range []error{
		windows.ERROR_BROKEN_PIPE,
		windows.ERROR_NO_DATA,
		windows.ERROR_PIPE_NOT_CONNECTED,
	} {
		if normalized := stream.normalizeOperationError(pipeErr, true, 0); normalized != io.EOF {
			t.Fatalf("exact zero-byte pipe error normalized to %v, want literal EOF", normalized)
		}
		for _, mutation := range []struct {
			name        string
			err         error
			transferred uint32
			preserved   error
		}{
			{name: "wrapped", err: fmt.Errorf("wrapped pipe error: %w", pipeErr), preserved: pipeErr},
			{name: "joined", err: errors.Join(pipeErr), preserved: pipeErr},
			{name: "cleanup", err: errors.Join(pipeErr, cleanupFailure), preserved: cleanupFailure},
			{name: "transferred", err: pipeErr, transferred: 1, preserved: pipeErr},
		} {
			t.Run(mutation.name, func(t *testing.T) {
				normalized := stream.normalizeOperationError(
					mutation.err,
					true,
					mutation.transferred,
				)
				if normalized == io.EOF {
					t.Fatal("mutated pipe failure normalized to literal EOF")
				}
				if !errors.Is(normalized, mutation.preserved) {
					t.Fatalf("pipe failure was lost: %v", normalized)
				}
			})
		}
	}
}

func TestWindowsStandardIOReadReturnsLiteralEOFOnlyAfterCleanLifecycle(t *testing.T) {
	for _, pipeErr := range []error{
		windows.ERROR_BROKEN_PIPE,
		windows.ERROR_NO_DATA,
		windows.ERROR_PIPE_NOT_CONNECTED,
	} {
		t.Run(pipeErr.Error(), func(t *testing.T) {
			stream := newWindowsStandardIOStream(windows.Handle(795), "test-stdout", true, false, time.Second)
			stream.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
				return windows.Handle(796), nil
			}
			stream.readFile = func(windows.Handle, []byte, *uint32, *windows.Overlapped) error {
				return pipeErr
			}
			stream.closeHandle = func(windows.Handle) error { return nil }

			if count, err := stream.ReadContext(context.Background(), make([]byte, 1)); count != 0 || err != io.EOF {
				t.Fatalf("ReadContext = (%d, %T %v), want (0, literal EOF)", count, err, err)
			}
		})
	}

	cleanupFailure := errors.New("event cleanup failed")
	quarantine := &processLifetimeQuarantine{}
	stream := newWindowsStandardIOStream(windows.Handle(797), "test-stdout", true, false, time.Second)
	stream.quarantine = quarantine
	stream.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
		return windows.Handle(798), nil
	}
	stream.readFile = func(windows.Handle, []byte, *uint32, *windows.Overlapped) error {
		return windows.ERROR_BROKEN_PIPE
	}
	stream.closeHandle = func(windows.Handle) error { return cleanupFailure }

	count, err := stream.ReadContext(context.Background(), make([]byte, 1))
	if count != 0 || err == io.EOF || !errors.Is(err, cleanupFailure) || !errors.Is(err, ErrLaunchCleanupFatal) {
		t.Fatalf("ReadContext with lifecycle failure = (%d, %T %v)", count, err, err)
	}
}

func TestWindowsStandardIOUnknownCompletionIsPinnedAndQuarantined(t *testing.T) {
	for _, completionErr := range []error{
		windows.ERROR_IO_INCOMPLETE,
		windows.ERROR_INVALID_HANDLE,
		windows.ERROR_INVALID_PARAMETER,
	} {
		t.Run(completionErr.Error(), func(t *testing.T) {
			const pipeHandle = windows.Handle(800)
			const eventHandle = windows.Handle(801)
			quarantine := &processLifetimeQuarantine{}
			retainTestQuarantine(quarantine)
			stream := newWindowsStandardIOStream(pipeHandle, "test-stdout", true, false, time.Second)
			stream.quarantine = quarantine
			stream.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
				return eventHandle, nil
			}
			caller := []byte{0x11}
			var operation *windowsStandardIOOperation
			stream.readFile = func(_ windows.Handle, kernel []byte, _ *uint32, _ *windows.Overlapped) error {
				kernel[0] = 0x99
				operation = stream.activeOperation
				return windows.ERROR_IO_PENDING
			}
			stream.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
				return windows.WAIT_OBJECT_0, nil
			}
			stream.getOverlappedResult = func(windows.Handle, *windows.Overlapped, *uint32, bool) error {
				return completionErr
			}
			closeCalls := 0
			stream.closeHandle = func(windows.Handle) error { closeCalls++; return nil }

			count, err := stream.ReadContext(context.Background(), caller)
			if count != 0 || !errors.Is(err, completionErr) || !errors.Is(err, ErrLaunchCleanupFatal) {
				t.Fatalf("unknown ReadContext=(%d,%v)", count, err)
			}
			if caller[0] != 0x11 || closeCalls != 0 || quarantine.count() != 1 {
				t.Fatalf("caller=%x close calls=%d quarantine=%d", caller, closeCalls, quarantine.count())
			}
			if operation == nil || !operation.pinned || stream.activeOperation != operation || !stream.quarantined {
				t.Fatal("unknown operation was released instead of quarantined")
			}
			if stream.active.wait(time.Millisecond) {
				t.Fatal("quarantined operation released activity")
			}
			if _, retryErr := stream.ReadContext(context.Background(), make([]byte, 1)); !errors.Is(retryErr, ErrLaunchCleanupFatal) {
				t.Fatalf("read after quarantine error = %v", retryErr)
			}
			if errors.Is(completionErr, windows.ERROR_INVALID_HANDLE) {
				if stream.handle != 0 || !operation.pipeTombstoned {
					t.Fatal("INVALID_HANDLE did not tombstone the pipe slot")
				}
			}
		})
	}
}

func TestWindowsStandardIOInvalidHandleAtSubmitOrEventWaitTombstonesOwner(t *testing.T) {
	for _, test := range []struct {
		name          string
		readFileError error
		waitError     error
		wantPipeDead  bool
		wantEventDead bool
	}{
		{name: "submit", readFileError: windows.ERROR_INVALID_HANDLE, wantPipeDead: true},
		{name: "event wait", readFileError: windows.ERROR_IO_PENDING, waitError: windows.ERROR_INVALID_HANDLE, wantEventDead: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			quarantine := &processLifetimeQuarantine{}
			retainTestQuarantine(quarantine)
			stream := newWindowsStandardIOStream(windows.Handle(850), "test-stdout", true, false, time.Second)
			stream.quarantine = quarantine
			stream.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
				return windows.Handle(851), nil
			}
			var operation *windowsStandardIOOperation
			stream.readFile = func(windows.Handle, []byte, *uint32, *windows.Overlapped) error {
				operation = stream.activeOperation
				return test.readFileError
			}
			stream.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
				return 0, test.waitError
			}
			closeCalls := 0
			stream.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
			if _, err := stream.Read(make([]byte, 1)); !errors.Is(err, windows.ERROR_INVALID_HANDLE) ||
				!errors.Is(err, ErrLaunchCleanupFatal) {
				t.Fatalf("invalid-handle Read error = %v", err)
			}
			if operation == nil || operation.pipeTombstoned != test.wantPipeDead ||
				operation.eventTombstoned != test.wantEventDead || closeCalls != 0 || quarantine.count() != 1 {
				t.Fatalf("operation=%#v close calls=%d quarantine=%d", operation, closeCalls, quarantine.count())
			}
		})
	}
}

func TestWindowsStandardIOCancelFailureAndNoCompletionIsBounded(t *testing.T) {
	const pipeHandle = windows.Handle(900)
	const eventHandle = windows.Handle(901)
	cancelFailure := errors.New("injected CancelIoEx failure")
	quarantine := &processLifetimeQuarantine{}
	retainTestQuarantine(quarantine)
	stream := newWindowsStandardIOStream(pipeHandle, "test-stdin", false, true, 5*time.Millisecond)
	stream.quarantine = quarantine
	stream.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
		return eventHandle, nil
	}
	stream.writeFile = func(windows.Handle, []byte, *uint32, *windows.Overlapped) error {
		return windows.ERROR_IO_PENDING
	}
	ctx, cancel := context.WithCancel(context.Background())
	waits := 0
	cleanupWaitMilliseconds := uint32(0)
	stream.waitForSingleObject = func(_ windows.Handle, milliseconds uint32) (uint32, error) {
		waits++
		if waits == 1 {
			cancel()
		} else {
			cleanupWaitMilliseconds = milliseconds
		}
		return uint32(windows.WAIT_TIMEOUT), nil
	}
	cancelCalls := 0
	stream.cancelIO = func(windows.Handle, *windows.Overlapped) error {
		cancelCalls++
		return cancelFailure
	}
	getResultCalls := 0
	stream.getOverlappedResult = func(windows.Handle, *windows.Overlapped, *uint32, bool) error {
		getResultCalls++
		return nil
	}
	closeCalls := 0
	stream.closeHandle = func(windows.Handle) error { closeCalls++; return nil }

	started := time.Now()
	count, err := stream.WriteContext(ctx, []byte{1})
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("canceled operation exceeded bounded cleanup: %v", elapsed)
	}
	if count != 0 || !errors.Is(err, context.Canceled) || !errors.Is(err, cancelFailure) ||
		!errors.Is(err, ErrStandardIOCloseTimeout) || !errors.Is(err, ErrLaunchCleanupFatal) {
		t.Fatalf("bounded cancellation=(%d,%v)", count, err)
	}
	if cancelCalls != 1 || getResultCalls != 0 || closeCalls != 0 || quarantine.count() != 1 || cleanupWaitMilliseconds == 0 {
		t.Fatalf("cancel=%d get=%d close=%d quarantine=%d cleanupWaitMs=%d", cancelCalls, getResultCalls, closeCalls, quarantine.count(), cleanupWaitMilliseconds)
	}
}

func TestWindowsStandardIOCancelInvalidHandleQuarantinesWithoutFurtherSyscalls(t *testing.T) {
	quarantine := &processLifetimeQuarantine{}
	retainTestQuarantine(quarantine)
	stream := newWindowsStandardIOStream(windows.Handle(950), "test-stdin", false, true, time.Second)
	stream.quarantine = quarantine
	stream.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
		return windows.Handle(951), nil
	}
	stream.writeFile = func(windows.Handle, []byte, *uint32, *windows.Overlapped) error {
		return windows.ERROR_IO_PENDING
	}
	ctx, cancel := context.WithCancel(context.Background())
	waitCalls := 0
	stream.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
		waitCalls++
		cancel()
		return uint32(windows.WAIT_TIMEOUT), nil
	}
	stream.cancelIO = func(windows.Handle, *windows.Overlapped) error {
		return windows.ERROR_INVALID_HANDLE
	}
	getCalls := 0
	stream.getOverlappedResult = func(windows.Handle, *windows.Overlapped, *uint32, bool) error {
		getCalls++
		return nil
	}
	if _, err := stream.WriteContext(ctx, []byte{1}); !errors.Is(err, windows.ERROR_INVALID_HANDLE) ||
		!errors.Is(err, ErrLaunchCleanupFatal) {
		t.Fatalf("cancel INVALID_HANDLE error = %v", err)
	}
	operation := stream.activeOperation
	if operation == nil || !operation.pipeTombstoned || stream.handle != 0 || waitCalls != 1 ||
		getCalls != 0 || quarantine.count() != 1 {
		t.Fatalf("operation=%#v handle=%d waits=%d get=%d quarantine=%d", operation, stream.handle, waitCalls, getCalls, quarantine.count())
	}
}

func TestWindowsStandardIOCloseRequestsCancellationFromOperationOwner(t *testing.T) {
	const pipeHandle = windows.Handle(1000)
	const eventHandle = windows.Handle(1001)
	stream := newWindowsStandardIOStream(pipeHandle, "test-stdout", true, false, time.Second)
	stream.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
		return eventHandle, nil
	}
	readStarted := make(chan struct{})
	stream.readFile = func(windows.Handle, []byte, *uint32, *windows.Overlapped) error {
		close(readStarted)
		return windows.ERROR_IO_PENDING
	}
	var canceled atomic.Bool
	stream.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
		if canceled.Load() {
			return windows.WAIT_OBJECT_0, nil
		}
		time.Sleep(time.Millisecond)
		return uint32(windows.WAIT_TIMEOUT), nil
	}
	cancelCalls := 0
	stream.cancelIO = func(handle windows.Handle, overlapped *windows.Overlapped) error {
		cancelCalls++
		if handle != pipeHandle || overlapped == nil {
			return errors.New("unexpected cancellation target")
		}
		canceled.Store(true)
		return nil
	}
	stream.getOverlappedResult = func(windows.Handle, *windows.Overlapped, *uint32, bool) error {
		return windows.ERROR_OPERATION_ABORTED
	}
	stream.disconnect = func(windows.Handle) error { return nil }
	closeCalls := 0
	stream.closeHandle = func(handle windows.Handle) error {
		closeCalls++
		if handle != eventHandle && handle != pipeHandle {
			return errors.New("unexpected close handle")
		}
		return nil
	}
	readResult := make(chan error, 1)
	go func() {
		_, err := stream.Read(make([]byte, 1))
		readResult <- err
	}()
	<-readStarted
	if err := stream.Close(); err != nil {
		t.Fatalf("Close error = %v", err)
	}
	if err := <-readResult; !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("canceled Read error = %v", err)
	}
	if cancelCalls != 1 || closeCalls != 2 {
		t.Fatalf("cancel calls=%d close calls=%d", cancelCalls, closeCalls)
	}
}

func TestWindowsStandardInputGracefulCloseContracts(t *testing.T) {
	t.Run("flush then EOF", func(t *testing.T) {
		stream := newWindowsStandardIOStream(windows.Handle(1100), "test-stdin", false, true, time.Second)
		events := make([]string, 0, 3)
		stream.flushBuffers = func(windows.Handle) error { events = append(events, "flush"); return nil }
		stream.disconnect = func(windows.Handle) error { events = append(events, "disconnect"); return nil }
		stream.closeHandle = func(windows.Handle) error { events = append(events, "close"); return nil }
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := stream.CloseWrite(ctx); err != nil {
			t.Fatal(err)
		}
		want := []string{"flush", "disconnect", "close"}
		if len(events) != len(want) {
			t.Fatalf("graceful events = %v", events)
		}
		for index := range want {
			if events[index] != want[index] {
				t.Fatalf("graceful events = %v", events)
			}
		}
	})

	t.Run("ordinary flush error remains recoverable", func(t *testing.T) {
		flushFailure := errors.New("flush failure")
		quarantine := &processLifetimeQuarantine{}
		stream := newWindowsStandardIOStream(windows.Handle(1110), "test-stdin", false, true, time.Second)
		stream.quarantine = quarantine
		stream.flushBuffers = func(windows.Handle) error { return flushFailure }
		closeCalls := 0
		stream.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := stream.CloseWrite(ctx); !errors.Is(err, flushFailure) || errors.Is(err, ErrLaunchCleanupFatal) {
			t.Fatalf("ordinary flush error = %v", err)
		}
		if closeCalls != 0 || quarantine.count() != 0 || stream.handle == 0 {
			t.Fatal("ordinary flush failure consumed or quarantined the pipe")
		}
	})

	t.Run("peer closed is consumed", func(t *testing.T) {
		stream := newWindowsStandardIOStream(windows.Handle(1120), "test-stdin", false, true, time.Second)
		stream.flushBuffers = func(windows.Handle) error { return windows.ERROR_BROKEN_PIPE }
		stream.disconnect = func(windows.Handle) error { return windows.ERROR_PIPE_NOT_CONNECTED }
		closeCalls := 0
		stream.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := stream.CloseWrite(ctx); !errors.Is(err, io.ErrClosedPipe) || errors.Is(err, ErrLaunchCleanupFatal) {
			t.Fatalf("peer-closed flush error = %v", err)
		}
		if closeCalls != 1 || stream.handle != 0 {
			t.Fatalf("peer-closed handle=%d close calls=%d", stream.handle, closeCalls)
		}
	})

	t.Run("timeout quarantines without close", func(t *testing.T) {
		quarantine := &processLifetimeQuarantine{}
		retainTestQuarantine(quarantine)
		stream := newWindowsStandardIOStream(windows.Handle(1130), "test-stdin", false, true, time.Second)
		stream.quarantine = quarantine
		releaseFlush := make(chan struct{})
		stream.flushBuffers = func(windows.Handle) error { <-releaseFlush; return nil }
		closeCalls := 0
		stream.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
		ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
		defer cancel()
		if err := stream.CloseWrite(ctx); !errors.Is(err, context.DeadlineExceeded) || !errors.Is(err, ErrLaunchCleanupFatal) {
			t.Fatalf("timed-out graceful close error = %v", err)
		}
		if closeCalls != 0 || quarantine.count() != 1 || !stream.quarantined {
			t.Fatalf("timeout close calls=%d quarantine=%d poisoned=%v", closeCalls, quarantine.count(), stream.quarantined)
		}
		close(releaseFlush)
	})

	t.Run("abortive close is bounded by an active flush", func(t *testing.T) {
		quarantine := &processLifetimeQuarantine{}
		stream := newWindowsStandardIOStream(windows.Handle(1135), "test-stdin", false, true, 5*time.Millisecond)
		stream.quarantine = quarantine
		flushStarted := make(chan struct{})
		releaseFlush := make(chan struct{})
		stream.flushBuffers = func(windows.Handle) error {
			close(flushStarted)
			<-releaseFlush
			return nil
		}
		disconnectCalls := 0
		closeCalls := 0
		stream.disconnect = func(windows.Handle) error { disconnectCalls++; return nil }
		stream.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
		closeWriteResult := make(chan error, 1)
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			closeWriteResult <- stream.CloseWrite(ctx)
		}()
		<-flushStarted

		closeResult := make(chan error, 1)
		go func() { closeResult <- stream.Close() }()
		select {
		case err := <-closeResult:
			if !errors.Is(err, ErrStandardIOCloseTimeout) || !errors.Is(err, ErrLaunchCleanupFatal) {
				t.Fatalf("abortive Close during flush error = %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("abortive Close blocked behind FlushFileBuffers")
		}
		if disconnectCalls != 0 || closeCalls != 0 || quarantine.count() != 1 {
			t.Fatalf("disconnect=%d close=%d quarantine=%d", disconnectCalls, closeCalls, quarantine.count())
		}
		writeResult := make(chan error, 1)
		go func() {
			_, err := stream.WriteContext(context.Background(), []byte{1})
			writeResult <- err
		}()
		select {
		case err := <-writeResult:
			if !errors.Is(err, ErrLaunchCleanupFatal) {
				t.Fatalf("Write after active-flush poison error = %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("Write blocked behind quarantined active flush")
		}
		close(releaseFlush)
		if err := <-closeWriteResult; !errors.Is(err, ErrLaunchCleanupFatal) {
			t.Fatalf("CloseWrite after concurrent poison error = %v", err)
		}
	})

	t.Run("raw close failure is consumed once", func(t *testing.T) {
		closeFailure := errors.New("stdin CloseHandle failure")
		quarantine := &processLifetimeQuarantine{}
		stream := newWindowsStandardIOStream(windows.Handle(1140), "test-stdin", false, true, time.Second)
		stream.quarantine = quarantine
		stream.flushBuffers = func(windows.Handle) error { return nil }
		stream.disconnect = func(windows.Handle) error { return nil }
		closeCalls := 0
		stream.closeHandle = func(windows.Handle) error { closeCalls++; return closeFailure }
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := stream.CloseWrite(ctx); !errors.Is(err, closeFailure) || !errors.Is(err, ErrLaunchCleanupFatal) {
			t.Fatalf("raw graceful close error = %v", err)
		}
		if err := stream.CloseWrite(ctx); !errors.Is(err, ErrLaunchCleanupFatal) {
			t.Fatalf("poisoned graceful close error = %v", err)
		}
		if closeCalls != 1 || quarantine.count() != 1 || stream.handle != 0 {
			t.Fatalf("close calls=%d quarantine=%d handle=%d", closeCalls, quarantine.count(), stream.handle)
		}
	})
}

func TestWindowsConnectCompletionAndRawCleanupContracts(t *testing.T) {
	t.Run("CreateFile ownership is assigned only after success", func(t *testing.T) {
		openFailure := errors.New("open failure")
		quarantine := &processLifetimeQuarantine{}
		operation := &windowsStdioConnectOperation{quarantine: quarantine}
		if err := operation.acceptChildHandle(windows.InvalidHandle, openFailure); !errors.Is(err, openFailure) {
			t.Fatalf("ordinary open failure = %v", err)
		}
		if operation.child != 0 || quarantine.count() != 0 {
			t.Fatal("ordinary open failure wrote an owner slot")
		}
		if err := operation.acceptChildHandle(windows.Handle(9), openFailure); !errors.Is(err, ErrLaunchCleanupFatal) {
			t.Fatalf("untrusted output error = %v", err)
		}
		if operation.child != 0 || quarantine.count() != 1 {
			t.Fatal("failed CreateFile output was adopted instead of quarantined")
		}
		if err := operation.acceptChildHandle(windows.Handle(10), nil); err != nil || operation.child != windows.Handle(10) {
			t.Fatalf("successful child adoption = handle:%d error:%v", operation.child, err)
		}
	})

	t.Run("aborted is terminal", func(t *testing.T) {
		operation := &windowsStdioConnectOperation{server: 1, event: 2}
		operation.cancelIO = func(windows.Handle, *windows.Overlapped) error { return nil }
		operation.waitForEvent = func(windows.Handle, uint32) (uint32, error) { return windows.WAIT_OBJECT_0, nil }
		operation.getResult = func(windows.Handle, *windows.Overlapped, *uint32, bool) error {
			return windows.ERROR_OPERATION_ABORTED
		}
		completed, err := cancelAndCompleteStdioConnect(operation, time.Millisecond)
		if !completed || err != nil {
			t.Fatalf("aborted completion = (%v, %v)", completed, err)
		}
	})

	t.Run("unknown GetOverlappedResult is not completion", func(t *testing.T) {
		for _, completionErr := range []error{
			windows.ERROR_IO_INCOMPLETE,
			windows.ERROR_INVALID_HANDLE,
			windows.ERROR_INVALID_PARAMETER,
		} {
			operation := &windowsStdioConnectOperation{server: 5, event: 6}
			operation.getResult = func(windows.Handle, *windows.Overlapped, *uint32, bool) error {
				return completionErr
			}
			completed, err := completeStdioConnect(operation)
			if completed || !errors.Is(err, completionErr) {
				t.Fatalf("completion %v = (%v, %v)", completionErr, completed, err)
			}
			if errors.Is(completionErr, windows.ERROR_INVALID_HANDLE) && !operation.serverTombstoned {
				t.Fatal("connect server INVALID_HANDLE was not tombstoned")
			}
		}
	})

	t.Run("cancel INVALID_HANDLE performs no further syscall", func(t *testing.T) {
		operation := &windowsStdioConnectOperation{server: 7, event: 8}
		operation.cancelIO = func(windows.Handle, *windows.Overlapped) error {
			return windows.ERROR_INVALID_HANDLE
		}
		waitCalls := 0
		operation.waitForEvent = func(windows.Handle, uint32) (uint32, error) {
			waitCalls++
			return windows.WAIT_OBJECT_0, nil
		}
		completed, err := cancelAndCompleteStdioConnect(operation, time.Millisecond)
		if completed || !errors.Is(err, windows.ERROR_INVALID_HANDLE) || waitCalls != 0 || !operation.serverTombstoned {
			t.Fatalf("cancel INVALID_HANDLE = (%v,%v), waits=%d tombstoned=%v", completed, err, waitCalls, operation.serverTombstoned)
		}
	})

	t.Run("cancel failure and timeout are bounded", func(t *testing.T) {
		cancelFailure := errors.New("cancel failure")
		operation := &windowsStdioConnectOperation{server: 3, event: 4}
		operation.cancelIO = func(windows.Handle, *windows.Overlapped) error { return cancelFailure }
		operation.waitForEvent = func(windows.Handle, uint32) (uint32, error) {
			return uint32(windows.WAIT_TIMEOUT), nil
		}
		getCalls := 0
		operation.getResult = func(windows.Handle, *windows.Overlapped, *uint32, bool) error {
			getCalls++
			return nil
		}
		completed, err := cancelAndCompleteStdioConnect(operation, time.Millisecond)
		if completed || !errors.Is(err, cancelFailure) || !errors.Is(err, ErrStandardIOCloseTimeout) || getCalls != 0 {
			t.Fatalf("timed-out completion = (%v, %v), get calls=%d", completed, err, getCalls)
		}
	})

	t.Run("raw cleanup consumes each slot once", func(t *testing.T) {
		closeFailure := errors.New("raw close failure")
		quarantine := &processLifetimeQuarantine{}
		operation := &windowsStdioConnectOperation{server: 10, child: 11, event: 12, quarantine: quarantine}
		calls := make(map[windows.Handle]int)
		operation.closeHandle = func(handle windows.Handle) error {
			calls[handle]++
			return closeFailure
		}
		err := cleanupStdioPipeCreation(operation)
		if !errors.Is(err, ErrLaunchCleanupFatal) || !errors.Is(err, closeFailure) {
			t.Fatalf("raw cleanup error = %v", err)
		}
		for _, handle := range []windows.Handle{10, 11, 12} {
			if calls[handle] != 1 {
				t.Fatalf("handle %d close calls = %d", handle, calls[handle])
			}
		}
		if operation.server != 0 || operation.child != 0 || operation.event != 0 || quarantine.count() != 3 {
			t.Fatal("raw cleanup did not tombstone and quarantine every slot")
		}
	})

	t.Run("tombstoned slots are never closed", func(t *testing.T) {
		operation := &windowsStdioConnectOperation{
			server:           20,
			child:            21,
			event:            22,
			serverTombstoned: true,
			childTombstoned:  true,
			eventTombstoned:  true,
		}
		closeCalls := 0
		operation.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
		if err := cleanupStdioPipeCreation(operation); err != nil {
			t.Fatal(err)
		}
		if closeCalls != 0 || operation.server != 0 || operation.child != 0 || operation.event != 0 {
			t.Fatalf("close calls=%d server=%d child=%d event=%d", closeCalls, operation.server, operation.child, operation.event)
		}
	})
}

func TestStandardIOCleanupGraceIsPositiveAndBounded(t *testing.T) {
	if got := standardIOCleanupGrace(0); got <= 0 {
		t.Fatalf("zero shutdown timeout cleanup grace = %v", got)
	}
	if got := standardIOCleanupGrace(time.Hour); got != maximumStandardIOCleanupGrace {
		t.Fatalf("large shutdown timeout cleanup grace = %v", got)
	}
}
