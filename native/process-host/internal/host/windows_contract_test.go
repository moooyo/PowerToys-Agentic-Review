package host

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestRequiredProcessCreationAttributesIncludeAtomicJobAssignment(t *testing.T) {
	want := []processCreationAttributeKind{
		processCreationAttributeInheritedHandles,
		processCreationAttributeJobList,
	}
	if got := requiredProcessCreationAttributes(); !reflect.DeepEqual(got, want) {
		t.Fatalf("creation attributes = %v, want %v", got, want)
	}
}

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

func TestWaitForNoActiveProcessesObservesWholeTree(t *testing.T) {
	counter := &sequenceProcessCounter{counts: []uint32{3, 1, 0}}
	clock := &fakeDrainClock{now: time.Unix(0, 0)}
	if err := waitForNoActiveProcesses(counter, time.Second, 10*time.Millisecond, clock); err != nil {
		t.Fatal(err)
	}
	if counter.index != 3 {
		t.Fatalf("active-process queries = %d, want 3", counter.index)
	}
}

func TestWaitForNoActiveProcessesIsBounded(t *testing.T) {
	counter := &sequenceProcessCounter{counts: []uint32{1}}
	clock := &fakeDrainClock{now: time.Unix(0, 0)}
	err := waitForNoActiveProcesses(counter, 25*time.Millisecond, 10*time.Millisecond, clock)
	if !errors.Is(err, errProcessTreeNotEmpty) {
		t.Fatalf("error = %v, want process-tree timeout", err)
	}
}
