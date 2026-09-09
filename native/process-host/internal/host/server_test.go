//go:build !windows

package host

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/protocol"
)

func TestServerPerformsReadyAndShutdownHandshake(t *testing.T) {
	input := strings.NewReader(`{"protocolVersion":"1.0","type":"shutdown","requestId":"shutdown:one"}` + "\n")
	var output bytes.Buffer
	server := NewServer(input, &output, nil, 1)
	if err := server.Run(context.Background()); err != nil {
		t.Fatal(err)
	}

	events := decodeEventLines(t, output.String())
	if len(events) != 2 {
		t.Fatalf("event count = %d, want 2", len(events))
	}
	if events[0]["type"] != "ready" || events[1]["type"] != "shutdown_complete" {
		t.Fatalf("unexpected event sequence: %#v", events)
	}
	capabilities := events[0]["capabilities"].(map[string]any)
	if capabilities["maximumFrameBytes"] != float64(protocol.MaxFrameBytes) {
		t.Fatalf("maximumFrameBytes = %v", capabilities["maximumFrameBytes"])
	}
	if capabilities["maximumConcurrentRequests"] != float64(1) {
		t.Fatalf("maximumConcurrentRequests = %v", capabilities["maximumConcurrentRequests"])
	}
}

type controlledLauncher struct {
	mu      sync.Mutex
	calls   int
	entered chan struct{}
	release chan struct{}
	process launchedProcess
	err     error
}

func (l *controlledLauncher) Launch(protocol.ProcessLaunchSpec, protocol.EffectiveLimits) (launchedProcess, error) {
	l.mu.Lock()
	l.calls++
	l.mu.Unlock()
	if l.entered != nil {
		l.entered <- struct{}{}
	}
	if l.release != nil {
		<-l.release
	}
	return l.process, l.err
}

func (l *controlledLauncher) callCount() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.calls
}

type completedProcess struct{}

func (completedProcess) ProcessID() uint32             { return 42 }
func (completedProcess) StandardInput() io.WriteCloser { return nopWriteCloser{Writer: io.Discard} }
func (completedProcess) StandardOutput() io.ReadCloser { return io.NopCloser(strings.NewReader("")) }
func (completedProcess) StandardError() io.ReadCloser  { return io.NopCloser(strings.NewReader("")) }
func (completedProcess) Wait() (*int64, error) {
	exitCode := int64(0)
	return &exitCode, nil
}
func (completedProcess) Terminate() error { return nil }
func (completedProcess) Close() error     { return nil }

func TestStartReservationRejectsConcurrentDuplicateAndReleasesAfterFailure(t *testing.T) {
	var output bytes.Buffer
	launcher := &controlledLauncher{
		entered: make(chan struct{}, 1),
		release: make(chan struct{}),
		err:     errors.New("launch failed"),
	}
	server := NewServer(strings.NewReader(""), &output, nil, 4)
	server.launcher = launcher
	request := validStartRequest("process:one")

	firstDone := make(chan error, 1)
	go func() { firstDone <- server.start(request) }()
	<-launcher.entered
	if err := server.start(request); err != nil {
		t.Fatal(err)
	}
	close(launcher.release)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
	if launcher.callCount() != 1 {
		t.Fatalf("launcher calls = %d, want 1", launcher.callCount())
	}
	server.mu.Lock()
	reservationCount := len(server.reservations)
	server.mu.Unlock()
	if reservationCount != 0 {
		t.Fatalf("reservations after failure = %d, want 0", reservationCount)
	}

	events := decodeEventLines(t, output.String())
	if len(events) != 2 || events[0]["code"] != "DUPLICATE_REQUEST_ID" || events[1]["code"] != "PROCESS_START_FAILED" {
		t.Fatalf("unexpected errors: %#v", events)
	}
}

func TestCompletedProcessReleasesReservationForReuse(t *testing.T) {
	var output bytes.Buffer
	server := NewServer(strings.NewReader(""), &output, nil, 1)
	server.launcher = &controlledLauncher{process: completedProcess{}}
	request := validStartRequest("process:reusable")
	if err := server.start(request); err != nil {
		t.Fatal(err)
	}

	waitDone := make(chan struct{})
	go func() {
		server.activeWG.Wait()
		close(waitDone)
	}()
	select {
	case <-waitDone:
	case <-time.After(time.Second):
		t.Fatal("process completion did not release its reservation")
	}
	server.mu.Lock()
	reservationCount := len(server.reservations)
	server.mu.Unlock()
	if reservationCount != 0 {
		t.Fatalf("reservations after completion = %d, want 0", reservationCount)
	}
	if err := server.terminate(protocol.TerminateRequest{
		ProtocolVersion: protocol.Version,
		Type:            "terminate",
		ID:              request.ID,
		Reason:          protocol.TerminationCancelled,
	}); err != nil {
		t.Fatal(err)
	}
	events := decodeEventLines(t, output.String())
	if last := events[len(events)-1]; last["code"] != "PROCESS_NOT_FOUND" {
		t.Fatalf("completed request did not report PROCESS_NOT_FOUND: %#v", last)
	}

	server.launcher = &controlledLauncher{err: errors.New("second launch failed")}
	if err := server.start(request); err != nil {
		t.Fatal(err)
	}
	events = decodeEventLines(t, output.String())
	last := events[len(events)-1]
	if last["code"] != "PROCESS_START_FAILED" {
		t.Fatalf("request ID was not reusable after completion: %#v", last)
	}
}

func TestTerminateNaturalExitRaceDefersToExitedEvent(t *testing.T) {
	var output bytes.Buffer
	server := NewServer(strings.NewReader(""), &output, nil, 1)
	process := &managedProcess{
		server:        server,
		requestID:     "process:exiting",
		process:       completedProcess{},
		processExited: true,
	}
	server.reservations[process.requestID] = process

	err := server.terminate(protocol.TerminateRequest{
		ProtocolVersion: protocol.Version,
		Type:            "terminate",
		ID:              process.requestID,
		Reason:          protocol.TerminationCancelled,
	})
	if err != nil {
		t.Fatal(err)
	}
	if output.Len() != 0 {
		t.Fatalf("terminate race emitted an event instead of deferring to exited: %s", output.String())
	}
}

func validStartRequest(requestID string) protocol.StartRequest {
	return protocol.StartRequest{
		ProtocolVersion: protocol.Version,
		Type:            "start",
		ID:              requestID,
		Spec: protocol.ProcessLaunchSpec{
			Executable:       `C:\Tools\codex.exe`,
			Arguments:        []string{},
			WorkingDirectory: `C:\work`,
			EnvironmentMode:  "replace",
			Environment:      map[string]string{},
			Limits: protocol.ProcessResourceLimits{
				HardTimeoutMS:       10_000,
				MaximumProcessCount: 1,
				MaximumMemoryBytes:  128 * 1024 * 1024,
				MaximumOutputBytes:  4 * 1024,
			},
		},
	}
}

func TestServerReportsStartFailureBeforeShutdownOnNonWindows(t *testing.T) {
	if _, supported := newProcessLauncher().(unsupportedLauncher); !supported {
		t.Skip("test exercises the non-Windows launcher")
	}
	start := `{"protocolVersion":"1.0","type":"start","requestId":"process:one","spec":{"executable":"C:\\Tools\\codex.exe","arguments":[],"workingDirectory":"C:\\work","environmentMode":"replace","environment":{},"limits":{"hardTimeoutMs":10000,"maximumProcessCount":1,"maximumMemoryBytes":134217728,"maximumOutputBytes":4096}}}`
	shutdown := `{"protocolVersion":"1.0","type":"shutdown","requestId":"shutdown:one"}`
	var output bytes.Buffer
	server := NewServer(strings.NewReader(start+"\n"+shutdown+"\n"), &output, nil, 1)
	if err := server.Run(context.Background()); err != nil {
		t.Fatal(err)
	}

	events := decodeEventLines(t, output.String())
	if len(events) != 3 || events[0]["type"] != "ready" || events[1]["type"] != "error" || events[2]["type"] != "shutdown_complete" {
		t.Fatalf("unexpected event sequence: %#v", events)
	}
	if events[1]["code"] != "PROCESS_START_FAILED" || events[1]["requestId"] != "process:one" {
		t.Fatalf("unexpected start error: %#v", events[1])
	}
}

func TestServerRejectsRequestedProcessIdentityOnNonWindows(t *testing.T) {
	var output bytes.Buffer
	server := NewServer(strings.NewReader(""), &output, nil, 1)
	request := validStartRequest("identity:unsupported")
	request.Spec.CaptureProcessIdentity = true
	if err := server.start(request); err != nil {
		t.Fatal(err)
	}
	events := decodeEventLines(t, output.String())
	if len(events) != 1 || events[0]["type"] != "error" || events[0]["code"] != "PROCESS_IDENTITY_UNAVAILABLE" {
		t.Fatalf("unexpected events: %#v", events)
	}
	if len(server.reservations) != 0 {
		t.Fatal("unsupported identity request retained its reservation")
	}
}

func TestServerFatalDoesNotWaitForActiveLifecycle(t *testing.T) {
	input, inputWriter := io.Pipe()
	defer input.Close()
	defer inputWriter.Close()
	var output bytes.Buffer
	server := NewServer(input, &output, nil, 1)
	server.activeWG.Add(1)
	defer server.activeWG.Done()
	process := &managedProcess{
		server:    server,
		requestID: "process:locked-during-fatal",
		process:   completedProcess{},
		done:      make(chan struct{}),
		started:   true,
	}
	process.lifecycleMu.Lock()
	defer process.lifecycleMu.Unlock()
	server.reservations[process.requestID] = process
	server.fail(errors.New("supervision failed"))

	started := time.Now()
	err := server.Run(context.Background())
	if err == nil || !strings.Contains(err.Error(), "supervision failed") {
		t.Fatalf("Run error = %v", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("fatal shutdown waited for active lifecycle: %v", elapsed)
	}
}

func decodeEventLines(t *testing.T, output string) []map[string]any {
	t.Helper()
	lines := strings.Split(strings.TrimSpace(output), "\n")
	events := make([]map[string]any, 0, len(lines))
	for _, line := range lines {
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("decode event %q: %v", line, err)
		}
		events = append(events, event)
	}
	return events
}
