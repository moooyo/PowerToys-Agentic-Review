package platform

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"sync/atomic"
	"time"
)

var (
	errInvalidComposition      = errors.New("invalid ServiceHost composition")
	errUnexpectedComponent     = errors.New("supervised ServiceHost component exited unexpectedly")
	errOrderlyRuntimeStop      = errors.New("orderly ServiceHost runtime stop")
	errHostCleanupFatal        = errors.New("ServiceHost cleanup failed; the process must exit")
	errNodeOwnerRetained       = errors.New("Node process owner must be retained until ServiceHost exits")
	errNodeTerminateFirst      = errors.New("Node process must be terminated before its handles are closed")
	errNodeWaitActive          = errors.New("Node process already has an active lifecycle wait")
	errNodeWaitUnavailable     = errors.New("Node process lifecycle wait is no longer available")
	errNodeTerminateWait       = errors.New("Node process wait canceled for termination")
	errGracefulShutdownTimeout = errors.New("ServiceHost graceful shutdown deadline expired")
)

type compositionBuilder interface {
	selectRole(context.Context, BootstrapOptions) error
	loadReleaseAuthority(context.Context) error
	prepareServiceSecurity(context.Context) error
	verifyInstallation(context.Context) error
	verifyDataRoot(context.Context) error
	openRoleCredentials(context.Context) error
	composePreflight(context.Context) error
	connectPeer(context.Context) error
	verifyPeer(context.Context) error
	finalizeRuntimePlan(context.Context) error
	createRuntimeBootstrap(context.Context) error
	openLaunchGuard(context.Context) error
	prepareHostControl(context.Context) error
	launchNode(context.Context) error
	takeNodeStandardIO(context.Context) error
	acceptHostControl(context.Context) error
	buildRoleRuntime(context.Context) error
	runtimeSupervision() (runtimeSupervision, error)
	cleanup() error
}

type compositionHost struct {
	newBuilder func() compositionBuilder
}

func (host compositionHost) Run(ctx context.Context, options BootstrapOptions) error {
	if isNilCompositionValue(ctx) {
		return fmt.Errorf("%w: context is required", errInvalidComposition)
	}
	if host.newBuilder == nil {
		return fmt.Errorf("%w: builder factory is required", errInvalidComposition)
	}
	builder := host.newBuilder()
	if isNilCompositionValue(builder) {
		return fmt.Errorf("%w: builder is required", errInvalidComposition)
	}
	return runComposition(ctx, options, builder)
}

type compositionStep struct {
	name string
	run  func(context.Context) error
}

func runComposition(
	ctx context.Context,
	options BootstrapOptions,
	builder compositionBuilder,
) error {
	if isNilCompositionValue(ctx) || isNilCompositionValue(builder) {
		return fmt.Errorf("%w: context and builder are required", errInvalidComposition)
	}
	setupContext, cancelSetup := context.WithCancelCause(ctx)
	defer cancelSetup(nil)
	lifetime, cancelLifetime := context.WithCancelCause(context.WithoutCancel(ctx))
	defer cancelLifetime(nil)

	var cleanupOnce sync.Once
	var cleanupErr error
	finish := func(primary error) error {
		cancelCause := primary
		if cancelCause == nil {
			cancelCause = errOrderlyRuntimeStop
		}
		cancelSetup(cancelCause)
		cancelLifetime(cancelCause)
		cleanupOnce.Do(func() {
			if err := builder.cleanup(); err != nil {
				cleanupErr = errors.Join(errHostCleanupFatal, err)
			}
		})
		return errors.Join(primary, cleanupErr)
	}

	steps := []compositionStep{
		{name: "select service role", run: func(ctx context.Context) error { return builder.selectRole(ctx, options) }},
		{name: "load release authority", run: builder.loadReleaseAuthority},
		{name: "prepare service security", run: builder.prepareServiceSecurity},
		{name: "verify installation", run: builder.verifyInstallation},
		{name: "verify data root", run: builder.verifyDataRoot},
		{name: "open role credentials", run: builder.openRoleCredentials},
		{name: "compose preflight", run: builder.composePreflight},
		{name: "connect peer pipe", run: builder.connectPeer},
		{name: "verify peer", run: builder.verifyPeer},
		{name: "finalize runtime plan", run: builder.finalizeRuntimePlan},
		{name: "create runtime bootstrap", run: builder.createRuntimeBootstrap},
		{name: "open launch guard", run: builder.openLaunchGuard},
		{name: "prepare HostControl", run: builder.prepareHostControl},
		{name: "launch Node", run: builder.launchNode},
		{name: "take Node standard I/O", run: builder.takeNodeStandardIO},
		{name: "accept HostControl", run: builder.acceptHostControl},
		{name: "build role runtime", run: builder.buildRoleRuntime},
	}
	for _, step := range steps {
		if cause := context.Cause(setupContext); cause != nil {
			return finish(cause)
		}
		stepContext := setupContext
		if step.name == "take Node standard I/O" {
			stepContext = lifetime
		}
		if err := step.run(stepContext); err != nil {
			return finish(fmt.Errorf("%s: %w", step.name, err))
		}
	}
	runtime, err := builder.runtimeSupervision()
	if err != nil {
		return finish(fmt.Errorf("construct runtime supervision: %w", err))
	}
	return finish(superviseRuntime(lifetime, cancelLifetime, runtime))
}

type supervisedNodeProcess interface {
	WaitContext(context.Context) (uint32, error)
	Terminate() error
	Close() error
}

type nodeShutdownOwner struct {
	inner supervisedNodeProcess

	mu               sync.Mutex
	terminateAttempt *nodeLifecycleAttempt
	closeAttempt     *nodeLifecycleAttempt
	retained         error
	waitActive       bool
	waitDone         chan struct{}
	cancelWait       context.CancelCauseFunc
}

type nodeLifecycleAttempt struct {
	done chan struct{}
	err  error
}

func newNodeShutdownOwner(node supervisedNodeProcess) (*nodeShutdownOwner, error) {
	if isNilCompositionValue(node) {
		return nil, fmt.Errorf("%w: Node process is required", errInvalidComposition)
	}
	return &nodeShutdownOwner{inner: node}, nil
}

func (owner *nodeShutdownOwner) WaitContext(ctx context.Context) (exitCode uint32, waitErr error) {
	if owner == nil || isNilCompositionValue(owner.inner) || isNilCompositionValue(ctx) {
		return 0, errInvalidComposition
	}
	owner.mu.Lock()
	if owner.retained != nil {
		err := owner.retained
		owner.mu.Unlock()
		return 0, err
	}
	if owner.waitActive {
		owner.mu.Unlock()
		return 0, errNodeWaitActive
	}
	if owner.terminateAttempt != nil || owner.closeAttempt != nil {
		owner.mu.Unlock()
		return 0, errNodeWaitUnavailable
	}
	waitContext, cancelWait := context.WithCancelCause(ctx)
	waitDone := make(chan struct{})
	owner.waitActive = true
	owner.waitDone = waitDone
	owner.cancelWait = cancelWait
	owner.mu.Unlock()

	returned := false
	waitConsumedShutdown := false
	defer func() {
		cancelWait(nil)
		owner.mu.Lock()
		owner.waitActive = false
		owner.waitDone = nil
		owner.cancelWait = nil
		if returned && waitConsumedShutdown {
			if waitErr != nil {
				waitErr = errors.Join(errNodeOwnerRetained, waitErr)
				owner.retained = waitErr
			}
			attempt := &nodeLifecycleAttempt{done: make(chan struct{}), err: waitErr}
			close(attempt.done)
			owner.terminateAttempt = attempt
		}
		close(waitDone)
		owner.mu.Unlock()
	}()

	exitCode, waitErr = owner.inner.WaitContext(waitContext)
	waitCause := context.Cause(waitContext)
	waitConsumedShutdown = !nodeWaitWasCanceled(waitCause, waitErr)
	returned = true
	return exitCode, waitErr
}

func nodeWaitWasCanceled(cause error, waitErr error) bool {
	if cause == nil || waitErr == nil {
		return false
	}
	return expectedSupervisionCancellation(waitErr, cause)
}

// Terminate makes the exact Node owner consume at most one termination budget.
// A failed attempt is permanently retained and forbids a later Close attempt.
func (owner *nodeShutdownOwner) Terminate() error {
	if owner == nil || isNilCompositionValue(owner.inner) {
		return errInvalidComposition
	}
	for {
		owner.mu.Lock()
		if owner.retained != nil {
			err := owner.retained
			owner.mu.Unlock()
			return err
		}
		if owner.terminateAttempt != nil {
			attempt := owner.terminateAttempt
			owner.mu.Unlock()
			<-attempt.done
			return attempt.err
		}
		if owner.waitActive {
			waitDone := owner.waitDone
			cancelWait := owner.cancelWait
			if cancelWait != nil {
				cancelWait(errNodeTerminateWait)
			}
			owner.mu.Unlock()
			<-waitDone
			continue
		}
		attempt := &nodeLifecycleAttempt{done: make(chan struct{})}
		owner.terminateAttempt = attempt
		owner.mu.Unlock()

		err := owner.inner.Terminate()
		if err != nil {
			err = errors.Join(errNodeOwnerRetained, err)
		}

		owner.mu.Lock()
		attempt.err = err
		if err != nil {
			owner.retained = err
		}
		close(attempt.done)
		owner.mu.Unlock()
		return err
	}
}

// Close releases only the handles left after one successful Terminate. It
// never retries either operation after an ownership failure.
func (owner *nodeShutdownOwner) Close() error {
	if owner == nil || isNilCompositionValue(owner.inner) {
		return errInvalidComposition
	}
	owner.mu.Lock()
	if owner.retained != nil {
		err := owner.retained
		owner.mu.Unlock()
		return err
	}
	terminateAttempt := owner.terminateAttempt
	if terminateAttempt == nil {
		owner.mu.Unlock()
		return errors.Join(errNodeOwnerRetained, errNodeTerminateFirst)
	}
	if owner.closeAttempt != nil {
		attempt := owner.closeAttempt
		owner.mu.Unlock()
		<-attempt.done
		return attempt.err
	}
	owner.mu.Unlock()

	<-terminateAttempt.done
	if terminateAttempt.err != nil {
		return terminateAttempt.err
	}

	owner.mu.Lock()
	if owner.retained != nil {
		err := owner.retained
		owner.mu.Unlock()
		return err
	}
	if owner.closeAttempt != nil {
		attempt := owner.closeAttempt
		owner.mu.Unlock()
		<-attempt.done
		return attempt.err
	}
	attempt := &nodeLifecycleAttempt{done: make(chan struct{})}
	owner.closeAttempt = attempt
	owner.mu.Unlock()

	err := owner.inner.Close()
	if err != nil {
		err = errors.Join(errNodeOwnerRetained, err)
	}

	owner.mu.Lock()
	attempt.err = err
	if err != nil {
		owner.retained = err
	}
	close(attempt.done)
	owner.mu.Unlock()
	return err

}

// retainAfterExternalShutdownAttempt prevents platform cleanup from issuing a
// second raw termination after HostControl has already rejected the launch.
func (owner *nodeShutdownOwner) retainAfterExternalShutdownAttempt(cause error) {
	if owner == nil {
		return
	}
	if cause == nil {
		cause = errUnexpectedComponent
	}
	owner.mu.Lock()
	defer owner.mu.Unlock()
	if owner.terminateAttempt == nil && owner.retained == nil {
		owner.retained = errors.Join(errNodeOwnerRetained, cause)
	}
}

type runtimeSupervision struct {
	node                 *nodeShutdownOwner
	stopContext          context.Context
	shutdownTimeout      time.Duration
	requestNodeShutdown  func(context.Context, time.Time, time.Time) error
	readShutdownDeadline func() (time.Time, bool)
	serveLocalRPC        func(context.Context) error
	runRelay             func(context.Context) error
	waitPeerWrapper      func(context.Context) error
	waitPeerHost         func(context.Context) error
	waitStderr           func(context.Context) error
	onResult             func(supervisedTaskKind)
}

type supervisedTaskKind uint8

const (
	supervisedLocalRPC supervisedTaskKind = iota
	supervisedRelay
	supervisedNode
	supervisedPeerWrapper
	supervisedPeerHost
	supervisedStderr
)

type supervisedTask struct {
	kind supervisedTaskKind
	name string
	run  func(context.Context) (uint32, error)
}

type supervisedResult struct {
	task                   supervisedTask
	exitCode               uint32
	err                    error
	afterShutdown          bool
	gracefulAtCompletion   bool
	relayCleanAtCompletion bool
}

type supervisionOutcome struct {
	primary            error
	secondary          []error
	localRPCClean      bool
	relayClean         bool
	nodeClean          bool
	nodeBarrier        bool
	gracefulProgress   bool
	gracefulRequested  bool
	shutdownStarted    bool
	terminationStarted bool
	cancelCause        error
}

func (outcome *supervisionOutcome) add(err error) {
	if err == nil {
		return
	}
	if outcome.primary == nil {
		outcome.primary = err
		return
	}
	outcome.secondary = append(outcome.secondary, err)
}

func (outcome *supervisionOutcome) result() error {
	return errors.Join(append([]error{outcome.primary}, outcome.secondary...)...)
}

func superviseRuntime(
	ctx context.Context,
	cancel context.CancelCauseFunc,
	runtime runtimeSupervision,
) error {
	if ctx == nil || cancel == nil || isNilCompositionValue(runtime.node) ||
		runtime.serveLocalRPC == nil || runtime.runRelay == nil ||
		runtime.waitPeerWrapper == nil || runtime.waitPeerHost == nil || runtime.waitStderr == nil {
		return errInvalidComposition
	}
	tasks := []supervisedTask{
		{kind: supervisedLocalRPC, name: "local RPC server", run: func(ctx context.Context) (uint32, error) {
			return 0, runtime.serveLocalRPC(ctx)
		}},
		{kind: supervisedRelay, name: "role-aware relay", run: func(ctx context.Context) (uint32, error) {
			return 0, runtime.runRelay(ctx)
		}},
		{kind: supervisedNode, name: "Node process", run: runtime.node.WaitContext},
		{kind: supervisedPeerWrapper, name: "peer WinSW wrapper", run: func(ctx context.Context) (uint32, error) {
			return 0, runtime.waitPeerWrapper(ctx)
		}},
		{kind: supervisedPeerHost, name: "peer ServiceHost", run: func(ctx context.Context) (uint32, error) {
			return 0, runtime.waitPeerHost(ctx)
		}},
		{kind: supervisedStderr, name: "Node stderr", run: func(ctx context.Context) (uint32, error) {
			return 0, runtime.waitStderr(ctx)
		}},
	}

	results := make(chan supervisedResult, len(tasks))
	var shutdownStarted atomic.Bool
	var gracefulProgress atomic.Bool
	var relayClean atomic.Bool
	for _, task := range tasks {
		task := task
		go func() {
			result := supervisedResult{task: task}
			defer func() {
				if recovered := recover(); recovered != nil {
					result.err = fmt.Errorf("panic: %v", recovered)
				}
				result.afterShutdown = shutdownStarted.Load()
				if result.err == nil && !result.afterShutdown {
					switch result.task.kind {
					case supervisedLocalRPC:
						gracefulProgress.Store(true)
					case supervisedRelay:
						gracefulProgress.Store(true)
						relayClean.Store(true)
					}
				}
				result.gracefulAtCompletion = gracefulProgress.Load()
				result.relayCleanAtCompletion = relayClean.Load()
				results <- result
			}()
			result.exitCode, result.err = task.run(ctx)
		}()
	}

	remaining := len(tasks)
	outcome := supervisionOutcome{nodeBarrier: runtime.readShutdownDeadline != nil}
	contextDone := ctx.Done()
	stopContext := runtime.stopContext
	if stopContext == nil {
		stopContext = ctx
	}
	stopDone := stopContext.Done()
	var shutdownDeadline time.Time
	var shutdownTimer *time.Timer
	var shutdownTimerDone <-chan time.Time
	notificationResult := make(chan error, 1)
	notificationPending := false
	notifyResult := func(kind supervisedTaskKind) {
		if runtime.onResult != nil {
			runtime.onResult(kind)
		}
	}
	forceShutdown := func(cause error) {
		if outcome.terminationStarted {
			return
		}
		if cause == nil {
			cause = errOrderlyRuntimeStop
		}
		outcome.shutdownStarted = true
		outcome.terminationStarted = true
		shutdownStarted.Store(true)
		if shutdownTimer != nil {
			if !shutdownTimer.Stop() {
				select {
				case <-shutdownTimer.C:
				default:
				}
			}
			shutdownTimer = nil
			shutdownTimerDone = nil
		}
		cancel(cause)
		actualCause := context.Cause(ctx)
		if actualCause == nil {
			actualCause = cause
		}
		outcome.cancelCause = actualCause
		if !sameErrorObject(actualCause, cause) {
			outcome.add(fmt.Errorf("runtime context: %w", actualCause))
		}
		contextDone = nil
		stopDone = nil
		if err := runtime.node.Terminate(); err != nil {
			outcome.add(fmt.Errorf("terminate Node root Job: %w", err))
		}
	}
	tightenShutdownTimer := func(deadline time.Time) error {
		if deadline.IsZero() || !time.Now().Before(deadline) {
			return errGracefulShutdownTimeout
		}
		if !shutdownDeadline.IsZero() && !deadline.Before(shutdownDeadline) {
			return nil
		}
		if shutdownTimer != nil && !shutdownTimer.Stop() {
			select {
			case <-shutdownTimer.C:
			default:
			}
		}
		shutdownDeadline = deadline
		shutdownTimer = time.NewTimer(time.Until(shutdownDeadline))
		shutdownTimerDone = shutdownTimer.C
		return nil
	}
	beginGracefulShutdown := func(cause error) {
		if outcome.shutdownStarted {
			return
		}
		if cause == nil {
			cause = errOrderlyRuntimeStop
		}
		if runtime.shutdownTimeout <= 0 || runtime.shutdownTimeout > 5*time.Minute {
			forceShutdown(cause)
			return
		}
		outcome.shutdownStarted = true
		outcome.gracefulRequested = true
		shutdownStarted.Store(true)
		stopDone = nil
		now := time.Now()
		requestedAt := now.Add(-time.Duration(now.Nanosecond() % int(time.Millisecond)))
		shutdownDeadline = requestedAt.Add(runtime.shutdownTimeout)
		shutdownTimer = time.NewTimer(time.Until(shutdownDeadline))
		shutdownTimerDone = shutdownTimer.C
		armAlreadyCommitted := false
		if runtime.readShutdownDeadline != nil {
			if deadline, valid := runtime.readShutdownDeadline(); valid {
				armAlreadyCommitted = true
				if err := tightenShutdownTimer(deadline); err != nil {
					outcome.add(err)
					forceShutdown(err)
					return
				}
			}
		}
		if runtime.requestNodeShutdown == nil || armAlreadyCommitted {
			return
		}
		notificationPending = true
		go func() {
			notificationContext, cancelNotification := context.WithDeadlineCause(
				ctx,
				shutdownDeadline,
				errGracefulShutdownTimeout,
			)
			defer cancelNotification()
			notificationResult <- runtime.requestNodeShutdown(
				notificationContext,
				requestedAt,
				shutdownDeadline,
			)
		}()
	}
	beginProtocolGrace := func(deadline time.Time) error {
		if outcome.gracefulRequested {
			return nil
		}
		outcome.shutdownStarted = true
		outcome.gracefulRequested = true
		shutdownStarted.Store(true)
		return tightenShutdownTimer(deadline)
	}

	for remaining != 0 || notificationPending {
		select {
		case <-stopDone:
			stopDone = nil
			cause := context.Cause(stopContext)
			outcome.add(cause)
			beginGracefulShutdown(cause)
		case <-contextDone:
			cause := context.Cause(ctx)
			outcome.add(cause)
			forceShutdown(cause)
		case notificationErr := <-notificationResult:
			if !notificationPending {
				continue
			}
			notificationPending = false
			if notificationErr != nil {
				terminal := fmt.Errorf("notify Node shutdown: %w", notificationErr)
				outcome.add(terminal)
				if !outcome.terminationStarted && runtime.readShutdownDeadline != nil {
					if deadline, valid := runtime.readShutdownDeadline(); valid {
						if err := tightenShutdownTimer(deadline); err != nil {
							outcome.add(err)
							forceShutdown(err)
						}
					}
					continue
				}
				forceShutdown(terminal)
			}
		case <-shutdownTimerDone:
			if stopDone != nil {
				stopCause := context.Cause(stopContext)
				if stopCause != nil {
					stopDone = nil
					outcome.add(stopCause)
				}
			}
			terminal := errGracefulShutdownTimeout
			outcome.add(terminal)
			forceShutdown(terminal)
		case result := <-results:
			if !outcome.shutdownStarted {
				if stopCause := context.Cause(stopContext); stopCause != nil {
					outcome.add(stopCause)
					beginGracefulShutdown(stopCause)
				}
			}
			remaining--
			if result.err != nil {
				if outcome.terminationStarted && outcome.cancelCause != nil &&
					expectedSupervisionCancellation(result.err, outcome.cancelCause) {
					notifyResult(result.task.kind)
					continue
				}
				if cause := context.Cause(ctx); cause != nil &&
					expectedSupervisionCancellation(result.err, cause) {
					outcome.add(cause)
					forceShutdown(cause)
					notifyResult(result.task.kind)
					continue
				}
				terminal := fmt.Errorf("%s: %w", result.task.name, result.err)
				outcome.add(terminal)
				forceShutdown(terminal)
				notifyResult(result.task.kind)
				continue
			}

			terminal, jointClean := outcome.observeClean(result)
			if terminal == nil && outcome.nodeBarrier && outcome.localRPCClean && outcome.relayClean {
				deadline, valid := runtime.readShutdownDeadline()
				if valid {
					if err := tightenShutdownTimer(deadline); err != nil {
						terminal = err
					}
				} else if !outcome.gracefulRequested {
					terminal = fmt.Errorf("%w: armed shutdown deadline is unavailable", errInvalidComposition)
				}
				if terminal == nil && !outcome.gracefulRequested {
					if err := beginProtocolGrace(deadline); err != nil {
						terminal = err
					}
				}
			}
			if terminal != nil {
				outcome.add(terminal)
				forceShutdown(terminal)
			} else if jointClean {
				forceShutdown(errOrderlyRuntimeStop)
			}
			notifyResult(result.task.kind)
		}
	}
	return outcome.result()
}

func (outcome *supervisionOutcome) observeClean(result supervisedResult) (error, bool) {
	switch result.task.kind {
	case supervisedLocalRPC:
		if result.afterShutdown && !outcome.gracefulRequested {
			return nil, false
		}
		outcome.localRPCClean = true
		outcome.gracefulProgress = true
		return nil, outcome.relayClean &&
			(!outcome.gracefulRequested && !outcome.nodeBarrier || outcome.nodeClean)
	case supervisedRelay:
		if result.afterShutdown && !outcome.gracefulRequested {
			return nil, false
		}
		outcome.relayClean = true
		outcome.gracefulProgress = true
		return nil, outcome.localRPCClean &&
			(!outcome.gracefulRequested && !outcome.nodeBarrier || outcome.nodeClean)
	case supervisedNode:
		if result.afterShutdown && (!outcome.gracefulRequested || outcome.terminationStarted) {
			return nil, false
		}
		if result.exitCode != 0 {
			return fmt.Errorf(
				"%w: Node process exited with code %d",
				errUnexpectedComponent,
				result.exitCode,
			), false
		}
		if outcome.gracefulRequested {
			outcome.nodeClean = true
			outcome.gracefulProgress = true
			return nil, outcome.localRPCClean && outcome.relayClean
		}
		if outcome.nodeBarrier {
			outcome.nodeClean = true
			return nil, outcome.localRPCClean && outcome.relayClean
		}
		if outcome.gracefulProgress || result.gracefulAtCompletion {
			return nil, false
		}
	case supervisedStderr:
		if result.afterShutdown || outcome.gracefulProgress || result.gracefulAtCompletion {
			return nil, false
		}
	case supervisedPeerWrapper, supervisedPeerHost:
		if outcome.relayClean || result.relayCleanAtCompletion {
			return nil, false
		}
	default:
		return fmt.Errorf("%w: unknown supervised task", errInvalidComposition), false
	}
	return fmt.Errorf("%w: %s", errUnexpectedComponent, result.task.name), false
}

func expectedSupervisionCancellation(err error, cause error) bool {
	if err == nil {
		return true
	}
	if sameErrorObject(err, cause) {
		return true
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		children := joined.Unwrap()
		if len(children) == 0 {
			return false
		}
		for _, child := range children {
			if !expectedSupervisionCancellation(child, cause) {
				return false
			}
		}
		return true
	}
	if wrapped, ok := err.(interface{ Unwrap() error }); ok {
		if child := wrapped.Unwrap(); child != nil {
			return expectedSupervisionCancellation(child, cause)
		}
	}
	return errors.Is(err, cause) || errors.Is(err, context.Canceled) ||
		errors.Is(cause, context.DeadlineExceeded) && errors.Is(err, context.DeadlineExceeded)
}

func sameErrorObject(left error, right error) bool {
	return reflect.ValueOf(left) == reflect.ValueOf(right)
}

func isNilCompositionValue(value any) bool {
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

var _ Host = compositionHost{}
