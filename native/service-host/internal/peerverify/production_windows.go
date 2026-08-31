//go:build windows

package peerverify

import (
	"errors"
	"fmt"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	scmManagerOpenAccess = uint32(windows.SC_MANAGER_CONNECT)
	scmServiceOpenAccess = uint32(windows.SERVICE_QUERY_STATUS)
)

// VerifyWindows opens and retains the opposing service's WinSW wrapper from a
// stable SCM observation, then verifies the named-pipe peer that is its direct
// ServiceHost child. Native process and verifier implementations are fixed by
// this package and cannot be supplied by the caller.
func VerifyWindows(options Options) (*Session, error) {
	return verifyWindowsWithPlatform(
		windowsVerificationOptions{
			Role:                                   options.Role,
			PipeObserver:                           options.PipeEndpoint,
			WrapperImage:                           options.WrapperImage,
			ServiceHostImage:                       options.ServiceHostImage,
			ExpectedLeafSignerCertificateDERSHA256: options.ExpectedLeafSignerCertificateDERSHA256,
		},
		windowsVerificationPlatformImpl{},
	)
}

type windowsVerificationPlatformImpl struct{}

func (windowsVerificationPlatformImpl) OpenPeerService(name string) (serviceStatusSource, error) {
	namePointer, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, fmt.Errorf("encode peer WinSW service name: %w", err)
	}
	manager, err := windows.OpenSCManager(nil, nil, scmManagerOpenAccess)
	if err != nil {
		return nil, fmt.Errorf("OpenSCManagerW for peer WinSW service: %w", err)
	}
	result := &windowsServiceStatusSource{manager: manager}
	service, err := windows.OpenService(manager, namePointer, scmServiceOpenAccess)
	if err != nil {
		return result, fmt.Errorf("OpenServiceW for peer WinSW service %q: %w", name, err)
	}
	result.service = service
	return result, nil
}

func (windowsVerificationPlatformImpl) OpenProcess(processID uint32) (PeerProcess, error) {
	return (windowsProcessOpener{}).OpenProcess(processID)
}

func (windowsVerificationPlatformImpl) NewAuthenticodeVerifier() (AuthenticodeVerifier, error) {
	return NewWindowsAuthenticodeVerifier()
}

type windowsServiceStatusSource struct {
	mu          sync.Mutex
	manager     windows.Handle
	service     windows.Handle
	closeHandle func(windows.Handle) error
}

func (source *windowsServiceStatusSource) Status() (serviceObservation, error) {
	if source == nil {
		return serviceObservation{}, ErrClosed
	}
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.service == 0 {
		return serviceObservation{}, ErrClosed
	}
	status := windows.SERVICE_STATUS_PROCESS{}
	var bytesNeeded uint32
	if err := windows.QueryServiceStatusEx(
		source.service,
		windows.SC_STATUS_PROCESS_INFO,
		(*byte)(unsafe.Pointer(&status)),
		uint32(unsafe.Sizeof(status)),
		&bytesNeeded,
	); err != nil {
		return serviceObservation{}, err
	}
	return serviceObservation{state: status.CurrentState, processID: status.ProcessId}, nil
}

func (source *windowsServiceStatusSource) Close() error {
	if source == nil {
		return nil
	}
	source.mu.Lock()
	defer source.mu.Unlock()
	closeHandle := source.closeHandle
	if closeHandle == nil {
		closeHandle = windows.CloseServiceHandle
	}
	var serviceErr error
	if source.service != 0 {
		if err := closeHandle(source.service); err != nil {
			serviceErr = fmt.Errorf("close peer WinSW service query handle: %w", err)
		} else {
			source.service = 0
		}
	}
	var managerErr error
	if source.manager != 0 {
		if err := closeHandle(source.manager); err != nil {
			managerErr = fmt.Errorf("close peer Service Control Manager handle: %w", err)
		} else {
			source.manager = 0
		}
	}
	return errors.Join(serviceErr, managerErr)
}

var (
	_ windowsVerificationPlatform = windowsVerificationPlatformImpl{}
	_ serviceStatusSource         = (*windowsServiceStatusSource)(nil)
)
