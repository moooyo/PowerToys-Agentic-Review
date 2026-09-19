//go:build windows

package host

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"runtime"
	"syscall"
	"time"
	"unsafe"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/protocol"
	"golang.org/x/sys/windows"
)

const recoveryJobPrefix = `Global\AgenticReview.Worker.Recovery.v1.`

var createRecoveryJobProcedure = windows.NewLazySystemDLL("kernel32.dll").NewProc("CreateJobObjectW")

func newRecoveryLauncher(instanceKey string) (processLauncher, *protocol.NamedJobRecoveryCapability, error) {
	return newRecoveryLauncherWithTimeout(instanceKey, 15*time.Second)
}

func newRecoveryLauncherWithTimeout(instanceKey string, timeout time.Duration) (processLauncher, *protocol.NamedJobRecoveryCapability, error) {
	if !ValidInstanceKey(instanceKey) {
		return nil, nil, errors.New("recovery instance key must be exactly 64 lowercase hexadecimal characters")
	}
	if timeout <= 0 {
		return nil, nil, errors.New("recovery timeout must be positive")
	}
	var generation [32]byte
	if _, err := rand.Read(generation[:]); err != nil {
		return nil, nil, fmt.Errorf("allocate recovery generation: %w", err)
	}
	job, err := openAndDrainRecoveryJob(instanceKey, timeout)
	if err != nil {
		return nil, nil, err
	}
	if err := windows.AssignProcessToJobObject(job, windows.CurrentProcess()); err != nil {
		_ = windows.CloseHandle(job)
		return nil, nil, fmt.Errorf("assign ProcessHost to recovery Job Object: %w", err)
	}

	// Deliberately retain this non-inheritable handle until process exit. Explicitly
	// closing its last handle would terminate this Host because it is also a member.
	// Windows closes the handle when the Host exits, enforcing kill-on-close even
	// when the client disappears or the Host crashes before normal request cleanup.
	return windowsLauncher{recoveryJob: job}, &protocol.NamedJobRecoveryCapability{
		Capability:          "named-job-tree-v1",
		InstanceKey:         instanceKey,
		Generation:          hex.EncodeToString(generation[:]),
		PreviousTreeDrained: true,
	}, nil
}

func openAndDrainRecoveryJob(instanceKey string, timeout time.Duration) (windows.Handle, error) {
	deadline := time.Now().Add(timeout)
	name, err := windows.UTF16PtrFromString(recoveryJobPrefix + instanceKey)
	if err != nil {
		return 0, fmt.Errorf("encode recovery Job Object name: %w", err)
	}
	job, created, err := createRecoveryJob(name)
	if err != nil {
		return 0, fmt.Errorf("open or create recovery Job Object: %w", err)
	}
	fail := func(err error) (windows.Handle, error) {
		return 0, errors.Join(err, windows.CloseHandle(job))
	}
	if err := configureRecoveryJob(job); err != nil {
		return fail(err)
	}
	active, err := (windowsJobCounter{job: job}).ActiveProcessCount()
	if err != nil {
		return fail(fmt.Errorf("inspect previous recovery Job Object: %w", err))
	}
	if active != 0 {
		if err := windows.TerminateJobObject(job, terminationExitCode); err != nil {
			return fail(fmt.Errorf("terminate previous recovery Job Object: %w", err))
		}
	}
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return fail(errors.New("recovery Job Object startup deadline expired before drain"))
	}
	if err := waitForNoActiveProcesses(windowsJobCounter{job: job}, remaining, 10*time.Millisecond, wallDrainClock{}); err != nil {
		return fail(fmt.Errorf("drain previous recovery Job Object: %w", err))
	}
	if created {
		return job, nil
	}
	// TerminateJobObject does not make the old object a reusable next-generation
	// container. Retained handles may also preserve its previous session/hierarchy.
	if err := windows.CloseHandle(job); err != nil {
		return 0, fmt.Errorf("close drained recovery Job Object: %w", err)
	}
	// A named job survives until its handles are closed AND all associated processes
	// have terminated. A newly created name is evidence only for a journal already
	// known to have used this containment contract; legacy PID records cannot use it.
	// https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
	for {
		remaining = time.Until(deadline)
		if remaining <= 0 {
			return 0, errors.New("recovery Job Object name is still retained by an earlier generation after its processes exited")
		}
		job, created, err = createRecoveryJob(name)
		if err != nil {
			return 0, fmt.Errorf("create fresh recovery Job Object: %w", err)
		}
		if created {
			if err := configureRecoveryJob(job); err != nil {
				return fail(err)
			}
			active, err := (windowsJobCounter{job: job}).ActiveProcessCount()
			if err != nil || active != 0 {
				return fail(errors.Join(errors.New("fresh recovery Job Object did not confirm zero active processes"), err))
			}
			return job, nil
		}
		// Do not keep our own polling handle alive while waiting for the old name
		// to disappear. A persistent external handle blocks startup, not the proof.
		if err := windows.CloseHandle(job); err != nil {
			return 0, fmt.Errorf("close retained recovery Job Object: %w", err)
		}
		if remaining > 10*time.Millisecond {
			remaining = 10 * time.Millisecond
		}
		time.Sleep(remaining)
	}
}

func configureRecoveryJob(job windows.Handle) error {
	information := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	information.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&information)),
		uint32(unsafe.Sizeof(information)),
	); err != nil {
		return fmt.Errorf("enforce recovery Job Object containment: %w", err)
	}
	return nil
}

func createRecoveryJob(name *uint16) (windows.Handle, bool, error) {
	if err := createRecoveryJobProcedure.Find(); err != nil {
		return 0, false, err
	}
	// The x/sys wrapper discards ERROR_ALREADY_EXISTS after a successful call.
	// SyscallN clears and captures last-error in the same native syscall stub; an
	// independent GetLastError call could observe a stale value or another thread.
	value, _, lastError := syscall.SyscallN(createRecoveryJobProcedure.Addr(), 0, uintptr(unsafe.Pointer(name)))
	runtime.KeepAlive(name)
	if value == 0 {
		if lastError == 0 {
			return 0, false, errors.New("CreateJobObject returned a null recovery handle")
		}
		return 0, false, lastError
	}
	job := windows.Handle(value)
	switch lastError {
	case 0:
		return job, true, nil
	case windows.ERROR_ALREADY_EXISTS:
		return job, false, nil
	default:
		return 0, false, errors.Join(fmt.Errorf("CreateJobObject returned an unexpected successful last-error: %w", lastError), windows.CloseHandle(job))
	}
}
