//go:build windows

package winprocess

import (
	"context"
	"errors"
	"fmt"
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

type nodeDuplicateHandleFunc func(
	windows.Handle,
	windows.Handle,
	windows.Handle,
	*windows.Handle,
	uint32,
	bool,
	uint32,
) error

type nodeWaitForSingleObjectFunc func(windows.Handle, uint32) (uint32, error)
type nodeGetExitCodeProcessFunc func(windows.Handle, *uint32) error
type nodeCloseProcessHandleFunc func(windows.Handle) error

var processLaunchCleanupGate launchCleanupGate

// LaunchNode starts exactly one reviewed Node executable and bundle in a new
// non-breakaway service-root Job Object.
func LaunchNode(spec NodeLaunchSpec) (node NodeProcess, err error) {
	launchPermit, err := processLaunchCleanupGate.begin()
	if err != nil {
		return nil, err
	}
	defer launchPermit.release()

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

	arguments := fixedNodeArguments(spec.Role, spec.BundlePath, spec.HostControlPipeName)
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

	var parentStreams []*windowsStandardIOStream
	var childHandles []windows.Handle
	var job windows.Handle
	processInfo := windows.ProcessInformation{}
	launchComplete := false
	defer func() {
		if launchComplete {
			return
		}
		var cleanup launchCleanupReport
		cleanup.merge(cleanupFailedLaunch(job, processInfo))
		for index, handle := range childHandles {
			if handle == 0 {
				continue
			}
			closeErr := consumeWindowsHandle(
				"close child standard-I/O handle",
				handle,
				windows.CloseHandle,
				windowsProcessLifetimeQuarantine,
			)
			childHandles[index] = 0
			if closeErr != nil {
				cleanup.addUnresolved(closeErr)
			}
		}
		for index, stream := range parentStreams {
			if stream == nil {
				continue
			}
			closeErr := stream.Close()
			parentStreams[index] = nil
			if closeErr != nil {
				cleanup.addUnresolved(windowsProcessLifetimeQuarantine.retain(stream, closeErr))
			}
		}
		cleanupErr := cleanup.result()
		if errors.Is(err, ErrLaunchCleanupFatal) || errors.Is(cleanupErr, ErrLaunchCleanupFatal) {
			launchPermit.markFatal()
		}
		err = errors.Join(err, cleanupErr)
	}()

	stdinParent, stdinChild, err := createStdioPipe(
		false,
		"service-node-stdin",
		spec.OwnServiceSID,
		spec.ShutdownTimeout,
	)
	if err != nil {
		return nil, fmt.Errorf("create Node stdin pipe: %w", err)
	}
	parentStreams = append(parentStreams, stdinParent)
	childHandles = append(childHandles, stdinChild)
	stdoutParent, stdoutChild, err := createStdioPipe(
		true,
		"service-node-stdout",
		spec.OwnServiceSID,
		spec.ShutdownTimeout,
	)
	if err != nil {
		return nil, fmt.Errorf("create Node stdout pipe: %w", err)
	}
	parentStreams = append(parentStreams, stdoutParent)
	childHandles = append(childHandles, stdoutChild)
	stderrParent, stderrChild, err := createStdioPipe(
		true,
		"service-node-stderr",
		spec.OwnServiceSID,
		spec.ShutdownTimeout,
	)
	if err != nil {
		return nil, fmt.Errorf("create Node stderr pipe: %w", err)
	}
	parentStreams = append(parentStreams, stderrParent)
	childHandles = append(childHandles, stderrChild)

	job, err = createRootJob(preHostControlProcessLimit, uintptr(spec.MaximumMemoryBytes))
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

	if err := launchPermit.check(); err != nil {
		return nil, err
	}
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
		var outputErr error
		for _, output := range []struct {
			kind   string
			handle *windows.Handle
		}{
			{kind: "untrusted Node process handle", handle: &processInfo.Process},
			{kind: "untrusted Node primary thread handle", handle: &processInfo.Thread},
		} {
			if *output.handle != 0 && *output.handle != windows.InvalidHandle {
				outputErr = errors.Join(outputErr, windowsProcessLifetimeQuarantine.retain(
					&windowsRawHandleOwner{kind: output.kind, value: *output.handle},
					errors.New("CreateProcess failed after writing an untrusted output handle"),
				))
			}
			*output.handle = 0
		}
		return nil, errors.Join(fmt.Errorf("CreateProcessW for fixed Node payload: %w", err), outputErr)
	}
	if processInfo.Process == 0 || processInfo.Process == windows.InvalidHandle ||
		processInfo.Thread == 0 || processInfo.Thread == windows.InvalidHandle {
		if processInfo.Process == windows.InvalidHandle {
			processInfo.Process = 0
		}
		if processInfo.Thread == windows.InvalidHandle {
			processInfo.Thread = 0
		}
		return nil, fatalLaunchCleanupError(errors.New("CreateProcess returned invalid process ownership handles"))
	}
	runtime.KeepAlive(childHandles)
	runtime.KeepAlive(jobHandles)
	if err := applyAndVerifyNodeDACLs(processInfo.Process, protectedDACLs); err != nil {
		if errors.Is(err, windows.ERROR_INVALID_HANDLE) && !errors.Is(err, ErrLaunchCleanupFatal) {
			process := processInfo.Process
			processInfo.Process = 0
			return nil, windowsProcessLifetimeQuarantine.retain(
				&windowsRawHandleOwner{kind: "Node process handle during DACL protection", value: process},
				err,
			)
		}
		return nil, err
	}

	if err := closeChildHandles(childHandles); err != nil {
		return nil, err
	}
	childHandles = nil

	if err := verifyRootJobBeforeResume(
		job,
		processInfo.ProcessId,
		preHostControlProcessLimit,
		uintptr(spec.MaximumMemoryBytes),
	); err != nil {
		if errors.Is(err, windows.ERROR_INVALID_HANDLE) {
			invalidJob := job
			job = 0
			return nil, windowsProcessLifetimeQuarantine.retain(
				&windowsRawHandleOwner{kind: "service-root Job handle before resume", value: invalidJob},
				err,
			)
		}
		return nil, err
	}
	stableIdentity, err := observeNodeIdentity(processInfo.Process, processInfo.ProcessId)
	if err != nil {
		if errors.Is(err, windows.ERROR_INVALID_HANDLE) {
			invalidProcess := processInfo.Process
			processInfo.Process = 0
			return nil, windowsProcessLifetimeQuarantine.retain(
				&windowsRawHandleOwner{kind: "Node process handle before resume", value: invalidProcess},
				err,
			)
		}
		return nil, fmt.Errorf("capture suspended Node identity before resume: %w", err)
	}
	if err := launchPermit.check(); err != nil {
		return nil, err
	}
	previousSuspendCount, err := windows.ResumeThread(processInfo.Thread)
	if err != nil {
		if errors.Is(err, windows.ERROR_INVALID_HANDLE) {
			thread := processInfo.Thread
			processInfo.Thread = 0
			return nil, windowsProcessLifetimeQuarantine.retain(
				&windowsRawHandleOwner{kind: "Node primary thread handle", value: thread},
				err,
			)
		}
		return nil, fmt.Errorf("resume verified Node process: %w", err)
	}
	if previousSuspendCount != 1 {
		return nil, fmt.Errorf("resume verified Node process returned suspend count %d, want 1", previousSuspendCount)
	}
	thread := processInfo.Thread
	threadCloseErr := consumeWindowsHandle(
		"close Node primary thread handle",
		thread,
		windows.CloseHandle,
		windowsProcessLifetimeQuarantine,
	)
	processInfo.Thread = 0
	if threadCloseErr != nil {
		return nil, threadCloseErr
	}

	result := &windowsNodeProcess{
		processID:        processInfo.ProcessId,
		process:          processInfo.Process,
		job:              job,
		standardIO:       newStandardIOOwnership(newNodeStandardIO(stdinParent, stdoutParent, stderrParent)),
		shutdownTimeout:  spec.ShutdownTimeout,
		stableIdentity:   stableIdentity,
		maximumProcesses: spec.MaximumProcesses,
		maximumMemory:    uintptr(spec.MaximumMemoryBytes),
	}
	if err := launchPermit.commit(func() {
		processInfo.Process = 0
		job = 0
		parentStreams = nil
		launchComplete = true
	}); err != nil {
		return nil, err
	}
	return result, nil
}

func createRootJob(maximumProcesses uint32, maximumMemory uintptr) (windows.Handle, error) {
	if err := validateRootJobLimitFlags(rootJobRequiredLimitFlags); err != nil {
		return 0, err
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		if job != 0 && job != windows.InvalidHandle {
			outputErr := windowsProcessLifetimeQuarantine.retain(
				&windowsRawHandleOwner{kind: "untrusted service-root Job handle", value: job},
				errors.New("CreateJobObject failed after writing an untrusted output handle"),
			)
			return 0, errors.Join(fmt.Errorf("create service-root Job Object: %w", err), outputErr)
		}
		return 0, fmt.Errorf("create service-root Job Object: %w", err)
	}
	if job == 0 || job == windows.InvalidHandle {
		return 0, windowsProcessLifetimeQuarantine.retain(
			&windowsRawHandleOwner{kind: "invalid service-root Job handle", value: job},
			errors.New("CreateJobObject returned an invalid handle without an error"),
		)
	}
	if err := validateCreatedLaunchResource(
		[]func() error{
			func() error { return setRootJobLimits(job, maximumProcesses, maximumMemory) },
			func() error { return verifyRootJobLimits(job, maximumProcesses, maximumMemory) },
		},
		func(validationErr error) error {
			if errors.Is(validationErr, windows.ERROR_INVALID_HANDLE) {
				return windowsProcessLifetimeQuarantine.retain(
					&windowsRawHandleOwner{kind: "rejected service-root Job handle", value: job},
					validationErr,
				)
			}
			return consumeWindowsHandle(
				"close rejected service-root Job handle",
				job,
				windows.CloseHandle,
				windowsProcessLifetimeQuarantine,
			)
		},
	); err != nil {
		return 0, err
	}
	return job, nil
}

func setRootJobLimits(job windows.Handle, maximumProcesses uint32, maximumMemory uintptr) error {
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
		return fmt.Errorf("set service-root Job limits: %w", err)
	}
	return nil
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
	accounting, err := queryWindowsJobAccounting(job)
	if err != nil {
		return fmt.Errorf("query service-root Job accounting before resume: %w", err)
	}
	if err := validateSingleNodeJobAccounting(accounting.TotalProcesses, accounting.ActiveProcesses); err != nil {
		return fmt.Errorf("verify service-root Job accounting before resume: %w", err)
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

func closeChildHandles(handles []windows.Handle) error {
	var result error
	for index, handle := range handles {
		closeErr := consumeWindowsHandle(
			"close inherited Node standard-I/O handle",
			handle,
			windows.CloseHandle,
			windowsProcessLifetimeQuarantine,
		)
		handles[index] = 0
		if closeErr != nil {
			result = errors.Join(result, closeErr)
		}
	}
	return result
}

func cleanupFailedLaunch(job windows.Handle, processInfo windows.ProcessInformation) launchCleanupReport {
	var report launchCleanupReport
	terminationRequested := false
	jobHandleUsable := job != 0
	processHandleUsable := processInfo.Process != 0
	if processHandleUsable && jobHandleUsable {
		jobTermination := retryNonConsumingLaunchCleanup("terminate service-root Job after launch failure", func() error {
			return windows.TerminateJobObject(job, terminationExitCode)
		})
		if jobTermination.invalidHandle {
			report.addUnresolved(windowsProcessLifetimeQuarantine.retain(
				&windowsRawHandleOwner{kind: "failed-launch service-root Job handle", value: job},
				jobTermination.err,
			))
			jobHandleUsable = false
		} else {
			report.addDiagnostics(jobTermination.err)
		}
		terminationRequested = jobTermination.succeeded
	}
	if processHandleUsable && !terminationRequested {
		processTermination := retryNonConsumingLaunchCleanup("terminate Node after launch failure", func() error {
			return windows.TerminateProcess(processInfo.Process, terminationExitCode)
		})
		if processTermination.invalidHandle {
			report.addUnresolved(windowsProcessLifetimeQuarantine.retain(
				&windowsRawHandleOwner{kind: "failed-launch Node process handle", value: processInfo.Process},
				processTermination.err,
			))
			processHandleUsable = false
		} else {
			report.addDiagnostics(processTermination.err)
		}
		terminationRequested = processTermination.succeeded
	}

	processExited := processInfo.Process == 0
	if processHandleUsable {
		status, waitErr := windows.WaitForSingleObject(
			processInfo.Process,
			uint32(failedLaunchWait/time.Millisecond),
		)
		switch {
		case waitErr != nil:
			if errors.Is(waitErr, windows.ERROR_INVALID_HANDLE) {
				report.addUnresolved(windowsProcessLifetimeQuarantine.retain(
					&windowsRawHandleOwner{kind: "failed-launch Node process handle", value: processInfo.Process},
					fmt.Errorf("wait for failed Node launch cleanup: %w", waitErr),
				))
				processHandleUsable = false
			} else {
				report.addUnresolved(fmt.Errorf("wait for failed Node launch cleanup: %w", waitErr))
			}
		case status != windows.WAIT_OBJECT_0:
			report.addUnresolved(fmt.Errorf("failed Node launch cleanup wait returned 0x%x", status))
		default:
			processExited = true
		}
	}
	if !terminationRequested && !processExited && processHandleUsable {
		report.addUnresolved(errors.New("failed Node launch did not accept a termination request"))
	}

	for _, resource := range []struct {
		label  string
		handle windows.Handle
	}{
		{label: "close failed Node primary thread handle", handle: processInfo.Thread},
		{label: "close failed Node process handle", handle: func() windows.Handle {
			if processHandleUsable {
				return processInfo.Process
			}
			return 0
		}()},
		{label: "close failed service-root Job handle", handle: func() windows.Handle {
			if jobHandleUsable {
				return job
			}
			return 0
		}()},
	} {
		if resource.handle == 0 {
			continue
		}
		if closeErr := consumeWindowsHandle(
			resource.label,
			resource.handle,
			windows.CloseHandle,
			windowsProcessLifetimeQuarantine,
		); closeErr != nil {
			report.addUnresolved(closeErr)
		}
	}
	return report
}

type windowsNodeProcess struct {
	processID        uint32
	process          windows.Handle
	job              windows.Handle
	standardIO       *standardIOOwnership
	shutdownTimeout  time.Duration
	stableIdentity   NodeIdentity
	maximumProcesses uint32
	maximumMemory    uintptr

	jobMu                sync.Mutex
	processMu            sync.RWMutex
	terminationInitiated bool
	hostControlActivated bool
	jobPoison            error
	processPoison        error
	closeMu              sync.Mutex

	duplicateHandle          nodeDuplicateHandleFunc
	waitForSingleObject      nodeWaitForSingleObjectFunc
	getExitCodeProcess       nodeGetExitCodeProcessFunc
	closeProcessNativeHandle nodeCloseProcessHandleFunc
}

func (p *windowsNodeProcess) ProcessID() uint32            { return p.processID }
func (p *windowsNodeProcess) StableIdentity() NodeIdentity { return p.stableIdentity }

func (p *windowsNodeProcess) TakeStandardIO() (*NodeStandardIO, error) {
	if p == nil {
		return nil, ErrStandardIOUnavailable
	}
	return p.standardIO.take()
}

func (p *windowsNodeProcess) ObserveIdentity() (NodeIdentity, error) {
	if p == nil {
		return NodeIdentity{}, errors.New("Node process is unavailable")
	}
	p.processMu.Lock()
	defer p.processMu.Unlock()
	if p.processPoison != nil {
		return NodeIdentity{}, p.processPoison
	}
	identity, err := observeNodeIdentity(p.process, p.processID)
	if err != nil {
		return NodeIdentity{}, p.poisonProcessHandleIfInvalidLocked(err)
	}
	if !sameNodeIdentity(identity, p.stableIdentity) {
		return NodeIdentity{}, errors.New("retained Node process identity changed after launch")
	}
	return identity, nil
}

func (p *windowsNodeProcess) RootJobActiveProcessCount() (uint32, error) {
	if p == nil {
		return 0, errors.New("Node process is unavailable")
	}
	p.jobMu.Lock()
	defer p.jobMu.Unlock()
	if p.jobPoison != nil {
		return 0, p.jobPoison
	}
	if p.job == 0 {
		return 0, errors.New("service-root Job handle is closed")
	}
	count, err := (windowsJobCounter{job: p.job}).ActiveProcessCount()
	if err != nil {
		return 0, p.poisonJobHandleIfInvalidLocked(err)
	}
	return count, nil
}

func (p *windowsNodeProcess) ActivateAfterHostControl() error {
	if p == nil {
		return errors.New("Node process is unavailable")
	}
	p.jobMu.Lock()
	defer p.jobMu.Unlock()
	if p.jobPoison != nil {
		return p.jobPoison
	}
	if p.hostControlActivated {
		return errors.New("HostControl was already activated for this Node process")
	}
	if p.job == 0 {
		return errors.New("service-root Job handle is closed")
	}
	before, err := queryWindowsJobAccounting(p.job)
	if err != nil {
		return p.poisonJobHandleIfInvalidLocked(fmt.Errorf("query root Job before HostControl activation: %w", err))
	}
	if err := validateSingleNodeJobAccounting(before.TotalProcesses, before.ActiveProcesses); err != nil {
		return fmt.Errorf("verify root Job before HostControl activation: %w", err)
	}
	if err := setRootJobLimits(p.job, p.maximumProcesses, p.maximumMemory); err != nil {
		return p.poisonJobHandleIfInvalidLocked(fmt.Errorf("raise root Job process limit after HostControl binding: %w", err))
	}
	if err := verifyRootJobLimits(p.job, p.maximumProcesses, p.maximumMemory); err != nil {
		return p.poisonJobHandleIfInvalidLocked(fmt.Errorf("verify root Job limits after HostControl binding: %w", err))
	}
	after, err := queryWindowsJobAccounting(p.job)
	if err != nil {
		return p.poisonJobHandleIfInvalidLocked(fmt.Errorf("query root Job after HostControl activation: %w", err))
	}
	if err := validateSingleNodeJobAccounting(after.TotalProcesses, after.ActiveProcesses); err != nil {
		return fmt.Errorf("verify root Job after HostControl activation: %w", err)
	}
	p.hostControlActivated = true
	return nil
}

func (p *windowsNodeProcess) Wait() (uint32, error) {
	return p.WaitContext(context.Background())
}

// WaitContext polls a private duplicate of the process handle. Cancellation
// ends only this observation; process and Job ownership remain available to a
// later wait, Terminate, or Close call.
func (p *windowsNodeProcess) WaitContext(ctx context.Context) (uint32, error) {
	if p == nil {
		return 0, errors.New("Node process is unavailable")
	}
	if ctx == nil {
		return 0, errors.New("Node process wait context is required")
	}
	if cause := context.Cause(ctx); cause != nil {
		return 0, cause
	}

	waitHandle, waitErr := p.duplicateProcessHandleForWait()
	var exitCode uint32
	var exitErr error
	terminal := waitErr != nil
	if waitErr == nil {
		outcome := waitForNodeProcessContext(
			ctx,
			func(interval time.Duration) (uint32, error) {
				return p.processWaiter()(waitHandle, uint32(interval/time.Millisecond))
			},
			func(code *uint32) error {
				return p.processExitCodeReader()(waitHandle, code)
			},
		)
		exitCode = outcome.exitCode
		waitErr = outcome.waitErr
		exitErr = outcome.exitErr
		terminal = outcome.terminal
		if errors.Is(waitErr, windows.ERROR_INVALID_HANDLE) {
			invalidHandle := waitHandle
			waitHandle = 0
			waitErr = windowsProcessLifetimeQuarantine.retain(
				&windowsRawHandleOwner{kind: "Node process wait handle", value: invalidHandle},
				waitErr,
			)
		} else if errors.Is(exitErr, windows.ERROR_INVALID_HANDLE) {
			invalidHandle := waitHandle
			waitHandle = 0
			exitErr = windowsProcessLifetimeQuarantine.retain(
				&windowsRawHandleOwner{kind: "Node process wait handle", value: invalidHandle},
				exitErr,
			)
		}
	}
	var waitHandleCloseErr error
	if waitHandle != 0 {
		waitHandleCloseErr = consumeWindowsHandle(
			"close Node process wait handle",
			waitHandle,
			p.processHandleCloser(),
			windowsProcessLifetimeQuarantine,
		)
		if waitHandleCloseErr != nil {
			p.processMu.Lock()
			waitHandleCloseErr = errors.Join(waitHandleCloseErr, p.poisonProcessHandleLocked(waitHandleCloseErr))
			p.processMu.Unlock()
		}
	}
	if errors.Is(waitErr, ErrLaunchCleanupFatal) || errors.Is(exitErr, ErrLaunchCleanupFatal) {
		p.processMu.Lock()
		poisonErr := p.poisonProcessHandleLocked(errors.Join(waitErr, exitErr))
		p.processMu.Unlock()
		waitErr = errors.Join(waitErr, poisonErr)
	}
	resultErr := errors.Join(waitErr, exitErr, waitHandleCloseErr)
	if !terminal {
		return exitCode, resultErr
	}

	p.jobMu.Lock()
	jobCleanupErr := drainThenCloseJob(p.terminateAndDrainJobLocked, p.closeJobLocked)
	p.jobMu.Unlock()
	var standardIOErr error
	if waitErr != nil || exitErr != nil || waitHandleCloseErr != nil || jobCleanupErr != nil {
		p.standardIO.seal()
		standardIOErr = p.standardIO.closeOwned()
	}
	return exitCode, errors.Join(resultErr, jobCleanupErr, standardIOErr)
}

func (p *windowsNodeProcess) duplicateProcessHandleForWait() (windows.Handle, error) {
	p.processMu.Lock()
	defer p.processMu.Unlock()
	if p.processPoison != nil {
		return 0, p.processPoison
	}
	if p.process == 0 {
		return 0, errors.New("retained Node process handle is closed")
	}
	var duplicate windows.Handle
	currentProcess := windows.CurrentProcess()
	duplicateHandle := p.processHandleDuplicator()
	if err := duplicateHandle(
		currentProcess,
		p.process,
		currentProcess,
		&duplicate,
		0,
		false,
		windows.DUPLICATE_SAME_ACCESS,
	); err != nil {
		var outputErr error
		// Unlike CreateFile's documented failure sentinel, any nonzero value
		// written to this zero-initialized output is an untrusted native output.
		if duplicate != 0 {
			outputErr = windowsProcessLifetimeQuarantine.retain(
				&windowsRawHandleOwner{kind: "untrusted Node process wait handle", value: duplicate},
				errors.New("DuplicateHandle failed after writing an untrusted output handle"),
			)
			duplicate = 0
		}
		if outputErr != nil {
			return 0, errors.Join(err, outputErr, p.poisonProcessHandleLocked(outputErr))
		}
		if errors.Is(err, windows.ERROR_INVALID_HANDLE) {
			return 0, errors.Join(p.poisonProcessHandleIfInvalidLocked(err), outputErr)
		}
		return 0, errors.Join(fmt.Errorf("duplicate Node process handle for wait: %w", err), outputErr)
	}
	if duplicate == 0 || duplicate == windows.InvalidHandle {
		if duplicate == windows.InvalidHandle {
			outputErr := windowsProcessLifetimeQuarantine.retain(
				&windowsRawHandleOwner{kind: "invalid Node process wait handle", value: duplicate},
				errors.New("DuplicateHandle returned INVALID_HANDLE_VALUE without an error"),
			)
			return 0, errors.Join(outputErr, p.poisonProcessHandleLocked(outputErr))
		}
		return 0, errors.New("DuplicateHandle returned a zero Node wait handle")
	}
	return duplicate, nil
}

func (p *windowsNodeProcess) processHandleDuplicator() nodeDuplicateHandleFunc {
	if p.duplicateHandle != nil {
		return p.duplicateHandle
	}
	return windows.DuplicateHandle
}

func (p *windowsNodeProcess) processWaiter() nodeWaitForSingleObjectFunc {
	if p.waitForSingleObject != nil {
		return p.waitForSingleObject
	}
	return windows.WaitForSingleObject
}

func (p *windowsNodeProcess) processExitCodeReader() nodeGetExitCodeProcessFunc {
	if p.getExitCodeProcess != nil {
		return p.getExitCodeProcess
	}
	return windows.GetExitCodeProcess
}

func (p *windowsNodeProcess) processHandleCloser() nodeCloseProcessHandleFunc {
	if p.closeProcessNativeHandle != nil {
		return p.closeProcessNativeHandle
	}
	return windows.CloseHandle
}

func (p *windowsNodeProcess) Terminate() error {
	if p == nil {
		return errors.New("Node process is unavailable")
	}
	p.standardIO.seal()
	p.jobMu.Lock()
	jobErr := drainThenCloseJob(p.terminateAndDrainJobLocked, p.closeJobLocked)
	p.jobMu.Unlock()
	return errors.Join(jobErr, p.standardIO.closeOwned())
}

func (p *windowsNodeProcess) terminateAndDrainJobLocked() error {
	if p.jobPoison != nil {
		return p.jobPoison
	}
	if p.job == 0 {
		return nil
	}
	if !p.terminationInitiated {
		if err := windows.TerminateJobObject(p.job, terminationExitCode); err != nil {
			return p.poisonJobHandleIfInvalidLocked(fmt.Errorf("terminate service-root Job: %w", err))
		}
		p.terminationInitiated = true
	}
	drainErr := waitForNoActiveProcesses(
		windowsJobCounter{job: p.job},
		p.shutdownTimeout,
		jobDrainPollInterval,
		wallDrainClock{},
	)
	return p.poisonJobHandleIfInvalidLocked(drainErr)
}

func (p *windowsNodeProcess) poisonJobHandleIfInvalidLocked(err error) error {
	if err == nil || !errors.Is(err, windows.ERROR_INVALID_HANDLE) {
		return err
	}
	if p.jobPoison != nil {
		return p.jobPoison
	}
	handle := p.job
	p.job = 0
	p.jobPoison = windowsProcessLifetimeQuarantine.retain(
		&windowsRawHandleOwner{kind: "service-root Job handle", value: handle},
		err,
	)
	return p.jobPoison
}

func (p *windowsNodeProcess) closeJobLocked() error {
	if p.jobPoison != nil {
		return p.jobPoison
	}
	if p.job == 0 {
		return nil
	}
	handle := p.job
	closeErr := consumeWindowsHandle(
		"close service-root Job handle",
		handle,
		windows.CloseHandle,
		windowsProcessLifetimeQuarantine,
	)
	p.job = 0
	if closeErr != nil {
		p.jobPoison = closeErr
	}
	return closeErr
}

func (p *windowsNodeProcess) Close() error {
	if p == nil {
		return nil
	}
	p.standardIO.seal()
	p.closeMu.Lock()
	defer p.closeMu.Unlock()

	return closeNodeResourcesAfterJob(
		func() error {
			p.jobMu.Lock()
			defer p.jobMu.Unlock()
			return drainThenCloseJob(p.terminateAndDrainJobLocked, p.closeJobLocked)
		},
		p.standardIO.closeOwned,
		p.closeProcessHandle,
	)
}

func (p *windowsNodeProcess) closeProcessHandle() error {
	p.processMu.Lock()
	defer p.processMu.Unlock()
	if p.processPoison != nil {
		return p.processPoison
	}
	if p.process == 0 {
		return nil
	}
	handle := p.process
	closeErr := consumeWindowsHandle(
		"close Node process handle",
		handle,
		p.processHandleCloser(),
		windowsProcessLifetimeQuarantine,
	)
	p.process = 0
	if closeErr != nil {
		p.processPoison = closeErr
	}
	return closeErr
}

func (p *windowsNodeProcess) poisonProcessHandleIfInvalidLocked(err error) error {
	if err == nil || !errors.Is(err, windows.ERROR_INVALID_HANDLE) {
		return err
	}
	return p.poisonProcessHandleLocked(err)
}

func (p *windowsNodeProcess) poisonProcessHandleLocked(cause error) error {
	if p.processPoison != nil {
		return p.processPoison
	}
	handle := p.process
	p.process = 0
	p.processPoison = windowsProcessLifetimeQuarantine.retain(
		&windowsRawHandleOwner{kind: "Node process handle", value: handle},
		cause,
	)
	return p.processPoison
}

func observeNodeIdentity(handle windows.Handle, expectedProcessID uint32) (NodeIdentity, error) {
	if handle == 0 {
		return NodeIdentity{}, errors.New("retained Node process handle is closed")
	}
	processID, err := windows.GetProcessId(handle)
	if err != nil {
		return NodeIdentity{}, fmt.Errorf("query retained Node process ID: %w", err)
	}
	if processID == 0 || processID != expectedProcessID {
		return NodeIdentity{}, fmt.Errorf("retained Node process ID is %d, want %d", processID, expectedProcessID)
	}
	active, err := nodeProcessStillActive(handle)
	if err != nil {
		return NodeIdentity{}, fmt.Errorf("query retained Node process liveness: %w", err)
	}
	if !active {
		return NodeIdentity{}, errors.New("retained Node process is not active")
	}

	var created windows.Filetime
	var exited windows.Filetime
	var kernel windows.Filetime
	var user windows.Filetime
	if err := windows.GetProcessTimes(handle, &created, &exited, &kernel, &user); err != nil {
		return NodeIdentity{}, fmt.Errorf("query retained Node creation time: %w", err)
	}
	identity := NodeIdentity{
		ProcessID:    processID,
		CreationTime: time.Unix(0, created.Nanoseconds()).UTC(),
	}
	if identity.CreationTime.IsZero() {
		return NodeIdentity{}, errors.New("retained Node creation time is zero")
	}

	var sequenceNumber uint64
	err = windows.NtQueryInformationProcess(
		handle,
		windows.ProcessSequenceNumber,
		unsafe.Pointer(&sequenceNumber),
		uint32(unsafe.Sizeof(sequenceNumber)),
		nil,
	)
	startKeyAvailable := err == nil
	if errors.Is(err, windows.STATUS_INVALID_INFO_CLASS) || errors.Is(err, windows.STATUS_NOT_SUPPORTED) {
		err = nil
		startKeyAvailable = false
	}
	if err != nil {
		return NodeIdentity{}, fmt.Errorf("query retained Node process sequence number: %w", err)
	}
	if startKeyAvailable && sequenceNumber == 0 {
		return NodeIdentity{}, errors.New("retained Node process sequence number is zero")
	}
	if startKeyAvailable {
		identity.StartKeyAvailable = true
		identity.StartKeySequenceNumber = sequenceNumber
	}

	active, err = nodeProcessStillActive(handle)
	if err != nil {
		return NodeIdentity{}, fmt.Errorf("requery retained Node process liveness: %w", err)
	}
	if !active {
		return NodeIdentity{}, errors.New("retained Node process exited during identity observation")
	}
	return identity, nil
}

func nodeProcessStillActive(handle windows.Handle) (bool, error) {
	status, err := windows.WaitForSingleObject(handle, 0)
	if err != nil {
		return false, err
	}
	switch status {
	case windows.WAIT_OBJECT_0:
		return false, nil
	case uint32(windows.WAIT_TIMEOUT):
		var exitCode uint32
		if err := windows.GetExitCodeProcess(handle, &exitCode); err != nil {
			return false, err
		}
		return exitCode == nodeStillActiveExitCode, nil
	default:
		return false, fmt.Errorf("unexpected Node process wait status 0x%x", status)
	}
}

func sameNodeIdentity(left, right NodeIdentity) bool {
	return left.ProcessID == right.ProcessID &&
		left.CreationTime.Equal(right.CreationTime) &&
		left.StartKeyAvailable == right.StartKeyAvailable &&
		left.StartKeySequenceNumber == right.StartKeySequenceNumber
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
	information, err := queryWindowsJobAccounting(c.job)
	if err != nil {
		return 0, err
	}
	return information.ActiveProcesses, nil
}

func queryWindowsJobAccounting(job windows.Handle) (jobObjectBasicAccountingInformation, error) {
	information := jobObjectBasicAccountingInformation{}
	if err := windows.QueryInformationJobObject(
		job,
		int32(windows.JobObjectBasicAccountingInformation),
		uintptr(unsafe.Pointer(&information)),
		uint32(unsafe.Sizeof(information)),
		nil,
	); err != nil {
		return jobObjectBasicAccountingInformation{}, err
	}
	return information, nil
}
