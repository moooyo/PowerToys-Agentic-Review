package localrpc

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
)

type runtimeBootstrapTestChannel struct {
	input  *bytes.Reader
	output bytes.Buffer
}

func (channel *runtimeBootstrapTestChannel) ReadContext(
	ctx context.Context,
	buffer []byte,
) (int, error) {
	if cause := context.Cause(ctx); cause != nil {
		return 0, cause
	}
	return channel.input.Read(buffer)
}

func (channel *runtimeBootstrapTestChannel) WriteContext(
	ctx context.Context,
	buffer []byte,
) (int, error) {
	if cause := context.Cause(ctx); cause != nil {
		return 0, cause
	}
	return channel.output.Write(buffer)
}

func TestExchangeRuntimeBootstrapSendsCanonicalDocumentBeforeAcceptingAck(t *testing.T) {
	bootstrap, bootstrapDocument := runtimeBootstrapForExchangeTest(t)
	ackDocument, err := EncodeRuntimeBootstrapAck(bootstrapDocument, RoleControl)
	if err != nil {
		t.Fatal(err)
	}
	var input bytes.Buffer
	if err := WriteFrame(&input, ackDocument, RuntimeBootstrapMaximumBytes); err != nil {
		t.Fatal(err)
	}
	channel := &runtimeBootstrapTestChannel{input: bytes.NewReader(input.Bytes())}

	pending, err := BeginRuntimeBootstrapExchange(context.Background(), channel, bootstrap)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pending.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	writtenStream := bytes.NewReader(channel.output.Bytes())
	written, err := ReadFrame(writtenStream, RuntimeBootstrapMaximumBytes)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(written, bootstrapDocument) {
		t.Fatalf("bootstrap write = %s, want %s", written, bootstrapDocument)
	}
	commitDocument, err := ReadFrame(writtenStream, RuntimeBootstrapMaximumBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateRuntimeBootstrapCommit(commitDocument, bootstrapDocument, RoleControl); err != nil {
		t.Fatalf("commit validation error = %v", err)
	}
	if _, err := pending.Commit(context.Background()); !errors.Is(err, ErrRuntimeBootstrapExchange) {
		t.Fatalf("second commit error = %v", err)
	}
}

func TestPendingRuntimeBootstrapCommitCopyRemainsSingleUse(t *testing.T) {
	bootstrap, bootstrapDocument := runtimeBootstrapForExchangeTest(t)
	ackDocument, err := EncodeRuntimeBootstrapAck(bootstrapDocument, RoleControl)
	if err != nil {
		t.Fatal(err)
	}
	var input bytes.Buffer
	if err := WriteFrame(&input, ackDocument, RuntimeBootstrapMaximumBytes); err != nil {
		t.Fatal(err)
	}
	channel := &runtimeBootstrapTestChannel{input: bytes.NewReader(input.Bytes())}
	pending, err := BeginRuntimeBootstrapExchange(context.Background(), channel, bootstrap)
	if err != nil {
		t.Fatal(err)
	}
	copyOfPending := *pending
	if _, err := pending.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := copyOfPending.Commit(context.Background()); !errors.Is(err, ErrRuntimeBootstrapExchange) {
		t.Fatalf("copied commit error = %v", err)
	}
}

func TestExchangeRuntimeBootstrapRejectsInvalidAcknowledgements(t *testing.T) {
	_, bootstrapDocument := runtimeBootstrapForExchangeTest(t)
	validAck, err := NewRuntimeBootstrapAck(bootstrapDocument, RoleControl)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name string
		ack  []byte
	}{
		{name: "negative", ack: func() []byte {
			candidate := validAck
			candidate.Accepted = false
			return canonicalForTest(t, map[string]any{
				"accepted": false, "arwxReceiveLoopStarted": true, "bootstrapId": candidate.BootstrapID,
				"bootstrapSha256": candidate.BootstrapSHA256, "bootstrapVersion": 1,
				"protocolVersion": "1.0", "role": "control", "type": "runtimeBootstrapAck",
			})
		}()},
		{name: "wrong role", ack: func() []byte {
			candidate := validAck
			candidate.Role = RoleExecutor
			document, encodeErr := encodeRuntimeBootstrapAckValue(candidate)
			if encodeErr != nil {
				t.Fatal(encodeErr)
			}
			return document
		}()},
		{name: "wrong digest", ack: func() []byte {
			candidate := validAck
			candidate.BootstrapSHA256 = strings.Repeat("0", 64)
			document, encodeErr := encodeRuntimeBootstrapAckValue(candidate)
			if encodeErr != nil {
				t.Fatal(encodeErr)
			}
			return document
		}()},
		{name: "ordinary RPC", ack: canonicalForTest(t, map[string]any{
			"operation": "Register", "payload": map[string]any{}, "protocolVersion": "1.0",
			"requestId": "request:1", "type": "call",
		})},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			bootstrap, candidateDocument := runtimeBootstrapForExchangeTest(t)
			if !bytes.Equal(candidateDocument, bootstrapDocument) {
				t.Fatal("deterministic test bootstrap document changed")
			}
			var input bytes.Buffer
			if err := WriteFrame(&input, test.ack, RuntimeBootstrapMaximumBytes); err != nil {
				t.Fatal(err)
			}
			channel := &runtimeBootstrapTestChannel{input: bytes.NewReader(input.Bytes())}
			if _, err := BeginRuntimeBootstrapExchange(context.Background(), channel, bootstrap); !errors.Is(err, ErrRuntimeBootstrapExchange) {
				t.Fatalf("exchange error = %v", err)
			}
		})
	}
}

func TestExchangeRuntimeBootstrapRejectsEOFPartialOversizeAndCancellation(t *testing.T) {
	oversizedPrefix := []byte{1, 0, 1, 0}
	tests := []struct {
		name  string
		input []byte
	}{
		{name: "EOF"},
		{name: "partial", input: []byte{10, 0, 0, 0, '{'}},
		{name: "oversize", input: oversizedPrefix},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			bootstrap, _ := runtimeBootstrapForExchangeTest(t)
			channel := &runtimeBootstrapTestChannel{input: bytes.NewReader(test.input)}
			if _, err := BeginRuntimeBootstrapExchange(context.Background(), channel, bootstrap); !errors.Is(err, ErrRuntimeBootstrapExchange) {
				t.Fatalf("exchange error = %v", err)
			}
		})
	}

	cancelled, cancel := context.WithCancelCause(context.Background())
	cancel(io.ErrClosedPipe)
	channel := &runtimeBootstrapTestChannel{input: bytes.NewReader(nil)}
	bootstrap, _ := runtimeBootstrapForExchangeTest(t)
	if _, err := BeginRuntimeBootstrapExchange(cancelled, channel, bootstrap); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("cancelled exchange error = %v", err)
	}
	var nilChannel *runtimeBootstrapTestChannel
	bootstrap, _ = runtimeBootstrapForExchangeTest(t)
	if _, err := BeginRuntimeBootstrapExchange(context.Background(), nilChannel, bootstrap); err == nil {
		t.Fatal("ExchangeRuntimeBootstrap accepted a typed nil channel")
	}
}

func TestRuntimeBootstrapIssuanceIsCopySafeAndSingleUse(t *testing.T) {
	bootstrap, bootstrapDocument := runtimeBootstrapForExchangeTest(t)
	copyOfBootstrap := bootstrap
	ackDocument, err := EncodeRuntimeBootstrapAck(bootstrapDocument, RoleControl)
	if err != nil {
		t.Fatal(err)
	}
	var input bytes.Buffer
	if err := WriteFrame(&input, ackDocument, RuntimeBootstrapMaximumBytes); err != nil {
		t.Fatal(err)
	}
	first := &runtimeBootstrapTestChannel{input: bytes.NewReader(input.Bytes())}
	if _, err := BeginRuntimeBootstrapExchange(context.Background(), first, bootstrap); err != nil {
		t.Fatal(err)
	}
	if _, err := BeginRuntimeBootstrapExchange(
		context.Background(),
		noIORuntimeBootstrapChannel{},
		copyOfBootstrap,
	); !errors.Is(err, ErrRuntimeBootstrapBinding) {
		t.Fatalf("copied bootstrap reuse error = %v", err)
	}
}

func TestRuntimeBootstrapIssuanceBurnsBeforeValidationOrIO(t *testing.T) {
	bootstrap, _ := runtimeBootstrapForExchangeTest(t)
	copyOfBootstrap := bootstrap
	cancelled, cancel := context.WithCancelCause(context.Background())
	cancel(io.ErrClosedPipe)
	if _, err := BeginRuntimeBootstrapExchange(
		cancelled,
		noIORuntimeBootstrapChannel{},
		bootstrap,
	); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("cancelled first exchange error = %v", err)
	}
	if _, err := BeginRuntimeBootstrapExchange(
		context.Background(),
		noIORuntimeBootstrapChannel{},
		copyOfBootstrap,
	); !errors.Is(err, ErrRuntimeBootstrapBinding) {
		t.Fatalf("burned bootstrap reuse error = %v", err)
	}
}

func TestRuntimeBootstrapIssuanceRejectsConcurrentCopies(t *testing.T) {
	bootstrap, bootstrapDocument := runtimeBootstrapForExchangeTest(t)
	ackDocument, err := EncodeRuntimeBootstrapAck(bootstrapDocument, RoleControl)
	if err != nil {
		t.Fatal(err)
	}
	channels := make([]*runtimeBootstrapTestChannel, 2)
	for index := range channels {
		var input bytes.Buffer
		if err := WriteFrame(&input, ackDocument, RuntimeBootstrapMaximumBytes); err != nil {
			t.Fatal(err)
		}
		channels[index] = &runtimeBootstrapTestChannel{input: bytes.NewReader(input.Bytes())}
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	for index := range channels {
		candidate := bootstrap
		channel := channels[index]
		go func() {
			<-start
			_, err := BeginRuntimeBootstrapExchange(context.Background(), channel, candidate)
			results <- err
		}()
	}
	close(start)
	succeeded := 0
	rejected := 0
	for range channels {
		err := <-results
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrRuntimeBootstrapBinding):
			rejected++
		default:
			t.Fatalf("concurrent Begin error = %v", err)
		}
	}
	if succeeded != 1 || rejected != 1 {
		t.Fatalf("concurrent Begin outcomes = success:%d rejected:%d", succeeded, rejected)
	}
	written := 0
	for _, channel := range channels {
		if channel.output.Len() != 0 {
			written++
		}
	}
	if written != 1 {
		t.Fatalf("concurrent Begin wrote to %d channels, want 1", written)
	}
}

func TestBeginRuntimeBootstrapPreservesCoalescedFirstRPCFrame(t *testing.T) {
	bootstrap, bootstrapDocument := runtimeBootstrapForExchangeTest(t)
	ackDocument, err := EncodeRuntimeBootstrapAck(bootstrapDocument, RoleControl)
	if err != nil {
		t.Fatal(err)
	}
	firstCall := canonicalForTest(t, map[string]any{
		"operation": "Register",
		"payload": map[string]any{
			"body": rawBodyDescriptorForTest([]byte(`{}`)),
		},
		"protocolVersion": "1.0",
		"requestId":       "request:1",
		"type":            "call",
	})
	var input bytes.Buffer
	for _, document := range [][]byte{ackDocument, firstCall} {
		if err := WriteFrame(&input, document, RuntimeBootstrapMaximumBytes); err != nil {
			t.Fatal(err)
		}
	}
	channel := &runtimeBootstrapTestChannel{input: bytes.NewReader(input.Bytes())}
	if _, err := BeginRuntimeBootstrapExchange(context.Background(), channel, bootstrap); err != nil {
		t.Fatal(err)
	}
	remaining, err := ReadFrame(
		runtimeBootstrapContextReader{ctx: context.Background(), channel: channel},
		RuntimeBootstrapMaximumBytes,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(remaining, firstCall) {
		t.Fatalf("preserved first call = %s, want %s", remaining, firstCall)
	}
}

func runtimeBootstrapForExchangeTest(t *testing.T) (RuntimeBootstrapV1, []byte) {
	t.Helper()
	bootstrap, err := newRuntimeBootstrap(validRuntimeBootstrapOptions())
	if err != nil {
		t.Fatal(err)
	}
	document, err := EncodeRuntimeBootstrap(bootstrap)
	if err != nil {
		t.Fatal(err)
	}
	return bootstrap, document
}
