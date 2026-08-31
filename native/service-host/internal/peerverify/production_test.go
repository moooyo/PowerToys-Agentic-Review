package peerverify

import (
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winpipe"
)

type scriptedServiceObservation struct {
	value serviceObservation
	err   error
}

type fakeServiceStatusSource struct {
	events       *[]string
	observations []scriptedServiceObservation
	closeErrors  []error
	closeCount   int
}

func (source *fakeServiceStatusSource) Status() (serviceObservation, error) {
	*source.events = append(*source.events, "scm-status")
	if len(source.observations) == 0 {
		return serviceObservation{}, errors.New("unexpected SCM status observation")
	}
	result := source.observations[0]
	source.observations = source.observations[1:]
	return result.value, result.err
}

func (source *fakeServiceStatusSource) Close() error {
	source.closeCount++
	*source.events = append(*source.events, "scm-close")
	if len(source.closeErrors) == 0 {
		return nil
	}
	err := source.closeErrors[0]
	source.closeErrors = source.closeErrors[1:]
	return err
}

type processOpenResult struct {
	process PeerProcess
	err     error
}

type fakeWindowsVerificationPlatform struct {
	events             *[]string
	service            serviceStatusSource
	serviceErr         error
	processes          map[uint32][]processOpenResult
	authenticode       AuthenticodeVerifier
	authenticodeErr    error
	currentProcessID   uint32
	openedServiceNames []string
}

type fakeProductionEndpoint struct {
	events   *[]string
	observer winpipe.ProcessIDObserver
	side     winpipe.EndpointSide
	sideErr  error
}

func (endpoint *fakeProductionEndpoint) LocalSide() (winpipe.EndpointSide, error) {
	*endpoint.events = append(*endpoint.events, "endpoint-side")
	return endpoint.side, endpoint.sideErr
}

func (endpoint *fakeProductionEndpoint) GetNamedPipeClientProcessID() (uint32, error) {
	return endpoint.observer.GetNamedPipeClientProcessID()
}

func (endpoint *fakeProductionEndpoint) GetNamedPipeServerProcessID() (uint32, error) {
	return endpoint.observer.GetNamedPipeServerProcessID()
}

func (platform *fakeWindowsVerificationPlatform) OpenPeerService(name string) (serviceStatusSource, error) {
	*platform.events = append(*platform.events, "open-service-"+name)
	platform.openedServiceNames = append(platform.openedServiceNames, name)
	return platform.service, platform.serviceErr
}

func (platform *fakeWindowsVerificationPlatform) CurrentProcessID() uint32 {
	*platform.events = append(*platform.events, "current-process-id")
	return platform.currentProcessID
}

func (platform *fakeWindowsVerificationPlatform) OpenProcess(processID uint32) (PeerProcess, error) {
	*platform.events = append(*platform.events, fmt.Sprintf("open-process-%d", processID))
	results := platform.processes[processID]
	if len(results) == 0 {
		return nil, fmt.Errorf("unexpected process open for PID %d", processID)
	}
	result := results[0]
	platform.processes[processID] = results[1:]
	return result.process, result.err
}

func (platform *fakeWindowsVerificationPlatform) NewAuthenticodeVerifier() (AuthenticodeVerifier, error) {
	*platform.events = append(*platform.events, "new-authenticode")
	return platform.authenticode, platform.authenticodeErr
}

type productionFixture struct {
	verification *verificationFixture
	service      *fakeServiceStatusSource
	platform     *fakeWindowsVerificationPlatform
	options      windowsVerificationOptions
	peerService  config.ServiceIdentity
	pipePeer     PipePeer
}

func newProductionFixture(role config.Role) *productionFixture {
	peerService := config.ServiceIdentity{Name: config.ExecutorServiceName, SID: config.ExecutorServiceSID}
	pipePeer := PipePeerClient
	localSide := winpipe.EndpointSideServer
	if role == config.RoleExecutor {
		peerService = config.ServiceIdentity{Name: config.ControlServiceName, SID: config.ControlServiceSID}
		pipePeer = PipePeerServer
		localSide = winpipe.EndpointSideClient
	}
	verification := newVerificationFixture(pipePeer)
	verification.observer.client = []observedPID{{value: 200}, {value: 200}, {value: 200}}
	verification.observer.server = []observedPID{{value: 200}, {value: 200}, {value: 200}}
	verification.peer.token.User.SID = peerService.SID
	verification.peer.token.Groups[0].SID = peerService.SID
	verification.peer.token.RestrictedSIDs[0].SID = peerService.SID
	service := &fakeServiceStatusSource{
		events: &verification.events,
		observations: []scriptedServiceObservation{
			{value: serviceObservation{state: serviceStateRunning, processID: 100}},
			{value: serviceObservation{state: serviceStateRunning, processID: 100}},
		},
	}
	platform := &fakeWindowsVerificationPlatform{
		events:           &verification.events,
		service:          service,
		authenticode:     verification.options.AuthenticodeVerifier,
		currentProcessID: verification.options.LocalProcessID,
		processes: map[uint32][]processOpenResult{
			100: {{process: verification.wrapper}},
			200: {{process: verification.peer}},
		},
	}
	return &productionFixture{
		verification: verification,
		service:      service,
		platform:     platform,
		options: windowsVerificationOptions{
			Role:                                   role,
			LocalEndpointSide:                      localSide,
			PipeObserver:                           verification.observer,
			WrapperImage:                           verification.options.WrapperImage,
			ServiceHostImage:                       verification.options.ServiceHostImage,
			ExpectedLeafSignerCertificateDERSHA256: verification.options.ExpectedLeafSignerCertificateDERSHA256,
		},
		peerService: peerService,
		pipePeer:    pipePeer,
	}
}

func TestProductionVerificationDerivesOpposingServiceAndPipeEndpointFromRole(t *testing.T) {
	tests := []struct {
		name        string
		role        config.Role
		observation string
	}{
		{name: "Control verifies Executor client", role: config.RoleControl, observation: "observe-client"},
		{name: "Executor verifies Control server", role: config.RoleExecutor, observation: "observe-server"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newProductionFixture(test.role)
			session, err := verifyWindowsWithPlatform(fixture.options, fixture.platform)
			if err != nil {
				t.Fatal(err)
			}
			wantPrefix := []string{
				"current-process-id",
				test.observation,
				"new-authenticode",
				"open-service-" + fixture.peerService.Name,
				"scm-status",
				"open-process-100",
				"scm-status",
				"wrapper-pid",
				"wrapper-active",
				"wrapper-created",
				"wrapper-start-key",
				"scm-close",
				test.observation,
				"open-process-200",
				test.observation,
			}
			if len(fixture.verification.events) < len(wantPrefix) ||
				!reflect.DeepEqual(fixture.verification.events[:len(wantPrefix)], wantPrefix) {
				t.Fatalf("operation prefix = %v, want %v", fixture.verification.events, wantPrefix)
			}
			if fixture.service.closeCount != 1 ||
				fixture.verification.wrapper.closeCount != 0 ||
				fixture.verification.peer.closeCount != 0 {
				t.Fatalf(
					"ownership before Session.Close = service %d wrapper %d peer %d",
					fixture.service.closeCount,
					fixture.verification.wrapper.closeCount,
					fixture.verification.peer.closeCount,
				)
			}
			if session.Evidence().PeerToken.ServiceSID != fixture.peerService.SID {
				t.Fatalf("verified token SID = %q, want %q", session.Evidence().PeerToken.ServiceSID, fixture.peerService.SID)
			}
			if err := session.Close(); err != nil {
				t.Fatal(err)
			}
			if fixture.verification.wrapper.closeCount != 1 || fixture.verification.peer.closeCount != 1 {
				t.Fatalf(
					"Session.Close counts = wrapper %d peer %d",
					fixture.verification.wrapper.closeCount,
					fixture.verification.peer.closeCount,
				)
			}
		})
	}
}

func TestProductionVerificationRejectsLoopbackPeerBeforePeerProcessOpen(t *testing.T) {
	for _, role := range []config.Role{config.RoleControl, config.RoleExecutor} {
		t.Run(string(role), func(t *testing.T) {
			fixture := newProductionFixture(role)
			localPID := fixture.platform.currentProcessID
			if role == config.RoleControl {
				fixture.verification.observer.client = []observedPID{{value: localPID}, {value: localPID}}
			} else {
				fixture.verification.observer.server = []observedPID{{value: localPID}, {value: localPID}}
			}
			_, err := verifyWindowsWithPlatform(fixture.options, fixture.platform)
			if !errors.Is(err, ErrPeerUnstable) {
				t.Fatalf("error = %v, want ErrPeerUnstable", err)
			}
			for _, event := range fixture.verification.events {
				if event == fmt.Sprintf("open-process-%d", localPID) {
					t.Fatalf("loopback peer reached process open: %v", fixture.verification.events)
				}
			}
			if fixture.verification.peer.closeCount != 0 || fixture.verification.wrapper.closeCount != 0 {
				t.Fatalf(
					"loopback close counts = peer %d wrapper %d",
					fixture.verification.peer.closeCount,
					fixture.verification.wrapper.closeCount,
				)
			}
		})
	}
}

func TestProductionVerificationRejectsZeroCurrentProcessIDBeforeNativeAcquisition(t *testing.T) {
	fixture := newProductionFixture(config.RoleControl)
	fixture.platform.currentProcessID = 0
	fixture.verification.events = nil
	_, err := verifyWindowsWithPlatform(fixture.options, fixture.platform)
	if !errors.Is(err, ErrPeerUnstable) {
		t.Fatalf("error = %v, want ErrPeerUnstable", err)
	}
	if !reflect.DeepEqual(fixture.verification.events, []string{"current-process-id"}) {
		t.Fatalf("zero current PID reached native acquisition: %v", fixture.verification.events)
	}
}

func TestProductionOptionsRejectInvalidRoleOrObserverBeforePlatformUse(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*windowsVerificationOptions)
	}{
		{name: "unknown role", mutate: func(options *windowsVerificationOptions) { options.Role = config.Role("other") }},
		{name: "Control on client endpoint", mutate: func(options *windowsVerificationOptions) {
			options.LocalEndpointSide = winpipe.EndpointSideClient
		}},
		{name: "Executor on server endpoint", mutate: func(options *windowsVerificationOptions) {
			options.Role = config.RoleExecutor
		}},
		{name: "missing pipe observer", mutate: func(options *windowsVerificationOptions) { options.PipeObserver = nil }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newProductionFixture(config.RoleControl)
			test.mutate(&fixture.options)
			fixture.verification.events = nil
			_, err := verifyWindowsWithPlatform(fixture.options, fixture.platform)
			if !errors.Is(err, ErrInvalidOptions) {
				t.Fatalf("error = %v, want ErrInvalidOptions", err)
			}
			if len(fixture.verification.events) != 0 {
				t.Fatalf("invalid options reached platform: %v", fixture.verification.events)
			}
		})
	}
}

func TestPublicOptionsRejectRoleEndpointSideMismatchBeforePlatformUse(t *testing.T) {
	tests := []struct {
		name string
		role config.Role
		side winpipe.EndpointSide
	}{
		{name: "Control cannot use client endpoint", role: config.RoleControl, side: winpipe.EndpointSideClient},
		{name: "Executor cannot use server endpoint", role: config.RoleExecutor, side: winpipe.EndpointSideServer},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newProductionFixture(test.role)
			options := Options{
				Role:                                   test.role,
				WrapperImage:                           fixture.options.WrapperImage,
				ServiceHostImage:                       fixture.options.ServiceHostImage,
				ExpectedLeafSignerCertificateDERSHA256: fixture.options.ExpectedLeafSignerCertificateDERSHA256,
			}
			endpoint := &fakeProductionEndpoint{
				events:   &fixture.verification.events,
				observer: fixture.verification.observer,
				side:     test.side,
			}
			fixture.verification.events = nil
			_, err := verifyWindowsEndpoint(options, endpoint, fixture.platform)
			if !errors.Is(err, ErrInvalidOptions) {
				t.Fatalf("error = %v, want ErrInvalidOptions", err)
			}
			if !reflect.DeepEqual(fixture.verification.events, []string{"endpoint-side"}) {
				t.Fatalf("mismatched role reached platform or SCM: %v", fixture.verification.events)
			}
		})
	}
}

func TestPeerSCMObservationMustRemainRunningWithOnePID(t *testing.T) {
	tests := []struct {
		name          string
		observations  []scriptedServiceObservation
		mutateWrapper func(*fakeWrapper)
		wrapperOpened bool
	}{
		{
			name:         "stopped before open",
			observations: []scriptedServiceObservation{{value: serviceObservation{state: 1, processID: 100}}},
		},
		{
			name:         "paused before open",
			observations: []scriptedServiceObservation{{value: serviceObservation{state: 7, processID: 100}}},
		},
		{
			name:         "zero PID before open",
			observations: []scriptedServiceObservation{{value: serviceObservation{state: serviceStateRunning}}},
		},
		{
			name: "PID changes around open",
			observations: []scriptedServiceObservation{
				{value: serviceObservation{state: serviceStateRunning, processID: 100}},
				{value: serviceObservation{state: serviceStateRunning, processID: 101}},
			},
			wrapperOpened: true,
		},
		{
			name: "state changes around open",
			observations: []scriptedServiceObservation{
				{value: serviceObservation{state: serviceStateRunning, processID: 100}},
				{value: serviceObservation{state: 7, processID: 100}},
			},
			wrapperOpened: true,
		},
		{
			name: "wrapper handle PID differs",
			observations: []scriptedServiceObservation{
				{value: serviceObservation{state: serviceStateRunning, processID: 100}},
				{value: serviceObservation{state: serviceStateRunning, processID: 100}},
			},
			mutateWrapper: func(wrapper *fakeWrapper) { wrapper.processIDs = []uint32{101} },
			wrapperOpened: true,
		},
		{
			name: "wrapper handle is not active",
			observations: []scriptedServiceObservation{
				{value: serviceObservation{state: serviceStateRunning, processID: 100}},
				{value: serviceObservation{state: serviceStateRunning, processID: 100}},
			},
			mutateWrapper: func(wrapper *fakeWrapper) { wrapper.active = []bool{false} },
			wrapperOpened: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newProductionFixture(config.RoleControl)
			fixture.service.observations = test.observations
			if test.mutateWrapper != nil {
				test.mutateWrapper(fixture.verification.wrapper)
			}
			_, err := verifyWindowsWithPlatform(fixture.options, fixture.platform)
			if !errors.Is(err, ErrWrapperUnstable) {
				t.Fatalf("error = %v, want ErrWrapperUnstable", err)
			}
			wantWrapperClose := 0
			if test.wrapperOpened {
				wantWrapperClose = 1
			}
			if fixture.verification.wrapper.closeCount != wantWrapperClose || fixture.verification.peer.closeCount != 0 {
				t.Fatalf(
					"rejected close counts = wrapper %d peer %d, want %d and 0",
					fixture.verification.wrapper.closeCount,
					fixture.verification.peer.closeCount,
					wantWrapperClose,
				)
			}
			if fixture.service.closeCount != 1 {
				t.Fatalf("SCM status source close count = %d, want 1", fixture.service.closeCount)
			}
		})
	}
}

func TestProductionVerificationDetectsWrapperHandleChangeAfterSCMAcquisition(t *testing.T) {
	fixture := newProductionFixture(config.RoleControl)
	fixture.verification.wrapper.processIDs = []uint32{100, 101}
	_, err := verifyWindowsWithPlatform(fixture.options, fixture.platform)
	if !errors.Is(err, ErrWrapperUnstable) {
		t.Fatalf("error = %v, want ErrWrapperUnstable", err)
	}
	if fixture.verification.wrapper.closeCount != 1 || fixture.verification.peer.closeCount != 1 {
		t.Fatalf(
			"changed wrapper close counts = wrapper %d peer %d",
			fixture.verification.wrapper.closeCount,
			fixture.verification.peer.closeCount,
		)
	}
}

func TestProductionAcquisitionRetainsCleanupFailuresAndRetriesDiscardedOwners(t *testing.T) {
	t.Run("service open returns cleanup owner", func(t *testing.T) {
		fixture := newProductionFixture(config.RoleControl)
		openErr := errors.New("open service failed")
		fixture.platform.serviceErr = openErr
		_, err := verifyWindowsWithPlatform(fixture.options, fixture.platform)
		if !errors.Is(err, openErr) || fixture.service.closeCount != 1 {
			t.Fatalf("result = %v, service close count = %d", err, fixture.service.closeCount)
		}
	})

	t.Run("process open returns cleanup owner", func(t *testing.T) {
		fixture := newProductionFixture(config.RoleControl)
		openErr := errors.New("open process failed")
		fixture.platform.processes[100] = []processOpenResult{{process: fixture.verification.wrapper, err: openErr}}
		_, err := verifyWindowsWithPlatform(fixture.options, fixture.platform)
		if !errors.Is(err, openErr) || fixture.verification.wrapper.closeCount != 1 || fixture.service.closeCount != 1 {
			t.Fatalf(
				"result = %v, close counts wrapper=%d service=%d",
				err,
				fixture.verification.wrapper.closeCount,
				fixture.service.closeCount,
			)
		}
	})

	t.Run("SCM close retries before wrapper handoff", func(t *testing.T) {
		fixture := newProductionFixture(config.RoleControl)
		closeErr := errors.New("close SCM failed")
		fixture.service.closeErrors = []error{closeErr, nil}
		_, err := verifyWindowsWithPlatform(fixture.options, fixture.platform)
		if !errors.Is(err, closeErr) || fixture.service.closeCount != 2 || fixture.verification.wrapper.closeCount != 1 {
			t.Fatalf(
				"result = %v, close counts service=%d wrapper=%d",
				err,
				fixture.service.closeCount,
				fixture.verification.wrapper.closeCount,
			)
		}
		if fixture.verification.peer.closeCount != 0 {
			t.Fatalf("peer was opened after SCM cleanup failure")
		}
	})

	t.Run("rejected wrapper close retries", func(t *testing.T) {
		fixture := newProductionFixture(config.RoleControl)
		closeErr := errors.New("close wrapper failed")
		fixture.service.observations[1].value.processID = 101
		fixture.verification.wrapper.closeErrors = []error{closeErr, nil}
		_, err := verifyWindowsWithPlatform(fixture.options, fixture.platform)
		if !errors.Is(err, ErrWrapperUnstable) || !errors.Is(err, closeErr) ||
			fixture.verification.wrapper.closeCount != 2 {
			t.Fatalf("result = %v, wrapper close count = %d", err, fixture.verification.wrapper.closeCount)
		}
	})
}

func TestProductionSessionRetainsFailedWrapperCloseForExplicitRetry(t *testing.T) {
	fixture := newProductionFixture(config.RoleControl)
	session, err := verifyWindowsWithPlatform(fixture.options, fixture.platform)
	if err != nil {
		t.Fatal(err)
	}
	closeErr := errors.New("close retained wrapper failed")
	fixture.verification.wrapper.closeErrors = []error{closeErr, nil}
	if err := session.Close(); !errors.Is(err, closeErr) {
		t.Fatalf("first Session.Close error = %v", err)
	}
	if fixture.verification.wrapper.closeCount != 1 || fixture.verification.peer.closeCount != 1 {
		t.Fatalf(
			"first close counts = wrapper %d peer %d",
			fixture.verification.wrapper.closeCount,
			fixture.verification.peer.closeCount,
		)
	}
	if err := session.Close(); err != nil {
		t.Fatalf("retry Session.Close error = %v", err)
	}
	if fixture.verification.wrapper.closeCount != 2 || fixture.verification.peer.closeCount != 1 {
		t.Fatalf(
			"retry close counts = wrapper %d peer %d",
			fixture.verification.wrapper.closeCount,
			fixture.verification.peer.closeCount,
		)
	}
}

var _ windowsVerificationPlatform = (*fakeWindowsVerificationPlatform)(nil)
var _ productionPipeEndpoint = (*fakeProductionEndpoint)(nil)
