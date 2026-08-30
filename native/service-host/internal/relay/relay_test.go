package relay

import (
	"context"
	"errors"
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
