package outeradmission

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installerprofile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
)

func bindBootstrapPair(
	index outerpackage.Index,
	control config.Config,
	executor config.Config,
	documents documentSnapshot,
) error {
	legacyMTLS := index.SchemaVersion == outerpackage.IndexSchemaVersion &&
		index.ProfileID == outerpackage.IndexProfileID
	bearerToken := index.SchemaVersion == outerpackage.BearerTokenIndexSchemaVersion &&
		index.ProfileID == outerpackage.BearerTokenIndexProfileID
	switch {
	case legacyMTLS:
		if control.SchemaVersion != config.SchemaVersion || executor.SchemaVersion != config.SchemaVersion ||
			index.MTLSClientCredential == nil {
			return ErrMismatch
		}
	case bearerToken:
		if index.MTLSClientCredential != nil || installerprofile.ValidatePackageRoots(
			installerprofile.BearerTokenInstallerV2ID,
			index.PackageID,
			index.TargetRoots.Metadata,
			index.TargetRoots.Installation,
			index.TargetRoots.TrustedConfiguration,
		) != nil || installerprofile.ValidateBearerTokenBootstrapPair(
			installerprofile.BearerTokenInstallerV2ID,
			control,
			executor,
		) != nil {
			return ErrMismatch
		}
	default:
		return ErrMismatch
	}
	if err := validateConfigurationPair(control, executor); err != nil {
		return ErrMismatch
	}
	if index.WorkerNodeID != control.WorkerNodeID || index.ReleaseID != control.Installation.ReleaseID ||
		!windowsPathEqual(index.TargetRoots.Installation, control.Installation.Root) ||
		!windowsPathEqual(index.TargetRoots.TrustedConfiguration, control.Installation.TrustedConfigurationRoot) {
		return ErrMismatch
	}
	if err := requireDocumentPayload(
		index,
		outerpackage.RootTrustedConfiguration,
		outerpackage.ControlBootstrapPath,
		outerpackage.RoleControlBootstrap,
		documents.control,
	); err != nil {
		return err
	}
	if err := requireDocumentPayload(
		index,
		outerpackage.RootTrustedConfiguration,
		outerpackage.ExecutorBootstrapPath,
		outerpackage.RoleExecutorBootstrap,
		documents.executor,
	); err != nil {
		return err
	}
	manifestRelative, err := relativeWindowsPath(index.TargetRoots.Installation, control.Installation.ManifestPath)
	if err != nil || !strings.EqualFold(manifestRelative, outerpackage.RuntimeManifestPath) ||
		requirePayload(index, outerpackage.RootInstallation, outerpackage.RuntimeManifestPath,
			outerpackage.RoleRuntimeManifest, control.Installation.ManifestSHA256) != nil {
		return ErrMismatch
	}
	if control.Control == nil || executor.Executor == nil ||
		control.Control.LocalAuthorityCNGKeyName != index.LocalAuthorityCNG.KeyName ||
		control.Control.LocalAuthorityKeySecurityDescriptorSHA256 != index.LocalAuthorityCNG.SecurityDescriptorSHA256 ||
		control.Control.LocalAuthorityPublicKeySHA256 != index.NodeSpecificLocalAuthorityPublicSPKI.SHA256 ||
		executor.Executor.LocalAuthorityPublicKeySHA256 != index.NodeSpecificLocalAuthorityPublicSPKI.SHA256 {
		return ErrMismatch
	}
	if legacyMTLS && (control.Control.ClientCertificateStore != index.MTLSClientCredential.CertificateStore ||
		control.Control.ClientCertificateDERSHA256 != index.MTLSClientCredential.CertificateDERSHA256 ||
		control.Control.ClientPrivateKeySecurityDescriptorSHA256 !=
			index.MTLSClientCredential.PrivateKeySecurityDescriptorSHA256) {
		return ErrMismatch
	}
	spkiRelative, err := relativeWindowsPath(
		index.TargetRoots.TrustedConfiguration,
		executor.Executor.LocalAuthorityPublicKeyPath,
	)
	if err != nil || !strings.EqualFold(spkiRelative, index.NodeSpecificLocalAuthorityPublicSPKI.Path) ||
		requirePayload(index, outerpackage.RootTrustedConfiguration, spkiRelative,
			outerpackage.RoleTrustedConfig, executor.Executor.LocalAuthorityPublicKeySHA256) != nil {
		return ErrMismatch
	}

	bindings := []struct {
		root   outerpackage.Root
		base   string
		path   string
		role   outerpackage.Role
		digest string
	}{
		{outerpackage.RootInstallation, index.TargetRoots.Installation, control.Node.ExecutablePath, outerpackage.RoleNodeRuntime, control.Node.ExecutableSHA256},
		{outerpackage.RootInstallation, index.TargetRoots.Installation, executor.Node.ExecutablePath, outerpackage.RoleNodeRuntime, executor.Node.ExecutableSHA256},
		{outerpackage.RootInstallation, index.TargetRoots.Installation, control.Node.BundlePath, outerpackage.RoleControlBundle, control.Node.BundleSHA256},
		{outerpackage.RootInstallation, index.TargetRoots.Installation, executor.Node.BundlePath, outerpackage.RoleExecutorBundle, executor.Node.BundleSHA256},
		{outerpackage.RootTrustedConfiguration, index.TargetRoots.TrustedConfiguration, control.Control.RootCertificatePath, outerpackage.RoleCABundle, control.Control.RootCertificateSHA256},
		{outerpackage.RootTrustedConfiguration, index.TargetRoots.TrustedConfiguration, executor.Executor.CodexPolicyPath, outerpackage.RolePolicy, executor.Executor.CodexPolicySHA256},
		{outerpackage.RootInstallation, index.TargetRoots.Installation, executor.Executor.ProcessHostPath, outerpackage.RoleProcessHost, executor.Executor.ProcessHostSHA256},
	}
	for _, binding := range bindings {
		relative, err := relativeWindowsPath(binding.base, binding.path)
		if err != nil || requirePayload(index, binding.root, relative, binding.role, binding.digest) != nil {
			return ErrMismatch
		}
	}
	return nil
}

func validateConfigurationPair(control, executor config.Config) error {
	if control.SchemaVersion != executor.SchemaVersion ||
		control.Role != config.RoleControl || executor.Role != config.RoleExecutor ||
		control.OwnService != executor.PeerService || control.PeerService != executor.OwnService ||
		control.WorkerNodeID != executor.WorkerNodeID || control.PipeName != executor.PipeName ||
		!windowsPathEqual(control.Installation.Root, executor.Installation.Root) ||
		!windowsPathEqual(control.Installation.TrustedConfigurationRoot, executor.Installation.TrustedConfigurationRoot) ||
		control.Installation.ReleaseID != executor.Installation.ReleaseID ||
		!windowsPathEqual(control.Installation.ManifestPath, executor.Installation.ManifestPath) ||
		control.Installation.ManifestSHA256 != executor.Installation.ManifestSHA256 ||
		control.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256 !=
			executor.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256 ||
		windowsPathsOverlap(control.Node.DataRoot, executor.Node.DataRoot) ||
		control.Control == nil || executor.Executor == nil ||
		control.Control.LocalAuthorityPublicKeySHA256 != executor.Executor.LocalAuthorityPublicKeySHA256 ||
		control.Limits.MaximumFrameBytes != executor.Limits.MaximumFrameBytes ||
		control.Limits.MaximumQueuedBytesPerDirection != executor.Limits.MaximumQueuedBytesPerDirection ||
		control.Limits.ConnectTimeoutMilliseconds != executor.Limits.ConnectTimeoutMilliseconds ||
		control.Limits.ShutdownTimeoutMilliseconds != executor.Limits.ShutdownTimeoutMilliseconds ||
		control.Limits.ForceTerminationReserveMilliseconds != executor.Limits.ForceTerminationReserveMilliseconds {
		return ErrMismatch
	}
	return nil
}

func requireDocumentPayload(
	index outerpackage.Index,
	root outerpackage.Root,
	path string,
	role outerpackage.Role,
	document []byte,
) error {
	digest := sha256.Sum256(document)
	expectedSize := strconv.FormatUint(uint64(len(document)), 10)
	matches := 0
	for _, payload := range index.Payloads {
		if payload.Root == root && strings.EqualFold(payload.Path, path) && payload.Role == role &&
			payload.SHA256 == hex.EncodeToString(digest[:]) && payload.Size == expectedSize {
			matches++
		}
	}
	if matches != 1 {
		return ErrMismatch
	}
	return nil
}

func requirePayload(
	index outerpackage.Index,
	root outerpackage.Root,
	path string,
	role outerpackage.Role,
	digest string,
) error {
	matches := 0
	for _, payload := range index.Payloads {
		if payload.Root == root && strings.EqualFold(payload.Path, path) &&
			payload.Role == role && payload.SHA256 == digest {
			matches++
		}
	}
	if matches != 1 {
		return ErrMismatch
	}
	return nil
}

func relativeWindowsPath(root, absolute string) (string, error) {
	prefix := root + `\`
	if len(absolute) <= len(prefix) || !strings.EqualFold(absolute[:len(prefix)], prefix) {
		return "", ErrMismatch
	}
	return absolute[len(prefix):], nil
}

func windowsPathEqual(left, right string) bool { return strings.EqualFold(left, right) }

func windowsPathsOverlap(left, right string) bool {
	left = strings.ToLower(left)
	right = strings.ToLower(right)
	return left == right || strings.HasPrefix(left, right+`\`) || strings.HasPrefix(right, left+`\`)
}
