package winprocess

import (
	"errors"
	"testing"
	"time"
)

type sequenceProcessCounter struct {
	counts []uint32
	index  int
	err    error
}

func (c *sequenceProcessCounter) ActiveProcessCount() (uint32, error) {
	if c.err != nil {
		return 0, c.err
	}
	index := c.index
	if index >= len(c.counts) {
		index = len(c.counts) - 1
	} else {
		c.index++
	}
	return c.counts[index], nil
}

type fakeDrainClock struct {
	now time.Time
}

func (c *fakeDrainClock) Now() time.Time { return c.now }
func (c *fakeDrainClock) Sleep(duration time.Duration) {
	c.now = c.now.Add(duration)
}

func TestWaitForNoActiveProcessesObservesWholeRootJob(t *testing.T) {
	counter := &sequenceProcessCounter{counts: []uint32{4, 2, 1, 0}}
	clock := &fakeDrainClock{now: time.Unix(0, 0)}
	if err := waitForNoActiveProcesses(counter, time.Second, 10*time.Millisecond, clock); err != nil {
		t.Fatal(err)
	}
	if counter.index != 4 {
		t.Fatalf("active process queries = %d, want 4", counter.index)
	}
}

func TestWaitForNoActiveProcessesIsBounded(t *testing.T) {
	counter := &sequenceProcessCounter{counts: []uint32{1}}
	clock := &fakeDrainClock{now: time.Unix(0, 0)}
	err := waitForNoActiveProcesses(counter, 25*time.Millisecond, 10*time.Millisecond, clock)
	if !errors.Is(err, ErrJobDrainTimeout) {
		t.Fatalf("error = %v, want ErrJobDrainTimeout", err)
	}
}

func TestWaitForNoActiveProcessesPropagatesQueryFailure(t *testing.T) {
	want := errors.New("query failed")
	counter := &sequenceProcessCounter{err: want}
	clock := &fakeDrainClock{now: time.Unix(0, 0)}
	err := waitForNoActiveProcesses(counter, time.Second, 10*time.Millisecond, clock)
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want wrapped query error", err)
	}
}

func TestDrainThenCloseJobRetainsHandleAfterDrainFailure(t *testing.T) {
	want := errors.New("drain failed")
	closeCalled := false
	err := drainThenCloseJob(
		func() error { return want },
		func() error {
			closeCalled = true
			return nil
		},
	)
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want drain failure", err)
	}
	if closeCalled {
		t.Fatal("Job handle was closed after drain failure")
	}
}

func TestDrainThenCloseJobClosesOnlyAfterSuccessfulDrain(t *testing.T) {
	var operations []string
	err := drainThenCloseJob(
		func() error {
			operations = append(operations, "drain")
			return nil
		},
		func() error {
			operations = append(operations, "close")
			return nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"drain", "close"}
	if len(operations) != len(want) || operations[0] != want[0] || operations[1] != want[1] {
		t.Fatalf("operations = %v, want %v", operations, want)
	}
}
