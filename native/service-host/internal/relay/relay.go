package relay

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

var ErrShutdownTimeout = errors.New("relay did not stop before its shutdown deadline")

type Endpoint interface {
	// ReadFrame must return an empty value and the exact io.EOF sentinel for a
	// clean directional end. Bytes returned with any error, and wrapped or joined
	// EOF values, are protocol failures. ReadFrame and WriteFrame must return when
	// ctx is cancelled or Close is called.
	ReadFrame(context.Context) ([]byte, error)
	WriteFrame(context.Context, []byte) error
	Close() error
}

type Options struct {
	MaximumQueuedBytesPerDirection int
	ShutdownTimeout                time.Duration
}

func Run(ctx context.Context, left Endpoint, right Endpoint, options Options) error {
	if ctx == nil {
		return errors.New("relay context is required")
	}
	if left == nil || right == nil {
		return errors.New("relay endpoints are required")
	}
	if options.ShutdownTimeout <= 0 || options.ShutdownTimeout > 5*time.Minute {
		return errors.New("relay shutdown timeout is outside the supported range")
	}
	leftToRight, err := NewByteQueue(options.MaximumQueuedBytesPerDirection)
	if err != nil {
		return err
	}
	rightToLeft, err := NewByteQueue(options.MaximumQueuedBytesPerDirection)
	if err != nil {
		return err
	}

	relayContext, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)

	var failureOnce sync.Once
	var failureMu sync.Mutex
	var failure error
	failureStarted := make(chan struct{})
	closeResults := make(chan error, 2)
	fail := func(err error) {
		if err == nil {
			err = errors.New("relay stopped without an error")
		}
		failureOnce.Do(func() {
			failureMu.Lock()
			failure = err
			failureMu.Unlock()
			cancel(err)
			leftToRight.Abort(err)
			rightToLeft.Abort(err)
			close(failureStarted)
			go closeEndpoint("left", left, closeResults)
			go closeEndpoint("right", right, closeResults)
		})
	}

	go func() {
		select {
		case <-ctx.Done():
			fail(context.Cause(ctx))
		case <-relayContext.Done():
		}
	}()

	var workers sync.WaitGroup
	workers.Add(4)
	go readLoop(relayContext, "left", left, leftToRight, &workers, fail)
	go writeLoop(relayContext, "right", right, leftToRight, &workers, fail)
	go readLoop(relayContext, "right", right, rightToLeft, &workers, fail)
	go writeLoop(relayContext, "left", left, rightToLeft, &workers, fail)
	workersDone := make(chan struct{})
	go func() {
		workers.Wait()
		close(workersDone)
	}()

	<-failureStarted
	timer := time.NewTimer(options.ShutdownTimeout)
	defer timer.Stop()
	closeCount := 0
	workersFinished := false
	var closeFailures []error
	for !workersFinished || closeCount < 2 {
		select {
		case <-workersDone:
			workersFinished = true
			workersDone = nil
		case closeFailure := <-closeResults:
			closeCount++
			if closeFailure != nil {
				closeFailures = append(closeFailures, closeFailure)
			}
		case <-timer.C:
			failureMu.Lock()
			terminalFailure := failure
			failureMu.Unlock()
			failures := []error{terminalFailure, ErrShutdownTimeout}
			failures = append(failures, closeFailures...)
			return errors.Join(failures...)
		}
	}

	failureMu.Lock()
	terminalFailure := failure
	failureMu.Unlock()
	return errors.Join(append([]error{terminalFailure}, closeFailures...)...)
}

func closeEndpoint(name string, endpoint Endpoint, results chan<- error) {
	if err := endpoint.Close(); err != nil {
		results <- fmt.Errorf("close %s endpoint: %w", name, err)
		return
	}
	results <- nil
}

func readLoop(
	ctx context.Context,
	name string,
	endpoint Endpoint,
	queue *ByteQueue,
	workers *sync.WaitGroup,
	fail func(error),
) {
	readLoopWithEOFPolicy(ctx, name, endpoint, queue, nil, workers, fail)
}

// readLoopWithEOFPolicy is the narrow foundation for a future role-aware
// shutdown coordinator. A nil or rejecting policy preserves Run's current
// fail-closed EOF behavior. Only an explicitly authorized empty value paired
// with the exact io.EOF sentinel seals the direction and leaves its writer to
// drain queued ownership.
func readLoopWithEOFPolicy(
	ctx context.Context,
	name string,
	endpoint Endpoint,
	queue *ByteQueue,
	authorizeEOF func() bool,
	workers *sync.WaitGroup,
	fail func(error),
) {
	defer workers.Done()
	for {
		value, err := endpoint.ReadFrame(ctx)
		if err != nil {
			if len(value) == 0 && err == io.EOF && context.Cause(ctx) == nil &&
				authorizeEOF != nil && authorizeEOF() {
				queue.Seal()
				return
			}
			fail(normalizeContextError(ctx, fmt.Errorf("read from %s endpoint: %w", name, err)))
			return
		}
		if err := queue.Enqueue(ctx, value); err != nil {
			fail(normalizeContextError(ctx, fmt.Errorf("queue frame from %s endpoint: %w", name, err)))
			return
		}
	}
}

func writeLoop(
	ctx context.Context,
	name string,
	endpoint Endpoint,
	queue *ByteQueue,
	workers *sync.WaitGroup,
	fail func(error),
) {
	writeLoopWithDrain(ctx, name, endpoint, queue, nil, workers, fail)
}

func writeLoopWithDrain(
	ctx context.Context,
	name string,
	endpoint Endpoint,
	queue *ByteQueue,
	onDrained func(),
	workers *sync.WaitGroup,
	fail func(error),
) {
	defer workers.Done()
	for {
		item, err := queue.Dequeue(ctx)
		if err != nil {
			if err == io.EOF && queue.sealedAndDrained() {
				if onDrained != nil {
					onDrained()
				}
				return
			}
			fail(normalizeContextError(ctx, fmt.Errorf("dequeue frame for %s endpoint: %w", name, err)))
			return
		}
		err = endpoint.WriteFrame(ctx, item.Bytes)
		item.Release()
		if err != nil {
			fail(normalizeContextError(ctx, fmt.Errorf("write to %s endpoint: %w", name, err)))
			return
		}
	}
}

func normalizeContextError(ctx context.Context, err error) error {
	if cause := context.Cause(ctx); cause != nil &&
		(errors.Is(err, context.Canceled) || errors.Is(err, cause) || errors.Is(err, ErrQueueClosed)) {
		return cause
	}
	return err
}
