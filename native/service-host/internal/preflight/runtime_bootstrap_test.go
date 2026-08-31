package preflight

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
)

var testRuntimeBootstrapUUIDV4 = regexp.MustCompile(
	`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
)

func TestRuntimePlanBuildsRoleBoundFoundationBootstrap(t *testing.T) {
	tests := []struct {
		role       config.Role
		localRole  localrpc.Role
		roleConfig []byte
	}{
		{
			role:       config.RoleControl,
			localRole:  localrpc.RoleControl,
			roleConfig: []byte(`{"executionEnabled":false,"foundationVersion":1,"role":"control"}`),
		},
		{
			role:       config.RoleExecutor,
			localRole:  localrpc.RoleExecutor,
			roleConfig: []byte(`{"executionEnabled":false,"foundationVersion":1,"role":"executor"}`),
		},
	}
	for _, test := range tests {
		t.Run(string(test.role), func(t *testing.T) {
			fixture := newCompositionFixture(t, test.role)
			evidence, err := composeSnapshots(fixture.input)
			if err != nil {
				t.Fatal(err)
			}
			root := &fakeDataRootLifecycle{}
			plan, err := finalizeRuntimePlan(
				context.Background(),
				evidence,
				cloneDataRootBinding(evidence.dataRoot),
				root,
			)
			if err != nil {
				t.Fatal(err)
			}
			bootstrap, err := plan.NewRuntimeBootstrapV1()
			if err != nil {
				t.Fatal(err)
			}
			configuration := plan.Configuration()
			templateDigest := plan.ReleaseTemplateDigest()
			preflightDigest := plan.PreflightDigest()
			if bootstrap.Role != test.localRole ||
				bootstrap.WorkerNodeID != configuration.WorkerNodeID ||
				bootstrap.ReleaseID != configuration.Installation.ReleaseID ||
				bootstrap.ReleaseTemplateSHA256 != hex.EncodeToString(templateDigest[:]) ||
				bootstrap.InstallationManifestSHA256 != configuration.Installation.ManifestSHA256 ||
				bootstrap.PreflightSHA256 != hex.EncodeToString(preflightDigest[:]) ||
				bootstrap.NodeBundleSHA256 != plan.Bundle().SHA256() {
				t.Fatalf("bootstrap facts differ from finalized plan: %#v", bootstrap)
			}
			if !testRuntimeBootstrapUUIDV4.MatchString(bootstrap.BootstrapID) {
				t.Fatalf("bootstrapId = %q", bootstrap.BootstrapID)
			}
			if bootstrap.ARWX.MaximumQueuedBytesPerDirection !=
				int(configuration.Limits.MaximumQueuedBytesPerDirection) ||
				bootstrap.Shutdown.GracefulTimeoutMS !=
					int(configuration.Limits.ShutdownTimeoutMilliseconds) ||
				bootstrap.Shutdown.ForceTerminationReserveMS !=
					int(configuration.Limits.ForceTerminationReserveMilliseconds) {
				t.Fatalf("bootstrap limits differ from finalized plan: %#v", bootstrap)
			}
			if !bytes.Equal(bootstrap.RoleConfigJSON(), test.roleConfig) {
				t.Fatalf("roleConfig = %s, want %s", bootstrap.RoleConfigJSON(), test.roleConfig)
			}
			roleConfigDigest := sha256.Sum256(test.roleConfig)
			if bootstrap.RoleConfig.ByteLength != len(test.roleConfig) ||
				bootstrap.RoleConfig.SHA256 != hex.EncodeToString(roleConfigDigest[:]) {
				t.Fatalf("roleConfig descriptor = %#v", bootstrap.RoleConfig)
			}
		})
	}
}

func TestRuntimePlanBootstrapRejectsInvalidAuthority(t *testing.T) {
	if _, err := (RuntimePlan{}).NewRuntimeBootstrapV1(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("zero RuntimePlan error = %v", err)
	}
	fixture := newCompositionFixture(t, config.RoleControl)
	evidence, err := composeSnapshots(fixture.input)
	if err != nil {
		t.Fatal(err)
	}
	plan := evidence.RuntimePlanMustForTest(t)
	plan.releaseTemplateDigest = [32]byte{}
	if _, err := plan.NewRuntimeBootstrapV1(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("missing release template digest error = %v", err)
	}
	if _, err := runtimeBootstrapRole(config.Role("other")); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("unknown role error = %v", err)
	}
}
