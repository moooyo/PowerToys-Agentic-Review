package relay

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"reflect"
	"sync"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/framing"
)

const (
	shutdownMessageDrain   uint16 = 14
	shutdownMessageDrained uint16 = 15
)

var (
	ErrInvalidRole        = errors.New("relay role must be control or executor")
	ErrShutdownProtocol   = errors.New("invalid role-aware relay shutdown sequence")
	ErrUnauthorizedEOF    = errors.New("ARWX EOF is not authorized")
	ErrUnexpectedPipeEOF  = errors.New("inter-service pipe reached EOF out of order")
	ErrMissingFinalFrame  = errors.New("shutdown direction drained without its final frame")
	ErrInvalidFinalFrame  = errors.New("invalid ARWX shutdown final frame")
	ErrShutdownNotStarted = errors.New("ARWX shutdown has not started")
	ErrShutdownDeadline   = errors.New("ARWX shutdown deadline is invalid")
)

// Role identifies the locally hosted ARWX payload. Control owns the named-pipe
// server; Executor owns its client connection.
type Role string

const (
	RoleControl  Role = "control"
	RoleExecutor Role = "executor"
)

// ArwxEOFAuthorizer consumes the role-local HostControl authorization for the
// exact final frame that immediately preceded Node stdout EOF.
type ArwxEOFAuthorizer interface {
	AuthorizeArwxEOF(context.Context, []byte) (time.Time, error)
}

// NodeEndpoint is the framed view of Node stdin/stdout. CloseWrite must flush
// successful writes and deliver EOF to Node before returning. It must honor a
// context with an absolute deadline.
type NodeEndpoint interface {
	Endpoint
	CloseWrite(context.Context) error
}

// ControlPipeEndpoint is the Control-owned server connection. FlushThenClose
// must flush successful writes, disconnect, and close before returning. It
// must honor a context with an absolute deadline.
type ControlPipeEndpoint interface {
	Endpoint
	FlushThenClose(context.Context) error
}

// RunRoleAware relays one verified Node session and one verified inter-service
// pipe session. Unlike Run, it permits only the role-specific Drain/Drained
// sequence to end cleanly. Every other termination is abortive.
func RunRoleAware(
	ctx context.Context,
	role Role,
	node NodeEndpoint,
	pipe Endpoint,
	authorizer ArwxEOFAuthorizer,
	options Options,
) error {
	serverPipe, err := validateRoleAwareOptions(ctx, role, node, pipe, authorizer, options)
	if err != nil {
		return err
	}

	localToPipe, err := NewByteQueue(options.MaximumQueuedBytesPerDirection)
	if err != nil {
		return err
	}
	pipeToLocal, err := NewByteQueue(options.MaximumQueuedBytesPerDirection)
	if err != nil {
		return err
	}

	relayContext, cancelRelay := context.WithCancelCause(ctx)
	defer cancelRelay(nil)
	budget := newShutdownBudget()
	signals := newRoleShutdownSignals()

	var workers sync.WaitGroup
	workers.Add(4)
	workersDone := make(chan struct{})

	var failureOnce sync.Once
	var failureMu sync.Mutex
	var failure error
	failureStarted := make(chan struct{})
	closeResults := make(chan error, 2)
	var closeOnce sync.Once
	startEndpointClose := func() {
		closeOnce.Do(func() {
			go closeEndpoint("Node", node, closeResults)
			go closeEndpoint("inter-service pipe", pipe, closeResults)
		})
	}
	fail := func(cause error) {
		if cause == nil {
			cause = errors.New("role-aware relay stopped without an error")
		}
		failureOnce.Do(func() {
			failureMu.Lock()
			failure = cause
			failureMu.Unlock()
			budget.Abort()
			cancelRelay(cause)
			localToPipe.Abort(cause)
			pipeToLocal.Abort(cause)
			close(failureStarted)
			startEndpointClose()
		})
	}

	go func() {
		select {
		case <-ctx.Done():
			fail(context.Cause(ctx))
		case <-relayContext.Done():
		}
	}()
	go func() {
		if err := budget.Wait(relayContext); errors.Is(err, ErrShutdownTimeout) {
			fail(err)
		}
	}()

	localFinal, peerFinal := finalMessageTypes(role)
	go readRoleLocal(
		relayContext, role, node, localToPipe, authorizer, budget,
		options.ShutdownTimeout, localFinal, signals, &workers, fail,
	)
	go writeRoleDirection(
		relayContext, "inter-service pipe", pipe, localToPipe, localFinal,
		signals.localFinalDelivered, signals.localDirectionDrained, nil,
		budget, &workers, fail,
	)
	go readRolePipe(
		relayContext, role, pipe, pipeToLocal, budget,
		options.ShutdownTimeout, peerFinal, signals, &workers, fail,
	)
	go writeRoleDirection(
		relayContext, "Node", node, pipeToLocal, peerFinal,
		signals.peerFinalDelivered, signals.peerDirectionDrained, node.CloseWrite,
		budget, &workers, fail,
	)
	go func() {
		workers.Wait()
		close(workersDone)
	}()

	select {
	case <-failureStarted:
		return waitRoleAbort(
			ctx, workersDone, closeResults, budget, options.ShutdownTimeout,
			currentFailure(&failureMu, &failure), localToPipe, pipeToLocal,
		)
	case <-workersDone:
		if terminal := currentFailure(&failureMu, &failure); terminal != nil {
			return waitRoleAbort(
				ctx, workersDone, closeResults, budget, options.ShutdownTimeout,
				terminal, localToPipe, pipeToLocal,
			)
		}
	}
	if cause := context.Cause(ctx); cause != nil {
		fail(cause)
		return waitRoleAbort(
			ctx, workersDone, closeResults, budget, options.ShutdownTimeout,
			currentFailure(&failureMu, &failure), localToPipe, pipeToLocal,
		)
	}

	if err := validateRoleSuccess(localToPipe, pipeToLocal, signals); err != nil {
		fail(err)
		return waitRoleAbort(
			ctx, workersDone, closeResults, budget, options.ShutdownTimeout,
			currentFailure(&failureMu, &failure), localToPipe, pipeToLocal,
		)
	}
	if role == RoleControl {
		flushContext, cancelFlush, err := budget.Context(relayContext)
		if err != nil {
			fail(err)
			return waitRoleAbort(
				ctx, workersDone, closeResults, budget, options.ShutdownTimeout,
				currentFailure(&failureMu, &failure), localToPipe, pipeToLocal,
			)
		}
		flushErr := serverPipe.FlushThenClose(flushContext)
		cancelFlush()
		if flushErr != nil {
			fail(fmt.Errorf("flush and close Control inter-service pipe: %w", flushErr))
			return waitRoleAbort(
				ctx, workersDone, closeResults, budget, options.ShutdownTimeout,
				currentFailure(&failureMu, &failure), localToPipe, pipeToLocal,
			)
		}
	}
	if cause := context.Cause(ctx); cause != nil {
		fail(cause)
		return waitRoleAbort(
			ctx, workersDone, closeResults, budget, options.ShutdownTimeout,
			currentFailure(&failureMu, &failure), localToPipe, pipeToLocal,
		)
	}

	startEndpointClose()
	closeErr := waitRoleSuccessClose(closeResults, budget, options.ShutdownTimeout)
	if outcome := roleFinalOutcome(ctx, &failureMu, &failure, closeErr); outcome != nil {
		return outcome
	}
	if err := budget.Finish(); err != nil {
		return err
	}
	return roleFinalOutcome(ctx, &failureMu, &failure, nil)
}

func validateRoleAwareOptions(
	ctx context.Context,
	role Role,
	node NodeEndpoint,
	pipe Endpoint,
	authorizer ArwxEOFAuthorizer,
	options Options,
) (ControlPipeEndpoint, error) {
	if ctx == nil {
		return nil, errors.New("role-aware relay context is required")
	}
	if role != RoleControl && role != RoleExecutor {
		return nil, ErrInvalidRole
	}
	if isNilRoleValue(node) || isNilRoleValue(pipe) || isNilRoleValue(authorizer) {
		return nil, errors.New("role-aware relay endpoints and authorizer are required")
	}
	if options.ShutdownTimeout <= 0 || options.ShutdownTimeout > 5*time.Minute {
		return nil, errors.New("relay shutdown timeout is outside the supported range")
	}
	if options.MaximumQueuedBytesPerDirection < framing.MaximumFrameBytes {
		return nil, fmt.Errorf("%w: role-aware queue cannot hold one maximum ARWX frame", ErrInvalidQueue)
	}
	if role != RoleControl {
		return nil, nil
	}
	serverPipe, ok := pipe.(ControlPipeEndpoint)
	if !ok || isNilRoleValue(serverPipe) {
		return nil, errors.New("Control relay requires a graceful server pipe endpoint")
	}
	return serverPipe, nil
}

func isNilRoleValue(value any) bool {
	if value == nil {
		return true
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return reflected.IsNil()
	default:
		return false
	}
}

type roleShutdownSignals struct {
	localFinalObserved    chan struct{}
	localFinalDelivered   chan struct{}
	localDirectionDrained chan struct{}
	peerFinalObserved     chan struct{}
	peerFinalDelivered    chan struct{}
	peerDirectionDrained  chan struct{}
}

func newRoleShutdownSignals() *roleShutdownSignals {
	return &roleShutdownSignals{
		localFinalObserved:    make(chan struct{}),
		localFinalDelivered:   make(chan struct{}),
		localDirectionDrained: make(chan struct{}),
		peerFinalObserved:     make(chan struct{}),
		peerFinalDelivered:    make(chan struct{}),
		peerDirectionDrained:  make(chan struct{}),
	}
}

func finalMessageTypes(role Role) (uint16, uint16) {
	if role == RoleControl {
		return shutdownMessageDrain, shutdownMessageDrained
	}
	return shutdownMessageDrained, shutdownMessageDrain
}

func readRoleLocal(
	ctx context.Context,
	role Role,
	endpoint Endpoint,
	queue *ByteQueue,
	authorizer ArwxEOFAuthorizer,
	budget *shutdownBudget,
	shutdownTimeout time.Duration,
	expectedFinal uint16,
	signals *roleShutdownSignals,
	workers *sync.WaitGroup,
	fail func(error),
) {
	defer workers.Done()
	sequence := newFrameSequence()
	var heldFinal []byte
	for {
		value, err := endpoint.ReadFrame(ctx)
		if err != nil {
			if len(value) != 0 || err != io.EOF || context.Cause(ctx) != nil {
				fail(normalizeContextError(ctx, fmt.Errorf("read from Node endpoint: %w", err)))
				return
			}
			if heldFinal == nil {
				fail(errors.Join(ErrUnauthorizedEOF, ErrMissingFinalFrame))
				return
			}
			if role == RoleExecutor {
				if !signalClosed(signals.peerFinalObserved) {
					fail(fmt.Errorf("%w: Executor emitted Drained before observing Drain", ErrShutdownProtocol))
					return
				}
				if err := waitRoleSignal(ctx, signals.peerDirectionDrained); err != nil {
					fail(normalizeContextError(ctx, fmt.Errorf("wait for Drain direction to close: %w", err)))
					return
				}
			}
			deadline, err := authorizer.AuthorizeArwxEOF(ctx, heldFinal)
			if err != nil {
				fail(errors.Join(ErrUnauthorizedEOF, err))
				return
			}
			if err := budget.Tighten(deadline); err != nil {
				fail(err)
				return
			}
			if err := queue.Enqueue(ctx, heldFinal); err != nil {
				fail(normalizeContextError(ctx, fmt.Errorf("queue authorized final frame for inter-service pipe: %w", err)))
				return
			}
			heldFinal = nil
			if !queue.Seal() {
				fail(fmt.Errorf("%w: local direction was already terminal", ErrShutdownProtocol))
			}
			return
		}

		header, err := validateRoleFrame(value, sequence)
		if err != nil {
			fail(fmt.Errorf("validate frame from Node endpoint: %w", err))
			return
		}
		if heldFinal != nil {
			fail(fmt.Errorf("%w: Node emitted a frame after its final frame", ErrShutdownProtocol))
			return
		}
		if isShutdownFinal(header.MessageType) && header.MessageType != expectedFinal {
			fail(fmt.Errorf("%w: Node emitted the peer role's final frame", ErrInvalidFinalFrame))
			return
		}
		if header.MessageType == expectedFinal {
			if err := validateFinalHeader(header); err != nil {
				fail(err)
				return
			}
			if role == RoleExecutor && !signalClosed(signals.peerFinalObserved) {
				fail(fmt.Errorf("%w: Executor emitted Drained before Drain", ErrShutdownProtocol))
				return
			}
			if err := budget.Begin(shutdownTimeout); err != nil {
				fail(err)
				return
			}
			heldFinal = append([]byte(nil), value...)
			close(signals.localFinalObserved)
			continue
		}
		if err := queue.Enqueue(ctx, value); err != nil {
			fail(normalizeContextError(ctx, fmt.Errorf("queue frame from Node endpoint: %w", err)))
			return
		}
	}
}

func readRolePipe(
	ctx context.Context,
	role Role,
	endpoint Endpoint,
	queue *ByteQueue,
	budget *shutdownBudget,
	shutdownTimeout time.Duration,
	expectedFinal uint16,
	signals *roleShutdownSignals,
	workers *sync.WaitGroup,
	fail func(error),
) {
	defer workers.Done()
	sequence := newFrameSequence()
	peerFinalSeen := false
	for {
		value, err := endpoint.ReadFrame(ctx)
		if err != nil {
			if len(value) != 0 || err != io.EOF || context.Cause(ctx) != nil {
				fail(normalizeContextError(ctx, fmt.Errorf("read from inter-service pipe: %w", err)))
				return
			}
			if role == RoleControl || !peerFinalSeen {
				fail(ErrUnexpectedPipeEOF)
				return
			}
			if !signalClosed(signals.localFinalObserved) {
				fail(fmt.Errorf("%w: server EOF preceded Executor Drained", ErrUnexpectedPipeEOF))
				return
			}
			if err := waitRoleSignal(ctx, signals.localDirectionDrained); err != nil {
				fail(normalizeContextError(ctx, fmt.Errorf("wait for Drained delivery: %w", err)))
			}
			return
		}

		header, err := validateRoleFrame(value, sequence)
		if err != nil {
			fail(fmt.Errorf("validate frame from inter-service pipe: %w", err))
			return
		}
		if peerFinalSeen {
			fail(fmt.Errorf("%w: peer emitted a frame after its final frame", ErrShutdownProtocol))
			return
		}
		if isShutdownFinal(header.MessageType) && header.MessageType != expectedFinal {
			fail(fmt.Errorf("%w: peer emitted the local role's final frame", ErrInvalidFinalFrame))
			return
		}
		if header.MessageType != expectedFinal {
			if err := queue.Enqueue(ctx, value); err != nil {
				fail(normalizeContextError(ctx, fmt.Errorf("queue frame from inter-service pipe: %w", err)))
				return
			}
			continue
		}
		if err := validateFinalHeader(header); err != nil {
			fail(err)
			return
		}
		if role == RoleControl && !signalClosed(signals.localFinalObserved) {
			fail(fmt.Errorf("%w: Control observed Drained before sending Drain", ErrShutdownProtocol))
			return
		}
		if err := budget.Begin(shutdownTimeout); err != nil {
			fail(err)
			return
		}
		peerFinalSeen = true
		close(signals.peerFinalObserved)
		if role == RoleControl {
			if err := waitRoleSignal(ctx, signals.localDirectionDrained); err != nil {
				fail(normalizeContextError(ctx, fmt.Errorf("wait for Drain delivery: %w", err)))
				return
			}
		}
		if err := queue.Enqueue(ctx, value); err != nil {
			fail(normalizeContextError(ctx, fmt.Errorf("queue peer final frame for Node: %w", err)))
			return
		}
		if !queue.Seal() {
			fail(fmt.Errorf("%w: peer direction was already terminal", ErrShutdownProtocol))
			return
		}
		if role == RoleControl {
			return
		}
	}
}

func writeRoleDirection(
	ctx context.Context,
	name string,
	endpoint Endpoint,
	queue *ByteQueue,
	expectedFinal uint16,
	finalDelivered chan struct{},
	directionDrained chan struct{},
	closeWrite func(context.Context) error,
	budget *shutdownBudget,
	workers *sync.WaitGroup,
	fail func(error),
) {
	defer workers.Done()
	finalWritten := false
	for {
		item, err := queue.Dequeue(ctx)
		if err != nil {
			if err != io.EOF || !queue.sealedAndDrained() {
				fail(normalizeContextError(ctx, fmt.Errorf("dequeue frame for %s endpoint: %w", name, err)))
				return
			}
			if !finalWritten {
				fail(ErrMissingFinalFrame)
				return
			}
			if closeWrite != nil {
				closeContext, cancelClose, contextErr := budget.Context(ctx)
				if contextErr != nil {
					fail(contextErr)
					return
				}
				closeErr := closeWrite(closeContext)
				cancelClose()
				if closeErr != nil {
					fail(fmt.Errorf("close %s write direction: %w", name, closeErr))
					return
				}
			}
			close(directionDrained)
			return
		}

		header, validateErr := framing.ValidateFrame(item.Bytes, framing.MaximumFrameBytes)
		if validateErr != nil {
			item.Release()
			fail(fmt.Errorf("validate queued frame for %s endpoint: %w", name, validateErr))
			return
		}
		writeErr := endpoint.WriteFrame(ctx, item.Bytes)
		item.Release()
		if writeErr != nil {
			fail(normalizeContextError(ctx, fmt.Errorf("write to %s endpoint: %w", name, writeErr)))
			return
		}
		if header.MessageType == expectedFinal {
			if finalWritten {
				fail(fmt.Errorf("%w: duplicate final frame written to %s", ErrShutdownProtocol, name))
				return
			}
			finalWritten = true
			close(finalDelivered)
		}
	}
}

type frameSequence struct {
	next      uint64
	exhausted bool
}

func newFrameSequence() *frameSequence {
	return &frameSequence{next: 1}
}

func validateRoleFrame(value []byte, sequence *frameSequence) (framing.Header, error) {
	header, err := framing.ValidateFrame(value, framing.MaximumFrameBytes)
	if err != nil {
		return framing.Header{}, err
	}
	if sequence.exhausted || header.Sequence != sequence.next {
		return framing.Header{}, fmt.Errorf(
			"%w: received sequence %d, expected %d",
			ErrShutdownProtocol,
			header.Sequence,
			sequence.next,
		)
	}
	if header.Sequence == math.MaxUint64 {
		sequence.exhausted = true
	} else {
		sequence.next++
	}
	return header, nil
}

func validateFinalHeader(header framing.Header) error {
	if header.CorrelationID != ([16]byte{}) {
		return fmt.Errorf("%w: shutdown final correlation ID must be nil", ErrInvalidFinalFrame)
	}
	return nil
}

func isShutdownFinal(messageType uint16) bool {
	return messageType == shutdownMessageDrain || messageType == shutdownMessageDrained
}

func waitRoleSignal(ctx context.Context, signal <-chan struct{}) error {
	select {
	case <-signal:
		return nil
	case <-ctx.Done():
		return context.Cause(ctx)
	}
}

func signalClosed(signal <-chan struct{}) bool {
	select {
	case <-signal:
		return true
	default:
		return false
	}
}

type shutdownBudget struct {
	mu       sync.Mutex
	deadline time.Time
	changed  chan struct{}
	finished bool
	aborted  bool
}

func newShutdownBudget() *shutdownBudget {
	return &shutdownBudget{changed: make(chan struct{})}
}

func (budget *shutdownBudget) Begin(maximum time.Duration) error {
	if maximum <= 0 {
		return ErrShutdownDeadline
	}
	return budget.Tighten(time.Now().Add(maximum))
}

func (budget *shutdownBudget) Tighten(deadline time.Time) error {
	budget.mu.Lock()
	defer budget.mu.Unlock()
	now := time.Now()
	if budget.finished || budget.aborted {
		return ErrShutdownDeadline
	}
	if deadline.IsZero() || !now.Before(deadline) {
		return errors.Join(ErrShutdownTimeout, ErrShutdownDeadline)
	}
	if !budget.deadline.IsZero() && !now.Before(budget.deadline) {
		return ErrShutdownTimeout
	}
	if budget.deadline.IsZero() || deadline.Before(budget.deadline) {
		budget.deadline = deadline
		close(budget.changed)
		budget.changed = make(chan struct{})
	}
	return nil
}

func (budget *shutdownBudget) Context(parent context.Context) (context.Context, context.CancelFunc, error) {
	budget.mu.Lock()
	deadline := budget.deadline
	finished := budget.finished
	aborted := budget.aborted
	budget.mu.Unlock()
	if deadline.IsZero() || finished || aborted {
		return nil, nil, ErrShutdownNotStarted
	}
	if !time.Now().Before(deadline) {
		return nil, nil, ErrShutdownTimeout
	}
	ctx, cancel := context.WithDeadlineCause(parent, deadline, ErrShutdownTimeout)
	return ctx, cancel, nil
}

func (budget *shutdownBudget) Wait(ctx context.Context) error {
	for {
		budget.mu.Lock()
		deadline := budget.deadline
		changed := budget.changed
		finished := budget.finished
		aborted := budget.aborted
		budget.mu.Unlock()
		if finished || aborted {
			return nil
		}
		if deadline.IsZero() {
			select {
			case <-ctx.Done():
				return context.Cause(ctx)
			case <-changed:
				continue
			}
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return ErrShutdownTimeout
		}
		timer := time.NewTimer(remaining)
		select {
		case <-ctx.Done():
			stopTimer(timer)
			return context.Cause(ctx)
		case <-changed:
			stopTimer(timer)
			continue
		case <-timer.C:
			budget.mu.Lock()
			currentDeadline := budget.deadline
			finished := budget.finished
			aborted := budget.aborted
			budget.mu.Unlock()
			if finished || aborted {
				return nil
			}
			if !currentDeadline.Equal(deadline) || time.Now().Before(currentDeadline) {
				continue
			}
			return ErrShutdownTimeout
		}
	}
}

func (budget *shutdownBudget) Remaining(maximum time.Duration) (time.Duration, error) {
	budget.mu.Lock()
	deadline := budget.deadline
	finished := budget.finished
	budget.mu.Unlock()
	if finished {
		return 0, ErrShutdownDeadline
	}
	if deadline.IsZero() {
		return maximum, nil
	}
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return 0, ErrShutdownTimeout
	}
	if remaining < maximum {
		return remaining, nil
	}
	return maximum, nil
}

func (budget *shutdownBudget) Abort() {
	budget.mu.Lock()
	defer budget.mu.Unlock()
	if budget.aborted || budget.finished {
		return
	}
	budget.aborted = true
	close(budget.changed)
	budget.changed = make(chan struct{})
}

// Finish is the successful shutdown linearization point. Once it succeeds,
// the deadline monitor cannot publish a later timeout for this relay.
func (budget *shutdownBudget) Finish() error {
	budget.mu.Lock()
	defer budget.mu.Unlock()
	if budget.finished || budget.aborted || budget.deadline.IsZero() {
		return ErrShutdownDeadline
	}
	if !time.Now().Before(budget.deadline) {
		return ErrShutdownTimeout
	}
	budget.finished = true
	close(budget.changed)
	budget.changed = make(chan struct{})
	return nil
}

func stopTimer(timer *time.Timer) {
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
}

func validateRoleSuccess(
	localToPipe *ByteQueue,
	pipeToLocal *ByteQueue,
	signals *roleShutdownSignals,
) error {
	signalChecks := []struct {
		name   string
		signal <-chan struct{}
	}{
		{name: "local final observed", signal: signals.localFinalObserved},
		{name: "local final delivered", signal: signals.localFinalDelivered},
		{name: "local direction drained", signal: signals.localDirectionDrained},
		{name: "peer final observed", signal: signals.peerFinalObserved},
		{name: "peer final delivered", signal: signals.peerFinalDelivered},
		{name: "peer direction drained", signal: signals.peerDirectionDrained},
	}
	for _, check := range signalChecks {
		if !signalClosed(check.signal) {
			return fmt.Errorf("%w: %s signal is missing", ErrShutdownProtocol, check.name)
		}
	}
	queueChecks := []struct {
		name  string
		queue *ByteQueue
	}{
		{name: "local-to-pipe", queue: localToPipe},
		{name: "pipe-to-local", queue: pipeToLocal},
	}
	for _, check := range queueChecks {
		stats := check.queue.Stats()
		if !stats.Sealed || stats.Aborted || stats.ReservedBytes != 0 ||
			stats.QueuedItems != 0 || stats.InFlightItems != 0 {
			return fmt.Errorf("%w: %s queue did not drain", ErrShutdownProtocol, check.name)
		}
	}
	return nil
}

func currentFailure(mu *sync.Mutex, failure *error) error {
	mu.Lock()
	defer mu.Unlock()
	return *failure
}

func roleFinalOutcome(
	ctx context.Context,
	failureMu *sync.Mutex,
	failure *error,
	closeErr error,
) error {
	if terminal := currentFailure(failureMu, failure); terminal != nil {
		return errors.Join(terminal, closeErr)
	}
	if cause := context.Cause(ctx); cause != nil {
		return errors.Join(cause, closeErr)
	}
	return closeErr
}

func waitRoleAbort(
	parent context.Context,
	workersDone <-chan struct{},
	closeResults <-chan error,
	budget *shutdownBudget,
	maximumWait time.Duration,
	primary error,
	queues ...*ByteQueue,
) error {
	wait, deadlineErr := budget.Remaining(maximumWait)
	if deadlineErr != nil {
		return errors.Join(primary, context.Cause(parent), deadlineErr)
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	workersFinished := false
	closeCount := 0
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
			failures := []error{primary, context.Cause(parent), ErrShutdownTimeout}
			return errors.Join(append(failures, closeFailures...)...)
		}
	}
	for _, queue := range queues {
		stats := queue.Stats()
		if stats.ReservedBytes != 0 || stats.QueuedItems != 0 || stats.InFlightItems != 0 {
			closeFailures = append(closeFailures, errors.New("relay queue ownership remained after abort"))
		}
	}
	failures := []error{primary, context.Cause(parent)}
	return errors.Join(append(failures, closeFailures...)...)
}

func waitRoleSuccessClose(
	closeResults <-chan error,
	budget *shutdownBudget,
	maximumWait time.Duration,
) error {
	wait, err := budget.Remaining(maximumWait)
	if err != nil {
		return err
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	var closeFailures []error
	for closeCount := 0; closeCount < 2; {
		select {
		case closeFailure := <-closeResults:
			closeCount++
			if closeFailure != nil {
				closeFailures = append(closeFailures, closeFailure)
			}
		case <-timer.C:
			return errors.Join(append([]error{ErrShutdownTimeout}, closeFailures...)...)
		}
	}
	return errors.Join(closeFailures...)
}
