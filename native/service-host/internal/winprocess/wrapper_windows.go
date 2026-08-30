//go:build windows

package winprocess

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	stillActiveExitCode uint32 = 259
	wrapperWaitPoll            = 100 * time.Millisecond
)

// OpenWrapperWatcher opens and verifies a stable handle to a local WinSW
// service wrapper using only SCM status and limited process-query rights.
func OpenWrapperWatcher(serviceName string) (watcher WrapperWatcher, err error) {
	if serviceName == "" || strings.ContainsRune(serviceName, '\x00') {
		return nil, errors.New("WinSW service name must be non-empty and contain no NUL")
	}
	serviceNameUTF16, err := windows.UTF16PtrFromString(serviceName)
	if err != nil {
		return nil, fmt.Errorf("encode WinSW service name: %w", err)
	}

	manager, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return nil, fmt.Errorf("open local Service Control Manager: %w", err)
	}
	service, err := windows.OpenService(manager, serviceNameUTF16, windows.SERVICE_QUERY_STATUS)
	if err != nil {
		_ = windows.CloseServiceHandle(manager)
		return nil, fmt.Errorf("open WinSW service for status query: %w", err)
	}

	watcher, openErr := openStableWrapper(
		scmServiceStatusSource{service: service},
		windowsWrapperProcessOpener{},
	)
	closeErr := errors.Join(
		closeServiceHandle(service, "close WinSW service status handle"),
		closeServiceHandle(manager, "close Service Control Manager handle"),
	)
	if openErr != nil || closeErr != nil {
		if watcher != nil {
			_ = watcher.Close()
		}
		return nil, errors.Join(openErr, closeErr)
	}
	return watcher, nil
}

type scmServiceStatusSource struct {
	service windows.Handle
}

func (s scmServiceStatusSource) Status() (serviceProcessStatus, error) {
	status := windows.SERVICE_STATUS_PROCESS{}
	var bytesNeeded uint32
	if err := windows.QueryServiceStatusEx(
		s.service,
		windows.SC_STATUS_PROCESS_INFO,
		(*byte)(unsafe.Pointer(&status)),
		uint32(unsafe.Sizeof(status)),
		&bytesNeeded,
	); err != nil {
		return serviceProcessStatus{}, err
	}
	return serviceProcessStatus{
		state:     serviceState(status.CurrentState),
		processID: status.ProcessId,
	}, nil
}

type windowsWrapperProcessOpener struct{}

func (windowsWrapperProcessOpener) Open(processID uint32) (wrapperProcessHandle, error) {
	process, err := windows.OpenProcess(
		windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE,
		false,
		processID,
	)
	if err != nil {
		return nil, err
	}
	return &windowsWrapperProcess{process: process}, nil
}

type windowsWrapperProcess struct {
	process   windows.Handle
	closeOnce sync.Once
	closeErr  error
}

func (p *windowsWrapperProcess) QueryProcessID() (uint32, error) {
	return windows.GetProcessId(p.process)
}

func (p *windowsWrapperProcess) StillActive() (bool, error) {
	status, err := windows.WaitForSingleObject(p.process, 0)
	if err != nil {
		return false, err
	}
	switch status {
	case windows.WAIT_OBJECT_0:
		return false, nil
	case uint32(windows.WAIT_TIMEOUT):
		var exitCode uint32
		if err := windows.GetExitCodeProcess(p.process, &exitCode); err != nil {
			return false, err
		}
		return exitCode == stillActiveExitCode, nil
	default:
		return false, fmt.Errorf("unexpected wrapper process poll status 0x%x", status)
	}
}

func (p *windowsWrapperProcess) QueryCreationTime() (time.Time, error) {
	var creationTime windows.Filetime
	var exitTime windows.Filetime
	var kernelTime windows.Filetime
	var userTime windows.Filetime
	if err := windows.GetProcessTimes(
		p.process,
		&creationTime,
		&exitTime,
		&kernelTime,
		&userTime,
	); err != nil {
		return time.Time{}, err
	}
	return time.Unix(0, creationTime.Nanoseconds()).UTC(), nil
}

func (p *windowsWrapperProcess) Wait(ctx context.Context) error {
	if ctx == nil {
		return errors.New("wrapper wait context is required")
	}
	for {
		status, err := windows.WaitForSingleObject(p.process, uint32(wrapperWaitPoll/time.Millisecond))
		if err != nil {
			return fmt.Errorf("wait for WinSW wrapper process: %w", err)
		}
		switch status {
		case windows.WAIT_OBJECT_0:
			return nil
		case uint32(windows.WAIT_TIMEOUT):
			if err := ctx.Err(); err != nil {
				return err
			}
			continue
		default:
			return fmt.Errorf("unexpected WinSW wrapper wait status 0x%x", status)
		}
	}
}

func (p *windowsWrapperProcess) Close() error {
	p.closeOnce.Do(func() {
		p.closeErr = closeHandle(p.process, "close retained WinSW wrapper process handle")
		p.process = 0
	})
	return p.closeErr
}

func closeServiceHandle(handle windows.Handle, operation string) error {
	if handle == 0 {
		return nil
	}
	if err := windows.CloseServiceHandle(handle); err != nil {
		return fmt.Errorf("%s: %w", operation, err)
	}
	return nil
}
