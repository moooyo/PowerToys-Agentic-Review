package hostcontrol

import (
	"testing"
	"time"
)

func TestActivityGroupWaitsForCompleteOperationTail(t *testing.T) {
	var active activityGroup
	finish := active.begin()
	waitResult := make(chan bool, 1)
	go func() {
		waitResult <- active.wait(time.Second)
	}()

	select {
	case <-waitResult:
		t.Fatal("activity wait returned before the operation tail finished")
	case <-time.After(10 * time.Millisecond):
	}

	tailComplete := make(chan struct{})
	close(tailComplete)
	finish()
	finish()
	select {
	case completed := <-waitResult:
		if !completed {
			t.Fatal("activity wait timed out after the operation tail finished")
		}
	case <-time.After(time.Second):
		t.Fatal("activity wait did not observe operation completion")
	}
	select {
	case <-tailComplete:
	default:
		t.Fatal("operation tail was not complete before activity release")
	}
}

func TestActivityGroupTimeoutsReuseOneDrainSignal(t *testing.T) {
	var active activityGroup
	finish := active.begin()
	active.mu.Lock()
	drained := active.drained
	active.mu.Unlock()
	if drained == nil {
		t.Fatal("activity group did not create its drain signal")
	}

	results := make(chan bool, 2)
	go func() { results <- active.wait(10 * time.Millisecond) }()
	go func() { results <- active.wait(10 * time.Millisecond) }()
	for range 2 {
		if <-results {
			t.Fatal("activity wait completed while work remained active")
		}
	}
	active.mu.Lock()
	if active.drained != drained {
		active.mu.Unlock()
		t.Fatal("timed waits replaced the shared drain signal")
	}
	active.mu.Unlock()

	finish()
	if !active.wait(time.Second) {
		t.Fatal("activity group did not drain after timed waiters returned")
	}
	select {
	case <-drained:
	default:
		t.Fatal("shared drain signal did not close")
	}
}
