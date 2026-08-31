//go:build windows

package servicebootstrap

import (
	"errors"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peerverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winprocess"
	"golang.org/x/sys/windows"
)

func TestWindowsConstantsMatchBootstrapContract(t *testing.T) {
	wantWrapperOpenAccess := uint32(
		windows.PROCESS_QUERY_LIMITED_INFORMATION |
			windows.SYNCHRONIZE |
			windows.READ_CONTROL |
			windows.WRITE_DAC,
	)
	if wrapperProcessOpenAccess != wantWrapperOpenAccess {
		t.Fatalf("wrapper open access = 0x%x, want 0x%x", wrapperProcessOpenAccess, wantWrapperOpenAccess)
	}
	wantTokenOpenAccess := uint32(windows.TOKEN_QUERY | windows.READ_CONTROL | windows.WRITE_DAC)
	if currentTokenOpenAccess != wantTokenOpenAccess {
		t.Fatalf("token open access = 0x%x, want 0x%x", currentTokenOpenAccess, wantTokenOpenAccess)
	}
	if processQueryLimitedAccessMask != uint32(windows.PROCESS_QUERY_LIMITED_INFORMATION) ||
		synchronizeAccessMask != uint32(windows.SYNCHRONIZE) ||
		tokenQueryAccessMask != uint32(windows.TOKEN_QUERY) {
		t.Fatal("detached DACL access constants do not match Windows")
	}
	if genericAllAccessMask != uint32(windows.GENERIC_ALL) {
		t.Fatal("generic-all DACL access does not match Windows")
	}
	if securityDescriptorDACLPresent != uint16(windows.SE_DACL_PRESENT) ||
		securityDescriptorDACLProtected != uint16(windows.SE_DACL_PROTECTED) {
		t.Fatal("security descriptor control constants do not match Windows")
	}
	if accessAllowedACEType != windows.ACCESS_ALLOWED_ACE_TYPE {
		t.Fatal("access-allowed ACE type does not match Windows")
	}
}

func TestWindowsBootstrapImplementsBothStableWrapperContracts(t *testing.T) {
	var _ Session = (*bootstrapSession)(nil)
	var _ winprocess.WrapperWatcher = (*bootstrapSession)(nil)
	var _ peerverify.StableWrapper = (*bootstrapSession)(nil)
}

func TestWindowsBootstrapWrapperCloseRetainsHandleAfterFailure(t *testing.T) {
	closeFailure := errors.New("injected CloseHandle failure")
	closeCalls := 0
	process := &windowsWrapperProcess{
		handle: windows.Handle(456),
		closeHandle: func(handle windows.Handle) error {
			closeCalls++
			if handle != windows.Handle(456) {
				t.Fatalf("close handle = %d, want 456", handle)
			}
			if closeCalls == 1 {
				return closeFailure
			}
			return nil
		},
	}
	if err := process.Close(); !errors.Is(err, closeFailure) {
		t.Fatalf("first Close error = %v", err)
	}
	if process.handle != windows.Handle(456) {
		t.Fatal("failed Close discarded the retained wrapper handle")
	}
	if err := process.Close(); err != nil {
		t.Fatalf("retry Close error = %v", err)
	}
	if process.handle != 0 || closeCalls != 2 {
		t.Fatalf("process handle = %d, close calls = %d", process.handle, closeCalls)
	}
}

func TestWindowsPrimaryTokenCloseRetainsHandleAfterFailure(t *testing.T) {
	closeFailure := errors.New("injected token CloseHandle failure")
	closeCalls := 0
	token := &windowsPrimaryToken{
		handle: windows.Handle(789),
		closeHandle: func(windows.Handle) error {
			closeCalls++
			if closeCalls == 1 {
				return closeFailure
			}
			return nil
		},
	}
	if err := token.Close(); !errors.Is(err, closeFailure) {
		t.Fatalf("first Close error = %v", err)
	}
	if token.handle != windows.Handle(789) {
		t.Fatal("failed Close discarded the token handle")
	}
	if err := token.Close(); err != nil {
		t.Fatal(err)
	}
	if token.handle != 0 || closeCalls != 2 {
		t.Fatalf("token handle = %d, close calls = %d", token.handle, closeCalls)
	}
}
