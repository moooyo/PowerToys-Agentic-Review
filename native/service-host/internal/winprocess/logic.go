package winprocess

import (
	"context"
	"errors"
	"fmt"
	"time"
)

type activeProcessCounter interface {
	ActiveProcessCount() (uint32, error)
}

type drainClock interface {
	Now() time.Time
	Sleep(time.Duration)
}

type wallDrainClock struct{}

func (wallDrainClock) Now() time.Time               { return time.Now() }
func (wallDrainClock) Sleep(duration time.Duration) { time.Sleep(duration) }

const (
	nodeWaitObjectStatus    uint32 = 0
	nodeWaitTimeoutStatus   uint32 = 258
	nodeStillActiveExitCode uint32 = 259
	nodeWaitPollInterval           = 10 * time.Millisecond
)

type nodeProcessWaitOutcome struct {
	exitCode uint32
	waitErr  error
	exitErr  error
	terminal bool
}

// waitForNodeProcessContext keeps cancellation observational. A signaled
// process or native wait failure is terminal; cancellation after a timeout is
// not, so the caller may create another duplicate and wait again.
func waitForNodeProcessContext(
	ctx context.Context,
	poll func(time.Duration) (uint32, error),
	readExitCode func(*uint32) error,
) nodeProcessWaitOutcome {
	if ctx == nil {
		return nodeProcessWaitOutcome{waitErr: errors.New("Node process wait context is required")}
	}
	if poll == nil || readExitCode == nil {
		return nodeProcessWaitOutcome{
			waitErr:  errors.New("Node process wait operations are required"),
			terminal: true,
		}
	}
	for {
		if cause := context.Cause(ctx); cause != nil {
			return nodeProcessWaitOutcome{waitErr: cause}
		}
		status, err := poll(nodeWaitPollInterval)
		if err != nil {
			return nodeProcessWaitOutcome{waitErr: err, terminal: true}
		}
		switch status {
		case nodeWaitObjectStatus:
			var exitCode uint32
			exitErr := readExitCode(&exitCode)
			if exitErr == nil && exitCode == nodeStillActiveExitCode {
				exitErr = errors.New("signaled Node process wait handle reported STILL_ACTIVE")
			}
			return nodeProcessWaitOutcome{
				exitCode: exitCode,
				exitErr:  exitErr,
				terminal: true,
			}
		case nodeWaitTimeoutStatus:
			if cause := context.Cause(ctx); cause != nil {
				return nodeProcessWaitOutcome{waitErr: cause}
			}
		default:
			return nodeProcessWaitOutcome{
				waitErr:  fmt.Errorf("Node process wait returned 0x%x", status),
				terminal: true,
			}
		}
	}
}

func waitForNoActiveProcesses(
	counter activeProcessCounter,
	timeout time.Duration,
	pollInterval time.Duration,
	clock drainClock,
) error {
	if counter == nil || clock == nil {
		return errors.New("Job process counter and clock are required")
	}
	if timeout <= 0 || pollInterval <= 0 {
		return errors.New("Job drain durations must be positive")
	}
	deadline := clock.Now().Add(timeout)
	for {
		active, err := counter.ActiveProcessCount()
		if err != nil {
			return fmt.Errorf("query active service-root Job processes: %w", err)
		}
		if active == 0 {
			return nil
		}
		remaining := deadline.Sub(clock.Now())
		if remaining <= 0 {
			return fmt.Errorf("%w: %d process(es) remain", ErrJobDrainTimeout, active)
		}
		if remaining < pollInterval {
			clock.Sleep(remaining)
		} else {
			clock.Sleep(pollInterval)
		}
	}
}

// drainThenCloseJob preserves the lifetime handle when drain fails. Callers
// retry the non-consuming termination/drain operation and never close the Job
// or process handle until zero active processes has been proved.
func drainThenCloseJob(drain func() error, closeJob func() error) error {
	if drain == nil || closeJob == nil {
		return errors.New("Job drain and close operations are required")
	}
	if err := drain(); err != nil {
		return err
	}
	return closeJob()
}

type serviceState uint32

const (
	serviceStopped         serviceState = 1
	serviceStartPending    serviceState = 2
	serviceStopPending     serviceState = 3
	serviceRunning         serviceState = 4
	serviceContinuePending serviceState = 5
	servicePausePending    serviceState = 6
	servicePaused          serviceState = 7
)

type serviceProcessStatus struct {
	state     serviceState
	processID uint32
}

type serviceStatusSource interface {
	Status() (serviceProcessStatus, error)
}

type wrapperProcessOpener interface {
	Open(uint32) (wrapperProcessHandle, error)
}

type wrapperProcessHandle interface {
	QueryProcessID() (uint32, error)
	StillActive() (bool, error)
	QueryCreationTime() (time.Time, error)
	Wait(context.Context) error
	Close() error
}

type stableWrapper struct {
	process      wrapperProcessHandle
	processID    uint32
	creationTime time.Time
}

func (w *stableWrapper) ProcessID() uint32       { return w.processID }
func (w *stableWrapper) CreationTime() time.Time { return w.creationTime }
func (w *stableWrapper) Wait(ctx context.Context) error {
	return w.process.Wait(ctx)
}
func (w *stableWrapper) Close() error { return w.process.Close() }

// openStableWrapper consumes a rejected process owner exactly once. Concrete
// Windows handles quarantine an unresolved close until process exit; callers
// must never retry a raw numeric handle after Close reports an error.
func openStableWrapper(source serviceStatusSource, opener wrapperProcessOpener) (watcher WrapperWatcher, err error) {
	if source == nil || opener == nil {
		return nil, errors.New("SCM status source and process opener are required")
	}
	first, err := source.Status()
	if err != nil {
		return nil, fmt.Errorf("read WinSW service status before opening wrapper: %w", err)
	}
	if err := validateStableServiceStatus(first); err != nil {
		return nil, err
	}

	process, err := opener.Open(first.processID)
	if err != nil {
		return nil, fmt.Errorf("open WinSW wrapper process %d: %w", first.processID, err)
	}
	keep := false
	defer func() {
		if !keep {
			_, closeErr := closeRejectedWrapper(process)
			err = errors.Join(err, closeErr)
		}
	}()

	second, err := source.Status()
	if err != nil {
		return nil, fmt.Errorf("read WinSW service status after opening wrapper: %w", err)
	}
	if err := validateStableServiceStatus(second); err != nil {
		return nil, err
	}
	if second.processID != first.processID {
		return nil, fmt.Errorf("%w: SCM wrapper PID changed from %d to %d", ErrWrapperUnstable, first.processID, second.processID)
	}

	handlePID, err := process.QueryProcessID()
	if err != nil {
		return nil, fmt.Errorf("read WinSW wrapper PID from retained handle: %w", err)
	}
	if handlePID != first.processID {
		return nil, fmt.Errorf("%w: retained handle PID is %d, SCM PID is %d", ErrWrapperUnstable, handlePID, first.processID)
	}
	active, err := process.StillActive()
	if err != nil {
		return nil, fmt.Errorf("inspect WinSW wrapper liveness: %w", err)
	}
	if !active {
		return nil, fmt.Errorf("%w: retained wrapper process is not active", ErrWrapperUnstable)
	}
	creationTime, err := process.QueryCreationTime()
	if err != nil {
		return nil, fmt.Errorf("read WinSW wrapper creation time: %w", err)
	}
	if creationTime.IsZero() {
		return nil, fmt.Errorf("%w: wrapper creation time is zero", ErrWrapperUnstable)
	}

	keep = true
	return &stableWrapper{
		process:      process,
		processID:    handlePID,
		creationTime: creationTime,
	}, nil
}

func closeRejectedWrapper(resource interface{ Close() error }) (bool, error) {
	if resource == nil {
		return true, nil
	}
	if err := resource.Close(); err != nil {
		return true, fmt.Errorf("consume rejected WinSW wrapper: %w", err)
	}
	return true, nil
}

func validateStableServiceStatus(status serviceProcessStatus) error {
	if status.state != serviceRunning && status.state != servicePaused {
		return fmt.Errorf("%w: SCM state %d is not running or paused", ErrWrapperUnstable, status.state)
	}
	if status.processID == 0 {
		return fmt.Errorf("%w: SCM returned a zero wrapper PID", ErrWrapperUnstable)
	}
	return nil
}
