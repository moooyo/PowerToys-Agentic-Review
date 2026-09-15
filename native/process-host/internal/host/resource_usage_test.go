package host

import (
	"bytes"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/protocol"
)

func TestResourceUsageSnapshotOmitsMissingAndUnrepresentableObservations(t *testing.T) {
	var observations resourceUsageObservation
	if observations.snapshot() != nil {
		t.Fatal("missing observations fabricated resource usage")
	}
	observations.observeMemory(protocol.MaxSafeInteger+1, protocol.MaxSafeInteger+1)
	if observations.snapshot() != nil {
		t.Fatal("unsafe integer observations were emitted")
	}
	observations.observeMemory(0, 0)
	usage := observations.snapshot()
	if usage.PeakJobMemoryBytes == nil || *usage.PeakJobMemoryBytes != 0 || usage.PeakProcessMemoryBytes == nil || usage.ActiveProcesses != nil {
		t.Fatalf("zero memory observations were confused with missing observations: %#v", usage)
	}
}

func TestResourceUsageSnapshotsAreIndependentAndUseOnlyObservedProcessCounts(t *testing.T) {
	var observations resourceUsageObservation
	observations.observeActiveProcesses(1)
	observations.observeActiveProcesses(4)
	observations.observeActiveProcesses(0)
	observations.observeMemory(1234, 1000)
	first := observations.snapshot()
	if first.ActiveProcesses.SampledPeak != 4 || first.ActiveProcesses.SampleCount != 3 || first.ActiveProcesses.SampleIntervalMS != 250 {
		t.Fatalf("unexpected active process observations: %#v", first.ActiveProcesses)
	}
	*first.PeakJobMemoryBytes = 0
	first.ActiveProcesses.SampledPeak = 0
	second := observations.snapshot()
	if *second.PeakJobMemoryBytes != 1234 || second.ActiveProcesses.SampledPeak != 4 {
		t.Fatal("caller mutation changed the cached observations")
	}
}

type resourceUsageTestProcess struct {
	*identityTestProcess
	usage   *protocol.ProcessResourceUsage
	queries int
}

func (p *resourceUsageTestProcess) ResourceUsage() *protocol.ProcessResourceUsage {
	p.queries++
	return p.usage
}

func TestResourceUsageDoesNotChangeCompletionOrCleanup(t *testing.T) {
	for _, requested := range []bool{false, true} {
		for _, available := range []bool{false, true} {
			var output bytes.Buffer
			process := &resourceUsageTestProcess{identityTestProcess: &identityTestProcess{}}
			if available {
				peak := uint64(4096)
				process.usage = &protocol.ProcessResourceUsage{PeakJobMemoryBytes: &peak}
			}
			server := NewServer(strings.NewReader(""), &output, nil, 1)
			server.launcher = identityTestLauncher{process: process}
			request := identityStartRequest(false)
			request.Spec.CaptureResourceUsage = requested
			if err := server.start(request); err != nil {
				t.Fatal(err)
			}
			server.activeWG.Wait()
			events := identityEventLines(t, output.String())
			if len(events) != 2 || events[1]["type"] != "exited" || events[1]["exitCode"] != float64(0) || process.closeCalls.Load() != 1 || process.terminateCalls.Load() != 0 {
				t.Fatalf("diagnostics changed lifecycle: %#v", events)
			}
			_, emitted := events[1]["resourceUsage"]
			if emitted != (requested && available) || (process.queries == 1) != requested {
				t.Fatalf("requested=%v available=%v emitted=%v queries=%d", requested, available, emitted, process.queries)
			}
		}
	}
}
