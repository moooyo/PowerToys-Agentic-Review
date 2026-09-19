//go:build windows

package host

import (
	"bufio"
	"bytes"
	"encoding/json"
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

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/protocol"
	"golang.org/x/sys/windows"
)

const recoveryHelperKeyEnvironment = "AGENTIC_REVIEW_NAMED_JOB_RECOVERY_KEY"
const recoveryChildEnvironment = "AGENTIC_REVIEW_NAMED_JOB_RECOVERY_CHILD"
const recoveryTimeoutEnvironment = "AGENTIC_REVIEW_NAMED_JOB_RECOVERY_TIMEOUT"

type recoveryHelperReceipt struct {
	Recovery         *protocol.NamedJobRecoveryCapability `json:"recovery"`
	RootPID          uint32                               `json:"rootPid"`
	DescendantPID    uint32                               `json:"descendantPid"`
	RequestJobHandle uint64                               `json:"requestJobHandle"`
}

func TestNamedJobRecoveryHelperProcess(t *testing.T) {
	key := os.Getenv(recoveryHelperKeyEnvironment)
	if key == "" {
		return
	}
	fail := func(err error) {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	release, err := AcquireGlobalInstanceMutex(key)
	if err != nil {
		fail(err)
	}
	timeout := 15 * time.Second
	if configured := os.Getenv(recoveryTimeoutEnvironment); configured != "" {
		timeout, err = time.ParseDuration(configured)
		if err != nil {
			fail(err)
		}
	}
	launcher, capability, err := newRecoveryLauncherWithTimeout(key, timeout)
	if err != nil {
		fail(err)
	}
	receipt := recoveryHelperReceipt{Recovery: capability}
	var process launchedProcess
	if os.Getenv(recoveryChildEnvironment) == "launch" {
		executable, err := os.Executable()
		if err != nil {
			fail(err)
		}
		limits, err := protocol.ResolveLimits(protocol.ProcessResourceLimits{
			HardTimeoutMS: 30_000, MaximumProcessCount: 8,
			MaximumMemoryBytes: 256 * 1024 * 1024, MaximumOutputBytes: 4 * 1024,
		})
		if err != nil {
			fail(err)
		}
		process, err = launcher.Launch(protocol.ProcessLaunchSpec{
			Executable:       executable,
			Arguments:        []string{"-test.run=^TestNamedJobRecoveryChildProcess$"},
			WorkingDirectory: filepath.Dir(executable), EnvironmentMode: "replace",
			Environment: map[string]string{
				recoveryChildEnvironment: "root", "SYSTEMROOT": os.Getenv("SYSTEMROOT"),
			},
		}, limits)
		if err != nil {
			fail(err)
		}
		line, err := readLineWithTimeout(process.StandardOutput(), 5*time.Second)
		if err != nil {
			fail(err)
		}
		descendant, err := strconv.ParseUint(strings.TrimSpace(line), 10, 32)
		if err != nil {
			fail(err)
		}
		receipt.RootPID = process.ProcessID()
		receipt.DescendantPID = uint32(descendant)
		receipt.RequestJobHandle = uint64(process.(*windowsProcess).job)
	}
	if err := json.NewEncoder(os.Stdout).Encode(receipt); err != nil {
		fail(err)
	}
	if _, err := io.Copy(io.Discard, os.Stdin); err != nil {
		fail(err)
	}
	if process != nil {
		if err := process.Terminate(); err != nil {
			fail(err)
		}
		if _, err := process.Wait(); err != nil {
			fail(err)
		}
		if err := process.Close(); err != nil {
			fail(err)
		}
	}
	if err := release(); err != nil {
		fail(err)
	}
	// The recovery handle intentionally remains open, matching production main.
	os.Exit(0)
}

func TestNamedJobRecoveryChildProcess(t *testing.T) {
	mode := os.Getenv(recoveryChildEnvironment)
	if mode != "root" && mode != "descendant" {
		return
	}
	if mode == "root" {
		executable, err := os.Executable()
		if err != nil {
			os.Exit(2)
		}
		child := exec.Command(executable, "-test.run=^TestNamedJobRecoveryChildProcess$")
		child.Env = []string{recoveryChildEnvironment + "=descendant", "SYSTEMROOT=" + os.Getenv("SYSTEMROOT")}
		if err := child.Start(); err != nil {
			os.Exit(3)
		}
		_, _ = fmt.Fprintf(os.Stdout, "%d\n", child.Process.Pid)
	}
	// Ignore pipe EOF so the recovery test can retain both jobs and prove explicit drain.
	time.Sleep(10 * time.Minute)
	os.Exit(4)
}

type recoveryHelper struct {
	command *exec.Cmd
	input   io.WriteCloser
	stderr  *bytes.Buffer
	receipt recoveryHelperReceipt
	waited  bool
	ready   <-chan recoveryHelperReadiness
}

type recoveryHelperReadiness struct {
	line string
	err  error
}

func startRecoveryHelper(t *testing.T, key string, withTree bool) *recoveryHelper {
	t.Helper()
	helper := launchRecoveryHelper(t, key, withTree, 0)
	helper.readReady(t, key)
	return helper
}

func launchRecoveryHelper(t *testing.T, key string, withTree bool, timeout time.Duration) *recoveryHelper {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(executable, "-test.run=^TestNamedJobRecoveryHelperProcess$")
	command.Env = append(os.Environ(), recoveryHelperKeyEnvironment+"="+key)
	if withTree {
		command.Env = append(command.Env, recoveryChildEnvironment+"=launch")
	}
	if timeout != 0 {
		command.Env = append(command.Env, recoveryTimeoutEnvironment+"="+timeout.String())
	}
	stderr := &bytes.Buffer{}
	command.Stderr = stderr
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := command.StdoutPipe()
	if err != nil {
		_ = input.Close()
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		_ = input.Close()
		_ = output.Close()
		t.Fatal(err)
	}
	ready := make(chan recoveryHelperReadiness, 1)
	helper := &recoveryHelper{command: command, input: input, stderr: stderr, ready: ready}
	t.Cleanup(func() {
		_ = input.Close()
		if !helper.waited {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	})
	go func() {
		line, err := bufio.NewReader(output).ReadString('\n')
		ready <- recoveryHelperReadiness{line: line, err: err}
	}()
	return helper
}

func (helper *recoveryHelper) readiness(t *testing.T) recoveryHelperReadiness {
	t.Helper()
	select {
	case result := <-helper.ready:
		return result
	case <-time.After(25 * time.Second):
		t.Fatal("timed out waiting for recovery helper readiness")
		return recoveryHelperReadiness{}
	}
}

func (helper *recoveryHelper) readReady(t *testing.T, key string) {
	t.Helper()
	result := helper.readiness(t)
	if result.err != nil {
		_ = helper.command.Process.Kill()
		_ = helper.wait(t)
		t.Fatalf("read recovery readiness: %v; stderr: %s", result.err, helper.stderr.String())
	}
	if err := json.Unmarshal([]byte(result.line), &helper.receipt); err != nil {
		t.Fatalf("decode recovery readiness: %v", err)
	}
	if helper.receipt.Recovery == nil || !helper.receipt.Recovery.PreviousTreeDrained ||
		helper.receipt.Recovery.InstanceKey != key || !ValidInstanceKey(helper.receipt.Recovery.Generation) ||
		helper.receipt.Recovery.Capability != "named-job-tree-v1" {
		t.Fatalf("invalid recovery receipt: %+v", helper.receipt.Recovery)
	}
}

func (helper *recoveryHelper) wait(t *testing.T) error {
	t.Helper()
	waited := make(chan error, 1)
	go func() { waited <- helper.command.Wait() }()
	select {
	case err := <-waited:
		helper.waited = true
		return err
	case <-time.After(25 * time.Second):
		_ = helper.command.Process.Kill()
		<-waited
		helper.waited = true
		t.Fatal("timed out waiting for recovery helper exit")
		return nil
	}
}

func TestNamedJobRecoveryPreservesNormalHostExit(t *testing.T) {
	helper := startRecoveryHelper(t, testInstanceKey(t.Name()), true)
	if err := helper.input.Close(); err != nil {
		t.Fatal(err)
	}
	if err := helper.wait(t); err != nil {
		t.Fatalf("contained Host exit: %v; stderr: %s", err, helper.stderr.String())
	}
}

func TestNamedJobRecoveryRejectsInvalidOwnershipKey(t *testing.T) {
	for _, key := range []string{"", strings.Repeat("A", 64), strings.Repeat("a", 63)} {
		launcher, capability, err := newRecoveryLauncher(key)
		if err == nil || launcher != nil || capability != nil {
			t.Fatalf("invalid key produced recovery ownership: (%v, %+v, %v)", launcher, capability, err)
		}
	}
}

func TestNamedJobRecoveryDrainsRetainedPreviousHostTreeBeforeReady(t *testing.T) {
	key := testInstanceKey(t.Name())
	previous := startRecoveryHelper(t, key, true)
	name, err := windows.UTF16PtrFromString(recoveryJobPrefix + key)
	if err != nil {
		t.Fatal(err)
	}
	outer, err := windows.CreateJobObject(nil, name)
	if err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		t.Fatal(err)
	}
	if outer == 0 {
		t.Fatal("expected a retained recovery Job handle")
	}
	t.Cleanup(func() {
		if outer != 0 {
			_ = windows.TerminateJobObject(outer, terminationExitCode)
			_ = windows.CloseHandle(outer)
		}
	})
	source, err := windows.OpenProcess(windows.PROCESS_DUP_HANDLE, false, uint32(previous.command.Process.Pid))
	if err != nil {
		t.Fatal(err)
	}
	var inner windows.Handle
	err = windows.DuplicateHandle(source, windows.Handle(previous.receipt.RequestJobHandle), windows.CurrentProcess(), &inner, 0, false, windows.DUPLICATE_SAME_ACCESS)
	_ = windows.CloseHandle(source)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if inner != 0 {
			_ = windows.TerminateJobObject(inner, terminationExitCode)
			_ = windows.CloseHandle(inner)
		}
	})
	var owned []windows.Handle
	for _, pid := range []uint32{previous.receipt.RootPID, previous.receipt.DescendantPID} {
		handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, pid)
		if err != nil {
			t.Fatal(err)
		}
		owned = append(owned, handle)
		index := len(owned) - 1
		t.Cleanup(func() {
			if owned[index] != 0 {
				_ = windows.CloseHandle(owned[index])
			}
		})
	}
	if err := previous.command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := previous.wait(t); err == nil {
		t.Fatal("expected an abrupt previous Host exit")
	}
	for _, process := range owned {
		if status, err := windows.WaitForSingleObject(process, 0); err != nil || status != uint32(windows.WAIT_TIMEOUT) {
			t.Fatalf("retained old child state = (%d, %v), want alive before recovery", status, err)
		}
	}
	current := launchRecoveryHelper(t, key, false, 0)
	for _, process := range owned {
		if status, err := windows.WaitForSingleObject(process, 5_000); err != nil || status != windows.WAIT_OBJECT_0 {
			t.Fatalf("previous child state after recovery = (%d, %v), want exited", status, err)
		}
	}
	if err := waitForNoActiveProcesses(windowsJobCounter{job: outer}, 5*time.Second, 10*time.Millisecond, wallDrainClock{}); err != nil {
		t.Fatalf("previous outer Job did not drain: %v", err)
	}
	select {
	case result := <-current.ready:
		t.Fatalf("recovery emitted readiness while old Job handles were retained: %+v", result)
	case <-time.After(100 * time.Millisecond):
	}
	// Preserve the independently observed terminal facts, then release every fixture
	// reference that could keep the terminated Job hierarchy alive.
	for index, process := range owned {
		if err := windows.CloseHandle(process); err != nil {
			t.Fatal(err)
		}
		owned[index] = 0
	}
	if err := windows.CloseHandle(inner); err != nil {
		t.Fatal(err)
	}
	inner = 0
	if err := windows.CloseHandle(outer); err != nil {
		t.Fatal(err)
	}
	outer = 0
	current.readReady(t, key)
	if current.receipt.Recovery.Generation == previous.receipt.Recovery.Generation {
		t.Fatal("restarted Host reused its generation")
	}
	if err := current.input.Close(); err != nil {
		t.Fatal(err)
	}
	if err := current.wait(t); err != nil {
		t.Fatalf("recovered Host exit: %v; stderr: %s", err, current.stderr.String())
	}
}

func TestNamedJobRecoveryRetainedNameTimesOutWithoutProof(t *testing.T) {
	key := testInstanceKey(t.Name())
	name, err := windows.UTF16PtrFromString(recoveryJobPrefix + key)
	if err != nil {
		t.Fatal(err)
	}
	retained, created, err := createRecoveryJob(name)
	if retained != 0 {
		t.Cleanup(func() { _ = windows.CloseHandle(retained) })
	}
	if err != nil || !created {
		t.Fatalf("create retained fixture Job: created=%t, error=%v", created, err)
	}
	helper := launchRecoveryHelper(t, key, false, 100*time.Millisecond)
	result := helper.readiness(t)
	if result.line != "" || !errors.Is(result.err, io.EOF) {
		t.Fatalf("retained-name startup produced output or lacked EOF: %+v", result)
	}
	if err := helper.wait(t); err == nil {
		t.Fatal("retained-name startup unexpectedly succeeded")
	}
	if !strings.Contains(helper.stderr.String(), "name is still retained by an earlier generation") {
		t.Fatalf("startup did not report retained ownership: %s", helper.stderr.String())
	}
}

func TestNamedJobRecoveryCreationDistinguishesFreshAndExisting(t *testing.T) {
	name, err := windows.UTF16PtrFromString(recoveryJobPrefix + testInstanceKey(t.Name()))
	if err != nil {
		t.Fatal(err)
	}
	first, created, err := createRecoveryJob(name)
	if first != 0 {
		t.Cleanup(func() { _ = windows.CloseHandle(first) })
	}
	if err != nil || !created {
		t.Fatalf("initial create = (%t, %v), want fresh", created, err)
	}
	second, created, err := createRecoveryJob(name)
	if second != 0 {
		t.Cleanup(func() { _ = windows.CloseHandle(second) })
	}
	if err != nil || created {
		t.Fatalf("second create = (%t, %v), want existing", created, err)
	}
	freshName, err := windows.UTF16PtrFromString(recoveryJobPrefix + testInstanceKey(t.Name()+"-fresh"))
	if err != nil {
		t.Fatal(err)
	}
	fresh, created, err := createRecoveryJob(freshName)
	if fresh != 0 {
		t.Cleanup(func() { _ = windows.CloseHandle(fresh) })
	}
	if err != nil || !created {
		t.Fatalf("create after ERROR_ALREADY_EXISTS = (%t, %v), want fresh", created, err)
	}
}
