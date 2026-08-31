//go:build windows

package winprocess

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

const (
	testRetainedProcessHandle = windows.Handle(7001)
	testDuplicateWaitHandle   = windows.Handle(7002)
)

func newWaitTestProcess() *windowsNodeProcess {
	return &windowsNodeProcess{
		process:    testRetainedProcessHandle,
		standardIO: newStandardIOOwnership(nil),
	}
}

func setSuccessfulTestDuplicate(process *windowsNodeProcess, calls *int) {
	process.duplicateHandle = func(
		_ windows.Handle,
		source windows.Handle,
		_ windows.Handle,
		output *windows.Handle,
		_ uint32,
		inherit bool,
		options uint32,
	) error {
		(*calls)++
		if source != testRetainedProcessHandle || inherit || options != windows.DUPLICATE_SAME_ACCESS {
			return errors.New("unexpected DuplicateHandle arguments")
		}
		*output = testDuplicateWaitHandle
		return nil
	}
}

func TestWindowsNodeWaitContextPreCanceledHasNoNativeSideEffects(t *testing.T) {
	process := newWaitTestProcess()
	nativeCalls := 0
	setSuccessfulTestDuplicate(process, &nativeCalls)
	process.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
		nativeCalls++
		return windows.WAIT_OBJECT_0, nil
	}
	process.getExitCodeProcess = func(windows.Handle, *uint32) error {
		nativeCalls++
		return nil
	}
	process.closeProcessNativeHandle = func(windows.Handle) error {
		nativeCalls++
		return nil
	}
	cause := errors.New("pre-canceled")
	ctx, cancel := context.WithCancelCause(context.Background())
	cancel(cause)

	if _, err := process.WaitContext(ctx); !errors.Is(err, cause) {
		t.Fatalf("WaitContext error=%v", err)
	}
	if nativeCalls != 0 || process.process != testRetainedProcessHandle || process.standardIO.sealed {
		t.Fatalf("native calls=%d process=%d sealed=%v", nativeCalls, process.process, process.standardIO.sealed)
	}
}

func TestWindowsNodeWaitContextCancellationClosesDuplicateAndCanRetry(t *testing.T) {
	process := newWaitTestProcess()
	duplicateCalls := 0
	setSuccessfulTestDuplicate(process, &duplicateCalls)
	cause := errors.New("cancel active wait")
	ctx, cancel := context.WithCancelCause(context.Background())
	waitCalls := 0
	process.waitForSingleObject = func(handle windows.Handle, milliseconds uint32) (uint32, error) {
		waitCalls++
		if handle != testDuplicateWaitHandle || milliseconds != uint32(nodeWaitPollInterval/time.Millisecond) {
			t.Fatalf("wait handle=%d milliseconds=%d", handle, milliseconds)
		}
		cancel(cause)
		return uint32(windows.WAIT_TIMEOUT), nil
	}
	closed := []windows.Handle{}
	process.closeProcessNativeHandle = func(handle windows.Handle) error {
		closed = append(closed, handle)
		return nil
	}

	if _, err := process.WaitContext(ctx); !errors.Is(err, cause) {
		t.Fatalf("canceled WaitContext error=%v", err)
	}
	if duplicateCalls != 1 || waitCalls != 1 || len(closed) != 1 || closed[0] != testDuplicateWaitHandle ||
		process.process != testRetainedProcessHandle || process.standardIO.sealed {
		t.Fatalf("duplicate=%d wait=%d closed=%v process=%d sealed=%v", duplicateCalls, waitCalls, closed, process.process, process.standardIO.sealed)
	}

	process.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
		return windows.WAIT_OBJECT_0, nil
	}
	process.getExitCodeProcess = func(_ windows.Handle, exitCode *uint32) error {
		*exitCode = 17
		return nil
	}
	exitCode, err := process.WaitContext(context.Background())
	if err != nil || exitCode != 17 || duplicateCalls != 2 || len(closed) != 2 || closed[1] != testDuplicateWaitHandle {
		t.Fatalf("retry exit=%d error=%v duplicate=%d closed=%v", exitCode, err, duplicateCalls, closed)
	}
}

func TestWindowsNodeWaitContextInvalidStatusAndStillActiveAreTerminal(t *testing.T) {
	tests := []struct {
		name     string
		status   uint32
		exitCode uint32
		wantText string
	}{
		{name: "invalid status", status: 0x81, wantText: "0x81"},
		{name: "still active", status: windows.WAIT_OBJECT_0, exitCode: nodeStillActiveExitCode, wantText: "STILL_ACTIVE"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			process := newWaitTestProcess()
			duplicateCalls := 0
			setSuccessfulTestDuplicate(process, &duplicateCalls)
			process.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
				return test.status, nil
			}
			process.getExitCodeProcess = func(_ windows.Handle, exitCode *uint32) error {
				*exitCode = test.exitCode
				return nil
			}
			process.closeProcessNativeHandle = func(windows.Handle) error { return nil }

			_, err := process.WaitContext(context.Background())
			if err == nil || !strings.Contains(err.Error(), test.wantText) {
				t.Fatalf("WaitContext error=%v", err)
			}
			if !process.standardIO.sealed {
				t.Fatal("terminal wait failure did not seal owned standard I/O")
			}
		})
	}
}

func TestWindowsNodeWaitContextInvalidHandleQuarantinesDuplicateAndOriginal(t *testing.T) {
	for _, source := range []string{"wait", "exit code"} {
		t.Run(source, func(t *testing.T) {
			original := windowsProcessLifetimeQuarantine
			quarantine := &processLifetimeQuarantine{}
			windowsProcessLifetimeQuarantine = quarantine
			defer func() { windowsProcessLifetimeQuarantine = original }()

			process := newWaitTestProcess()
			duplicateCalls := 0
			setSuccessfulTestDuplicate(process, &duplicateCalls)
			process.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
				if source == "wait" {
					return 0, windows.ERROR_INVALID_HANDLE
				}
				return windows.WAIT_OBJECT_0, nil
			}
			process.getExitCodeProcess = func(windows.Handle, *uint32) error {
				return windows.ERROR_INVALID_HANDLE
			}
			closeCalls := 0
			process.closeProcessNativeHandle = func(windows.Handle) error {
				closeCalls++
				return nil
			}

			_, err := process.WaitContext(context.Background())
			if !errors.Is(err, ErrLaunchCleanupFatal) || process.process != 0 || closeCalls != 0 || quarantine.count() != 2 {
				t.Fatalf("error=%v process=%d close=%d quarantine=%d", err, process.process, closeCalls, quarantine.count())
			}
		})
	}
}

func TestWindowsNodeWaitCancellationDuplicateCloseFailurePoisonsWithoutDrain(t *testing.T) {
	original := windowsProcessLifetimeQuarantine
	quarantine := &processLifetimeQuarantine{}
	windowsProcessLifetimeQuarantine = quarantine
	defer func() { windowsProcessLifetimeQuarantine = original }()

	process := newWaitTestProcess()
	duplicateCalls := 0
	setSuccessfulTestDuplicate(process, &duplicateCalls)
	cause := errors.New("cancel wait")
	ctx, cancel := context.WithCancelCause(context.Background())
	process.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
		cancel(cause)
		return uint32(windows.WAIT_TIMEOUT), nil
	}
	closeFailure := errors.New("duplicate close failed")
	process.closeProcessNativeHandle = func(handle windows.Handle) error {
		if handle != testDuplicateWaitHandle {
			t.Fatalf("unexpected close handle=%d", handle)
		}
		return closeFailure
	}

	_, err := process.WaitContext(ctx)
	if !errors.Is(err, cause) || !errors.Is(err, closeFailure) || !errors.Is(err, ErrLaunchCleanupFatal) {
		t.Fatalf("WaitContext error=%v", err)
	}
	if process.process != 0 || process.standardIO.sealed || quarantine.count() != 2 {
		t.Fatalf("process=%d sealed=%v quarantine=%d", process.process, process.standardIO.sealed, quarantine.count())
	}
}

func TestWindowsNodeWaitUsesBackgroundCompatibility(t *testing.T) {
	process := newWaitTestProcess()
	duplicateCalls := 0
	setSuccessfulTestDuplicate(process, &duplicateCalls)
	process.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
		return windows.WAIT_OBJECT_0, nil
	}
	process.getExitCodeProcess = func(_ windows.Handle, exitCode *uint32) error {
		*exitCode = 23
		return nil
	}
	closed := 0
	process.closeProcessNativeHandle = func(windows.Handle) error {
		closed++
		return nil
	}

	exitCode, err := process.Wait()
	if err != nil || exitCode != 23 || duplicateCalls != 1 || closed != 1 {
		t.Fatalf("exit=%d error=%v duplicate=%d closed=%d", exitCode, err, duplicateCalls, closed)
	}
}

func TestWindowsNodeWaitIsLinearWithConcurrentTerminateAndClose(t *testing.T) {
	process := newWaitTestProcess()
	duplicateCalls := 0
	setSuccessfulTestDuplicate(process, &duplicateCalls)
	waitStarted := make(chan struct{})
	releaseWait := make(chan struct{})
	var waitOnce sync.Once
	process.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
		waitOnce.Do(func() { close(waitStarted) })
		<-releaseWait
		return uint32(windows.WAIT_TIMEOUT), nil
	}
	var closeMu sync.Mutex
	closed := []windows.Handle{}
	process.closeProcessNativeHandle = func(handle windows.Handle) error {
		closeMu.Lock()
		closed = append(closed, handle)
		closeMu.Unlock()
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	waitResult := make(chan error, 1)
	go func() {
		_, err := process.WaitContext(ctx)
		waitResult <- err
	}()
	<-waitStarted

	terminateResult := make(chan error, 1)
	closeResult := make(chan error, 1)
	go func() { terminateResult <- process.Terminate() }()
	go func() { closeResult <- process.Close() }()
	if err := <-terminateResult; err != nil {
		t.Fatalf("Terminate error=%v", err)
	}
	if err := <-closeResult; err != nil {
		t.Fatalf("Close error=%v", err)
	}
	cancel()
	close(releaseWait)
	if err := <-waitResult; !errors.Is(err, context.Canceled) {
		t.Fatalf("WaitContext error=%v", err)
	}

	closeMu.Lock()
	defer closeMu.Unlock()
	if len(closed) != 2 || closed[0] == closed[1] {
		t.Fatalf("closed handles=%v", closed)
	}
	foundOriginal := false
	foundDuplicate := false
	for _, handle := range closed {
		foundOriginal = foundOriginal || handle == testRetainedProcessHandle
		foundDuplicate = foundDuplicate || handle == testDuplicateWaitHandle
	}
	if !foundOriginal || !foundDuplicate {
		t.Fatalf("closed handles=%v", closed)
	}
}
