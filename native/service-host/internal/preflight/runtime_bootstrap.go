package preflight

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
)

// NewRuntimeBootstrapV1 derives one fresh zero-execution Node bootstrap from this finalized plan.
func (plan RuntimePlan) NewRuntimeBootstrapV1() (localrpc.RuntimeBootstrapV1, error) {
	if err := plan.Validate(); err != nil {
		return localrpc.RuntimeBootstrapV1{}, fmt.Errorf("build RuntimeBootstrapV1 from finalized plan: %w", err)
	}
	return localrpc.NewFoundationRuntimeBootstrap(
		cloneRuntimeBootstrapAuthority(plan.bootstrapAuthority).options,
	)
}

// RuntimeBootstrapAuthority returns an opaque copy of the exact bootstrap
// facts derived from this evidence. It never exposes the contained options.
func (e Evidence) RuntimeBootstrapAuthority() (RuntimeBootstrapAuthority, error) {
	if err := e.Validate(); err != nil {
		return RuntimeBootstrapAuthority{}, err
	}
	authority, err := newRuntimeBootstrapAuthority(e, e.Configuration())
	if err != nil {
		return RuntimeBootstrapAuthority{}, err
	}
	return cloneRuntimeBootstrapAuthority(authority), nil
}

// Validate rejects a zero or internally inconsistent bootstrap authority.
func (authority RuntimeBootstrapAuthority) Validate() error {
	options := authority.options
	if !authority.valid || !validSHA256(options.ReleaseTemplateSHA256) ||
		!validSHA256(options.InstallationManifestSHA256) ||
		!validSHA256(options.PreflightSHA256) || !validSHA256(options.NodeBundleSHA256) ||
		!validSHA256(options.ExecutorPolicySHA256) ||
		options.WorkerNodeID == "" || options.ReleaseID == "" ||
		options.MaximumQueuedBytesPerDirection < localrpc.RuntimeBootstrapARWXMinimumQueuedBytes ||
		options.MaximumQueuedBytesPerDirection > localrpc.RuntimeBootstrapARWXMaximumQueuedBytes ||
		options.TotalShutdownTimeoutMS < localrpc.RuntimeBootstrapMinimumGracefulTimeoutMS ||
		options.TotalShutdownTimeoutMS > localrpc.RuntimeBootstrapMaximumGracefulTimeoutMS ||
		options.ForceTerminationReserveMS < localrpc.RuntimeBootstrapMinimumForceTerminationReserve ||
		options.ForceTerminationReserveMS >= options.TotalShutdownTimeoutMS {
		return invalidEvidenceError("runtime bootstrap authority is empty or incomplete", nil)
	}
	if options.Role != localrpc.RoleControl && options.Role != localrpc.RoleExecutor {
		return invalidEvidenceError("runtime bootstrap authority role is unsupported", nil)
	}
	return nil
}

// Matches reports whether two validated opaque authorities contain exactly
// the same immutable facts.
func (authority RuntimeBootstrapAuthority) Matches(other RuntimeBootstrapAuthority) bool {
	return authority.Validate() == nil && other.Validate() == nil &&
		reflectRuntimeBootstrapOptionsEqual(authority.options, other.options)
}

// Copy returns a detached authority value without exposing its private facts.
func (authority RuntimeBootstrapAuthority) Copy() RuntimeBootstrapAuthority {
	return cloneRuntimeBootstrapAuthority(authority)
}

// FoundationOptionsForLaunch returns a detached, non-authorizing fact copy.
// Architecture tests restrict its sole production consumer to launchguard.
func (authority RuntimeBootstrapAuthority) FoundationOptionsForLaunch() (
	localrpc.FoundationRuntimeBootstrapOptions,
	error,
) {
	if err := authority.Validate(); err != nil {
		var empty localrpc.FoundationRuntimeBootstrapOptions
		return empty, err
	}
	return cloneRuntimeBootstrapAuthority(authority).options, nil
}

func newRuntimeBootstrapAuthority(
	e Evidence,
	configuration config.Config,
) (RuntimeBootstrapAuthority, error) {
	role, err := runtimeBootstrapRole(e.role)
	if err != nil {
		return RuntimeBootstrapAuthority{}, err
	}
	executor := e.executor.Configuration.Executor
	if executor == nil {
		return RuntimeBootstrapAuthority{}, invalidEvidenceError(
			"runtime bootstrap trust configuration is incomplete",
			nil,
		)
	}
	options := localrpc.FoundationRuntimeBootstrapOptions{
		Role:                           role,
		WorkerNodeID:                   configuration.WorkerNodeID,
		ReleaseID:                      configuration.Installation.ReleaseID,
		ReleaseTemplateSHA256:          hex.EncodeToString(e.release.templateDigest[:]),
		InstallationManifestSHA256:     configuration.Installation.ManifestSHA256,
		PreflightSHA256:                hex.EncodeToString(e.digest[:]),
		NodeBundleSHA256:               configuration.Node.BundleSHA256,
		ExecutorPolicySHA256:           executor.CodexPolicySHA256,
		MaximumQueuedBytesPerDirection: int(configuration.Limits.MaximumQueuedBytesPerDirection),
		TotalShutdownTimeoutMS:         int(configuration.Limits.ShutdownTimeoutMilliseconds),
		ForceTerminationReserveMS:      int(configuration.Limits.ForceTerminationReserveMilliseconds),
	}
	authority := RuntimeBootstrapAuthority{options: options, valid: true}
	if err := authority.Validate(); err != nil {
		return RuntimeBootstrapAuthority{}, err
	}
	return cloneRuntimeBootstrapAuthority(authority), nil
}

func (authority RuntimeBootstrapAuthority) validateFor(plan RuntimePlan) error {
	if err := authority.Validate(); err != nil {
		return err
	}
	configuration := plan.configuration
	role, err := runtimeBootstrapRole(plan.role)
	if err != nil {
		return err
	}
	releaseDigest := hex.EncodeToString(plan.releaseTemplateDigest[:])
	preflightDigest := hex.EncodeToString(plan.preflightDigest[:])
	options := authority.options
	if options.Role != role || options.WorkerNodeID != configuration.WorkerNodeID ||
		options.ReleaseID != configuration.Installation.ReleaseID ||
		options.ReleaseTemplateSHA256 != releaseDigest ||
		options.InstallationManifestSHA256 != configuration.Installation.ManifestSHA256 ||
		options.PreflightSHA256 != preflightDigest ||
		options.NodeBundleSHA256 != plan.bundle.sha256 ||
		options.ExecutorPolicySHA256 != plan.bootstrapTrust.executorPolicySHA256 ||
		options.MaximumQueuedBytesPerDirection != int(configuration.Limits.MaximumQueuedBytesPerDirection) ||
		options.TotalShutdownTimeoutMS != int(configuration.Limits.ShutdownTimeoutMilliseconds) ||
		options.ForceTerminationReserveMS != int(configuration.Limits.ForceTerminationReserveMilliseconds) {
		return invalidEvidenceError("runtime bootstrap authority differs from its runtime plan", nil)
	}
	return nil
}

func (plan RuntimePlan) validateRuntimeBootstrapTrust() error {
	trust := plan.bootstrapTrust
	if !validSHA256(trust.executorPolicySHA256) {
		return invalidEvidenceError("runtime bootstrap trust digests are invalid", nil)
	}
	switch plan.role {
	case config.RoleControl:
		if plan.configuration.Control == nil {
			return invalidEvidenceError("Control bootstrap configuration is unavailable", nil)
		}
	case config.RoleExecutor:
		executor := plan.configuration.Executor
		if executor == nil || executor.CodexPolicySHA256 != trust.executorPolicySHA256 {
			return invalidEvidenceError("Executor bootstrap trust differs from configuration", nil)
		}
		policy, err := selectExecutorPolicy(plan.runtimeContents, executor)
		if err != nil || !runtimeContentDigestMatches(policy, trust.executorPolicySHA256) {
			return invalidEvidenceError("Executor bootstrap policy content is invalid", err)
		}
	default:
		return invalidEvidenceError("runtime bootstrap trust role is unsupported", nil)
	}
	return nil
}

func selectExecutorPolicy(
	contents []VerifiedRuntimeContent,
	executor *config.ExecutorConfiguration,
) ([]byte, error) {
	var policy []byte
	matches := 0
	for _, content := range contents {
		if content.role != releasemanifest.RolePolicy ||
			!windowsPathEqual(content.absolutePath, executor.CodexPolicyPath) ||
			content.sha256 != executor.CodexPolicySHA256 {
			continue
		}
		policy = content.Bytes()
		matches++
	}
	if matches != 1 || len(policy) == 0 {
		return nil, invalidEvidenceError("Executor runtime bootstrap lacks one exact policy", nil)
	}
	return policy, nil
}

func runtimeContentDigestMatches(content []byte, expected string) bool {
	digest := sha256.Sum256(content)
	return subtle.ConstantTimeCompare(
		[]byte(hex.EncodeToString(digest[:])),
		[]byte(expected),
	) == 1
}

func reflectRuntimeBootstrapOptionsEqual(
	left localrpc.FoundationRuntimeBootstrapOptions,
	right localrpc.FoundationRuntimeBootstrapOptions,
) bool {
	return left.Role == right.Role && left.WorkerNodeID == right.WorkerNodeID &&
		left.ReleaseID == right.ReleaseID &&
		left.ReleaseTemplateSHA256 == right.ReleaseTemplateSHA256 &&
		left.InstallationManifestSHA256 == right.InstallationManifestSHA256 &&
		left.PreflightSHA256 == right.PreflightSHA256 &&
		left.NodeBundleSHA256 == right.NodeBundleSHA256 &&
		left.ExecutorPolicySHA256 == right.ExecutorPolicySHA256 &&
		left.MaximumQueuedBytesPerDirection == right.MaximumQueuedBytesPerDirection &&
		left.TotalShutdownTimeoutMS == right.TotalShutdownTimeoutMS &&
		left.ForceTerminationReserveMS == right.ForceTerminationReserveMS
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
