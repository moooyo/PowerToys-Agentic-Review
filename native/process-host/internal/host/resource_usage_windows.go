//go:build windows

package host

import (
	"unsafe"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/protocol"
	"golang.org/x/sys/windows"
)

func (p *windowsProcess) ResourceUsage() *protocol.ProcessResourceUsage {
	p.jobMu.Lock()
	defer p.jobMu.Unlock()
	if !p.captureResourceUsage {
		return nil
	}
	return p.resourceUsage.snapshot()
}

func (p *windowsProcess) observeActiveProcessesLocked() {
	if !p.captureResourceUsage || p.job == 0 {
		return
	}
	if active, err := (windowsJobCounter{job: p.job}).ActiveProcessCount(); err == nil {
		p.resourceUsage.observeActiveProcesses(active)
	}
}

// Query failure only omits diagnostics. The existing drain and close path owns cleanup.
func (p *windowsProcess) observeResourceUsageLocked() {
	if !p.captureResourceUsage || p.job == 0 {
		return
	}
	p.observeActiveProcessesLocked()
	information := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	if err := windows.QueryInformationJobObject(
		p.job,
		int32(windows.JobObjectExtendedLimitInformation),
		uintptr(unsafe.Pointer(&information)),
		uint32(unsafe.Sizeof(information)),
		nil,
	); err == nil {
		p.resourceUsage.observeMemory(uint64(information.PeakJobMemoryUsed), uint64(information.PeakProcessMemoryUsed))
	}
}
