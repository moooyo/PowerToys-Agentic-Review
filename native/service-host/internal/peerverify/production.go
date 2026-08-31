package peerverify

import (
	"errors"
	"fmt"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winpipe"
)

const serviceStateRunning = uint32(4)

type serviceObservation struct {
	state     uint32
	processID uint32
}

type serviceStatusSource interface {
	Status() (serviceObservation, error)
	Close() error
}

type windowsVerificationPlatform interface {
	processOpener
	CurrentProcessID() uint32
	OpenPeerService(string) (serviceStatusSource, error)
	NewAuthenticodeVerifier() (AuthenticodeVerifier, error)
}

type productionPipeEndpoint interface {
	winpipe.ProcessIDObserver
	LocalSide() (winpipe.EndpointSide, error)
}

type resolvedWindowsOptions struct {
	peerService config.ServiceIdentity
	pipePeer    PipePeer
}

type windowsVerificationOptions struct {
	Role                                   config.Role
	LocalEndpointSide                      winpipe.EndpointSide
	PipeObserver                           winpipe.ProcessIDObserver
	WrapperImage                           ImageExpectation
	ServiceHostImage                       ImageExpectation
	ExpectedLeafSignerCertificateDERSHA256 string
}

type scmStableWrapper struct {
	StableProcess
	facts StableProcessFacts
}

func (wrapper *scmStableWrapper) StableFacts() StableProcessFacts {
	if wrapper == nil {
		return StableProcessFacts{}
	}
	return wrapper.facts
}

func verifyWindowsEndpoint(
	options Options,
	endpoint productionPipeEndpoint,
	platform windowsVerificationPlatform,
) (*Session, error) {
	expectedSide, err := expectedLocalEndpointSide(options.Role)
	if err != nil {
		return nil, err
	}
	if isNilInterface(endpoint) {
		return nil, invalidOptions("concrete named-pipe endpoint is required")
	}
	localSide, err := endpoint.LocalSide()
	if err != nil {
		return nil, errors.Join(ErrInvalidOptions, fmt.Errorf("inspect concrete named-pipe endpoint side: %w", err))
	}
	if localSide != expectedSide {
		return nil, invalidOptions(fmt.Sprintf(
			"role %q requires local pipe endpoint side %d, got %d",
			options.Role,
			expectedSide,
			localSide,
		))
	}
	return verifyWindowsWithPlatform(
		windowsVerificationOptions{
			Role:                                   options.Role,
			LocalEndpointSide:                      localSide,
			PipeObserver:                           endpoint,
			WrapperImage:                           options.WrapperImage,
			ServiceHostImage:                       options.ServiceHostImage,
			ExpectedLeafSignerCertificateDERSHA256: options.ExpectedLeafSignerCertificateDERSHA256,
		},
		platform,
	)
}

func expectedLocalEndpointSide(role config.Role) (winpipe.EndpointSide, error) {
	switch role {
	case config.RoleControl:
		return winpipe.EndpointSideServer, nil
	case config.RoleExecutor:
		return winpipe.EndpointSideClient, nil
	default:
		return winpipe.EndpointSideUnknown, invalidOptions("role must be control or executor")
	}
}

func verifyWindowsWithPlatform(
	options windowsVerificationOptions,
	platform windowsVerificationPlatform,
) (*Session, error) {
	resolved, err := resolveWindowsOptions(options)
	if err != nil {
		return nil, err
	}
	if isNilInterface(platform) {
		return nil, errors.New("Windows peer verification platform is required")
	}
	localProcessID := platform.CurrentProcessID()
	if localProcessID == 0 {
		return nil, fmt.Errorf("%w: Windows returned local process ID zero", ErrPeerUnstable)
	}
	initialPeerPID, err := observePipeProcessID(options.PipeObserver, resolved.pipePeer)
	if err != nil {
		return nil, fmt.Errorf("observe named-pipe peer before native acquisition: %w", err)
	}
	if initialPeerPID == 0 {
		return nil, fmt.Errorf("%w: initial named-pipe peer observation returned PID zero", ErrPeerUnstable)
	}
	if initialPeerPID == localProcessID {
		return nil, fmt.Errorf(
			"%w: named-pipe peer PID %d is the local ServiceHost process",
			ErrPeerUnstable,
			initialPeerPID,
		)
	}
	authenticodeVerifier, err := platform.NewAuthenticodeVerifier()
	if err != nil {
		return nil, fmt.Errorf("construct production Authenticode verifier: %w", err)
	}
	if isNilInterface(authenticodeVerifier) {
		return nil, errors.New("production Authenticode verifier is missing")
	}
	wrapper, err := openPeerSCMWrapper(platform, resolved.peerService.Name)
	if err != nil {
		return nil, err
	}
	return verifyWithOpener(
		options.PipeObserver,
		wrapper,
		verificationOptions{
			PipePeer:                               resolved.pipePeer,
			LocalProcessID:                         localProcessID,
			ExpectedServiceSID:                     resolved.peerService.SID,
			WrapperImage:                           options.WrapperImage,
			ServiceHostImage:                       options.ServiceHostImage,
			ExpectedLeafSignerCertificateDERSHA256: options.ExpectedLeafSignerCertificateDERSHA256,
			AuthenticodeVerifier:                   authenticodeVerifier,
			TokenVerifier:                          ExactRestrictedServiceSIDVerifier{},
		},
		platform,
	)
}

func resolveWindowsOptions(options windowsVerificationOptions) (resolvedWindowsOptions, error) {
	var expected config.ServiceIdentity
	var pipePeer PipePeer
	localSide, err := expectedLocalEndpointSide(options.Role)
	if err != nil {
		return resolvedWindowsOptions{}, err
	}
	switch options.Role {
	case config.RoleControl:
		expected = config.ServiceIdentity{Name: config.ExecutorServiceName, SID: config.ExecutorServiceSID}
		pipePeer = PipePeerClient
	case config.RoleExecutor:
		expected = config.ServiceIdentity{Name: config.ControlServiceName, SID: config.ControlServiceSID}
		pipePeer = PipePeerServer
	}
	if options.LocalEndpointSide != localSide {
		return resolvedWindowsOptions{}, invalidOptions(fmt.Sprintf(
			"role %q requires local pipe endpoint side %d, got %d",
			options.Role,
			localSide,
			options.LocalEndpointSide,
		))
	}
	if isNilInterface(options.PipeObserver) {
		return resolvedWindowsOptions{}, invalidOptions("named-pipe PID observer is required")
	}
	if err := validateImageExpectation("WinSW wrapper", options.WrapperImage); err != nil {
		return resolvedWindowsOptions{}, err
	}
	if err := validateImageExpectation("ServiceHost", options.ServiceHostImage); err != nil {
		return resolvedWindowsOptions{}, err
	}
	if sameWindowsPath(options.WrapperImage.Path, options.ServiceHostImage.Path) {
		return resolvedWindowsOptions{}, invalidOptions("WinSW wrapper and ServiceHost paths must be different")
	}
	if !validSHA256(options.ExpectedLeafSignerCertificateDERSHA256) {
		return resolvedWindowsOptions{}, invalidOptions(
			"expected Authenticode leaf signer certificate DER SHA-256 must be 64 lowercase hexadecimal characters",
		)
	}
	return resolvedWindowsOptions{peerService: expected, pipePeer: pipePeer}, nil
}

func openPeerSCMWrapper(
	platform windowsVerificationPlatform,
	serviceName string,
) (wrapper StableWrapper, err error) {
	service, err := platform.OpenPeerService(serviceName)
	if err != nil {
		return nil, errors.Join(
			fmt.Errorf("open peer WinSW service %q for status query: %w", serviceName, err),
			closeDiscardedServiceStatusSource(service),
		)
	}
	if isNilInterface(service) {
		return nil, errors.New("peer WinSW service status source is missing")
	}

	serviceOwned := true
	var process PeerProcess
	processTransferred := false
	defer func() {
		if !processTransferred {
			err = errors.Join(err, closeDiscardedStableProcess("close rejected peer WinSW wrapper process", process))
		}
		if serviceOwned {
			err = errors.Join(err, closeDiscardedServiceStatusSource(service))
		}
	}()

	before, err := service.Status()
	if err != nil {
		return nil, fmt.Errorf("observe peer WinSW service before opening wrapper process: %w", err)
	}
	if err := validatePeerSCMObservation(before); err != nil {
		return nil, err
	}
	process, err = platform.OpenProcess(before.processID)
	if err != nil {
		return nil, fmt.Errorf("open peer WinSW wrapper process %d: %w", before.processID, err)
	}
	if isNilInterface(process) {
		return nil, fmt.Errorf("%w: wrapper process opener returned no retained object", ErrWrapperUnstable)
	}

	after, err := service.Status()
	if err != nil {
		return nil, fmt.Errorf("observe peer WinSW service after opening wrapper process: %w", err)
	}
	if err := validatePeerSCMObservation(after); err != nil {
		return nil, err
	}
	if after != before {
		return nil, fmt.Errorf(
			"%w: peer SCM observation changed from state=%d PID=%d to state=%d PID=%d",
			ErrWrapperUnstable,
			before.state,
			before.processID,
			after.state,
			after.processID,
		)
	}

	facts, err := verifyCurrentProcess(
		process,
		StableProcessFacts{ProcessID: before.processID},
		ErrWrapperUnstable,
		"peer WinSW wrapper from SCM",
	)
	if err != nil {
		return nil, err
	}
	serviceCloseErr := closeDiscardedServiceStatusSource(service)
	serviceOwned = false
	if serviceCloseErr != nil {
		return nil, serviceCloseErr
	}

	processTransferred = true
	return &scmStableWrapper{StableProcess: process, facts: facts}, nil
}

func validatePeerSCMObservation(observation serviceObservation) error {
	if observation.state != serviceStateRunning {
		return fmt.Errorf(
			"%w: peer SCM state is %d, want SERVICE_RUNNING",
			ErrWrapperUnstable,
			observation.state,
		)
	}
	if observation.processID == 0 {
		return fmt.Errorf("%w: peer SCM returned PID zero", ErrWrapperUnstable)
	}
	return nil
}

func closeDiscardedServiceStatusSource(service serviceStatusSource) error {
	if isNilInterface(service) {
		return nil
	}
	return closeDiscardedResource("close peer SCM status handles", service.Close)
}

var _ StableWrapper = (*scmStableWrapper)(nil)
