//go:build windows

package host

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
	"unsafe"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/protocol"
	"golang.org/x/sys/windows"
)

const (
	windowsLauncherHelperEnvironment = "AGENTIC_REVIEW_PROCESS_HOST_HELPER"
	windowsLauncherHelperArgument    = "agentic-review-process-host-helper"
	windowsLauncherDescendantParent  = "agentic-review-process-host-descendant-parent"
	windowsLauncherDescendantChild   = "agentic-review-process-host-descendant-child"
)

func TestWindowsLauncherHelperProcess(t *testing.T) {
	if os.Getenv(windowsLauncherHelperEnvironment) != "1" || len(os.Args) == 0 {
		return
	}

	switch os.Args[len(os.Args)-1] {
	case windowsLauncherHelperArgument:
		runWindowsLauncherBlockingHelper("ready\n", 2)
	case windowsLauncherDescendantChild:
		runWindowsLauncherBlockingHelper("", 6)
	case windowsLauncherDescendantParent:
		runWindowsLauncherDescendantParentHelper()
	default:
		return
	}
}

func TestWindowsLauncherCreatesJobAndConnectsStandardIO(t *testing.T) {
	process := launchWindowsLauncherTestProcess(t, windowsLauncherHelperArgument, protocol.ProcessResourceLimits{
		HardTimeoutMS:       10_000,
		MaximumProcessCount: 1,
		MaximumMemoryBytes:  256 * 1024 * 1024,
		MaximumOutputBytes:  4 * 1024,
	})
	completed := false
	defer func() {
		if !completed {
			_ = process.Terminate()
		}
		if err := process.Close(); err != nil && !completed {
			t.Logf("process cleanup: %v", err)
		}
	}()
	if process.ProcessCreationTimeFileTime() != 0 {
		t.Fatal("launcher captured an unrequested process identity")
	}

	line, err := readLineWithTimeout(process.StandardOutput(), 5*time.Second)
	if err != nil {
		t.Fatalf("read helper readiness: %v", err)
	}
	if line != "ready\n" {
		t.Fatalf("helper readiness = %q, want ready newline", line)
	}

	activeProcesses, err := (windowsJobCounter{job: process.job}).ActiveProcessCount()
	if err != nil {
		t.Fatalf("query Job Object: %v", err)
	}
	if activeProcesses == 0 {
		t.Fatal("Job Object reported no active process while the helper was blocked")
	}
	processIDs, err := activeJobProcessIDs(process.job)
	if err != nil {
		t.Fatalf("query Job Object process IDs: %v", err)
	}
	// Windows may also associate its headless conhost with the Job, so require
	// direct membership of the launched helper instead of an exact process count.
	foundHelper := false
	for _, processID := range processIDs {
		if processID == process.processID {
			foundHelper = true
			break
		}
	}
	if !foundHelper {
		t.Fatalf("Job Object process IDs = %v, missing helper PID %d", processIDs, process.processID)
	}
	if err := process.StandardInput().Close(); err != nil {
		t.Fatalf("close helper standard input: %v", err)
	}

	type waitResult struct {
		exitCode *int64
		err      error
	}
	waited := make(chan waitResult, 1)
	go func() {
		exitCode, err := process.Wait()
		waited <- waitResult{exitCode: exitCode, err: err}
	}()
	select {
	case result := <-waited:
		if result.err != nil {
			t.Fatalf("wait for helper: %v", result.err)
		}
		if result.exitCode == nil || *result.exitCode != 0 {
			t.Fatalf("helper exit code = %v, want 0", result.exitCode)
		}
		completed = true
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for helper exit")
	}
}

func TestWindowsLauncherCapturesCreationTimeFromOriginalHandle(t *testing.T) {
	process := launchWindowsLauncherTestProcessWithIdentity(t, windowsLauncherHelperArgument, protocol.ProcessResourceLimits{
		HardTimeoutMS:       10_000,
		MaximumProcessCount: 1,
		MaximumMemoryBytes:  256 * 1024 * 1024,
		MaximumOutputBytes:  4 * 1024,
	}, true)
	defer func() {
		_ = process.Terminate()
		if err := process.Close(); err != nil {
			t.Errorf("close helper process: %v", err)
		}
	}()

	var creationTime, exitTime, kernelTime, userTime windows.Filetime
	if err := windows.GetProcessTimes(process.process, &creationTime, &exitTime, &kernelTime, &userTime); err != nil {
		t.Fatalf("read creation time through original process handle: %v", err)
	}
	want := uint64(creationTime.HighDateTime)<<32 | uint64(creationTime.LowDateTime)
	if got := process.ProcessCreationTimeFileTime(); got == 0 || got != want {
		t.Fatalf("captured creation time = %d, want original handle value %d", got, want)
	}
	if err := process.StandardInput().Close(); err != nil {
		t.Fatalf("close helper standard input: %v", err)
	}
	waited := make(chan error, 1)
	go func() {
		exitCode, err := process.Wait()
		if err == nil && (exitCode == nil || *exitCode != 0) {
			err = fmt.Errorf("helper exit code = %v, want 0", exitCode)
		}
		waited <- err
	}()
	select {
	case err := <-waited:
		if err != nil {
			t.Fatalf("wait for helper: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for identity helper exit")
	}
	if err := process.Close(); err != nil {
		t.Fatalf("close exited helper: %v", err)
	}
	if got := process.ProcessCreationTimeFileTime(); got != want {
		t.Fatalf("identity changed after handle closure = %d, want %d", got, want)
	}
}

func TestReadProcessCreationTimeReportsKernelQueryFailure(t *testing.T) {
	creationTime, err := readProcessCreationTimeFileTime(windows.Handle(0))
	if creationTime != 0 || !errors.Is(err, errProcessIdentityQueryFailed) || !errors.Is(err, windows.ERROR_INVALID_HANDLE) {
		t.Fatalf("invalid handle query = (%d, %v), want PROCESS_IDENTITY_QUERY_FAILED with ERROR_INVALID_HANDLE", creationTime, err)
	}
}

func TestWindowsLauncherTerminateKillsDescendantsAndDrainsJob(t *testing.T) {
	process := launchWindowsLauncherTestProcess(t, windowsLauncherDescendantParent, protocol.ProcessResourceLimits{
		HardTimeoutMS:       10_000,
		MaximumProcessCount: 8,
		MaximumMemoryBytes:  256 * 1024 * 1024,
		MaximumOutputBytes:  4 * 1024,
	})
	completed := false
	defer func() {
		if !completed {
			_ = process.Terminate()
		}
		if err := process.Close(); err != nil && !completed {
			t.Logf("process cleanup: %v", err)
		}
	}()

	line, err := readLineWithTimeout(process.StandardOutput(), 5*time.Second)
	if err != nil {
		t.Fatalf("read descendant parent readiness: %v", err)
	}
	childPID, err := parseDescendantReadyLine(line)
	if err != nil {
		t.Fatalf("parse descendant parent readiness: %v", err)
	}

	childHandle, err := windows.OpenProcess(
		windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION,
		false,
		childPID,
	)
	if err != nil {
		t.Fatalf("open child process %d: %v", childPID, err)
	}
	defer func() {
		if err := windows.CloseHandle(childHandle); err != nil && !errors.Is(err, windows.ERROR_INVALID_HANDLE) {
			t.Logf("close child process handle: %v", err)
		}
	}()

	jobProbe, err := duplicateCurrentProcessHandle(process.job)
	if err != nil {
		t.Fatalf("duplicate Job Object handle: %v", err)
	}
	defer func() {
		if err := windows.CloseHandle(jobProbe); err != nil && !errors.Is(err, windows.ERROR_INVALID_HANDLE) {
			t.Logf("close duplicated Job Object handle: %v", err)
		}
	}()

	if err := waitForJobMembership(jobProbe, 2*time.Second, process.processID, childPID); err != nil {
		t.Fatal(err)
	}

	if err := process.Terminate(); err != nil {
		t.Fatalf("terminate process tree: %v", err)
	}

	type waitResult struct {
		exitCode *int64
		err      error
	}
	waited := make(chan waitResult, 1)
	go func() {
		exitCode, err := process.Wait()
		waited <- waitResult{exitCode: exitCode, err: err}
	}()

	select {
	case result := <-waited:
		if result.err != nil {
			t.Fatalf("wait for terminated tree: %v", result.err)
		}
		if result.exitCode == nil || *result.exitCode != int64(terminationExitCode) {
			t.Fatalf("root exit code = %v, want %d", result.exitCode, terminationExitCode)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for terminated tree")
	}

	childStatus, err := windows.WaitForSingleObject(childHandle, 3000)
	if err != nil {
		t.Fatalf("wait for child termination: %v", err)
	}
	if childStatus != windows.WAIT_OBJECT_0 {
		t.Fatalf("child wait status = 0x%x, want WAIT_OBJECT_0", childStatus)
	}

	var childExitCode uint32
	if err := windows.GetExitCodeProcess(childHandle, &childExitCode); err != nil {
		t.Fatalf("read child exit code: %v", err)
	}
	if childExitCode != terminationExitCode {
		t.Fatalf("child exit code = %d, want %d", childExitCode, terminationExitCode)
	}

	activeProcesses, err := (windowsJobCounter{job: jobProbe}).ActiveProcessCount()
	if err != nil {
		t.Fatalf("query Job Object after wait: %v", err)
	}
	if activeProcesses != 0 {
		t.Fatalf("Job Object active process count after wait = %d, want 0", activeProcesses)
	}
	if process.job != 0 {
		t.Fatal("retained Job Object handle was not closed after wait")
	}

	completed = true
}

func runWindowsLauncherBlockingHelper(readiness string, stdinReadFailureCode int) {
	if readiness != "" {
		_, _ = io.WriteString(os.Stdout, readiness)
	}
	if _, err := io.Copy(io.Discard, os.Stdin); err != nil {
		os.Exit(stdinReadFailureCode)
	}
	os.Exit(0)
}

func runWindowsLauncherDescendantParentHelper() {
	executable, err := os.Executable()
	if err != nil {
		os.Exit(3)
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		os.Exit(4)
	}
	child := exec.Command(executable, "-test.run=^TestWindowsLauncherHelperProcess$", "--", windowsLauncherDescendantChild)
	child.Env = os.Environ()
	child.Stdin = os.Stdin
	child.Stdout = io.Discard
	child.Stderr = io.Discard
	if err := child.Start(); err != nil {
		os.Exit(5)
	}
	_, _ = fmt.Fprintf(os.Stdout, "ready child=%d\n", child.Process.Pid)
	if _, err := io.Copy(io.Discard, os.Stdin); err != nil {
		os.Exit(7)
	}
	os.Exit(0)
}

func launchWindowsLauncherTestProcess(
	t *testing.T,
	helperArgument string,
	resourceLimits protocol.ProcessResourceLimits,
) *windowsProcess {
	t.Helper()
	return launchWindowsLauncherTestProcessWithIdentity(t, helperArgument, resourceLimits, false)
}

func launchWindowsLauncherTestProcessWithIdentity(
	t *testing.T,
	helperArgument string,
	resourceLimits protocol.ProcessResourceLimits,
	captureIdentity bool,
) *windowsProcess {
	t.Helper()
	return launchWindowsLauncherTestProcessWithDiagnostics(t, helperArgument, resourceLimits, captureIdentity, false)
}

func launchWindowsLauncherTestProcessWithDiagnostics(
	t *testing.T,
	helperArgument string,
	resourceLimits protocol.ProcessResourceLimits,
	captureIdentity bool,
	captureUsage bool,
) *windowsProcess {
	t.Helper()

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		t.Fatal(err)
	}
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}

	environment := map[string]string{
		windowsLauncherHelperEnvironment: "1",
		"SYSTEMROOT":                     os.Getenv("SYSTEMROOT"),
	}
	for _, name := range []string{"TEMP", "TMP"} {
		if value := os.Getenv(name); value != "" {
			environment[name] = value
		}
	}
	limits, err := protocol.ResolveLimits(resourceLimits)
	if err != nil {
		t.Fatal(err)
	}

	launched, err := newProcessLauncher().Launch(protocol.ProcessLaunchSpec{
		Executable:             executable,
		Arguments:              []string{"-test.run=^TestWindowsLauncherHelperProcess$", "--", helperArgument},
		WorkingDirectory:       workingDirectory,
		EnvironmentMode:        "replace",
		Environment:            environment,
		CaptureProcessIdentity: captureIdentity,
		CaptureResourceUsage:   captureUsage,
	}, limits)
	if err != nil {
		t.Fatal(err)
	}
	process, ok := launched.(*windowsProcess)
	if !ok {
		_ = launched.Close()
		t.Fatalf("launched process type = %T, want *windowsProcess", launched)
	}
	return process
}

func readLineWithTimeout(reader io.Reader, timeout time.Duration) (string, error) {
	type readResult struct {
		line string
		err  error
	}
	resultChannel := make(chan readResult, 1)
	go func() {
		line, err := bufio.NewReader(reader).ReadString('\n')
		resultChannel <- readResult{line: line, err: err}
	}()
	select {
	case result := <-resultChannel:
		return result.line, result.err
	case <-time.After(timeout):
		return "", fmt.Errorf("timed out waiting for readiness after %s", timeout)
	}
}

func parseDescendantReadyLine(line string) (uint32, error) {
	trimmed := strings.TrimSpace(line)
	const prefix = "ready child="
	if !strings.HasPrefix(trimmed, prefix) {
		return 0, fmt.Errorf("unexpected readiness line %q", line)
	}
	childPID, err := strconv.ParseUint(strings.TrimPrefix(trimmed, prefix), 10, 32)
	if err != nil {
		return 0, fmt.Errorf("parse descendant PID from %q: %w", line, err)
	}
	if childPID == 0 {
		return 0, fmt.Errorf("read descendant PID 0 from %q", line)
	}
	return uint32(childPID), nil
}

func duplicateCurrentProcessHandle(source windows.Handle) (windows.Handle, error) {
	var duplicated windows.Handle
	err := windows.DuplicateHandle(
		windows.CurrentProcess(),
		source,
		windows.CurrentProcess(),
		&duplicated,
		0,
		false,
		windows.DUPLICATE_SAME_ACCESS,
	)
	if err != nil {
		return 0, err
	}
	return duplicated, nil
}

func waitForJobMembership(job windows.Handle, timeout time.Duration, processIDs ...uint32) error {
	deadline := time.Now().Add(timeout)
	for {
		listed, err := activeJobProcessIDs(job)
		if err != nil {
			return fmt.Errorf("query Job Object process IDs while waiting for membership: %w", err)
		}

		allPresent := true
		for _, processID := range processIDs {
			present := false
			for _, listedProcessID := range listed {
				if listedProcessID == processID {
					present = true
					break
				}
			}
			if !present {
				allPresent = false
				break
			}
		}
		if allPresent {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out waiting for Job Object membership of %v; current IDs %v", processIDs, listed)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func activeJobProcessIDs(job windows.Handle) ([]uint32, error) {
	var information struct {
		NumberOfAssignedProcesses uint32
		NumberOfProcessIDsInList  uint32
		ProcessIDs                [16]uintptr
	}
	if err := windows.QueryInformationJobObject(
		job,
		windows.JobObjectBasicProcessIdList,
		uintptr(unsafe.Pointer(&information)),
		uint32(unsafe.Sizeof(information)),
		nil,
	); err != nil {
		return nil, err
	}
	if information.NumberOfProcessIDsInList > uint32(len(information.ProcessIDs)) {
		return nil, fmt.Errorf("Job Object returned %d process IDs", information.NumberOfProcessIDsInList)
	}
	processIDs := make([]uint32, information.NumberOfProcessIDsInList)
	for index := range processIDs {
		processIDs[index] = uint32(information.ProcessIDs[index])
	}
	return processIDs, nil
}
