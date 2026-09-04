//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/platform"
	"golang.org/x/sys/windows/svc"
)

const serviceTestTimeout = 5 * time.Second

type fakeWindowsServiceHost struct {
	started      chan platform.BootstrapOptions
	readyCalls   int
	returnBefore bool
	returnError  error
	cleanupError error
}

func (host *fakeWindowsServiceHost) Run(
	ctx context.Context,
	options platform.BootstrapOptions,
) error {
	if host.started != nil {
		host.started <- options
	}
	if host.returnBefore {
		return host.returnError
	}
	for index := 0; index < host.readyCalls; index++ {
		options.Ready()
	}
	<-ctx.Done()
	return errors.Join(context.Cause(ctx), host.cleanupError)
}

type serviceExecuteResult struct {
	specific bool
	code     uint32
}

type readyBarrierHost struct {
	allowReady    <-chan struct{}
	readyEntered  chan<- struct{}
	readyReturned chan<- struct{}
}

type cancellationBarrierHost struct {
	canceled    chan<- error
	allowReturn <-chan struct{}
}

func (host cancellationBarrierHost) Run(ctx context.Context, _ platform.BootstrapOptions) error {
	<-ctx.Done()
	cause := context.Cause(ctx)
	if host.canceled != nil {
		host.canceled <- cause
	}
	if host.allowReturn != nil {
		<-host.allowReturn
	}
	return cause
}

type fakeWindowsServiceClock struct {
	ticks         chan time.Time
	timeout       chan time.Time
	tickerStarted chan time.Duration
	tickerStopped chan struct{}
	timerStarted  chan time.Duration
	timerStopped  chan struct{}
}

func newFakeWindowsServiceClock() *fakeWindowsServiceClock {
	return &fakeWindowsServiceClock{
		ticks:         make(chan time.Time, 4),
		timeout:       make(chan time.Time, 1),
		tickerStarted: make(chan time.Duration, 4),
		tickerStopped: make(chan struct{}, 4),
		timerStarted:  make(chan time.Duration, 1),
		timerStopped:  make(chan struct{}, 1),
	}
}

func (clock *fakeWindowsServiceClock) timing() windowsServiceTiming {
	return windowsServiceTiming{
		newTicker: func(interval time.Duration) serviceTimeSignal {
			clock.tickerStarted <- interval
			return serviceTimeSignal{
				channel: clock.ticks,
				stop:    func() { clock.tickerStopped <- struct{}{} },
			}
		},
		newTimer: func(interval time.Duration) serviceTimeSignal {
			clock.timerStarted <- interval
			return serviceTimeSignal{
				channel: clock.timeout,
				stop:    func() { clock.timerStopped <- struct{}{} },
			}
		},
	}
}

func (host readyBarrierHost) Run(ctx context.Context, options platform.BootstrapOptions) error {
	if host.allowReady != nil {
		<-host.allowReady
	}
	if host.readyEntered != nil {
		host.readyEntered <- struct{}{}
	}
	options.Ready()
	if host.readyReturned != nil {
		host.readyReturned <- struct{}{}
	}
	<-ctx.Done()
	return context.Cause(ctx)
}

func TestServiceNameFromBootstrapPathUsesFixedRoleIdentity(t *testing.T) {
	tests := []struct {
		name string
		path string
		want string
	}{
		{
			name: "Control",
			path: config.ControlBootstrapPath,
			want: config.ControlServiceName,
		},
		{
			name: "Executor",
			path: config.ExecutorBootstrapPath,
			want: config.ExecutorServiceName,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := serviceNameFromBootstrapPath(test.path)
			if err != nil || got != test.want {
				t.Fatalf("serviceNameFromBootstrapPath(%q) = (%q, %v), want (%q, nil)", test.path, got, err, test.want)
			}
		})
	}
	if name, err := serviceNameFromBootstrapPath(`C:\config.json`); err == nil || name != "" {
		t.Fatalf("unknown bootstrap path returned (%q, %v)", name, err)
	}
}

func TestWindowsServiceRunnerDerivesNameBeforeDispatchAndIgnoresStartArguments(t *testing.T) {
	path := config.ControlBootstrapPath
	host := &fakeWindowsServiceHost{
		started:    make(chan platform.BootstrapOptions, 1),
		readyCalls: 1,
	}
	runner := windowsServiceRunner{
		isWindowsService: func() (bool, error) { return true, nil },
		runService: func(name string, handler svc.Handler) error {
			if name != config.ControlServiceName {
				return fmt.Errorf("service name = %q", name)
			}
			requests := make(chan svc.ChangeRequest, 1)
			statuses := make(chan svc.Status, 4)
			result := make(chan serviceExecuteResult, 1)
			go func() {
				specific, code := handler.Execute(
					[]string{config.ExecutorServiceName, "--config", `D:\attacker.json`},
					requests,
					statuses,
				)
				result <- serviceExecuteResult{specific: specific, code: code}
			}()
			expectServiceState(t, statuses, svc.StartPending)
			options := receiveBootstrapOptions(t, host.started)
			if options.ActualBootstrapPath != path {
				t.Fatalf("host bootstrap path = %q, want %q", options.ActualBootstrapPath, path)
			}
			expectServiceState(t, statuses, svc.Running)
			requests <- svc.ChangeRequest{Cmd: svc.Stop}
			expectServiceState(t, statuses, svc.StopPending)
			outcome := receiveServiceResult(t, result)
			if outcome.specific || outcome.code != 0 {
				t.Fatalf("service outcome = %+v, want clean stop", outcome)
			}
			return nil
		},
	}
	handled, err := runner.RunIfService(commandLine{configPath: path}, host)
	if err != nil || !handled {
		t.Fatalf("RunIfService = (%v, %v), want (true, nil)", handled, err)
	}
}

func TestWindowsServiceRunnerDoesNotEnterDispatcherOutsideSCM(t *testing.T) {
	runCalls := 0
	runner := windowsServiceRunner{
		isWindowsService: func() (bool, error) { return false, nil },
		runService: func(string, svc.Handler) error {
			runCalls++
			return nil
		},
	}
	handled, err := runner.RunIfService(commandLine{configPath: `C:\config.json`}, &fakeWindowsServiceHost{})
	if err != nil || handled || runCalls != 0 {
		t.Fatalf("RunIfService = (%v, %v), dispatcher calls=%d", handled, err, runCalls)
	}
}

func TestWindowsServiceRunnerFailsClosedWhenDetectionFails(t *testing.T) {
	detectionFailure := errors.New("detection failed")
	runCalls := 0
	runner := windowsServiceRunner{
		isWindowsService: func() (bool, error) { return false, detectionFailure },
		runService: func(string, svc.Handler) error {
			runCalls++
			return nil
		},
	}
	handled, err := runner.RunIfService(commandLine{configPath: `C:\config.json`}, &fakeWindowsServiceHost{})
	if !handled || !errors.Is(err, detectionFailure) || runCalls != 0 {
		t.Fatalf("RunIfService = (%v, %v), dispatcher calls=%d", handled, err, runCalls)
	}
}

func TestWindowsServiceHandlerStatusAndControlFlow(t *testing.T) {
	for _, command := range []svc.Cmd{svc.Stop, svc.Shutdown} {
		t.Run(fmt.Sprintf("command-%d", command), func(t *testing.T) {
			host := &fakeWindowsServiceHost{readyCalls: 2}
			handler := &windowsServiceHandler{host: host}
			requests := make(chan svc.ChangeRequest, 3)
			statuses := make(chan svc.Status, 6)
			result := make(chan serviceExecuteResult, 1)
			go func() {
				specific, code := handler.Execute(nil, requests, statuses)
				result <- serviceExecuteResult{specific: specific, code: code}
			}()

			startPending := expectServiceState(t, statuses, svc.StartPending)
			if startPending.CheckPoint != 1 || startPending.WaitHint != serviceStartWaitHintMilliseconds {
				t.Fatalf("StartPending progress = %+v", startPending)
			}
			running := expectServiceState(t, statuses, svc.Running)
			if running.Accepts != svc.AcceptStop|svc.AcceptShutdown {
				t.Fatalf("Running accepts = %v", running.Accepts)
			}
			select {
			case unexpected := <-statuses:
				t.Fatalf("duplicate ready status = %+v", unexpected)
			default:
			}
			requests <- svc.ChangeRequest{Cmd: svc.Interrogate}
			expectServiceState(t, statuses, svc.Running)
			requests <- svc.ChangeRequest{Cmd: command}
			stopPending := expectServiceState(t, statuses, svc.StopPending)
			if stopPending.CheckPoint != 1 || stopPending.WaitHint != serviceStopWaitHintMilliseconds {
				t.Fatalf("StopPending progress = %+v", stopPending)
			}
			outcome := receiveServiceResult(t, result)
			if outcome.specific || outcome.code != 0 {
				t.Fatalf("service outcome = %+v, want clean stop", outcome)
			}
		})
	}
}

func TestWindowsServiceReadyBlocksUntilRunningStatusHandoff(t *testing.T) {
	readyEntered := make(chan struct{}, 1)
	readyReturned := make(chan struct{}, 1)
	clock := newFakeWindowsServiceClock()
	handler := &windowsServiceHandler{host: readyBarrierHost{
		readyEntered:  readyEntered,
		readyReturned: readyReturned,
	}, timing: clock.timing()}
	requests := make(chan svc.ChangeRequest, 1)
	statuses := make(chan svc.Status)
	result := make(chan serviceExecuteResult, 1)
	go func() {
		specific, code := handler.Execute(nil, requests, statuses)
		result <- serviceExecuteResult{specific: specific, code: code}
	}()

	expectServiceState(t, statuses, svc.StartPending)
	expectDuration(t, clock.tickerStarted, servicePendingUpdateInterval, "pending ticker interval")
	expectDuration(t, clock.timerStarted, serviceStartupLimit, "startup timeout")
	expectSignal(t, readyEntered, "ready callback entry")
	assertNoSignal(t, readyReturned, "ready callback returned before Running handoff")
	expectServiceState(t, statuses, svc.Running)
	expectSignal(t, clock.tickerStopped, "startup progress ticker stop")
	expectSignal(t, clock.timerStopped, "startup timer stop")
	expectSignal(t, readyReturned, "ready callback return")

	requests <- svc.ChangeRequest{Cmd: svc.Stop}
	expectServiceState(t, statuses, svc.StopPending)
	outcome := receiveServiceResult(t, result)
	if outcome.specific || outcome.code != 0 {
		t.Fatalf("service outcome = %+v, want clean stop", outcome)
	}
}

func TestWindowsServicePendingProgressIncrementsCheckpoints(t *testing.T) {
	allowReturn := make(chan struct{})
	canceled := make(chan error, 1)
	clock := newFakeWindowsServiceClock()
	handler := &windowsServiceHandler{
		host: cancellationBarrierHost{
			canceled:    canceled,
			allowReturn: allowReturn,
		},
		timing: clock.timing(),
	}
	requests := make(chan svc.ChangeRequest, 1)
	statuses := make(chan svc.Status)
	result := make(chan serviceExecuteResult, 1)
	go func() {
		specific, code := handler.Execute(nil, requests, statuses)
		result <- serviceExecuteResult{specific: specific, code: code}
	}()

	start := expectServiceState(t, statuses, svc.StartPending)
	if start.CheckPoint != 1 || start.WaitHint != serviceStartWaitHintMilliseconds {
		t.Fatalf("initial StartPending = %+v", start)
	}
	clock.ticks <- time.Now()
	start = expectServiceState(t, statuses, svc.StartPending)
	if start.CheckPoint != 2 {
		t.Fatalf("updated StartPending = %+v", start)
	}
	clock.ticks <- time.Now()
	start = expectServiceState(t, statuses, svc.StartPending)
	if start.CheckPoint != 3 {
		t.Fatalf("updated StartPending = %+v", start)
	}

	requests <- svc.ChangeRequest{Cmd: svc.Stop}
	stop := expectServiceState(t, statuses, svc.StopPending)
	if stop.CheckPoint != 1 || stop.WaitHint != serviceStopWaitHintMilliseconds {
		t.Fatalf("initial StopPending = %+v", stop)
	}
	if cause := expectError(t, canceled, "service stop cancellation"); !errors.Is(cause, errWindowsServiceStop) {
		t.Fatalf("service stop cause = %v", cause)
	}
	clock.ticks <- time.Now()
	stop = expectServiceState(t, statuses, svc.StopPending)
	if stop.CheckPoint != 2 {
		t.Fatalf("updated StopPending = %+v", stop)
	}
	close(allowReturn)
	outcome := receiveServiceResult(t, result)
	if outcome.specific || outcome.code != 0 {
		t.Fatalf("service outcome = %+v, want clean stop", outcome)
	}
}

func TestWindowsServiceStartupTimeoutCancelsHostAndReturnsServiceError(t *testing.T) {
	canceled := make(chan error, 1)
	clock := newFakeWindowsServiceClock()
	handler := &windowsServiceHandler{
		host:   cancellationBarrierHost{canceled: canceled},
		timing: clock.timing(),
	}
	requests := make(chan svc.ChangeRequest)
	statuses := make(chan svc.Status)
	result := make(chan serviceExecuteResult, 1)
	go func() {
		specific, code := handler.Execute(nil, requests, statuses)
		result <- serviceExecuteResult{specific: specific, code: code}
	}()

	expectServiceState(t, statuses, svc.StartPending)
	clock.timeout <- time.Now()
	stop := expectServiceState(t, statuses, svc.StopPending)
	if stop.CheckPoint != 1 || stop.WaitHint != serviceStopWaitHintMilliseconds {
		t.Fatalf("timeout StopPending = %+v", stop)
	}
	if cause := expectError(t, canceled, "startup timeout cancellation"); !errors.Is(cause, errWindowsServiceStartupTimeout) {
		t.Fatalf("startup timeout cause = %v", cause)
	}
	outcome := receiveServiceResult(t, result)
	if !outcome.specific || outcome.code != uint32(exitPreflight) {
		t.Fatalf("service outcome = %+v, want service-specific %d", outcome, exitPreflight)
	}
	select {
	case unexpected := <-statuses:
		t.Fatalf("status after startup timeout = %+v", unexpected)
	default:
	}
}

func TestWindowsServiceHandlerStopBeforeReadyNeverReportsRunning(t *testing.T) {
	allowReady := make(chan struct{})
	readyReturned := make(chan struct{}, 1)
	handler := &windowsServiceHandler{host: readyBarrierHost{
		allowReady:    allowReady,
		readyReturned: readyReturned,
	}}
	requests := make(chan svc.ChangeRequest, 1)
	statuses := make(chan svc.Status, 3)
	result := make(chan serviceExecuteResult, 1)
	go func() {
		specific, code := handler.Execute(nil, requests, statuses)
		result <- serviceExecuteResult{specific: specific, code: code}
	}()
	startPending := expectServiceState(t, statuses, svc.StartPending)
	requests <- svc.ChangeRequest{Cmd: svc.Interrogate}
	interrogated := expectServiceState(t, statuses, svc.StartPending)
	if interrogated != startPending {
		t.Fatalf("interrogated status = %+v, want %+v", interrogated, startPending)
	}
	requests <- svc.ChangeRequest{Cmd: svc.Stop}
	expectServiceState(t, statuses, svc.StopPending)
	close(allowReady)
	expectSignal(t, readyReturned, "ready callback release after pre-ready stop")
	outcome := receiveServiceResult(t, result)
	if outcome.specific || outcome.code != 0 {
		t.Fatalf("service outcome = %+v, want clean stop", outcome)
	}
	select {
	case unexpected := <-statuses:
		t.Fatalf("status after clean pre-ready stop = %+v", unexpected)
	default:
	}
}

func TestWindowsServiceHandlerReturnsServiceSpecificCodeForHostFailures(t *testing.T) {
	t.Run("nil before ready", func(t *testing.T) {
		clock := newFakeWindowsServiceClock()
		handler := &windowsServiceHandler{
			host:   &fakeWindowsServiceHost{returnBefore: true},
			timing: clock.timing(),
		}
		requests := make(chan svc.ChangeRequest)
		statuses := make(chan svc.Status, 1)
		result := make(chan serviceExecuteResult, 1)
		go func() {
			specific, code := handler.Execute(nil, requests, statuses)
			result <- serviceExecuteResult{specific: specific, code: code}
		}()
		expectServiceState(t, statuses, svc.StartPending)
		outcome := receiveServiceResult(t, result)
		if !outcome.specific || outcome.code != uint32(exitPreflight) {
			t.Fatalf("service outcome = %+v, want service-specific %d", outcome, exitPreflight)
		}
		expectSignal(t, clock.tickerStopped, "startup progress ticker stop after host result")
		expectSignal(t, clock.timerStopped, "startup timer stop after host result")
	})

	t.Run("startup", func(t *testing.T) {
		hostFailure := errors.New("startup failed")
		handler := &windowsServiceHandler{host: &fakeWindowsServiceHost{
			returnBefore: true,
			returnError:  hostFailure,
		}}
		requests := make(chan svc.ChangeRequest)
		statuses := make(chan svc.Status, 1)
		result := make(chan serviceExecuteResult, 1)
		go func() {
			specific, code := handler.Execute(nil, requests, statuses)
			result <- serviceExecuteResult{specific: specific, code: code}
		}()
		expectServiceState(t, statuses, svc.StartPending)
		outcome := receiveServiceResult(t, result)
		if !outcome.specific || outcome.code != uint32(exitPreflight) {
			t.Fatalf("service outcome = %+v, want service-specific %d", outcome, exitPreflight)
		}
	})

	t.Run("cleanup after stop", func(t *testing.T) {
		cleanupFailure := errors.New("cleanup failed")
		handler := &windowsServiceHandler{host: &fakeWindowsServiceHost{
			readyCalls:   1,
			cleanupError: cleanupFailure,
		}}
		requests := make(chan svc.ChangeRequest, 1)
		statuses := make(chan svc.Status, 3)
		result := make(chan serviceExecuteResult, 1)
		go func() {
			specific, code := handler.Execute(nil, requests, statuses)
			result <- serviceExecuteResult{specific: specific, code: code}
		}()
		expectServiceState(t, statuses, svc.StartPending)
		expectServiceState(t, statuses, svc.Running)
		requests <- svc.ChangeRequest{Cmd: svc.Stop}
		expectServiceState(t, statuses, svc.StopPending)
		outcome := receiveServiceResult(t, result)
		if !outcome.specific || outcome.code != uint32(exitPreflight) {
			t.Fatalf("service outcome = %+v, want service-specific %d", outcome, exitPreflight)
		}
	})
}

func expectServiceState(t *testing.T, statuses <-chan svc.Status, want svc.State) svc.Status {
	t.Helper()
	select {
	case status := <-statuses:
		if status.State != want {
			t.Fatalf("service state = %v, want %v", status.State, want)
		}
		return status
	case <-time.After(serviceTestTimeout):
		t.Fatalf("timed out waiting for service state %v", want)
		return svc.Status{}
	}
}

func expectSignal(t *testing.T, signal <-chan struct{}, label string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(serviceTestTimeout):
		t.Fatalf("timed out waiting for %s", label)
	}
}

func expectDuration(
	t *testing.T,
	values <-chan time.Duration,
	want time.Duration,
	label string,
) {
	t.Helper()
	select {
	case value := <-values:
		if value != want {
			t.Fatalf("%s = %v, want %v", label, value, want)
		}
	case <-time.After(serviceTestTimeout):
		t.Fatalf("timed out waiting for %s", label)
	}
}

func expectError(t *testing.T, values <-chan error, label string) error {
	t.Helper()
	select {
	case value := <-values:
		return value
	case <-time.After(serviceTestTimeout):
		t.Fatalf("timed out waiting for %s", label)
		return nil
	}
}

func assertNoSignal(t *testing.T, signal <-chan struct{}, label string) {
	t.Helper()
	select {
	case <-signal:
		t.Fatal(label)
	case <-time.After(50 * time.Millisecond):
	}
}

func receiveBootstrapOptions(
	t *testing.T,
	options <-chan platform.BootstrapOptions,
) platform.BootstrapOptions {
	t.Helper()
	select {
	case value := <-options:
		return value
	case <-time.After(serviceTestTimeout):
		t.Fatal("timed out waiting for host bootstrap options")
		return platform.BootstrapOptions{}
	}
}

func receiveServiceResult(
	t *testing.T,
	result <-chan serviceExecuteResult,
) serviceExecuteResult {
	t.Helper()
	select {
	case value := <-result:
		return value
	case <-time.After(serviceTestTimeout):
		t.Fatal("timed out waiting for service result")
		return serviceExecuteResult{}
	}
}
