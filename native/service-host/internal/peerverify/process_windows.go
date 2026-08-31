//go:build windows

package peerverify

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	processOpenAccess     = uint32(windows.PROCESS_QUERY_LIMITED_INFORMATION | windows.SYNCHRONIZE)
	tokenOpenAccess       = uint32(windows.TOKEN_QUERY)
	stillActiveCode       = uint32(259)
	processWaitPoll       = 100 * time.Millisecond
	initialImagePathUnits = uint32(512)
	maximumImagePathUnits = uint32(32_768)
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

func (p *windowsStableProcess) HandleCreationTime() (time.Time, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle == 0 {
		return time.Time{}, ErrClosed
	}
	var created windows.Filetime
	var exited windows.Filetime
	var kernel windows.Filetime
	var user windows.Filetime
	if err := windows.GetProcessTimes(p.handle, &created, &exited, &kernel, &user); err != nil {
		return time.Time{}, err
	}
	return time.Unix(0, created.Nanoseconds()).UTC(), nil
}

func (p *windowsStableProcess) HandleStartKey() (ProcessStartKey, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle == 0 {
		return ProcessStartKey{}, ErrClosed
	}
	var sequenceNumber uint64
	bufferSize := uint32(unsafe.Sizeof(sequenceNumber))
	err := windows.NtQueryInformationProcess(
		p.handle,
		windows.ProcessSequenceNumber,
		unsafe.Pointer(&sequenceNumber),
		bufferSize,
		nil,
	)
	if errors.Is(err, windows.STATUS_INVALID_INFO_CLASS) || errors.Is(err, windows.STATUS_NOT_SUPPORTED) {
		return ProcessStartKey{}, nil
	}
	if err != nil {
		return ProcessStartKey{}, err
	}
	if sequenceNumber == 0 {
		return ProcessStartKey{}, errors.New("ProcessSequenceNumber returned zero")
	}
	return ProcessStartKey{Available: true, SequenceNumber: sequenceNumber}, nil
}

func (p *windowsStableProcess) DirectParentProcessID() (uint32, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle == 0 {
		return 0, ErrClosed
	}
	information := windows.PROCESS_BASIC_INFORMATION{}
	informationSize := uint32(unsafe.Sizeof(information))
	var returnedSize uint32
	if err := windows.NtQueryInformationProcess(
		p.handle,
		windows.ProcessBasicInformation,
		unsafe.Pointer(&information),
		informationSize,
		&returnedSize,
	); err != nil {
		return 0, err
	}
	if returnedSize != informationSize {
		return 0, fmt.Errorf("NtQueryInformationProcess returned %d bytes, expected %d", returnedSize, informationSize)
	}
	parent := information.InheritedFromUniqueProcessId
	if parent == 0 || uint64(parent) > uint64(^uint32(0)) {
		return 0, fmt.Errorf("NtQueryInformationProcess returned invalid parent PID %d", parent)
	}
	return uint32(parent), nil
}

func (p *windowsStableProcess) ImagePathDiagnostic() (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle == 0 {
		return "", ErrClosed
	}
	return queryWindowsProcessImagePath(p.handle)
}

func queryWindowsProcessImagePath(handle windows.Handle) (string, error) {
	for units := initialImagePathUnits; units <= maximumImagePathUnits; units *= 2 {
		buffer := make([]uint16, units)
		length := units
		err := windows.QueryFullProcessImageName(handle, 0, &buffer[0], &length)
		if err == nil {
			if length == 0 || length >= units {
				return "", fmt.Errorf("QueryFullProcessImageNameW returned invalid length %d", length)
			}
			return windows.UTF16ToString(buffer[:length]), nil
		}
		if !errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) {
			return "", err
		}
		if units > maximumImagePathUnits/2 {
			break
		}
	}
	return "", fmt.Errorf("QueryFullProcessImageNameW exceeded %d UTF-16 units", maximumImagePathUnits)
}

func (p *windowsStableProcess) OpenImage() (ImageSubject, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle == 0 {
		return nil, ErrClosed
	}
	path, err := queryWindowsProcessImagePath(p.handle)
	if err != nil {
		return nil, err
	}
	return openWindowsImage(path)
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
		closeErr := closeDiscardedResource("close TOKEN_QUERY peer token", token, token.Close)
		err = errors.Join(err, closeErr)
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
