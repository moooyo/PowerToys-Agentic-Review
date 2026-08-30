package host

import (
	"errors"
	"fmt"
	"time"
)

type processCreationAttributeKind uint8

const (
	processCreationAttributeInheritedHandles processCreationAttributeKind = iota + 1
	processCreationAttributeJobList
)

func requiredProcessCreationAttributes() []processCreationAttributeKind {
	return []processCreationAttributeKind{
		processCreationAttributeInheritedHandles,
		processCreationAttributeJobList,
	}
}

var (
	errProcessAlreadyExited = errors.New("process already exited")
	errProcessTreeNotEmpty  = errors.New("process tree did not become empty before the cleanup deadline")
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

func waitForNoActiveProcesses(
	counter activeProcessCounter,
	timeout time.Duration,
	pollInterval time.Duration,
	clock drainClock,
) error {
	if timeout <= 0 || pollInterval <= 0 {
		return errors.New("process-tree wait durations must be positive")
	}
	deadline := clock.Now().Add(timeout)
	for {
		active, err := counter.ActiveProcessCount()
		if err != nil {
			return fmt.Errorf("query active Job processes: %w", err)
		}
		if active == 0 {
			return nil
		}
		remaining := deadline.Sub(clock.Now())
		if remaining <= 0 {
			return fmt.Errorf("%w: %d process(es) remain", errProcessTreeNotEmpty, active)
		}
		if remaining < pollInterval {
			clock.Sleep(remaining)
		} else {
			clock.Sleep(pollInterval)
		}
	}
}
