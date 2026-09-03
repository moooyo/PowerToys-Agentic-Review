//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/platform"
	"golang.org/x/sys/windows/svc"
)

var errWindowsServiceStop = errors.New("Windows service stop requested")

const (
	serviceStartWaitHintMilliseconds uint32 = 30_000
	serviceStopWaitHintMilliseconds  uint32 = 300_000
)

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
	role, err := installverify.RoleFromBootstrapPath(path)
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

	ready := make(chan struct{}, 1)
	var readyOnce sync.Once
	var readySignaled atomic.Bool
	options := handler.options
	options.Ready = func() {
		readyOnce.Do(func() {
			readySignaled.Store(true)
			ready <- struct{}{}
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
	for {
		select {
		case <-ready:
			if stopRequested || current.State != svc.StartPending {
				continue
			}
			current = svc.Status{
				State:   svc.Running,
				Accepts: svc.AcceptStop | svc.AcceptShutdown,
			}
			statuses <- current
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
					current = svc.Status{
						State:      svc.StopPending,
						CheckPoint: 1,
						WaitHint:   serviceStopWaitHintMilliseconds,
					}
					statuses <- current
					cancel(errWindowsServiceStop)
				}
			}
		case err := <-result:
			if err == nil {
				if stopRequested || readySignaled.Load() {
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
