package host

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/protocol"
)

type inputEventLog struct {
	mu           sync.Mutex
	items        []map[string]any
	changed      chan struct{}
	beforeReturn func(map[string]any)
}

func newInputEventLog() *inputEventLog { return &inputEventLog{changed: make(chan struct{}, 128)} }
func (l *inputEventLog) Write(data []byte) (int, error) {
	var event map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(data), &event); err != nil {
		return 0, err
	}
	l.mu.Lock()
	l.items = append(l.items, event)
	l.mu.Unlock()
	select {
	case l.changed <- struct{}{}:
	default:
	}
	if l.beforeReturn != nil {
		l.beforeReturn(event)
	}
	return len(data), nil
}
func (l *inputEventLog) snapshot() []map[string]any {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]map[string]any(nil), l.items...)
}
func awaitInputEvent(t *testing.T, log *inputEventLog, predicate func(map[string]any) bool) map[string]any {
	t.Helper()
	timer := time.NewTimer(3 * time.Second)
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
			t.Fatalf("expected input event was not observed: %#v", log.snapshot())
		}
	}
}
func awaitInputDone(t *testing.T, managed *managedProcess) {
	t.Helper()
	select {
	case <-managed.done:
	case <-time.After(3 * time.Second):
		t.Fatal("managed process did not finish")
	}
}
func inputEventsFor(log *inputEventLog, kind string) []map[string]any {
	var events []map[string]any
	for _, event := range log.snapshot() {
		if event["type"] == kind {
			events = append(events, event)
		}
	}
	return events
}
func assertInputBeforeExited(t *testing.T, log *inputEventLog, requestID string) {
	t.Helper()
	exited := false
	for _, event := range log.snapshot() {
		if event["requestId"] != requestID {
			continue
		}
		if event["type"] == "exited" {
			exited = true
		}
		if event["type"] == "stdin_result" && exited {
			t.Fatal("accepted input result followed exited")
		}
	}
	if !exited {
		t.Fatal("missing process exited event")
	}
}

type inputTestPipe struct {
	mu        sync.Mutex
	data      []byte
	writes    int
	blocked   bool
	entered   chan struct{}
	release   chan struct{}
	closed    chan struct{}
	closeOnce sync.Once
	onClose   func()
	partial   int
	writeErr  error
}

func newInputTestPipe() *inputTestPipe {
	return &inputTestPipe{entered: make(chan struct{}, 1), release: make(chan struct{}), closed: make(chan struct{})}
}
func (p *inputTestPipe) Write(data []byte) (int, error) {
	p.mu.Lock()
	p.writes++
	p.mu.Unlock()
	select {
	case p.entered <- struct{}{}:
	default:
	}
	if p.blocked {
		select {
		case <-p.release:
		case <-p.closed:
			return 0, io.ErrClosedPipe
		}
	}
	n := len(data)
	if p.writeErr != nil {
		n = p.partial
	}
	p.mu.Lock()
	p.data = append(p.data, data[:n]...)
	p.mu.Unlock()
	return n, p.writeErr
}
func (p *inputTestPipe) Close() error {
	p.closeOnce.Do(func() {
		close(p.closed)
		if p.onClose != nil {
			p.onClose()
		}
	})
	return nil
}
func (p *inputTestPipe) bytes() []byte {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]byte(nil), p.data...)
}

type inputTestProcess struct {
	input        *inputTestPipe
	exited       chan struct{}
	exitOnce     sync.Once
	terminations atomic.Int32
	closes       atomic.Int32
}

func newInputTestProcess(pipe *inputTestPipe) *inputTestProcess {
	p := &inputTestProcess{input: pipe, exited: make(chan struct{})}
	pipe.onClose = p.exit
	return p
}
func (p *inputTestProcess) exit()                         { p.exitOnce.Do(func() { close(p.exited) }) }
func (p *inputTestProcess) ProcessID() uint32             { return 42 }
func (p *inputTestProcess) StandardInput() io.WriteCloser { return p.input }
func (p *inputTestProcess) StandardOutput() io.ReadCloser { return io.NopCloser(strings.NewReader("")) }
func (p *inputTestProcess) StandardError() io.ReadCloser  { return io.NopCloser(strings.NewReader("")) }
func (p *inputTestProcess) Wait() (*int64, error)         { <-p.exited; code := int64(0); return &code, nil }
func (p *inputTestProcess) Terminate() error              { p.terminations.Add(1); p.exit(); return nil }
func (p *inputTestProcess) Close() error                  { p.closes.Add(1); return p.input.Close() }

type inputTestLauncher struct{ processes []*inputTestProcess }

func (l *inputTestLauncher) Launch(protocol.ProcessLaunchSpec, protocol.EffectiveLimits) (launchedProcess, error) {
	if len(l.processes) == 0 {
		return nil, errors.New("no synthetic process remains")
	}
	p := l.processes[0]
	l.processes = l.processes[1:]
	return p, nil
}
func inputStartRequest(id string, interactive bool) protocol.StartRequest {
	return protocol.StartRequest{ProtocolVersion: protocol.Version, Type: "start", ID: id,
		Spec: protocol.ProcessLaunchSpec{Executable: `C:\Synthetic\fixture.exe`, Arguments: []string{}, WorkingDirectory: `C:\Synthetic`, EnvironmentMode: "replace", Environment: map[string]string{}, InteractiveStdin: interactive,
			Limits: protocol.ProcessResourceLimits{HardTimeoutMS: 30000, MaximumProcessCount: 1, MaximumMemoryBytes: 128 * 1024 * 1024, MaximumOutputBytes: 4096}}}
}
func inputManaged(t *testing.T, server *Server, id string) *managedProcess {
	t.Helper()
	server.mu.Lock()
	defer server.mu.Unlock()
	p := server.reservations[id]
	if p == nil {
		t.Fatal("missing synthetic managed process")
	}
	return p
}
func startInputFixture(t *testing.T, pipe *inputTestPipe) (*Server, *managedProcess, *inputTestProcess, *inputEventLog) {
	t.Helper()
	log := newInputEventLog()
	process := newInputTestProcess(pipe)
	server := NewServerWithInteractiveInput(strings.NewReader(""), log, nil, 4, true)
	server.launcher = &inputTestLauncher{processes: []*inputTestProcess{process}}
	if err := server.start(inputStartRequest("input:one", true)); err != nil {
		t.Fatal(err)
	}
	managed := inputManaged(t, server, "input:one")
	t.Cleanup(func() { managed.input.stop(protocol.StdinCancelled); process.exit(); awaitInputDone(t, managed) })
	return server, managed, process, log
}
func sendInput(t *testing.T, server *Server, managed *managedProcess, seq uint64, data []byte) {
	t.Helper()
	if err := server.writeInput(protocol.StdinWriteRequest{ProtocolVersion: protocol.Version, Type: "stdin_write", ID: managed.requestID, StdinStreamID: managed.input.streamID, Sequence: seq, DataBase64: base64.StdEncoding.EncodeToString(data)}); err != nil {
		t.Fatal(err)
	}
}
func closeTestInput(t *testing.T, server *Server, managed *managedProcess, seq uint64) {
	t.Helper()
	if err := server.closeInput(protocol.StdinCloseRequest{ProtocolVersion: protocol.Version, Type: "stdin_close", ID: managed.requestID, StdinStreamID: managed.input.streamID, Sequence: seq}); err != nil {
		t.Fatal(err)
	}
}

func TestInteractiveInputReadyIsOptInAndLegacyJSONIsUnchanged(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		var output bytes.Buffer
		server := NewServerWithInteractiveInput(strings.NewReader(`{"protocolVersion":"1.0","type":"shutdown","requestId":"stop"}`+"\n"), &output, nil, 4, enabled)
		if err := server.Run(context.Background()); err != nil {
			t.Fatal(err)
		}
		line := strings.Split(output.String(), "\n")[0]
		if !enabled && line != `{"protocolVersion":"1.0","type":"ready","processHostPid":`+strconv.Itoa(os.Getpid())+`,"capabilities":{"concurrentRequests":true,"maximumFrameBytes":1048576,"maximumConcurrentRequests":4}}` {
			t.Fatalf("legacy ready changed: %s", line)
		}
		var ready protocol.ReadyEvent
		if err := json.Unmarshal([]byte(line), &ready); err != nil {
			t.Fatal(err)
		}
		if enabled && (ready.Capabilities.InteractiveStdin == nil || *ready.Capabilities.InteractiveStdin != *protocol.DefaultInteractiveStdinCapabilities()) {
			t.Fatal("incorrect interactive capability")
		}
	}
}

func TestInteractiveInputRequiresExplicitHostOptInAndPreservesSingleShot(t *testing.T) {
	log := newInputEventLog()
	server := NewServer(strings.NewReader(""), log, nil, 2)
	pipe := newInputTestPipe()
	process := newInputTestProcess(pipe)
	launcher := &inputTestLauncher{processes: []*inputTestProcess{process}}
	server.launcher = launcher
	if err := server.start(inputStartRequest("disabled", true)); err != nil {
		t.Fatal(err)
	}
	if len(launcher.processes) != 1 || log.snapshot()[0]["code"] != protocol.StdinNotEnabled {
		t.Fatal("disabled input launched a process")
	}
	request := inputStartRequest("legacy", false)
	text := "one-shot synthetic input"
	request.Spec.StandardInput = &text
	if err := server.start(request); err != nil {
		t.Fatal(err)
	}
	awaitInputEvent(t, log, func(e map[string]any) bool { return e["type"] == "exited" })
	if string(pipe.bytes()) != text {
		t.Fatal("legacy standard input changed")
	}
	for _, event := range inputEventsFor(log, "started") {
		if _, exists := event["stdinStreamId"]; exists {
			t.Fatal("legacy start exposed a stream")
		}
	}
}

func TestInteractiveInputCopiesBytesAndPreservesSequenceAcrossBusyAndMismatch(t *testing.T) {
	pipe := newInputTestPipe()
	pipe.blocked = true
	server, managed, _, log := startInputFixture(t, pipe)
	data := []byte{0, 255, 226, 130, 172}
	expected := append([]byte(nil), data...)
	if code := managed.input.admit(managed.input.streamID, 1, "write", data); code != "" {
		t.Fatal(code)
	}
	<-pipe.entered
	data[0] = 1
	if code := managed.input.admit(strings.Repeat("f", 64), 2, "write", []byte("x")); code != protocol.StdinStreamMismatch {
		t.Fatal(code)
	}
	if code := managed.input.admit(managed.input.streamID, 2, "write", []byte("x")); code != protocol.StdinBusy {
		t.Fatal(code)
	}
	close(pipe.release)
	ack := awaitInputEvent(t, log, func(e map[string]any) bool { return e["type"] == "stdin_result" && e["sequence"] == float64(1) })
	if ack["status"] != "succeeded" || ack["bytesWritten"] != float64(len(data)) {
		t.Fatalf("invalid write result: %#v", ack)
	}
	if code := managed.input.admit(managed.input.streamID, 9, "close", nil); code != protocol.StdinSequenceMismatch {
		t.Fatal(code)
	}
	closeTestInput(t, server, managed, 2)
	awaitInputDone(t, managed)
	if !bytes.Equal(pipe.bytes(), expected) {
		t.Fatal("caller mutation changed admitted bytes")
	}
	assertInputBeforeExited(t, log, managed.requestID)
}

func TestInteractiveInputBudgetsRejectWithoutAdvancingSequence(t *testing.T) {
	for _, budget := range []string{"bytes", "operations"} {
		controller := newInputController(nil, strings.Repeat("a", 64), newInputTestPipe())
		if budget == "bytes" {
			controller.totalBytes = protocol.MaxInteractiveStdinTotalBytes - 1
		} else {
			controller.operations = protocol.MaxInteractiveStdinOperations
		}
		seq := controller.operations + 1
		if code := controller.admit(controller.streamID, seq, "write", []byte("ab")); code != protocol.StdinLimitExceeded {
			t.Fatalf("%s: %s", budget, code)
		}
		if controller.pending != nil || controller.operations+1 != seq {
			t.Fatal("rejected budget consumed an operation")
		}
	}
}

func TestInteractiveInputAdmissionErrorsAreCorrelatedAndDoNotFailHost(t *testing.T) {
	for _, code := range []string{protocol.StdinNotEnabled, protocol.StdinProcessNotFound, protocol.StdinProcessNotRunning, protocol.StdinStreamMismatch, protocol.StdinSequenceMismatch, protocol.StdinClosed, protocol.StdinLimitExceeded} {
		t.Run(code, func(t *testing.T) {
			log := newInputEventLog()
			server := NewServerWithInteractiveInput(strings.NewReader(""), log, nil, 1, true)
			stream := strings.Repeat("a", 64)
			sequence := uint64(1)
			managed := &managedProcess{server: server, requestID: "admission"}
			managed.input = newInputController(managed, stream, newInputTestPipe())
			server.reservations[managed.requestID] = managed
			switch code {
			case protocol.StdinNotEnabled:
				server.interactiveInput = false
			case protocol.StdinProcessNotFound:
				delete(server.reservations, managed.requestID)
			case protocol.StdinProcessNotRunning:
				server.reservations[managed.requestID] = nil
			case protocol.StdinStreamMismatch:
				stream = strings.Repeat("b", 64)
			case protocol.StdinSequenceMismatch:
				sequence = 2
			case protocol.StdinClosed:
				managed.input.closing = true
			case protocol.StdinLimitExceeded:
				managed.input.operations = protocol.MaxInteractiveStdinOperations
				sequence = protocol.MaxInteractiveStdinOperations + 1
			}
			if err := server.admitInput(managed.requestID, stream, sequence, "close", nil); err != nil {
				t.Fatal(err)
			}
			events := inputEventsFor(log, "stdin_result")
			if len(events) != 1 || events[0]["code"] != code || events[0]["requestId"] != managed.requestID || events[0]["stdinStreamId"] != stream || events[0]["sequence"] != float64(sequence) || events[0]["bytesWritten"] != float64(0) {
				t.Fatalf("wrong admission rejection: %#v", events)
			}
			select {
			case err := <-server.fatal:
				t.Fatalf("input rejection failed Host: %v", err)
			default:
			}
		})
	}
}

func TestInteractiveInputPartialWriteStopsProcessWithoutReplay(t *testing.T) {
	pipe := newInputTestPipe()
	pipe.partial = 2
	pipe.writeErr = io.ErrShortWrite
	server, managed, process, log := startInputFixture(t, pipe)
	pipe.onClose = nil
	sendInput(t, server, managed, 1, []byte("abcdef"))
	awaitInputDone(t, managed)
	acks := inputEventsFor(log, "stdin_result")
	if len(acks) != 1 || acks[0]["status"] != "failed" || acks[0]["code"] != protocol.StdinWriteFailed || acks[0]["bytesWritten"] != float64(2) {
		t.Fatalf("wrong partial write result: %#v", acks)
	}
	if process.terminations.Load() != 1 || pipe.writes != 1 || string(pipe.bytes()) != "ab" {
		t.Fatal("partial write replayed or did not stop process")
	}
	if len(inputEventsFor(log, "terminated")) != 0 {
		t.Fatal("input failure emitted an unsolicited terminate acknowledgement")
	}
	assertInputBeforeExited(t, log, managed.requestID)
}

func TestInteractiveInputWriteTimeoutClosesBlockedPipeAndStopsOnlyItsProcess(t *testing.T) {
	pipe := newInputTestPipe()
	pipe.blocked = true
	server, managed, process, log := startInputFixture(t, pipe)
	pipe.onClose = nil
	managed.input.writeTimeout = 20 * time.Millisecond
	sendInput(t, server, managed, 1, []byte("blocked"))
	awaitInputDone(t, managed)
	ack := inputEventsFor(log, "stdin_result")
	if len(ack) != 1 || ack[0]["code"] != protocol.StdinWriteTimeout || ack[0]["bytesWritten"] != float64(0) {
		t.Fatalf("wrong timeout result: %#v", ack)
	}
	if process.terminations.Load() != 1 || pipe.writes != 1 {
		t.Fatal("timeout replayed input or did not terminate the affected process")
	}
	if len(inputEventsFor(log, "terminated")) != 0 {
		t.Fatal("input timeout emitted an unsolicited terminate acknowledgement")
	}
	assertInputBeforeExited(t, log, managed.requestID)
}

func TestInteractiveInputQueuedWriteCannotSucceedAfterSpontaneousExit(t *testing.T) {
	pipe := newInputTestPipe()
	process := newInputTestProcess(pipe)
	log := newInputEventLog()
	server := NewServerWithInteractiveInput(strings.NewReader(""), log, nil, 1, true)
	managed := &managedProcess{server: server, requestID: "queued", process: process, done: make(chan struct{}), started: true, limits: protocol.EffectiveLimits{MaximumOutputBytes: 4096}}
	managed.input = newInputController(managed, strings.Repeat("a", 64), pipe)
	server.reservations[managed.requestID] = managed
	server.activeWG.Add(1)
	if code := managed.input.admit(managed.input.streamID, 1, "write", []byte("must not write")); code != "" {
		t.Fatal(code)
	}
	managed.input.stop(protocol.StdinProcessExited)
	process.exit()
	managed.startIO(nil)
	awaitInputDone(t, managed)
	ack := inputEventsFor(log, "stdin_result")
	if len(ack) != 1 || ack[0]["code"] != protocol.StdinProcessExited || ack[0]["bytesWritten"] != float64(0) || pipe.writes != 0 {
		t.Fatalf("queued operation was reported successful: %#v", ack)
	}
	assertInputBeforeExited(t, log, managed.requestID)
}

func TestInteractiveInputSuccessfulEOFSurvivesExitBeforeResultPublication(t *testing.T) {
	pipe := newInputTestPipe()
	server, managed, _, log := startInputFixture(t, pipe)
	entered := make(chan struct{})
	release := make(chan struct{})
	log.beforeReturn = func(event map[string]any) {
		if event["type"] == "stdin_result" {
			close(entered)
			<-release
		}
	}
	closeTestInput(t, server, managed, 1)
	<-entered
	select {
	case <-managed.input.stopSignal:
	case <-time.After(time.Second):
		t.Fatal("EOF did not produce a spontaneous exit")
	}
	if len(inputEventsFor(log, "exited")) != 0 {
		t.Fatal("exited preceded committed input result publication")
	}
	ack := inputEventsFor(log, "stdin_result")[0]
	if ack["status"] != "succeeded" || ack["operation"] != "close" || ack["code"] != nil {
		t.Fatalf("successful EOF was invalidated: %#v", ack)
	}
	close(release)
	awaitInputDone(t, managed)
	assertInputBeforeExited(t, log, managed.requestID)
}

func TestInteractiveInputIdleExitDoesNotWaitForClientEOF(t *testing.T) {
	_, managed, process, log := startInputFixture(t, newInputTestPipe())
	process.exit()
	awaitInputDone(t, managed)
	if len(inputEventsFor(log, "stdin_result")) != 0 {
		t.Fatal("idle exit fabricated input completion")
	}
}

func TestInteractiveInputCompletedCleanupIgnoresLateWatchdog(t *testing.T) {
	server, managed, _, _ := startInputFixture(t, newInputTestPipe())
	closeTestInput(t, server, managed, 1)
	awaitInputDone(t, managed)
	managed.input.failUnconfirmedCleanup()
	select {
	case err := <-server.fatal:
		t.Fatalf("completed cleanup failed the shared Host: %v", err)
	default:
	}
}

func TestInteractiveInputLateTimeoutCannotKillCommittedWrite(t *testing.T) {
	pipe := newInputTestPipe()
	pipe.blocked = true
	server, managed, process, log := startInputFixture(t, pipe)
	publishing := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	releasePublication := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(releasePublication)
	log.beforeReturn = func(event map[string]any) {
		if event["type"] == "stdin_result" && event["sequence"] == float64(1) {
			close(publishing)
			<-release
		}
	}
	sendInput(t, server, managed, 1, []byte("committed"))
	<-pipe.entered
	managed.input.mu.Lock()
	operation := managed.input.pending
	managed.input.mu.Unlock()
	close(pipe.release)
	select {
	case <-publishing:
	case <-time.After(time.Second):
		t.Fatal("write result was not committed")
	}
	if managed.input.timeoutOperation(operation) {
		t.Fatal("late timeout cancelled a committed write")
	}
	if process.terminations.Load() != 0 {
		t.Fatal("late timeout killed the live process")
	}
	// A client can receive the complete acknowledgement just before the emitter returns.
	// Its next close must remain queued and cannot disappear during the first publication.
	closeTestInput(t, server, managed, 2)
	releasePublication()
	awaitInputDone(t, managed)
	acks := inputEventsFor(log, "stdin_result")
	if len(acks) != 2 || acks[0]["status"] != "succeeded" || acks[1]["status"] != "succeeded" {
		t.Fatalf("wrong committed operation results: %#v", acks)
	}
	assertInputBeforeExited(t, log, managed.requestID)
}

func TestInteractiveInputStreamIDPreventsRequestIDReuse(t *testing.T) {
	log := newInputEventLog()
	server := NewServerWithInteractiveInput(strings.NewReader(""), log, nil, 2, true)
	first := newInputTestProcess(newInputTestPipe())
	second := newInputTestProcess(newInputTestPipe())
	server.launcher = &inputTestLauncher{processes: []*inputTestProcess{first, second}}
	request := inputStartRequest("reused", true)
	if err := server.start(request); err != nil {
		t.Fatal(err)
	}
	previous := inputManaged(t, server, request.ID)
	closeTestInput(t, server, previous, 1)
	awaitInputDone(t, previous)
	server.activeWG.Wait()
	if err := server.start(request); err != nil {
		t.Fatal(err)
	}
	current := inputManaged(t, server, request.ID)
	if previous.input.streamID == current.input.streamID || protocol.ValidateStdinStreamID(current.input.streamID) != nil {
		t.Fatal("input generation was not renewed")
	}
	if err := server.writeInput(protocol.StdinWriteRequest{ProtocolVersion: protocol.Version, Type: "stdin_write", ID: request.ID, StdinStreamID: previous.input.streamID, Sequence: 1, DataBase64: "eA=="}); err != nil {
		t.Fatal(err)
	}
	if len(second.input.bytes()) != 0 {
		t.Fatal("old stream wrote to replacement process")
	}
	closeTestInput(t, server, current, 1)
	awaitInputDone(t, current)
	acks := inputEventsFor(log, "stdin_result")
	found := false
	for _, ack := range acks {
		if ack["code"] == protocol.StdinStreamMismatch {
			found = true
		}
	}
	if !found {
		t.Fatal("old stream was not rejected")
	}
}
