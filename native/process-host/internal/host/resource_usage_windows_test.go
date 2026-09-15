//go:build windows

package host

import (
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/protocol"
	"golang.org/x/sys/windows"
)

func TestResourceUsageQueryFailureOmitsDiagnostics(t *testing.T) {
	process := &windowsProcess{captureResourceUsage: true, job: windows.InvalidHandle}
	process.observeResourceUsageLocked()
	if process.ResourceUsage() != nil {
		t.Fatal("failed Job Object queries fabricated resource usage")
	}
}

func TestWindowsResourceUsageSurvivesNormalAndTerminatedTreeCleanup(t *testing.T) {
	for _, terminate := range []bool{false, true} {
		name := "normal"
		if terminate {
			name = "terminated"
		}
		t.Run(name, func(t *testing.T) {
			process := launchWindowsLauncherTestProcessWithDiagnostics(t, windowsLauncherHelperArgument, protocol.ProcessResourceLimits{
				HardTimeoutMS: 10000, MaximumProcessCount: 4, MaximumMemoryBytes: 256 * 1024 * 1024, MaximumOutputBytes: 4096,
			}, false, true)
			defer func() {
				_ = process.Terminate()
				_ = process.Close()
			}()
			if _, err := readLineWithTimeout(process.StandardOutput(), 5*time.Second); err != nil {
				t.Fatal(err)
			}
			type waitResult struct {
				exitCode *int64
				err      error
			}
			waited := make(chan waitResult, 1)
			go func() {
				exitCode, err := process.Wait()
				waited <- waitResult{exitCode, err}
			}()
			deadline := time.Now().Add(2 * time.Second)
			for {
				usage := process.ResourceUsage()
				if usage != nil && usage.ActiveProcesses != nil && usage.ActiveProcesses.SampledPeak > 0 {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("the running process was not sampled")
				}
				time.Sleep(10 * time.Millisecond)
			}
			wantExitCode := int64(0)
			if terminate {
				wantExitCode = int64(terminationExitCode)
				if err := process.Terminate(); err != nil {
					t.Fatal(err)
				}
			} else if err := process.StandardInput().Close(); err != nil {
				t.Fatal(err)
			}
			select {
			case result := <-waited:
				if result.err != nil || result.exitCode == nil || *result.exitCode != wantExitCode {
					t.Fatalf("unexpected completion: %#v", result)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("resource observations delayed tree completion")
			}
			if err := process.Close(); err != nil {
				t.Fatal(err)
			}
			usage := process.ResourceUsage()
			if process.job != 0 || usage == nil || usage.PeakJobMemoryBytes == nil || *usage.PeakJobMemoryBytes == 0 || usage.PeakProcessMemoryBytes == nil || *usage.PeakProcessMemoryBytes == 0 || usage.ActiveProcesses == nil {
				t.Fatalf("completed process lost its observations or Job handle: %#v", usage)
			}
		})
	}
}
