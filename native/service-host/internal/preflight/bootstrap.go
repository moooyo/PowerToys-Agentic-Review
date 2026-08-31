package preflight

import (
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/servicebootstrap"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winidentity"
)

func captureBootstrapBinding(
	source servicebootstrap.Evidence,
	expectedDigest [32]byte,
	installation *installationSnapshot,
) (BootstrapBinding, error) {
	if err := source.Validate(); err != nil {
		return BootstrapBinding{}, preflightError(ErrorServiceBootstrap, "service bootstrap evidence is invalid", err)
	}
	digest, err := source.Digest()
	if err != nil || digest == ([32]byte{}) || digest != expectedDigest {
		return BootstrapBinding{}, preflightError(ErrorServiceBootstrap, "service bootstrap digest changed during capture", err)
	}
	options := source.Options()
	current := installation.controlConfig
	if installation.role == config.RoleExecutor {
		current = installation.executorConfig
	}
	binding := BootstrapBinding{
		role:                 installation.role,
		ownServiceName:       options.ServiceName,
		ownServiceSID:        options.OwnServiceSID,
		peerServiceName:      current.PeerService.Name,
		peerServiceSID:       options.PeerServiceSID,
		serviceHostProcessID: source.StableServiceHostFacts().ProcessID,
		sourceDigest:         digest,
		bound:                true,
	}
	if err := validateBootstrapBinding(
		binding,
		installation.role,
		installation.controlConfig,
		installation.executorConfig,
		installation.identity,
	); err != nil {
		return BootstrapBinding{}, err
	}
	return binding, nil
}

func validateBootstrapBinding(
	binding BootstrapBinding,
	role config.Role,
	control config.Config,
	executor config.Config,
	identity winidentity.Evidence,
) error {
	current := control
	if role == config.RoleExecutor {
		current = executor
	} else if role != config.RoleControl {
		return preflightError(ErrorServiceBootstrap, "service bootstrap role is unsupported", nil)
	}
	expectedOwn := config.ServiceIdentity{Name: config.ControlServiceName, SID: config.ControlServiceSID}
	expectedPeer := config.ServiceIdentity{Name: config.ExecutorServiceName, SID: config.ExecutorServiceSID}
	if role == config.RoleExecutor {
		expectedOwn, expectedPeer = expectedPeer, expectedOwn
	}
	if !binding.bound || binding.sourceDigest == ([32]byte{}) || binding.serviceHostProcessID == 0 {
		return preflightError(ErrorServiceBootstrap, "service bootstrap binding is empty", nil)
	}
	if binding.role != role || current.Role != role || current.OwnService != expectedOwn ||
		current.PeerService != expectedPeer {
		return preflightError(ErrorServiceBootstrap, "service bootstrap role or fixed service identities differ", nil)
	}
	if binding.ownServiceName != current.OwnService.Name ||
		binding.ownServiceSID != current.OwnService.SID ||
		binding.peerServiceName != current.PeerService.Name ||
		binding.peerServiceSID != current.PeerService.SID {
		return preflightError(ErrorServiceBootstrap, "service bootstrap options differ from the selected configuration", nil)
	}
	if identity.OwnService.Name != current.OwnService.Name ||
		identity.OwnService.SID != current.OwnService.SID ||
		identity.PeerService.Name != current.PeerService.Name ||
		identity.PeerService.SID != current.PeerService.SID {
		return preflightError(ErrorServiceBootstrap, "service bootstrap options differ from installation identity", nil)
	}
	if binding.serviceHostProcessID != identity.ProcessID {
		return preflightError(ErrorServiceBootstrap, "service bootstrap ServiceHost PID differs from installation identity", nil)
	}
	return nil
}
