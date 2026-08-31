//go:build windows

package peerverify

import (
	"errors"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestWindowsAccessMasksMatchReviewedContract(t *testing.T) {
	if processOpenAccess != uint32(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE) {
		t.Fatalf("process access = 0x%x", processOpenAccess)
	}
	if tokenOpenAccess != uint32(windows.TOKEN_QUERY) {
		t.Fatalf("token access = 0x%x, want TOKEN_QUERY", tokenOpenAccess)
	}
	if serviceGroupMandatory != windows.SE_GROUP_MANDATORY ||
		serviceGroupDefault != windows.SE_GROUP_ENABLED_BY_DEFAULT ||
		serviceGroupEnabled != windows.SE_GROUP_ENABLED ||
		serviceGroupDenyOnly != windows.SE_GROUP_USE_FOR_DENY_ONLY ||
		serviceGroupLogonID != windows.SE_GROUP_LOGON_ID ||
		serviceGroupValid != windows.SE_GROUP_VALID_ATTRIBUTES {
		t.Fatal("token group attributes do not match Windows")
	}
	if privilegeEnabled != windows.SE_PRIVILEGE_ENABLED ||
		privilegeValidAttributes != windows.SE_PRIVILEGE_VALID_ATTRIBUTES {
		t.Fatal("token privilege attributes do not match Windows")
	}
}

func TestWindowsImageSnapshotLayoutsMatchFileInformationClasses(t *testing.T) {
	if unsafe.Sizeof(imageAttributeTagInfo{}) != imageAttributeTagInfoSize ||
		unsafe.Sizeof(imageFileIDInfo{}) != imageFileIDInfoSize ||
		unsafe.Sizeof(imageStandardInfo{}) != imageStandardInfoSize ||
		unsafe.Sizeof(imageBasicInfo{}) != imageBasicInfoSize {
		t.Fatal("image information structure layout changed")
	}
	if unsafe.Sizeof(nativeTokenStatistics{}) != tokenStatisticsSize ||
		unsafe.Offsetof(nativeTokenStatistics{}.ModifiedID) != 48 {
		t.Fatal("TOKEN_STATISTICS layout changed")
	}
}

func TestWindowsImplementationsSatisfyOpaqueContracts(t *testing.T) {
	var _ processOpener = windowsProcessOpener{}
	var _ PeerProcess = (*windowsStableProcess)(nil)
	var _ ImageSubject = (*windowsImageSubject)(nil)
}

func TestWindowsProcessCloseRetainsHandleForRetry(t *testing.T) {
	closeFailure := errors.New("close failed")
	attempts := 0
	process := &windowsStableProcess{
		handle: windows.Handle(123),
		closeHandle: func(handle windows.Handle) error {
			attempts++
			if handle != windows.Handle(123) {
				t.Fatalf("close handle = %d", handle)
			}
			if attempts == 1 {
				return closeFailure
			}
			return nil
		},
	}
	if err := process.Close(); !errors.Is(err, closeFailure) {
		t.Fatalf("first Close error = %v", err)
	}
	if process.handle != windows.Handle(123) {
		t.Fatal("failed Close discarded the process handle")
	}
	if err := process.Close(); err != nil {
		t.Fatalf("retry Close error = %v", err)
	}
	if process.handle != 0 || attempts != 2 {
		t.Fatalf("retry left handle %d after %d attempts", process.handle, attempts)
	}
}

func TestWindowsImageCloseRetainsHandleForRetry(t *testing.T) {
	closeFailure := errors.New("close failed")
	attempts := 0
	image := &windowsImageSubject{
		handle: windows.Handle(456),
		closeHandle: func(handle windows.Handle) error {
			attempts++
			if handle != windows.Handle(456) {
				t.Fatalf("close handle = %d", handle)
			}
			if attempts == 1 {
				return closeFailure
			}
			return nil
		},
	}
	if err := image.Close(); !errors.Is(err, closeFailure) {
		t.Fatalf("first Close error = %v", err)
	}
	if image.handle != windows.Handle(456) {
		t.Fatal("failed Close discarded the image handle")
	}
	if err := image.Close(); err != nil {
		t.Fatalf("retry Close error = %v", err)
	}
	if image.handle != 0 || attempts != 2 {
		t.Fatalf("retry left handle %d after %d attempts", image.handle, attempts)
	}
}
