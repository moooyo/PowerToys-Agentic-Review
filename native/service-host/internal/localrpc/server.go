package localrpc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
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
	RuntimeBootstrap          CommittedRuntimeBootstrap
	MaximumConcurrentRequests int
	MaximumRequestsPerSession int
	RequestTimeout            time.Duration
	ClaimTimeout              time.Duration
	IOTimeout                 time.Duration
	ShutdownTimeout           time.Duration
}

type Server struct {
	options         ServerOptions
	dispatcher      ControlDispatcher
	shutdown        *arwxShutdownGate
	operationPolicy runtimeOperationPolicy
}

func NewServer(options ServerOptions, dispatcher ControlDispatcher) (*Server, error) {
	if options.Role != RoleControl && options.Role != RoleExecutor {
		return nil, fmt.Errorf("%w: role must be control or executor", ErrInvalidServerOptions)
	}
	if options.Role == RoleControl && isNilControlDispatcher(dispatcher) {
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
	shutdown, err := newArwxShutdownGate(options.RuntimeBootstrap, options.Role)
	if err != nil {
		return nil, fmt.Errorf("%w: committed runtime bootstrap is invalid", ErrInvalidServerOptions)
	}
	return &Server{
		options:         options,
		dispatcher:      dispatcher,
		shutdown:        shutdown,
		operationPolicy: shutdown.binding.operationPolicy,
	}, nil
}

func isNilControlDispatcher(dispatcher ControlDispatcher) bool {
	if dispatcher == nil {
		return true
	}
	value := reflect.ValueOf(dispatcher)
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return value.IsNil()
	default:
		return false
	}
}

// Serve borrows the already-bootstrapped HostControl byte stream for one payload lifetime. The
// caller remains its owner and must close it after Serve returns. Responses may complete out of
// order and are correlated only by the session-unique requestId.
func (s *Server) Serve(ctx context.Context, input io.ReadCloser, output io.WriteCloser) error {
	if ctx == nil {
		return errors.New("local RPC server context is required")
	}
	if input == nil || output == nil {
		return errors.New("local RPC input and output are required")
	}
	channel, err := s.shutdown.bindServeStreams(input, output)
	if err != nil {
		return err
	}
	frameReader := sessionFrameReader{channel: channel, partialTimeout: s.options.IOTimeout}

	sessionContext, cancelSession := context.WithCancelCause(ctx)
	defer cancelSession(nil)

	state := newSessionState(s.options.MaximumRequestsPerSession)
	claimGate := make(chan struct{}, 1)
	writer := newResponseWriter(sessionContext, channel, s.options.IOTimeout)
	fatal := make(chan error, 1)
	reportFatal := func(err error) {
		select {
		case fatal <- err:
			cancelSession(err)
		default:
		}
	}

	terminalError := error(nil)
	orderlyArmedEOF := false

serveLoop:
	for terminalError == nil {
		boundaryDeadline := time.Time{}
		if state.shutdownArmed() {
			deadline, valid := s.shutdown.armedDeadline()
			if !valid {
				terminalError = ErrIOTimeout
				break serveLoop
			}
			if !time.Now().Before(deadline) {
				s.shutdown.failCurrentAuthorization()
				terminalError = ErrIOTimeout
				break serveLoop
			}
			boundaryDeadline = deadline
		}
		document, err := frameReader.readFrame(
			sessionContext,
			MaximumRequestFrameBytes,
			boundaryDeadline,
		)
		if err != nil {
			if fatalError := pollError(fatal); fatalError != nil {
				terminalError = fatalError
			} else if cause := context.Cause(sessionContext); cause != nil {
				terminalError = cause
			} else if err == io.EOF {
				if state.shutdownArmed() {
					if _, valid := s.shutdown.armedDeadline(); valid {
						orderlyArmedEOF = true
						break serveLoop
					}
					terminalError = ErrIOTimeout
				} else {
					terminalError = ErrPeerClosed
				}
			} else if state.shutdownArmed() && errors.Is(err, ErrIOTimeout) {
				s.shutdown.failCurrentAuthorization()
				terminalError = ErrIOTimeout
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
		if state.shutdownStarted() {
			terminalError = protocolError(
				"ARWX_SHUTDOWN_ARMED",
				"HostControl received a request after ARWX shutdown started.",
				message.RequestID(),
				ErrArwxShutdownArmed,
			)
			break
		}
		if call, ok := message.(CallRequest); ok &&
			call.Operation == OperationClaim && !s.operationPolicy.claimAllowed {
			denied := protocolError(
				"OPERATION_NOT_ALLOWED",
				"Local RPC Claim is not enabled by the committed role configuration.",
				call.ID,
				ErrOperationNotAllowed,
			)
			writeErr := writer.writeError(call.ID, errorBody{
				Code: denied.Code, Message: denied.Message, Retryable: false,
			})
			terminalError = denied
			if writeErr != nil {
				terminalError = errors.Join(denied, writeErr)
			}
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
			if typed.Operation == OperationArmArwxShutdown {
				terminalError = s.armArwxShutdown(sessionContext, state, writer, typed)
				break
			}
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
			go func(request CallRequest) {
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

	if state.shutdownStarted() && !orderlyArmedEOF {
		s.shutdown.failCurrentAuthorization()
	}
	cancelSession(terminalError)
	if !state.waitForIdle(s.options.ShutdownTimeout) {
		s.shutdown.failCurrentAuthorization()
		return errors.Join(terminalError, ErrServerShutdownTimeout)
	}
	if cause := context.Cause(ctx); cause != nil {
		s.shutdown.failCurrentAuthorization()
		return cause
	}
	if fatalError := pollError(fatal); fatalError != nil {
		s.shutdown.failCurrentAuthorization()
		return fatalError
	}
	if orderlyArmedEOF {
		if _, valid := s.shutdown.armedDeadline(); valid {
			return nil
		}
		s.shutdown.failCurrentAuthorization()
		return ErrIOTimeout
	}
	return terminalError
}

// AuthorizeArwxEOF consumes the sole prepared shutdown authorization and validates the exact
// role-local final ARWX frame. A prepared authorization may wait for its response acknowledgement
// only until the Arm claim's absolute deadline.
func (s *Server) AuthorizeArwxEOF(ctx context.Context, finalFrame []byte) (time.Time, error) {
	if ctx == nil {
		return time.Time{}, errors.New("ARWX EOF authorization context is required")
	}
	if s == nil || s.shutdown == nil {
		return time.Time{}, ErrArwxShutdownUnavailable
	}
	return s.shutdown.authorizeEOF(ctx, finalFrame)
}

func (s *Server) armArwxShutdown(
	ctx context.Context,
	state *sessionState,
	writer *responseWriter,
	request CallRequest,
) error {
	deadline := time.Now().Add(time.Duration(request.ArwxShutdown.RemainingShutdownMS) * time.Millisecond)
	if err := state.beginShutdownArm(ctx, deadline); err != nil {
		return protocolError(
			"ARWX_SHUTDOWN_NOT_READY",
			"ARWX shutdown cannot arm while local RPC work is active.",
			request.ID,
			err,
		)
	}
	if s.shutdown == nil {
		return protocolError(
			"ARWX_SHUTDOWN_NOT_READY",
			"ARWX shutdown is not bound to a committed bootstrap.",
			request.ID,
			ErrArwxShutdownUnavailable,
		)
	}
	result, authorization, err := s.shutdown.prepare(request.ArwxShutdown, deadline)
	if err != nil {
		return protocolError(
			"INVALID_PAYLOAD",
			"ArmArwxShutdownV1 does not match the committed session.",
			request.ID,
			err,
		)
	}
	document, err := marshalArmArwxShutdownResult(request.ID, result)
	if err != nil {
		failArwxShutdownAuthorization(authorization)
		return err
	}
	if err := writer.writeUntil(document, MaximumArmArwxShutdownBytes, deadline); err != nil {
		failArwxShutdownAuthorization(authorization)
		return err
	}
	if !markArwxShutdownAcknowledged(authorization) {
		failArwxShutdownAuthorization(authorization)
		return ErrIOTimeout
	}
	state.finishShutdownArm()
	return nil
}

func (s *Server) dispatch(ctx context.Context, request CallRequest) (json.RawMessage, error) {
	if request.Operation == OperationClaim && !s.operationPolicy.claimAllowed {
		return nil, ErrOperationNotAllowed
	}
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
	responseIdle   chan struct{}
	maximumSeenIDs int
	shutdownPhase  uint8
}

func (s *sessionState) beginShutdownArm(ctx context.Context, deadline time.Time) error {
	s.mu.Lock()
	if s.shutdownPhase != 0 {
		s.mu.Unlock()
		return ErrArwxShutdownArmed
	}
	s.shutdownPhase = 1
	if len(s.active) != 0 {
		s.mu.Unlock()
		return ErrArwxShutdownActive
	}
	if s.inFlight == 0 {
		s.mu.Unlock()
		return nil
	}
	idle := s.responseIdle
	s.mu.Unlock()

	remaining := time.Until(deadline)
	if remaining <= 0 {
		return ErrIOTimeout
	}
	timer := time.NewTimer(remaining)
	defer timer.Stop()
	select {
	case <-idle:
	case <-ctx.Done():
		return context.Cause(ctx)
	case <-timer.C:
		return ErrIOTimeout
	}
	if !time.Now().Before(deadline) {
		return ErrIOTimeout
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inFlight != 0 || len(s.active) != 0 {
		return ErrArwxShutdownActive
	}
	return nil
}

func (s *sessionState) finishShutdownArm() {
	s.mu.Lock()
	if s.shutdownPhase == 1 {
		s.shutdownPhase = 2
	}
	s.mu.Unlock()
}

func (s *sessionState) shutdownStarted() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.shutdownPhase != 0
}

func (s *sessionState) shutdownArmed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.shutdownPhase == 2
}

func (s *sessionState) waitForIdle(timeout time.Duration) bool {
	s.mu.Lock()
	if s.inFlight == 0 {
		s.mu.Unlock()
		return true
	}
	idle := s.responseIdle
	s.mu.Unlock()

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-idle:
		return true
	case <-timer.C:
		select {
		case <-idle:
			return true
		default:
			return false
		}
	}
}

func newSessionState(maximumSeenIDs int) *sessionState {
	responseIdle := make(chan struct{})
	close(responseIdle)
	return &sessionState{
		seen: make(map[string]struct{}), active: make(map[string]context.CancelCauseFunc),
		responseIdle: responseIdle, maximumSeenIDs: maximumSeenIDs,
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
	if s.inFlight == 0 {
		s.responseIdle = make(chan struct{})
	}
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
		if s.inFlight == 0 {
			close(s.responseIdle)
		}
	}
	s.mu.Unlock()
}

type responseWriter struct {
	gate    chan struct{}
	context context.Context
	output  RuntimeBootstrapChannel
	timeout time.Duration
}

func newResponseWriter(
	ctx context.Context,
	output RuntimeBootstrapChannel,
	timeout time.Duration,
) *responseWriter {
	gate := make(chan struct{}, 1)
	gate <- struct{}{}
	return &responseWriter{gate: gate, context: ctx, output: output, timeout: timeout}
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

func (w *responseWriter) writeUntil(document []byte, maximum int, deadline time.Time) error {
	writeContext, cancelWrite := context.WithDeadlineCause(w.context, deadline, ErrIOTimeout)
	defer cancelWrite()
	return w.writeContext(writeContext, document, maximum)
}

func (w *responseWriter) buildAndWrite(maximum int, build func() ([]byte, error)) error {
	writeContext, cancelWrite := context.WithTimeoutCause(w.context, w.timeout, ErrIOTimeout)
	defer cancelWrite()
	if err := acquireResponseWrite(writeContext, w.gate); err != nil {
		return err
	}
	defer releaseResponseWrite(w.gate)
	if cause := context.Cause(writeContext); cause != nil {
		return cause
	}
	document, err := build()
	if err != nil {
		return err
	}
	if cause := context.Cause(writeContext); cause != nil {
		return cause
	}
	err = WriteFrame(
		runtimeBootstrapContextWriter{ctx: writeContext, channel: w.output},
		document,
		maximum,
	)
	if cause := context.Cause(writeContext); cause != nil {
		return errors.Join(cause, err)
	}
	return err
}

func (w *responseWriter) writeContext(
	ctx context.Context,
	document []byte,
	maximum int,
) error {
	if err := acquireResponseWrite(ctx, w.gate); err != nil {
		return err
	}
	defer releaseResponseWrite(w.gate)
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	err := WriteFrame(
		runtimeBootstrapContextWriter{ctx: ctx, channel: w.output},
		document,
		maximum,
	)
	if cause := context.Cause(ctx); cause != nil {
		return errors.Join(cause, err)
	}
	return err
}

func acquireResponseWrite(ctx context.Context, gate chan struct{}) error {
	select {
	case <-ctx.Done():
		return context.Cause(ctx)
	case <-gate:
		return nil
	}
}

func releaseResponseWrite(gate chan struct{}) {
	gate <- struct{}{}
}

type sessionFrameReader struct {
	channel        RuntimeBootstrapChannel
	partialTimeout time.Duration
}

func (reader *sessionFrameReader) readFrame(
	ctx context.Context,
	maximum int,
	boundaryDeadline time.Time,
) ([]byte, error) {
	if ctx == nil {
		return nil, errors.New("local RPC frame context is required")
	}
	if reader == nil || isNilRuntimeBootstrapChannel(reader.channel) {
		return nil, errors.New("local RPC frame channel is required")
	}
	if cause := context.Cause(ctx); cause != nil {
		return nil, cause
	}

	boundaryContext := ctx
	cancelBoundary := func() {}
	if !boundaryDeadline.IsZero() {
		if !time.Now().Before(boundaryDeadline) {
			return nil, ErrIOTimeout
		}
		boundaryContext, cancelBoundary = context.WithDeadlineCause(
			ctx,
			boundaryDeadline,
			ErrIOTimeout,
		)
	}
	defer cancelBoundary()

	firstByte := make([]byte, 1)
	count, firstErr := reader.channel.ReadContext(boundaryContext, firstByte)
	if count < 0 || count > len(firstByte) {
		return nil, errors.New("local RPC frame reader returned an invalid byte count")
	}
	if cause := context.Cause(ctx); cause != nil {
		return nil, joinFrameReadCause(cause, count, firstErr)
	}
	if cause := context.Cause(boundaryContext); cause != nil {
		return nil, joinFrameReadCause(cause, count, firstErr)
	}
	if !boundaryDeadline.IsZero() && !time.Now().Before(boundaryDeadline) {
		return nil, joinFrameReadCause(ErrIOTimeout, count, firstErr)
	}
	if count == 0 {
		if firstErr == io.EOF {
			return nil, io.EOF
		}
		return nil, firstByteReadError(count, firstErr)
	}
	if firstErr != nil {
		return nil, firstByteReadError(count, firstErr)
	}

	now := time.Now()
	frameDeadline := now.Add(reader.partialTimeout)
	if !boundaryDeadline.IsZero() && boundaryDeadline.Before(frameDeadline) {
		frameDeadline = boundaryDeadline
	}
	if !now.Before(frameDeadline) {
		return nil, ErrIOTimeout
	}
	frameContext, cancelFrame := context.WithDeadlineCause(ctx, frameDeadline, ErrIOTimeout)
	defer cancelFrame()
	framedInput := io.MultiReader(
		bytes.NewReader(firstByte),
		runtimeBootstrapContextReader{ctx: frameContext, channel: reader.channel},
	)
	document, err := ReadFrame(framedInput, maximum)
	if cause := context.Cause(ctx); cause != nil {
		return nil, errors.Join(cause, err)
	}
	if cause := context.Cause(frameContext); cause != nil {
		return nil, errors.Join(cause, err)
	}
	if !time.Now().Before(frameDeadline) {
		return nil, errors.Join(ErrIOTimeout, err)
	}
	return document, err
}

func joinFrameReadCause(cause error, count int, readErr error) error {
	if readErr == nil || count == 0 && readErr == io.EOF {
		return cause
	}
	return errors.Join(cause, firstByteReadError(count, readErr))
}

func firstByteReadError(count int, readErr error) error {
	if readErr == nil {
		return fmt.Errorf("%w: length prefix reader made no progress", ErrPartialFrame)
	}
	return fmt.Errorf("%w: length prefix after %d byte: %v", ErrPartialFrame, count, readErr)
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
