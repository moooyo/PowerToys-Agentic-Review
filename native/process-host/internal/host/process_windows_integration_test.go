//go:build windows

package host

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
	"unsafe"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/protocol"
	"golang.org/x/sys/windows"
)

const (
	windowsLauncherHelperEnvironment = "AGENTIC_REVIEW_PROCESS_HOST_HELPER"
	windowsLauncherHelperArgument    = "agentic-review-process-host-helper"
)

func TestWindowsLauncherHelperProcess(t *testing.T) {
	if os.Getenv(windowsLauncherHelperEnvironment) != "1" ||
		len(os.Args) == 0 || os.Args[len(os.Args)-1] != windowsLauncherHelperArgument {
		return
	}
	_, _ = io.WriteString(os.Stdout, "ready\n")
	if _, err := io.Copy(io.Discard, os.Stdin); err != nil {
		os.Exit(2)
	}
	os.Exit(0)
}

func TestWindowsLauncherCreatesJobAndConnectsStandardIO(t *testing.T) {
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
	limits, err := protocol.ResolveLimits(protocol.ProcessResourceLimits{
		HardTimeoutMS:       10_000,
		MaximumProcessCount: 1,
		MaximumMemoryBytes:  256 * 1024 * 1024,
		MaximumOutputBytes:  4 * 1024,
	})
	if err != nil {
		t.Fatal(err)
	}

	launched, err := newProcessLauncher().Launch(protocol.ProcessLaunchSpec{
		Executable:       executable,
		Arguments:        []string{"-test.run=^TestWindowsLauncherHelperProcess$", "--", windowsLauncherHelperArgument},
		WorkingDirectory: workingDirectory,
		EnvironmentMode:  "replace",
		Environment:      environment,
	}, limits)
	if err != nil {
		t.Fatal(err)
	}
	process, ok := launched.(*windowsProcess)
	if !ok {
		_ = launched.Close()
		t.Fatalf("launched process type = %T, want *windowsProcess", launched)
	}
	completed := false
	defer func() {
		if !completed {
			_ = process.Terminate()
		}
		if err := process.Close(); err != nil && !completed {
			t.Logf("process cleanup: %v", err)
		}
	}()

	type readResult struct {
		line string
		err  error
	}
	ready := make(chan readResult, 1)
	go func() {
		line, err := bufio.NewReader(process.StandardOutput()).ReadString('\n')
		ready <- readResult{line: line, err: err}
	}()
	select {
	case result := <-ready:
		if result.err != nil {
			t.Fatalf("read helper readiness: %v", result.err)
		}
		if result.line != "ready\n" {
			t.Fatalf("helper readiness = %q, want ready newline", result.line)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for helper readiness")
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
