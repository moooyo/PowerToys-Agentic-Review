package peerverify

import (
	"errors"
	"fmt"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winpipe"
)

const (
	serviceStateStartPending = uint32(2)
	serviceStateRunning      = uint32(4)
)

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
	Role              config.Role
	LocalEndpointSide winpipe.EndpointSide
	PipeObserver      winpipe.ProcessIDObserver
}

func verifyWindowsEndpoint(
	options productionOptions,
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
	return verifyWindowsWithPlatform(windowsVerificationOptions{
		Role:              options.Role,
		LocalEndpointSide: localSide,
		PipeObserver:      endpoint,
	}, platform)
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
) (session *Session, err error) {
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
	service, err := platform.OpenPeerService(resolved.peerService.Name)
	if err != nil {
		return nil, errors.Join(
			fmt.Errorf("open peer service %q for status query: %w", resolved.peerService.Name, err),
			closeServiceStatusSource(service),
		)
	}
	if isNilInterface(service) {
		return nil, errors.New("peer service status source is missing")
	}
	defer func() {
		err = errors.Join(err, closeServiceStatusSource(service))
	}()

	return verifyRetainedPeer(
		options.PipeObserver,
		service,
		verificationOptions{
			PipePeer:           resolved.pipePeer,
			LocalProcessID:     localProcessID,
			ExpectedServiceSID: resolved.peerService.SID,
			TokenVerifier:      ExactRestrictedServiceSIDVerifier{},
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
	return resolvedWindowsOptions{peerService: expected, pipePeer: pipePeer}, nil
}

func validatePeerServiceObservation(observation serviceObservation) error {
	if observation.state != serviceStateStartPending && observation.state != serviceStateRunning {
		return fmt.Errorf(
			"%w: peer SCM state is %d, want SERVICE_START_PENDING or SERVICE_RUNNING",
			ErrPeerUnstable,
			observation.state,
		)
	}
	if observation.processID == 0 {
		return fmt.Errorf("%w: peer SCM returned PID zero", ErrPeerUnstable)
	}
	return nil
}

func closeServiceStatusSource(service serviceStatusSource) error {
	if isNilInterface(service) {
		return nil
	}
	return closeDiscardedResource("close peer SCM status handles", service, service.Close)
}
