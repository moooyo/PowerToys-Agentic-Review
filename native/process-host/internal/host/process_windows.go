//go:build windows

package host

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unsafe"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/protocol"
	"golang.org/x/sys/windows"
)

const (
	terminationExitCode uint32 = 0xC000013A
	// ProcThreadAttributeValue(ProcThreadAttributeJobList, false, true, false).
	procThreadAttributeJobList uintptr = 0x0002000D
)

type windowsLauncher struct{}

func newProcessLauncher() processLauncher {
	return windowsLauncher{}
}

func (windowsLauncher) Launch(spec protocol.ProcessLaunchSpec, limits protocol.EffectiveLimits) (launchedProcess, error) {
	executable, err := validateRuntimePath(spec.Executable, true)
	if err != nil {
		return nil, fmt.Errorf("validate executable: %w", err)
	}
	workingDirectory, err := validateRuntimePath(spec.WorkingDirectory, false)
	if err != nil {
		return nil, fmt.Errorf("validate working directory: %w", err)
	}

	commandLine := windows.ComposeCommandLine(append([]string{executable}, spec.Arguments...))
	commandLineUTF16, err := windows.UTF16FromString(commandLine)
	if err != nil {
		return nil, fmt.Errorf("encode command line: %w", err)
	}
	if len(commandLineUTF16) > 32_767 {
		return nil, errors.New("composed command line exceeds the Windows 32,767 UTF-16-unit limit")
	}
	executableUTF16, err := windows.UTF16PtrFromString(executable)
	if err != nil {
		return nil, fmt.Errorf("encode executable path: %w", err)
	}
	workingDirectoryUTF16, err := windows.UTF16PtrFromString(workingDirectory)
	if err != nil {
		return nil, fmt.Errorf("encode working directory: %w", err)
	}
	environment, err := buildEnvironmentBlock(spec.Environment)
	if err != nil {
		return nil, err
	}

	stdinParent, stdinChild, err := createPipe(false, "process-stdin")
	if err != nil {
		return nil, fmt.Errorf("create stdin pipe: %w", err)
	}
	stdoutParent, stdoutChild, err := createPipe(true, "process-stdout")
	if err != nil {
		stdinParent.Close()
		windows.CloseHandle(stdinChild)
		return nil, fmt.Errorf("create stdout pipe: %w", err)
	}
	stderrParent, stderrChild, err := createPipe(true, "process-stderr")
	if err != nil {
		stdinParent.Close()
		stdoutParent.Close()
		windows.CloseHandle(stdinChild)
		windows.CloseHandle(stdoutChild)
		return nil, fmt.Errorf("create stderr pipe: %w", err)
	}

	parentFiles := []*os.File{stdinParent, stdoutParent, stderrParent}
	childHandles := []windows.Handle{stdinChild, stdoutChild, stderrChild}
	cleanupPipes := true
	defer func() {
		for _, handle := range childHandles {
			_ = windows.CloseHandle(handle)
		}
		if cleanupPipes {
			for _, file := range parentFiles {
				_ = file.Close()
			}
		}
	}()

	job, err := createLimitedJob(limits)
	if err != nil {
		return nil, err
	}
	jobOwned := true
	defer func() {
		if jobOwned {
			_ = windows.CloseHandle(job)
		}
	}()

	creationAttributes := requiredProcessCreationAttributes()
	attributes, err := windows.NewProcThreadAttributeList(uint32(len(creationAttributes)))
	if err != nil {
		return nil, fmt.Errorf("allocate process attribute list: %w", err)
	}
	defer attributes.Delete()
	jobHandles := []windows.Handle{job}
	for _, attribute := range creationAttributes {
		switch attribute {
		case processCreationAttributeInheritedHandles:
			if err := attributes.Update(
				windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
				unsafe.Pointer(&childHandles[0]),
				unsafe.Sizeof(childHandles[0])*uintptr(len(childHandles)),
			); err != nil {
				return nil, fmt.Errorf("restrict inherited process handles: %w", err)
			}
		case processCreationAttributeJobList:
			if err := attributes.Update(
				procThreadAttributeJobList,
				unsafe.Pointer(&jobHandles[0]),
				unsafe.Sizeof(jobHandles[0])*uintptr(len(jobHandles)),
			); err != nil {
				return nil, fmt.Errorf("configure atomic Job Object assignment: %w", err)
			}
		default:
			return nil, fmt.Errorf("unsupported process creation attribute %d", attribute)
		}
	}

	startupInfo := windows.StartupInfoEx{}
	startupInfo.Cb = uint32(unsafe.Sizeof(startupInfo))
	startupInfo.Flags = windows.STARTF_USESTDHANDLES
	startupInfo.StdInput = stdinChild
	startupInfo.StdOutput = stdoutChild
	startupInfo.StdErr = stderrChild
	startupInfo.ProcThreadAttributeList = attributes.List()

	processInfo := windows.ProcessInformation{}
	creationFlags := uint32(
		windows.CREATE_SUSPENDED |
			windows.CREATE_UNICODE_ENVIRONMENT |
			windows.CREATE_NO_WINDOW |
			windows.EXTENDED_STARTUPINFO_PRESENT,
	)
	if err := windows.CreateProcess(
		executableUTF16,
		&commandLineUTF16[0],
		nil,
		nil,
		true,
		creationFlags,
		&environment[0],
		workingDirectoryUTF16,
		&startupInfo.StartupInfo,
		&processInfo,
	); err != nil {
		return nil, fmt.Errorf("CreateProcessW: %w", err)
	}
	runtime.KeepAlive(childHandles)
	runtime.KeepAlive(jobHandles)

	for _, handle := range childHandles {
		_ = windows.CloseHandle(handle)
	}
	childHandles = nil

	processOwned := true
	threadOwned := true
	defer func() {
		if threadOwned {
			_ = windows.CloseHandle(processInfo.Thread)
		}
		if processOwned {
			_ = windows.TerminateProcess(processInfo.Process, terminationExitCode)
			_ = windows.CloseHandle(processInfo.Process)
		}
	}()

	var processCreationTimeFileTime uint64
	if spec.CaptureProcessIdentity {
		processCreationTimeFileTime, err = readProcessCreationTimeFileTime(processInfo.Process)
		if err != nil {
			return nil, err
		}
	}

	if _, err := windows.ResumeThread(processInfo.Thread); err != nil {
		_ = windows.TerminateJobObject(job, terminationExitCode)
		return nil, fmt.Errorf("resume assigned process: %w", err)
	}
	if err := windows.CloseHandle(processInfo.Thread); err != nil {
		_ = windows.TerminateJobObject(job, terminationExitCode)
		return nil, fmt.Errorf("close primary thread handle: %w", err)
	}
	threadOwned = false

	processOwned = false
	jobOwned = false
	cleanupPipes = false
	return &windowsProcess{
		processID:                   processInfo.ProcessId,
		processCreationTimeFileTime: processCreationTimeFileTime,
		process:                     processInfo.Process,
		job:                         job,
		standardInput:               stdinParent,
		standardOutput:              stdoutParent,
		standardError:               stderrParent,
	}, nil
}

func readProcessCreationTimeFileTime(process windows.Handle) (uint64, error) {
	var creationTime, exitTime, kernelTime, userTime windows.Filetime
	if err := windows.GetProcessTimes(process, &creationTime, &exitTime, &kernelTime, &userTime); err != nil {
		return 0, fmt.Errorf("%w: GetProcessTimes: %w", errProcessIdentityQueryFailed, err)
	}
	value := uint64(creationTime.HighDateTime)<<32 | uint64(creationTime.LowDateTime)
	if value == 0 {
		return 0, fmt.Errorf("%w: GetProcessTimes returned a zero creation time", errProcessIdentityQueryFailed)
	}
	return value, nil
}

func createLimitedJob(limits protocol.EffectiveLimits) (windows.Handle, error) {
	if uint64(uintptr(limits.MaximumMemoryBytes)) != limits.MaximumMemoryBytes {
		return 0, errors.New("memory limit cannot be represented on this Windows architecture")
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, fmt.Errorf("create Job Object: %w", err)
	}
	information := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	information.BasicLimitInformation.LimitFlags =
		windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
			windows.JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
			windows.JOB_OBJECT_LIMIT_PROCESS_MEMORY |
			windows.JOB_OBJECT_LIMIT_JOB_MEMORY
	information.BasicLimitInformation.ActiveProcessLimit = limits.MaximumProcessCount
	information.ProcessMemoryLimit = uintptr(limits.MaximumMemoryBytes)
	information.JobMemoryLimit = uintptr(limits.MaximumMemoryBytes)
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&information)),
		uint32(unsafe.Sizeof(information)),
	); err != nil {
		_ = windows.CloseHandle(job)
		return 0, fmt.Errorf("set Job Object limits: %w", err)
	}
	return job, nil
}

func createPipe(parentReads bool, name string) (*os.File, windows.Handle, error) {
	securityAttributes := windows.SecurityAttributes{
		Length:        uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		InheritHandle: 1,
	}
	var readHandle windows.Handle
	var writeHandle windows.Handle
	if err := windows.CreatePipe(&readHandle, &writeHandle, &securityAttributes, 0); err != nil {
		return nil, 0, err
	}

	parentHandle := writeHandle
	childHandle := readHandle
	if parentReads {
		parentHandle = readHandle
		childHandle = writeHandle
	}
	if err := windows.SetHandleInformation(parentHandle, windows.HANDLE_FLAG_INHERIT, 0); err != nil {
		_ = windows.CloseHandle(readHandle)
		_ = windows.CloseHandle(writeHandle)
		return nil, 0, err
	}
	return os.NewFile(uintptr(parentHandle), name), childHandle, nil
}

func buildEnvironmentBlock(environment map[string]string) ([]uint16, error) {
	names := make([]string, 0, len(environment))
	for name := range environment {
		names = append(names, name)
	}
	sort.Slice(names, func(left, right int) bool {
		return strings.ToUpper(names[left]) < strings.ToUpper(names[right])
	})

	block := make([]uint16, 0, 1024)
	for _, name := range names {
		entry, err := windows.UTF16FromString(name + "=" + environment[name])
		if err != nil {
			return nil, fmt.Errorf("encode environment variable %s: %w", name, err)
		}
		block = append(block, entry...)
	}
	if len(block) == 0 {
		return []uint16{0, 0}, nil
	}
	return append(block, 0), nil
}

func validateRuntimePath(path string, executable bool) (string, error) {
	path = strings.ReplaceAll(path, "/", `\`)
	path = filepath.Clean(path)
	if err := protocol.ValidateWindowsLocalAbsolutePath(path, executable); err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", fmt.Errorf("resolve path: %w", err)
	}
	resolved = filepath.Clean(resolved)
	if err := protocol.ValidateWindowsLocalAbsolutePath(resolved, executable); err != nil {
		return "", fmt.Errorf("resolved path: %w", err)
	}
	root, err := windows.UTF16PtrFromString(resolved[:3])
	if err != nil {
		return "", fmt.Errorf("encode volume root: %w", err)
	}
	if driveType := windows.GetDriveType(root); driveType != windows.DRIVE_FIXED {
		return "", fmt.Errorf("path must resolve to a fixed local drive, got drive type %d", driveType)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", fmt.Errorf("stat path: %w", err)
	}
	if executable && !info.Mode().IsRegular() {
		return "", errors.New("executable path is not a regular file")
	}
	if !executable && !info.IsDir() {
		return "", errors.New("working directory path is not a directory")
	}
	return resolved, nil
}

type windowsProcess struct {
	processID                   uint32
	processCreationTimeFileTime uint64
	process                     windows.Handle
	job                         windows.Handle
	standardInput               *os.File
	standardOutput              *os.File
	standardError               *os.File

	jobMu                sync.Mutex
	rootExited           bool
	terminationInitiated bool
	closeOnce            sync.Once
	closeErr             error
}

func (p *windowsProcess) ProcessID() uint32                   { return p.processID }
func (p *windowsProcess) ProcessCreationTimeFileTime() uint64 { return p.processCreationTimeFileTime }
func (p *windowsProcess) StandardInput() io.WriteCloser       { return p.standardInput }
func (p *windowsProcess) StandardOutput() io.ReadCloser       { return p.standardOutput }
func (p *windowsProcess) StandardError() io.ReadCloser        { return p.standardError }

func (p *windowsProcess) Wait() (*int64, error) {
	status, err := windows.WaitForSingleObject(p.process, windows.INFINITE)
	if err != nil {
		cleanupErr := p.cleanupJob()
		p.closeIOAfterCleanupFailure()
		return nil, errors.Join(err, cleanupErr)
	}
	if status != windows.WAIT_OBJECT_0 {
		cleanupErr := p.cleanupJob()
		p.closeIOAfterCleanupFailure()
		return nil, errors.Join(fmt.Errorf("unexpected process wait status 0x%x", status), cleanupErr)
	}

	p.jobMu.Lock()
	p.rootExited = true
	drainErr := p.terminateAndDrainJobLocked()
	closeJobErr := p.closeJobLocked()
	p.jobMu.Unlock()
	if drainErr != nil || closeJobErr != nil {
		p.closeIOAfterCleanupFailure()
	}

	var exitCode uint32
	if err := windows.GetExitCodeProcess(p.process, &exitCode); err != nil {
		return nil, errors.Join(err, drainErr, closeJobErr)
	}
	value := int64(exitCode)
	return &value, errors.Join(drainErr, closeJobErr)
}

func (p *windowsProcess) Terminate() error {
	p.jobMu.Lock()
	defer p.jobMu.Unlock()

	alreadyExited, err := p.rootExitedLocked()
	if err != nil {
		return err
	}
	if err := p.beginTerminationLocked(); err != nil {
		return err
	}
	if alreadyExited {
		return errProcessAlreadyExited
	}
	return nil
}

func (p *windowsProcess) rootExitedLocked() (bool, error) {
	if p.rootExited {
		return true, nil
	}
	status, err := windows.WaitForSingleObject(p.process, 0)
	if err != nil {
		return false, fmt.Errorf("inspect root process state: %w", err)
	}
	switch status {
	case windows.WAIT_OBJECT_0:
		p.rootExited = true
		return true, nil
	case uint32(windows.WAIT_TIMEOUT):
		return false, nil
	default:
		return false, fmt.Errorf("unexpected root process poll status 0x%x", status)
	}
}

func (p *windowsProcess) beginTerminationLocked() error {
	if p.job == 0 || p.terminationInitiated {
		return nil
	}
	counter := windowsJobCounter{job: p.job}
	active, err := counter.ActiveProcessCount()
	if err != nil {
		return fmt.Errorf("query Job Object before termination: %w", err)
	}
	if active > 0 {
		if err := windows.TerminateJobObject(p.job, terminationExitCode); err != nil {
			return fmt.Errorf("terminate Job Object: %w", err)
		}
	}
	p.terminationInitiated = true
	return nil
}

func (p *windowsProcess) terminateAndDrainJobLocked() error {
	if p.job == 0 {
		return nil
	}
	if err := p.beginTerminationLocked(); err != nil {
		return err
	}
	return waitForNoActiveProcesses(
		windowsJobCounter{job: p.job},
		15*time.Second,
		10*time.Millisecond,
		wallDrainClock{},
	)
}

func (p *windowsProcess) cleanupJob() error {
	p.jobMu.Lock()
	defer p.jobMu.Unlock()
	drainErr := p.terminateAndDrainJobLocked()
	closeErr := p.closeJobLocked()
	return errors.Join(drainErr, closeErr)

}

func (p *windowsProcess) closeJobLocked() error {
	if p.job == 0 {
		return nil
	}
	if err := windows.CloseHandle(p.job); err != nil {
		return fmt.Errorf("close Job Object: %w", err)
	}
	p.job = 0
	return nil
}

func (p *windowsProcess) closeIOAfterCleanupFailure() {
	_ = closeFile(p.standardInput)
	_ = closeFile(p.standardOutput)
	_ = closeFile(p.standardError)
}

func (p *windowsProcess) Close() error {
	p.closeOnce.Do(func() {
		cleanupErr := p.cleanupJob()
		if cleanupErr != nil {
			p.closeIOAfterCleanupFailure()
		}
		p.closeErr = errors.Join(
			cleanupErr,
			closeFile(p.standardInput),
			closeFile(p.standardOutput),
			closeFile(p.standardError),
			windows.CloseHandle(p.process),
		)
	})
	return p.closeErr
}

type jobObjectBasicAccountingInformation struct {
	TotalUserTime             int64
	TotalKernelTime           int64
	ThisPeriodTotalUserTime   int64
	ThisPeriodTotalKernelTime int64
	TotalPageFaultCount       uint32
	TotalProcesses            uint32
	ActiveProcesses           uint32
	TotalTerminatedProcesses  uint32
}

type windowsJobCounter struct {
	job windows.Handle
}

func (c windowsJobCounter) ActiveProcessCount() (uint32, error) {
	information := jobObjectBasicAccountingInformation{}
	if err := windows.QueryInformationJobObject(
		c.job,
		int32(windows.JobObjectBasicAccountingInformation),
		uintptr(unsafe.Pointer(&information)),
		uint32(unsafe.Sizeof(information)),
		nil,
	); err != nil {
		return 0, err
	}
	return information.ActiveProcesses, nil
}

func closeFile(file *os.File) error {
	err := file.Close()
	if errors.Is(err, os.ErrClosed) {
		return nil
	}
	return err
}
