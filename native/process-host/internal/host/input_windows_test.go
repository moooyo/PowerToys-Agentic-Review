//go:build windows

package host

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/protocol"
	"golang.org/x/sys/windows"
)

const inputWindowsHelperEnvironment = "AGENTIC_REVIEW_INTERACTIVE_INPUT_HELPER"

func TestInteractiveInputWindowsHelper(t *testing.T) {
	if os.Getenv(inputWindowsHelperEnvironment) != "1" {
		return
	}
	mode := os.Args[len(os.Args)-1]
	if mode == "blocked" {
		_, _ = io.WriteString(os.Stdout, "ready-blocked\n")
		// This helper intentionally never reads stdin. It runs no repository or model command.
		time.Sleep(60 * time.Second)
		os.Exit(11)
	}
	if mode == "echo" {
		_, _ = io.WriteString(os.Stdout, "ready-echo\n")
		if _, err := io.Copy(os.Stdout, os.Stdin); err != nil {
			os.Exit(12)
		}
		os.Exit(0)
	}
	os.Exit(13)
}

type windowsInputHarness struct {
	server *Server
	writer *protocol.FrameWriter
	input  *io.PipeWriter
	log    *inputEventLog
	done   chan struct{}
	err    error
	cancel context.CancelFunc
}

func startWindowsInputHarness(t *testing.T) *windowsInputHarness {
	t.Helper()
	inputReader, inputWriter := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	h := &windowsInputHarness{log: newInputEventLog(), input: inputWriter, writer: protocol.NewFrameWriter(inputWriter, protocol.MaxFrameBytes), done: make(chan struct{}), cancel: cancel}
	h.server = NewServerWithInteractiveInput(inputReader, h.log, nil, 4, true)
	go func() { h.err = h.server.Run(ctx); close(h.done) }()
	t.Cleanup(func() {
		cancel()
		_ = inputWriter.Close()
		_ = inputReader.Close()
		select {
		case <-h.done:
		case <-time.After(15 * time.Second):
			t.Error("native input Host did not stop")
		}
	})
	awaitNativeInputEvent(t, h.log, 5*time.Second, func(event map[string]any) bool { return event["type"] == "ready" })
	return h
}

func awaitNativeInputEvent(t *testing.T, log *inputEventLog, timeout time.Duration, predicate func(map[string]any) bool) map[string]any {
	t.Helper()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		for _, event := range log.snapshot() {
			if predicate(event) {
				return event
			}
		}
		select {
		case <-log.changed:
		case <-timer.C:
			t.Fatalf("native input event deadline exceeded: %#v", log.snapshot())
		}
	}
}

func (h *windowsInputHarness) send(t *testing.T, request protocol.HostRequest) {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- h.writer.WriteFrame(request) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("blocked child stdin prevented Host control frame processing")
	}
}

func (h *windowsInputHarness) start(t *testing.T, id, mode string) (*managedProcess, *windowsProcess) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		t.Fatal(err)
	}
	request := protocol.StartRequest{ProtocolVersion: protocol.Version, Type: "start", ID: id, Spec: protocol.ProcessLaunchSpec{
		Executable: executable, Arguments: []string{"-test.run=^TestInteractiveInputWindowsHelper$", "--", mode},
		WorkingDirectory: t.TempDir(), EnvironmentMode: "replace", InteractiveStdin: true,
		Environment: map[string]string{inputWindowsHelperEnvironment: "1", "SYSTEMROOT": os.Getenv("SYSTEMROOT")},
		Limits:      protocol.ProcessResourceLimits{HardTimeoutMS: 30000, MaximumProcessCount: 4, MaximumMemoryBytes: 256 * 1024 * 1024, MaximumOutputBytes: 1024 * 1024},
	}}
	h.send(t, request)
	started := awaitNativeInputEvent(t, h.log, 5*time.Second, func(event map[string]any) bool { return event["type"] == "started" && event["requestId"] == id })
	managed := inputManaged(t, h.server, id)
	process, ok := managed.process.(*windowsProcess)
	if !ok {
		t.Fatal("expected the real Windows launcher")
	}
	// Register after TempDir so every failure closes this process before directory removal.
	t.Cleanup(func() {
		select {
		case <-managed.done:
			return
		default:
		}
		_, _ = managed.terminate(protocol.TerminationWorkerShutdown, false)
		select {
		case <-managed.done:
		case <-time.After(5 * time.Second):
			t.Error("owned Windows helper cleanup was not confirmed")
		}
	})
	if started["stdinStreamId"] != managed.input.streamID || protocol.ValidateStdinStreamID(managed.input.streamID) != nil {
		t.Fatal("native start did not bind its interactive stream")
	}
	awaitNativeInputEvent(t, h.log, 5*time.Second, func(event map[string]any) bool {
		if event["type"] != "stdout" || event["requestId"] != id {
			return false
		}
		data, err := base64.StdEncoding.DecodeString(event["dataBase64"].(string))
		return err == nil && bytes.Contains(data, []byte("ready-"+mode))
	})
	return managed, process
}

func (h *windowsInputHarness) write(t *testing.T, p *managedProcess, sequence uint64, data []byte) {
	h.send(t, protocol.StdinWriteRequest{ProtocolVersion: protocol.Version, Type: "stdin_write", ID: p.requestID, StdinStreamID: p.input.streamID, Sequence: sequence, DataBase64: base64.StdEncoding.EncodeToString(data)})
}
func (h *windowsInputHarness) closeInput(t *testing.T, p *managedProcess, sequence uint64) {
	h.send(t, protocol.StdinCloseRequest{ProtocolVersion: protocol.Version, Type: "stdin_close", ID: p.requestID, StdinStreamID: p.input.streamID, Sequence: sequence})
}
func (h *windowsInputHarness) result(t *testing.T, p *managedProcess, sequence uint64, timeout time.Duration) map[string]any {
	return awaitNativeInputEvent(t, h.log, timeout, func(event map[string]any) bool {
		return event["type"] == "stdin_result" && event["requestId"] == p.requestID && event["stdinStreamId"] == p.input.streamID && event["sequence"] == float64(sequence)
	})
}
func (h *windowsInputHarness) shutdown(t *testing.T) {
	h.send(t, protocol.ShutdownRequest{ProtocolVersion: protocol.Version, Type: "shutdown", ID: "shutdown:interactive"})
	select {
	case <-h.done:
		if h.err != nil {
			t.Fatal(h.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("interactive Host shutdown was not confirmed")
	}
}

func probeInputWindowsJob(t *testing.T, process *windowsProcess) windows.Handle {
	t.Helper()
	var duplicate windows.Handle
	if err := windows.DuplicateHandle(windows.CurrentProcess(), process.job, windows.CurrentProcess(), &duplicate, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = windows.CloseHandle(duplicate) })
	count, err := (windowsJobCounter{job: duplicate}).ActiveProcessCount()
	if err != nil || count < 1 {
		t.Fatalf("helper not active in its real Job Object: %d, %v", count, err)
	}
	return duplicate
}
func assertNativeInputCleanup(t *testing.T, managed *managedProcess, process *windowsProcess, probe windows.Handle) {
	t.Helper()
	awaitInputDone(t, managed)
	count, err := (windowsJobCounter{job: probe}).ActiveProcessCount()
	if err != nil || count != 0 {
		t.Fatalf("Job Object was not empty: %d, %v", count, err)
	}
	if process.job != 0 {
		t.Fatal("owned Job Object handle remained open")
	}
	for _, file := range []*os.File{process.standardInput, process.standardOutput, process.standardError} {
		if _, err := file.Stat(); !errors.Is(err, os.ErrClosed) && !errors.Is(err, windows.ERROR_INVALID_HANDLE) {
			t.Fatalf("pipe handle was not closed: %v", err)
		}
	}
	if _, err := windows.WaitForSingleObject(process.process, 0); !errors.Is(err, windows.ERROR_INVALID_HANDLE) {
		t.Fatalf("owned process handle remained valid: %v", err)
	}
}

func TestInteractiveInputWindowsBlockedWritePreservesControlAndCleanup(t *testing.T) {
	for _, mode := range []string{"terminate", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			h := startWindowsInputHarness(t)
			blocked, blockedProcess := h.start(t, "native:blocked", "blocked")
			probe := probeInputWindowsJob(t, blockedProcess)
			startedAt := time.Now()
			h.write(t, blocked, 1, bytes.Repeat([]byte("x"), protocol.MaxInteractiveStdinChunkBytes))
			// The helper does not read; a real maximum-sized write must remain pending in the
			// Windows pipe, not merely be delayed by a fake writer or a request queue.
			time.Sleep(150 * time.Millisecond)
			blocked.input.mu.Lock()
			pending := blocked.input.pending != nil && blocked.input.pending.started && !blocked.input.pending.completed
			blocked.input.mu.Unlock()
			if !pending {
				t.Fatal("the real Windows pipe write did not block")
			}
			for _, event := range inputEventsFor(h.log, "stdin_result") {
				if event["requestId"] == blocked.requestID {
					t.Fatal("blocked write completed before control isolation check")
				}
			}
			other, otherProcess := h.start(t, "native:other", "echo")
			otherProbe := probeInputWindowsJob(t, otherProcess)
			h.write(t, other, 1, []byte("owned second process\n"))
			if result := h.result(t, other, 1, 3*time.Second); result["status"] != "succeeded" {
				t.Fatalf("unrelated process write failed: %#v", result)
			}
			h.closeInput(t, other, 2)
			if result := h.result(t, other, 2, 3*time.Second); result["status"] != "succeeded" {
				t.Fatalf("unrelated process EOF failed: %#v", result)
			}
			assertNativeInputCleanup(t, other, otherProcess, otherProbe)
			code := protocol.StdinWriteTimeout
			if mode == "terminate" {
				code = protocol.StdinCancelled
				h.send(t, protocol.TerminateRequest{ProtocolVersion: protocol.Version, Type: "terminate", ID: blocked.requestID, Reason: protocol.TerminationCancelled})
			}
			result := h.result(t, blocked, 1, 15*time.Second)
			if result["status"] != "failed" || result["code"] != code {
				t.Fatalf("unexpected blocked-write result: %#v", result)
			}
			if mode == "timeout" && time.Since(startedAt) < 9*time.Second {
				t.Fatal("write timeout occurred before the advertised budget")
			}
			assertNativeInputCleanup(t, blocked, blockedProcess, probe)
			assertInputBeforeExited(t, h.log, blocked.requestID)
			assertInputBeforeExited(t, h.log, other.requestID)
			if mode == "timeout" && len(inputEventsFor(h.log, "terminated")) != 0 {
				t.Fatal("stdin timeout emitted an unsolicited terminate acknowledgement")
			}
			h.shutdown(t)
			t.Logf("synthetic Windows input: mode=%s elapsed=%s bytesWritten=%v otherProcessControlled=true jobActiveProcesses=0 pipeHandlesClosed=true processHandleClosed=true", mode, time.Since(startedAt), result["bytesWritten"])
		})
	}
}

func TestInteractiveInputWindowsSequentialBinaryChunksAndEOF(t *testing.T) {
	h := startWindowsInputHarness(t)
	managed, process := h.start(t, "native:binary", "echo")
	probe := probeInputWindowsJob(t, process)
	chunks := [][]byte{{'{', '}', '\n', 0xe2}, {0x82, 0xac, '\n', 0}, {0xff, 'x', '\n'}}
	for index, chunk := range chunks {
		h.write(t, managed, uint64(index+1), chunk)
		if result := h.result(t, managed, uint64(index+1), 3*time.Second); result["status"] != "succeeded" || result["bytesWritten"] != float64(len(chunk)) {
			t.Fatalf("binary chunk not acknowledged: %#v", result)
		}
	}
	h.closeInput(t, managed, 4)
	if result := h.result(t, managed, 4, 3*time.Second); result["status"] != "succeeded" || result["bytesWritten"] != float64(0) {
		t.Fatalf("EOF close was not successful: %#v", result)
	}
	assertNativeInputCleanup(t, managed, process, probe)
	var output []byte
	for _, event := range h.log.snapshot() {
		if event["type"] == "stdout" && event["requestId"] == managed.requestID {
			data, err := base64.StdEncoding.DecodeString(event["dataBase64"].(string))
			if err != nil {
				t.Fatal(err)
			}
			output = append(output, data...)
		}
	}
	expected := append([]byte("ready-echo\n"), bytes.Join(chunks, nil)...)
	if !bytes.Equal(output, expected) {
		t.Fatalf("stdin bytes were transformed: got=%x want=%x", output, expected)
	}
	assertInputBeforeExited(t, h.log, managed.requestID)
	h.shutdown(t)
	t.Logf("synthetic Windows input: chunks=%d decodedBytes=%d EOF=true jobActiveProcesses=0 handlesClosed=true", len(chunks), len(bytes.Join(chunks, nil)))
}
