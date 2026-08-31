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
	"time"

	"golang.org/x/sys/windows"
)

const (
	standardIOOperationPollInterval = 25 * time.Millisecond
	maximumStandardIOCleanupGrace   = 5 * time.Second
)

type standardIOCancelFunc func(windows.Handle, *windows.Overlapped) error
type standardIOCloseHandleFunc func(windows.Handle) error
type standardIOCreateEventFunc func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error)
type standardIODisconnectFunc func(windows.Handle) error
type standardIOGetResultFunc func(windows.Handle, *windows.Overlapped, *uint32, bool) error
type standardIOFlushFunc func(windows.Handle) error
type standardIOReadFunc func(windows.Handle, []byte, *uint32, *windows.Overlapped) error
type standardIOWaitFunc func(windows.Handle, uint32) (uint32, error)
type standardIOWriteFunc func(windows.Handle, []byte, *uint32, *windows.Overlapped) error

// windowsStandardIOOperation is heap-owned and pinned before its OVERLAPPED or
// byte backing store reaches Windows. Unknown completion quarantines this whole
// object, including its stream and buffer references, until process exit.
type windowsStandardIOOperation struct {
	stream      *windowsStandardIOStream
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
	cancelRequested  atomic.Bool
}

func newWindowsStandardIOOperation(
	stream *windowsStandardIOStream,
	callerBuffer []byte,
	event windows.Handle,
	finish func(),
	reading bool,
) *windowsStandardIOOperation {
	kernelBuffer := make([]byte, len(callerBuffer))
	if !reading {
		copy(kernelBuffer, callerBuffer)
	}
	operation := &windowsStandardIOOperation{
		stream:    stream,
		buffer:    kernelBuffer,
		event:     event,
		finish:    finish,
		completed: true,
	}
	operation.overlapped.HEvent = event
	operation.pinner.Pin(&operation.overlapped)
	operation.pinner.Pin(&operation.buffer[0])
	operation.pinned = true
	return operation
}

// windowsStandardIOStream owns one connected overlapped named-pipe server.
type windowsStandardIOStream struct {
	name         string
	readable     bool
	writable     bool
	closeTimeout time.Duration
	cleanupGrace time.Duration

	mu              sync.Mutex
	closeMu         sync.Mutex
	operationGate   chan struct{}
	poisoned        chan struct{}
	poisonOnce      sync.Once
	active          standardIOActivity
	handle          windows.Handle
	closing         bool
	quarantined     bool
	activeOperation *windowsStandardIOOperation
	activeFlush     *windowsStandardIOFlushOwner
	quarantine      *processLifetimeQuarantine

	cancelIO            standardIOCancelFunc
	closeHandle         standardIOCloseHandleFunc
	createEvent         standardIOCreateEventFunc
	disconnect          standardIODisconnectFunc
	flushBuffers        standardIOFlushFunc
	getOverlappedResult standardIOGetResultFunc
	readFile            standardIOReadFunc
	waitForSingleObject standardIOWaitFunc
	writeFile           standardIOWriteFunc
}

func newWindowsStandardIOStream(
	handle windows.Handle,
	name string,
	readable bool,
	writable bool,
	closeTimeout time.Duration,
) *windowsStandardIOStream {
	operationGate := make(chan struct{}, 1)
	operationGate <- struct{}{}
	return &windowsStandardIOStream{
		handle:        handle,
		name:          name,
		readable:      readable,
		writable:      writable,
		closeTimeout:  closeTimeout,
		cleanupGrace:  standardIOCleanupGrace(closeTimeout),
		operationGate: operationGate,
		poisoned:      make(chan struct{}),
		quarantine:    windowsProcessLifetimeQuarantine,
	}
}

func (s *windowsStandardIOStream) Read(buffer []byte) (int, error) {
	return s.ReadContext(context.Background(), buffer)
}

func (s *windowsStandardIOStream) ReadContext(ctx context.Context, buffer []byte) (int, error) {
	if s == nil || !s.readable {
		return 0, fmt.Errorf("read Node standard I/O: %w", io.ErrClosedPipe)
	}
	return s.performOverlapped(ctx, buffer, true)
}

func (s *windowsStandardIOStream) Write(buffer []byte) (int, error) {
	return s.WriteContext(context.Background(), buffer)
}

func (s *windowsStandardIOStream) WriteContext(ctx context.Context, buffer []byte) (int, error) {
	if s == nil || !s.writable {
		return 0, fmt.Errorf("write Node standard I/O: %w", io.ErrClosedPipe)
	}
	return s.performOverlapped(ctx, buffer, false)
}

type windowsStandardIOFlushOwner struct {
	stream   *windowsStandardIOStream
	handle   windows.Handle
	done     chan struct{}
	finished chan struct{}
	err      error
}

// CloseWrite preserves successful stdin writes by waiting for the client to
// consume the pipe buffer before disconnecting and delivering EOF.
func (s *windowsStandardIOStream) CloseWrite(ctx context.Context) error {
	if s == nil || !s.writable {
		return io.ErrClosedPipe
	}
	if ctx == nil {
		return errors.New("Node stdin graceful-close context is required")
	}
	if _, ok := ctx.Deadline(); !ok {
		return errors.New("Node stdin graceful-close context must have a deadline")
	}
	if err := acquireStandardIOOperation(ctx, s.operationGate, s.poisoned); err != nil {
		return err
	}
	defer releaseStandardIOOperation(s.operationGate)

	flushBuffers := s.flushBuffers
	if flushBuffers == nil {
		flushBuffers = windows.FlushFileBuffers
	}
	owner := &windowsStandardIOFlushOwner{
		stream:   s,
		done:     make(chan struct{}),
		finished: make(chan struct{}),
	}
	s.mu.Lock()
	if s.quarantined {
		s.mu.Unlock()
		return ErrLaunchCleanupFatal
	}
	if s.handle == 0 {
		s.mu.Unlock()
		return nil
	}
	s.closing = true
	handle := s.handle
	owner.handle = handle
	s.activeFlush = owner
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		if s.activeFlush == owner {
			s.activeFlush = nil
		}
		s.mu.Unlock()
		close(owner.finished)
	}()
	go func() {
		owner.err = flushBuffers(handle)
		close(owner.done)
		runtime.KeepAlive(owner)
	}()
	var flushTerminalErr error
	select {
	case <-owner.done:
		flushErr := owner.err
		switch {
		case flushErr == nil:
		case errors.Is(flushErr, windows.ERROR_INVALID_HANDLE):
			s.mu.Lock()
			s.handle = 0
			s.markQuarantinedLocked()
			s.mu.Unlock()
			return s.quarantineOwner(owner, fmt.Errorf("flush Node stdin before EOF: %w", flushErr))
		case errors.Is(flushErr, windows.ERROR_BROKEN_PIPE),
			errors.Is(flushErr, windows.ERROR_NO_DATA),
			errors.Is(flushErr, windows.ERROR_PIPE_NOT_CONNECTED):
			flushTerminalErr = io.ErrClosedPipe
		default:
			return fmt.Errorf("flush Node stdin before EOF: %w", flushErr)
		}
	case <-ctx.Done():
		s.mu.Lock()
		s.markQuarantinedLocked()
		s.mu.Unlock()
		return s.quarantineOwner(owner, context.Cause(ctx))
	case <-s.poisoned:
		return ErrLaunchCleanupFatal
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.handle != handle || s.quarantined {
		return ErrLaunchCleanupFatal
	}
	disconnect := s.disconnect
	if disconnect == nil {
		disconnect = windows.DisconnectNamedPipe
	}
	if err := disconnect(handle); err != nil &&
		!errors.Is(err, windows.ERROR_PIPE_NOT_CONNECTED) &&
		!errors.Is(err, windows.ERROR_NO_DATA) {
		if errors.Is(err, windows.ERROR_INVALID_HANDLE) {
			s.handle = 0
			s.markQuarantinedLocked()
			return s.quarantineOwner(owner, err)
		}
		return fmt.Errorf("disconnect Node stdin after flush: %w", err)
	}
	closeHandle := s.closeHandle
	if closeHandle == nil {
		closeHandle = windows.CloseHandle
	}
	closeErr := consumeWindowsHandle(
		"close Node stdin handle after flush",
		handle,
		closeHandle,
		s.quarantine,
	)
	s.handle = 0
	if closeErr != nil {
		s.markQuarantinedLocked()
	}
	return errors.Join(flushTerminalErr, closeErr)
}

func (s *windowsStandardIOStream) performOverlapped(
	ctx context.Context,
	buffer []byte,
	reading bool,
) (transferred int, resultErr error) {
	if ctx == nil {
		return 0, errors.New("Node standard-I/O context is required")
	}
	if cause := context.Cause(ctx); cause != nil {
		return 0, cause
	}
	if len(buffer) == 0 {
		return 0, nil
	}
	if err := acquireStandardIOOperation(ctx, s.operationGate, s.poisoned); err != nil {
		return 0, err
	}
	defer releaseStandardIOOperation(s.operationGate)
	// The operation pins a pointer-free internal bounce buffer. KeepAlive is
	// registered before operation finalization so LIFO also retains the caller
	// buffer through terminal classification, read publication, and event cleanup.
	defer runtime.KeepAlive(buffer)
	if cause := context.Cause(ctx); cause != nil {
		return 0, cause
	}

	handle, finish, err := s.beginOperation()
	if err != nil {
		return 0, err
	}
	event, err := s.createOperationEvent()
	if err != nil {
		finish()
		return 0, err
	}
	operation := newWindowsStandardIOOperation(s, buffer, event, finish, reading)
	defer func() {
		var lifecycleErr error
		if operation.completed && !operation.forcedQuarantine.Load() {
			lifecycleErr = s.releaseCompletedOperation(operation)
		} else {
			lifecycleErr = s.quarantineIncompleteOperation(operation, resultErr)
		}
		resultErr = errors.Join(resultErr, lifecycleErr)
	}()
	if cause := context.Cause(ctx); cause != nil {
		return 0, cause
	}

	startErr := s.submitOperation(handle, operation, reading)
	if !operation.submitted {
		return 0, startErr
	}
	if startErr == nil {
		completed, completionErr := s.completeOperation(operation)
		operation.completed = completed
		if !completed {
			return 0, s.normalizeOperationError(completionErr, reading)
		}
		count, countErr := publishCompletedStandardIO(operation, buffer, reading)
		return count, errors.Join(s.normalizeOperationError(completionErr, reading), countErr)
	}
	if !errors.Is(startErr, windows.ERROR_IO_PENDING) {
		if operation.forcedQuarantine.Load() {
			operation.completed = false
			return 0, startErr
		}
		operation.completed = true
		count, countErr := publishCompletedStandardIO(operation, buffer, reading)
		return count, errors.Join(s.normalizeOperationError(startErr, reading), countErr)
	}

	waitForSingleObject := s.waitForSingleObject
	if waitForSingleObject == nil {
		waitForSingleObject = windows.WaitForSingleObject
	}
	for {
		if cause := context.Cause(ctx); cause != nil {
			completed, completionErr := s.cancelAndComplete(
				operation,
				s.cleanupGrace,
			)
			operation.completed = completed
			if !completed {
				return 0, errors.Join(cause, completionErr)
			}
			count, countErr := publishCompletedStandardIO(operation, buffer, reading)
			return count, errors.Join(cause, completionErr, countErr)
		}
		if operation.cancelRequested.Load() {
			completed, completionErr := s.cancelAndComplete(operation, s.cleanupGrace)
			operation.completed = completed
			if !completed {
				return 0, errors.Join(io.ErrClosedPipe, completionErr)
			}
			count, countErr := publishCompletedStandardIO(operation, buffer, reading)
			return count, errors.Join(io.ErrClosedPipe, completionErr, countErr)
		}
		status, waitErr := waitForSingleObject(
			operation.event,
			standardIODurationMilliseconds(standardIOOperationPollInterval),
		)
		runtime.KeepAlive(operation)
		if waitErr != nil {
			if errors.Is(waitErr, windows.ERROR_INVALID_HANDLE) {
				s.forceQuarantineOperation(operation, false, true)
			}
			operation.completed = false
			return 0, fmt.Errorf("wait for %s overlapped I/O: %w", s.name, waitErr)
		}
		switch status {
		case windows.WAIT_OBJECT_0:
			completed, completionErr := s.completeOperation(operation)
			operation.completed = completed
			if !completed {
				return 0, s.normalizeOperationError(completionErr, reading)
			}
			count, countErr := publishCompletedStandardIO(operation, buffer, reading)
			return count, errors.Join(s.normalizeOperationError(completionErr, reading), countErr)
		case uint32(windows.WAIT_TIMEOUT):
			continue
		default:
			operation.completed = false
			return 0, fmt.Errorf("wait for %s overlapped I/O returned status 0x%x", s.name, status)
		}
	}
}

func (s *windowsStandardIOStream) beginOperation() (windows.Handle, func(), error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.quarantined {
		return 0, func() {}, ErrLaunchCleanupFatal
	}
	if s.handle == 0 || s.closing {
		return 0, func() {}, io.ErrClosedPipe
	}
	return s.handle, s.active.begin(), nil
}

func (s *windowsStandardIOStream) createOperationEvent() (windows.Handle, error) {
	createEvent := s.createEvent
	if createEvent == nil {
		createEvent = windows.CreateEvent
	}
	event, createErr := createEvent(nil, 1, 0, nil)
	event, err := adoptWindowsHandleOutput(
		s.name+" overlapped I/O event",
		event,
		createErr,
		s.quarantine,
	)
	if err != nil {
		if errors.Is(err, ErrLaunchCleanupFatal) {
			s.mu.Lock()
			s.markQuarantinedLocked()
			s.mu.Unlock()
		}
		return 0, fmt.Errorf("create %s overlapped I/O event: %w", s.name, err)
	}
	return event, nil
}

func (s *windowsStandardIOStream) submitOperation(
	handle windows.Handle,
	operation *windowsStandardIOOperation,
	reading bool,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.handle != handle || s.handle == 0 || s.closing {
		return io.ErrClosedPipe
	}
	if s.quarantined || s.activeOperation != nil {
		return ErrLaunchCleanupFatal
	}
	s.activeOperation = operation
	operation.handle = handle
	operation.submitted = true
	operation.completed = false
	if reading {
		readFile := s.readFile
		if readFile == nil {
			readFile = windows.ReadFile
		}
		err := readFile(
			handle,
			operation.buffer,
			&operation.transferred,
			&operation.overlapped,
		)
		runtime.KeepAlive(operation)
		if errors.Is(err, windows.ERROR_INVALID_HANDLE) {
			operation.pipeTombstoned = true
			operation.forcedQuarantine.Store(true)
			s.handle = 0
			s.markQuarantinedLocked()
		}
		return err
	}
	writeFile := s.writeFile
	if writeFile == nil {
		writeFile = windows.WriteFile
	}
	err := writeFile(
		handle,
		operation.buffer,
		&operation.transferred,
		&operation.overlapped,
	)
	runtime.KeepAlive(operation)
	if errors.Is(err, windows.ERROR_INVALID_HANDLE) {
		operation.pipeTombstoned = true
		operation.forcedQuarantine.Store(true)
		s.handle = 0
		s.markQuarantinedLocked()
	}
	return err
}

func (s *windowsStandardIOStream) releaseCompletedOperation(operation *windowsStandardIOOperation) error {
	closeHandle := s.closeHandle
	if closeHandle == nil {
		closeHandle = windows.CloseHandle
	}
	eventCloseErr := consumeWindowsHandle(
		"close "+s.name+" overlapped I/O event",
		operation.event,
		closeHandle,
		s.quarantine,
	)
	operation.event = 0

	s.mu.Lock()
	var invariantErr error
	if operation.submitted {
		if s.activeOperation == operation {
			s.activeOperation = nil
		} else {
			invariantErr = errors.New("Node standard-I/O completion ownership changed")
		}
	}
	if invariantErr != nil || eventCloseErr != nil {
		s.markQuarantinedLocked()
	}
	operation.finish()
	s.mu.Unlock()
	operation.pinner.Unpin()
	operation.pinned = false
	operation.buffer = nil

	if invariantErr != nil || eventCloseErr != nil {
		return s.quarantineOwner(operation, errors.Join(invariantErr, eventCloseErr))
	}
	operation.stream = nil
	return nil
}

func (s *windowsStandardIOStream) quarantineIncompleteOperation(
	operation *windowsStandardIOOperation,
	cause error,
) error {
	s.mu.Lock()
	if !operation.quarantined {
		operation.quarantined = true
		s.markQuarantinedLocked()
	}
	s.mu.Unlock()
	if cause == nil {
		cause = errors.New("standard-I/O completion state is unknown")
	}
	return s.quarantineOwner(operation, cause)
}

func (s *windowsStandardIOStream) quarantineOwner(owner any, cause error) error {
	quarantine := s.quarantine
	if quarantine == nil {
		quarantine = windowsProcessLifetimeQuarantine
	}
	return quarantine.retain(owner, cause)
}

func (s *windowsStandardIOStream) completeOperation(
	operation *windowsStandardIOOperation,
) (bool, error) {
	getResult := s.getOverlappedResult
	if getResult == nil {
		getResult = windows.GetOverlappedResult
	}
	err := getResult(
		operation.handle,
		&operation.overlapped,
		&operation.transferred,
		false,
	)
	runtime.KeepAlive(operation)
	completed, classifiedErr := classifyOverlappedCompletion(err)
	if errors.Is(classifiedErr, windows.ERROR_INVALID_HANDLE) {
		s.forceQuarantineOperation(operation, true, false)
	}
	return completed, classifiedErr
}

func (s *windowsStandardIOStream) cancelAndComplete(
	operation *windowsStandardIOOperation,
	timeout time.Duration,
) (bool, error) {
	cancelIO := s.cancelIO
	if cancelIO == nil {
		cancelIO = windows.CancelIoEx
	}
	cancelErr := cancelIO(operation.handle, &operation.overlapped)
	runtime.KeepAlive(operation)
	if errors.Is(cancelErr, windows.ERROR_INVALID_HANDLE) {
		s.forceQuarantineOperation(operation, true, false)
		return false, cancelErr
	}
	if errors.Is(cancelErr, windows.ERROR_NOT_FOUND) {
		cancelErr = nil
	}
	completed, completionErr := s.waitForTerminalCompletion(operation, timeout)
	if completed && errors.Is(completionErr, windows.ERROR_OPERATION_ABORTED) {
		completionErr = nil
	}
	return completed, errors.Join(cancelErr, completionErr)
}

func (s *windowsStandardIOStream) waitForTerminalCompletion(
	operation *windowsStandardIOOperation,
	timeout time.Duration,
) (bool, error) {
	waitForSingleObject := s.waitForSingleObject
	if waitForSingleObject == nil {
		waitForSingleObject = windows.WaitForSingleObject
	}
	status, waitErr := waitForSingleObject(
		operation.event,
		standardIODurationMilliseconds(timeout),
	)
	runtime.KeepAlive(operation)
	if waitErr != nil {
		if errors.Is(waitErr, windows.ERROR_INVALID_HANDLE) {
			s.forceQuarantineOperation(operation, false, true)
		}
		return false, waitErr
	}
	switch status {
	case windows.WAIT_OBJECT_0:
		return s.completeOperation(operation)
	case uint32(windows.WAIT_TIMEOUT):
		return false, ErrStandardIOCloseTimeout
	default:
		return false, fmt.Errorf("wait for canceled %s I/O returned status 0x%x", s.name, status)
	}
}

func (s *windowsStandardIOStream) forceQuarantineOperation(
	operation *windowsStandardIOOperation,
	pipeTombstoned bool,
	eventTombstoned bool,
) {
	operation.forcedQuarantine.Store(true)
	operation.pipeTombstoned = operation.pipeTombstoned || pipeTombstoned
	operation.eventTombstoned = operation.eventTombstoned || eventTombstoned
	s.mu.Lock()
	if pipeTombstoned && s.handle == operation.handle {
		s.handle = 0
	}
	s.markQuarantinedLocked()
	s.mu.Unlock()
}

func (s *windowsStandardIOStream) markQuarantinedLocked() {
	s.quarantined = true
	if s.poisoned != nil {
		s.poisonOnce.Do(func() { close(s.poisoned) })
	}
}

func classifyOverlappedCompletion(err error) (bool, error) {
	if err == nil ||
		errors.Is(err, windows.ERROR_OPERATION_ABORTED) ||
		errors.Is(err, windows.ERROR_BROKEN_PIPE) ||
		errors.Is(err, windows.ERROR_NO_DATA) ||
		errors.Is(err, windows.ERROR_PIPE_NOT_CONNECTED) {
		return true, err
	}
	return false, err
}

func (s *windowsStandardIOStream) normalizeOperationError(err error, reading bool) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, windows.ERROR_BROKEN_PIPE) ||
		errors.Is(err, windows.ERROR_NO_DATA) ||
		errors.Is(err, windows.ERROR_PIPE_NOT_CONNECTED) {
		if reading {
			return io.EOF
		}
		return io.ErrClosedPipe
	}
	if errors.Is(err, windows.ERROR_OPERATION_ABORTED) {
		s.mu.Lock()
		closing := s.closing
		s.mu.Unlock()
		if closing {
			return io.ErrClosedPipe
		}
	}
	return fmt.Errorf("%s: %w", s.name, err)
}

// Close cancels the exact active OVERLAPPED and waits for its terminal tail.
// Quarantined operations keep every address and handle alive until process exit.
func (s *windowsStandardIOStream) Close() error {
	if s == nil {
		return nil
	}
	s.closeMu.Lock()
	defer s.closeMu.Unlock()
	if err := s.waitForActiveFlush(); err != nil {
		return err
	}

	s.mu.Lock()
	if s.quarantined {
		s.mu.Unlock()
		return ErrLaunchCleanupFatal
	}
	if s.handle == 0 {
		s.mu.Unlock()
		return nil
	}
	s.closing = true
	handle := s.handle
	operation := s.activeOperation
	if operation != nil {
		operation.cancelRequested.Store(true)
	}
	s.mu.Unlock()

	if !s.active.wait(s.closeTimeout) {
		s.mu.Lock()
		quarantined := s.quarantined
		s.mu.Unlock()
		if quarantined {
			return ErrLaunchCleanupFatal
		}
		return ErrStandardIOCloseTimeout
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.quarantined {
		return ErrLaunchCleanupFatal
	}
	if s.handle != handle {
		return errors.New("Node standard-I/O handle changed during close")
	}
	if s.activeOperation != nil {
		return errors.New("Node standard-I/O completion did not release its operation")
	}
	disconnect := s.disconnect
	if disconnect == nil {
		disconnect = windows.DisconnectNamedPipe
	}
	if err := disconnect(handle); err != nil &&
		!errors.Is(err, windows.ERROR_PIPE_NOT_CONNECTED) &&
		!errors.Is(err, windows.ERROR_NO_DATA) {
		if errors.Is(err, windows.ERROR_INVALID_HANDLE) {
			s.handle = 0
			s.markQuarantinedLocked()
			return s.quarantineOwner(
				&windowsRawHandleOwner{kind: s.name + " pipe", value: handle},
				err,
			)
		}
		return fmt.Errorf("disconnect %s: %w", s.name, err)
	}
	closeHandle := s.closeHandle
	if closeHandle == nil {
		closeHandle = windows.CloseHandle
	}
	closeErr := consumeWindowsHandle(
		"close "+s.name+" handle",
		handle,
		closeHandle,
		s.quarantine,
	)
	s.handle = 0
	if closeErr != nil {
		s.markQuarantinedLocked()
	}
	return closeErr
}

func (s *windowsStandardIOStream) waitForActiveFlush() error {
	s.mu.Lock()
	if s.quarantined {
		s.mu.Unlock()
		return ErrLaunchCleanupFatal
	}
	owner := s.activeFlush
	s.mu.Unlock()
	if owner == nil {
		return nil
	}
	timer := time.NewTimer(standardIOCleanupGrace(s.closeTimeout))
	defer timer.Stop()
	select {
	case <-owner.finished:
		return nil
	case <-timer.C:
		s.mu.Lock()
		s.markQuarantinedLocked()
		s.mu.Unlock()
		return s.quarantineOwner(owner, ErrStandardIOCloseTimeout)
	}
}

func validateStandardIOTransferCount(buffer []byte, transferred uint32, reading bool) (int, error) {
	if transferred > uint32(len(buffer)) {
		return 0, errors.New("Node standard I/O returned an invalid byte count")
	}
	if !reading && transferred < uint32(len(buffer)) {
		return int(transferred), io.ErrShortWrite
	}
	return int(transferred), nil
}

func publishCompletedStandardIO(
	operation *windowsStandardIOOperation,
	callerBuffer []byte,
	reading bool,
) (int, error) {
	count, err := validateStandardIOTransferCount(callerBuffer, operation.transferred, reading)
	if err != nil {
		return count, err
	}
	if reading && count > 0 {
		copy(callerBuffer[:count], operation.buffer[:count])
	}
	return count, nil
}

func standardIODurationMilliseconds(value time.Duration) uint32 {
	if value <= 0 {
		return 0
	}
	milliseconds := (value + time.Millisecond - 1) / time.Millisecond
	if milliseconds > time.Duration(^uint32(0)) {
		return ^uint32(0)
	}
	return uint32(milliseconds)
}

func standardIOCleanupGrace(shutdownTimeout time.Duration) time.Duration {
	if shutdownTimeout <= 0 {
		return time.Second
	}
	return min(shutdownTimeout, maximumStandardIOCleanupGrace)
}

func acquireStandardIOOperation(ctx context.Context, gate chan struct{}, poisoned <-chan struct{}) error {
	select {
	case <-ctx.Done():
		return context.Cause(ctx)
	case <-poisoned:
		return ErrLaunchCleanupFatal
	case <-gate:
		return nil
	}
}

func releaseStandardIOOperation(gate chan struct{}) {
	gate <- struct{}{}
}
