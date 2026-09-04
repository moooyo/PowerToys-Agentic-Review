package launchguard

import (
	"crypto/sha256"
	"reflect"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/preflight"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
)

func captureAuthority(
	evidence preflight.Evidence,
	plan preflight.RuntimePlan,
) (authoritySnapshot, error) {
	before, err := captureAuthorityOnce(evidence, plan)
	if err != nil {
		return authoritySnapshot{}, err
	}
	after, err := captureAuthorityOnce(evidence, plan)
	if err != nil {
		return authoritySnapshot{}, err
	}
	if !reflect.DeepEqual(before, after) {
		return authoritySnapshot{}, authorityError("preflight launch authority changed during capture", nil)
	}
	return cloneAuthority(after), nil
}

func validateAuthoritySnapshot(value authoritySnapshot) error {
	if value.role != config.RoleControl && value.role != config.RoleExecutor ||
		value.configuration.Role != value.role || value.preflightDigest == ([32]byte{}) ||
		value.releaseDigest == ([32]byte{}) || !validBootstrapOptions(value) ||
		value.root.Root != releasemanifest.RootInstallation || value.root.Path == "" ||
		len(value.root.Ancestors) == 0 || !validSHA256(value.signerPin) {
		return authorityError("captured launch authority is empty or inconsistent", nil)
	}
	wantCount := 2
	if value.role == config.RoleExecutor {
		wantCount = 3
	}
	if len(value.targets) != wantCount {
		return authorityError("captured launch target count differs from the role", nil)
	}
	seen := make(map[targetKind]struct{}, wantCount)
	for _, target := range value.targets {
		if _, duplicate := seen[target.kind]; duplicate {
			return authorityError("captured launch authority repeats a target kind", nil)
		}
		seen[target.kind] = struct{}{}
		expectedPath := value.configuration.Node.ExecutablePath
		expectedDigest := value.configuration.Node.ExecutableSHA256
		switch target.kind {
		case targetBundle:
			expectedPath = value.configuration.Node.BundlePath
			expectedDigest = value.configuration.Node.BundleSHA256
		case targetProcessHost:
			if value.role != config.RoleExecutor || value.configuration.Executor == nil {
				return authorityError("captured ProcessHost target is not Executor-local", nil)
			}
			expectedPath = value.configuration.Executor.ProcessHostPath
			expectedDigest = value.configuration.Executor.ProcessHostSHA256
		case targetNode:
		default:
			return authorityError("captured launch target kind is unknown", nil)
		}
		if target.file.Root != releasemanifest.RootInstallation ||
			target.file.Role != expectedRole(target.kind, value.role) ||
			!strings.EqualFold(target.file.AbsolutePath, expectedPath) ||
			target.file.SHA256 != expectedDigest || target.file.Size == 0 ||
			target.file.Object.Path != target.file.AbsolutePath {
			return authorityError("captured launch target differs from its role configuration", nil)
		}
	}
	if _, ok := seen[targetNode]; !ok {
		return authorityError("captured launch authority omits Node", nil)
	}
	if _, ok := seen[targetBundle]; !ok {
		return authorityError("captured launch authority omits the role bundle", nil)
	}
	if value.role == config.RoleExecutor {
		if _, ok := seen[targetProcessHost]; !ok {
			return authorityError("captured launch authority omits ProcessHost", nil)
		}
	}
	return nil
}

func captureAuthorityOnce(
	evidence preflight.Evidence,
	plan preflight.RuntimePlan,
) (authoritySnapshot, error) {
	if err := evidence.Validate(); err != nil {
		return authoritySnapshot{}, authorityError("preflight evidence is invalid", err)
	}
	digest, err := evidence.Digest()
	if err != nil || digest == ([sha256.Size]byte{}) {
		return authoritySnapshot{}, authorityError("preflight evidence digest is unavailable", err)
	}
	if err := plan.Validate(); err != nil {
		return authoritySnapshot{}, authorityError("runtime plan is invalid", err)
	}
	if plan.PreflightDigest() != digest || plan.Role() != evidence.Role() {
		return authoritySnapshot{}, authorityError("runtime plan does not derive from the supplied preflight evidence", nil)
	}
	configuration := evidence.Configuration()
	if !reflect.DeepEqual(configuration, plan.Configuration()) || configuration.Role != evidence.Role() {
		return authoritySnapshot{}, authorityError("runtime plan configuration differs from preflight evidence", nil)
	}
	evidenceBootstrapAuthority, err := evidence.RuntimeBootstrapAuthority()
	if err != nil {
		return authoritySnapshot{}, authorityError("derive preflight bootstrap authority", err)
	}
	planBootstrapAuthority := plan.RuntimeBootstrapAuthority()
	if !evidenceBootstrapAuthority.Matches(planBootstrapAuthority) {
		return authoritySnapshot{}, authorityError("runtime plan bootstrap authority differs from preflight evidence", nil)
	}
	bootstrapOptions, err := planBootstrapAuthority.FoundationOptionsForLaunch()
	if err != nil {
		return authoritySnapshot{}, authorityError("copy runtime bootstrap launch facts", err)
	}

	root, err := selectInstallationRoot(evidence.Roots())
	if err != nil {
		return authoritySnapshot{}, err
	}
	targets, err := selectLaunchTargets(configuration.Role, plan, evidence.Files())
	if err != nil {
		return authoritySnapshot{}, err
	}
	signerPin := evidence.ApprovedSignerCertificateDERSHA256()
	if !validSHA256(signerPin) {
		return authoritySnapshot{}, authorityError("compiled Authenticode signer pin is invalid", nil)
	}
	return authoritySnapshot{
		role: configuration.Role, configuration: cloneConfig(configuration),
		preflightDigest: digest, releaseDigest: plan.ReleaseTemplateDigest(),
		bootstrapOptions: bootstrapOptions,
		root:             cloneRoot(root), targets: targets, signerPin: signerPin,
	}, nil
}

func validBootstrapOptions(value authoritySnapshot) bool {
	options := value.bootstrapOptions
	expectedRole, err := launchRuntimeBootstrapRole(value.role)
	if err != nil || options.Role != expectedRole ||
		options.WorkerNodeID != value.configuration.WorkerNodeID ||
		options.MaximumQueuedBytesPerDirection != int(value.configuration.Limits.MaximumQueuedBytesPerDirection) ||
		options.TotalShutdownTimeoutMS != int(value.configuration.Limits.ShutdownTimeoutMilliseconds) ||
		options.ForceTerminationReserveMS != int(value.configuration.Limits.ForceTerminationReserveMilliseconds) {
		return false
	}
	if value.role == config.RoleControl {
		return value.configuration.Control != nil
	}
	if value.configuration.Executor == nil {
		return false
	}
	return true
}

func selectInstallationRoot(values []preflight.VerifiedRoot) (preflight.VerifiedRoot, error) {
	var result preflight.VerifiedRoot
	count := 0
	for _, root := range values {
		if root.Root != releasemanifest.RootInstallation {
			continue
		}
		result = cloneRoot(root)
		count++
	}
	if count != 1 || result.Path == "" || len(result.Ancestors) == 0 {
		return preflight.VerifiedRoot{}, authorityError("preflight must contain exactly one installation root with ancestors", nil)
	}
	return result, nil
}

func selectLaunchTargets(
	role config.Role,
	plan preflight.RuntimePlan,
	files []preflight.VerifiedFile,
) ([]launchTarget, error) {
	if role != config.RoleControl && role != config.RoleExecutor {
		return nil, authorityError("launch role is unsupported", nil)
	}
	requirements := []struct {
		kind   targetKind
		pinned preflight.PinnedRuntimeFile
	}{
		{kind: targetNode, pinned: plan.Node()},
		{kind: targetBundle, pinned: plan.Bundle()},
	}
	processHost, hasProcessHost := plan.ProcessHost()
	if role == config.RoleExecutor {
		if !hasProcessHost {
			return nil, authorityError("Executor runtime plan omits ProcessHost", nil)
		}
		requirements = append(requirements, struct {
			kind   targetKind
			pinned preflight.PinnedRuntimeFile
		}{kind: targetProcessHost, pinned: processHost})
	} else if hasProcessHost {
		return nil, authorityError("Control runtime plan contains ProcessHost", nil)
	}

	result := make([]launchTarget, 0, len(requirements))
	seenIdentity := make(map[string]struct{}, len(requirements))
	seenPath := make(map[string]struct{}, len(requirements))
	for _, requirement := range requirements {
		var selected preflight.VerifiedFile
		count := 0
		for _, file := range files {
			if file.Root == releasemanifest.RootInstallation &&
				strings.EqualFold(file.AbsolutePath, requirement.pinned.Path()) &&
				file.Role == expectedRole(requirement.kind, role) &&
				file.SHA256 == requirement.pinned.SHA256() {
				selected = cloneFile(file)
				count++
			}
		}
		if count != 1 || selected.Object.Path != selected.AbsolutePath || selected.Size == 0 {
			return nil, authorityError("runtime plan target lacks one exact verified installation file", nil)
		}
		pathKey := strings.ToLower(selected.AbsolutePath)
		identity := selected.Object.Evidence.Identity
		identityKey := fmt.Sprintf("%016x:%x", identity.VolumeSerialNumber, identity.FileID)
		if _, duplicate := seenPath[pathKey]; duplicate {
			return nil, authorityError("runtime plan reuses one launch path", nil)
		}
		if _, duplicate := seenIdentity[identityKey]; duplicate {
			return nil, authorityError("runtime plan reuses one launch file identity", nil)
		}
		seenPath[pathKey] = struct{}{}
		seenIdentity[identityKey] = struct{}{}
		result = append(result, launchTarget{kind: requirement.kind, file: selected})
	}
	return result, nil
}

func validSHA256(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			if character < 'a' || character > 'f' {
				return false
			}
		}
	}
	return true
}

func authorityError(message string, cause error) error {
	if cause != nil {
		return fmt.Errorf("%w: %s: %w", ErrInvalidAuthority, message, cause)
	}
	return fmt.Errorf("%w: %s", ErrInvalidAuthority, message)
}
