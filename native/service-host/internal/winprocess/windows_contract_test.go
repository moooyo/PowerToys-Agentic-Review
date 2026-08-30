//go:build windows

package winprocess

import (
	"testing"

	"golang.org/x/sys/windows"
)

func TestWindowsConstantsMatchReviewedProcessContract(t *testing.T) {
	wantCreationFlags := uint32(
		windows.CREATE_SUSPENDED |
			windows.CREATE_UNICODE_ENVIRONMENT |
			windows.CREATE_NO_WINDOW |
			windows.EXTENDED_STARTUPINFO_PRESENT,
	)
	if requiredProcessCreationFlags != wantCreationFlags {
		t.Fatalf("creation flags = 0x%x, want 0x%x", requiredProcessCreationFlags, wantCreationFlags)
	}
	wantJobFlags := uint32(
		windows.JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
			windows.JOB_OBJECT_LIMIT_PROCESS_MEMORY |
			windows.JOB_OBJECT_LIMIT_JOB_MEMORY |
			windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
	)
	if rootJobRequiredLimitFlags != wantJobFlags {
		t.Fatalf("root Job flags = 0x%x, want 0x%x", rootJobRequiredLimitFlags, wantJobFlags)
	}
	wantForbidden := uint32(
		windows.JOB_OBJECT_LIMIT_BREAKAWAY_OK |
			windows.JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
	)
	if rootJobForbiddenLimitFlags != wantForbidden {
		t.Fatalf("forbidden root Job flags = 0x%x, want 0x%x", rootJobForbiddenLimitFlags, wantForbidden)
	}
	if genericAllAccessMask != uint32(windows.GENERIC_ALL) {
		t.Fatalf("generic-all mask = 0x%x, want 0x%x", genericAllAccessMask, windows.GENERIC_ALL)
	}
	if processQueryLimitedMask != windows.PROCESS_QUERY_LIMITED_INFORMATION {
		t.Fatalf("peer process mask = 0x%x, want PROCESS_QUERY_LIMITED_INFORMATION", processQueryLimitedMask)
	}
	if tokenQueryMask != windows.TOKEN_QUERY {
		t.Fatalf("peer token mask = 0x%x, want TOKEN_QUERY", tokenQueryMask)
	}
	if securityDescriptorDACLPresent != uint16(windows.SE_DACL_PRESENT) ||
		securityDescriptorDACLProtected != uint16(windows.SE_DACL_PROTECTED) {
		t.Fatal("security descriptor control constants do not match Windows")
	}
	if accessAllowedACEType != windows.ACCESS_ALLOWED_ACE_TYPE {
		t.Fatal("access-allowed ACE type does not match Windows")
	}
}

func TestWindowsImplementationsSatisfyStableInterfaces(t *testing.T) {
	var _ NodeProcess = (*windowsNodeProcess)(nil)
	var _ WrapperWatcher = (*stableWrapper)(nil)
	var _ wrapperProcessHandle = (*windowsWrapperProcess)(nil)
}
