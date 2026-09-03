package peerverify

import (
	"errors"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winpipe"
)

type fakeProductionEndpoint struct {
	*fakeObserver
	side winpipe.EndpointSide
}

func (endpoint fakeProductionEndpoint) LocalSide() (winpipe.EndpointSide, error) {
	return endpoint.side, nil
}

type fakeWindowsPlatform struct {
	localPID      uint32
	serviceName   string
	service       *fakeService
	processOpener fakeOpener
}

func (platform *fakeWindowsPlatform) CurrentProcessID() uint32 { return platform.localPID }
func (platform *fakeWindowsPlatform) OpenPeerService(name string) (serviceStatusSource, error) {
	platform.serviceName = name
	return platform.service, nil
}
func (platform *fakeWindowsPlatform) OpenProcess(pid uint32) (PeerProcess, error) {
	return platform.processOpener.OpenProcess(pid)
}

func TestVerifyWindowsEndpointMapsRoleToFixedServiceAndPipeSide(t *testing.T) {
	for _, test := range []struct {
		name        string
		role        config.Role
		side        winpipe.EndpointSide
		peerService string
		peerSID     string
		pipePeer    PipePeer
	}{
		{"Control", config.RoleControl, winpipe.EndpointSideServer, config.ExecutorServiceName, config.ExecutorServiceSID, PipePeerClient},
		{"Executor", config.RoleExecutor, winpipe.EndpointSideClient, config.ControlServiceName, config.ControlServiceSID, PipePeerServer},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newVerificationFixture(test.pipePeer)
			fixture.process.snapshot = validTokenSnapshotForSID(test.peerSID)
			endpoint := fakeProductionEndpoint{fakeObserver: fixture.observer, side: test.side}
			platform := &fakeWindowsPlatform{
				localPID: 100, service: fixture.service, processOpener: fixture.opener,
			}
			session, err := verifyWindowsEndpoint(productionOptions{Role: test.role}, endpoint, platform)
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			if platform.serviceName != test.peerService || fixture.service.closed != 1 {
				t.Fatalf("service = %q, close count = %d", platform.serviceName, fixture.service.closed)
			}
		})
	}
}

func TestVerifyWindowsEndpointRejectsWrongLocalPipeSide(t *testing.T) {
	fixture := newVerificationFixture(PipePeerClient)
	endpoint := fakeProductionEndpoint{fakeObserver: fixture.observer, side: winpipe.EndpointSideClient}
	platform := &fakeWindowsPlatform{localPID: 100, service: fixture.service, processOpener: fixture.opener}
	session, err := verifyWindowsEndpoint(productionOptions{Role: config.RoleControl}, endpoint, platform)
	if session != nil || !errors.Is(err, ErrInvalidOptions) {
		t.Fatalf("result = (%v, %v)", session, err)
	}
}
