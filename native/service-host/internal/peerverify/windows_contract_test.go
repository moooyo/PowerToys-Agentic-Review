//go:build windows

package peerverify

import (
	"errors"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestWindowsAccessMasksMatchReviewedContract(t *testing.T) {
	if scmManagerOpenAccess != uint32(windows.SC_MANAGER_CONNECT) ||
		scmServiceOpenAccess != uint32(windows.SERVICE_QUERY_STATUS) {
		t.Fatal("SCM access masks changed")
	}
	if processOpenAccess != uint32(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE) {
		t.Fatalf("process access = 0x%x", processOpenAccess)
	}
	if tokenOpenAccess != uint32(windows.TOKEN_QUERY) {
		t.Fatalf("token access = 0x%x", tokenOpenAccess)
	}
	if unsafe.Sizeof(nativeTokenStatistics{}) != tokenStatisticsSize ||
		unsafe.Offsetof(nativeTokenStatistics{}.ModifiedID) != 48 {
		t.Fatal("TOKEN_STATISTICS layout changed")
	}
}

func TestWindowsImplementationsSatisfyMinimalContracts(t *testing.T) {
	var _ processOpener = windowsProcessOpener{}
	var _ windowsVerificationPlatform = windowsVerificationPlatformImpl{}
	var _ serviceStatusSource = (*windowsServiceStatusSource)(nil)
	var _ PeerProcess = (*windowsStableProcess)(nil)
}

func TestWindowsSCMCloseRetainsOnlyFailedHandlesForRetry(t *testing.T) {
	closeFailure := errors.New("close failed")
	serviceHandle := windows.Handle(123)
	managerHandle := windows.Handle(456)
	attempts := map[windows.Handle]int{}
	source := &windowsServiceStatusSource{
		service: serviceHandle,
		manager: managerHandle,
		closeHandle: func(handle windows.Handle) error {
			attempts[handle]++
			if handle == serviceHandle && attempts[handle] == 1 {
				return closeFailure
			}
			return nil
		},
	}
	if err := source.Close(); !errors.Is(err, closeFailure) {
		t.Fatalf("first Close error = %v", err)
	}
	if source.service != serviceHandle || source.manager != 0 {
		t.Fatalf("handles after failed Close = %d/%d", source.service, source.manager)
	}
	if err := source.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsProcessCloseRetainsHandleForRetry(t *testing.T) {
	closeFailure := errors.New("close failed")
	attempts := 0
	process := &windowsStableProcess{
		handle: windows.Handle(123),
		closeHandle: func(windows.Handle) error {
			attempts++
			if attempts == 1 {
				return closeFailure
			}
			return nil
		},
	}
	if err := process.Close(); !errors.Is(err, closeFailure) {
		t.Fatalf("first Close error = %v", err)
	}
	if err := process.Close(); err != nil {
		t.Fatal(err)
	}
	if process.handle != 0 || attempts != 2 {
		t.Fatalf("handle = %d, attempts = %d", process.handle, attempts)
	}
}
