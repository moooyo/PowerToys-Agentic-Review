package host

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/protocol"
)

const defaultMaximumConcurrentRequests = 4

type Server struct {
	reader           *protocol.FrameReader
	emitter          *protocolEmitter
	launcher         processLauncher
	logger           *log.Logger
	maxConcurrent    int
	interactiveInput bool

	mu           sync.Mutex
	reservations map[string]*managedProcess
	activeWG     sync.WaitGroup
	fatal        chan error
	fatalOnce    sync.Once
}

func NewServer(input io.Reader, output io.Writer, logger *log.Logger, maximumConcurrentRequests int) *Server {
	return NewServerWithInteractiveInput(input, output, logger, maximumConcurrentRequests, false)
}

func NewServerWithInteractiveInput(input io.Reader, output io.Writer, logger *log.Logger, maximumConcurrentRequests int, interactiveInput bool) *Server {
	if maximumConcurrentRequests <= 0 {
		maximumConcurrentRequests = defaultMaximumConcurrentRequests
	}
	return &Server{
		reader:           protocol.NewFrameReader(input, protocol.MaxFrameBytes),
		emitter:          newProtocolEmitter(protocol.NewFrameWriter(output, protocol.MaxFrameBytes)),
		launcher:         newProcessLauncher(),
		logger:           logger,
		maxConcurrent:    maximumConcurrentRequests,
		interactiveInput: interactiveInput,
		reservations:     make(map[string]*managedProcess),
		fatal:            make(chan error, 1),
	}
}

func (s *Server) Run(ctx context.Context) error {
	processID := os.Getpid()
	if processID <= 0 || uint64(processID) > uint64(^uint32(0)) {
		return errors.New("host process ID is outside the protocol range")
	}
	capabilities := protocol.ReadyCapabilities{
		ConcurrentRequests:        true,
		MaximumFrameBytes:         protocol.MaxFrameBytes,
		MaximumConcurrentRequests: s.maxConcurrent,
	}
	if s.interactiveInput {
		capabilities.InteractiveStdin = protocol.DefaultInteractiveStdinCapabilities()
	}
	if err := s.emitter.Emit(protocol.ReadyEvent{
		ProtocolVersion: protocol.Version,
		Type:            "ready",
		ProcessHostPID:  uint32(processID),
		Capabilities:    capabilities,
	}); err != nil {
		return fmt.Errorf("emit ready event: %w", err)
	}

	requests := make(chan requestReadResult)
	go s.readRequests(requests)

	for {
		select {
		case <-ctx.Done():
			s.terminateAll(protocol.TerminationWorkerShutdown, false)
			s.waitForActiveProcesses(10 * time.Second)
			return ctx.Err()
		case err := <-s.emitter.Failed():
			s.terminateAll(protocol.TerminationWorkerShutdown, false)
			s.waitForActiveProcesses(10 * time.Second)
			return fmt.Errorf("protocol output failed: %w", err)
		case err := <-s.fatal:
			s.terminateAllBestEffort(protocol.TerminationWorkerShutdown)
			return fmt.Errorf("fatal process supervision failure: %w", err)
		case result := <-requests:
			if result.err != nil {
				if errors.Is(result.err, io.EOF) {
					s.terminateAll(protocol.TerminationWorkerShutdown, false)
					s.waitForActiveProcesses(10 * time.Second)
					return errors.New("protocol input closed before shutdown")
				}
				s.emitRequestError(result.err)
				s.terminateAll(protocol.TerminationWorkerShutdown, true)
				s.waitForActiveProcesses(10 * time.Second)
				return fmt.Errorf("invalid protocol input: %w", result.err)
			}

			switch request := result.request.(type) {
			case protocol.StartRequest:
				if err := s.start(request); err != nil {
					return err
				}
			case protocol.TerminateRequest:
				if err := s.terminate(request); err != nil {
					return err
				}
			case protocol.StdinWriteRequest:
				if err := s.writeInput(request); err != nil {
					return err
				}
			case protocol.StdinCloseRequest:
				if err := s.closeInput(request); err != nil {
					return err
				}
			case protocol.ShutdownRequest:
				s.terminateAll(protocol.TerminationWorkerShutdown, true)
				s.activeWG.Wait()
				if err := s.emitter.Emit(protocol.ShutdownCompleteEvent{
					ProtocolVersion: protocol.Version,
					Type:            "shutdown_complete",
					RequestID:       request.ID,
				}); err != nil {
					return fmt.Errorf("emit shutdown completion: %w", err)
				}
				return nil
			default:
				return fmt.Errorf("unsupported decoded request %T", result.request)
			}
		}
	}
}

type requestReadResult struct {
	request protocol.HostRequest
	err     error
}

func (s *Server) readRequests(results chan<- requestReadResult) {
	for {
		frame, err := s.reader.ReadFrame()
		if err != nil {
			if !errors.Is(err, io.EOF) {
				code := "INVALID_FRAME"
				if errors.Is(err, protocol.ErrFrameTooLarge) {
					code = "FRAME_TOO_LARGE"
				}
				err = &protocol.RequestError{Code: code, Message: err.Error()}
			}
			results <- requestReadResult{err: err}
			return
		}
		request, err := protocol.DecodeRequest(frame)
		results <- requestReadResult{request: request, err: err}
		if err != nil {
			return
		}
	}
}

func (s *Server) start(request protocol.StartRequest) error {
	if request.Spec.InteractiveStdin && !s.interactiveInput {
		return s.emitOperationalError(&request.ID, protocol.StdinNotEnabled, errors.New("interactive standard input is not enabled for this Host"))
	}
	var stdinStreamID string
	if request.Spec.InteractiveStdin {
		var nonce [32]byte
		if _, err := rand.Read(nonce[:]); err != nil {
			return s.emitOperationalError(&request.ID, "PROCESS_START_FAILED", errors.New("unable to allocate interactive input identity"))
		}
		stdinStreamID = hex.EncodeToString(nonce[:])
	}
	s.mu.Lock()
	if _, exists := s.reservations[request.ID]; exists {
		s.mu.Unlock()
		return s.emitOperationalError(&request.ID, "DUPLICATE_REQUEST_ID", errors.New("requestId is already reserved by a starting or active process"))
	}
	if len(s.reservations) >= s.maxConcurrent {
		s.mu.Unlock()
		return s.emitOperationalError(&request.ID, "HOST_CAPACITY_EXCEEDED", fmt.Errorf("host allows at most %d concurrent requests", s.maxConcurrent))
	}
	s.reservations[request.ID] = nil
	s.mu.Unlock()

	limits, err := protocol.ResolveLimits(request.Spec.Limits)
	if err != nil {
		emitErr := s.emitOperationalError(&request.ID, "INVALID_RESOURCE_LIMIT", err)
		s.releaseReservation(request.ID, nil, false)
		return emitErr
	}
	process, err := s.launcher.Launch(request.Spec, limits)
	if err != nil {
		code := "PROCESS_START_FAILED"
		if errors.Is(err, errProcessIdentityUnavailable) {
			code = "PROCESS_IDENTITY_UNAVAILABLE"
		} else if errors.Is(err, errProcessIdentityQueryFailed) {
			code = "PROCESS_IDENTITY_QUERY_FAILED"
		}
		emitErr := s.emitOperationalError(&request.ID, code, err)
		s.releaseReservation(request.ID, nil, false)
		return emitErr
	}

	managed := &managedProcess{
		server:               s,
		requestID:            request.ID,
		process:              process,
		limits:               limits,
		done:                 make(chan struct{}),
		captureResourceUsage: request.Spec.CaptureResourceUsage,
	}
	if request.Spec.InteractiveStdin {
		managed.input = newInputController(managed, stdinStreamID, process.StandardInput())
	}
	s.mu.Lock()
	s.reservations[request.ID] = managed
	s.activeWG.Add(1)
	s.mu.Unlock()

	var processCreationTimeFileTime string
	if request.Spec.CaptureProcessIdentity {
		provider, available := process.(processIdentityProvider)
		if available {
			if creationTime := provider.ProcessCreationTimeFileTime(); creationTime != 0 {
				processCreationTimeFileTime = strconv.FormatUint(creationTime, 10)
			}
		}
		if processCreationTimeFileTime == "" {
			cleanupErr := managed.abortBeforeStarted()
			emitErr := s.emitOperationalError(&request.ID, "PROCESS_IDENTITY_UNAVAILABLE", errProcessIdentityUnavailable)
			return errors.Join(emitErr, cleanupErr)
		}
	}
	managed.armTimeout()

	if err := s.emitter.Emit(protocol.StartedEvent{
		ProtocolVersion:             protocol.Version,
		Type:                        "started",
		RequestID:                   request.ID,
		ProcessID:                   process.ProcessID(),
		ProcessCreationTimeFileTime: processCreationTimeFileTime,
		StdinStreamID:               stdinStreamID,
	}); err != nil {
		cleanupErr := managed.abortBeforeStarted()
		return errors.Join(fmt.Errorf("emit started event: %w", err), cleanupErr)
	}
	if err := managed.confirmStarted(); err != nil {
		cleanupErr := managed.abortBeforeStarted()
		return errors.Join(fmt.Errorf("complete started event: %w", err), cleanupErr)
	}
	managed.startIO(request.Spec.StandardInput)
	return nil
}

func (s *Server) terminate(request protocol.TerminateRequest) error {
	s.mu.Lock()
	process, exists := s.reservations[request.ID]
	s.mu.Unlock()
	if !exists {
		return s.emitOperationalError(&request.ID, "PROCESS_NOT_FOUND", errors.New("requestId does not identify an active process"))
	}
	if process == nil {
		return s.emitOperationalError(&request.ID, "PROCESS_NOT_RUNNING", errors.New("requestId identifies a process that is still starting"))
	}

	accepted, err := process.terminate(request.Reason, true)
	if !accepted {
		return nil
	}
	if err != nil {
		s.fail(err)
		s.emitOperationalErrorBestEffort(&request.ID, "PROCESS_TERMINATION_FAILED", err)
		return fmt.Errorf("fatal process termination failure: %w", err)
	}
	return nil
}

func (s *Server) terminateAll(reason protocol.TerminationReason, emitAcknowledgement bool) {
	s.mu.Lock()
	processes := make([]*managedProcess, 0, len(s.reservations))
	for _, process := range s.reservations {
		if process != nil {
			processes = append(processes, process)
		}
	}
	s.mu.Unlock()

	for _, process := range processes {
		accepted, err := process.terminate(reason, emitAcknowledgement)
		if !accepted || err == nil {
			continue
		}
		if emitAcknowledgement {
			_ = s.emitOperationalError(&process.requestID, "PROCESS_TERMINATION_FAILED", err)
		} else if s.logger != nil {
			s.logger.Printf("process termination failed for request %s: %v", process.requestID, err)
		}
	}
}

func (s *Server) terminateAllBestEffort(reason protocol.TerminationReason) {
	s.mu.Lock()
	processes := make([]*managedProcess, 0, len(s.reservations))
	for _, process := range s.reservations {
		if process != nil {
			processes = append(processes, process)
		}
	}
	s.mu.Unlock()
	for _, process := range processes {
		go func(process *managedProcess) {
			_, _ = process.terminate(reason, false)
		}(process)
	}
}

func (s *Server) waitForActiveProcesses(timeout time.Duration) {
	done := make(chan struct{})
	go func() {
		s.activeWG.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
	}
}

func (s *Server) releaseReservation(requestID string, expected *managedProcess, active bool) {
	s.mu.Lock()
	current, exists := s.reservations[requestID]
	if exists && current == expected {
		delete(s.reservations, requestID)
	}
	s.mu.Unlock()
	if exists && current == expected && active {
		s.activeWG.Done()
	}
}

func (s *Server) emitRequestError(err error) {
	var requestErr *protocol.RequestError
	if errors.As(err, &requestErr) {
		_ = s.emitter.Emit(newErrorEvent(requestErr.RequestID, requestErr.Code, requestErr.Message))
		return
	}
	_ = s.emitter.Emit(newErrorEvent(nil, "INVALID_REQUEST", err.Error()))
}

func (s *Server) emitOperationalError(requestID *string, code string, err error) error {
	if emitErr := s.emitter.Emit(newErrorEvent(requestID, code, err.Error())); emitErr != nil {
		return fmt.Errorf("emit %s error: %w", code, emitErr)
	}
	return nil
}

func (s *Server) emitOperationalErrorBestEffort(requestID *string, code string, err error) {
	go func() {
		_ = s.emitOperationalError(requestID, code, err)
	}()
}

func (s *Server) fail(err error) {
	if err == nil || s.fatal == nil {
		return
	}
	s.fatalOnce.Do(func() {
		s.fatal <- err
	})
}

func newErrorEvent(requestID *string, code, message string) protocol.ErrorEvent {
	message = strings.ReplaceAll(message, "\x00", " ")
	if message == "" {
		message = "unspecified ProcessHost error"
	}
	message = truncateUTF16(message, 2048)
	return protocol.ErrorEvent{
		ProtocolVersion: protocol.Version,
		Type:            "error",
		RequestID:       requestID,
		Code:            code,
		Message:         message,
	}
}

func truncateUTF16(value string, maximumUnits int) string {
	if len(utf16.Encode([]rune(value))) <= maximumUnits {
		return value
	}
	var builder strings.Builder
	units := 0
	for _, character := range value {
		characterUnits := 1
		if character > 0xffff {
			characterUnits = 2
		}
		if units+characterUnits > maximumUnits {
			break
		}
		builder.WriteRune(character)
		units += characterUnits
	}
	return builder.String()
}

type managedProcess struct {
	server               *Server
	requestID            string
	process              launchedProcess
	limits               protocol.EffectiveLimits
	done                 chan struct{}
	input                *inputController
	publicationMu        sync.Mutex
	captureResourceUsage bool

	lifecycleMu        sync.Mutex
	terminating        bool
	processExited      bool
	finished           bool
	started            bool
	pendingTermination *pendingTermination
	inputError         error
	doneOnce           sync.Once
}

type pendingTermination struct {
	reason              protocol.TerminationReason
	emitAcknowledgement bool
	err                 error
}

func (p *managedProcess) armTimeout() {
	timer := time.NewTimer(p.limits.HardTimeout)
	go p.enforceTimeout(timer)
}

func (p *managedProcess) confirmStarted() error {
	p.publicationMu.Lock()
	defer p.publicationMu.Unlock()
	p.lifecycleMu.Lock()
	if p.finished {
		p.lifecycleMu.Unlock()
		return errors.New("process finished before its started event completed")
	}
	p.started = true
	pending := p.pendingTermination
	p.pendingTermination = nil
	p.lifecycleMu.Unlock()
	if pending == nil {
		return nil
	}
	if pending.err != nil {
		p.server.fail(pending.err)
		p.server.emitOperationalErrorBestEffort(&p.requestID, "PROCESS_TERMINATION_FAILED", pending.err)
		return pending.err
	}
	if pending.emitAcknowledgement {
		return p.server.emitter.Emit(protocol.TerminatedEvent{
			ProtocolVersion: protocol.Version,
			Type:            "terminated",
			RequestID:       p.requestID,
			Reason:          pending.reason,
		})
	}
	return nil
}

func (p *managedProcess) abortBeforeStarted() error {
	p.lifecycleMu.Lock()
	p.finished = true
	p.pendingTermination = nil
	var terminateErr error
	if !p.terminating && !p.processExited {
		p.terminating = true
		terminateErr = p.process.Terminate()
	}
	p.lifecycleMu.Unlock()

	p.finishDone()
	closeErr := p.process.Close()
	p.server.releaseReservation(p.requestID, p, true)
	return errors.Join(terminateErr, closeErr)
}

func (p *managedProcess) startIO(standardInput *string) {
	collector := newOutputCollector(p.requestID, p.limits.MaximumOutputBytes, p.server.emitter)
	var streams sync.WaitGroup
	streams.Add(3)
	go func() {
		defer streams.Done()
		collector.Drain("stdout", p.process.StandardOutput())
	}()
	go func() {
		defer streams.Done()
		collector.Drain("stderr", p.process.StandardError())
	}()
	if p.input != nil {
		p.input.start(&streams)
	} else {
		go func() {
			defer streams.Done()
			defer p.process.StandardInput().Close()
			if standardInput == nil {
				return
			}
			if _, err := io.WriteString(p.process.StandardInput(), *standardInput); err != nil {
				p.lifecycleMu.Lock()
				p.inputError = err
				p.lifecycleMu.Unlock()
			}
		}()
	}

	go p.wait(collector, &streams)
}

func (p *managedProcess) enforceTimeout(timer *time.Timer) {
	defer timer.Stop()
	select {
	case <-p.done:
		return
	case <-timer.C:
		accepted, err := p.terminate(protocol.TerminationTimeout, true)
		if accepted && err != nil {
			p.server.fail(err)
			p.server.emitOperationalErrorBestEffort(&p.requestID, "PROCESS_TERMINATION_FAILED", err)
		}
	}
}

func (p *managedProcess) terminate(reason protocol.TerminationReason, emitAcknowledgement bool) (bool, error) {
	p.publicationMu.Lock()
	defer p.publicationMu.Unlock()
	p.lifecycleMu.Lock()
	if p.finished || p.processExited || p.terminating {
		p.lifecycleMu.Unlock()
		return false, nil
	}
	p.terminating = true
	if p.input != nil {
		p.input.stop(protocol.StdinCancelled)
	}
	terminateErr := p.process.Terminate()
	if errors.Is(terminateErr, errProcessAlreadyExited) {
		p.terminating = false
		p.processExited = true
		p.lifecycleMu.Unlock()
		return false, nil
	}
	if !p.started {
		p.pendingTermination = &pendingTermination{
			reason:              reason,
			emitAcknowledgement: emitAcknowledgement,
			err:                 terminateErr,
		}
		p.lifecycleMu.Unlock()
		return true, nil
	}
	p.lifecycleMu.Unlock()
	if terminateErr != nil {
		return true, terminateErr
	}
	if emitAcknowledgement {
		if err := p.server.emitter.Emit(protocol.TerminatedEvent{
			ProtocolVersion: protocol.Version,
			Type:            "terminated",
			RequestID:       p.requestID,
			Reason:          reason,
		}); err != nil {
			return true, err
		}
	}
	return true, nil
}

func (p *managedProcess) wait(collector *outputCollector, streams *sync.WaitGroup) {
	exitCode, waitErr := p.process.Wait()
	p.lifecycleMu.Lock()
	p.processExited = true
	p.lifecycleMu.Unlock()
	if p.input != nil {
		p.input.stop(protocol.StdinProcessExited)
	}
	if waitErr != nil {
		p.server.fail(waitErr)
	}
	streams.Wait()
	closeErr := p.process.Close()
	if closeErr != nil {
		p.server.fail(closeErr)
	}
	if waitErr != nil || closeErr != nil {
		p.lifecycleMu.Lock()
		p.finished = true
		p.lifecycleMu.Unlock()
		p.finishDone()
		p.server.releaseReservation(p.requestID, p, true)
		if waitErr != nil {
			p.server.emitOperationalErrorBestEffort(&p.requestID, "PROCESS_WAIT_FAILED", waitErr)
		}
		if closeErr != nil {
			p.server.emitOperationalErrorBestEffort(&p.requestID, "PROCESS_CLEANUP_FAILED", closeErr)
		}
		return
	}
	outputTruncated, outputErr := collector.Finish()
	var resourceUsage *protocol.ProcessResourceUsage
	if p.captureResourceUsage {
		if provider, available := p.process.(processResourceUsageProvider); available {
			resourceUsage = provider.ResourceUsage()
		}
	}

	p.publicationMu.Lock()
	p.lifecycleMu.Lock()
	p.finished = true
	inputErr := p.inputError
	p.lifecycleMu.Unlock()
	if outputErr != nil {
		_ = p.server.emitOperationalError(&p.requestID, "OUTPUT_READ_FAILED", outputErr)
	}
	if inputErr != nil {
		_ = p.server.emitOperationalError(&p.requestID, "STANDARD_INPUT_WRITE_FAILED", inputErr)
	}
	_ = p.server.emitter.Emit(protocol.ExitedEvent{
		ProtocolVersion: protocol.Version,
		Type:            "exited",
		RequestID:       p.requestID,
		ExitCode:        exitCode,
		Signal:          nil,
		OutputTruncated: outputTruncated,
		ResourceUsage:   resourceUsage,
	})
	p.publicationMu.Unlock()

	p.finishDone()
	p.server.releaseReservation(p.requestID, p, true)
}

func (p *managedProcess) finishDone() {
	p.doneOnce.Do(func() {
		close(p.done)
	})
}
