package winprocess

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"
)

type fakeServiceStatusSource struct {
	statuses []serviceProcessStatus
	index    int
	events   *[]string
}

func (s *fakeServiceStatusSource) Status() (serviceProcessStatus, error) {
	*s.events = append(*s.events, "scm-status")
	if s.index >= len(s.statuses) {
		return serviceProcessStatus{}, errors.New("unexpected status read")
	}
	status := s.statuses[s.index]
	s.index++
	return status, nil
}

type fakeWrapperProcessOpener struct {
	process wrapperProcessHandle
	events  *[]string
}

func (o fakeWrapperProcessOpener) Open(processID uint32) (wrapperProcessHandle, error) {
	*o.events = append(*o.events, fmt.Sprintf("open-%d", processID))
	return o.process, nil
}

type fakeWrapperProcess struct {
	processID    uint32
	active       bool
	creationTime time.Time
	waitErr      error
	closed       bool
	events       *[]string
}

func (p *fakeWrapperProcess) QueryProcessID() (uint32, error) {
	*p.events = append(*p.events, "handle-pid")
	return p.processID, nil
}

func (p *fakeWrapperProcess) StillActive() (bool, error) {
	*p.events = append(*p.events, "still-active")
	return p.active, nil
}

func (p *fakeWrapperProcess) QueryCreationTime() (time.Time, error) {
	*p.events = append(*p.events, "creation-time")
	return p.creationTime, nil
}

func (p *fakeWrapperProcess) Wait(context.Context) error {
	*p.events = append(*p.events, "wait")
	return p.waitErr
}

func (p *fakeWrapperProcess) Close() error {
	p.closed = true
	*p.events = append(*p.events, "close")
	return nil
}

func TestOpenStableWrapperUsesSCMOpenSCMHandleVerificationOrder(t *testing.T) {
	var events []string
	created := time.Unix(1_700_000_000, 123).UTC()
	process := &fakeWrapperProcess{
		processID:    42,
		active:       true,
		creationTime: created,
		events:       &events,
	}
	source := &fakeServiceStatusSource{
		statuses: []serviceProcessStatus{
			{state: serviceRunning, processID: 42},
			{state: servicePaused, processID: 42},
		},
		events: &events,
	}
	watcher, err := openStableWrapper(source, fakeWrapperProcessOpener{process: process, events: &events})
	if err != nil {
		t.Fatal(err)
	}
	wantEvents := []string{
		"scm-status",
		"open-42",
		"scm-status",
		"handle-pid",
		"still-active",
		"creation-time",
	}
	if !reflect.DeepEqual(events, wantEvents) {
		t.Fatalf("operation order = %v, want %v", events, wantEvents)
	}
	if watcher.ProcessID() != 42 || !watcher.CreationTime().Equal(created) {
		t.Fatalf("watcher identity = (%d, %v), want (42, %v)", watcher.ProcessID(), watcher.CreationTime(), created)
	}
	if process.closed {
		t.Fatal("retained process handle was closed during verification")
	}
	if err := watcher.Close(); err != nil {
		t.Fatal(err)
	}
	if !process.closed {
		t.Fatal("watcher Close did not close the retained process handle")
	}
}

func TestOpenStableWrapperRejectsEveryNonstableServiceState(t *testing.T) {
	states := []serviceState{
		serviceStopped,
		serviceStartPending,
		serviceStopPending,
		serviceContinuePending,
		servicePausePending,
	}
	for _, state := range states {
		t.Run(fmt.Sprintf("state-%d", state), func(t *testing.T) {
			var events []string
			source := &fakeServiceStatusSource{
				statuses: []serviceProcessStatus{{state: state, processID: 42}},
				events:   &events,
			}
			process := &fakeWrapperProcess{events: &events}
			_, err := openStableWrapper(source, fakeWrapperProcessOpener{process: process, events: &events})
			if !errors.Is(err, ErrWrapperUnstable) {
				t.Fatalf("error = %v, want ErrWrapperUnstable", err)
			}
			if len(events) != 1 || events[0] != "scm-status" {
				t.Fatalf("operations after unstable state = %v, want only first SCM read", events)
			}
		})
	}
}

func TestOpenStableWrapperRejectsPendingSecondSCMReadAndClosesHandle(t *testing.T) {
	var events []string
	process := &fakeWrapperProcess{
		processID:    42,
		active:       true,
		creationTime: time.Now(),
		events:       &events,
	}
	source := &fakeServiceStatusSource{
		statuses: []serviceProcessStatus{
			{state: serviceRunning, processID: 42},
			{state: serviceStopPending, processID: 42},
		},
		events: &events,
	}
	_, err := openStableWrapper(source, fakeWrapperProcessOpener{process: process, events: &events})
	if !errors.Is(err, ErrWrapperUnstable) {
		t.Fatalf("error = %v, want ErrWrapperUnstable", err)
	}
	if !process.closed {
		t.Fatal("process handle was not closed after the second SCM read became pending")
	}
}

func TestOpenStableWrapperClosesHandleOnIdentityOrLivenessFailure(t *testing.T) {
	tests := []struct {
		name      string
		firstPID  uint32
		secondPID uint32
		handlePID uint32
		active    bool
		created   time.Time
	}{
		{name: "SCM PID changed", firstPID: 42, secondPID: 43, handlePID: 42, active: true, created: time.Now()},
		{name: "handle PID mismatch", firstPID: 42, secondPID: 42, handlePID: 43, active: true, created: time.Now()},
		{name: "wrapper exited", firstPID: 42, secondPID: 42, handlePID: 42, active: false, created: time.Now()},
		{name: "zero creation time", firstPID: 42, secondPID: 42, handlePID: 42, active: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var events []string
			process := &fakeWrapperProcess{
				processID:    test.handlePID,
				active:       test.active,
				creationTime: test.created,
				events:       &events,
			}
			source := &fakeServiceStatusSource{
				statuses: []serviceProcessStatus{
					{state: serviceRunning, processID: test.firstPID},
					{state: serviceRunning, processID: test.secondPID},
				},
				events: &events,
			}
			_, err := openStableWrapper(source, fakeWrapperProcessOpener{process: process, events: &events})
			if !errors.Is(err, ErrWrapperUnstable) {
				t.Fatalf("error = %v, want ErrWrapperUnstable", err)
			}
			if !process.closed {
				t.Fatal("rejected wrapper process handle was not closed")
			}
		})
	}
}

type fakeRootTerminator struct {
	called bool
	err    error
}

func (t *fakeRootTerminator) Terminate() error {
	t.called = true
	return t.err
}

func TestWatchWrapperSignalTerminatesRootJob(t *testing.T) {
	events := []string{}
	watcher := &stableWrapper{
		process:      &fakeWrapperProcess{events: &events},
		processID:    42,
		creationTime: time.Now(),
	}
	root := &fakeRootTerminator{}
	if err := WatchWrapper(context.Background(), watcher, root); err != nil {
		t.Fatal(err)
	}
	if !root.called {
		t.Fatal("wrapper signal did not terminate the root Job")
	}
}

func TestWatchWrapperAlwaysTerminatesRootJob(t *testing.T) {
	waitErr := errors.New("wrapper monitor failed")
	terminateErr := errors.New("root Job drain failed")
	events := []string{}
	watcher := &stableWrapper{
		process: &fakeWrapperProcess{
			waitErr: waitErr,
			events:  &events,
		},
		processID:    42,
		creationTime: time.Now(),
	}
	root := &fakeRootTerminator{err: terminateErr}
	err := WatchWrapper(context.Background(), watcher, root)
	if !root.called {
		t.Fatal("wrapper monitor failure did not terminate the root Job")
	}
	if !errors.Is(err, waitErr) || !errors.Is(err, terminateErr) {
		t.Fatalf("error = %v, want both wait and termination failures", err)
	}
}
