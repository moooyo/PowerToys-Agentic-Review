package relay

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestByteQueueCountsInFlightItemsAgainstCapacity(t *testing.T) {
	queue := mustQueue(t, 6)
	original := []byte{1, 2, 3, 4}
	if err := queue.Enqueue(context.Background(), original); err != nil {
		t.Fatalf("Enqueue returned an error: %v", err)
	}
	item, err := queue.Dequeue(context.Background())
	if err != nil {
		t.Fatalf("Dequeue returned an error: %v", err)
	}
	if &item.Bytes[0] != &original[0] {
		t.Fatal("Enqueue did not transfer ownership of the original byte slice")
	}

	enqueued := make(chan error, 1)
	go func() {
		enqueued <- queue.Enqueue(context.Background(), []byte{5, 6, 7})
	}()
	select {
	case err := <-enqueued:
		t.Fatalf("Enqueue completed before the in-flight reservation was released: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	item.Release()
	select {
	case err := <-enqueued:
		if err != nil {
			t.Fatalf("blocked Enqueue returned an error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Enqueue did not resume after reservation release")
	}

	stats := queue.Stats()
	if stats.ReservedBytes != 3 || stats.QueuedItems != 1 || stats.InFlightItems != 0 {
		t.Fatalf("unexpected queue accounting: %#v", stats)
	}
}

func TestByteQueueReleaseIsIdempotent(t *testing.T) {
	queue := mustQueue(t, 4)
	if err := queue.Enqueue(context.Background(), []byte{1, 2}); err != nil {
		t.Fatalf("Enqueue returned an error: %v", err)
	}
	item, err := queue.Dequeue(context.Background())
	if err != nil {
		t.Fatalf("Dequeue returned an error: %v", err)
	}
	item.Release()
	item.Release()
	if stats := queue.Stats(); stats.ReservedBytes != 0 || stats.InFlightItems != 0 {
		t.Fatalf("Release corrupted accounting: %#v", stats)
	}
}

func TestByteQueueCancellationAndCloseWakeWaiters(t *testing.T) {
	queue := mustQueue(t, 2)
	ctx, cancel := context.WithCancelCause(context.Background())
	cause := errors.New("lease lost")
	waiting := make(chan error, 1)
	go func() {
		_, err := queue.Dequeue(ctx)
		waiting <- err
	}()
	cancel(cause)
	select {
	case err := <-waiting:
		if !errors.Is(err, cause) {
			t.Fatalf("Dequeue returned the wrong cancellation cause: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled Dequeue did not wake")
	}

	closeCause := errors.New("pipe failed")
	queue.Close(closeCause)
	if err := queue.Enqueue(context.Background(), []byte{1}); !errors.Is(err, closeCause) {
		t.Fatalf("Enqueue returned the wrong close cause: %v", err)
	}
	if _, err := queue.Dequeue(context.Background()); !errors.Is(err, closeCause) {
		t.Fatalf("Dequeue returned the wrong close cause: %v", err)
	}
}

func TestByteQueueDoesNotCommitAfterCancellation(t *testing.T) {
	queue := mustQueue(t, 4)
	cancelled, cancel := context.WithCancelCause(context.Background())
	cause := errors.New("session lost")
	cancel(cause)
	if err := queue.Enqueue(cancelled, []byte{1}); !errors.Is(err, cause) {
		t.Fatalf("Enqueue returned the wrong cancellation cause: %v", err)
	}
	if err := queue.Enqueue(context.Background(), []byte{2}); err != nil {
		t.Fatalf("Enqueue returned an error: %v", err)
	}
	if _, err := queue.Dequeue(cancelled); !errors.Is(err, cause) {
		t.Fatalf("Dequeue returned the wrong cancellation cause: %v", err)
	}
	stats := queue.Stats()
	if stats.ReservedBytes != 1 || stats.QueuedItems != 1 || stats.InFlightItems != 0 {
		t.Fatalf("cancelled operations changed queue state: %#v", stats)
	}
}

func TestByteQueueCloseDropsQueuedButRetainsInFlightAccounting(t *testing.T) {
	queue := mustQueue(t, 8)
	if err := queue.Enqueue(context.Background(), []byte{1, 2, 3}); err != nil {
		t.Fatalf("Enqueue(first) returned an error: %v", err)
	}
	item, err := queue.Dequeue(context.Background())
	if err != nil {
		t.Fatalf("Dequeue returned an error: %v", err)
	}
	if err := queue.Enqueue(context.Background(), []byte{4, 5}); err != nil {
		t.Fatalf("Enqueue(second) returned an error: %v", err)
	}
	queue.Close(nil)
	stats := queue.Stats()
	if stats.ReservedBytes != 3 || stats.QueuedItems != 0 || stats.InFlightItems != 1 || !stats.Closed {
		t.Fatalf("Close returned unexpected accounting: %#v", stats)
	}
	item.Release()
	if stats := queue.Stats(); stats.ReservedBytes != 0 || stats.InFlightItems != 0 {
		t.Fatalf("released closed queue retained accounting: %#v", stats)
	}
}

func TestByteQueueRejectsInvalidItemsAndCapacity(t *testing.T) {
	if _, err := NewByteQueue(0); !errors.Is(err, ErrInvalidQueue) {
		t.Fatalf("expected invalid queue error, got %v", err)
	}
	queue := mustQueue(t, 2)
	if err := queue.Enqueue(context.Background(), nil); !errors.Is(err, ErrEmptyItem) {
		t.Fatalf("expected empty item error, got %v", err)
	}
	if err := queue.Enqueue(context.Background(), []byte{1, 2, 3}); !errors.Is(err, ErrItemTooLarge) {
		t.Fatalf("expected oversized item error, got %v", err)
	}
}

func mustQueue(t *testing.T, capacity int) *ByteQueue {
	t.Helper()
	queue, err := NewByteQueue(capacity)
	if err != nil {
		t.Fatalf("NewByteQueue returned an error: %v", err)
	}
	return queue
}
