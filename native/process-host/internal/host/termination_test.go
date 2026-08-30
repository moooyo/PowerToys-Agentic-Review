package host

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/protocol"
)

type terminationOrderProcess struct {
	protocolOutput *bytes.Buffer
	terminateErr   error
	framesAtCall   int
	closeCalls     int
	streamCalls    int
}

func (p *terminationOrderProcess) ProcessID() uint32 { return 42 }
func (p *terminationOrderProcess) StandardInput() io.WriteCloser {
	p.streamCalls++
	return nopWriteCloser{io.Discard}
}
func (p *terminationOrderProcess) StandardOutput() io.ReadCloser {
	p.streamCalls++
	return io.NopCloser(strings.NewReader(""))
}
func (p *terminationOrderProcess) StandardError() io.ReadCloser {
	p.streamCalls++
	return io.NopCloser(strings.NewReader(""))
}
func (p *terminationOrderProcess) Wait() (*int64, error) { return nil, nil }
func (p *terminationOrderProcess) Close() error {
	p.closeCalls++
	return nil
}
func (p *terminationOrderProcess) Terminate() error {
	p.framesAtCall = bytes.Count(p.protocolOutput.Bytes(), []byte{'\n'})
	return p.terminateErr
}

type nopWriteCloser struct {
	io.Writer
}

func (nopWriteCloser) Close() error { return nil }

func TestTerminateAcknowledgesOnlyAfterKernelTerminationSucceeds(t *testing.T) {
	var output bytes.Buffer
	server := &Server{emitter: newProtocolEmitter(protocol.NewFrameWriter(&output, protocol.MaxFrameBytes))}
	process := &terminationOrderProcess{protocolOutput: &output}
	managed := &managedProcess{server: server, requestID: "process:one", process: process, started: true}

	accepted, err := managed.terminate(protocol.TerminationLeaseLost, true)
	if err != nil || !accepted {
		t.Fatalf("terminate = (%v, %v), want accepted without error", accepted, err)
	}
	if process.framesAtCall != 0 {
		t.Fatalf("termination acknowledgement was emitted before Terminate returned")
	}
	if !bytes.Contains(output.Bytes(), []byte(`"type":"terminated"`)) {
		t.Fatalf("missing termination acknowledgement: %s", output.String())
	}
}

func TestTerminateFailureDoesNotAcknowledge(t *testing.T) {
	var output bytes.Buffer
	server := &Server{emitter: newProtocolEmitter(protocol.NewFrameWriter(&output, protocol.MaxFrameBytes))}
	process := &terminationOrderProcess{protocolOutput: &output, terminateErr: errors.New("kernel termination failed")}
	managed := &managedProcess{server: server, requestID: "process:one", process: process, started: true}

	accepted, err := managed.terminate(protocol.TerminationLeaseLost, true)
	if !accepted || err == nil {
		t.Fatalf("terminate = (%v, %v), want accepted with error", accepted, err)
	}
	if output.Len() != 0 {
		t.Fatalf("unexpected acknowledgement after failure: %s", output.String())
	}
}

func TestClientTerminationFailureFailsBeforeBlockedErrorEmission(t *testing.T) {
	writer := &firstWriteGate{entered: make(chan struct{}), release: make(chan struct{})}
	server := &Server{
		emitter:      newProtocolEmitter(protocol.NewFrameWriter(writer, protocol.MaxFrameBytes)),
		reservations: make(map[string]*managedProcess),
		fatal:        make(chan error, 1),
	}
	process := &terminationOrderProcess{
		protocolOutput: &bytes.Buffer{},
		terminateErr:   errors.New("client termination failed"),
	}
	managed := &managedProcess{
		server:    server,
		requestID: "process:client-termination-failure",
		process:   process,
		done:      make(chan struct{}),
		started:   true,
	}
	server.reservations[managed.requestID] = managed
	request := protocol.TerminateRequest{
		ProtocolVersion: protocol.Version,
		Type:            "terminate",
		ID:              managed.requestID,
		Reason:          protocol.TerminationLeaseLost,
	}

	handlerDone := make(chan error, 1)
	go func() { handlerDone <- server.terminate(request) }()
	<-writer.entered
	select {
	case err := <-handlerDone:
		if err == nil || !strings.Contains(err.Error(), "client termination failed") {
			t.Fatalf("handler error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("terminate handler remained blocked behind protocol output")
	}
	select {
	case err := <-server.fatal:
		if err == nil || !strings.Contains(err.Error(), "client termination failed") {
			t.Fatalf("fatal error = %v", err)
		}
	default:
		t.Fatal("client termination failure did not publish fatal")
	}
	if writer.String() != "" {
		t.Fatalf("blocked writer unexpectedly emitted data: %s", writer.String())
	}
	close(writer.release)
	outputText := waitForWriterSubstring(t, writer, `"code":"PROCESS_TERMINATION_FAILED"`)
	if strings.Contains(outputText, `"type":"terminated"`) || strings.Contains(outputText, `"type":"exited"`) {
		t.Fatalf("unexpected terminal event: %s", outputText)
	}
}

func TestTimeoutDoesNotAcknowledgeWhenKernelAlreadyObservedExit(t *testing.T) {
	var output bytes.Buffer
	server := &Server{emitter: newProtocolEmitter(protocol.NewFrameWriter(&output, protocol.MaxFrameBytes))}
	process := &terminationOrderProcess{protocolOutput: &output, terminateErr: errProcessAlreadyExited}
	managed := &managedProcess{server: server, requestID: "process:already-exited", process: process, started: true}

	accepted, err := managed.terminate(protocol.TerminationTimeout, true)
	if accepted || err != nil {
		t.Fatalf("timeout arbitration = (%v, %v), want already-exited without error", accepted, err)
	}
	if output.Len() != 0 {
		t.Fatalf("unexpected timeout acknowledgement: %s", output.String())
	}
	if !managed.processExited || managed.terminating {
		t.Fatalf("managed state = processExited:%v terminating:%v", managed.processExited, managed.terminating)
	}
}

func TestHardTimeoutTerminationFailureReportsErrorThenFailsHost(t *testing.T) {
	writer := &firstWriteGate{entered: make(chan struct{}), release: make(chan struct{})}
	close(writer.release)
	server := &Server{
		emitter: newProtocolEmitter(protocol.NewFrameWriter(writer, protocol.MaxFrameBytes)),
		fatal:   make(chan error, 1),
	}
	process := &terminationOrderProcess{
		protocolOutput: &bytes.Buffer{},
		terminateErr:   errors.New("hard-timeout termination failed"),
	}
	managed := &managedProcess{
		server:    server,
		requestID: "process:hard-timeout-failure",
		process:   process,
		done:      make(chan struct{}),
		started:   true,
	}

	managed.enforceTimeout(time.NewTimer(0))
	select {
	case err := <-server.fatal:
		if err == nil || !strings.Contains(err.Error(), "hard-timeout termination failed") {
			t.Fatalf("fatal error = %v", err)
		}
	default:
		t.Fatal("hard-timeout termination failure did not fail the host")
	}
	outputText := waitForWriterSubstring(t, writer, `"code":"PROCESS_TERMINATION_FAILED"`)
	if !strings.Contains(outputText, `"code":"PROCESS_TERMINATION_FAILED"`) {
		t.Fatalf("missing termination failure event: %s", outputText)
	}
	if strings.Contains(outputText, `"type":"terminated"`) || strings.Contains(outputText, `"type":"exited"`) {
		t.Fatalf("termination failure emitted a terminal lifecycle event: %s", outputText)
	}
}

func TestHardTimeoutFatalPrecedesBlockedErrorEmission(t *testing.T) {
	writer := &firstWriteGate{entered: make(chan struct{}), release: make(chan struct{})}
	server := &Server{
		emitter: newProtocolEmitter(protocol.NewFrameWriter(writer, protocol.MaxFrameBytes)),
		fatal:   make(chan error, 1),
	}
	process := &terminationOrderProcess{
		protocolOutput: &bytes.Buffer{},
		terminateErr:   errors.New("blocked hard-timeout termination failure"),
	}
	managed := &managedProcess{
		server:    server,
		requestID: "process:blocked-hard-timeout-failure",
		process:   process,
		done:      make(chan struct{}),
		started:   true,
	}

	enforceDone := make(chan struct{})
	go func() {
		managed.enforceTimeout(time.NewTimer(0))
		close(enforceDone)
	}()
	<-writer.entered
	select {
	case err := <-server.fatal:
		if err == nil || !strings.Contains(err.Error(), "blocked hard-timeout termination failure") {
			t.Fatalf("fatal error = %v", err)
		}
	default:
		t.Fatal("fatal was not observable while error emission was blocked")
	}
	if writer.String() != "" {
		t.Fatalf("blocked writer unexpectedly emitted data: %s", writer.String())
	}
	close(writer.release)
	select {
	case <-enforceDone:
	case <-time.After(time.Second):
		t.Fatal("timeout handler did not finish after writer release")
	}
	outputText := waitForWriterSubstring(t, writer, `"code":"PROCESS_TERMINATION_FAILED"`)
	if !strings.Contains(outputText, `"code":"PROCESS_TERMINATION_FAILED"`) || strings.Contains(outputText, `"type":"terminated"`) || strings.Contains(outputText, `"type":"exited"`) {
		t.Fatalf("unexpected timeout failure events: %s", outputText)
	}
}

func TestPreStartTimeoutFailureReportsErrorAndForcesCleanup(t *testing.T) {
	writer := &firstWriteGate{entered: make(chan struct{}), release: make(chan struct{})}
	close(writer.release)
	server := &Server{
		emitter:      newProtocolEmitter(protocol.NewFrameWriter(writer, protocol.MaxFrameBytes)),
		reservations: make(map[string]*managedProcess),
		fatal:        make(chan error, 1),
	}
	process := &terminationOrderProcess{
		protocolOutput: &bytes.Buffer{},
		terminateErr:   errors.New("kernel termination failed"),
	}
	managed := &managedProcess{
		server:    server,
		requestID: "process:pre-start-timeout-failure",
		process:   process,
		done:      make(chan struct{}),
	}
	server.reservations[managed.requestID] = managed
	server.activeWG.Add(1)

	accepted, err := managed.terminate(protocol.TerminationTimeout, true)
	if !accepted || err != nil {
		t.Fatalf("pre-start terminate = (%v, %v), want accepted with deferred error", accepted, err)
	}
	if err := server.emitter.Emit(protocol.StartedEvent{
		ProtocolVersion: protocol.Version,
		Type:            "started",
		RequestID:       managed.requestID,
		ProcessID:       process.ProcessID(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := managed.confirmStarted(); err == nil || !strings.Contains(err.Error(), "kernel termination failed") {
		t.Fatalf("confirmStarted error = %v, want deferred termination failure", err)
	}
	select {
	case fatalErr := <-server.fatal:
		if fatalErr == nil || !strings.Contains(fatalErr.Error(), "kernel termination failed") {
			t.Fatalf("fatal error = %v", fatalErr)
		}
	default:
		t.Fatal("pre-start termination failure did not fail the host")
	}
	if err := managed.abortBeforeStarted(); err != nil {
		t.Fatal(err)
	}

	outputText := waitForWriterSubstring(t, writer, `"code":"PROCESS_TERMINATION_FAILED"`)
	startedIndex := strings.Index(outputText, `"type":"started"`)
	errorIndex := strings.Index(outputText, `"code":"PROCESS_TERMINATION_FAILED"`)
	if startedIndex < 0 || errorIndex <= startedIndex || strings.Contains(outputText, `"type":"terminated"`) {
		t.Fatalf("unexpected event sequence: %s", outputText)
	}
	if process.closeCalls != 1 || process.streamCalls != 0 {
		t.Fatalf("cleanup/startIO calls = close:%d streams:%d, want close once and no streams", process.closeCalls, process.streamCalls)
	}
	server.mu.Lock()
	reservationCount := len(server.reservations)
	server.mu.Unlock()
	if reservationCount != 0 {
		t.Fatalf("reservations after cleanup = %d, want 0", reservationCount)
	}
}

func TestPreStartTerminationFailureReleasesLifecycleBeforeBlockedErrorEmission(t *testing.T) {
	var startedOutput bytes.Buffer
	server := &Server{
		emitter: newProtocolEmitter(protocol.NewFrameWriter(&startedOutput, protocol.MaxFrameBytes)),
		fatal:   make(chan error, 1),
	}
	process := &terminationOrderProcess{
		protocolOutput: &startedOutput,
		terminateErr:   errors.New("blocked pre-start termination failure"),
	}
	managed := &managedProcess{
		server:    server,
		requestID: "process:blocked-pre-start-failure",
		process:   process,
		done:      make(chan struct{}),
	}
	accepted, err := managed.terminate(protocol.TerminationTimeout, true)
	if !accepted || err != nil {
		t.Fatalf("pre-start terminate = (%v, %v)", accepted, err)
	}
	if err := server.emitter.Emit(protocol.StartedEvent{
		ProtocolVersion: protocol.Version,
		Type:            "started",
		RequestID:       managed.requestID,
		ProcessID:       process.ProcessID(),
	}); err != nil {
		t.Fatal(err)
	}

	blockedWriter := &firstWriteGate{entered: make(chan struct{}), release: make(chan struct{})}
	server.emitter = newProtocolEmitter(protocol.NewFrameWriter(blockedWriter, protocol.MaxFrameBytes))
	if err := managed.confirmStarted(); err == nil || !strings.Contains(err.Error(), "blocked pre-start termination failure") {
		t.Fatalf("confirmStarted error = %v", err)
	}
	<-blockedWriter.entered
	select {
	case fatalErr := <-server.fatal:
		if fatalErr == nil || !strings.Contains(fatalErr.Error(), "blocked pre-start termination failure") {
			t.Fatalf("fatal error = %v", fatalErr)
		}
	default:
		t.Fatal("pre-start fatal was not observable while error emission was blocked")
	}
	if !managed.lifecycleMu.TryLock() {
		t.Fatal("lifecycle mutex remained held behind protocol output")
	}
	managed.lifecycleMu.Unlock()
	close(blockedWriter.release)
	outputText := waitForWriterSubstring(t, blockedWriter, `"code":"PROCESS_TERMINATION_FAILED"`)
	if strings.Contains(outputText, `"type":"terminated"`) || strings.Contains(outputText, `"type":"exited"`) {
		t.Fatalf("unexpected terminal event: %s", outputText)
	}
}

type timedProcess struct {
	mu             sync.Mutex
	terminateCalls int
	closeCalls     int
	terminated     chan struct{}
	terminatedOnce sync.Once
}

func newTimedProcess() *timedProcess {
	return &timedProcess{terminated: make(chan struct{})}
}

func (p *timedProcess) ProcessID() uint32             { return 84 }
func (p *timedProcess) StandardInput() io.WriteCloser { return nopWriteCloser{io.Discard} }
func (p *timedProcess) StandardOutput() io.ReadCloser { return io.NopCloser(strings.NewReader("")) }
func (p *timedProcess) StandardError() io.ReadCloser  { return io.NopCloser(strings.NewReader("")) }
func (p *timedProcess) Wait() (*int64, error)         { return nil, nil }
func (p *timedProcess) Terminate() error {
	p.mu.Lock()
	p.terminateCalls++
	p.mu.Unlock()
	p.terminatedOnce.Do(func() { close(p.terminated) })
	return nil
}
func (p *timedProcess) Close() error {
	p.mu.Lock()
	p.closeCalls++
	p.mu.Unlock()
	return nil
}
func (p *timedProcess) counts() (int, int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.terminateCalls, p.closeCalls
}

type firstWriteGate struct {
	mu        sync.Mutex
	buffer    bytes.Buffer
	entered   chan struct{}
	release   chan struct{}
	once      sync.Once
	failFirst bool
}

func (w *firstWriteGate) Write(data []byte) (int, error) {
	first := false
	w.once.Do(func() {
		first = true
		close(w.entered)
	})
	if first {
		<-w.release
		if w.failFirst {
			return 0, errors.New("started event write failed")
		}
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buffer.Write(data)
}

func (w *firstWriteGate) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buffer.String()
}

func TestHardTimeoutStartsBeforeBlockedStartedEventCompletes(t *testing.T) {
	writer := &firstWriteGate{entered: make(chan struct{}), release: make(chan struct{})}
	server := &Server{emitter: newProtocolEmitter(protocol.NewFrameWriter(writer, protocol.MaxFrameBytes))}
	process := newTimedProcess()
	managed := &managedProcess{
		server:    server,
		requestID: "process:timeout-before-started",
		process:   process,
		limits:    protocol.EffectiveLimits{HardTimeout: 20 * time.Millisecond},
		done:      make(chan struct{}),
	}
	managed.armTimeout()

	startedWrite := make(chan error, 1)
	go func() {
		startedWrite <- server.emitter.Emit(protocol.StartedEvent{
			ProtocolVersion: protocol.Version,
			Type:            "started",
			RequestID:       managed.requestID,
			ProcessID:       process.ProcessID(),
		})
	}()
	<-writer.entered
	select {
	case <-process.terminated:
	case <-time.After(time.Second):
		t.Fatal("hard timeout did not terminate while the started event was blocked")
	}
	if output := writer.String(); output != "" {
		t.Fatalf("event escaped the blocked started frame: %q", output)
	}

	close(writer.release)
	if err := <-startedWrite; err != nil {
		t.Fatal(err)
	}
	if err := managed.confirmStarted(); err != nil {
		t.Fatal(err)
	}
	output := writer.String()
	startedIndex := strings.Index(output, `"type":"started"`)
	terminatedIndex := strings.Index(output, `"type":"terminated"`)
	if startedIndex < 0 || terminatedIndex <= startedIndex || strings.Count(output, "\n") != 2 {
		t.Fatalf("unexpected event order: %s", output)
	}
	managed.finishDone()
}

func TestStartedWriteFailureCancelsTimerAndCleansProcessOnce(t *testing.T) {
	writer := &firstWriteGate{
		entered:   make(chan struct{}),
		release:   make(chan struct{}),
		failFirst: true,
	}
	server := &Server{
		emitter:      newProtocolEmitter(protocol.NewFrameWriter(writer, protocol.MaxFrameBytes)),
		reservations: make(map[string]*managedProcess),
	}
	process := newTimedProcess()
	managed := &managedProcess{
		server:    server,
		requestID: "process:failed-started",
		process:   process,
		limits:    protocol.EffectiveLimits{HardTimeout: 30 * time.Millisecond},
		done:      make(chan struct{}),
	}
	server.reservations[managed.requestID] = managed
	server.activeWG.Add(1)
	managed.armTimeout()

	writeDone := make(chan error, 1)
	go func() {
		writeDone <- server.emitter.Emit(protocol.StartedEvent{Type: "started"})
	}()
	<-writer.entered
	close(writer.release)
	if err := <-writeDone; err == nil {
		t.Fatal("expected the started event write to fail")
	}
	if err := managed.abortBeforeStarted(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * managed.limits.HardTimeout)
	terminateCalls, closeCalls := process.counts()
	if terminateCalls != 1 || closeCalls != 1 {
		t.Fatalf("cleanup calls = terminate:%d close:%d, want 1 each", terminateCalls, closeCalls)
	}
	server.mu.Lock()
	reservationCount := len(server.reservations)
	server.mu.Unlock()
	if reservationCount != 0 {
		t.Fatalf("reservations after failed started event = %d, want 0", reservationCount)
	}
}

type waitFailureProcess struct{}

func (waitFailureProcess) ProcessID() uint32             { return 126 }
func (waitFailureProcess) StandardInput() io.WriteCloser { return nopWriteCloser{io.Discard} }
func (waitFailureProcess) StandardOutput() io.ReadCloser { return io.NopCloser(strings.NewReader("")) }
func (waitFailureProcess) StandardError() io.ReadCloser  { return io.NopCloser(strings.NewReader("")) }
func (waitFailureProcess) Wait() (*int64, error)         { return nil, errors.New("Job drain failed") }
func (waitFailureProcess) Terminate() error              { return nil }
func (waitFailureProcess) Close() error                  { return nil }

func TestWaitFailureReportsErrorWithoutExitedAndFailsHost(t *testing.T) {
	writer := &firstWriteGate{entered: make(chan struct{}), release: make(chan struct{})}
	close(writer.release)
	server := &Server{
		emitter:      newProtocolEmitter(protocol.NewFrameWriter(writer, protocol.MaxFrameBytes)),
		reservations: make(map[string]*managedProcess),
		fatal:        make(chan error, 1),
	}
	managed := &managedProcess{
		server:    server,
		requestID: "process:wait-failure",
		process:   waitFailureProcess{},
		limits:    protocol.EffectiveLimits{MaximumOutputBytes: 4096},
		done:      make(chan struct{}),
		started:   true,
	}
	server.reservations[managed.requestID] = managed
	server.activeWG.Add(1)
	managed.startIO(nil)

	select {
	case err := <-server.fatal:
		if err == nil || !strings.Contains(err.Error(), "Job drain failed") {
			t.Fatalf("fatal error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("wait failure did not fail the host")
	}
	outputText := waitForWriterSubstring(t, writer, `"code":"PROCESS_WAIT_FAILED"`)
	if !strings.Contains(outputText, `"code":"PROCESS_WAIT_FAILED"`) {
		t.Fatalf("missing wait error: %s", outputText)
	}
	if strings.Contains(outputText, `"type":"exited"`) {
		t.Fatalf("wait failure emitted an unproven exited event: %s", outputText)
	}
}

func TestWaitFailureFatalAndLifecycleReleasePrecedeBlockedErrorEmission(t *testing.T) {
	writer := &firstWriteGate{entered: make(chan struct{}), release: make(chan struct{})}
	server := &Server{
		emitter:      newProtocolEmitter(protocol.NewFrameWriter(writer, protocol.MaxFrameBytes)),
		reservations: make(map[string]*managedProcess),
		fatal:        make(chan error, 1),
	}
	managed := &managedProcess{
		server:    server,
		requestID: "process:blocked-wait-failure",
		process:   waitFailureProcess{},
		limits:    protocol.EffectiveLimits{MaximumOutputBytes: 4096},
		done:      make(chan struct{}),
		started:   true,
	}
	server.reservations[managed.requestID] = managed
	server.activeWG.Add(1)
	managed.startIO(nil)

	<-writer.entered
	select {
	case err := <-server.fatal:
		if err == nil || !strings.Contains(err.Error(), "Job drain failed") {
			t.Fatalf("fatal error = %v", err)
		}
	default:
		t.Fatal("wait fatal was not observable while error emission was blocked")
	}
	server.mu.Lock()
	reservationCount := len(server.reservations)
	server.mu.Unlock()
	if reservationCount != 0 {
		t.Fatalf("reservations while error emission blocked = %d, want 0", reservationCount)
	}
	activeDone := make(chan struct{})
	go func() {
		server.activeWG.Wait()
		close(activeDone)
	}()
	select {
	case <-activeDone:
	case <-time.After(time.Second):
		t.Fatal("active lifecycle remained blocked behind protocol output")
	}

	close(writer.release)
	outputText := waitForWriterSubstring(t, writer, `"code":"PROCESS_WAIT_FAILED"`)
	if !strings.Contains(outputText, `"code":"PROCESS_WAIT_FAILED"`) || strings.Contains(outputText, `"type":"exited"`) {
		t.Fatalf("unexpected wait failure events: %s", outputText)
	}
}

func waitForWriterSubstring(t *testing.T, writer *firstWriteGate, substring string) string {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		output := writer.String()
		if strings.Contains(output, substring) {
			return output
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %q in %q", substring, output)
		}
		time.Sleep(time.Millisecond)
	}
}
