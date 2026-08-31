package relay

import (
	"context"
	"errors"
	"io"
	"sync"
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

func TestByteQueueSealDrainsQueuedAndInFlightBeforeEOF(t *testing.T) {
	queue := mustQueue(t, 8)
	if err := queue.Enqueue(context.Background(), []byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	first, err := queue.Dequeue(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := queue.Enqueue(context.Background(), []byte{4, 5}); err != nil {
		t.Fatal(err)
	}
	if !queue.Seal() || queue.Seal() {
		t.Fatal("Seal was not a single linearized transition")
	}
	if err := queue.Enqueue(context.Background(), []byte{6}); !errors.Is(err, ErrQueueSealed) {
		t.Fatalf("enqueue after seal error = %v, want ErrQueueSealed", err)
	}
	stats := queue.Stats()
	if !stats.Sealed || stats.Aborted || !stats.Closed || stats.ReservedBytes != 5 ||
		stats.QueuedItems != 1 || stats.InFlightItems != 1 {
		t.Fatalf("sealed stats = %#v", stats)
	}

	second, err := queue.Dequeue(context.Background())
	if err != nil || string(second.Bytes) != string([]byte{4, 5}) {
		t.Fatalf("second dequeue = (%v, %v)", second, err)
	}
	eofResult := make(chan error, 1)
	go func() {
		_, err := queue.Dequeue(context.Background())
		eofResult <- err
	}()
	drainResult := make(chan error, 1)
	go func() { drainResult <- queue.WaitDrained(context.Background()) }()

	first.Release()
	select {
	case err := <-eofResult:
		t.Fatalf("Dequeue returned before all in-flight ownership was released: %v", err)
	case err := <-drainResult:
		t.Fatalf("WaitDrained returned before all in-flight ownership was released: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	second.Release()
	select {
	case err := <-eofResult:
		if !errors.Is(err, io.EOF) {
			t.Fatalf("drained Dequeue error = %v, want EOF", err)
		}
	case <-time.After(time.Second):
		t.Fatal("drained Dequeue did not return EOF")
	}
	select {
	case err := <-drainResult:
		if err != nil {
			t.Fatalf("WaitDrained error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("WaitDrained did not observe released ownership")
	}
	stats = queue.Stats()
	if !stats.Sealed || stats.ReservedBytes != 0 || stats.QueuedItems != 0 || stats.InFlightItems != 0 {
		t.Fatalf("drained stats = %#v", stats)
	}
}

func TestByteQueueSealWakesBlockedOperations(t *testing.T) {
	full := mustQueue(t, 2)
	if err := full.Enqueue(context.Background(), []byte{1, 2}); err != nil {
		t.Fatal(err)
	}
	enqueueStarted := make(chan struct{})
	enqueueResult := make(chan error, 1)
	go func() {
		close(enqueueStarted)
		enqueueResult <- full.Enqueue(context.Background(), []byte{3})
	}()
	<-enqueueStarted
	select {
	case err := <-enqueueResult:
		t.Fatalf("blocked Enqueue returned before seal: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	full.Seal()
	select {
	case err := <-enqueueResult:
		if !errors.Is(err, ErrQueueSealed) {
			t.Fatalf("blocked Enqueue error = %v, want ErrQueueSealed", err)
		}
	case <-time.After(time.Second):
		t.Fatal("seal did not wake blocked Enqueue")
	}

	empty := mustQueue(t, 2)
	dequeueStarted := make(chan struct{})
	dequeueResult := make(chan error, 1)
	go func() {
		close(dequeueStarted)
		_, err := empty.Dequeue(context.Background())
		dequeueResult <- err
	}()
	<-dequeueStarted
	empty.Seal()
	select {
	case err := <-dequeueResult:
		if !errors.Is(err, io.EOF) {
			t.Fatalf("blocked Dequeue error = %v, want EOF", err)
		}
	case <-time.After(time.Second):
		t.Fatal("seal did not wake blocked Dequeue")
	}
}

func TestByteQueueAbortWakesBlockedOperations(t *testing.T) {
	cause := errors.New("transport failed")
	full := mustQueue(t, 1)
	if err := full.Enqueue(context.Background(), []byte{1}); err != nil {
		t.Fatal(err)
	}
	enqueueStarted := make(chan struct{})
	enqueueResult := make(chan error, 1)
	go func() {
		close(enqueueStarted)
		enqueueResult <- full.Enqueue(context.Background(), []byte{2})
	}()
	<-enqueueStarted
	select {
	case err := <-enqueueResult:
		t.Fatalf("blocked Enqueue returned before abort: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	full.Abort(cause)
	select {
	case err := <-enqueueResult:
		if !errors.Is(err, cause) {
			t.Fatalf("blocked Enqueue abort error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("abort did not wake blocked Enqueue")
	}

	empty := mustQueue(t, 1)
	dequeueStarted := make(chan struct{})
	dequeueResult := make(chan error, 1)
	go func() {
		close(dequeueStarted)
		_, err := empty.Dequeue(context.Background())
		dequeueResult <- err
	}()
	<-dequeueStarted
	select {
	case err := <-dequeueResult:
		t.Fatalf("blocked Dequeue returned before abort: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	empty.Abort(cause)
	select {
	case err := <-dequeueResult:
		if !errors.Is(err, cause) {
			t.Fatalf("blocked Dequeue abort error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("abort did not wake blocked Dequeue")
	}
}

func TestByteQueueAbortAfterSealWaitsForInFlightRelease(t *testing.T) {
	queue := mustQueue(t, 8)
	if err := queue.Enqueue(context.Background(), []byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	inFlight, err := queue.Dequeue(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := queue.Enqueue(context.Background(), []byte{4, 5}); err != nil {
		t.Fatal(err)
	}
	queue.Seal()
	drainResult := make(chan error, 1)
	go func() { drainResult <- queue.WaitDrained(context.Background()) }()

	abortCause := errors.New("write failed")
	if !queue.Abort(abortCause) || queue.Abort(errors.New("later failure")) {
		t.Fatal("Abort was not a single terminal transition")
	}
	queue.Close(errors.New("compatibility close must not replace the cause"))
	stats := queue.Stats()
	if stats.Sealed || !stats.Aborted || stats.ReservedBytes != 3 ||
		stats.QueuedItems != 0 || stats.InFlightItems != 1 {
		t.Fatalf("aborted stats = %#v", stats)
	}
	if _, err := queue.Dequeue(context.Background()); !errors.Is(err, abortCause) {
		t.Fatalf("Dequeue after abort error = %v", err)
	}
	select {
	case err := <-drainResult:
		t.Fatalf("WaitDrained returned before aborted in-flight release: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	inFlight.Release()
	select {
	case err := <-drainResult:
		if !errors.Is(err, abortCause) {
			t.Fatalf("aborted WaitDrained error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("aborted WaitDrained did not observe released ownership")
	}
}

func TestByteQueueWaitDrainedCancellation(t *testing.T) {
	queue := mustQueue(t, 1)
	ctx, cancel := context.WithCancelCause(context.Background())
	cause := errors.New("shutdown deadline")
	result := make(chan error, 1)
	go func() { result <- queue.WaitDrained(ctx) }()
	cancel(cause)
	select {
	case err := <-result:
		if !errors.Is(err, cause) {
			t.Fatalf("WaitDrained cancellation = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled WaitDrained did not return")
	}
	if err := queue.WaitDrained(nil); err == nil {
		t.Fatal("WaitDrained accepted a nil context")
	}
}

func TestByteQueueConcurrentSealAndAbortAreIdempotent(t *testing.T) {
	const callers = 16
	for iteration := 0; iteration < 100; iteration++ {
		queue := mustQueue(t, 1)
		start := make(chan struct{})
		type transition struct {
			seal  bool
			index int
			won   bool
		}
		results := make(chan transition, callers)
		causes := make([]error, callers/2)
		var group sync.WaitGroup
		group.Add(callers)
		for index := 0; index < callers; index++ {
			go func() {
				defer group.Done()
				<-start
				if index%2 == 0 {
					results <- transition{seal: true, index: index, won: queue.Seal()}
					return
				}
				causeIndex := index / 2
				cause := errors.New("concurrent abort")
				causes[causeIndex] = cause
				results <- transition{index: causeIndex, won: queue.Abort(cause)}
			}()
		}
		close(start)
		group.Wait()
		close(results)

		sealWinners := 0
		abortWinners := 0
		var winningCause error
		for result := range results {
			if !result.won {
				continue
			}
			if result.seal {
				sealWinners++
			} else {
				abortWinners++
				winningCause = causes[result.index]
			}
		}
		if sealWinners > 1 || abortWinners != 1 {
			t.Fatalf("iteration %d transition winners: seal=%d abort=%d", iteration, sealWinners, abortWinners)
		}
		stats := queue.Stats()
		if !stats.Aborted || stats.Sealed || stats.ReservedBytes != 0 {
			t.Fatalf("iteration %d final stats = %#v", iteration, stats)
		}
		if err := queue.WaitDrained(context.Background()); !errors.Is(err, winningCause) {
			t.Fatalf("iteration %d abort cause = %v, want %v", iteration, err, winningCause)
		}
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
