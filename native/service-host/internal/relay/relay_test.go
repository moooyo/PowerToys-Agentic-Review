package relay

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"
)

func TestRelayTransfersFramesInBothDirections(t *testing.T) {
	left := newScriptedEndpoint()
	right := newScriptedEndpoint()
	ctx, cancel := context.WithCancelCause(context.Background())
	result := make(chan error, 1)
	go func() {
		result <- Run(ctx, left, right, testRelayOptions())
	}()

	left.reads <- readResult{value: []byte("left-to-right")}
	right.reads <- readResult{value: []byte("right-to-left")}
	if value := receiveBytes(t, right.writes); string(value) != "left-to-right" {
		t.Fatalf("right received %q", value)
	}
	if value := receiveBytes(t, left.writes); string(value) != "right-to-left" {
		t.Fatalf("left received %q", value)
	}

	cause := errors.New("test shutdown")
	cancel(cause)
	if err := receiveError(t, result); !errors.Is(err, cause) {
		t.Fatalf("Run returned the wrong cancellation cause: %v", err)
	}
}

func TestAuthorizedDirectionalEOFSealsAndDrainsQueuedTail(t *testing.T) {
	left := newScriptedEndpoint()
	right := newScriptedEndpoint()
	releaseWrite := make(chan struct{})
	right.writeBlock = releaseWrite
	left.reads <- readResult{value: []byte("final-frame")}
	left.reads <- readResult{err: io.EOF}

	queue := mustQueue(t, 64)
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	authorized := make(chan struct{})
	drained := make(chan struct{})
	failures := make(chan error, 1)
	fail := func(err error) {
		select {
		case failures <- err:
		default:
		}
		cancel(err)
	}
	var workers sync.WaitGroup
	workers.Add(2)
	go readLoopWithEOFPolicy(ctx, "left", left, queue, func() bool {
		close(authorized)
		return true
	}, &workers, fail)
	go writeLoopWithDrain(ctx, "right", right, queue, func() { close(drained) }, &workers, fail)

	select {
	case <-authorized:
	case err := <-failures:
		t.Fatalf("direction failed before EOF authorization: %v", err)
	case <-time.After(time.Second):
		t.Fatal("read loop did not observe the authorized EOF")
	}
	select {
	case <-drained:
		t.Fatal("direction drained while its final write was blocked")
	case err := <-failures:
		t.Fatalf("direction failed while its final write was blocked: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	close(releaseWrite)
	if value := receiveBytes(t, right.writes); string(value) != "final-frame" {
		t.Fatalf("right received %q", value)
	}
	select {
	case <-drained:
	case err := <-failures:
		t.Fatalf("direction failed instead of draining: %v", err)
	case <-time.After(time.Second):
		t.Fatal("write loop did not report the sealed direction drained")
	}
	workersDone := make(chan struct{})
	go func() {
		workers.Wait()
		close(workersDone)
	}()
	select {
	case <-workersDone:
	case <-time.After(time.Second):
		t.Fatal("authorized direction workers did not stop")
	}
	stats := queue.Stats()
	if !stats.Sealed || stats.Aborted || stats.ReservedBytes != 0 ||
		stats.QueuedItems != 0 || stats.InFlightItems != 0 {
		t.Fatalf("drained direction stats = %#v", stats)
	}
	select {
	case err := <-failures:
		t.Fatalf("authorized direction reported a failure: %v", err)
	default:
	}
}

func TestEOFPolicyRejectsAmbiguousEOFTerminations(t *testing.T) {
	secondary := errors.New("secondary failure")
	tests := []struct {
		name  string
		value []byte
		err   error
	}{
		{name: "value with exact EOF", value: []byte("tail"), err: io.EOF},
		{name: "value with wrapped EOF", value: []byte("tail"), err: fmt.Errorf("wrapped: %w", io.EOF)},
		{name: "empty wrapped EOF", err: fmt.Errorf("wrapped: %w", io.EOF)},
		{name: "empty joined EOF", err: errors.Join(io.EOF, secondary)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			endpoint := newScriptedEndpoint()
			endpoint.reads <- readResult{value: test.value, err: test.err}
			queue := mustQueue(t, 64)
			failures := make(chan error, 1)
			authorizationCalls := 0
			var workers sync.WaitGroup
			workers.Add(1)
			go readLoopWithEOFPolicy(
				context.Background(),
				"left",
				endpoint,
				queue,
				func() bool {
					authorizationCalls++
					return true
				},
				&workers,
				func(err error) {
					queue.Abort(err)
					failures <- err
				},
			)
			var failure error
			select {
			case failure = <-failures:
			case <-time.After(time.Second):
				t.Fatal("ambiguous EOF did not fail closed")
			}
			workers.Wait()
			if !errors.Is(failure, io.EOF) {
				t.Fatalf("failure = %v, want original EOF cause", failure)
			}
			if authorizationCalls != 0 {
				t.Fatalf("authorization callback calls = %d, want zero", authorizationCalls)
			}
			stats := queue.Stats()
			if stats.Sealed || !stats.Aborted || stats.ReservedBytes != 0 ||
				stats.QueuedItems != 0 || stats.InFlightItems != 0 {
				t.Fatalf("ambiguous EOF queue stats = %#v", stats)
			}
			if err := queue.WaitDrained(context.Background()); !errors.Is(err, failure) {
				t.Fatalf("WaitDrained error = %v, want failure %v", err, failure)
			}
		})
	}
}

func TestWriteLoopDoesNotTreatAbortCauseEOFAsGracefulDrain(t *testing.T) {
	queue := mustQueue(t, 64)
	queue.Abort(io.EOF)
	endpoint := newScriptedEndpoint()
	drained := make(chan struct{})
	failures := make(chan error, 1)
	var workers sync.WaitGroup
	workers.Add(1)
	go writeLoopWithDrain(
		context.Background(),
		"right",
		endpoint,
		queue,
		func() { close(drained) },
		&workers,
		func(err error) { failures <- err },
	)
	select {
	case err := <-failures:
		if !errors.Is(err, io.EOF) {
			t.Fatalf("write loop failure = %v, want EOF cause", err)
		}
	case <-drained:
		t.Fatal("aborted queue was reported as gracefully drained")
	case <-time.After(time.Second):
		t.Fatal("write loop did not classify the aborted queue")
	}
	workers.Wait()
}

func TestRelayClosesBothEndpointsAfterReadFailure(t *testing.T) {
	left := newScriptedEndpoint()
	right := newScriptedEndpoint()
	left.reads <- readResult{err: io.EOF}
	err := Run(context.Background(), left, right, testRelayOptions())
	if !errors.Is(err, io.EOF) {
		t.Fatalf("Run returned the wrong read failure: %v", err)
	}
	assertClosed(t, left.closed)
	assertClosed(t, right.closed)
}

func TestRelayPreservesWriteFailure(t *testing.T) {
	left := newScriptedEndpoint()
	right := newScriptedEndpoint()
	cause := errors.New("write failed")
	right.writeError = cause
	left.reads <- readResult{value: []byte("frame")}
	err := Run(context.Background(), left, right, testRelayOptions())
	if !errors.Is(err, cause) {
		t.Fatalf("Run returned the wrong write failure: %v", err)
	}
}

func TestRelayRejectsInvalidOptions(t *testing.T) {
	err := Run(context.Background(), newScriptedEndpoint(), newScriptedEndpoint(), Options{
		ShutdownTimeout: time.Second,
	})
	if !errors.Is(err, ErrInvalidQueue) {
		t.Fatalf("Run returned the wrong options error: %v", err)
	}
	err = Run(context.Background(), newScriptedEndpoint(), newScriptedEndpoint(), Options{
		MaximumQueuedBytesPerDirection: 64,
	})
	if err == nil {
		t.Fatal("Run accepted a missing shutdown timeout")
	}
}

func TestRelayReturnsWhenEndpointCloseBlocks(t *testing.T) {
	left := newScriptedEndpoint()
	right := newScriptedEndpoint()
	closeFailure := errors.New("left close failed")
	left.closeError = closeFailure
	releaseClose := make(chan struct{})
	right.closeBlock = releaseClose
	left.reads <- readResult{err: io.EOF}
	err := Run(context.Background(), left, right, Options{
		MaximumQueuedBytesPerDirection: 64,
		ShutdownTimeout:                25 * time.Millisecond,
	})
	close(releaseClose)
	if !errors.Is(err, io.EOF) || !errors.Is(err, ErrShutdownTimeout) || !errors.Is(err, closeFailure) {
		t.Fatalf("Run did not preserve failure and shutdown timeout: %v", err)
	}
}

func testRelayOptions() Options {
	return Options{
		MaximumQueuedBytesPerDirection: 64,
		ShutdownTimeout:                time.Second,
	}
}

type readResult struct {
	value []byte
	err   error
}

type scriptedEndpoint struct {
	reads      chan readResult
	writes     chan []byte
	closed     chan struct{}
	closeOnce  sync.Once
	writeBlock <-chan struct{}
	writeError error
	closeBlock <-chan struct{}
	closeError error
}

func newScriptedEndpoint() *scriptedEndpoint {
	return &scriptedEndpoint{
		reads:  make(chan readResult, 4),
		writes: make(chan []byte, 4),
		closed: make(chan struct{}),
	}
}

func (e *scriptedEndpoint) ReadFrame(ctx context.Context) ([]byte, error) {
	select {
	case result := <-e.reads:
		return append([]byte(nil), result.value...), result.err
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-e.closed:
		return nil, io.ErrClosedPipe
	}
}

func (e *scriptedEndpoint) WriteFrame(ctx context.Context, value []byte) error {
	if e.writeBlock != nil {
		select {
		case <-e.writeBlock:
		case <-ctx.Done():
			return ctx.Err()
		case <-e.closed:
			return io.ErrClosedPipe
		}
	}
	if e.writeError != nil {
		return e.writeError
	}
	copyOfValue := append([]byte(nil), value...)
	select {
	case e.writes <- copyOfValue:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-e.closed:
		return io.ErrClosedPipe
	}
}

func (e *scriptedEndpoint) Close() error {
	if e.closeBlock != nil {
		<-e.closeBlock
	}
	e.closeOnce.Do(func() { close(e.closed) })
	return e.closeError
}

func receiveBytes(t *testing.T, values <-chan []byte) []byte {
	t.Helper()
	select {
	case value := <-values:
		return value
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for relayed bytes")
		return nil
	}
}

func receiveError(t *testing.T, values <-chan error) error {
	t.Helper()
	select {
	case value := <-values:
		return value
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for relay result")
		return nil
	}
}

func assertClosed(t *testing.T, closed <-chan struct{}) {
	t.Helper()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("endpoint was not closed")
	}
}
