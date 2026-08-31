package platform

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/framing"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winprocess"
)

type nodeEndpointTestInput struct {
	mu                sync.Mutex
	maximumWrite      int
	written           []byte
	writeContexts     []context.Context
	closeWriteContext context.Context
	closeWriteCalls   int
	closeWriteErr     error
	closeCalls        int
}

func (stream *nodeEndpointTestInput) Write(value []byte) (int, error) {
	return stream.WriteContext(context.Background(), value)
}

func (stream *nodeEndpointTestInput) WriteContext(ctx context.Context, value []byte) (int, error) {
	stream.mu.Lock()
	defer stream.mu.Unlock()
	stream.writeContexts = append(stream.writeContexts, ctx)
	count := len(value)
	if stream.maximumWrite > 0 && count > stream.maximumWrite {
		count = stream.maximumWrite
	}
	stream.written = append(stream.written, value[:count]...)
	return count, nil
}

func (stream *nodeEndpointTestInput) CloseWrite(ctx context.Context) error {
	stream.mu.Lock()
	defer stream.mu.Unlock()
	stream.closeWriteCalls++
	stream.closeWriteContext = ctx
	return stream.closeWriteErr
}

func (stream *nodeEndpointTestInput) Close() error {
	stream.mu.Lock()
	defer stream.mu.Unlock()
	stream.closeCalls++
	return nil
}

type nodeEndpointTestOutput struct {
	mu                    sync.Mutex
	data                  []byte
	offset                int
	maximumRead           int
	terminal              error
	terminalWithFinalData bool
	readContexts          []context.Context
	readCalls             int
	closeCalls            int
	read                  func(context.Context, []byte) (int, error)
}

func (stream *nodeEndpointTestOutput) Read(value []byte) (int, error) {
	return stream.ReadContext(context.Background(), value)
}

func (stream *nodeEndpointTestOutput) ReadContext(ctx context.Context, value []byte) (int, error) {
	stream.mu.Lock()
	stream.readContexts = append(stream.readContexts, ctx)
	stream.readCalls++
	read := stream.read
	if read != nil {
		stream.mu.Unlock()
		return read(ctx, value)
	}
	if stream.offset < len(stream.data) {
		count := len(stream.data) - stream.offset
		if count > len(value) {
			count = len(value)
		}
		if stream.maximumRead > 0 && count > stream.maximumRead {
			count = stream.maximumRead
		}
		copy(value, stream.data[stream.offset:stream.offset+count])
		stream.offset += count
		var err error
		if stream.terminalWithFinalData && stream.offset == len(stream.data) {
			err = stream.terminal
		}
		stream.mu.Unlock()
		return count, err
	}
	err := stream.terminal
	stream.mu.Unlock()
	return 0, err
}

func (stream *nodeEndpointTestOutput) Close() error {
	stream.mu.Lock()
	defer stream.mu.Unlock()
	stream.closeCalls++
	return nil
}

type nodeEndpointTestOwner struct {
	input  winprocess.NodeStandardInput
	output winprocess.NodeStandardOutput
	stderr winprocess.NodeStandardOutput

	closeCalls atomic.Int32
	closeStart chan struct{}
	closeBlock chan struct{}
	closeErr   error
}

func (owner *nodeEndpointTestOwner) StandardInput() winprocess.NodeStandardInput { return owner.input }
func (owner *nodeEndpointTestOwner) StandardOutput() winprocess.NodeStandardOutput {
	return owner.output
}
func (owner *nodeEndpointTestOwner) StandardError() winprocess.NodeStandardOutput {
	return owner.stderr
}

func (owner *nodeEndpointTestOwner) Close() error {
	owner.closeCalls.Add(1)
	if owner.closeStart != nil {
		select {
		case <-owner.closeStart:
		default:
			close(owner.closeStart)
		}
	}
	if owner.closeBlock != nil {
		<-owner.closeBlock
	}
	return owner.closeErr
}

func newNodeEndpointTestOwner() (*nodeEndpointTestOwner, *nodeEndpointTestInput, *nodeEndpointTestOutput, *nodeEndpointTestOutput) {
	input := &nodeEndpointTestInput{}
	output := &nodeEndpointTestOutput{terminal: io.EOF}
	stderr := &nodeEndpointTestOutput{terminal: io.EOF}
	return &nodeEndpointTestOwner{input: input, output: output, stderr: stderr}, input, output, stderr
}

func TestNewNodeARWXEndpointRejectsInvalidOwnershipAndLimits(t *testing.T) {
	validOwner, _, _, _ := newNodeEndpointTestOwner()
	var typedNilOwner *nodeEndpointTestOwner
	var typedNilInput *nodeEndpointTestInput
	var typedNilOutput *nodeEndpointTestOutput

	tests := []struct {
		name    string
		owner   nodeStandardIOOwner
		maximum uint32
	}{
		{name: "nil owner", maximum: framing.MaximumFrameBytes},
		{name: "typed nil owner", owner: typedNilOwner, maximum: framing.MaximumFrameBytes},
		{name: "missing input", owner: &nodeEndpointTestOwner{output: validOwner.output, stderr: validOwner.stderr}, maximum: framing.MaximumFrameBytes},
		{name: "typed nil input", owner: &nodeEndpointTestOwner{input: typedNilInput, output: validOwner.output, stderr: validOwner.stderr}, maximum: framing.MaximumFrameBytes},
		{name: "missing output", owner: &nodeEndpointTestOwner{input: validOwner.input, stderr: validOwner.stderr}, maximum: framing.MaximumFrameBytes},
		{name: "typed nil output", owner: &nodeEndpointTestOwner{input: validOwner.input, output: typedNilOutput, stderr: validOwner.stderr}, maximum: framing.MaximumFrameBytes},
		{name: "missing stderr", owner: &nodeEndpointTestOwner{input: validOwner.input, output: validOwner.output}, maximum: framing.MaximumFrameBytes},
		{name: "typed nil stderr", owner: &nodeEndpointTestOwner{input: validOwner.input, output: validOwner.output, stderr: typedNilOutput}, maximum: framing.MaximumFrameBytes},
		{name: "zero maximum", owner: validOwner},
		{name: "below header", owner: validOwner, maximum: framing.HeaderBytes - 1},
		{name: "above protocol maximum", owner: validOwner, maximum: framing.MaximumFrameBytes + 1},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if endpoint, err := newNodeARWXEndpoint(test.owner, test.maximum); endpoint != nil || !errors.Is(err, errInvalidNodeARWXEndpoint) {
				t.Fatalf("newNodeARWXEndpoint() = (%#v, %v), want nil invalid endpoint", endpoint, err)
			}
		})
	}

	endpoint, err := newNodeARWXEndpoint(validOwner, framing.HeaderBytes)
	if err != nil || endpoint == nil {
		t.Fatalf("newNodeARWXEndpoint(valid) = (%#v, %v)", endpoint, err)
	}
}

func TestNodeARWXEndpointUsesContextAwarePartialIO(t *testing.T) {
	owner, input, output, _ := newNodeEndpointTestOwner()
	frame := nodeEndpointTestFrame(7, []byte("partial transport"))
	output.data = bytes.Clone(frame)
	output.maximumRead = 3
	input.maximumWrite = 2
	endpoint, err := newNodeARWXEndpoint(owner, framing.MaximumFrameBytes)
	if err != nil {
		t.Fatal(err)
	}

	type contextKey struct{}
	ctx := context.WithValue(context.Background(), contextKey{}, "exact")
	read, err := endpoint.ReadFrame(ctx)
	if err != nil {
		t.Fatalf("ReadFrame() error = %v", err)
	}
	if !bytes.Equal(read, frame) {
		t.Fatal("ReadFrame changed frame bytes")
	}
	if err := endpoint.WriteFrame(ctx, frame); err != nil {
		t.Fatalf("WriteFrame() error = %v", err)
	}
	if !bytes.Equal(input.written, frame) {
		t.Fatal("WriteFrame changed frame bytes")
	}
	for _, observed := range append(append([]context.Context(nil), output.readContexts...), input.writeContexts...) {
		if observed != ctx {
			t.Fatal("partial I/O did not receive the exact caller context")
		}
	}
	if len(output.readContexts) < 2 || len(input.writeContexts) < 2 {
		t.Fatal("test did not exercise partial context-aware I/O")
	}
}

func TestNodeARWXEndpointPropagatesCloseWriteDeadline(t *testing.T) {
	owner, input, _, _ := newNodeEndpointTestOwner()
	closeFailure := errors.New("close write failed")
	input.closeWriteErr = closeFailure
	endpoint, err := newNodeARWXEndpoint(owner, framing.MaximumFrameBytes)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Minute)
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	if err := endpoint.CloseWrite(ctx); !errors.Is(err, closeFailure) {
		t.Fatalf("CloseWrite() error = %v", err)
	}
	if input.closeWriteCalls != 1 || input.closeWriteContext != ctx {
		t.Fatal("CloseWrite did not pass the exact caller context once")
	}
	observed, ok := input.closeWriteContext.Deadline()
	if !ok || !observed.Equal(deadline) {
		t.Fatalf("CloseWrite deadline = %v, %v; want %v", observed, ok, deadline)
	}
}

func TestNodeARWXEndpointPreservesOnlyExactCleanEOF(t *testing.T) {
	tests := []struct {
		name     string
		data     []byte
		terminal error
		withData bool
		clean    bool
	}{
		{name: "literal EOF", terminal: io.EOF, clean: true},
		{name: "wrapped EOF", terminal: fmt.Errorf("wrapped: %w", io.EOF)},
		{name: "joined EOF", terminal: errors.Join(io.EOF)},
		{name: "partial EOF", data: []byte{1}, terminal: io.EOF, withData: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			owner, _, output, _ := newNodeEndpointTestOwner()
			output.data = bytes.Clone(test.data)
			output.terminal = test.terminal
			output.terminalWithFinalData = test.withData
			endpoint, err := newNodeARWXEndpoint(owner, framing.MaximumFrameBytes)
			if err != nil {
				t.Fatal(err)
			}
			value, err := endpoint.ReadFrame(context.Background())
			if test.clean {
				if value != nil || err != io.EOF {
					t.Fatalf("ReadFrame() = (%x, %T %v), want literal EOF", value, err, err)
				}
				return
			}
			if value != nil || err == io.EOF || !errors.Is(err, framing.ErrPartialFrame) || errors.Is(err, io.EOF) {
				t.Fatalf("ReadFrame() = (%x, %T %v), want non-EOF partial-frame failure", value, err, err)
			}
		})
	}
}

func TestNodeARWXEndpointRejectsCancelledIOBeforeTouchingStreams(t *testing.T) {
	owner, input, output, _ := newNodeEndpointTestOwner()
	endpoint, err := newNodeARWXEndpoint(owner, framing.MaximumFrameBytes)
	if err != nil {
		t.Fatal(err)
	}
	cause := errors.New("cancelled by supervisor")
	ctx, cancel := context.WithCancelCause(context.Background())
	cancel(cause)
	if _, err := endpoint.ReadFrame(ctx); !errors.Is(err, cause) {
		t.Fatalf("ReadFrame() error = %v", err)
	}
	if err := endpoint.WriteFrame(ctx, nodeEndpointTestFrame(1, nil)); !errors.Is(err, cause) {
		t.Fatalf("WriteFrame() error = %v", err)
	}
	if output.readCalls != 0 || len(input.writeContexts) != 0 {
		t.Fatal("cancelled I/O touched a standard-I/O stream")
	}
}

func TestNodeARWXEndpointCloseUsesOwnerOnce(t *testing.T) {
	owner, input, output, stderr := newNodeEndpointTestOwner()
	owner.closeStart = make(chan struct{})
	owner.closeBlock = make(chan struct{})
	endpoint, err := newNodeARWXEndpoint(owner, framing.MaximumFrameBytes)
	if err != nil {
		t.Fatal(err)
	}

	const callers = 16
	results := make(chan error, callers)
	for range callers {
		go func() { results <- endpoint.Close() }()
	}
	select {
	case <-owner.closeStart:
	case <-time.After(time.Second):
		t.Fatal("owner Close did not start")
	}
	if calls := owner.closeCalls.Load(); calls != 1 {
		t.Fatalf("owner Close calls = %d, want 1", calls)
	}
	close(owner.closeBlock)
	for range callers {
		if err := <-results; err != nil {
			t.Fatalf("concurrent Close error = %v", err)
		}
	}
	if err := endpoint.Close(); err != nil || owner.closeCalls.Load() != 1 {
		t.Fatalf("repeated Close = %v, owner calls = %d", err, owner.closeCalls.Load())
	}
	if input.closeCalls != 0 || output.closeCalls != 0 || stderr.closeCalls != 0 {
		t.Fatal("endpoint closed a borrowed stream outside the standard-I/O owner")
	}
	if err := (*nodeARWXEndpoint)(nil).Close(); err != nil {
		t.Fatalf("nil endpoint Close error = %v", err)
	}
}

func TestNodeARWXEndpointCloseRetriesFailureThenSealsSuccess(t *testing.T) {
	owner, _, _, _ := newNodeEndpointTestOwner()
	closeFailure := errors.New("owner close failed")
	owner.closeErr = closeFailure
	endpoint, err := newNodeARWXEndpoint(owner, framing.MaximumFrameBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := endpoint.Close(); !errors.Is(err, closeFailure) || owner.closeCalls.Load() != 1 {
		t.Fatalf("first Close = %v, owner calls = %d", err, owner.closeCalls.Load())
	}
	owner.closeErr = nil
	if err := endpoint.Close(); err != nil || owner.closeCalls.Load() != 2 {
		t.Fatalf("retry Close = %v, owner calls = %d", err, owner.closeCalls.Load())
	}
	if err := endpoint.Close(); err != nil || owner.closeCalls.Load() != 2 {
		t.Fatalf("sealed Close = %v, owner calls = %d", err, owner.closeCalls.Load())
	}
}

func TestNodeStderrDrainCompletesOnExactEOFAndStartsOnce(t *testing.T) {
	owner, _, _, stderr := newNodeEndpointTestOwner()
	stderr.data = []byte("discarded diagnostic")
	stderr.maximumRead = 2
	endpoint, err := newNodeARWXEndpoint(owner, framing.MaximumFrameBytes)
	if err != nil {
		t.Fatal(err)
	}
	type contextKey struct{}
	ctx := context.WithValue(context.Background(), contextKey{}, "stderr")
	drain, err := endpoint.startStderrDrain(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if drain.Done() == nil {
		t.Fatal("stderr drain has no completion channel")
	}
	if err := drain.Wait(); err != nil {
		t.Fatalf("stderr drain error = %v", err)
	}
	if err := drain.Wait(); err != nil {
		t.Fatalf("repeated stderr drain Wait error = %v", err)
	}
	if _, err := endpoint.startStderrDrain(ctx); !errors.Is(err, errNodeStderrDrainStarted) {
		t.Fatalf("second stderr drain error = %v", err)
	}
	if stderr.readCalls < 2 {
		t.Fatal("test did not exercise partial stderr reads")
	}
	for _, observed := range stderr.readContexts {
		if observed != ctx {
			t.Fatal("stderr read did not receive the exact caller context")
		}
	}
}

func TestDrainNodeStderrAcceptsOnlyLiteralZeroByteEOF(t *testing.T) {
	tests := []struct {
		name     string
		stream   *nodeEndpointTestOutput
		wantRead bool
	}{
		{name: "literal EOF", stream: &nodeEndpointTestOutput{terminal: io.EOF}},
		{name: "wrapped EOF", stream: &nodeEndpointTestOutput{terminal: fmt.Errorf("wrapped: %w", io.EOF)}, wantRead: true},
		{name: "joined EOF", stream: &nodeEndpointTestOutput{terminal: errors.Join(io.EOF)}, wantRead: true},
		{name: "partial EOF", stream: &nodeEndpointTestOutput{data: []byte("x"), terminal: io.EOF, terminalWithFinalData: true}, wantRead: true},
		{name: "zero progress", stream: &nodeEndpointTestOutput{}, wantRead: true},
		{name: "other read failure", stream: &nodeEndpointTestOutput{terminal: errors.New("read failed")}, wantRead: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := drainNodeStderr(context.Background(), test.stream, 8)
			if !test.wantRead {
				if err != nil {
					t.Fatalf("drainNodeStderr() error = %v", err)
				}
				return
			}
			if !errors.Is(err, errNodeStderrDrainRead) || err == io.EOF || errors.Is(err, io.EOF) {
				t.Fatalf("drainNodeStderr() error = %T %v, want non-EOF read failure", err, err)
			}
		})
	}
}

func TestDrainNodeStderrEnforcesFixedBufferAndHardTotalLimit(t *testing.T) {
	requested := 0
	stream := &nodeEndpointTestOutput{read: func(_ context.Context, buffer []byte) (int, error) {
		requested = len(buffer)
		copy(buffer, "12345")
		return 5, nil
	}}
	if err := drainNodeStderr(context.Background(), stream, 4); !errors.Is(err, errNodeStderrLimit) {
		t.Fatalf("over-limit stderr error = %v", err)
	}
	if requested != nodeStderrDrainBufferBytes {
		t.Fatalf("stderr read buffer = %d, want %d", requested, nodeStderrDrainBufferBytes)
	}

	exact := &nodeEndpointTestOutput{data: []byte("1234"), maximumRead: 2, terminal: io.EOF}
	if err := drainNodeStderr(context.Background(), exact, 4); err != nil {
		t.Fatalf("exact-limit stderr error = %v", err)
	}
	for _, maximum := range []uint64{0, nodeStderrMaximumBytes + 1} {
		if err := drainNodeStderr(context.Background(), exact, maximum); !errors.Is(err, errInvalidNodeARWXEndpoint) {
			t.Fatalf("invalid maximum %d error = %v", maximum, err)
		}
	}
	var typedNil *nodeEndpointTestOutput
	if err := drainNodeStderr(context.Background(), typedNil, 1); !errors.Is(err, errInvalidNodeARWXEndpoint) {
		t.Fatalf("typed-nil stderr error = %v", err)
	}
}

func TestNodeStderrDrainCancellationIsJoined(t *testing.T) {
	readStarted := make(chan struct{})
	var startOnce sync.Once
	stderr := &nodeEndpointTestOutput{read: func(ctx context.Context, _ []byte) (int, error) {
		startOnce.Do(func() { close(readStarted) })
		<-ctx.Done()
		return 0, context.Cause(ctx)
	}}
	owner, _, _, _ := newNodeEndpointTestOwner()
	owner.stderr = stderr
	endpoint, err := newNodeARWXEndpoint(owner, framing.MaximumFrameBytes)
	if err != nil {
		t.Fatal(err)
	}
	cause := errors.New("supervisor stopped stderr")
	ctx, cancel := context.WithCancelCause(context.Background())
	drain, err := endpoint.startStderrDrain(ctx)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-readStarted:
	case <-time.After(time.Second):
		t.Fatal("stderr drain did not start")
	}
	cancel(cause)

	const waiters = 8
	results := make(chan error, waiters)
	for range waiters {
		go func() { results <- drain.Wait() }()
	}
	for range waiters {
		if err := <-results; !errors.Is(err, cause) {
			t.Fatalf("stderr Wait error = %v", err)
		}
	}
	select {
	case <-drain.Done():
	default:
		t.Fatal("stderr completion was not published before Wait returned")
	}
	if err := (*nodeStderrDrain)(nil).Wait(); !errors.Is(err, errInvalidNodeARWXEndpoint) {
		t.Fatalf("nil drain Wait error = %v", err)
	}
}

func TestStartNodeStderrDrainRejectsInvalidInputs(t *testing.T) {
	stream := &nodeEndpointTestOutput{terminal: io.EOF}
	if drain, err := startNodeStderrDrain(nil, stream); drain != nil || err == nil {
		t.Fatalf("nil-context start = (%#v, %v)", drain, err)
	}
	var typedNil *nodeEndpointTestOutput
	if drain, err := startNodeStderrDrain(context.Background(), typedNil); drain != nil || !errors.Is(err, errInvalidNodeARWXEndpoint) {
		t.Fatalf("typed-nil start = (%#v, %v)", drain, err)
	}
}

func nodeEndpointTestFrame(sequence uint64, payload []byte) []byte {
	value := make([]byte, framing.HeaderBytes+len(payload))
	copy(value[0:4], framing.Magic)
	binary.LittleEndian.PutUint16(value[4:6], framing.HeaderBytes)
	binary.LittleEndian.PutUint16(value[6:8], framing.MajorVersion)
	binary.LittleEndian.PutUint16(value[8:10], framing.MinorVersion)
	binary.LittleEndian.PutUint16(value[10:12], 1)
	binary.LittleEndian.PutUint32(value[16:20], uint32(len(payload)))
	binary.LittleEndian.PutUint64(value[20:28], sequence)
	copy(value[framing.HeaderBytes:], payload)
	return value
}
