package host

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/protocol"
)

type identityTestLauncher struct {
	process launchedProcess
	err     error
}

func (l identityTestLauncher) Launch(protocol.ProcessLaunchSpec, protocol.EffectiveLimits) (launchedProcess, error) {
	return l.process, l.err
}

type identityTestProcess struct {
	terminateCalls atomic.Int32
	closeCalls     atomic.Int32
	streamCalls    atomic.Int32
}

func (*identityTestProcess) ProcessID() uint32 { return 42 }
func (p *identityTestProcess) StandardInput() io.WriteCloser {
	p.streamCalls.Add(1)
	return nopWriteCloser{io.Discard}
}
func (p *identityTestProcess) StandardOutput() io.ReadCloser {
	p.streamCalls.Add(1)
	return io.NopCloser(strings.NewReader(""))
}
func (p *identityTestProcess) StandardError() io.ReadCloser {
	p.streamCalls.Add(1)
	return io.NopCloser(strings.NewReader(""))
}
func (*identityTestProcess) Wait() (*int64, error) {
	exitCode := int64(0)
	return &exitCode, nil
}
func (p *identityTestProcess) Terminate() error {
	p.terminateCalls.Add(1)
	return nil
}
func (p *identityTestProcess) Close() error {
	p.closeCalls.Add(1)
	return nil
}

type capturedIdentityTestProcess struct {
	*identityTestProcess
	creationTime  uint64
	identityCalls int
}

func (p *capturedIdentityTestProcess) ProcessCreationTimeFileTime() uint64 {
	p.identityCalls++
	return p.creationTime
}

func TestStartIncludesRequestedProcessIdentityWithoutPrecisionLoss(t *testing.T) {
	for _, test := range []struct {
		creationTime uint64
		want         string
	}{
		{creationTime: 1, want: "1"},
		{creationTime: 9_007_199_254_740_993, want: "9007199254740993"},
		{creationTime: 18_446_744_073_709_551_615, want: "18446744073709551615"},
	} {
		t.Run(test.want, func(t *testing.T) {
			var output bytes.Buffer
			process := &capturedIdentityTestProcess{identityTestProcess: &identityTestProcess{}, creationTime: test.creationTime}
			server := NewServer(strings.NewReader(""), &output, nil, 1)
			server.launcher = identityTestLauncher{process: process}
			request := identityStartRequest(true)
			if err := server.start(request); err != nil {
				t.Fatal(err)
			}
			server.activeWG.Wait()
			events := identityEventLines(t, output.String())
			if len(events) != 2 || events[0]["type"] != "started" || events[1]["type"] != "exited" {
				t.Fatalf("unexpected event sequence: %#v", events)
			}
			if got := events[0]["processCreationTimeFileTime"]; got != test.want {
				t.Fatalf("creation time = %#v, want %q", got, test.want)
			}
			if process.identityCalls != 1 {
				t.Fatalf("identity calls = %d, want 1", process.identityCalls)
			}
		})
	}
}

func TestStartDoesNotReadOrEmitUnrequestedProcessIdentity(t *testing.T) {
	provider := &capturedIdentityTestProcess{identityTestProcess: &identityTestProcess{}, creationTime: 123}
	for _, process := range []launchedProcess{&identityTestProcess{}, provider} {
		var output bytes.Buffer
		server := NewServer(strings.NewReader(""), &output, nil, 1)
		server.launcher = identityTestLauncher{process: process}
		if err := server.start(identityStartRequest(false)); err != nil {
			t.Fatal(err)
		}
		server.activeWG.Wait()
		events := identityEventLines(t, output.String())
		if len(events) != 2 || events[0]["type"] != "started" || events[1]["type"] != "exited" {
			t.Fatalf("unexpected event sequence: %#v", events)
		}
		if _, exists := events[0]["processCreationTimeFileTime"]; exists {
			t.Fatalf("legacy started event includes process identity: %#v", events[0])
		}
	}
	if provider.identityCalls != 0 {
		t.Fatalf("unrequested identity calls = %d, want 0", provider.identityCalls)
	}
}

func TestStartRejectsUnavailableIdentityBeforeStartingIO(t *testing.T) {
	for _, available := range []bool{false, true} {
		t.Run(fmt.Sprintf("provider=%v", available), func(t *testing.T) {
			var output bytes.Buffer
			process := &identityTestProcess{}
			launcher := identityTestLauncher{process: process}
			if available {
				launcher.process = &capturedIdentityTestProcess{identityTestProcess: process}
			}
			server := NewServer(strings.NewReader(""), &output, nil, 1)
			server.launcher = launcher
			if err := server.start(identityStartRequest(true)); err != nil {
				t.Fatal(err)
			}
			server.activeWG.Wait()
			events := identityEventLines(t, output.String())
			if len(events) != 1 || events[0]["type"] != "error" || events[0]["code"] != "PROCESS_IDENTITY_UNAVAILABLE" {
				t.Fatalf("unexpected events: %#v", events)
			}
			if process.terminateCalls.Load() != 1 || process.closeCalls.Load() != 1 || process.streamCalls.Load() != 0 {
				t.Fatalf("process calls = terminate:%d close:%d streams:%d", process.terminateCalls.Load(), process.closeCalls.Load(), process.streamCalls.Load())
			}
			if len(server.reservations) != 0 {
				t.Fatal("failed identity capture retained its reservation")
			}
			server.launcher = identityTestLauncher{process: &identityTestProcess{}}
			if err := server.start(identityStartRequest(false)); err != nil {
				t.Fatal(err)
			}
			server.activeWG.Wait()
			events = identityEventLines(t, output.String())
			if len(events) != 3 || events[1]["type"] != "started" || events[2]["type"] != "exited" {
				t.Fatalf("reservation was not reusable: %#v", events)
			}
		})
	}
}

func TestStartReportsIdentityLaunchErrorsExplicitly(t *testing.T) {
	for _, test := range []struct {
		err  error
		code string
	}{
		{err: fmt.Errorf("capture: %w", errProcessIdentityUnavailable), code: "PROCESS_IDENTITY_UNAVAILABLE"},
		{err: fmt.Errorf("capture: %w", errProcessIdentityQueryFailed), code: "PROCESS_IDENTITY_QUERY_FAILED"},
		{err: errors.New("ordinary launch failure"), code: "PROCESS_START_FAILED"},
	} {
		t.Run(test.code, func(t *testing.T) {
			var output bytes.Buffer
			server := NewServer(strings.NewReader(""), &output, nil, 1)
			server.launcher = identityTestLauncher{err: test.err}
			if err := server.start(identityStartRequest(true)); err != nil {
				t.Fatal(err)
			}
			events := identityEventLines(t, output.String())
			if len(events) != 1 || events[0]["type"] != "error" || events[0]["code"] != test.code || events[0]["requestId"] != "identity:one" {
				t.Fatalf("unexpected events: %#v", events)
			}
			if len(server.reservations) != 0 {
				t.Fatal("launch failure retained its reservation")
			}
		})
	}
}

func identityStartRequest(capture bool) protocol.StartRequest {
	return protocol.StartRequest{
		ProtocolVersion: protocol.Version,
		Type:            "start",
		ID:              "identity:one",
		Spec: protocol.ProcessLaunchSpec{
			Executable:             `C:\Tools\codex.exe`,
			Arguments:              []string{},
			WorkingDirectory:       `C:\work`,
			EnvironmentMode:        "replace",
			Environment:            map[string]string{},
			CaptureProcessIdentity: capture,
			Limits:                 protocol.ProcessResourceLimits{HardTimeoutMS: 10_000, MaximumProcessCount: 1, MaximumMemoryBytes: 128 * 1024 * 1024, MaximumOutputBytes: 4096},
		},
	}
}

func identityEventLines(t *testing.T, output string) []map[string]any {
	t.Helper()
	var events []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	return events
}
