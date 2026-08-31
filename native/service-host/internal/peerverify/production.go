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
	OpenPeerService(string) (serviceStatusSource, error)
	NewAuthenticodeVerifier() (AuthenticodeVerifier, error)
}

type resolvedWindowsOptions struct {
	peerService config.ServiceIdentity
	pipePeer    PipePeer
}

type windowsVerificationOptions struct {
	Role                                   config.Role
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
	switch options.Role {
	case config.RoleControl:
		expected = config.ServiceIdentity{Name: config.ExecutorServiceName, SID: config.ExecutorServiceSID}
		pipePeer = PipePeerClient
	case config.RoleExecutor:
		expected = config.ServiceIdentity{Name: config.ControlServiceName, SID: config.ControlServiceSID}
		pipePeer = PipePeerServer
	default:
		return resolvedWindowsOptions{}, invalidOptions("role must be control or executor")
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
