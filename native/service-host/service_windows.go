//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/platform"
	"golang.org/x/sys/windows/svc"
)

var (
	errWindowsServiceStop           = errors.New("Windows service stop requested")
	errWindowsServiceStartupTimeout = errors.New("Windows service startup timed out")
)

const (
	servicePendingUpdateInterval            = 10 * time.Second
	serviceStartupLimit                     = 5 * time.Minute
	serviceStartWaitHintMilliseconds uint32 = uint32(serviceStartupLimit / time.Millisecond)
	serviceStopWaitHintMilliseconds  uint32 = 300_000
)

type serviceTimeSignal struct {
	channel <-chan time.Time
	stop    func()
}

type windowsServiceTiming struct {
	newTicker func(time.Duration) serviceTimeSignal
	newTimer  func(time.Duration) serviceTimeSignal
}

func productionWindowsServiceTiming() windowsServiceTiming {
	return windowsServiceTiming{
		newTicker: func(interval time.Duration) serviceTimeSignal {
			ticker := time.NewTicker(interval)
			return serviceTimeSignal{channel: ticker.C, stop: ticker.Stop}
		},
		newTimer: func(interval time.Duration) serviceTimeSignal {
			timer := time.NewTimer(interval)
			return serviceTimeSignal{
				channel: timer.C,
				stop: func() {
					if timer.Stop() {
						return
					}
					select {
					case <-timer.C:
					default:
					}
				},
			}
		},
	}
}

func (timing windowsServiceTiming) withDefaults() windowsServiceTiming {
	production := productionWindowsServiceTiming()
	if timing.newTicker == nil {
		timing.newTicker = production.newTicker
	}
	if timing.newTimer == nil {
		timing.newTimer = production.newTimer
	}
	return timing
}

type windowsServiceRunner struct {
	isWindowsService func() (bool, error)
	runService       func(string, svc.Handler) error
}

func newServiceRunner() serviceRunner {
	return windowsServiceRunner{
		isWindowsService: svc.IsWindowsService,
		runService:       svc.Run,
	}
}

func (runner windowsServiceRunner) RunIfService(
	command commandLine,
	host platform.Host,
) (bool, error) {
	isService, err := runner.isWindowsService()
	if err != nil {
		return true, fmt.Errorf("detect Windows service process: %w", err)
	}
	if !isService {
		return false, nil
	}
	serviceName, err := serviceNameFromBootstrapPath(command.configPath)
	if err != nil {
		return true, err
	}
	if runner.runService == nil {
		return true, errors.New("Windows service runner is unavailable")
	}
	return true, runner.runService(serviceName, &windowsServiceHandler{
		host: host,
		options: platform.BootstrapOptions{
			ActualBootstrapPath: command.configPath,
		},
	})
}

func serviceNameFromBootstrapPath(path string) (string, error) {
	role, err := config.RoleFromTrustedBootstrapPath(path)
	if err != nil {
		return "", fmt.Errorf("derive Windows service name from bootstrap path: %w", err)
	}
	switch role {
	case config.RoleControl:
		return config.ControlServiceName, nil
	case config.RoleExecutor:
		return config.ExecutorServiceName, nil
	default:
		return "", errors.New("bootstrap path selected an unsupported Windows service role")
	}
}

type windowsServiceHandler struct {
	host    platform.Host
	options platform.BootstrapOptions
	timing  windowsServiceTiming
}

// Execute ignores dynamic StartService arguments because the process command
// line has already selected the fixed bootstrap path and service identity.
func (handler *windowsServiceHandler) Execute(
	_ []string,
	requests <-chan svc.ChangeRequest,
	statuses chan<- svc.Status,
) (bool, uint32) {
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	timing := handler.timing.withDefaults()

	var pendingTicks <-chan time.Time
	var stopPendingTicks func()
	stopPendingProgress := func() {
		pendingTicks = nil
		if stopPendingTicks != nil {
			stopPendingTicks()
			stopPendingTicks = nil
		}
	}
	startPendingProgress := func() {
		stopPendingProgress()
		ticker := timing.newTicker(servicePendingUpdateInterval)
		pendingTicks = ticker.channel
		stopPendingTicks = ticker.stop
	}
	startPendingProgress()
	defer stopPendingProgress()

	startupTimer := timing.newTimer(serviceStartupLimit)
	startupTimeout := startupTimer.channel
	stopStartupTimer := func() {
		startupTimeout = nil
		if startupTimer.stop != nil {
			startupTimer.stop()
			startupTimer.stop = nil
		}
	}
	defer stopStartupTimer()

	readyRequests := make(chan chan struct{})
	var readyOnce sync.Once
	options := handler.options
	options.Ready = func() {
		readyOnce.Do(func() {
			acknowledged := make(chan struct{})
			readyRequests <- acknowledged
			<-acknowledged
		})
	}

	current := svc.Status{
		State:      svc.StartPending,
		CheckPoint: 1,
		WaitHint:   serviceStartWaitHintMilliseconds,
	}
	statuses <- current
	result := make(chan error, 1)
	go func() {
		result <- handler.host.Run(ctx, options)
	}()

	stopRequested := false
	startupTimedOut := false
	runningReported := false
	for {
		select {
		case acknowledged := <-readyRequests:
			if !stopRequested && current.State == svc.StartPending {
				stopStartupTimer()
				stopPendingProgress()
				current = svc.Status{
					State:   svc.Running,
					Accepts: svc.AcceptStop | svc.AcceptShutdown,
				}
				statuses <- current
				runningReported = true
			}
			close(acknowledged)
		case request, ok := <-requests:
			if !ok {
				requests = nil
				continue
			}
			switch request.Cmd {
			case svc.Interrogate:
				statuses <- current
			case svc.Stop, svc.Shutdown:
				if !stopRequested {
					stopRequested = true
					stopStartupTimer()
					startPendingProgress()
					current = svc.Status{
						State:      svc.StopPending,
						CheckPoint: 1,
						WaitHint:   serviceStopWaitHintMilliseconds,
					}
					statuses <- current
					cancel(errWindowsServiceStop)
				}
			}
		case <-pendingTicks:
			current.CheckPoint++
			statuses <- current
		case <-startupTimeout:
			startupTimedOut = true
			stopStartupTimer()
			startPendingProgress()
			current = svc.Status{
				State:      svc.StopPending,
				CheckPoint: 1,
				WaitHint:   serviceStopWaitHintMilliseconds,
			}
			statuses <- current
			cancel(errWindowsServiceStartupTimeout)
		case err := <-result:
			if startupTimedOut {
				return true, uint32(exitPreflight)
			}
			if err == nil {
				if stopRequested || runningReported {
					return false, 0
				}
				return true, uint32(exitPreflight)
			}
			if stopRequested && isCleanWindowsServiceStop(err) {
				return false, 0
			}
			return true, uint32(exitPreflight)
		}
	}
}

func isCleanWindowsServiceStop(err error) bool {
	if err == nil {
		return true
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		children := joined.Unwrap()
		if len(children) == 0 {
			return false
		}
		for _, child := range children {
			if !isCleanWindowsServiceStop(child) {
				return false
			}
		}
		return true
	}
	if wrapped := errors.Unwrap(err); wrapped != nil {
		return isCleanWindowsServiceStop(wrapped)
	}
	return err == errWindowsServiceStop || err == context.Canceled
}

var _ svc.Handler = (*windowsServiceHandler)(nil)
