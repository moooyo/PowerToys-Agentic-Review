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
// service wrapper using only SCM status and limited process-query rights. A
// A rejected raw handle is consumed once; unresolved ownership is quarantined
// until ServiceHost exits and is never returned as a retryable numeric handle.
func OpenWrapperWatcher(serviceName string) (watcher WrapperWatcher, err error) {
	if serviceName == "" || strings.ContainsRune(serviceName, '\x00') {
		return nil, errors.New("WinSW service name must be non-empty and contain no NUL")
	}
	serviceNameUTF16, err := windows.UTF16PtrFromString(serviceName)
	if err != nil {
		return nil, fmt.Errorf("encode WinSW service name: %w", err)
	}

	manager, openManagerErr := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err := validateOpenedWrapperHandle("Service Control Manager", manager, openManagerErr); err != nil {
		return nil, fmt.Errorf("open local Service Control Manager: %w", err)
	}
	service, openServiceErr := windows.OpenService(manager, serviceNameUTF16, windows.SERVICE_QUERY_STATUS)
	if err := validateOpenedWrapperHandle("WinSW service status", service, openServiceErr); err != nil {
		return nil, errors.Join(
			fmt.Errorf("open WinSW service for status query: %w", err),
			closeServiceHandle(manager, "close rejected Service Control Manager handle"),
		)
	}

	statusSource := &scmServiceStatusSource{service: &service}
	watcher, openErr := openStableWrapper(
		statusSource,
		windowsWrapperProcessOpener{},
	)
	closeErr := errors.Join(
		closeServiceHandle(service, "close WinSW service status handle"),
		closeServiceHandle(manager, "close Service Control Manager handle"),
	)
	if openErr != nil {
		return watcher, errors.Join(openErr, closeErr)
	}
	if closeErr != nil {
		_, watcherCloseErr := closeRejectedWrapper(watcher)
		return nil, errors.Join(closeErr, watcherCloseErr)
	}
	return watcher, nil
}

type scmServiceStatusSource struct {
	mu         sync.Mutex
	service    *windows.Handle
	poisonedBy error
}

func (s *scmServiceStatusSource) Status() (serviceProcessStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.poisonedBy != nil {
		return serviceProcessStatus{}, s.poisonedBy
	}
	if s.service == nil || *s.service == 0 {
		return serviceProcessStatus{}, errors.New("WinSW service status handle is closed")
	}
	service := *s.service
	status := windows.SERVICE_STATUS_PROCESS{}
	var bytesNeeded uint32
	if err := windows.QueryServiceStatusEx(
		service,
		windows.SC_STATUS_PROCESS_INFO,
		(*byte)(unsafe.Pointer(&status)),
		uint32(unsafe.Sizeof(status)),
		&bytesNeeded,
	); err != nil {
		if errors.Is(err, windows.ERROR_INVALID_HANDLE) {
			*s.service = 0
			s.poisonedBy = windowsProcessLifetimeQuarantine.retain(
				&windowsRawHandleOwner{kind: "WinSW service status handle", value: service},
				fmt.Errorf("query WinSW service status: %w", err),
			)
			return serviceProcessStatus{}, s.poisonedBy
		}
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
	if err := validateOpenedWrapperHandle("WinSW wrapper process", process, err); err != nil {
		return nil, err
	}
	return &windowsWrapperProcess{
		process:    process,
		quarantine: windowsProcessLifetimeQuarantine,
	}, nil
}

type windowsWrapperProcess struct {
	mu          sync.Mutex
	process     windows.Handle
	poisonedBy  error
	quarantine  *processLifetimeQuarantine
	closeHandle func(windows.Handle) error
}

func (p *windowsWrapperProcess) QueryProcessID() (uint32, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.poisonedBy != nil {
		return 0, p.poisonedBy
	}
	if p.process == 0 {
		return 0, errors.New("retained WinSW wrapper process handle is closed")
	}
	processID, err := windows.GetProcessId(p.process)
	return processID, p.poisonInvalidHandleLocked("read retained WinSW wrapper process ID", err)
}

func (p *windowsWrapperProcess) StillActive() (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.poisonedBy != nil {
		return false, p.poisonedBy
	}
	if p.process == 0 {
		return false, errors.New("retained WinSW wrapper process handle is closed")
	}
	status, err := windows.WaitForSingleObject(p.process, 0)
	if err != nil {
		return false, p.poisonInvalidHandleLocked("poll retained WinSW wrapper process", err)
	}
	switch status {
	case windows.WAIT_OBJECT_0:
		return false, nil
	case uint32(windows.WAIT_TIMEOUT):
		var exitCode uint32
		if err := windows.GetExitCodeProcess(p.process, &exitCode); err != nil {
			return false, p.poisonInvalidHandleLocked("query retained WinSW wrapper exit code", err)
		}
		return exitCode == stillActiveExitCode, nil
	default:
		return false, fmt.Errorf("unexpected wrapper process poll status 0x%x", status)
	}
}

func (p *windowsWrapperProcess) QueryCreationTime() (time.Time, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.poisonedBy != nil {
		return time.Time{}, p.poisonedBy
	}
	if p.process == 0 {
		return time.Time{}, errors.New("retained WinSW wrapper process handle is closed")
	}
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
		return time.Time{}, p.poisonInvalidHandleLocked("query retained WinSW wrapper creation time", err)
	}
	return time.Unix(0, creationTime.Nanoseconds()).UTC(), nil
}

func (p *windowsWrapperProcess) Wait(ctx context.Context) error {
	if ctx == nil {
		return errors.New("wrapper wait context is required")
	}
	for {
		p.mu.Lock()
		if p.poisonedBy != nil {
			err := p.poisonedBy
			p.mu.Unlock()
			return err
		}
		if p.process == 0 {
			p.mu.Unlock()
			return errors.New("retained WinSW wrapper process handle is closed")
		}
		status, err := windows.WaitForSingleObject(p.process, uint32(wrapperWaitPoll/time.Millisecond))
		if err != nil {
			err = p.poisonInvalidHandleLocked("wait for retained WinSW wrapper process", err)
		}
		p.mu.Unlock()
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
	if p == nil {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.poisonedBy != nil {
		return p.poisonedBy
	}
	if p.process == 0 {
		return nil
	}
	closeHandle := p.closeHandle
	if closeHandle == nil {
		closeHandle = windows.CloseHandle
	}
	handle := p.process
	p.process = 0
	err := consumeWindowsHandle(
		"close retained WinSW wrapper process handle",
		handle,
		closeHandle,
		p.lifetimeQuarantine(),
	)
	if err != nil {
		p.poisonedBy = err
	}
	return err
}

func closeServiceHandle(handle windows.Handle, operation string) error {
	return consumeWindowsHandle(
		operation,
		handle,
		windows.CloseServiceHandle,
		windowsProcessLifetimeQuarantine,
	)
}

func validateOpenedWrapperHandle(label string, handle windows.Handle, openErr error) error {
	if openErr != nil {
		if handle != 0 && handle != windows.InvalidHandle {
			return errors.Join(
				openErr,
				windowsProcessLifetimeQuarantine.retain(
					&windowsRawHandleOwner{kind: "untrusted " + label + " output", value: handle},
					fmt.Errorf("%s returned a handle together with an error", label),
				),
			)
		}
		return openErr
	}
	if handle == 0 {
		return fmt.Errorf("%s returned a null handle", label)
	}
	if handle == windows.InvalidHandle {
		return windowsProcessLifetimeQuarantine.retain(
			&windowsRawHandleOwner{kind: label, value: handle},
			fmt.Errorf("%s: %w", label, windows.ERROR_INVALID_HANDLE),
		)
	}
	return nil
}

func (p *windowsWrapperProcess) lifetimeQuarantine() *processLifetimeQuarantine {
	if p.quarantine != nil {
		return p.quarantine
	}
	return windowsProcessLifetimeQuarantine
}

func (p *windowsWrapperProcess) poisonInvalidHandleLocked(operation string, err error) error {
	if err == nil || !errors.Is(err, windows.ERROR_INVALID_HANDLE) {
		return err
	}
	handle := p.process
	p.process = 0
	p.poisonedBy = p.lifetimeQuarantine().retain(
		&windowsRawHandleOwner{kind: "retained WinSW wrapper process handle", value: handle},
		fmt.Errorf("%s: %w", operation, err),
	)
	return p.poisonedBy
}
