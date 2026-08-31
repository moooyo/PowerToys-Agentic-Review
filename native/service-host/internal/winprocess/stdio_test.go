package winprocess

import (
	"context"
	"errors"
	"io"
	"sync"
	"testing"
	"time"
)

type retryStandardIOStream struct {
	mu            sync.Mutex
	closeFailures []error
	closeAttempts int
	closed        bool
}

func (s *retryStandardIOStream) Read([]byte) (int, error) {
	return 0, io.EOF
}

func (s *retryStandardIOStream) ReadContext(context.Context, []byte) (int, error) {
	return 0, io.EOF
}

func (s *retryStandardIOStream) Write(buffer []byte) (int, error) {
	return len(buffer), nil
}

func (s *retryStandardIOStream) WriteContext(_ context.Context, buffer []byte) (int, error) {
	return len(buffer), nil
}

func (s *retryStandardIOStream) CloseWrite(context.Context) error {
	return s.Close()
}

func (s *retryStandardIOStream) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closeAttempts++
	if len(s.closeFailures) > 0 {
		err := s.closeFailures[0]
		s.closeFailures = s.closeFailures[1:]
		return err
	}
	s.closed = true
	return nil
}

func (s *retryStandardIOStream) snapshot() (int, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closeAttempts, s.closed
}

func newTestStandardIO() (*NodeStandardIO, [3]*retryStandardIOStream) {
	streams := [3]*retryStandardIOStream{{}, {}, {}}
	return newNodeStandardIO(streams[0], streams[1], streams[2]), streams
}

func TestStandardIOOwnershipTransfersExactlyOnce(t *testing.T) {
	standardIO, streams := newTestStandardIO()
	ownership := newStandardIOOwnership(standardIO)

	const callers = 64
	start := make(chan struct{})
	results := make(chan *NodeStandardIO, callers)
	errorsSeen := make(chan error, callers)
	var group sync.WaitGroup
	group.Add(callers)
	for range callers {
		go func() {
			defer group.Done()
			<-start
			result, err := ownership.take()
			results <- result
			errorsSeen <- err
		}()
	}
	close(start)
	group.Wait()
	close(results)
	close(errorsSeen)

	successes := 0
	for result := range results {
		if result != nil {
			successes++
			if result != standardIO {
				t.Fatal("ownership transfer returned a different standard-I/O owner")
			}
		}
	}
	unavailable := 0
	for err := range errorsSeen {
		if err == nil {
			continue
		}
		if !errors.Is(err, ErrStandardIOUnavailable) {
			t.Fatalf("ownership transfer error = %v", err)
		}
		unavailable++
	}
	if successes != 1 || unavailable != callers-1 {
		t.Fatalf("successful transfers = %d, unavailable = %d", successes, unavailable)
	}
	if err := ownership.closeOwned(); err != nil {
		t.Fatalf("close after transfer: %v", err)
	}
	for index, stream := range streams {
		attempts, closed := stream.snapshot()
		if attempts != 0 || closed {
			t.Fatalf("stream %d was closed by the former owner: attempts=%d closed=%v", index, attempts, closed)
		}
	}
	if err := standardIO.Close(); err != nil {
		t.Fatalf("transferred owner Close: %v", err)
	}
}

func TestNodeStandardIOCloseRetriesOnlyFailedResources(t *testing.T) {
	closeFailure := errors.New("injected stream close failure")
	standardIO, streams := newTestStandardIO()
	streams[1].closeFailures = []error{closeFailure}

	if err := standardIO.Close(); !errors.Is(err, closeFailure) {
		t.Fatalf("first Close error = %v", err)
	}
	wantAttempts := [3]int{1, 1, 1}
	wantClosed := [3]bool{true, false, true}
	assertStandardIOState(t, streams, wantAttempts, wantClosed)

	if err := standardIO.Close(); err != nil {
		t.Fatalf("retry Close error = %v", err)
	}
	wantAttempts = [3]int{1, 2, 1}
	wantClosed = [3]bool{true, true, true}
	assertStandardIOState(t, streams, wantAttempts, wantClosed)

	const concurrentClosers = 32
	closeErrors := make(chan error, concurrentClosers)
	var group sync.WaitGroup
	group.Add(concurrentClosers)
	for range concurrentClosers {
		go func() {
			defer group.Done()
			closeErrors <- standardIO.Close()
		}()
	}
	group.Wait()
	close(closeErrors)
	for err := range closeErrors {
		if err != nil {
			t.Fatalf("concurrent idempotent Close error = %v", err)
		}
	}
	assertStandardIOState(t, streams, wantAttempts, wantClosed)
}

func TestNodeStandardIOValueCopiesShareCloseState(t *testing.T) {
	standardIO, streams := newTestStandardIO()
	copyByValue := *standardIO
	results := make(chan error, 2)
	go func() { results <- standardIO.Close() }()
	go func() { results <- copyByValue.Close() }()
	for range 2 {
		if err := <-results; err != nil {
			t.Fatalf("Close through copied owner error = %v", err)
		}
	}
	wantAttempts := [3]int{1, 1, 1}
	wantClosed := [3]bool{true, true, true}
	assertStandardIOState(t, streams, wantAttempts, wantClosed)
}

func TestStandardIOOwnershipRetainsPartialCloseFailure(t *testing.T) {
	closeFailure := errors.New("injected retained close failure")
	standardIO, streams := newTestStandardIO()
	streams[2].closeFailures = []error{closeFailure}
	ownership := newStandardIOOwnership(standardIO)

	if err := ownership.closeOwned(); !errors.Is(err, closeFailure) {
		t.Fatalf("first owned Close error = %v", err)
	}
	if transferred, err := ownership.take(); transferred != nil || !errors.Is(err, ErrStandardIOUnavailable) {
		t.Fatalf("Take after failed owned Close = (%v, %v)", transferred, err)
	}
	if err := ownership.closeOwned(); err != nil {
		t.Fatalf("retry owned Close error = %v", err)
	}
	wantAttempts := [3]int{1, 1, 2}
	wantClosed := [3]bool{true, true, true}
	assertStandardIOState(t, streams, wantAttempts, wantClosed)
}

func TestStandardIOTransferAndCloseRaceIsLinearizable(t *testing.T) {
	const iterations = 200
	for iteration := range iterations {
		standardIO, streams := newTestStandardIO()
		ownership := newStandardIOOwnership(standardIO)
		start := make(chan struct{})
		takeResult := make(chan struct {
			standardIO *NodeStandardIO
			err        error
		}, 1)
		closeResult := make(chan error, 1)
		go func() {
			<-start
			result, err := ownership.take()
			takeResult <- struct {
				standardIO *NodeStandardIO
				err        error
			}{standardIO: result, err: err}
		}()
		go func() {
			<-start
			closeResult <- ownership.closeOwned()
		}()
		close(start)
		taken := <-takeResult
		if err := <-closeResult; err != nil {
			t.Fatalf("iteration %d owned Close error = %v", iteration, err)
		}

		if taken.err == nil {
			if taken.standardIO != standardIO {
				t.Fatalf("iteration %d returned a different standard-I/O owner", iteration)
			}
			for index, stream := range streams {
				attempts, closed := stream.snapshot()
				if attempts != 0 || closed {
					t.Fatalf("iteration %d stream %d was closed after transfer", iteration, index)
				}
			}
			if err := taken.standardIO.Close(); err != nil {
				t.Fatalf("iteration %d transferred Close error = %v", iteration, err)
			}
			continue
		}
		if !errors.Is(taken.err, ErrStandardIOUnavailable) || taken.standardIO != nil {
			t.Fatalf("iteration %d Take result = (%v, %v)", iteration, taken.standardIO, taken.err)
		}
		wantAttempts := [3]int{1, 1, 1}
		wantClosed := [3]bool{true, true, true}
		assertStandardIOState(t, streams, wantAttempts, wantClosed)
	}
}

func TestStandardIOTransferRejectsIncompleteOrSealedOwner(t *testing.T) {
	complete, _ := newTestStandardIO()
	sealed := newStandardIOOwnership(complete)
	sealed.seal()
	if result, err := sealed.take(); result != nil || !errors.Is(err, ErrStandardIOUnavailable) {
		t.Fatalf("sealed Take = (%v, %v)", result, err)
	}

	var typedNil *retryStandardIOStream
	incomplete := newStandardIOOwnership(newNodeStandardIO(typedNil, &retryStandardIOStream{}, &retryStandardIOStream{}))
	if result, err := incomplete.take(); result != nil || !errors.Is(err, ErrStandardIOUnavailable) {
		t.Fatalf("incomplete Take = (%v, %v)", result, err)
	}
}

func TestStandardIOActivityWaitsForOperationTail(t *testing.T) {
	var activity standardIOActivity
	finish := activity.begin()
	if activity.wait(time.Millisecond) {
		t.Fatal("activity wait completed before the operation tail")
	}
	finish()
	finish()
	if !activity.wait(time.Second) {
		t.Fatal("activity wait did not complete after the operation tail")
	}
}

func assertStandardIOState(
	t *testing.T,
	streams [3]*retryStandardIOStream,
	wantAttempts [3]int,
	wantClosed [3]bool,
) {
	t.Helper()
	for index, stream := range streams {
		attempts, closed := stream.snapshot()
		if attempts != wantAttempts[index] || closed != wantClosed[index] {
			t.Fatalf(
				"stream %d state = attempts:%d closed:%v, want attempts:%d closed:%v",
				index,
				attempts,
				closed,
				wantAttempts[index],
				wantClosed[index],
			)
		}
	}
}
