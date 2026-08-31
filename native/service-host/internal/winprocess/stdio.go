package winprocess

import (
	"context"
	"errors"
	"fmt"
	"io"
	"reflect"
	"sync"
	"time"
)

// ErrStandardIOUnavailable reports an incomplete, transferred, or sealed
// standard-I/O ownership slot.
var ErrStandardIOUnavailable = errors.New("Node standard I/O is unavailable")

// ErrStandardIOCloseTimeout reports that active I/O did not drain before its
// deadline. No raw handle close has been attempted at that point.
var ErrStandardIOCloseTimeout = errors.New("Node standard I/O did not stop before the close deadline")

// NodeStandardInput is the transferred write end of Node stdin.
type NodeStandardInput interface {
	io.WriteCloser
	WriteContext(context.Context, []byte) (int, error)
	// CloseWrite flushes writes already reported successful before delivering
	// EOF to Node. The context must have a deadline.
	CloseWrite(context.Context) error
}

// NodeStandardOutput is one transferred read end of Node stdout or stderr.
type NodeStandardOutput interface {
	io.ReadCloser
	ReadContext(context.Context, []byte) (int, error)
}

// NodeStandardIO is the sole owner of the three parent-side Node pipe ends
// after NodeProcess.TakeStandardIO succeeds. Copies share one internal state,
// and each stream may also be closed separately.
type NodeStandardIO struct {
	state *nodeStandardIOState
}

type nodeStandardIOState struct {
	closeMu       sync.Mutex
	input         NodeStandardInput
	output        NodeStandardOutput
	standardError NodeStandardOutput
}

func newNodeStandardIO(
	input NodeStandardInput,
	output NodeStandardOutput,
	errorOutput NodeStandardOutput,
) *NodeStandardIO {
	return &NodeStandardIO{state: &nodeStandardIOState{
		input:         input,
		output:        output,
		standardError: errorOutput,
	}}
}

func (s *NodeStandardIO) StandardInput() NodeStandardInput {
	if s == nil || s.state == nil {
		return nil
	}
	return s.state.input
}

func (s *NodeStandardIO) StandardOutput() NodeStandardOutput {
	if s == nil || s.state == nil {
		return nil
	}
	return s.state.output
}

func (s *NodeStandardIO) StandardError() NodeStandardOutput {
	if s == nil || s.state == nil {
		return nil
	}
	return s.state.standardError
}

// Close is abortive, idempotent, and safe to call concurrently. Call
// StandardInput().CloseWrite with a deadline before Close when successful stdin
// writes must be consumed by Node. A raw-handle close failure poisons the host
// and is never retried with the same numeric value.
func (s *NodeStandardIO) Close() error {
	if s == nil || s.state == nil {
		return nil
	}
	state := s.state
	state.closeMu.Lock()
	defer state.closeMu.Unlock()

	streams := []struct {
		label  string
		stream io.Closer
	}{
		{label: "close Node standard input", stream: state.input},
		{label: "close Node standard output", stream: state.output},
		{label: "close Node standard error", stream: state.standardError},
	}
	closeErrors := make([]error, len(streams))
	var group sync.WaitGroup
	group.Add(len(streams))
	for index := range streams {
		go func() {
			defer group.Done()
			closeErrors[index] = closeStandardIOStream(streams[index].label, streams[index].stream)
		}()
	}
	group.Wait()
	return errors.Join(closeErrors...)
}

func (s *NodeStandardIO) valid() bool {
	return s != nil && s.state != nil &&
		!isNilCloser(s.state.input) &&
		!isNilCloser(s.state.output) &&
		!isNilCloser(s.state.standardError)
}

type standardIOOwnership struct {
	mu      sync.Mutex
	closeMu sync.Mutex
	streams *NodeStandardIO
	sealed  bool
}

func newStandardIOOwnership(streams *NodeStandardIO) *standardIOOwnership {
	return &standardIOOwnership{streams: streams}
}

func (o *standardIOOwnership) take() (*NodeStandardIO, error) {
	if o == nil {
		return nil, ErrStandardIOUnavailable
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.sealed || !o.streams.valid() {
		return nil, ErrStandardIOUnavailable
	}
	streams := o.streams
	o.streams = nil
	return streams, nil
}

// seal synchronously prevents a concurrent or later ownership transfer.
func (o *standardIOOwnership) seal() {
	if o == nil {
		return
	}
	o.mu.Lock()
	o.sealed = true
	o.mu.Unlock()
}

func (o *standardIOOwnership) closeOwned() error {
	if o == nil {
		return nil
	}
	o.closeMu.Lock()
	defer o.closeMu.Unlock()
	o.mu.Lock()
	o.sealed = true
	streams := o.streams
	o.mu.Unlock()
	if streams == nil {
		return nil
	}
	if err := streams.Close(); err != nil {
		return err
	}
	o.mu.Lock()
	if o.streams == streams {
		o.streams = nil
	}
	o.mu.Unlock()
	return nil
}

func closeStandardIOStream(label string, stream io.Closer) error {
	if isNilCloser(stream) {
		return fmt.Errorf("%s: %w", label, ErrStandardIOUnavailable)
	}
	if err := stream.Close(); err != nil {
		return fmt.Errorf("%s: %w", label, err)
	}
	return nil
}

func isNilCloser(value io.Closer) bool {
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

type standardIOActivity struct {
	mu      sync.Mutex
	count   int
	drained chan struct{}
}

func (a *standardIOActivity) begin() func() {
	a.mu.Lock()
	if a.count == 0 {
		a.drained = make(chan struct{})
	}
	a.count++
	a.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			a.mu.Lock()
			a.count--
			if a.count == 0 {
				close(a.drained)
			}
			a.mu.Unlock()
		})
	}
}

func (a *standardIOActivity) wait(timeout time.Duration) bool {
	a.mu.Lock()
	if a.count == 0 {
		a.mu.Unlock()
		return true
	}
	drained := a.drained
	a.mu.Unlock()

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-drained:
		return true
	case <-timer.C:
		return false
	}
}
