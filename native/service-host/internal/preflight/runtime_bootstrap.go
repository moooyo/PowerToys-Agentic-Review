package preflight

import (
	"encoding/hex"
	"fmt"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
)

// NewRuntimeBootstrapV1 derives one fresh zero-execution Node bootstrap from this finalized plan.
func (plan RuntimePlan) NewRuntimeBootstrapV1() (localrpc.RuntimeBootstrapV1, error) {
	if err := plan.Validate(); err != nil {
		return localrpc.RuntimeBootstrapV1{}, fmt.Errorf("build RuntimeBootstrapV1 from finalized plan: %w", err)
	}
	role, err := runtimeBootstrapRole(plan.Role())
	if err != nil {
		return localrpc.RuntimeBootstrapV1{}, err
	}
	configuration := plan.Configuration()
	releaseTemplateDigest := plan.ReleaseTemplateDigest()
	preflightDigest := plan.PreflightDigest()
	return localrpc.NewFoundationRuntimeBootstrap(localrpc.FoundationRuntimeBootstrapOptions{
		Role:                           role,
		WorkerNodeID:                   configuration.WorkerNodeID,
		ReleaseID:                      configuration.Installation.ReleaseID,
		ReleaseTemplateSHA256:          hex.EncodeToString(releaseTemplateDigest[:]),
		InstallationManifestSHA256:     configuration.Installation.ManifestSHA256,
		PreflightSHA256:                hex.EncodeToString(preflightDigest[:]),
		NodeBundleSHA256:               plan.Bundle().SHA256(),
		MaximumQueuedBytesPerDirection: int(configuration.Limits.MaximumQueuedBytesPerDirection),
		TotalShutdownTimeoutMS:         int(configuration.Limits.ShutdownTimeoutMilliseconds),
		ForceTerminationReserveMS:      int(configuration.Limits.ForceTerminationReserveMilliseconds),
	})
}

func runtimeBootstrapRole(role config.Role) (localrpc.Role, error) {
	switch role {
	case config.RoleControl:
		return localrpc.RoleControl, nil
	case config.RoleExecutor:
		return localrpc.RoleExecutor, nil
	default:
		return "", invalidEvidenceError("runtime bootstrap role is unsupported", nil)
	}
}
