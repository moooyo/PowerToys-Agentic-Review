package localrpc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"sync/atomic"
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
	if _, err := NewServer(defaultServerOptions(), &fakeControlDispatcher{}); !errors.Is(err, ErrInvalidServerOptions) {
		t.Fatalf("server without committed bootstrap error = %v", err)
	}
	valid := serverOptionsWithBootstrapForTest(t, defaultServerOptions(), &serverTestChannel{})
	if _, err := NewServer(valid, nil); !errors.Is(err, ErrInvalidServerOptions) {
		t.Fatalf("control server without dispatcher error = %v", err)
	}
	typedNilOptions := serverOptionsWithBootstrapForTest(t, defaultServerOptions(), &serverTestChannel{})
	var typedNilDispatcher *fakeControlDispatcher
	if _, err := NewServer(typedNilOptions, typedNilDispatcher); !errors.Is(err, ErrInvalidServerOptions) {
		t.Fatalf("control server with typed-nil dispatcher error = %v", err)
	}
	if _, err := NewServer(typedNilOptions, &fakeControlDispatcher{}); err != nil {
		t.Fatalf("typed-nil rejection consumed committed bootstrap: %v", err)
	}
	executor := defaultServerOptions()
	executor.Role = RoleExecutor
	executor = serverOptionsWithBootstrapForTest(t, executor, &serverTestChannel{})
	if _, err := NewServer(executor, nil); err != nil {
		t.Fatalf("executor transport-only server was rejected: %v", err)
	}
	tooConcurrent := serverOptionsWithBootstrapForTest(t, defaultServerOptions(), &serverTestChannel{})
	tooConcurrent.MaximumConcurrentRequests = maximumConfiguredConcurrency + 1
	if _, err := NewServer(tooConcurrent, &fakeControlDispatcher{}); !errors.Is(err, ErrInvalidServerOptions) {
		t.Fatalf("excess concurrency error = %v", err)
	}
	missingIOTimeout := serverOptionsWithBootstrapForTest(t, defaultServerOptions(), &serverTestChannel{})
	missingIOTimeout.IOTimeout = 0
	if _, err := NewServer(missingIOTimeout, &fakeControlDispatcher{}); !errors.Is(err, ErrInvalidServerOptions) {
		t.Fatalf("missing I/O timeout error = %v", err)
	}
	reusable := serverOptionsWithBootstrapForTest(t, defaultServerOptions(), &serverTestChannel{})
	if _, err := NewServer(reusable, &fakeControlDispatcher{}); err != nil {
		t.Fatal(err)
	}
	if _, err := NewServer(reusable, &fakeControlDispatcher{}); !errors.Is(err, ErrInvalidServerOptions) {
		t.Fatalf("reused committed bootstrap error = %v", err)
	}
	mismatched := serverOptionsWithBootstrapForTest(t, defaultServerOptions(), &serverTestChannel{})
	mismatched.Role = RoleExecutor
	if _, err := NewServer(mismatched, nil); !errors.Is(err, ErrInvalidServerOptions) {
		t.Fatalf("role-mismatched committed bootstrap error = %v", err)
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
	largeValue := strings.Repeat("x", MaximumClaimResponseBodyBytes-len(`{"value":""}`))
	largeBody := json.RawMessage(canonicalForTest(t, map[string]any{"value": largeValue}))
	dispatcher := &fakeControlDispatcher{
		claim: func(context.Context, json.RawMessage) (json.RawMessage, error) {
			return largeBody, nil
		},
		register: func(context.Context, json.RawMessage) (json.RawMessage, error) {
			return largeBody, nil
		},
	}
	options := defaultServerOptions()
	options.IOTimeout = 10 * time.Second
	harness := newServerHarness(t, dispatcher, options)
	defer harness.close(t)

	claimID := strings.Repeat("c", maximumIdentifierBytes)
	harness.send(t, callDocument(t, claimID, OperationClaim, map[string]any{"body": map[string]any{}}))
	claimResponse := harness.readResponse(t, MaximumClaimResponseFrameBytes)
	if claimResponse["outcome"] != "ok" {
		t.Fatalf("large claim response failed: %#v", claimResponse)
	}

	harness.send(t, callDocument(t, "register:1", OperationRegister, map[string]any{"body": map[string]any{}}))
	registerResponse := harness.readResponse(t, MaximumFrameBytes)
	assertResponseErrorCode(t, registerResponse, "INVALID_HANDLER_RESPONSE")
}

func TestServerAcceptsLargeCompletionWithoutRelaxingOtherRequests(t *testing.T) {
	largeBody := map[string]any{"result": strings.Repeat("x", MaximumWorkerAPIBodyBytes+512)}
	seen := make(chan int, 1)
	dispatcher := &fakeControlDispatcher{
		completeRun: func(_ context.Context, _ string, body json.RawMessage) (json.RawMessage, error) {
			seen <- len(body)
			return json.RawMessage(`{"runState":"succeeded"}`), nil
		},
	}
	harness := newServerHarness(t, dispatcher, defaultServerOptions())
	defer harness.close(t)

	document := callDocument(t, "complete:large", OperationCompleteRun, map[string]any{
		"body": largeBody, "runAttemptId": "run:large",
	})
	if len(document) <= MaximumFrameBytes || len(document) > MaximumRequestFrameBytes {
		t.Fatalf("completion fixture has unexpected size %d", len(document))
	}
	harness.send(t, document)
	response := harness.readResponse(t, MaximumFrameBytes)
	if response["outcome"] != "ok" {
		t.Fatalf("large completion failed: %#v", response)
	}
	if got := <-seen; got <= MaximumWorkerAPIBodyBytes {
		t.Fatalf("dispatcher received only %d completion bytes", got)
	}
}

func TestServerPreservesExactWorkerAPIBodiesAcrossDescriptorBoundary(t *testing.T) {
	requestBody := json.RawMessage(" { \"confidence\" : 0.8, \"escaped\" : \"\\u0061\" } ")
	responseBody := json.RawMessage(" { \"z\" : 1e0, \"a\" : -0 } \n")
	dispatcher := &fakeControlDispatcher{
		register: func(_ context.Context, body json.RawMessage) (json.RawMessage, error) {
			if !bytes.Equal(body, requestBody) {
				t.Fatalf("dispatcher body = %q, want %q", body, requestBody)
			}
			body[0] = '['
			return responseBody, nil
		},
	}
	harness := newServerHarness(t, dispatcher, defaultServerOptions())
	defer harness.close(t)
	harness.send(t, callDocument(t, "register:exact", OperationRegister, map[string]any{"body": requestBody}))
	response := harness.readResponse(t, MaximumFrameBytes)
	decoded := workerAPIBodyFromResponseForTest(t, response, MaximumWorkerAPIBodyBytes)
	if !bytes.Equal(decoded, responseBody) {
		t.Fatalf("response body = %q, want %q", decoded, responseBody)
	}
	responseBody[0] = '['
	if decoded[0] != ' ' {
		t.Fatal("encoded response aliases dispatcher storage")
	}
	if requestBody[0] != ' ' {
		t.Fatal("dispatcher mutation escaped into caller request storage")
	}
}

func TestServerSerializesClaimDispatchThroughResponseWrite(t *testing.T) {
	started := make(chan int32, 2)
	releaseFirst := make(chan struct{})
	var calls atomic.Int32
	dispatcher := &fakeControlDispatcher{
		claim: func(context.Context, json.RawMessage) (json.RawMessage, error) {
			call := calls.Add(1)
			started <- call
			if call == 1 {
				<-releaseFirst
			}
			return json.RawMessage(`{"outcome":"no_work"}`), nil
		},
	}
	harness := newServerHarness(t, dispatcher, defaultServerOptions())
	defer harness.close(t)
	harness.send(t, callDocument(t, "claim:1", OperationClaim, map[string]any{"body": map[string]any{}}))
	if call := <-started; call != 1 {
		t.Fatalf("first claim call = %d", call)
	}
	harness.send(t, callDocument(t, "claim:2", OperationClaim, map[string]any{"body": map[string]any{}}))
	select {
	case call := <-started:
		t.Fatalf("second claim started before first response completed: %d", call)
	case <-time.After(20 * time.Millisecond):
	}
	close(releaseFirst)
	first := harness.readResponse(t, MaximumClaimResponseFrameBytes)
	if first["requestId"] != "claim:1" {
		t.Fatalf("first claim response = %#v", first)
	}
	select {
	case call := <-started:
		if call != 2 {
			t.Fatalf("second claim call = %d", call)
		}
	case <-time.After(time.Second):
		t.Fatal("second claim did not start after first response completed")
	}
	second := harness.readResponse(t, MaximumClaimResponseFrameBytes)
	if second["requestId"] != "claim:2" {
		t.Fatalf("second claim response = %#v", second)
	}
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
		inputReader, inputWriter := io.Pipe()
		outputReader, outputWriter := io.Pipe()
		channel := newServerTestChannel(inputReader, outputWriter)
		options = serverOptionsWithBootstrapForTest(t, options, channel)
		server, err := NewServer(options, &fakeControlDispatcher{})
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- server.Serve(context.Background(), channel, channel) }()
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
		inputReader, inputWriter := io.Pipe()
		output := newBlockingWriteCloser()
		channel := newServerTestChannel(inputReader, output)
		options = serverOptionsWithBootstrapForTest(t, options, channel)
		server, err := NewServer(options, &fakeControlDispatcher{})
		if err != nil {
			t.Fatal(err)
		}
		request := callDocument(t, "register:1", OperationRegister, map[string]any{"body": map[string]any{}})
		done := make(chan error, 1)
		go func() { done <- server.Serve(context.Background(), channel, channel) }()
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
		inputReader, inputWriter := io.Pipe()
		output := newStubbornWriteCloser()
		channel := newServerTestChannel(inputReader, output)
		options = serverOptionsWithBootstrapForTest(t, options, channel)
		server, err := NewServer(options, &fakeControlDispatcher{})
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- server.Serve(context.Background(), channel, channel) }()
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

func TestResponseWriterDoesNotStartWriteAfterBuildDeadline(t *testing.T) {
	buildStarted := make(chan struct{})
	releaseBuild := make(chan struct{})
	buildFinished := make(chan struct{})
	output := &signalingWriter{writes: make(chan []byte, 1)}
	writer := &responseWriter{
		context: context.Background(), output: output, timeout: 20 * time.Millisecond,
		closeOutput: func() {},
	}
	result := make(chan error, 1)
	go func() {
		result <- writer.buildAndWrite(MaximumCanonicalControlFrameBytes, func() ([]byte, error) {
			close(buildStarted)
			<-releaseBuild
			close(buildFinished)
			return []byte(`{}`), nil
		})
	}()
	<-buildStarted
	if err := <-result; !errors.Is(err, ErrIOTimeout) {
		t.Fatalf("buildAndWrite error = %v", err)
	}
	close(releaseBuild)
	<-buildFinished
	select {
	case written := <-output.writes:
		t.Fatalf("writer started after its deadline: %q", written)
	case <-time.After(20 * time.Millisecond):
	}
}

type fakeControlDispatcher struct {
	register    func(context.Context, json.RawMessage) (json.RawMessage, error)
	claim       func(context.Context, json.RawMessage) (json.RawMessage, error)
	completeRun func(context.Context, string, json.RawMessage) (json.RawMessage, error)
	failRun     func(context.Context, string, json.RawMessage) (json.RawMessage, error)
	signDigest  string
	mu          sync.Mutex
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

func (d *fakeControlDispatcher) CompleteRun(ctx context.Context, id string, body json.RawMessage) (json.RawMessage, error) {
	if d.completeRun != nil {
		return d.completeRun(ctx, id, body)
	}
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

type serverTestChannel struct {
	input     io.ReadCloser
	output    io.WriteCloser
	closeOnce sync.Once
	closeErr  error
}

type blockingWriteCloser struct {
	closed chan struct{}
	once   sync.Once
}

type stubbornWriteCloser struct {
	release chan struct{}
}

type signalingWriter struct {
	writes chan []byte
}

func (w *signalingWriter) Write(value []byte) (int, error) {
	w.writes <- bytes.Clone(value)
	return len(value), nil
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
	inputReader, inputWriter := io.Pipe()
	outputReader, outputWriter := io.Pipe()
	channel := newServerTestChannel(inputReader, outputWriter)
	options = serverOptionsWithBootstrapForTest(t, options, channel)
	server, err := NewServer(options, dispatcher)
	if err != nil {
		t.Fatalf("NewServer returned an error: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(context.Background(), channel, channel) }()
	return &serverHarness{input: inputWriter, output: outputReader, done: done}
}

func newServerTestChannel(input io.ReadCloser, output io.WriteCloser) *serverTestChannel {
	return &serverTestChannel{input: input, output: output}
}

func (channel *serverTestChannel) Read(buffer []byte) (int, error) {
	if channel.input == nil {
		return 0, io.ErrClosedPipe
	}
	return channel.input.Read(buffer)
}

func (channel *serverTestChannel) Write(buffer []byte) (int, error) {
	if channel.output == nil {
		return 0, io.ErrClosedPipe
	}
	return channel.output.Write(buffer)
}

func (channel *serverTestChannel) ReadContext(ctx context.Context, buffer []byte) (int, error) {
	if cause := context.Cause(ctx); cause != nil {
		return 0, cause
	}
	return channel.Read(buffer)
}

func (channel *serverTestChannel) WriteContext(ctx context.Context, buffer []byte) (int, error) {
	if cause := context.Cause(ctx); cause != nil {
		return 0, cause
	}
	return channel.Write(buffer)
}

func (channel *serverTestChannel) Close() error {
	channel.closeOnce.Do(func() {
		var inputErr error
		if channel.input != nil {
			inputErr = channel.input.Close()
		}
		var outputErr error
		if channel.output != nil {
			outputErr = channel.output.Close()
		}
		channel.closeErr = errors.Join(inputErr, outputErr)
	})
	return channel.closeErr
}

func serverOptionsWithBootstrapForTest(
	t *testing.T,
	options ServerOptions,
	channel RuntimeBootstrapChannel,
) ServerOptions {
	t.Helper()
	options.RuntimeBootstrap = committedRuntimeBootstrapForArmTest(t, channel, options.Role)
	return options
}

func (h *serverHarness) send(t *testing.T, document []byte) {
	t.Helper()
	if err := WriteFrame(h.input, document, MaximumRequestFrameBytes); err != nil {
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
	payload = cloneObjectForTest(payload)
	if body, exists := payload["body"]; exists {
		var document []byte
		switch typed := body.(type) {
		case json.RawMessage:
			document = bytes.Clone(typed)
		case []byte:
			document = bytes.Clone(typed)
		default:
			document = canonicalForTest(t, typed)
		}
		payload["body"] = rawBodyDescriptorForTest(document)
	}
	return canonicalForTest(t, map[string]any{
		"operation": operation, "payload": payload, "protocolVersion": ProtocolVersion,
		"requestId": requestID, "type": "call",
	})
}

func workerAPIBodyFromResponseForTest(t *testing.T, response map[string]any, maximumBytes int) []byte {
	t.Helper()
	descriptor, ok := response["body"].(map[string]any)
	if !ok {
		t.Fatalf("response body descriptor = %#v", response["body"])
	}
	body, err := decodeWorkerAPIBodyDescriptor(canonicalForTest(t, descriptor), maximumBytes)
	if err != nil {
		t.Fatalf("decode response body descriptor: %v", err)
	}
	return body
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
