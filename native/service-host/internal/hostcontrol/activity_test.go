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
