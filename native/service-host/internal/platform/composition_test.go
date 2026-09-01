package platform

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
)

var compositionTestStages = []string{
	"select-role",
	"load-release",
	"open-bootstrap",
	"measure-image",
	"verify-installation",
	"verify-data-root",
	"open-credentials",
	"compose-preflight",
	"connect-peer",
	"verify-peer",
	"finalize-plan",
	"create-bootstrap",
	"open-guard",
	"prepare-host-control",
	"launch-node",
	"take-node-stdio",
	"accept-host-control",
	"build-role-runtime",
}

type fakeCompositionBuilder struct {
	mu sync.Mutex

	events           []string
	acquired         []string
	closed           []string
	failAt           string
	failure          error
	runtime          runtimeSupervision
	runtimeError     error
	cleanupError     error
	cleanupCalls     int
	lifetime         context.Context
	cleanupExitCount int
	coordinator      *supervisionCoordinator
	nodeOwner        *nodeShutdownOwner
}

func (builder *fakeCompositionBuilder) step(ctx context.Context, name string) error {
	builder.mu.Lock()
	defer builder.mu.Unlock()
	builder.lifetime = ctx
	builder.events = append(builder.events, name)
	// Model a stage that may return an error after publishing a partial owner.
	builder.acquired = append(builder.acquired, name)
	if builder.failAt == name {
		return builder.failure
	}
	return nil
}

func (builder *fakeCompositionBuilder) selectRole(ctx context.Context, _ BootstrapOptions) error {
	return builder.step(ctx, "select-role")
}
func (builder *fakeCompositionBuilder) loadReleaseAuthority(ctx context.Context) error {
	return builder.step(ctx, "load-release")
}
func (builder *fakeCompositionBuilder) openServiceBootstrap(ctx context.Context) error {
	return builder.step(ctx, "open-bootstrap")
}
func (builder *fakeCompositionBuilder) measureCurrentImage(ctx context.Context) error {
	return builder.step(ctx, "measure-image")
}
func (builder *fakeCompositionBuilder) verifyInstallation(ctx context.Context) error {
	return builder.step(ctx, "verify-installation")
}
func (builder *fakeCompositionBuilder) verifyDataRoot(ctx context.Context) error {
	return builder.step(ctx, "verify-data-root")
}
func (builder *fakeCompositionBuilder) openRoleCredentials(ctx context.Context) error {
	return builder.step(ctx, "open-credentials")
}
func (builder *fakeCompositionBuilder) composePreflight(ctx context.Context) error {
	return builder.step(ctx, "compose-preflight")
}
func (builder *fakeCompositionBuilder) connectPeer(ctx context.Context) error {
	return builder.step(ctx, "connect-peer")
}
func (builder *fakeCompositionBuilder) verifyPeer(ctx context.Context) error {
	return builder.step(ctx, "verify-peer")
}
func (builder *fakeCompositionBuilder) finalizeRuntimePlan(ctx context.Context) error {
	return builder.step(ctx, "finalize-plan")
}
func (builder *fakeCompositionBuilder) createRuntimeBootstrap(ctx context.Context) error {
	return builder.step(ctx, "create-bootstrap")
}
func (builder *fakeCompositionBuilder) openLaunchGuard(ctx context.Context) error {
	return builder.step(ctx, "open-guard")
}
func (builder *fakeCompositionBuilder) prepareHostControl(ctx context.Context) error {
	return builder.step(ctx, "prepare-host-control")
}
func (builder *fakeCompositionBuilder) launchNode(ctx context.Context) error {
	return builder.step(ctx, "launch-node")
}
func (builder *fakeCompositionBuilder) takeNodeStandardIO(ctx context.Context) error {
	return builder.step(ctx, "take-node-stdio")
}
func (builder *fakeCompositionBuilder) acceptHostControl(ctx context.Context) error {
	return builder.step(ctx, "accept-host-control")
}
func (builder *fakeCompositionBuilder) buildRoleRuntime(ctx context.Context) error {
	return builder.step(ctx, "build-role-runtime")
}

func (builder *fakeCompositionBuilder) runtimeSupervision() (runtimeSupervision, error) {
	builder.mu.Lock()
	defer builder.mu.Unlock()
	builder.events = append(builder.events, "runtime-supervision")
	return builder.runtime, builder.runtimeError
}

func (builder *fakeCompositionBuilder) cleanup() error {
	builder.mu.Lock()
	defer builder.mu.Unlock()
	builder.cleanupCalls++
	builder.events = append(builder.events, "cleanup")
	if builder.lifetime != nil && context.Cause(builder.lifetime) == nil {
		return errors.New("cleanup ran before lifetime cancellation")
	}
	if builder.coordinator != nil {
		builder.cleanupExitCount = builder.coordinator.exitCount()
	}
	for index := len(builder.acquired) - 1; index >= 0; index-- {
		builder.closed = append(builder.closed, builder.acquired[index])
	}
	result := builder.cleanupError
	if builder.nodeOwner != nil {
		result = errors.Join(result, builder.nodeOwner.Terminate(), builder.nodeOwner.Close())
	}
	return result
}

func (builder *fakeCompositionBuilder) snapshot() ([]string, int, int) {
	builder.mu.Lock()
	defer builder.mu.Unlock()
	return append([]string(nil), builder.events...), builder.cleanupCalls, builder.cleanupExitCount
}

func (builder *fakeCompositionBuilder) closedSnapshot() []string {
	builder.mu.Lock()
	defer builder.mu.Unlock()
	return append([]string(nil), builder.closed...)
}

func TestCompositionRunsFixedStagesAndCleansEveryFailure(t *testing.T) {
	failure := errors.New("stage failed")
	for index, stage := range compositionTestStages {
		t.Run(stage, func(t *testing.T) {
			builder := &fakeCompositionBuilder{failAt: stage, failure: failure}
			err := runComposition(context.Background(), BootstrapOptions{ActualBootstrapPath: `C:\trusted.json`}, builder)
			if !errors.Is(err, failure) {
				t.Fatalf("runComposition error = %v", err)
			}
			events, cleanupCalls, _ := builder.snapshot()
			want := append([]string(nil), compositionTestStages[:index+1]...)
			want = append(want, "cleanup")
			if !reflect.DeepEqual(events, want) || cleanupCalls != 1 {
				t.Fatalf("events=%v cleanup=%d want=%v/1", events, cleanupCalls, want)
			}
			wantClosed := make([]string, index+1)
			for ownerIndex := range wantClosed {
				wantClosed[ownerIndex] = compositionTestStages[index-ownerIndex]
			}
			if closed := builder.closedSnapshot(); !reflect.DeepEqual(closed, wantClosed) {
				t.Fatalf("closed owners = %v, want reverse acquisition order %v", closed, wantClosed)
			}
		})
	}
}

func TestCompositionRuntimeConstructionAndCleanupErrorsAreJoined(t *testing.T) {
	runtimeFailure := errors.New("runtime construction failed")
	cleanupFailure := errors.New("cleanup failed")
	builder := &fakeCompositionBuilder{
		runtimeError: runtimeFailure,
		cleanupError: cleanupFailure,
	}
	err := runComposition(context.Background(), BootstrapOptions{}, builder)
	if !errors.Is(err, runtimeFailure) || !errors.Is(err, cleanupFailure) ||
		!errors.Is(err, errHostCleanupFatal) {
		t.Fatalf("joined error = %v", err)
	}
	events, cleanupCalls, _ := builder.snapshot()
	want := append(append([]string(nil), compositionTestStages...), "runtime-supervision", "cleanup")
	if !reflect.DeepEqual(events, want) || cleanupCalls != 1 {
		t.Fatalf("events=%v cleanup=%d want=%v/1", events, cleanupCalls, want)
	}
}

func TestCompositionStartupFailureUsesOneNodeTerminationBudget(t *testing.T) {
	failure := errors.New("startup failed after Node launch")
	t.Run("successful termination closes remaining handles", func(t *testing.T) {
		rawNode := &fakeSupervisedNode{}
		node := mustNodeOwner(t, rawNode)
		builder := &fakeCompositionBuilder{
			failAt:    "take-node-stdio",
			failure:   failure,
			nodeOwner: node,
		}
		if err := runComposition(context.Background(), BootstrapOptions{}, builder); !errors.Is(err, failure) {
			t.Fatalf("startup failure = %v", err)
		}
		terminateCalls, closeCalls := rawNode.calls()
		if terminateCalls != 1 || closeCalls != 1 {
			t.Fatalf("raw terminate=%d close=%d, want 1/1", terminateCalls, closeCalls)
		}
	})

	t.Run("failed termination retains owner", func(t *testing.T) {
		termination := errors.New("termination failed")
		rawNode := &fakeSupervisedNode{terminateErr: termination}
		node := mustNodeOwner(t, rawNode)
		builder := &fakeCompositionBuilder{
			failAt:    "take-node-stdio",
			failure:   failure,
			nodeOwner: node,
		}
		err := runComposition(context.Background(), BootstrapOptions{}, builder)
		if !errors.Is(err, failure) || !errors.Is(err, termination) ||
			!errors.Is(err, errHostCleanupFatal) {
			t.Fatalf("startup cleanup failure = %v", err)
		}
		terminateCalls, closeCalls := rawNode.calls()
		if terminateCalls != 1 || closeCalls != 0 {
			t.Fatalf("raw terminate=%d close=%d, want 1/0", terminateCalls, closeCalls)
		}
	})
}

type supervisionCoordinator struct {
	started chan string
	release chan struct{}

	mu     sync.Mutex
	exited int
}

func newSupervisionCoordinator() *supervisionCoordinator {
	return &supervisionCoordinator{
		started: make(chan string, 7),
		release: make(chan struct{}),
	}
}

func (coordinator *supervisionCoordinator) markExit() {
	coordinator.mu.Lock()
	coordinator.exited++
	coordinator.mu.Unlock()
}

func (coordinator *supervisionCoordinator) exitCount() int {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	return coordinator.exited
}

type fakeSupervisedNode struct {
	coordinator  *supervisionCoordinator
	terminateErr error
	closeErr     error

	mu             sync.Mutex
	terminateCalls int
	closeCalls     int
}

type panickingSupervisedNode struct {
	mu             sync.Mutex
	terminateCalls int
	closeCalls     int
}

func (*panickingSupervisedNode) WaitContext(context.Context) (uint32, error) {
	panic("Node wait panic")
}

func (node *panickingSupervisedNode) Terminate() error {
	node.mu.Lock()
	node.terminateCalls++
	node.mu.Unlock()
	return nil
}

func (node *panickingSupervisedNode) Close() error {
	node.mu.Lock()
	node.closeCalls++
	node.mu.Unlock()
	return nil
}

func (node *panickingSupervisedNode) calls() (int, int) {
	node.mu.Lock()
	defer node.mu.Unlock()
	return node.terminateCalls, node.closeCalls
}

func (node *fakeSupervisedNode) WaitContext(ctx context.Context) (uint32, error) {
	if node.coordinator == nil {
		<-ctx.Done()
		return 0, context.Cause(ctx)
	}
	node.coordinator.started <- "node"
	defer node.coordinator.markExit()
	<-ctx.Done()
	return 0, context.Cause(ctx)
}

func (node *fakeSupervisedNode) Terminate() error {
	node.mu.Lock()
	node.terminateCalls++
	node.mu.Unlock()
	return node.terminateErr
}

func (node *fakeSupervisedNode) Close() error {
	node.mu.Lock()
	node.closeCalls++
	node.mu.Unlock()
	return node.closeErr
}

func (node *fakeSupervisedNode) calls() (int, int) {
	node.mu.Lock()
	defer node.mu.Unlock()
	return node.terminateCalls, node.closeCalls
}

func mustNodeOwner(t *testing.T, node supervisedNodeProcess) *nodeShutdownOwner {
	t.Helper()
	owner, err := newNodeShutdownOwner(node)
	if err != nil {
		t.Fatal(err)
	}
	return owner
}

func coordinatedRuntime(
	coordinator *supervisionCoordinator,
	node *nodeShutdownOwner,
	lifetime func() context.Context,
	primaryName string,
	primaryErr error,
	secondaryName string,
	secondaryErr error,
) runtimeSupervision {
	task := func(name string) func(context.Context) error {
		return func(ctx context.Context) error {
			coordinator.started <- name
			defer coordinator.markExit()
			if name == primaryName || name == secondaryName {
				<-coordinator.release
				if name == primaryName {
					return primaryErr
				}
				return secondaryErr
			}
			<-ctx.Done()
			return context.Cause(ctx)
		}
	}
	return runtimeSupervision{
		node:            node,
		serveLocalRPC:   task("local-rpc"),
		runRelay:        task("relay"),
		waitOwnWrapper:  task("own-wrapper"),
		waitPeerWrapper: task("peer-wrapper"),
		waitPeerHost:    task("peer-host"),
		waitStderr: func(context.Context) error {
			coordinator.started <- "stderr"
			defer coordinator.markExit()
			ctx := lifetime()
			<-ctx.Done()
			return context.Cause(ctx)
		},
	}
}

type controlledNodeResult struct {
	exitCode uint32
	err      error
}

type controlledSupervision struct {
	started     chan string
	results     map[string]chan error
	nodeResults chan controlledNodeResult
}

func newControlledSupervision() *controlledSupervision {
	results := make(map[string]chan error)
	for _, name := range []string{
		"local-rpc", "relay", "own-wrapper", "peer-wrapper", "peer-host", "stderr",
	} {
		results[name] = make(chan error, 1)
	}
	return &controlledSupervision{
		started:     make(chan string, 7),
		results:     results,
		nodeResults: make(chan controlledNodeResult, 1),
	}
}

func (control *controlledSupervision) task(name string) func(context.Context) error {
	return func(ctx context.Context) error {
		control.started <- name
		select {
		case err := <-control.results[name]:
			return err
		case <-ctx.Done():
			return context.Cause(ctx)
		}
	}
}

type controlledSupervisedNode struct {
	control             *controlledSupervision
	waitCancellationErr error

	mu             sync.Mutex
	terminateCalls int
	closeCalls     int
}

func (node *controlledSupervisedNode) WaitContext(ctx context.Context) (uint32, error) {
	node.control.started <- "node"
	select {
	case result := <-node.control.nodeResults:
		return result.exitCode, result.err
	case <-ctx.Done():
		return 0, errors.Join(context.Cause(ctx), node.waitCancellationErr)
	}
}

func (node *controlledSupervisedNode) Terminate() error {
	node.mu.Lock()
	node.terminateCalls++
	node.mu.Unlock()
	return nil
}

func (node *controlledSupervisedNode) Close() error {
	node.mu.Lock()
	node.closeCalls++
	node.mu.Unlock()
	return nil
}

func (node *controlledSupervisedNode) calls() (int, int) {
	node.mu.Lock()
	defer node.mu.Unlock()
	return node.terminateCalls, node.closeCalls
}

func controlledRuntime(
	control *controlledSupervision,
	node *nodeShutdownOwner,
	observed chan<- supervisedTaskKind,
) runtimeSupervision {
	return runtimeSupervision{
		node:            node,
		serveLocalRPC:   control.task("local-rpc"),
		runRelay:        control.task("relay"),
		waitOwnWrapper:  control.task("own-wrapper"),
		waitPeerWrapper: control.task("peer-wrapper"),
		waitPeerHost:    control.task("peer-host"),
		waitStderr:      control.task("stderr"),
		onResult: func(kind supervisedTaskKind) {
			observed <- kind
		},
	}
}

func waitForControlledStarts(t *testing.T, control *controlledSupervision) {
	t.Helper()
	started := make(map[string]struct{}, 7)
	for len(started) != 7 {
		select {
		case name := <-control.started:
			started[name] = struct{}{}
		case <-time.After(5 * time.Second):
			t.Fatalf("supervised tasks did not all start: %v", started)
		}
	}
}

func waitForObservedResult(
	t *testing.T,
	observed <-chan supervisedTaskKind,
	want supervisedTaskKind,
) {
	t.Helper()
	select {
	case got := <-observed:
		if got != want {
			t.Fatalf("observed task = %d, want %d", got, want)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("supervisor did not observe task %d", want)
	}
}

func waitForSupervisionResult(t *testing.T, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("supervision did not converge")
		return nil
	}
}

func TestSupervisionRequiresJointCleanBarrier(t *testing.T) {
	t.Run("local RPC first permits Node and stderr exit", func(t *testing.T) {
		control := newControlledSupervision()
		rawNode := &controlledSupervisedNode{control: control}
		node := mustNodeOwner(t, rawNode)
		observed := make(chan supervisedTaskKind, 7)
		ctx, cancel := context.WithCancelCause(context.Background())
		defer cancel(nil)
		result := make(chan error, 1)
		go func() {
			result <- superviseRuntime(ctx, cancel, controlledRuntime(control, node, observed))
		}()
		waitForControlledStarts(t, control)

		control.results["local-rpc"] <- nil
		waitForObservedResult(t, observed, supervisedLocalRPC)
		if cause := context.Cause(ctx); cause != nil {
			t.Fatalf("first clean component canceled runtime: %v", cause)
		}
		control.nodeResults <- controlledNodeResult{}
		waitForObservedResult(t, observed, supervisedNode)
		control.results["stderr"] <- nil
		waitForObservedResult(t, observed, supervisedStderr)
		if cause := context.Cause(ctx); cause != nil {
			t.Fatalf("graceful-progress exits canceled runtime: %v", cause)
		}

		control.results["relay"] <- nil
		waitForObservedResult(t, observed, supervisedRelay)
		if cause := context.Cause(ctx); !errors.Is(cause, errOrderlyRuntimeStop) {
			t.Fatalf("joint clean cancellation cause = %v", cause)
		}
		if err := waitForSupervisionResult(t, result); err != nil {
			t.Fatalf("joint clean supervision = %v", err)
		}
		terminateCalls, closeCalls := rawNode.calls()
		if terminateCalls != 0 || closeCalls != 0 {
			t.Fatalf("raw terminate=%d close=%d before cleanup", terminateCalls, closeCalls)
		}
		if err := node.Close(); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("relay first permits peer exits", func(t *testing.T) {
		control := newControlledSupervision()
		rawNode := &controlledSupervisedNode{control: control}
		node := mustNodeOwner(t, rawNode)
		observed := make(chan supervisedTaskKind, 7)
		ctx, cancel := context.WithCancelCause(context.Background())
		defer cancel(nil)
		result := make(chan error, 1)
		go func() {
			result <- superviseRuntime(ctx, cancel, controlledRuntime(control, node, observed))
		}()
		waitForControlledStarts(t, control)

		control.results["relay"] <- nil
		waitForObservedResult(t, observed, supervisedRelay)
		if cause := context.Cause(ctx); cause != nil {
			t.Fatalf("first clean relay canceled runtime: %v", cause)
		}
		control.results["peer-wrapper"] <- nil
		waitForObservedResult(t, observed, supervisedPeerWrapper)
		control.results["peer-host"] <- nil
		waitForObservedResult(t, observed, supervisedPeerHost)
		if cause := context.Cause(ctx); cause != nil {
			t.Fatalf("peer exits after relay clean canceled runtime: %v", cause)
		}

		control.results["local-rpc"] <- nil
		waitForObservedResult(t, observed, supervisedLocalRPC)
		if err := waitForSupervisionResult(t, result); err != nil {
			t.Fatalf("joint clean supervision = %v", err)
		}
		if err := node.Close(); err != nil {
			t.Fatal(err)
		}
	})
}

func TestSupervisionPreservesPreShutdownFailureAfterCleanProgress(t *testing.T) {
	control := newControlledSupervision()
	rawNode := &controlledSupervisedNode{control: control}
	node := mustNodeOwner(t, rawNode)
	observed := make(chan supervisedTaskKind, 7)
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	result := make(chan error, 1)
	go func() {
		result <- superviseRuntime(ctx, cancel, controlledRuntime(control, node, observed))
	}()
	waitForControlledStarts(t, control)

	control.results["local-rpc"] <- nil
	waitForObservedResult(t, observed, supervisedLocalRPC)
	if cause := context.Cause(ctx); cause != nil {
		t.Fatalf("clean progress canceled runtime: %v", cause)
	}
	relayFailure := errors.New("relay failed before shutdown")
	control.results["relay"] <- errors.Join(relayFailure, context.Canceled)
	waitForObservedResult(t, observed, supervisedRelay)
	if err := waitForSupervisionResult(t, result); !errors.Is(err, relayFailure) {
		t.Fatalf("pre-shutdown relay error was lost: %v", err)
	}
	if err := node.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestSupervisionDoesNotLoseTerminalWhenParentIsAlreadyCanceled(t *testing.T) {
	terminal := errors.New("relay terminal")
	parent := errors.New("parent canceled")
	rawNode := &fakeSupervisedNode{}
	node := mustNodeOwner(t, rawNode)
	waitContext := func(ctx context.Context) error {
		<-ctx.Done()
		return context.Cause(ctx)
	}
	runtime := runtimeSupervision{
		node:            node,
		serveLocalRPC:   waitContext,
		runRelay:        func(context.Context) error { return terminal },
		waitOwnWrapper:  waitContext,
		waitPeerWrapper: waitContext,
		waitPeerHost:    waitContext,
		waitStderr:      waitContext,
	}
	ctx, cancel := context.WithCancelCause(context.Background())
	cancel(parent)
	err := superviseRuntime(ctx, cancel, runtime)
	if !errors.Is(err, terminal) || !errors.Is(err, parent) {
		t.Fatalf("concurrent terminal/context result = %v", err)
	}
	if closeErr := node.Close(); closeErr != nil {
		t.Fatal(closeErr)
	}
}

func TestSupervisionCancelsTerminatesAndJoinsBeforeCleanup(t *testing.T) {
	coordinator := newSupervisionCoordinator()
	rawNode := &fakeSupervisedNode{coordinator: coordinator}
	node := mustNodeOwner(t, rawNode)
	builder := &fakeCompositionBuilder{coordinator: coordinator, nodeOwner: node}
	builder.runtime = coordinatedRuntime(
		coordinator,
		node,
		func() context.Context { return builder.lifetime },
		"local-rpc",
		nil,
		"relay",
		nil,
	)
	result := make(chan error, 1)
	go func() { result <- runComposition(context.Background(), BootstrapOptions{}, builder) }()
	started := make(map[string]struct{}, 7)
	for range 7 {
		started[<-coordinator.started] = struct{}{}
	}
	if len(started) != 7 {
		t.Fatalf("started tasks = %v", started)
	}
	close(coordinator.release)
	if err := <-result; err != nil {
		t.Fatalf("orderly supervision error = %v", err)
	}
	_, cleanupCalls, cleanupExitCount := builder.snapshot()
	terminateCalls, closeCalls := rawNode.calls()
	if terminateCalls != 1 || closeCalls != 1 || cleanupCalls != 1 || cleanupExitCount != 7 {
		t.Fatalf(
			"terminate=%d close=%d cleanup=%d joined-before-cleanup=%d",
			terminateCalls,
			closeCalls,
			cleanupCalls,
			cleanupExitCount,
		)
	}
}

func TestSupervisionPreservesPrimarySecondaryAndTerminationFailures(t *testing.T) {
	coordinator := newSupervisionCoordinator()
	primary := errors.New("relay failed")
	secondary := errors.New("peer wait failed during shutdown")
	termination := errors.New("root Job termination failed")
	rawNode := &fakeSupervisedNode{coordinator: coordinator, terminateErr: termination}
	node := mustNodeOwner(t, rawNode)
	builder := &fakeCompositionBuilder{coordinator: coordinator, nodeOwner: node}
	builder.runtime = coordinatedRuntime(
		coordinator,
		node,
		func() context.Context { return builder.lifetime },
		"relay",
		primary,
		"peer-host",
		secondary,
	)
	result := make(chan error, 1)
	go func() { result <- runComposition(context.Background(), BootstrapOptions{}, builder) }()
	for range 7 {
		<-coordinator.started
	}
	close(coordinator.release)
	err := <-result
	if !errors.Is(err, primary) || !errors.Is(err, secondary) || !errors.Is(err, termination) ||
		!errors.Is(err, errHostCleanupFatal) {
		t.Fatalf("supervision error = %v", err)
	}
	_, _, cleanupExitCount := builder.snapshot()
	terminateCalls, closeCalls := rawNode.calls()
	if cleanupExitCount != 7 || terminateCalls != 1 || closeCalls != 0 {
		t.Fatalf("joined=%d terminate=%d close=%d", cleanupExitCount, terminateCalls, closeCalls)
	}
}

func TestCleanLocalRPCExitDoesNotHideRelayShutdownFailure(t *testing.T) {
	coordinator := newSupervisionCoordinator()
	relayFailure := errors.New("relay failed after local RPC stopped")
	rawNode := &fakeSupervisedNode{coordinator: coordinator}
	node := mustNodeOwner(t, rawNode)
	builder := &fakeCompositionBuilder{coordinator: coordinator, nodeOwner: node}
	builder.runtime = coordinatedRuntime(
		coordinator,
		node,
		func() context.Context { return builder.lifetime },
		"local-rpc",
		nil,
		"relay",
		errors.Join(relayFailure, context.Canceled),
	)
	result := make(chan error, 1)
	go func() { result <- runComposition(context.Background(), BootstrapOptions{}, builder) }()
	for range 7 {
		<-coordinator.started
	}
	close(coordinator.release)
	if err := <-result; !errors.Is(err, relayFailure) {
		t.Fatalf("clean local RPC exit hid relay failure: %v", err)
	}
	_, _, cleanupExitCount := builder.snapshot()
	if cleanupExitCount != 7 {
		t.Fatalf("joined tasks before cleanup = %d, want 7", cleanupExitCount)
	}
}

func TestParentCancellationTerminatesAndJoinsEveryRuntimeTask(t *testing.T) {
	coordinator := newSupervisionCoordinator()
	rawNode := &fakeSupervisedNode{coordinator: coordinator}
	node := mustNodeOwner(t, rawNode)
	builder := &fakeCompositionBuilder{coordinator: coordinator, nodeOwner: node}
	builder.runtime = coordinatedRuntime(
		coordinator,
		node,
		func() context.Context { return builder.lifetime },
		"",
		nil,
		"",
		nil,
	)
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- runComposition(ctx, BootstrapOptions{}, builder) }()
	for range 7 {
		<-coordinator.started
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("parent cancellation error = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("runtime tasks did not converge after parent cancellation")
	}
	_, cleanupCalls, cleanupExitCount := builder.snapshot()
	terminateCalls, closeCalls := rawNode.calls()
	if terminateCalls != 1 || closeCalls != 1 || cleanupCalls != 1 || cleanupExitCount != 7 {
		t.Fatalf(
			"terminate=%d close=%d cleanup=%d joined-before-cleanup=%d",
			terminateCalls,
			closeCalls,
			cleanupCalls,
			cleanupExitCount,
		)
	}
}

func TestSupervisionTreatsWatcherExitAsUnexpected(t *testing.T) {
	coordinator := newSupervisionCoordinator()
	rawNode := &fakeSupervisedNode{coordinator: coordinator}
	node := mustNodeOwner(t, rawNode)
	builder := &fakeCompositionBuilder{coordinator: coordinator, nodeOwner: node}
	builder.runtime = coordinatedRuntime(
		coordinator,
		node,
		func() context.Context { return builder.lifetime },
		"own-wrapper",
		nil,
		"",
		nil,
	)
	result := make(chan error, 1)
	go func() { result <- runComposition(context.Background(), BootstrapOptions{}, builder) }()
	for range 7 {
		<-coordinator.started
	}
	close(coordinator.release)
	if err := <-result; !errors.Is(err, errUnexpectedComponent) {
		t.Fatalf("watcher exit error = %v", err)
	}
}

func TestSupervisionCleanExitStateMachine(t *testing.T) {
	localRPC := supervisedResult{task: supervisedTask{
		kind: supervisedLocalRPC,
		name: "local RPC server",
	}}
	relayResult := supervisedResult{task: supervisedTask{
		kind: supervisedRelay,
		name: "role-aware relay",
	}}
	nodeResult := supervisedResult{task: supervisedTask{
		kind: supervisedNode,
		name: "Node process",
	}}
	stderrResult := supervisedResult{task: supervisedTask{
		kind: supervisedStderr,
		name: "Node stderr",
	}}
	peerWrapper := supervisedResult{task: supervisedTask{
		kind: supervisedPeerWrapper,
		name: "peer WinSW wrapper",
	}}
	peerHost := supervisedResult{task: supervisedTask{
		kind: supervisedPeerHost,
		name: "peer ServiceHost",
	}}
	ownWrapper := supervisedResult{task: supervisedTask{
		kind: supervisedOwnWrapper,
		name: "own WinSW wrapper",
	}}

	beforeGraceful := supervisionOutcome{}
	if terminal, _ := beforeGraceful.observeClean(nodeResult); !errors.Is(terminal, errUnexpectedComponent) {
		t.Fatalf("Node exit before graceful progress = %v", terminal)
	}
	if terminal, _ := beforeGraceful.observeClean(stderrResult); !errors.Is(terminal, errUnexpectedComponent) {
		t.Fatalf("stderr exit before graceful progress = %v", terminal)
	}

	outcome := supervisionOutcome{}
	if terminal, joint := outcome.observeClean(localRPC); terminal != nil || joint {
		t.Fatalf("first clean component = terminal:%v joint:%v", terminal, joint)
	}
	if terminal, _ := outcome.observeClean(nodeResult); terminal != nil {
		t.Fatalf("Node exit during graceful progress = %v", terminal)
	}
	if terminal, _ := outcome.observeClean(stderrResult); terminal != nil {
		t.Fatalf("stderr exit during graceful progress = %v", terminal)
	}
	if terminal, _ := outcome.observeClean(peerWrapper); !errors.Is(terminal, errUnexpectedComponent) {
		t.Fatalf("peer wrapper exit before relay clean = %v", terminal)
	}
	if terminal, joint := outcome.observeClean(relayResult); terminal != nil || !joint {
		t.Fatalf("joint clean barrier = terminal:%v joint:%v", terminal, joint)
	}
	if terminal, _ := outcome.observeClean(peerHost); terminal != nil {
		t.Fatalf("peer exit after relay clean = %v", terminal)
	}
	if terminal, _ := outcome.observeClean(ownWrapper); !errors.Is(terminal, errUnexpectedComponent) {
		t.Fatalf("own wrapper exit during graceful shutdown = %v", terminal)
	}
	nodeResult.exitCode = 7
	if terminal, _ := outcome.observeClean(nodeResult); !errors.Is(terminal, errUnexpectedComponent) {
		t.Fatalf("nonzero Node exit = %v", terminal)
	}
	nodeResult.afterShutdown = true
	if terminal, _ := outcome.observeClean(nodeResult); terminal != nil {
		t.Fatalf("actively terminated Node exit became secondary failure: %v", terminal)
	}
}

func TestSupervisionOutcomePreservesFirstTerminalAndConcurrentContextCause(t *testing.T) {
	first := errors.New("first terminal")
	parent := errors.New("parent cancellation")
	outcome := supervisionOutcome{}
	outcome.add(fmt.Errorf("role-aware relay: %w", first))
	outcome.add(fmt.Errorf("runtime context: %w", parent))
	if !errors.Is(outcome.primary, first) || len(outcome.secondary) != 1 ||
		!errors.Is(outcome.secondary[0], parent) {
		t.Fatalf("outcome reordered or lost a concurrent cause: %+v", outcome)
	}
	if result := outcome.result(); !errors.Is(result, first) || !errors.Is(result, parent) {
		t.Fatalf("joined outcome = %v", result)
	}
}

func TestSupervisionConvergesAfterNodeWaitPanic(t *testing.T) {
	rawNode := &panickingSupervisedNode{}
	node := mustNodeOwner(t, rawNode)
	waitForShutdown := func(ctx context.Context) error {
		<-ctx.Done()
		return context.Cause(ctx)
	}
	runtime := runtimeSupervision{
		node:            node,
		serveLocalRPC:   waitForShutdown,
		runRelay:        waitForShutdown,
		waitOwnWrapper:  waitForShutdown,
		waitPeerWrapper: waitForShutdown,
		waitPeerHost:    waitForShutdown,
		waitStderr:      waitForShutdown,
	}
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	result := make(chan error, 1)
	go func() { result <- superviseRuntime(ctx, cancel, runtime) }()

	select {
	case err := <-result:
		if err == nil || !strings.Contains(err.Error(), "Node wait panic") {
			t.Fatalf("Node wait panic result = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("supervision did not converge after Node wait panic")
	}
	if err := node.Close(); err != nil {
		t.Fatal(err)
	}
	terminateCalls, closeCalls := rawNode.calls()
	if terminateCalls != 1 || closeCalls != 1 {
		t.Fatalf("raw terminate=%d close=%d, want 1/1", terminateCalls, closeCalls)
	}
}

func TestNodeShutdownOwnerConsumesTerminationOnce(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		rawNode := &fakeSupervisedNode{}
		owner := mustNodeOwner(t, rawNode)
		var callers sync.WaitGroup
		results := make(chan error, 8)
		for range 8 {
			callers.Add(1)
			go func() {
				defer callers.Done()
				results <- owner.Terminate()
			}()
		}
		callers.Wait()
		close(results)
		for err := range results {
			if err != nil {
				t.Fatalf("concurrent Terminate = %v", err)
			}
		}
		if err := owner.Close(); err != nil {
			t.Fatal(err)
		}
		if err := owner.Close(); err != nil {
			t.Fatal(err)
		}
		terminateCalls, closeCalls := rawNode.calls()
		if terminateCalls != 1 || closeCalls != 1 {
			t.Fatalf("raw terminate=%d close=%d, want 1/1", terminateCalls, closeCalls)
		}
	})

	t.Run("termination failure retains without close", func(t *testing.T) {
		termination := errors.New("termination failed")
		rawNode := &fakeSupervisedNode{terminateErr: termination}
		owner := mustNodeOwner(t, rawNode)
		if err := owner.Terminate(); !errors.Is(err, termination) ||
			!errors.Is(err, errNodeOwnerRetained) {
			t.Fatalf("Terminate = %v", err)
		}
		if err := owner.Terminate(); !errors.Is(err, termination) {
			t.Fatalf("repeated Terminate = %v", err)
		}
		if err := owner.Close(); !errors.Is(err, errNodeOwnerRetained) {
			t.Fatalf("Close after failed Terminate = %v", err)
		}
		terminateCalls, closeCalls := rawNode.calls()
		if terminateCalls != 1 || closeCalls != 0 {
			t.Fatalf("raw terminate=%d close=%d, want 1/0", terminateCalls, closeCalls)
		}
	})

	t.Run("close before termination is rejected", func(t *testing.T) {
		rawNode := &fakeSupervisedNode{}
		owner := mustNodeOwner(t, rawNode)
		if err := owner.Close(); !errors.Is(err, errNodeTerminateFirst) {
			t.Fatalf("Close before Terminate = %v", err)
		}
		terminateCalls, closeCalls := rawNode.calls()
		if terminateCalls != 0 || closeCalls != 0 {
			t.Fatalf("raw terminate=%d close=%d, want 0/0", terminateCalls, closeCalls)
		}
	})

	t.Run("external rejection is never retried", func(t *testing.T) {
		rejection := errors.New("HostControl rejected launch")
		rawNode := &fakeSupervisedNode{}
		owner := mustNodeOwner(t, rawNode)
		owner.retainAfterExternalShutdownAttempt(rejection)
		if err := owner.Terminate(); !errors.Is(err, rejection) {
			t.Fatalf("Terminate after external rejection = %v", err)
		}
		if err := owner.Close(); !errors.Is(err, errNodeOwnerRetained) {
			t.Fatalf("Close after external rejection = %v", err)
		}
		terminateCalls, closeCalls := rawNode.calls()
		if terminateCalls != 0 || closeCalls != 0 {
			t.Fatalf("raw terminate=%d close=%d, want 0/0", terminateCalls, closeCalls)
		}
	})

	t.Run("terminal wait failure consumes the attempt", func(t *testing.T) {
		control := newControlledSupervision()
		rawNode := &controlledSupervisedNode{control: control}
		owner := mustNodeOwner(t, rawNode)
		waitFailure := errors.New("terminal wait drain failed")
		waitResult := make(chan error, 1)
		go func() {
			_, err := owner.WaitContext(context.Background())
			waitResult <- err
		}()
		select {
		case name := <-control.started:
			if name != "node" {
				t.Fatalf("started task = %q", name)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("Node wait did not start")
		}
		control.nodeResults <- controlledNodeResult{err: waitFailure}
		if err := <-waitResult; !errors.Is(err, waitFailure) ||
			!errors.Is(err, errNodeOwnerRetained) {
			t.Fatalf("terminal WaitContext = %v", err)
		}
		if err := owner.Terminate(); !errors.Is(err, waitFailure) {
			t.Fatalf("Terminate after terminal wait = %v", err)
		}
		if err := owner.Close(); !errors.Is(err, errNodeOwnerRetained) {
			t.Fatalf("Close after terminal wait = %v", err)
		}
		terminateCalls, closeCalls := rawNode.calls()
		if terminateCalls != 0 || closeCalls != 0 {
			t.Fatalf("raw terminate=%d close=%d, want 0/0", terminateCalls, closeCalls)
		}
	})

	t.Run("cancellation plus native cleanup failure retains", func(t *testing.T) {
		control := newControlledSupervision()
		cleanupFailure := errors.New("wait handle cleanup failed")
		rawNode := &controlledSupervisedNode{
			control:             control,
			waitCancellationErr: cleanupFailure,
		}
		owner := mustNodeOwner(t, rawNode)
		waitResult := make(chan error, 1)
		go func() {
			_, err := owner.WaitContext(context.Background())
			waitResult <- err
		}()
		select {
		case name := <-control.started:
			if name != "node" {
				t.Fatalf("started task = %q", name)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("Node wait did not start")
		}
		if err := owner.Terminate(); !errors.Is(err, cleanupFailure) ||
			!errors.Is(err, errNodeOwnerRetained) {
			t.Fatalf("Terminate after poisoned cancellation = %v", err)
		}
		if err := <-waitResult; !errors.Is(err, cleanupFailure) {
			t.Fatalf("WaitContext after poisoned cancellation = %v", err)
		}
		if err := owner.Close(); !errors.Is(err, errNodeOwnerRetained) {
			t.Fatalf("Close after poisoned cancellation = %v", err)
		}
		terminateCalls, closeCalls := rawNode.calls()
		if terminateCalls != 0 || closeCalls != 0 {
			t.Fatalf("raw terminate=%d close=%d, want 0/0", terminateCalls, closeCalls)
		}
	})
}

type roleTestDispatcher struct{}

func (*roleTestDispatcher) Register(context.Context, json.RawMessage) (json.RawMessage, error) {
	return nil, nil
}
func (*roleTestDispatcher) Claim(context.Context, json.RawMessage) (json.RawMessage, error) {
	return nil, nil
}
func (*roleTestDispatcher) InstanceHeartbeat(context.Context, string, json.RawMessage) (json.RawMessage, error) {
	return nil, nil
}
func (*roleTestDispatcher) CompleteRun(context.Context, string, json.RawMessage) (json.RawMessage, error) {
	return nil, nil
}
func (*roleTestDispatcher) FailRun(context.Context, string, json.RawMessage) (json.RawMessage, error) {
	return nil, nil
}
func (*roleTestDispatcher) SignLocalDigest(context.Context, [32]byte) ([]byte, error) {
	return nil, nil
}

func TestRoleRuntimeComponentsKeepExecutorFreeOfControlDependencies(t *testing.T) {
	for _, role := range []config.Role{config.RoleControl, config.RoleExecutor} {
		t.Run(string(role), func(t *testing.T) {
			controlCalls := 0
			serverCalls := 0
			err := buildRoleRuntimeComponents(role, func() (localrpc.ControlDispatcher, error) {
				controlCalls++
				return &roleTestDispatcher{}, nil
			}, func(localRole localrpc.Role, dispatcher localrpc.ControlDispatcher) error {
				serverCalls++
				if role == config.RoleControl {
					if localRole != localrpc.RoleControl || dispatcher == nil {
						t.Fatal("Control runtime omitted its dispatcher")
					}
				} else if localRole != localrpc.RoleExecutor || dispatcher != nil {
					t.Fatal("Executor runtime received a Control dispatcher")
				}
				return nil
			})
			if err != nil || serverCalls != 1 {
				t.Fatalf("runtime build = calls:%d error:%v", serverCalls, err)
			}
			wantControlCalls := 0
			if role == config.RoleControl {
				wantControlCalls = 1
			}
			if controlCalls != wantControlCalls {
				t.Fatalf("Control factory calls = %d, want %d", controlCalls, wantControlCalls)
			}
		})
	}
}

func TestProductionRuntimeLimitsAndShutdownBudgetAreFixed(t *testing.T) {
	if productionRequestTimeout != 60*time.Second || productionClaimTimeout != 90*time.Second ||
		productionMaximumConcurrency != 16 || productionMaximumRequestsPerSession != 1_000_000 {
		t.Fatal("production local RPC or Worker transport limits changed")
	}
	configuration := config.Config{Limits: config.Limits{
		ShutdownTimeoutMilliseconds:         120_000,
		ForceTerminationReserveMilliseconds: 15_000,
	}}
	timeout, err := gracefulShutdownTimeout(configuration)
	if err != nil || timeout != 105*time.Second {
		t.Fatalf("graceful timeout = %v, %v", timeout, err)
	}
	configuration.Limits.ForceTerminationReserveMilliseconds = 120_000
	if _, err := gracefulShutdownTimeout(configuration); err == nil {
		t.Fatal("invalid shutdown reserve was accepted")
	}
}

func TestCompositionRejectsTypedNilBuilderAndNode(t *testing.T) {
	var builder *fakeCompositionBuilder
	host := compositionHost{newBuilder: func() compositionBuilder { return builder }}
	if err := host.Run(context.Background(), BootstrapOptions{}); !errors.Is(err, errInvalidComposition) {
		t.Fatalf("typed-nil builder error = %v", err)
	}
	var node *nodeShutdownOwner
	runtime := runtimeSupervision{
		node:            node,
		serveLocalRPC:   func(context.Context) error { return nil },
		runRelay:        func(context.Context) error { return nil },
		waitOwnWrapper:  func(context.Context) error { return nil },
		waitPeerWrapper: func(context.Context) error { return nil },
		waitPeerHost:    func(context.Context) error { return nil },
		waitStderr:      func(context.Context) error { return nil },
	}
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	if err := superviseRuntime(ctx, cancel, runtime); !errors.Is(err, errInvalidComposition) {
		t.Fatalf("typed-nil Node error = %v", err)
	}
}

var _ localrpc.ControlDispatcher = (*roleTestDispatcher)(nil)
