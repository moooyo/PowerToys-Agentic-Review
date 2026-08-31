package localrpc

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
)

func TestServerDispatchesConcurrentTypedCallsAndCorrelatesResponses(t *testing.T) {
	dispatcher := &fakeControlDispatcher{}
	harness := newServerHarness(t, dispatcher, defaultServerOptions())
	defer harness.close(t)

	harness.send(t, callDocument(t, "register:1", OperationRegister, map[string]any{
		"body": map[string]any{"workerNodeId": "node:1"},
	}))
	harness.send(t, callDocument(t, "sign:1", OperationSignLocalDigest, map[string]any{
		"digestSha256": strings.Repeat("a", 64),
	}))

	responses := harness.readResponses(t, 2, MaximumFrameBytes)
	if responses["register:1"]["outcome"] != "ok" || responses["sign:1"]["outcome"] != "ok" {
		t.Fatalf("unexpected responses: %#v", responses)
	}
	signBody := responses["sign:1"]["body"].(map[string]any)
	if signature, ok := signBody["signatureP1363"].(string); !ok || len(signature) != 86 {
		t.Fatalf("signature response = %#v", signBody)
	}
	if dispatcher.signDigest != strings.Repeat("aa", 32) {
		t.Fatalf("dispatcher digest = %q", dispatcher.signDigest)
	}
}

func TestServerOptionsEnforceRoleAndBounds(t *testing.T) {
	valid := defaultServerOptions()
	if _, err := NewServer(valid, nil); !errors.Is(err, ErrInvalidServerOptions) {
		t.Fatalf("control server without dispatcher error = %v", err)
	}
	executor := valid
	executor.Role = RoleExecutor
	if _, err := NewServer(executor, nil); err != nil {
		t.Fatalf("executor transport-only server was rejected: %v", err)
	}
	tooConcurrent := valid
	tooConcurrent.MaximumConcurrentRequests = maximumConfiguredConcurrency + 1
	if _, err := NewServer(tooConcurrent, &fakeControlDispatcher{}); !errors.Is(err, ErrInvalidServerOptions) {
		t.Fatalf("excess concurrency error = %v", err)
	}
	missingIOTimeout := valid
	missingIOTimeout.IOTimeout = 0
	if _, err := NewServer(missingIOTimeout, &fakeControlDispatcher{}); !errors.Is(err, ErrInvalidServerOptions) {
		t.Fatalf("missing I/O timeout error = %v", err)
	}
}

func TestServerCancelsOneConcurrentRequestWithoutStoppingAnother(t *testing.T) {
	claimStarted := make(chan struct{})
	releaseRegister := make(chan struct{})
	dispatcher := &fakeControlDispatcher{
		claim: func(ctx context.Context, _ json.RawMessage) (json.RawMessage, error) {
			close(claimStarted)
			<-ctx.Done()
			return nil, context.Cause(ctx)
		},
		register: func(context.Context, json.RawMessage) (json.RawMessage, error) {
			<-releaseRegister
			return json.RawMessage(`{"registered":true}`), nil
		},
	}
	harness := newServerHarness(t, dispatcher, defaultServerOptions())
	defer harness.close(t)

	harness.send(t, callDocument(t, "claim:1", OperationClaim, map[string]any{"body": map[string]any{}}))
	select {
	case <-claimStarted:
	case <-time.After(time.Second):
		t.Fatal("claim did not start")
	}
	harness.send(t, callDocument(t, "register:1", OperationRegister, map[string]any{"body": map[string]any{}}))
	harness.send(t, canonicalForTest(t, map[string]any{
		"protocolVersion": ProtocolVersion,
		"requestId":       "cancel:1",
		"targetRequestId": "claim:1",
		"type":            "cancel",
	}))
	close(releaseRegister)

	responses := harness.readResponses(t, 3, MaximumClaimResponseFrameBytes)
	if responses["cancel:1"]["outcome"] != "ok" || responses["register:1"]["outcome"] != "ok" {
		t.Fatalf("cancel or independent request failed: %#v", responses)
	}
	assertResponseErrorCode(t, responses["claim:1"], "REQUEST_CANCELLED")
}

func TestServerAppliesOperationTimeoutAndSanitizesHandlerErrors(t *testing.T) {
	options := defaultServerOptions()
	options.RequestTimeout = 20 * time.Millisecond
	dispatcher := &fakeControlDispatcher{
		register: func(ctx context.Context, _ json.RawMessage) (json.RawMessage, error) {
			<-ctx.Done()
			return nil, context.Cause(ctx)
		},
		failRun: func(context.Context, string, json.RawMessage) (json.RawMessage, error) {
			return nil, errors.New("server=https://private.invalid bearer=secret")
		},
	}
	harness := newServerHarness(t, dispatcher, options)
	defer harness.close(t)

	harness.send(t, callDocument(t, "register:1", OperationRegister, map[string]any{"body": map[string]any{}}))
	harness.send(t, callDocument(t, "fail:1", OperationFailRun, map[string]any{
		"body": map[string]any{}, "runAttemptId": "run:1",
	}))
	responses := harness.readResponses(t, 2, MaximumFrameBytes)
	assertResponseErrorCode(t, responses["register:1"], "REQUEST_TIMEOUT")
	assertResponseErrorCode(t, responses["fail:1"], "INTERNAL_ERROR")
	serialized := string(canonicalForTest(t, responses["fail:1"]))
	if strings.Contains(serialized, "private.invalid") || strings.Contains(serialized, "bearer") {
		t.Fatalf("sanitized response disclosed handler error: %s", serialized)
	}
}

func TestServerSanitizesDispatcherPanic(t *testing.T) {
	dispatcher := &fakeControlDispatcher{
		register: func(context.Context, json.RawMessage) (json.RawMessage, error) {
			panic("credential=must-not-cross")
		},
	}
	harness := newServerHarness(t, dispatcher, defaultServerOptions())
	defer harness.close(t)
	harness.send(t, callDocument(t, "panic:1", OperationRegister, map[string]any{"body": map[string]any{}}))
	response := harness.readResponse(t, MaximumFrameBytes)
	assertResponseErrorCode(t, response, "INTERNAL_ERROR")
	if bytes.Contains(canonicalForTest(t, response), []byte("must-not-cross")) {
		t.Fatalf("panic value crossed the RPC boundary: %#v", response)
	}
}

func TestServerKeepsClaimResponseOnDedicated16MiBPath(t *testing.T) {
	largeValue := strings.Repeat("x", MaximumFrameBytes+1024)
	largeBody := json.RawMessage(canonicalForTest(t, map[string]any{"value": largeValue}))
	dispatcher := &fakeControlDispatcher{
		claim: func(context.Context, json.RawMessage) (json.RawMessage, error) {
			return largeBody, nil
		},
		register: func(context.Context, json.RawMessage) (json.RawMessage, error) {
			return largeBody, nil
		},
	}
	harness := newServerHarness(t, dispatcher, defaultServerOptions())
	defer harness.close(t)

	harness.send(t, callDocument(t, "claim:1", OperationClaim, map[string]any{"body": map[string]any{}}))
	claimResponse := harness.readResponse(t, MaximumClaimResponseFrameBytes)
	if claimResponse["outcome"] != "ok" {
		t.Fatalf("large claim response failed: %#v", claimResponse)
	}

	harness.send(t, callDocument(t, "register:1", OperationRegister, map[string]any{"body": map[string]any{}}))
	registerResponse := harness.readResponse(t, MaximumFrameBytes)
	assertResponseErrorCode(t, registerResponse, "INVALID_HANDLER_RESPONSE")
}

func TestServerRejectsDuplicateRequestIDAndClosesSession(t *testing.T) {
	harness := newServerHarness(t, &fakeControlDispatcher{}, defaultServerOptions())
	document := callDocument(t, "duplicate:1", OperationRegister, map[string]any{"body": map[string]any{}})
	harness.send(t, document)
	_ = harness.readResponse(t, MaximumFrameBytes)
	harness.send(t, document)
	response := harness.readResponse(t, MaximumFrameBytes)
	assertResponseErrorCode(t, response, "DUPLICATE_REQUEST_ID")
	select {
	case err := <-harness.done:
		if !errors.Is(err, ErrDuplicateRequestID) {
			t.Fatalf("Serve error = %v, want duplicate requestId", err)
		}
	case <-time.After(time.Second):
		t.Fatal("server did not close after duplicate requestId")
	}
	harness.output.Close()
}

func TestServerBoundsPartialInputAndBlockedOutput(t *testing.T) {
	t.Run("partial input", func(t *testing.T) {
		options := defaultServerOptions()
		options.IOTimeout = 20 * time.Millisecond
		server, err := NewServer(options, &fakeControlDispatcher{})
		if err != nil {
			t.Fatal(err)
		}
		inputReader, inputWriter := io.Pipe()
		outputReader, outputWriter := io.Pipe()
		done := make(chan error, 1)
		go func() { done <- server.Serve(context.Background(), inputReader, outputWriter) }()
		if _, err := inputWriter.Write([]byte{10, 0, 0, 0, '{'}); err != nil {
			t.Fatal(err)
		}
		select {
		case err := <-done:
			if !errors.Is(err, ErrIOTimeout) {
				t.Fatalf("Serve error = %v, want ErrIOTimeout", err)
			}
		case <-time.After(time.Second):
			t.Fatal("partial frame did not time out")
		}
		_ = inputWriter.Close()
		_ = outputReader.Close()
	})

	t.Run("blocked output", func(t *testing.T) {
		options := defaultServerOptions()
		options.IOTimeout = 20 * time.Millisecond
		server, err := NewServer(options, &fakeControlDispatcher{})
		if err != nil {
			t.Fatal(err)
		}
		request := callDocument(t, "register:1", OperationRegister, map[string]any{"body": map[string]any{}})
		inputReader, inputWriter := io.Pipe()
		output := newBlockingWriteCloser()
		done := make(chan error, 1)
		go func() { done <- server.Serve(context.Background(), inputReader, output) }()
		if err := WriteFrame(inputWriter, request, MaximumFrameBytes); err != nil {
			t.Fatal(err)
		}
		select {
		case err := <-done:
			if !errors.Is(err, ErrIOTimeout) {
				t.Fatalf("Serve error = %v, want ErrIOTimeout", err)
			}
		case <-time.After(time.Second):
			t.Fatal("blocked output did not time out")
		}
		_ = inputWriter.Close()
	})

	t.Run("blocked close", func(t *testing.T) {
		options := defaultServerOptions()
		options.IOTimeout = 20 * time.Millisecond
		server, err := NewServer(options, &fakeControlDispatcher{})
		if err != nil {
			t.Fatal(err)
		}
		inputReader, inputWriter := io.Pipe()
		output := newStubbornWriteCloser()
		done := make(chan error, 1)
		go func() { done <- server.Serve(context.Background(), inputReader, output) }()
		request := callDocument(t, "register:1", OperationRegister, map[string]any{"body": map[string]any{}})
		if err := WriteFrame(inputWriter, request, MaximumFrameBytes); err != nil {
			t.Fatal(err)
		}
		select {
		case err := <-done:
			if !errors.Is(err, ErrIOTimeout) {
				t.Fatalf("Serve error = %v, want ErrIOTimeout", err)
			}
		case <-time.After(time.Second):
			t.Fatal("blocking Close defeated the I/O timeout")
		}
		close(output.release)
		_ = inputWriter.Close()
	})
}

func TestConcurrencyReservationIncludesResponseWrite(t *testing.T) {
	state := newSessionState(10)
	ctx := context.Background()
	_, cancelFirst, accepted := state.start(ctx, "first", 1, time.Second)
	if !accepted {
		t.Fatal("first request was not accepted")
	}
	state.finishDispatch("first")
	if _, _, accepted := state.start(ctx, "second", 1, time.Second); accepted {
		t.Fatal("response-phase request released its concurrency reservation too early")
	}
	state.complete()
	cancelFirst(nil)
	_, cancelThird, accepted := state.start(ctx, "third", 1, time.Second)
	if !accepted {
		t.Fatal("completed response did not release its concurrency reservation")
	}
	state.finishDispatch("third")
	state.complete()
	cancelThird(nil)
}

type fakeControlDispatcher struct {
	register   func(context.Context, json.RawMessage) (json.RawMessage, error)
	claim      func(context.Context, json.RawMessage) (json.RawMessage, error)
	failRun    func(context.Context, string, json.RawMessage) (json.RawMessage, error)
	signDigest string
	mu         sync.Mutex
}

func (d *fakeControlDispatcher) Register(ctx context.Context, body json.RawMessage) (json.RawMessage, error) {
	if d.register != nil {
		return d.register(ctx, body)
	}
	return json.RawMessage(`{"registered":true}`), nil
}

func (d *fakeControlDispatcher) Claim(ctx context.Context, body json.RawMessage) (json.RawMessage, error) {
	if d.claim != nil {
		return d.claim(ctx, body)
	}
	return json.RawMessage(`{"outcome":"no_work"}`), nil
}

func (*fakeControlDispatcher) InstanceHeartbeat(context.Context, string, json.RawMessage) (json.RawMessage, error) {
	return json.RawMessage(`{"workerState":"online"}`), nil
}

func (*fakeControlDispatcher) CompleteRun(context.Context, string, json.RawMessage) (json.RawMessage, error) {
	return json.RawMessage(`{"runState":"succeeded"}`), nil
}

func (d *fakeControlDispatcher) FailRun(ctx context.Context, id string, body json.RawMessage) (json.RawMessage, error) {
	if d.failRun != nil {
		return d.failRun(ctx, id, body)
	}
	return json.RawMessage(`{"runState":"failed"}`), nil
}

func (d *fakeControlDispatcher) SignLocalDigest(_ context.Context, digest [32]byte) ([]byte, error) {
	d.mu.Lock()
	d.signDigest = bytesToHex(digest[:])
	d.mu.Unlock()
	return bytes.Repeat([]byte{1}, 64), nil
}

func bytesToHex(value []byte) string {
	const alphabet = "0123456789abcdef"
	result := make([]byte, len(value)*2)
	for index, item := range value {
		result[index*2] = alphabet[item>>4]
		result[index*2+1] = alphabet[item&0x0f]
	}
	return string(result)
}

func defaultServerOptions() ServerOptions {
	return ServerOptions{
		Role: RoleControl, MaximumConcurrentRequests: 4, MaximumRequestsPerSession: 100,
		RequestTimeout: time.Second, ClaimTimeout: time.Second, IOTimeout: time.Second,
		ShutdownTimeout: time.Second,
	}
}

type serverHarness struct {
	input  *io.PipeWriter
	output *io.PipeReader
	done   chan error
}

type blockingWriteCloser struct {
	closed chan struct{}
	once   sync.Once
}

type stubbornWriteCloser struct {
	release chan struct{}
}

func newStubbornWriteCloser() *stubbornWriteCloser {
	return &stubbornWriteCloser{release: make(chan struct{})}
}

func (w *stubbornWriteCloser) Write([]byte) (int, error) {
	<-w.release
	return 0, io.ErrClosedPipe
}

func (w *stubbornWriteCloser) Close() error {
	<-w.release
	return nil
}

func newBlockingWriteCloser() *blockingWriteCloser {
	return &blockingWriteCloser{closed: make(chan struct{})}
}

func (w *blockingWriteCloser) Write([]byte) (int, error) {
	<-w.closed
	return 0, io.ErrClosedPipe
}

func (w *blockingWriteCloser) Close() error {
	w.once.Do(func() { close(w.closed) })
	return nil
}

func newServerHarness(t *testing.T, dispatcher ControlDispatcher, options ServerOptions) *serverHarness {
	t.Helper()
	server, err := NewServer(options, dispatcher)
	if err != nil {
		t.Fatalf("NewServer returned an error: %v", err)
	}
	inputReader, inputWriter := io.Pipe()
	outputReader, outputWriter := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- server.Serve(context.Background(), inputReader, outputWriter) }()
	return &serverHarness{input: inputWriter, output: outputReader, done: done}
}

func (h *serverHarness) send(t *testing.T, document []byte) {
	t.Helper()
	if err := WriteFrame(h.input, document, MaximumFrameBytes); err != nil {
		t.Fatalf("send local RPC request: %v", err)
	}
}

func (h *serverHarness) readResponse(t *testing.T, maximum int) map[string]any {
	t.Helper()
	document, err := ReadFrame(h.output, maximum)
	if err != nil {
		t.Fatalf("read local RPC response: %v", err)
	}
	value, err := ParseCanonicalJSON(document, maximum)
	if err != nil {
		t.Fatalf("response is not canonical: %v", err)
	}
	response, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("response is not an object: %#v", value)
	}
	return response
}

func (h *serverHarness) readResponses(t *testing.T, count int, maximum int) map[string]map[string]any {
	t.Helper()
	responses := make(map[string]map[string]any, count)
	for range count {
		response := h.readResponse(t, maximum)
		requestID, ok := response["requestId"].(string)
		if !ok {
			t.Fatalf("response has no requestId: %#v", response)
		}
		responses[requestID] = response
	}
	return responses
}

func (h *serverHarness) close(t *testing.T) {
	t.Helper()
	_ = h.input.Close()
	select {
	case err := <-h.done:
		if !errors.Is(err, ErrPeerClosed) {
			t.Errorf("Serve error = %v, want ErrPeerClosed", err)
		}
	case <-time.After(time.Second):
		t.Error("server did not stop after input close")
	}
	_ = h.output.Close()
}

func callDocument(t *testing.T, requestID string, operation Operation, payload map[string]any) []byte {
	t.Helper()
	return canonicalForTest(t, map[string]any{
		"operation": operation, "payload": payload, "protocolVersion": ProtocolVersion,
		"requestId": requestID, "type": "call",
	})
}

func assertResponseErrorCode(t *testing.T, response map[string]any, expected string) {
	t.Helper()
	if response["outcome"] != "error" {
		t.Fatalf("response outcome = %#v", response)
	}
	errorValue, ok := response["error"].(map[string]any)
	if !ok || errorValue["code"] != expected {
		t.Fatalf("response error = %#v, want %s", response["error"], expected)
	}
}
