package preflight

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/dataroot"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

func runtimeContentTargetsFor(
	role config.Role,
	controlConfig config.Config,
	executorConfig config.Config,
) ([]runtimeContentTarget, error) {
	switch role {
	case config.RoleControl:
		if controlConfig.Control == nil {
			return nil, preflightError(ErrorRuntimeContent, "Control content configuration is absent", nil)
		}
		control := controlConfig.Control
		return []runtimeContentTarget{{
			path: control.RootCertificatePath, role: releasemanifest.RoleCABundle,
			sha256: control.RootCertificateSHA256,
		}}, nil
	case config.RoleExecutor:
		if executorConfig.Executor == nil {
			return nil, preflightError(ErrorRuntimeContent, "Executor content configuration is absent", nil)
		}
		executor := executorConfig.Executor
		return []runtimeContentTarget{{
			path: executor.CodexPolicyPath, role: releasemanifest.RolePolicy,
			sha256: executor.CodexPolicySHA256,
		}}, nil
	default:
		return nil, preflightError(ErrorRuntimeContent, "runtime content role is unsupported", nil)
	}
}

func validateDataRootBinding(
	binding DataRootBinding,
	role config.Role,
	controlConfig config.Config,
	executorConfig config.Config,
	roots []VerifiedRoot,
) error {
	current := controlConfig
	peer := executorConfig
	if role == config.RoleExecutor {
		current, peer = peer, current
	}
	if !binding.bound || binding.digest == ([32]byte{}) || binding.role != role ||
		binding.currentPath != current.Node.DataRoot || binding.peerPath != peer.Node.DataRoot ||
		binding.peerObservation != dataroot.PeerLiveRootNotObservedByDesign {
		return preflightError(ErrorDataRoot, "data-root binding is absent or inconsistent", nil)
	}
	return validateDataRootInstallationBindings(binding.installationRoots, roots)
}

func validateRuntimeContents(
	role config.Role,
	controlConfig config.Config,
	executorConfig config.Config,
	contents []VerifiedRuntimeContent,
	bindings []FileBindingEvidence,
) ([]VerifiedRuntimeContent, error) {
	targets, err := runtimeContentTargetsFor(role, controlConfig, executorConfig)
	if err != nil {
		return nil, err
	}
	if len(contents) != len(targets) {
		return nil, preflightError(ErrorRuntimeContent, "role-scoped runtime content count is invalid", nil)
	}
	trustedRoot := controlConfig.Installation.TrustedConfigurationRoot
	result := make([]VerifiedRuntimeContent, 0, len(targets))
	for index, target := range targets {
		content := contents[index]
		contentDigest := sha256.Sum256(content.data)
		relative, err := ManifestRelativePath(trustedRoot, target.path)
		if err != nil {
			return nil, preflightError(ErrorRuntimeContent, "runtime content path is outside the trusted root", err)
		}
		if content.root != releasemanifest.RootTrustedConfiguration || content.path != relative ||
			!windowsPathEqual(content.absolutePath, target.path) || content.role != target.role ||
			content.sha256 != target.sha256 || content.size == 0 ||
			uint64(len(content.data)) != content.size ||
			hex.EncodeToString(contentDigest[:]) != content.sha256 {
			return nil, preflightError(ErrorRuntimeContent, "runtime content metadata or bytes differ from configuration", nil)
		}
		if content.object.Path != content.absolutePath {
			return nil, preflightError(ErrorRuntimeContent, "runtime content object path is inconsistent", nil)
		}
		size := content.size
		if err := validateObjectEvidence("runtime content", content.object, winfile.ObjectKindFile, &size); err != nil {
			return nil, preflightError(ErrorRuntimeContent, "runtime content object evidence is invalid", err)
		}
		matched := false
		for _, binding := range bindings {
			file := binding.Manifest.File
			fileSize, sizeErr := strconv.ParseUint(file.Size, 10, 64)
			if sizeErr == nil && file.Root == content.root && file.Path == content.path &&
				file.Role == content.role && file.SHA256 == content.sha256 && fileSize == content.size &&
				sameObjectEvidence(binding.VerifiedFile.Object, content.object) {
				matched = true
				break
			}
		}
		if !matched {
			return nil, preflightError(ErrorRuntimeContent, "runtime content lacks an exact file binding", nil)
		}
		result = append(result, cloneRuntimeContent(content))
	}
	return result, nil
}
