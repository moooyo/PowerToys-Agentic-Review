//go:build windows

package peerverify

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"golang.org/x/sys/windows"
)

const (
	processOpenAccess = uint32(windows.PROCESS_QUERY_LIMITED_INFORMATION | windows.SYNCHRONIZE)
	tokenOpenAccess   = uint32(windows.TOKEN_QUERY)
	stillActiveCode   = uint32(259)
	processWaitPoll   = 100 * time.Millisecond
)

type windowsProcessOpener struct{}

func (windowsProcessOpener) OpenProcess(processID uint32) (PeerProcess, error) {
	handle, err := windows.OpenProcess(processOpenAccess, false, processID)
	if err != nil {
		return nil, err
	}
	if handle == 0 {
		return nil, errors.New("OpenProcess returned a null handle")
	}
	return &windowsStableProcess{handle: handle}, nil
}

type windowsStableProcess struct {
	mu          sync.Mutex
	handle      windows.Handle
	closeHandle func(windows.Handle) error
	closeErr    error
}

func (p *windowsStableProcess) HandleProcessID() (uint32, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle == 0 {
		return 0, ErrClosed
	}
	return windows.GetProcessId(p.handle)
}

func (p *windowsStableProcess) StillActive() (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle == 0 {
		return false, ErrClosed
	}
	return windowsProcessStillActive(p.handle)
}

func windowsProcessStillActive(handle windows.Handle) (bool, error) {
	status, err := windows.WaitForSingleObject(handle, 0)
	if err != nil {
		return false, err
	}
	switch status {
	case windows.WAIT_OBJECT_0:
		return false, nil
	case uint32(windows.WAIT_TIMEOUT):
		var exitCode uint32
		if err := windows.GetExitCodeProcess(handle, &exitCode); err != nil {
			return false, err
		}
		return exitCode == stillActiveCode, nil
	default:
		return false, fmt.Errorf("unexpected process wait status 0x%x", status)
	}
}

func (p *windowsStableProcess) TokenSnapshot() (snapshot TokenSnapshot, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle == 0 {
		return TokenSnapshot{}, ErrClosed
	}
	var token windows.Token
	if err := windows.OpenProcessToken(p.handle, tokenOpenAccess, &token); err != nil {
		return TokenSnapshot{}, err
	}
	defer func() {
		err = errors.Join(err, closeDiscardedResource("close TOKEN_QUERY peer token", token, token.Close))
	}()
	return queryWindowsTokenSnapshot(token)
}

func (p *windowsStableProcess) Wait(ctx context.Context) error {
	if ctx == nil {
		return errors.New("process wait context is required")
	}
	for {
		p.mu.Lock()
		if p.handle == 0 {
			p.mu.Unlock()
			return ErrClosed
		}
		status, err := windows.WaitForSingleObject(p.handle, uint32(processWaitPoll/time.Millisecond))
		p.mu.Unlock()
		if err != nil {
			return err
		}
		switch status {
		case windows.WAIT_OBJECT_0:
			return nil
		case uint32(windows.WAIT_TIMEOUT):
			if err := ctx.Err(); err != nil {
				return err
			}
		default:
			return fmt.Errorf("unexpected process wait status 0x%x", status)
		}
	}
}

func (p *windowsStableProcess) Close() error {
	if p == nil {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle == 0 {
		return nil
	}
	if errors.Is(p.closeErr, ErrNativeHandleOwnershipFatal) {
		return p.closeErr
	}
	handle := p.handle
	closeHandle := p.closeHandle
	if closeHandle == nil {
		closeHandle = windows.CloseHandle
	}
	if err := closeHandle(handle); err != nil {
		p.closeErr = fmt.Errorf("CloseHandle process: %w", err)
		if errors.Is(err, windows.ERROR_INVALID_HANDLE) {
			p.closeErr = errors.Join(ErrNativeHandleOwnershipFatal, p.closeErr)
		}
		return p.closeErr
	}
	p.handle = 0
	p.closeErr = nil
	return nil
}

var _ PeerProcess = (*windowsStableProcess)(nil)
