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
