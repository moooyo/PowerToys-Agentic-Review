package localrpc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

const (
	maximumConfiguredConcurrency = 64
	maximumConfiguredRequests    = 1_000_000
	maximumConfiguredTimeout     = 10 * time.Minute
)

var (
	ErrInvalidServerOptions  = errors.New("invalid local RPC server options")
	ErrPeerClosed            = errors.New("local RPC peer closed its request stream")
	ErrServerShutdownTimeout = errors.New("local RPC handlers did not stop before the shutdown deadline")
	ErrIOTimeout             = errors.New("local RPC input or output timed out")
)

// ControlDispatcher exposes the complete privileged v1 surface. Implementations map these typed
// operations to fixed Worker API routes or the one configured non-exportable signing key.
type ControlDispatcher interface {
	Register(context.Context, json.RawMessage) (json.RawMessage, error)
	Claim(context.Context, json.RawMessage) (json.RawMessage, error)
	InstanceHeartbeat(context.Context, string, json.RawMessage) (json.RawMessage, error)
	CompleteRun(context.Context, string, json.RawMessage) (json.RawMessage, error)
	FailRun(context.Context, string, json.RawMessage) (json.RawMessage, error)
	SignLocalDigest(context.Context, [32]byte) ([]byte, error)
}

type ServerOptions struct {
	Role                      Role
	MaximumConcurrentRequests int
	MaximumRequestsPerSession int
	RequestTimeout            time.Duration
	ClaimTimeout              time.Duration
	IOTimeout                 time.Duration
	ShutdownTimeout           time.Duration
}

type Server struct {
	options    ServerOptions
	dispatcher ControlDispatcher
}

func NewServer(options ServerOptions, dispatcher ControlDispatcher) (*Server, error) {
	if options.Role != RoleControl && options.Role != RoleExecutor {
		return nil, fmt.Errorf("%w: role must be control or executor", ErrInvalidServerOptions)
	}
	if options.Role == RoleControl && dispatcher == nil {
		return nil, fmt.Errorf("%w: control dispatcher is required", ErrInvalidServerOptions)
	}
	if options.MaximumConcurrentRequests < 1 || options.MaximumConcurrentRequests > maximumConfiguredConcurrency {
		return nil, fmt.Errorf("%w: concurrent request limit is outside the supported range", ErrInvalidServerOptions)
	}
	if options.MaximumRequestsPerSession < 1 || options.MaximumRequestsPerSession > maximumConfiguredRequests {
		return nil, fmt.Errorf("%w: requestId limit is outside the supported range", ErrInvalidServerOptions)
	}
	if !validServerTimeout(options.RequestTimeout) || !validServerTimeout(options.ClaimTimeout) ||
		!validServerTimeout(options.IOTimeout) ||
		!validServerTimeout(options.ShutdownTimeout) {
		return nil, fmt.Errorf("%w: timeout is outside the supported range", ErrInvalidServerOptions)
	}
	return &Server{options: options, dispatcher: dispatcher}, nil
}

// Serve owns the already-bootstrapped HostControl byte stream for one payload lifetime. Closing
// either side cancels every active operation. Responses may complete out of order and are
// correlated only by the session-unique requestId.
func (s *Server) Serve(ctx context.Context, input io.ReadCloser, output io.WriteCloser) error {
	if ctx == nil {
		return errors.New("local RPC server context is required")
	}
	if input == nil || output == nil {
		return errors.New("local RPC input and output are required")
	}

	sessionContext, cancelSession := context.WithCancelCause(ctx)
	defer cancelSession(nil)
	var inputCloseOnce sync.Once
	var outputCloseOnce sync.Once
	// io.Closer does not promise that Close interrupts a concurrent synchronous pipe I/O or
	// returns promptly. Initiate each close once without putting the configured I/O deadline
	// behind an unbounded Close call. The ServiceHost process lifetime remains the final handle
	// boundary if a platform endpoint cannot be cancelled.
	closeInput := func() {
		inputCloseOnce.Do(func() { go func() { _ = input.Close() }() })
	}
	closeOutput := func() {
		outputCloseOnce.Do(func() { go func() { _ = output.Close() }() })
	}

	go func() {
		<-sessionContext.Done()
		closeInput()
		closeOutput()
	}()

	state := newSessionState(s.options.MaximumRequestsPerSession)
	claimGate := make(chan struct{}, 1)
	writer := &responseWriter{
		context: sessionContext, output: output, timeout: s.options.IOTimeout, closeOutput: closeOutput,
	}
	fatal := make(chan error, 1)
	reportFatal := func(err error) {
		select {
		case fatal <- err:
			cancelSession(err)
			closeInput()
			closeOutput()
		default:
		}
	}

	var handlers sync.WaitGroup
	terminalError := error(nil)
	for terminalError == nil {
		document, err := readFrameWithTimeout(
			sessionContext, input, MaximumRequestFrameBytes, s.options.IOTimeout, closeInput,
		)
		if err != nil {
			if fatalError := pollError(fatal); fatalError != nil {
				terminalError = fatalError
			} else if cause := context.Cause(sessionContext); cause != nil {
				terminalError = cause
			} else if errors.Is(err, io.EOF) {
				terminalError = ErrPeerClosed
			} else {
				terminalError = protocolError("INVALID_FRAME", "Local RPC framing failed.", "", err)
			}
			break
		}

		message, err := DecodeMessage(document, s.options.Role)
		if err != nil {
			var protocolFailure *ProtocolError
			if errors.As(err, &protocolFailure) && protocolFailure.RequestID != "" {
				_ = writer.writeError(protocolFailure.RequestID, errorBody{
					Code: protocolFailure.Code, Message: protocolFailure.Message, Retryable: false,
				})
			}
			terminalError = err
			break
		}
		if err := state.reserveID(message.RequestID()); err != nil {
			code := "DUPLICATE_REQUEST_ID"
			messageText := "Local RPC requestId was already used."
			if errors.Is(err, ErrRequestIDCapacity) {
				code = "REQUEST_ID_CAPACITY"
				messageText = "The local RPC requestId capacity is exhausted."
			}
			_ = writer.writeError(message.RequestID(), errorBody{
				Code: code, Message: messageText, Retryable: false,
			})
			terminalError = protocolError(code, messageText, message.RequestID(), err)
			break
		}

		switch typed := message.(type) {
		case CancelRequest:
			if !state.cancel(typed.TargetRequestID) {
				if err := writer.writeError(typed.ID, errorBody{
					Code: "REQUEST_NOT_ACTIVE", Message: "The target local RPC request is not active.", Retryable: false,
				}); err != nil {
					reportFatal(err)
				}
				continue
			}
			if err := writer.writeCanonicalSuccess(
				typed.ID,
				successBooleanBody("cancelled", true),
			); err != nil {
				reportFatal(err)
			}
		case CallRequest:
			requestContext, cancelRequest, accepted := state.start(
				sessionContext,
				typed.ID,
				s.maximumConcurrentRequests(),
				s.requestTimeout(typed.Operation),
			)
			if !accepted {
				if err := writer.writeError(typed.ID, errorBody{
					Code: "CONCURRENCY_LIMIT", Message: "The local RPC concurrency limit is reached.", Retryable: true,
				}); err != nil {
					reportFatal(err)
				}
				continue
			}
			handlers.Add(1)
			go func(request CallRequest) {
				defer handlers.Done()
				defer state.complete()
				defer cancelRequest(nil)
				releaseClaim, dispatchError := acquireClaim(requestContext, request.Operation, claimGate)
				var body json.RawMessage
				if dispatchError == nil {
					defer releaseClaim()
					body, dispatchError = s.dispatchSafely(requestContext, request)
				}
				// Remove the request under the same mutex used by cancel. If cancel wins, its
				// cause is visible below; if finish wins, a later cancel reports not-active.
				state.finishDispatch(request.ID)
				if cause := context.Cause(requestContext); cause != nil {
					dispatchError = cause
				}
				if dispatchError != nil {
					if err := writer.writeError(request.ID, sanitizeOperationError(dispatchError)); err != nil {
						reportFatal(err)
					}
					return
				}
				if request.Operation == OperationSignLocalDigest {
					if err := writer.writeCanonicalSuccess(request.ID, body); err != nil {
						reportFatal(err)
					}
					return
				}
				bodyMaximum := MaximumWorkerAPIBodyBytes
				frameMaximum := MaximumFrameBytes
				if request.Operation == OperationClaim {
					bodyMaximum = MaximumClaimResponseBodyBytes
					frameMaximum = MaximumClaimResponseFrameBytes
				}
				if err := writer.writeWorkerAPISuccess(request.ID, body, bodyMaximum, frameMaximum); err != nil {
					if errors.Is(err, ErrCanonicalJSONLimit) || errors.Is(err, ErrResponseTooLarge) ||
						errors.Is(err, ErrInvalidHandlerResult) {
						writeErr := writer.writeError(request.ID, errorBody{
							Code:      "INVALID_HANDLER_RESPONSE",
							Message:   "The ServiceHost operation returned an invalid response.",
							Retryable: true,
						})
						if writeErr == nil {
							return
						}
						err = errors.Join(err, writeErr)
					}
					reportFatal(err)
				}
			}(typed)
		default:
			terminalError = protocolError("INVALID_MESSAGE", "Local RPC message is invalid.", message.RequestID(), ErrInvalidMessage)
		}

		if fatalError := pollError(fatal); fatalError != nil {
			terminalError = fatalError
		}
	}

	cancelSession(terminalError)
	closeInput()
	closeOutput()
	if !waitForHandlers(&handlers, s.options.ShutdownTimeout) {
		return errors.Join(terminalError, ErrServerShutdownTimeout)
	}
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	if fatalError := pollError(fatal); fatalError != nil {
		return fatalError
	}
	return terminalError
}

func (s *Server) dispatch(ctx context.Context, request CallRequest) (json.RawMessage, error) {
	if s.dispatcher == nil {
		return nil, ErrOperationNotAllowed
	}
	body := json.RawMessage(bytes.Clone(request.Body))
	switch request.Operation {
	case OperationRegister:
		return s.dispatcher.Register(ctx, body)
	case OperationClaim:
		return s.dispatcher.Claim(ctx, body)
	case OperationInstanceHeartbeat:
		return s.dispatcher.InstanceHeartbeat(ctx, request.WorkerInstanceID, body)
	case OperationCompleteRun:
		return s.dispatcher.CompleteRun(ctx, request.RunAttemptID, body)
	case OperationFailRun:
		return s.dispatcher.FailRun(ctx, request.RunAttemptID, body)
	case OperationSignLocalDigest:
		signature, err := s.dispatcher.SignLocalDigest(ctx, request.Digest)
		if err != nil {
			return nil, err
		}
		return signatureBody(signature)
	default:
		return nil, ErrUnknownOperation
	}
}

func (s *Server) dispatchSafely(ctx context.Context, request CallRequest) (body json.RawMessage, err error) {
	defer func() {
		if recover() != nil {
			body = nil
			err = errors.New("local RPC dispatcher panicked")
		}
	}()
	return s.dispatch(ctx, request)
}

func (s *Server) maximumConcurrentRequests() int { return s.options.MaximumConcurrentRequests }

func (s *Server) requestTimeout(operation Operation) time.Duration {
	if operation == OperationClaim {
		return s.options.ClaimTimeout
	}
	return s.options.RequestTimeout
}

func acquireClaim(ctx context.Context, operation Operation, gate chan struct{}) (func(), error) {
	if operation != OperationClaim {
		return func() {}, nil
	}
	select {
	case gate <- struct{}{}:
		return func() { <-gate }, nil
	case <-ctx.Done():
		return nil, context.Cause(ctx)
	}
}

type sessionState struct {
	mu             sync.Mutex
	seen           map[string]struct{}
	active         map[string]context.CancelCauseFunc
	inFlight       int
	maximumSeenIDs int
}

func newSessionState(maximumSeenIDs int) *sessionState {
	return &sessionState{
		seen: make(map[string]struct{}), active: make(map[string]context.CancelCauseFunc), maximumSeenIDs: maximumSeenIDs,
	}
}

func (s *sessionState) reserveID(requestID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.seen[requestID]; exists {
		return ErrDuplicateRequestID
	}
	if len(s.seen) >= s.maximumSeenIDs {
		return ErrRequestIDCapacity
	}
	s.seen[requestID] = struct{}{}
	return nil
}

func (s *sessionState) start(
	parent context.Context,
	requestID string,
	maximumConcurrent int,
	timeout time.Duration,
) (context.Context, context.CancelCauseFunc, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inFlight >= maximumConcurrent {
		return nil, nil, false
	}
	cancellable, cancel := context.WithCancelCause(parent)
	timed, cancelTimeout := context.WithTimeoutCause(cancellable, timeout, ErrRequestTimeout)
	combinedCancel := func(cause error) {
		if cause != nil {
			cancel(cause)
		} else {
			cancel(nil)
		}
		cancelTimeout()
	}
	s.active[requestID] = combinedCancel
	s.inFlight++
	return timed, combinedCancel, true
}

func (s *sessionState) cancel(requestID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	cancel, exists := s.active[requestID]
	if exists {
		cancel(ErrRequestCancelled)
	}
	return exists
}

func (s *sessionState) finishDispatch(requestID string) {
	s.mu.Lock()
	delete(s.active, requestID)
	s.mu.Unlock()
}

func (s *sessionState) complete() {
	s.mu.Lock()
	if s.inFlight > 0 {
		s.inFlight--
	}
	s.mu.Unlock()
}

type responseWriter struct {
	mu          sync.Mutex
	context     context.Context
	output      io.Writer
	timeout     time.Duration
	closeOutput func()
}

func (w *responseWriter) writeWorkerAPISuccess(
	requestID string,
	body json.RawMessage,
	bodyMaximum int,
	frameMaximum int,
) error {
	return w.buildAndWrite(frameMaximum, func() ([]byte, error) {
		document, err := marshalSuccessResponse(requestID, body, bodyMaximum, frameMaximum)
		if errors.Is(err, ErrCanonicalJSONLimit) {
			return nil, ErrResponseTooLarge
		}
		return document, err
	})
}

func (w *responseWriter) writeCanonicalSuccess(requestID string, body json.RawMessage) error {
	document, err := marshalCanonicalSuccessResponse(requestID, body)
	if err != nil {
		return err
	}
	return w.write(document, MaximumCanonicalControlFrameBytes)
}

func (w *responseWriter) writeError(requestID string, body errorBody) error {
	document, err := MarshalErrorResponse(requestID, body)
	if err != nil {
		return err
	}
	return w.write(document, MaximumCanonicalControlFrameBytes)
}

func (w *responseWriter) write(document []byte, maximum int) error {
	return w.buildAndWrite(maximum, func() ([]byte, error) { return document, nil })
}

func (w *responseWriter) buildAndWrite(maximum int, build func() ([]byte, error)) error {
	writeContext, cancelWrite := context.WithTimeoutCause(w.context, w.timeout, ErrIOTimeout)
	defer cancelWrite()
	done := make(chan error, 1)
	go func() {
		w.mu.Lock()
		defer w.mu.Unlock()
		if cause := context.Cause(writeContext); cause != nil {
			done <- cause
			return
		}
		document, err := build()
		if err != nil {
			done <- err
			return
		}
		if cause := context.Cause(writeContext); cause != nil {
			done <- cause
			return
		}
		done <- WriteFrame(w.output, document, maximum)
	}()
	select {
	case err := <-done:
		return err
	case <-writeContext.Done():
		w.closeOutput()
		return context.Cause(writeContext)
	}
}

type frameReadResult struct {
	document []byte
	err      error
}

func readFrameWithTimeout(
	ctx context.Context,
	input io.Reader,
	maximum int,
	timeout time.Duration,
	closeInput func(),
) ([]byte, error) {
	result := make(chan frameReadResult, 1)
	go func() {
		document, err := ReadFrame(input, maximum)
		result <- frameReadResult{document: document, err: err}
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case value := <-result:
		return value.document, value.err
	case <-ctx.Done():
		closeInput()
		return nil, context.Cause(ctx)
	case <-timer.C:
		closeInput()
		return nil, ErrIOTimeout
	}
}

func waitForHandlers(handlers *sync.WaitGroup, timeout time.Duration) bool {
	done := make(chan struct{})
	go func() {
		handlers.Wait()
		close(done)
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-done:
		return true
	case <-timer.C:
		return false
	}
}

func pollError(channel <-chan error) error {
	select {
	case err := <-channel:
		return err
	default:
		return nil
	}
}

func validServerTimeout(value time.Duration) bool {
	return value > 0 && value <= maximumConfiguredTimeout
}
