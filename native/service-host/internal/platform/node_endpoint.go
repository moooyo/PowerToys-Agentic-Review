package platform

import (
	"context"
	"errors"
	"fmt"
	"io"
	"reflect"
	"sync"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/framing"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/relay"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winprocess"
)

const (
	nodeStderrDrainBufferBytes = 32 * 1024
	nodeStderrMaximumBytes     = 1 * 1024 * 1024
)

var (
	errInvalidNodeARWXEndpoint = errors.New("invalid Node ARWX endpoint")
	errNodeStderrDrainStarted  = errors.New("Node stderr drain was already started")
	errNodeStderrDrainRead     = errors.New("Node stderr drain failed")
	errNodeStderrLimit         = errors.New("Node stderr exceeded its byte limit")
)

// nodeStandardIOOwner is the single owner returned by NodeProcess.TakeStandardIO.
// The endpoint borrows its streams but closes them only through this owner.
type nodeStandardIOOwner interface {
	StandardInput() winprocess.NodeStandardInput
	StandardOutput() winprocess.NodeStandardOutput
	StandardError() winprocess.NodeStandardOutput
	Close() error
}

// nodeARWXEndpoint adapts Node's byte-stream stdin/stdout to the framed relay
// contract. stderr has an independent, explicitly joined drain lifecycle.
type nodeARWXEndpoint struct {
	owner         nodeStandardIOOwner
	input         winprocess.NodeStandardInput
	output        winprocess.NodeStandardOutput
	standardError winprocess.NodeStandardOutput
	maximumBytes  uint32

	closeMu      sync.Mutex
	closing      bool
	closed       bool
	closeAttempt *nodeEndpointCloseAttempt

	stderrMu      sync.Mutex
	stderrStarted bool
}

type nodeEndpointCloseAttempt struct {
	done   chan struct{}
	result error
}

func newNodeARWXEndpoint(owner nodeStandardIOOwner, maximumFrameBytes uint32) (*nodeARWXEndpoint, error) {
	if isNilNodeEndpointValue(owner) {
		return nil, fmt.Errorf("%w: standard-I/O owner is required", errInvalidNodeARWXEndpoint)
	}
	if maximumFrameBytes < framing.HeaderBytes || maximumFrameBytes > framing.MaximumFrameBytes {
		return nil, fmt.Errorf(
			"%w: maximum frame bytes must be from %d through %d",
			errInvalidNodeARWXEndpoint,
			framing.HeaderBytes,
			framing.MaximumFrameBytes,
		)
	}

	input := owner.StandardInput()
	output := owner.StandardOutput()
	standardError := owner.StandardError()
	if isNilNodeEndpointValue(input) || isNilNodeEndpointValue(output) || isNilNodeEndpointValue(standardError) {
		return nil, fmt.Errorf("%w: standard-I/O streams are incomplete", errInvalidNodeARWXEndpoint)
	}

	return &nodeARWXEndpoint{
		owner:         owner,
		input:         input,
		output:        output,
		standardError: standardError,
		maximumBytes:  maximumFrameBytes,
	}, nil
}

func (endpoint *nodeARWXEndpoint) ReadFrame(ctx context.Context) ([]byte, error) {
	if endpoint == nil || isNilNodeEndpointValue(endpoint.output) {
		return nil, errInvalidNodeARWXEndpoint
	}
	if ctx == nil {
		return nil, errors.New("Node ARWX read context is required")
	}
	if cause := context.Cause(ctx); cause != nil {
		return nil, cause
	}
	frame, err := framing.ReadFrame(
		nodeARWXContextReader{ctx: ctx, stream: endpoint.output},
		endpoint.maximumBytes,
	)
	if err != nil {
		return nil, err
	}
	return frame.Bytes, nil
}

func (endpoint *nodeARWXEndpoint) WriteFrame(ctx context.Context, value []byte) error {
	if endpoint == nil || isNilNodeEndpointValue(endpoint.input) {
		return errInvalidNodeARWXEndpoint
	}
	if ctx == nil {
		return errors.New("Node ARWX write context is required")
	}
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	return framing.WriteFrame(
		nodeARWXContextWriter{ctx: ctx, stream: endpoint.input},
		value,
		endpoint.maximumBytes,
	)
}

func (endpoint *nodeARWXEndpoint) CloseWrite(ctx context.Context) error {
	if endpoint == nil || isNilNodeEndpointValue(endpoint.input) {
		return errInvalidNodeARWXEndpoint
	}
	if ctx == nil {
		return errors.New("Node ARWX graceful-close context is required")
	}
	return endpoint.input.CloseWrite(ctx)
}

// Close consumes the complete standard-I/O owner. It never closes an
// individual borrowed stream. Concurrent callers share one attempt; a later
// call may retry a failed non-consuming close, while success is permanent.
func (endpoint *nodeARWXEndpoint) Close() error {
	if endpoint == nil {
		return nil
	}
	endpoint.closeMu.Lock()
	if endpoint.closed {
		endpoint.closeMu.Unlock()
		return nil
	}
	if endpoint.closing {
		attempt := endpoint.closeAttempt
		endpoint.closeMu.Unlock()
		<-attempt.done
		return attempt.result
	}
	attempt := &nodeEndpointCloseAttempt{done: make(chan struct{})}
	endpoint.closing = true
	endpoint.closeAttempt = attempt
	endpoint.closeMu.Unlock()

	result := endpoint.owner.Close()

	endpoint.closeMu.Lock()
	attempt.result = result
	endpoint.closing = false
	endpoint.closed = result == nil
	close(attempt.done)
	endpoint.closeMu.Unlock()
	return result
}

// startStderrDrain starts the endpoint's only stderr consumer. The caller must
// join the returned drain before releasing the surrounding supervisor.
func (endpoint *nodeARWXEndpoint) startStderrDrain(ctx context.Context) (*nodeStderrDrain, error) {
	if endpoint == nil || isNilNodeEndpointValue(endpoint.standardError) {
		return nil, errInvalidNodeARWXEndpoint
	}
	if ctx == nil {
		return nil, errors.New("Node stderr drain context is required")
	}
	endpoint.stderrMu.Lock()
	defer endpoint.stderrMu.Unlock()
	if endpoint.stderrStarted {
		return nil, errNodeStderrDrainStarted
	}
	endpoint.stderrStarted = true
	return startNodeStderrDrain(ctx, endpoint.standardError)
}

type nodeARWXContextReader struct {
	ctx    context.Context
	stream winprocess.NodeStandardOutput
}

func (reader nodeARWXContextReader) Read(buffer []byte) (int, error) {
	return reader.stream.ReadContext(reader.ctx, buffer)
}

type nodeARWXContextWriter struct {
	ctx    context.Context
	stream winprocess.NodeStandardInput
}

func (writer nodeARWXContextWriter) Write(buffer []byte) (int, error) {
	return writer.stream.WriteContext(writer.ctx, buffer)
}

// nodeStderrDrain retains only its terminal outcome. stderr bytes are read into
// one fixed buffer, discarded immediately, and never returned to callers.
type nodeStderrDrain struct {
	done chan struct{}
	err  error
}

func startNodeStderrDrain(
	ctx context.Context,
	stream winprocess.NodeStandardOutput,
) (*nodeStderrDrain, error) {
	if ctx == nil {
		return nil, errors.New("Node stderr drain context is required")
	}
	if isNilNodeEndpointValue(stream) {
		return nil, fmt.Errorf("%w: stderr stream is required", errInvalidNodeARWXEndpoint)
	}
	drain := &nodeStderrDrain{done: make(chan struct{})}
	go func() {
		defer close(drain.done)
		drain.err = drainNodeStderr(ctx, stream, nodeStderrMaximumBytes)
	}()
	return drain, nil
}

func (drain *nodeStderrDrain) Done() <-chan struct{} {
	if drain == nil {
		return nil
	}
	return drain.done
}

func (drain *nodeStderrDrain) Wait() error {
	if drain == nil || drain.done == nil {
		return fmt.Errorf("%w: stderr drain is unavailable", errInvalidNodeARWXEndpoint)
	}
	<-drain.done
	return drain.err
}

func drainNodeStderr(
	ctx context.Context,
	stream winprocess.NodeStandardOutput,
	maximumBytes uint64,
) error {
	if ctx == nil {
		return errors.New("Node stderr drain context is required")
	}
	if isNilNodeEndpointValue(stream) {
		return fmt.Errorf("%w: stderr stream is required", errInvalidNodeARWXEndpoint)
	}
	if maximumBytes == 0 || maximumBytes > nodeStderrMaximumBytes {
		return fmt.Errorf("%w: stderr byte limit is invalid", errInvalidNodeARWXEndpoint)
	}

	var buffer [nodeStderrDrainBufferBytes]byte
	defer clear(buffer[:])
	var total uint64
	for {
		if cause := context.Cause(ctx); cause != nil {
			return cause
		}
		count, readErr := stream.ReadContext(ctx, buffer[:])
		if count < 0 || count > len(buffer) {
			return fmt.Errorf("%w: stderr returned an invalid byte count", errNodeStderrDrainRead)
		}
		if cause := context.Cause(ctx); cause != nil {
			clear(buffer[:max(count, 0)])
			return cause
		}

		var limitErr error
		if uint64(count) > maximumBytes-total {
			limitErr = fmt.Errorf("%w: maximum is %d bytes", errNodeStderrLimit, maximumBytes)
		} else {
			total += uint64(count)
		}
		clear(buffer[:count])

		if readErr != nil {
			if count == 0 && readErr == io.EOF && limitErr == nil {
				return nil
			}
			return errors.Join(
				limitErr,
				fmt.Errorf("%w: read returned %d bytes and terminal error %v", errNodeStderrDrainRead, count, readErr),
			)
		}
		if limitErr != nil {
			return limitErr
		}
		if count == 0 {
			return errors.Join(errNodeStderrDrainRead, io.ErrNoProgress)
		}
	}
}

func isNilNodeEndpointValue(value any) bool {
	if value == nil {
		return true
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return reflected.IsNil()
	default:
		return false
	}
}

var (
	_ nodeStandardIOOwner = (*winprocess.NodeStandardIO)(nil)
	_ relay.NodeEndpoint  = (*nodeARWXEndpoint)(nil)
)
