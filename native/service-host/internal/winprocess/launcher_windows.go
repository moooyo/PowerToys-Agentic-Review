//go:build windows

package winprocess

import (
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	terminationExitCode uint32 = 0xC000013A
	// ProcThreadAttributeValue(ProcThreadAttributeJobList, false, true, false).
	procThreadAttributeJobList uintptr = 0x0002000D
	jobDrainPollInterval               = 10 * time.Millisecond
	failedLaunchWait                   = 5 * time.Second
)

// LaunchNode starts exactly one reviewed Node executable and bundle in a new
// non-breakaway service-root Job Object.
func LaunchNode(spec NodeLaunchSpec) (node NodeProcess, err error) {
	if err := validateLaunchSpec(spec); err != nil {
		return nil, err
	}
	if uint64(uintptr(spec.MaximumMemoryBytes)) != spec.MaximumMemoryBytes {
		return nil, errors.New("root Job memory limit cannot be represented on this Windows architecture")
	}
	protectedDACLs, err := prepareNodeDACLs(spec)
	if err != nil {
		return nil, err
	}

	arguments := fixedNodeArguments(spec.Role, spec.BundlePath)
	commandLine := windows.ComposeCommandLine(append([]string{spec.ExecutablePath}, arguments...))
	commandLineUTF16, err := windows.UTF16FromString(commandLine)
	if err != nil {
		return nil, fmt.Errorf("encode fixed Node command line: %w", err)
	}
	if len(commandLineUTF16) > 32_767 {
		return nil, errors.New("fixed Node command line exceeds the Windows UTF-16 limit")
	}
	executableUTF16, err := windows.UTF16PtrFromString(spec.ExecutablePath)
	if err != nil {
		return nil, fmt.Errorf("encode Node executable path: %w", err)
	}
	workingDirectoryUTF16, err := windows.UTF16PtrFromString(spec.WorkingDirectory)
	if err != nil {
		return nil, fmt.Errorf("encode Node working directory: %w", err)
	}
	environment, err := buildEnvironmentBlock(spec.Environment)
	if err != nil {
		return nil, err
	}

	var parentFiles []*os.File
	var childHandles []windows.Handle
	var job windows.Handle
	processInfo := windows.ProcessInformation{}
	launchComplete := false
	defer func() {
		if launchComplete {
			return
		}
		cleanupErr := cleanupFailedLaunch(job, processInfo)
		for _, handle := range childHandles {
			cleanupErr = errors.Join(cleanupErr, closeHandle(handle, "close child standard-I/O handle"))
		}
		for _, file := range parentFiles {
			cleanupErr = errors.Join(cleanupErr, closeFile(file))
		}
		err = errors.Join(err, cleanupErr)
	}()

	stdinParent, stdinChild, err := createStdioPipe(false, "service-node-stdin")
	if err != nil {
		return nil, fmt.Errorf("create Node stdin pipe: %w", err)
	}
	parentFiles = append(parentFiles, stdinParent)
	childHandles = append(childHandles, stdinChild)
	stdoutParent, stdoutChild, err := createStdioPipe(true, "service-node-stdout")
	if err != nil {
		return nil, fmt.Errorf("create Node stdout pipe: %w", err)
	}
	parentFiles = append(parentFiles, stdoutParent)
	childHandles = append(childHandles, stdoutChild)
	stderrParent, stderrChild, err := createStdioPipe(true, "service-node-stderr")
	if err != nil {
		return nil, fmt.Errorf("create Node stderr pipe: %w", err)
	}
	parentFiles = append(parentFiles, stderrParent)
	childHandles = append(childHandles, stderrChild)

	job, err = createRootJob(spec.MaximumProcesses, uintptr(spec.MaximumMemoryBytes))
	if err != nil {
		return nil, err
	}

	attributes := requiredProcessCreationAttributes()
	attributeList, err := windows.NewProcThreadAttributeList(uint32(len(attributes)))
	if err != nil {
		return nil, fmt.Errorf("allocate Node process attribute list: %w", err)
	}
	defer attributeList.Delete()
	jobHandles := []windows.Handle{job}
	for _, attribute := range attributes {
		switch attribute {
		case attributeHandleList:
			if len(childHandles) != 3 {
				return nil, fmt.Errorf("Node must inherit exactly three standard-I/O handles, got %d", len(childHandles))
			}
			if err := attributeList.Update(
				windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
				unsafe.Pointer(&childHandles[0]),
				unsafe.Sizeof(childHandles[0])*uintptr(len(childHandles)),
			); err != nil {
				return nil, fmt.Errorf("restrict inherited Node handles: %w", err)
			}
		case attributeJobList:
			if err := attributeList.Update(
				procThreadAttributeJobList,
				unsafe.Pointer(&jobHandles[0]),
				unsafe.Sizeof(jobHandles[0]),
			); err != nil {
				return nil, fmt.Errorf("configure atomic service-root Job assignment: %w", err)
			}
		default:
			return nil, fmt.Errorf("unsupported Node creation attribute %d", attribute)
		}
	}

	startupInfo := windows.StartupInfoEx{}
	startupInfo.Cb = uint32(unsafe.Sizeof(startupInfo))
	startupInfo.Flags = windows.STARTF_USESTDHANDLES
	startupInfo.StdInput = stdinChild
	startupInfo.StdOutput = stdoutChild
	startupInfo.StdErr = stderrChild
	startupInfo.ProcThreadAttributeList = attributeList.List()

	if err := windows.CreateProcess(
		executableUTF16,
		&commandLineUTF16[0],
		nil,
		nil,
		true,
		requiredProcessCreationFlags,
		&environment[0],
		workingDirectoryUTF16,
		&startupInfo.StartupInfo,
		&processInfo,
	); err != nil {
		return nil, fmt.Errorf("CreateProcessW for fixed Node payload: %w", err)
	}
	runtime.KeepAlive(childHandles)
	runtime.KeepAlive(jobHandles)
	if err := applyAndVerifyNodeDACLs(processInfo.Process, protectedDACLs); err != nil {
		return nil, err
	}

	if err := closeChildHandles(childHandles); err != nil {
		return nil, err
	}
	childHandles = nil

	if err := verifyRootJobBeforeResume(
		job,
		processInfo.ProcessId,
		spec.MaximumProcesses,
		uintptr(spec.MaximumMemoryBytes),
	); err != nil {
		return nil, err
	}
	previousSuspendCount, err := windows.ResumeThread(processInfo.Thread)
	if err != nil {
		return nil, fmt.Errorf("resume verified Node process: %w", err)
	}
	if previousSuspendCount != 1 {
		return nil, fmt.Errorf("resume verified Node process returned suspend count %d, want 1", previousSuspendCount)
	}
	if err := windows.CloseHandle(processInfo.Thread); err != nil {
		return nil, fmt.Errorf("close Node primary thread handle: %w", err)
	}
	processInfo.Thread = 0

	result := &windowsNodeProcess{
		processID:       processInfo.ProcessId,
		process:         processInfo.Process,
		job:             job,
		standardInput:   stdinParent,
		standardOutput:  stdoutParent,
		standardError:   stderrParent,
		shutdownTimeout: spec.ShutdownTimeout,
	}
	processInfo.Process = 0
	job = 0
	parentFiles = nil
	launchComplete = true
	return result, nil
}

func createRootJob(maximumProcesses uint32, maximumMemory uintptr) (windows.Handle, error) {
	if err := validateRootJobLimitFlags(rootJobRequiredLimitFlags); err != nil {
		return 0, err
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, fmt.Errorf("create service-root Job Object: %w", err)
	}
	information := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	information.BasicLimitInformation.LimitFlags = rootJobRequiredLimitFlags
	information.BasicLimitInformation.ActiveProcessLimit = maximumProcesses
	information.ProcessMemoryLimit = maximumMemory
	information.JobMemoryLimit = maximumMemory
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&information)),
		uint32(unsafe.Sizeof(information)),
	); err != nil {
		_ = windows.CloseHandle(job)
		return 0, fmt.Errorf("set service-root Job limits: %w", err)
	}
	if err := verifyRootJobLimits(job, maximumProcesses, maximumMemory); err != nil {
		_ = windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}

func verifyRootJobBeforeResume(
	job windows.Handle,
	processID uint32,
	maximumProcesses uint32,
	maximumMemory uintptr,
) error {
	if err := verifyRootJobLimits(job, maximumProcesses, maximumMemory); err != nil {
		return fmt.Errorf("verify service-root Job before resume: %w", err)
	}
	if err := verifyOnlyJobMember(job, processID, maximumProcesses); err != nil {
		return fmt.Errorf("verify atomic service-root Job membership before resume: %w", err)
	}
	accounting := windowsJobCounter{job: job}
	active, err := accounting.ActiveProcessCount()
	if err != nil {
		return fmt.Errorf("query active service-root Job count before resume: %w", err)
	}
	if active != 1 {
		return fmt.Errorf("service-root Job active process count is %d before resume, want 1", active)
	}
	return nil
}

func verifyRootJobLimits(job windows.Handle, maximumProcesses uint32, maximumMemory uintptr) error {
	information := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	if err := windows.QueryInformationJobObject(
		job,
		int32(windows.JobObjectExtendedLimitInformation),
		uintptr(unsafe.Pointer(&information)),
		uint32(unsafe.Sizeof(information)),
		nil,
	); err != nil {
		return fmt.Errorf("read back service-root Job limits: %w", err)
	}
	flags := information.BasicLimitInformation.LimitFlags
	if err := validateRootJobLimitFlags(flags); err != nil {
		return err
	}
	if flags != rootJobRequiredLimitFlags {
		return fmt.Errorf("service-root Job limit flags are 0x%x, want exactly 0x%x", flags, rootJobRequiredLimitFlags)
	}
	if information.BasicLimitInformation.ActiveProcessLimit != maximumProcesses {
		return fmt.Errorf(
			"service-root Job process limit is %d, want %d",
			information.BasicLimitInformation.ActiveProcessLimit,
			maximumProcesses,
		)
	}
	if information.ProcessMemoryLimit != maximumMemory || information.JobMemoryLimit != maximumMemory {
		return fmt.Errorf(
			"service-root Job memory limits are process=%d job=%d, want %d",
			information.ProcessMemoryLimit,
			information.JobMemoryLimit,
			maximumMemory,
		)
	}
	return nil
}

func verifyOnlyJobMember(job windows.Handle, processID uint32, maximumProcesses uint32) error {
	pointerSize := int(unsafe.Sizeof(uintptr(0)))
	buffer := make([]byte, 8+int(maximumProcesses)*pointerSize)
	if err := windows.QueryInformationJobObject(
		job,
		int32(windows.JobObjectBasicProcessIdList),
		uintptr(unsafe.Pointer(&buffer[0])),
		uint32(len(buffer)),
		nil,
	); err != nil {
		return fmt.Errorf("query service-root Job process list: %w", err)
	}
	assigned := *(*uint32)(unsafe.Pointer(&buffer[0]))
	listed := *(*uint32)(unsafe.Pointer(&buffer[4]))
	if assigned != 1 || listed != 1 {
		return fmt.Errorf("service-root Job contains assigned=%d listed=%d processes before resume, want 1", assigned, listed)
	}
	listedProcessID := *(*uintptr)(unsafe.Pointer(&buffer[8]))
	if listedProcessID != uintptr(processID) {
		return fmt.Errorf("service-root Job member PID is %d, want Node PID %d", listedProcessID, processID)
	}
	return nil
}

func createStdioPipe(parentReads bool, name string) (*os.File, windows.Handle, error) {
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

func closeChildHandles(handles []windows.Handle) error {
	var result error
	for index, handle := range handles {
		if err := closeHandle(handle, "close inherited Node standard-I/O handle"); err != nil {
			result = errors.Join(result, err)
			continue
		}
		handles[index] = 0
	}
	return result
}

func cleanupFailedLaunch(job windows.Handle, processInfo windows.ProcessInformation) error {
	var result error
	jobTerminated := false
	if job != 0 {
		if err := windows.TerminateJobObject(job, terminationExitCode); err != nil {
			result = errors.Join(result, fmt.Errorf("terminate service-root Job after launch failure: %w", err))
		} else {
			jobTerminated = true
		}
	}
	if processInfo.Process != 0 {
		if err := windows.TerminateProcess(processInfo.Process, terminationExitCode); err != nil && !jobTerminated {
			result = errors.Join(result, fmt.Errorf("terminate suspended Node after launch failure: %w", err))
		}
	}
	if processInfo.Process != 0 {
		status, err := windows.WaitForSingleObject(processInfo.Process, uint32(failedLaunchWait/time.Millisecond))
		if err != nil {
			result = errors.Join(result, fmt.Errorf("wait for failed Node launch cleanup: %w", err))
		} else if status != windows.WAIT_OBJECT_0 {
			result = errors.Join(result, fmt.Errorf("failed Node launch cleanup wait returned 0x%x", status))
		}
	}
	result = errors.Join(
		result,
		closeHandle(processInfo.Thread, "close failed Node primary thread handle"),
		closeHandle(processInfo.Process, "close failed Node process handle"),
		closeHandle(job, "close failed service-root Job handle"),
	)
	return result
}

type windowsNodeProcess struct {
	processID       uint32
	process         windows.Handle
	job             windows.Handle
	standardInput   *os.File
	standardOutput  *os.File
	standardError   *os.File
	shutdownTimeout time.Duration

	jobMu                sync.Mutex
	terminationInitiated bool
	closeOnce            sync.Once
	closeErr             error
}

func (p *windowsNodeProcess) ProcessID() uint32             { return p.processID }
func (p *windowsNodeProcess) StandardInput() io.WriteCloser { return p.standardInput }
func (p *windowsNodeProcess) StandardOutput() io.ReadCloser { return p.standardOutput }
func (p *windowsNodeProcess) StandardError() io.ReadCloser  { return p.standardError }

func (p *windowsNodeProcess) Wait() (uint32, error) {
	status, waitErr := windows.WaitForSingleObject(p.process, windows.INFINITE)
	if waitErr == nil && status != windows.WAIT_OBJECT_0 {
		waitErr = fmt.Errorf("Node process wait returned 0x%x", status)
	}
	var exitCode uint32
	exitErr := windows.GetExitCodeProcess(p.process, &exitCode)

	p.jobMu.Lock()
	jobCleanupErr := drainThenCloseJob(p.terminateAndDrainJobLocked, p.closeJobLocked)
	p.jobMu.Unlock()
	if waitErr != nil || jobCleanupErr != nil {
		_ = closeFile(p.standardInput)
		_ = closeFile(p.standardOutput)
		_ = closeFile(p.standardError)
	}
	return exitCode, errors.Join(waitErr, exitErr, jobCleanupErr)
}

func (p *windowsNodeProcess) Terminate() error {
	p.jobMu.Lock()
	defer p.jobMu.Unlock()
	return drainThenCloseJob(p.terminateAndDrainJobLocked, p.closeJobLocked)
}

func (p *windowsNodeProcess) terminateAndDrainJobLocked() error {
	if p.job == 0 {
		return nil
	}
	if !p.terminationInitiated {
		if err := windows.TerminateJobObject(p.job, terminationExitCode); err != nil {
			return fmt.Errorf("terminate service-root Job: %w", err)
		}
		p.terminationInitiated = true
	}
	return waitForNoActiveProcesses(
		windowsJobCounter{job: p.job},
		p.shutdownTimeout,
		jobDrainPollInterval,
		wallDrainClock{},
	)
}

func (p *windowsNodeProcess) closeJobLocked() error {
	if p.job == 0 {
		return nil
	}
	if err := windows.CloseHandle(p.job); err != nil {
		return fmt.Errorf("close service-root Job handle: %w", err)
	}
	p.job = 0
	return nil
}

func (p *windowsNodeProcess) Close() error {
	p.closeOnce.Do(func() {
		p.jobMu.Lock()
		drainErr := p.terminateAndDrainJobLocked()
		closeJobErr := p.closeJobLocked()
		p.jobMu.Unlock()
		p.closeErr = errors.Join(
			drainErr,
			closeJobErr,
			closeFile(p.standardInput),
			closeFile(p.standardOutput),
			closeFile(p.standardError),
			closeHandle(p.process, "close Node process handle"),
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

func closeHandle(handle windows.Handle, operation string) error {
	if handle == 0 {
		return nil
	}
	if err := windows.CloseHandle(handle); err != nil {
		return fmt.Errorf("%s: %w", operation, err)
	}
	return nil
}

func closeFile(file *os.File) error {
	if file == nil {
		return nil
	}
	err := file.Close()
	if errors.Is(err, os.ErrClosed) {
		return nil
	}
	return err
}
