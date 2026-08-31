//go:build windows

package winprocess

import (
	"errors"
	"strings"
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
	if standardIOPipeAccessInbound != windows.PIPE_ACCESS_INBOUND ||
		standardIOPipeAccessOutbound != windows.PIPE_ACCESS_OUTBOUND ||
		standardIOFileFlagOverlapped != windows.FILE_FLAG_OVERLAPPED ||
		standardIOFirstPipeInstance != windows.FILE_FLAG_FIRST_PIPE_INSTANCE ||
		standardIORejectRemoteClients != windows.PIPE_REJECT_REMOTE_CLIENTS {
		t.Fatal("standard-I/O named-pipe constants do not match Windows")
	}
	if standardIOPipeTypeByte != windows.PIPE_TYPE_BYTE ||
		standardIOPipeReadModeByte != windows.PIPE_READMODE_BYTE ||
		standardIOPipeWait != windows.PIPE_WAIT {
		t.Fatal("standard-I/O named pipe is not byte-mode blocking mode")
	}
	if standardIOFileGenericRead != windows.FILE_GENERIC_READ ||
		standardIOFileGenericWrite != windows.FILE_GENERIC_WRITE {
		t.Fatal("standard-I/O pipe access masks do not match Windows")
	}
	wantFileAllAccess := uint32(windows.STANDARD_RIGHTS_REQUIRED | windows.SYNCHRONIZE | 0x000001FF)
	if standardIOFileAllAccess != wantFileAllAccess {
		t.Fatal("standard-I/O full-control mask does not match Windows")
	}
	if standardIOChildOpenFlags != windows.FILE_ATTRIBUTE_NORMAL ||
		standardIOChildOpenFlags&windows.FILE_FLAG_OVERLAPPED != 0 {
		t.Fatal("standard-I/O child handle is not explicitly synchronous")
	}
	if standardIOMaximumInstances != 1 {
		t.Fatal("standard-I/O named pipe permits more than one server instance")
	}
}

func TestFixedNodeCommandLinesRemainWithinWindowsLimit(t *testing.T) {
	spec := validLaunchSpec()
	for _, role := range []Role{RoleControl, RoleExecutor} {
		arguments := fixedNodeArguments(role, spec.BundlePath, spec.HostControlPipeName)
		commandLine := windows.ComposeCommandLine(append([]string{spec.ExecutablePath}, arguments...))
		encoded, err := windows.UTF16FromString(commandLine)
		if err != nil {
			t.Fatal(err)
		}
		if len(encoded) > 32_767 {
			t.Fatalf("%s command line uses %d UTF-16 units", role, len(encoded))
		}
		bundleIndex := strings.Index(commandLine, spec.BundlePath)
		for _, fixedFlag := range []string{"--disallow-code-generation-from-strings", "--no-addons"} {
			if flagIndex := strings.Index(commandLine, fixedFlag); flagIndex < 0 || flagIndex >= bundleIndex {
				t.Fatalf("%s command line does not place %s before the bundle: %q", role, fixedFlag, commandLine)
			}
		}
	}
}

func TestWindowsImplementationsSatisfyStableInterfaces(t *testing.T) {
	var _ NodeProcess = (*windowsNodeProcess)(nil)
	var _ WrapperWatcher = (*stableWrapper)(nil)
	var _ wrapperProcessHandle = (*windowsWrapperProcess)(nil)
}

func TestWindowsWrapperCloseFailureTombstonesWithoutRetry(t *testing.T) {
	closeFailure := errors.New("injected CloseHandle failure")
	quarantine := &processLifetimeQuarantine{}
	closeCalls := 0
	process := &windowsWrapperProcess{
		process:    windows.Handle(123),
		quarantine: quarantine,
		closeHandle: func(handle windows.Handle) error {
			closeCalls++
			if handle != windows.Handle(123) {
				t.Fatalf("close handle = %d, want 123", handle)
			}
			if closeCalls == 1 {
				return closeFailure
			}
			return nil
		},
	}
	if err := process.Close(); !errors.Is(err, closeFailure) || !errors.Is(err, ErrLaunchCleanupFatal) {
		t.Fatalf("first Close error = %v", err)
	}
	if process.process != 0 || quarantine.count() != 1 {
		t.Fatalf("process handle = %d, quarantine = %d", process.process, quarantine.count())
	}
	if err := process.Close(); !errors.Is(err, ErrLaunchCleanupFatal) {
		t.Fatalf("sticky Close error = %v", err)
	}
	if process.process != 0 || closeCalls != 1 {
		t.Fatalf("process handle = %d, close calls = %d", process.process, closeCalls)
	}
}

func TestInvalidWrapperProcessHandleIsStickyPoison(t *testing.T) {
	quarantine := &processLifetimeQuarantine{}
	closeCalls := 0
	process := &windowsWrapperProcess{
		process:    windows.Handle(124),
		quarantine: quarantine,
		closeHandle: func(windows.Handle) error {
			closeCalls++
			return nil
		},
	}
	process.mu.Lock()
	err := process.poisonInvalidHandleLocked("test wrapper query", windows.ERROR_INVALID_HANDLE)
	process.mu.Unlock()
	if !errors.Is(err, ErrLaunchCleanupFatal) || process.process != 0 || quarantine.count() != 1 {
		t.Fatalf("error=%v process=%d quarantine=%d", err, process.process, quarantine.count())
	}
	if err := process.Close(); !errors.Is(err, ErrLaunchCleanupFatal) {
		t.Fatalf("Close after poison error = %v", err)
	}
	if closeCalls != 0 {
		t.Fatalf("CloseHandle calls after invalid-handle tombstone = %d", closeCalls)
	}
}

func TestInvalidNodeTokenIsTombstonedWithoutClose(t *testing.T) {
	original := windowsProcessLifetimeQuarantine
	quarantine := &processLifetimeQuarantine{}
	windowsProcessLifetimeQuarantine = quarantine
	defer func() { windowsProcessLifetimeQuarantine = original }()

	token := windows.Token(321)
	err := poisonNodeTokenIfInvalid(&token, windows.ERROR_INVALID_HANDLE)
	if token != 0 || !errors.Is(err, ErrLaunchCleanupFatal) || quarantine.count() != 1 {
		t.Fatalf("token=%d error=%v quarantine=%d", token, err, quarantine.count())
	}
}

func TestAdoptWindowsHandleOutputContracts(t *testing.T) {
	t.Run("ordinary failure has no owner", func(t *testing.T) {
		quarantine := &processLifetimeQuarantine{}
		callErr := errors.New("native open failure")
		handle, err := adoptWindowsHandleOutput("test handle", windows.InvalidHandle, callErr, quarantine)
		if handle != 0 || !errors.Is(err, callErr) || errors.Is(err, ErrLaunchCleanupFatal) {
			t.Fatalf("handle=%d error=%v", handle, err)
		}
		if quarantine.count() != 0 {
			t.Fatalf("ordinary failure quarantine count = %d", quarantine.count())
		}
	})

	t.Run("error with valid output is quarantined", func(t *testing.T) {
		quarantine := &processLifetimeQuarantine{}
		callErr := errors.New("native open failure")
		handle, err := adoptWindowsHandleOutput("test handle", windows.Handle(501), callErr, quarantine)
		if handle != 0 || !errors.Is(err, callErr) || !errors.Is(err, ErrLaunchCleanupFatal) {
			t.Fatalf("handle=%d error=%v", handle, err)
		}
		if quarantine.count() != 1 {
			t.Fatalf("untrusted output quarantine count = %d", quarantine.count())
		}
	})

	t.Run("success adopts only a valid handle", func(t *testing.T) {
		quarantine := &processLifetimeQuarantine{}
		handle, err := adoptWindowsHandleOutput("test handle", windows.Handle(502), nil, quarantine)
		if err != nil || handle != windows.Handle(502) || quarantine.count() != 0 {
			t.Fatalf("handle=%d error=%v quarantine=%d", handle, err, quarantine.count())
		}
	})
}

func TestInvalidRetainedJobAndProcessHandlesAreStickyPoison(t *testing.T) {
	original := windowsProcessLifetimeQuarantine
	quarantine := &processLifetimeQuarantine{}
	windowsProcessLifetimeQuarantine = quarantine
	defer func() { windowsProcessLifetimeQuarantine = original }()

	process := &windowsNodeProcess{
		job:     windows.Handle(401),
		process: windows.Handle(402),
	}
	jobErr := process.poisonJobHandleIfInvalidLocked(windows.ERROR_INVALID_HANDLE)
	processErr := process.poisonProcessHandleIfInvalidLocked(windows.ERROR_INVALID_HANDLE)
	if process.job != 0 || process.process != 0 ||
		!errors.Is(jobErr, ErrLaunchCleanupFatal) || !errors.Is(processErr, ErrLaunchCleanupFatal) {
		t.Fatalf("job=%d process=%d jobErr=%v processErr=%v", process.job, process.process, jobErr, processErr)
	}
	if quarantine.count() != 2 {
		t.Fatalf("quarantine count = %d", quarantine.count())
	}
	if retry := process.poisonJobHandleIfInvalidLocked(windows.ERROR_INVALID_HANDLE); retry != process.jobPoison {
		t.Fatal("job poison was not sticky")
	}
	if retry := process.poisonProcessHandleIfInvalidLocked(windows.ERROR_INVALID_HANDLE); retry != process.processPoison {
		t.Fatal("process poison was not sticky")
	}
	if quarantine.count() != 2 {
		t.Fatal("sticky poison quarantined the same numeric handle twice")
	}
}
