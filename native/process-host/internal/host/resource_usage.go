package host

import "github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/protocol"

const resourceUsageSampleIntervalMS uint32 = 250

// resourceUsageObservation is protected by the owning process's Job lock.
type resourceUsageObservation struct {
	peakJobMemoryBytes     *uint64
	peakProcessMemoryBytes *uint64
	sampledPeak            uint32
	sampleCount            uint64
}

func (o *resourceUsageObservation) observeActiveProcesses(active uint32) {
	if active > o.sampledPeak {
		o.sampledPeak = active
	}
	if o.sampleCount < protocol.MaxSafeInteger {
		o.sampleCount++
	}
}

func (o *resourceUsageObservation) observeMemory(peakJob, peakProcess uint64) {
	if peakJob <= protocol.MaxSafeInteger {
		o.peakJobMemoryBytes = &peakJob
	}
	if peakProcess <= protocol.MaxSafeInteger {
		o.peakProcessMemoryBytes = &peakProcess
	}
}

func (o *resourceUsageObservation) snapshot() *protocol.ProcessResourceUsage {
	if o.peakJobMemoryBytes == nil && o.peakProcessMemoryBytes == nil && o.sampleCount == 0 {
		return nil
	}
	usage := &protocol.ProcessResourceUsage{}
	if o.peakJobMemoryBytes != nil {
		value := *o.peakJobMemoryBytes
		usage.PeakJobMemoryBytes = &value
	}
	if o.peakProcessMemoryBytes != nil {
		value := *o.peakProcessMemoryBytes
		usage.PeakProcessMemoryBytes = &value
	}
	if o.sampleCount > 0 {
		usage.ActiveProcesses = &protocol.ActiveProcessObservation{
			SampledPeak:      o.sampledPeak,
			SampleCount:      o.sampleCount,
			SampleIntervalMS: resourceUsageSampleIntervalMS,
		}
	}
	return usage
}
