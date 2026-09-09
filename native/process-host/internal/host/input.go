package host

import (
	"errors"
	"io"
	"os"
	"sync"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/protocol"
)

type inputOperation struct {
	sequence  uint64
	operation string
	data      []byte
	started   bool
	completed bool
}

type inputActivity struct {
	operation *inputOperation
	started   bool
}

// One operation may await pipe completion. Completed results are committed before publication,
// so an EOF-driven process exit cannot retroactively change a successful close into a failure.
// Three fixed goroutines own writing, cancellation/Close, and deadlines; requests spawn none.
type inputController struct {
	owner        *managedProcess
	streamID     string
	writer       io.WriteCloser
	writeTimeout time.Duration
	mu           sync.Mutex
	pending      *inputOperation
	operations   uint64
	totalBytes   uint64
	closing      bool
	stopped      bool
	stopCode     string
	queue        chan *inputOperation
	activity     chan inputActivity
	stopSignal   chan struct{}
	closeSignal  chan struct{}
	closed       chan struct{}
	done         chan struct{}
	closeOnce    sync.Once
	closeErr     error
}

func newInputController(owner *managedProcess, streamID string, writer io.WriteCloser) *inputController {
	return &inputController{
		owner: owner, streamID: streamID, writer: writer,
		writeTimeout: time.Duration(protocol.InteractiveStdinWriteTimeoutMS) * time.Millisecond,
		queue:        make(chan *inputOperation, 1), activity: make(chan inputActivity, 2),
		stopSignal: make(chan struct{}), closeSignal: make(chan struct{}),
		closed: make(chan struct{}), done: make(chan struct{}),
	}
}

func (s *Server) writeInput(request protocol.StdinWriteRequest) error {
	data, err := protocol.DecodeStdinWriteData(request.DataBase64)
	if err != nil {
		return err
	}
	return s.admitInput(request.ID, request.StdinStreamID, request.Sequence, "write", data)
}

func (s *Server) closeInput(request protocol.StdinCloseRequest) error {
	return s.admitInput(request.ID, request.StdinStreamID, request.Sequence, "close", nil)
}

func (s *Server) admitInput(requestID, streamID string, sequence uint64, operation string, data []byte) error {
	code := ""
	if !s.interactiveInput {
		code = protocol.StdinNotEnabled
	} else {
		s.mu.Lock()
		process, exists := s.reservations[requestID]
		s.mu.Unlock()
		switch {
		case !exists:
			code = protocol.StdinProcessNotFound
		case process == nil:
			code = protocol.StdinProcessNotRunning
		case process.input == nil:
			code = protocol.StdinNotEnabled
		default:
			code = process.input.admit(streamID, sequence, operation, data)
		}
	}
	if code == "" {
		return nil
	}
	return s.emitter.Emit(inputResult(requestID, streamID, sequence, operation, 0, code))
}

func inputResult(requestID, streamID string, sequence uint64, operation string, written uint64, code string) protocol.StdinResultEvent {
	status := "succeeded"
	var failure *string
	if code != "" {
		status = "failed"
		failure = &code
	}
	return protocol.StdinResultEvent{ProtocolVersion: protocol.Version, Type: "stdin_result",
		RequestID: requestID, StdinStreamID: streamID, Sequence: sequence, Operation: operation,
		Status: status, BytesWritten: written, Code: failure}
}

func (c *inputController) admit(streamID string, sequence uint64, operation string, data []byte) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if streamID != c.streamID {
		return protocol.StdinStreamMismatch
	}
	if c.stopped {
		if c.stopCode == protocol.StdinProcessExited {
			return protocol.StdinProcessExited
		}
		return protocol.StdinClosed
	}
	if c.closing {
		return protocol.StdinClosed
	}
	if c.pending != nil {
		return protocol.StdinBusy
	}
	if sequence != c.operations+1 {
		return protocol.StdinSequenceMismatch
	}
	if c.operations >= protocol.MaxInteractiveStdinOperations || c.totalBytes+uint64(len(data)) > protocol.MaxInteractiveStdinTotalBytes {
		return protocol.StdinLimitExceeded
	}
	op := &inputOperation{sequence: sequence, operation: operation, data: append([]byte(nil), data...)}
	select {
	case c.queue <- op:
		c.operations++
		c.totalBytes += uint64(len(data))
		c.pending = op
		c.closing = operation == "close"
		return ""
	default:
		return protocol.StdinBusy
	}
}

func (c *inputController) stop(code string) {
	c.mu.Lock()
	if !c.stopped {
		c.stopped = true
		c.stopCode = code
		close(c.stopSignal)
	}
	c.mu.Unlock()
	c.requestClose()
}

func (c *inputController) requestClose() { c.closeOnce.Do(func() { close(c.closeSignal) }) }

func (c *inputController) start(streams *sync.WaitGroup) {
	go func() {
		<-c.closeSignal
		// os.File.Close cancels pending Windows pipe I/O and waits for its references. Never
		// close the raw handle or perform this operation on the protocol/control goroutine.
		c.closeErr = c.writer.Close()
		if errors.Is(c.closeErr, io.ErrClosedPipe) || errors.Is(c.closeErr, os.ErrClosed) {
			c.closeErr = nil
		}
		close(c.closed)
	}()
	go c.watch()
	go func() {
		defer streams.Done()
		defer func() { c.requestClose(); <-c.closed; close(c.done) }()
		for {
			var op *inputOperation
			select {
			case op = <-c.queue:
			case <-c.stopSignal:
				c.mu.Lock()
				op = c.pending
				c.mu.Unlock()
				if op == nil {
					return
				}
			}
			c.execute(op)
			c.mu.Lock()
			stopped := c.stopped && c.pending == nil
			c.mu.Unlock()
			if stopped || op.operation == "close" {
				return
			}
		}
	}()
}

func (c *inputController) execute(op *inputOperation) {
	c.mu.Lock()
	code := ""
	if c.stopped {
		code = protocol.StdinCancelled
		if c.stopCode == protocol.StdinProcessExited {
			code = protocol.StdinProcessExited
		}
	} else {
		op.started = true
	}
	c.mu.Unlock()
	written := 0
	var operationErr error
	if code == "" {
		c.activity <- inputActivity{op, true}
		if op.operation == "close" {
			c.requestClose()
			<-c.closed
			operationErr = c.closeErr
		} else {
			written, operationErr = c.writer.Write(op.data)
			if written < 0 || written > len(op.data) {
				written = 0
				operationErr = io.ErrShortWrite
			}
			if operationErr == nil && written != len(op.data) {
				operationErr = io.ErrShortWrite
			}
		}
	}
	c.mu.Lock()
	if op.started {
		if c.stopped && c.stopCode != protocol.StdinProcessExited {
			code = c.stopCode
		}
		if code == "" && operationErr != nil {
			if c.stopped {
				code = c.stopCode
			} else if op.operation == "close" {
				code = protocol.StdinCloseFailed
			} else {
				code = protocol.StdinWriteFailed
			}
		}
	}
	op.completed = true
	// Retire only this operation. A subsequent request can be admitted while its committed
	// result is publishing, but the single writer cannot execute it before that publication.
	if c.pending == op {
		c.pending = nil
	}
	c.mu.Unlock()
	c.activity <- inputActivity{op, false}
	if code != "" && op.started && code != protocol.StdinProcessExited && code != protocol.StdinCancelled {
		c.stop(code)
		c.terminateProcess()
	}
	if err := c.owner.server.emitter.Emit(inputResult(c.owner.requestID, c.streamID, op.sequence, op.operation, uint64(written), code)); err != nil {
		c.owner.server.fail(err)
		c.stop(protocol.StdinCancelled)
	}
}

func (c *inputController) terminateProcess() {
	// This is an internal failure response, not a client terminate request. Only stdin_result
	// reports it; an unsolicited terminated(cancelled) would violate the existing client protocol.
	_, err := c.owner.terminate(protocol.TerminationCancelled, false)
	if err != nil {
		c.owner.server.fail(err)
	}
}

func (c *inputController) timeoutOperation(expected *inputOperation) bool {
	c.mu.Lock()
	// Commit and deadline cancellation contend under the same lock. A timer that fired before
	// publication but lost to an already completed operation must not terminate its process.
	if expected == nil || c.pending != expected || !expected.started || expected.completed || c.stopped {
		c.mu.Unlock()
		return false
	}
	c.stopped = true
	c.stopCode = protocol.StdinWriteTimeout
	if expected.operation == "close" {
		c.stopCode = protocol.StdinCloseFailed
	}
	close(c.stopSignal)
	c.mu.Unlock()
	c.requestClose()
	c.terminateProcess()
	return true
}

func (c *inputController) failUnconfirmedCleanup() {
	// Completion and an expired timer can both be ready when the watcher is scheduled.
	// The timer must not fail a shared Host whose input cleanup has already completed.
	select {
	case <-c.done:
		return
	default:
	}
	c.owner.server.fail(errors.New("interactive standard input cleanup could not be confirmed"))
}

func (c *inputController) watch() {
	var active *inputOperation
	var timer *time.Timer
	var timeout <-chan time.Time
	var cleanupTimer *time.Timer
	var cleanupTimeout <-chan time.Time
	stop := c.stopSignal
	defer func() {
		if timer != nil {
			timer.Stop()
		}
		if cleanupTimer != nil {
			cleanupTimer.Stop()
		}
	}()
	for {
		select {
		case <-c.done:
			return
		case event := <-c.activity:
			if event.started {
				active = event.operation
				if timer != nil {
					timer.Stop()
				}
				timer = time.NewTimer(c.writeTimeout)
				timeout = timer.C
			} else if active == event.operation {
				if timer != nil {
					timer.Stop()
				}
				active = nil
				timeout = nil
			}
		case <-timeout:
			timeout = nil
			c.timeoutOperation(active)
		case <-stop:
			stop = nil
			cleanupTimer = time.NewTimer(c.writeTimeout)
			cleanupTimeout = cleanupTimer.C
		case <-cleanupTimeout:
			c.failUnconfirmedCleanup()
			return
		}
	}
}
