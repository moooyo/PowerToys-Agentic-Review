package servicebootstrap

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peerverify"
)

const rejectedResourceCloseAttempts = 3

type ownedResource interface {
	Close() error
}

type scmStatusSource interface {
	Status() (ServiceObservation, error)
	Close() error
}

type processObservation interface {
	HandleProcessID() (uint32, error)
	StillActive() (bool, error)
	HandleCreationTime() (time.Time, error)
	HandleStartKey() (peerverify.ProcessStartKey, error)
}

type daclTarget interface {
	ApplyAndVerifyDACL(daclPolicy) (DACLEvidence, error)
}

type currentProcess interface {
	processObservation
	daclTarget
	DirectParentProcessID() (uint32, error)
}

type primaryToken interface {
	daclTarget
	ownedResource
}

type wrapperProcess interface {
	processObservation
	daclTarget
	ImagePathDiagnostic() (string, error)
	OpenImage() (peerverify.ImageSubject, error)
	Wait(context.Context) error
	Close() error
}

type bootstrapPlatform interface {
	OpenSCMService(string) (scmStatusSource, error)
	OpenWrapperProcess(uint32) (wrapperProcess, error)
	CurrentProcess() (currentProcess, error)
	OpenCurrentPrimaryToken() (primaryToken, error)
}

// bootstrapGate makes the production bootstrap a process-wide one-shot. A
// failed attempt remains terminal because it may already have changed one of
// the three protected DACLs; retrying with another policy could create mixed
// evidence across the objects.
type bootstrapGate struct {
	mu        sync.Mutex
	attempted bool
}

var productionBootstrapGate bootstrapGate

func (g *bootstrapGate) open(options Options, platform bootstrapPlatform) (Session, error) {
	if err := validateOptions(options); err != nil {
		return nil, err
	}
	g.mu.Lock()
	if g.attempted {
		g.mu.Unlock()
		return nil, ErrAlreadyBootstrapped
	}
	g.attempted = true
	g.mu.Unlock()
	return openWithPlatform(options, platform)
}

func openWithPlatform(options Options, platform bootstrapPlatform) (result Session, err error) {
	if err := validateOptions(options); err != nil {
		return nil, err
	}
	if platform == nil {
		return nil, fmt.Errorf("%w: Windows platform adapter is required", ErrInvalidOptions)
	}

	service, err := platform.OpenSCMService(options.ServiceName)
	if err != nil {
		return nil, fmt.Errorf("open WinSW service in the local SCM: %w", err)
	}
	var wrapper wrapperProcess
	var token primaryToken
	keep := false
	defer func() {
		if keep {
			return
		}
		err = errors.Join(
			err,
			closeRejectedResource("close rejected current ServiceHost primary token", token),
			closeRejectedResource("close rejected WinSW wrapper process", wrapper),
			closeRejectedResource("close rejected SCM service handles", service),
		)
	}()

	before, err := service.Status()
	if err != nil {
		return nil, fmt.Errorf("observe WinSW service before opening wrapper process: %w", err)
	}
	if err := validateSCMObservation(before); err != nil {
		return nil, err
	}

	wrapper, err = platform.OpenWrapperProcess(before.ProcessID)
	if err != nil {
		return nil, fmt.Errorf("open WinSW wrapper process %d: %w", before.ProcessID, err)
	}
	if wrapper == nil {
		return nil, fmt.Errorf("%w: wrapper process opener returned no retained object", ErrWrapperUnstable)
	}

	after, err := service.Status()
	if err != nil {
		return nil, fmt.Errorf("observe WinSW service after opening wrapper process: %w", err)
	}
	if err := validateSCMObservation(after); err != nil {
		return nil, err
	}
	if before != after {
		return nil, fmt.Errorf(
			"%w: SCM observation changed from state=%d PID=%d to state=%d PID=%d",
			ErrWrapperUnstable,
			before.State,
			before.ProcessID,
			after.State,
			after.ProcessID,
		)
	}

	wrapperBefore, err := inspectStableProcess(wrapper, before.ProcessID, "WinSW wrapper")
	if err != nil {
		return nil, err
	}
	current, err := platform.CurrentProcess()
	if err != nil {
		return nil, fmt.Errorf("open current ServiceHost process object: %w", err)
	}
	if current == nil {
		return nil, errors.New("current ServiceHost process adapter is missing")
	}
	serviceHostBefore, err := inspectStableProcess(current, 0, "current ServiceHost")
	if err != nil {
		return nil, err
	}
	parentBefore, err := current.DirectParentProcessID()
	if err != nil {
		return nil, fmt.Errorf("query current ServiceHost direct parent: %w", err)
	}
	if err := validateDirectParent(serviceHostBefore, wrapperBefore, parentBefore); err != nil {
		return nil, err
	}

	processPolicy, tokenPolicy, err := serviceDACLPolicies(options.OwnServiceSID, options.PeerServiceSID)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidOptions, err)
	}
	token, err = platform.OpenCurrentPrimaryToken()
	if err != nil {
		return nil, fmt.Errorf("open current ServiceHost primary token for DACL bootstrap: %w", err)
	}
	if token == nil {
		return nil, errors.New("current ServiceHost primary token adapter is missing")
	}

	serviceHostProcessDACL, err := applyAndValidateDACL(current, processPolicy, "current ServiceHost process")
	if err != nil {
		return nil, err
	}
	serviceHostTokenDACL, err := applyAndValidateDACL(token, tokenPolicy, "current ServiceHost primary token")
	if err != nil {
		return nil, err
	}
	wrapperProcessDACL, err := applyAndValidateDACL(wrapper, processPolicy, "WinSW wrapper process")
	if err != nil {
		return nil, err
	}

	wrapperAfter, err := inspectStableProcess(wrapper, before.ProcessID, "WinSW wrapper after DACL bootstrap")
	if err != nil {
		return nil, err
	}
	if err := requireSameProcessFacts(wrapperBefore, wrapperAfter, "WinSW wrapper"); err != nil {
		return nil, err
	}
	serviceHostAfter, err := inspectStableProcess(current, serviceHostBefore.ProcessID, "current ServiceHost after DACL bootstrap")
	if err != nil {
		return nil, err
	}
	if err := requireSameProcessFacts(serviceHostBefore, serviceHostAfter, "current ServiceHost"); err != nil {
		return nil, err
	}
	parentAfter, err := current.DirectParentProcessID()
	if err != nil {
		return nil, fmt.Errorf("requery current ServiceHost direct parent: %w", err)
	}
	if parentAfter != parentBefore {
		return nil, fmt.Errorf(
			"%w: current ServiceHost direct parent changed from %d to %d",
			ErrParentMismatch,
			parentBefore,
			parentAfter,
		)
	}
	if err := validateDirectParent(serviceHostAfter, wrapperAfter, parentAfter); err != nil {
		return nil, err
	}

	evidence := Evidence{
		ServiceName:                 options.ServiceName,
		SCMBeforeOpen:               before,
		SCMAfterOpen:                after,
		StableWrapperFacts:          wrapperAfter,
		StableServiceHostFacts:      serviceHostAfter,
		DirectParentProcessID:       parentAfter,
		ServiceHostProcessDACL:      serviceHostProcessDACL,
		ServiceHostPrimaryTokenDACL: serviceHostTokenDACL,
		WinSWWrapperProcessDACL:     wrapperProcessDACL,
	}
	bootstrap := &bootstrapSession{
		service:  service,
		token:    token,
		wrapper:  wrapper,
		evidence: cloneEvidence(evidence),
	}
	keep = true
	return bootstrap, nil
}

func validateSCMObservation(observation ServiceObservation) error {
	if observation.State != ServiceRunning && observation.State != ServicePaused {
		return fmt.Errorf(
			"%w: SCM state %d is not running or paused",
			ErrWrapperUnstable,
			observation.State,
		)
	}
	if observation.ProcessID == 0 {
		return fmt.Errorf("%w: SCM returned wrapper PID zero", ErrWrapperUnstable)
	}
	return nil
}

func inspectStableProcess(
	process processObservation,
	expectedProcessID uint32,
	label string,
) (peerverify.StableProcessFacts, error) {
	processID, err := process.HandleProcessID()
	if err != nil {
		return peerverify.StableProcessFacts{}, fmt.Errorf("query %s PID from retained handle: %w", label, err)
	}
	if processID == 0 || expectedProcessID != 0 && processID != expectedProcessID {
		return peerverify.StableProcessFacts{}, fmt.Errorf(
			"%w: %s retained handle PID is %d, expected %d",
			ErrWrapperUnstable,
			label,
			processID,
			expectedProcessID,
		)
	}
	active, err := process.StillActive()
	if err != nil {
		return peerverify.StableProcessFacts{}, fmt.Errorf("query %s liveness: %w", label, err)
	}
	if !active {
		return peerverify.StableProcessFacts{}, fmt.Errorf("%w: %s is not active", ErrWrapperUnstable, label)
	}
	creationTime, err := process.HandleCreationTime()
	if err != nil {
		return peerverify.StableProcessFacts{}, fmt.Errorf("query %s creation time: %w", label, err)
	}
	if creationTime.IsZero() {
		return peerverify.StableProcessFacts{}, fmt.Errorf("%w: %s creation time is zero", ErrWrapperUnstable, label)
	}
	startKey, err := process.HandleStartKey()
	if err != nil {
		return peerverify.StableProcessFacts{}, fmt.Errorf("query %s process start key: %w", label, err)
	}
	if startKey.Available && startKey.SequenceNumber == 0 {
		return peerverify.StableProcessFacts{}, fmt.Errorf("%w: %s process start key is zero", ErrWrapperUnstable, label)
	}
	active, err = process.StillActive()
	if err != nil {
		return peerverify.StableProcessFacts{}, fmt.Errorf("requery %s liveness: %w", label, err)
	}
	if !active {
		return peerverify.StableProcessFacts{}, fmt.Errorf("%w: %s exited during inspection", ErrWrapperUnstable, label)
	}
	return peerverify.StableProcessFacts{
		ProcessID:    processID,
		CreationTime: creationTime,
		StartKey:     startKey,
	}, nil
}

func requireSameProcessFacts(
	before peerverify.StableProcessFacts,
	after peerverify.StableProcessFacts,
	label string,
) error {
	if before.ProcessID != after.ProcessID ||
		!before.CreationTime.Equal(after.CreationTime) ||
		before.StartKey != after.StartKey {
		return fmt.Errorf(
			"%w: %s facts changed from %+v to %+v",
			ErrWrapperUnstable,
			label,
			before,
			after,
		)
	}
	return nil
}

func validateDirectParent(
	serviceHost peerverify.StableProcessFacts,
	wrapper peerverify.StableProcessFacts,
	parentProcessID uint32,
) error {
	if parentProcessID == 0 || parentProcessID != wrapper.ProcessID {
		return fmt.Errorf(
			"%w: current ServiceHost parent PID is %d, current WinSW wrapper PID is %d",
			ErrParentMismatch,
			parentProcessID,
			wrapper.ProcessID,
		)
	}
	if !serviceHost.CreationTime.After(wrapper.CreationTime) {
		return fmt.Errorf(
			"%w: ServiceHost creation time %s is not later than WinSW creation time %s",
			ErrParentMismatch,
			serviceHost.CreationTime.UTC().Format(time.RFC3339Nano),
			wrapper.CreationTime.UTC().Format(time.RFC3339Nano),
		)
	}
	if serviceHost.StartKey.Available && wrapper.StartKey.Available &&
		serviceHost.StartKey.SequenceNumber == wrapper.StartKey.SequenceNumber {
		return fmt.Errorf(
			"%w: ServiceHost and WinSW report the same process sequence number %d",
			ErrParentMismatch,
			serviceHost.StartKey.SequenceNumber,
		)
	}
	return nil
}

func applyAndValidateDACL(target daclTarget, policy daclPolicy, label string) (DACLEvidence, error) {
	evidence, err := target.ApplyAndVerifyDACL(policy)
	if err != nil {
		return DACLEvidence{}, fmt.Errorf("apply and read back protected %s DACL: %w", label, err)
	}
	if err := validateDACL(evidence, policy); err != nil {
		return DACLEvidence{}, fmt.Errorf("validate protected %s DACL: %w", label, err)
	}
	return cloneDACLEvidence(evidence), nil
}

func closeRejectedResource(label string, resource ownedResource) error {
	if resource == nil {
		return nil
	}
	var failures []error
	for attempt := 1; attempt <= rejectedResourceCloseAttempts; attempt++ {
		if err := resource.Close(); err != nil {
			failures = append(failures, fmt.Errorf("%s attempt %d: %w", label, attempt, err))
			continue
		}
		return errors.Join(failures...)
	}
	return errors.Join(failures...)
}

type bootstrapSession struct {
	mu       sync.RWMutex
	closeMu  sync.Mutex
	service  scmStatusSource
	token    primaryToken
	wrapper  wrapperProcess
	evidence Evidence
}

func (s *bootstrapSession) Evidence() Evidence {
	if s == nil {
		return Evidence{}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneEvidence(s.evidence)
}

func (s *bootstrapSession) ProcessID() uint32 {
	return s.StableFacts().ProcessID
}

func (s *bootstrapSession) CreationTime() time.Time {
	return s.StableFacts().CreationTime
}

func (s *bootstrapSession) StableFacts() peerverify.StableProcessFacts {
	if s == nil {
		return peerverify.StableProcessFacts{}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.evidence.StableWrapperFacts
}

func (s *bootstrapSession) currentWrapper() (wrapperProcess, error) {
	if s == nil {
		return nil, ErrClosed
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.wrapper == nil {
		return nil, ErrClosed
	}
	return s.wrapper, nil
}

func (s *bootstrapSession) HandleProcessID() (uint32, error) {
	wrapper, err := s.currentWrapper()
	if err != nil {
		return 0, err
	}
	return wrapper.HandleProcessID()
}

func (s *bootstrapSession) StillActive() (bool, error) {
	wrapper, err := s.currentWrapper()
	if err != nil {
		return false, err
	}
	return wrapper.StillActive()
}

func (s *bootstrapSession) HandleCreationTime() (time.Time, error) {
	wrapper, err := s.currentWrapper()
	if err != nil {
		return time.Time{}, err
	}
	return wrapper.HandleCreationTime()
}

func (s *bootstrapSession) HandleStartKey() (peerverify.ProcessStartKey, error) {
	wrapper, err := s.currentWrapper()
	if err != nil {
		return peerverify.ProcessStartKey{}, err
	}
	return wrapper.HandleStartKey()
}

func (s *bootstrapSession) ImagePathDiagnostic() (string, error) {
	wrapper, err := s.currentWrapper()
	if err != nil {
		return "", err
	}
	return wrapper.ImagePathDiagnostic()
}

func (s *bootstrapSession) OpenImage() (peerverify.ImageSubject, error) {
	wrapper, err := s.currentWrapper()
	if err != nil {
		return nil, err
	}
	return wrapper.OpenImage()
}

func (s *bootstrapSession) Wait(ctx context.Context) error {
	wrapper, err := s.currentWrapper()
	if err != nil {
		return err
	}
	return wrapper.Wait(ctx)
}

// Close clears each owned handle only after its native close succeeds. A
// failed wrapper close therefore leaves the exact original process handle
// available for a later Close retry.
func (s *bootstrapSession) Close() error {
	if s == nil {
		return nil
	}
	s.closeMu.Lock()
	defer s.closeMu.Unlock()

	s.mu.RLock()
	token := s.token
	service := s.service
	wrapper := s.wrapper
	s.mu.RUnlock()

	tokenErr := closeOwnedSessionResource("close current ServiceHost primary token", token)
	serviceErr := closeOwnedSessionResource("close SCM service handles", service)
	wrapperErr := closeOwnedSessionResource("close retained WinSW wrapper process", wrapper)

	s.mu.Lock()
	if tokenErr == nil && s.token == token {
		s.token = nil
	}
	if serviceErr == nil && s.service == service {
		s.service = nil
	}
	if wrapperErr == nil && s.wrapper == wrapper {
		s.wrapper = nil
	}
	s.mu.Unlock()
	return errors.Join(tokenErr, serviceErr, wrapperErr)
}

func closeOwnedSessionResource(label string, resource ownedResource) error {
	if resource == nil {
		return nil
	}
	if err := resource.Close(); err != nil {
		return fmt.Errorf("%s: %w", label, err)
	}
	return nil
}

var _ Session = (*bootstrapSession)(nil)
