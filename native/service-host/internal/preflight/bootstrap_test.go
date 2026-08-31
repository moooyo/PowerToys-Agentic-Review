package preflight

import (
	"errors"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
)

func TestBootstrapBindingMatchesSelectedRoleConfigurationAndInstallationIdentity(t *testing.T) {
	for _, role := range []config.Role{config.RoleControl, config.RoleExecutor} {
		t.Run(string(role), func(t *testing.T) {
			fixture := newCompositionFixture(t, role)
			evidence, err := composeSnapshots(fixture.input)
			if err != nil {
				t.Fatal(err)
			}
			binding, exists := evidence.BootstrapBinding()
			if !exists {
				t.Fatal("Evidence omitted service bootstrap binding")
			}
			current := evidence.Configuration()
			if binding.Role() != role || binding.OwnServiceName() != current.OwnService.Name ||
				binding.OwnServiceSID() != current.OwnService.SID ||
				binding.PeerServiceName() != current.PeerService.Name ||
				binding.PeerServiceSID() != current.PeerService.SID ||
				binding.ServiceHostProcessID() != evidence.Identity().ProcessID ||
				binding.SourceDigest() != fixture.input.bootstrap.sourceDigest {
				t.Fatalf("unexpected bootstrap binding: %#v", binding)
			}
		})
	}
}

func TestBootstrapBindingRejectsZeroAndEveryCrossBindingMismatch(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleControl)
	tests := []struct {
		name   string
		mutate func(*compositionFixture)
	}{
		{"zero", func(value *compositionFixture) { value.input.bootstrap = BootstrapBinding{} }},
		{"unbound", func(value *compositionFixture) { value.input.bootstrap.bound = false }},
		{"role", func(value *compositionFixture) { value.input.bootstrap.role = config.RoleExecutor }},
		{"own service name", func(value *compositionFixture) { value.input.bootstrap.ownServiceName += ".Other" }},
		{"own service SID", func(value *compositionFixture) { value.input.bootstrap.ownServiceSID = config.ExecutorServiceSID }},
		{"peer service name", func(value *compositionFixture) { value.input.bootstrap.peerServiceName += ".Other" }},
		{"peer service SID", func(value *compositionFixture) { value.input.bootstrap.peerServiceSID = config.ControlServiceSID }},
		{"zero PID", func(value *compositionFixture) { value.input.bootstrap.serviceHostProcessID = 0 }},
		{"wrong PID", func(value *compositionFixture) { value.input.bootstrap.serviceHostProcessID++ }},
		{"zero source digest", func(value *compositionFixture) { value.input.bootstrap.sourceDigest = [32]byte{} }},
		{"installation own name", func(value *compositionFixture) { value.installation.identity.OwnService.Name += ".Other" }},
		{"installation own SID", func(value *compositionFixture) {
			value.installation.identity.OwnService.SID = config.ExecutorServiceSID
		}},
		{"installation peer name", func(value *compositionFixture) { value.installation.identity.PeerService.Name += ".Other" }},
		{"installation peer SID", func(value *compositionFixture) {
			value.installation.identity.PeerService.SID = config.ControlServiceSID
		}},
		{"installation PID", func(value *compositionFixture) { value.installation.identity.ProcessID++ }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := newCompositionFixture(t, config.RoleControl)
			test.mutate(&candidate)
			_, err := composeSnapshots(candidate.input)
			assertPreflightErrorCode(t, err, ErrorServiceBootstrap)
		})
	}

	if err := validateBootstrapBinding(
		fixture.input.bootstrap,
		config.RoleControl,
		fixture.control,
		fixture.executor,
		fixture.installation.identity,
	); err != nil {
		t.Fatalf("valid bootstrap binding rejected: %v", err)
	}
}

func TestBootstrapBindingGetterIsCopyOnlyAndEvidenceMutationIsRejected(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleExecutor)
	evidence, err := composeSnapshots(fixture.input)
	if err != nil {
		t.Fatal(err)
	}
	binding, exists := evidence.BootstrapBinding()
	if !exists {
		t.Fatal("Evidence omitted service bootstrap binding")
	}
	originalDigest := binding.SourceDigest()
	binding.ownServiceName = "mutated"
	binding.sourceDigest[0] ^= 0xff
	again, exists := evidence.BootstrapBinding()
	if !exists || again.OwnServiceName() == "mutated" || again.SourceDigest() != originalDigest {
		t.Fatal("BootstrapBinding getter exposed mutable evidence storage")
	}

	candidate := cloneEvidenceForDigestTest(evidence)
	candidate.bootstrap.serviceHostProcessID++
	if err := candidate.Validate(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("mutated bootstrap Evidence.Validate = %v", err)
	}
}
