package preflight

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"reflect"
	"strconv"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/framing"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

const (
	WorkerAPIProtocolVersion   = "1.0"
	ServiceHostRPCVersion      = uint32(1)
	ProcessHostProtocolVersion = uint32(1)
	fileAttributeReparsePoint  = uint32(0x00000400)
)

// CompiledCompatibility returns the versions compiled into this ServiceHost.
func CompiledCompatibility() releasemanifest.Compatibility {
	return releasemanifest.Compatibility{
		WorkerAPIProtocolVersion:   WorkerAPIProtocolVersion,
		LocalProtocolMajor:         uint32(framing.MajorVersion),
		LocalProtocolMinimumMinor:  uint32(framing.MinorVersion),
		LocalProtocolMaximumMinor:  uint32(framing.MinorVersion),
		ServiceHostRPCVersion:      ServiceHostRPCVersion,
		ProcessHostProtocolVersion: ProcessHostProtocolVersion,
	}
}

// composeSnapshots is the side-effect-free composition core. It is private so
// tests cannot turn detached fixtures into production-authorizing evidence.
func composeSnapshots(input snapshotInput) (Evidence, error) {
	if input.role != config.RoleControl && input.role != config.RoleExecutor {
		return Evidence{}, preflightError(ErrorInput, "preflight role must be control or executor", nil)
	}
	if _, err := parseCanonicalWindowsPath(input.actualBootstrapPath, false); err != nil {
		return Evidence{}, preflightError(ErrorInput, "actual bootstrap path is invalid", err)
	}
	if input.installation == nil {
		return Evidence{}, preflightError(ErrorInstallation, "installation snapshot is required", nil)
	}
	if input.role != input.installation.role ||
		!windowsPathEqual(input.actualBootstrapPath, input.installation.actualBootstrapPath) {
		return Evidence{}, preflightError(ErrorInput, "snapshot selectors do not match installation evidence", nil)
	}

	controlConfig, err := parseConfigurationRead("Control", input.installation.controlBootstrap)
	if err != nil {
		return Evidence{}, err
	}
	executorConfig, err := parseConfigurationRead("Executor", input.installation.executorBootstrap)
	if err != nil {
		return Evidence{}, err
	}
	if controlConfig.Role != config.RoleControl || executorConfig.Role != config.RoleExecutor {
		return Evidence{}, preflightError(
			ErrorConfigurationPair,
			"bootstrap configuration roles are not Control and Executor",
			nil,
		)
	}
	if !reflect.DeepEqual(controlConfig, input.installation.controlConfig) ||
		!reflect.DeepEqual(executorConfig, input.installation.executorConfig) {
		return Evidence{}, preflightError(
			ErrorInstallation,
			"opaque configuration snapshots differ from their exact bootstrap reads",
			nil,
		)
	}
	if err := validateConfigurationSecurityPaths(controlConfig); err != nil {
		return Evidence{}, preflightError(ErrorConfiguration, "Control configuration contains an unsafe security path", err)
	}
	if err := validateConfigurationSecurityPaths(executorConfig); err != nil {
		return Evidence{}, preflightError(ErrorConfiguration, "Executor configuration contains an unsafe security path", err)
	}
	if err := validateConfigurationPair(controlConfig, executorConfig); err != nil {
		return Evidence{}, err
	}
	if err := validateBootstrapBinding(
		input.bootstrap,
		input.role,
		controlConfig,
		executorConfig,
		input.installation.identity,
	); err != nil {
		return Evidence{}, err
	}
	installationSigner := input.installation.release.signerPin
	if !validSHA256(installationSigner) ||
		subtle.ConstantTimeCompare(
			[]byte(installationSigner),
			[]byte(controlConfig.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256),
		) != 1 ||
		subtle.ConstantTimeCompare(
			[]byte(installationSigner),
			[]byte(executorConfig.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256),
		) != 1 {
		return Evidence{}, preflightError(
			ErrorReleaseAuthority,
			"installation verification signer pin does not match both configurations",
			nil,
		)
	}

	roots, rootIndex, err := validateRoots(input.installation.roots, controlConfig, executorConfig)
	if err != nil {
		return Evidence{}, err
	}
	trustedRoot := rootIndex[releasemanifest.RootTrustedConfiguration]
	installationRoot := rootIndex[releasemanifest.RootInstallation]

	controlEvidence, err := bindBootstrap(
		controlConfig,
		input.installation.controlBootstrap,
		releasemanifest.BootstrapControl,
		trustedRoot,
	)
	if err != nil {
		return Evidence{}, err
	}
	executorEvidence, err := bindBootstrap(
		executorConfig,
		input.installation.executorBootstrap,
		releasemanifest.BootstrapExecutor,
		trustedRoot,
	)
	if err != nil {
		return Evidence{}, err
	}
	selectedPath := controlEvidence.Read.File.Path
	if input.role == config.RoleExecutor {
		selectedPath = executorEvidence.Read.File.Path
	}
	if !windowsPathEqual(input.actualBootstrapPath, selectedPath) {
		return Evidence{}, preflightError(
			ErrorBootstrapBinding,
			"actual bootstrap path does not identify the selected role configuration",
			nil,
		)
	}

	manifestRead := input.installation.manifestRead
	manifestEvidence, err := validateManifestRead(
		manifestRead,
		controlConfig,
		executorConfig,
		installationRoot,
	)
	if err != nil {
		return Evidence{}, err
	}
	if !reflect.DeepEqual(manifestEvidence.Manifest, input.installation.manifest) {
		return Evidence{}, preflightError(
			ErrorInstallation,
			"opaque manifest snapshot differs from its exact manifest read",
			nil,
		)
	}

	files, fileIndex, err := validateVerifiedFiles(
		input.installation.files,
		manifestEvidence.Manifest,
		rootIndex,
	)
	if err != nil {
		return Evidence{}, err
	}
	if err := validateUniqueFileIdentities(
		roots,
		controlEvidence.Read,
		executorEvidence.Read,
		manifestEvidence.Read,
		files,
	); err != nil {
		return Evidence{}, err
	}

	bindings, err := bindConfiguredFiles(
		controlConfig,
		executorConfig,
		manifestEvidence,
		rootIndex,
		fileIndex,
	)
	if err != nil {
		return Evidence{}, err
	}
	releaseBindings, serviceHost, err := bindReleaseBinding(
		input.installation.release,
		manifestEvidence,
		fileIndex,
	)
	if err != nil {
		return Evidence{}, err
	}
	bindings = append(bindings, releaseBindings...)
	if err := validateCurrentImageBinding(
		input.currentImage,
		input.bootstrap,
		input.installation.identity.ProcessID,
		serviceHost,
	); err != nil {
		return Evidence{}, err
	}
	if err := validateDataRootBinding(input.dataRoot, input.role, controlConfig, executorConfig, roots); err != nil {
		return Evidence{}, err
	}
	contents, err := validateRuntimeContents(
		input.role,
		controlConfig,
		executorConfig,
		input.installation.contents,
		bindings,
	)
	if err != nil {
		return Evidence{}, err
	}

	if input.role == config.RoleControl {
		if input.credentials == nil || !input.credentials.bound {
			return Evidence{}, preflightError(ErrorCredentialIdentity, "Control credential binding is absent", nil)
		}
	} else if input.credentials != nil {
		return Evidence{}, preflightError(ErrorCredentialIdentity, "Executor snapshot contains Control credentials", nil)
	}

	result := Evidence{
		role:                input.role,
		actualBootstrapPath: input.actualBootstrapPath,
		control:             cloneConfigurationEvidence(controlEvidence),
		executor:            cloneConfigurationEvidence(executorEvidence),
		manifest:            cloneManifestEvidence(manifestEvidence),
		identity:            cloneIdentityEvidence(input.installation.identity),
		roots:               cloneRoots(roots),
		files:               cloneFiles(files),
		release:             cloneReleaseBinding(input.installation.release),
		bindings:            cloneBindings(bindings),
		controlCredentials:  cloneControlCredentials(input.credentials),
		dataRoot:            cloneDataRootBinding(input.dataRoot),
		contents:            cloneRuntimeContents(contents),
		bootstrap:           input.bootstrap,
		currentImage:        input.currentImage,
	}
	result.digest, err = digestEvidence(result)
	if err != nil {
		return Evidence{}, preflightError(ErrorEvidence, "compute preflight evidence digest", err)
	}
	if err := result.Validate(); err != nil {
		return Evidence{}, err
	}
	return result, nil
}

func parseConfigurationRead(label string, read secureconfig.Result) (config.Config, error) {
	if err := validateSecureRead(label+" bootstrap configuration", read, uint64(config.MaximumDocumentBytes)); err != nil {
		return config.Config{}, preflightError(ErrorConfiguration, label+" bootstrap evidence is invalid", err)
	}
	parsed, err := config.Parse(read.Data)
	if err != nil {
		return config.Config{}, preflightError(ErrorConfiguration, label+" bootstrap configuration is invalid", err)
	}
	return parsed, nil
}

func validateConfigurationPair(control config.Config, executor config.Config) error {
	mismatch := func(field string) error {
		return preflightError(ErrorConfigurationPair, "Control and Executor configurations disagree on "+field, nil)
	}
	if control.OwnService != executor.PeerService || control.PeerService != executor.OwnService {
		return mismatch("mutual ownService and peerService identities")
	}
	if control.PipeName != executor.PipeName {
		return mismatch("pipeName")
	}
	if !windowsPathEqual(control.Installation.Root, executor.Installation.Root) {
		return mismatch("installation.root")
	}
	if !windowsPathEqual(
		control.Installation.TrustedConfigurationRoot,
		executor.Installation.TrustedConfigurationRoot,
	) {
		return mismatch("installation.trustedConfigurationRoot")
	}
	if control.Installation.ReleaseID != executor.Installation.ReleaseID {
		return mismatch("installation.releaseId")
	}
	if !windowsPathEqual(control.Installation.ManifestPath, executor.Installation.ManifestPath) {
		return mismatch("installation.manifestPath")
	}
	if control.Installation.ManifestSHA256 != executor.Installation.ManifestSHA256 {
		return mismatch("installation.manifestSha256")
	}
	if control.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256 !=
		executor.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256 {
		return mismatch("installation.approvedAuthenticodeSignerCertificateDerSha256")
	}
	if windowsPathsOverlap(control.Node.DataRoot, executor.Node.DataRoot) {
		return mismatch("distinct non-overlapping node.dataRoot values")
	}
	if control.Control == nil || executor.Executor == nil ||
		control.Control.LocalAuthorityPublicKeySHA256 != executor.Executor.LocalAuthorityPublicKeySHA256 {
		return mismatch("local authority public key digest")
	}
	return nil
}

func validateRoots(
	values []VerifiedRoot,
	control config.Config,
	executor config.Config,
) ([]VerifiedRoot, map[releasemanifest.FileRoot]VerifiedRoot, error) {
	if len(values) != 2 {
		return nil, nil, preflightError(ErrorInstallation, "installation evidence must contain exactly two roots", nil)
	}
	result := cloneRoots(values)
	indexed := make(map[releasemanifest.FileRoot]VerifiedRoot, 2)
	for _, root := range result {
		if root.Root != releasemanifest.RootInstallation &&
			root.Root != releasemanifest.RootTrustedConfiguration {
			return nil, nil, preflightError(ErrorInstallation, "installation evidence contains an unknown root", nil)
		}
		if _, duplicate := indexed[root.Root]; duplicate {
			return nil, nil, preflightError(ErrorInstallation, "installation evidence contains a duplicate root", nil)
		}
		if _, err := parseCanonicalWindowsPath(root.Path, false); err != nil {
			return nil, nil, preflightError(ErrorInstallation, "verified root path is invalid", err)
		}
		if root.Object.Path != root.Path {
			return nil, nil, preflightError(ErrorInstallation, "verified root object path is inconsistent", nil)
		}
		if root.Object.Evidence.SecurityMode != winfile.SecurityModeManaged {
			return nil, nil, preflightError(ErrorInstallation, "verified root does not use managed security", nil)
		}
		if err := validateObjectEvidence("verified root", root.Object, winfile.ObjectKindDirectory, nil); err != nil {
			return nil, nil, preflightError(ErrorInstallation, "verified root object is invalid", err)
		}
		if err := validateVerifiedRootAncestors(root); err != nil {
			return nil, nil, preflightError(ErrorInstallation, "verified root ancestor chain is invalid", err)
		}
		indexed[root.Root] = root
	}
	installation, installationExists := indexed[releasemanifest.RootInstallation]
	trusted, trustedExists := indexed[releasemanifest.RootTrustedConfiguration]
	if !installationExists || !trustedExists {
		return nil, nil, preflightError(ErrorInstallation, "installation evidence is missing a required root", nil)
	}
	if windowsPathsOverlap(installation.Path, trusted.Path) {
		return nil, nil, preflightError(ErrorInstallation, "verified roots overlap", nil)
	}
	for _, candidate := range []config.Config{control, executor} {
		if !windowsPathEqual(candidate.Installation.Root, installation.Path) ||
			!windowsPathEqual(candidate.Installation.TrustedConfigurationRoot, trusted.Path) {
			return nil, nil, preflightError(ErrorInstallation, "configuration roots do not match verified roots", nil)
		}
	}
	return result, indexed, nil
}

func validateVerifiedRootAncestors(root VerifiedRoot) error {
	if len(root.Ancestors) == 0 {
		return fmt.Errorf("verified root has no ancestor evidence")
	}
	seen := make(map[fileIdentity]string, len(root.Ancestors)+1)
	for index, ancestor := range root.Ancestors {
		if err := validateObjectEvidence("verified root ancestor", ancestor, winfile.ObjectKindDirectory, nil); err != nil {
			return err
		}
		if ancestor.Evidence.Identity.VolumeSerialNumber != root.Object.Evidence.Identity.VolumeSerialNumber {
			return fmt.Errorf("verified root and ancestors use different volume identities")
		}
		if index > 0 && !isDirectWindowsChild(root.Ancestors[index-1].Path, ancestor.Path) {
			return fmt.Errorf("verified root ancestor chain is not component-relative")
		}
		if err := registerFileIdentity(seen, "verified root ancestor", ancestor); err != nil {
			return err
		}
	}
	if !isDirectWindowsChild(root.Ancestors[len(root.Ancestors)-1].Path, root.Path) {
		return fmt.Errorf("verified root is not a direct child of its retained parent")
	}
	return registerFileIdentity(seen, "verified root", root.Object)
}

func bindBootstrap(
	configuration config.Config,
	read secureconfig.Result,
	expectedKind releasemanifest.BootstrapConfigurationKind,
	root VerifiedRoot,
) (ConfigurationEvidence, error) {
	if err := tieReadToRoot(read, root); err != nil {
		return ConfigurationEvidence{}, preflightError(ErrorBootstrapBinding, "bootstrap read is not bound to the verified trusted root", err)
	}
	relative, err := ManifestRelativePath(root.Path, read.File.Path)
	if err != nil {
		return ConfigurationEvidence{}, preflightError(ErrorBootstrapBinding, "bootstrap path is outside the verified trusted root", err)
	}
	binding, err := releasemanifest.NewBootstrapConfigurationEvidence(
		releasemanifest.RootTrustedConfiguration,
		relative,
		read.ContentSHA256.String(),
		strconv.FormatUint(uint64(len(read.Data)), 10),
	)
	if err != nil {
		return ConfigurationEvidence{}, preflightError(ErrorBootstrapBinding, "bootstrap path, digest, or size is invalid", err)
	}
	if binding.Kind != expectedKind || string(configuration.Role) != string(expectedKind) {
		return ConfigurationEvidence{}, preflightError(ErrorBootstrapBinding, "bootstrap role and fixed path disagree", nil)
	}
	return ConfigurationEvidence{
		Configuration: cloneConfig(configuration),
		Read:          cloneRead(read),
		Binding:       binding,
	}, nil
}

func validateManifestRead(
	read secureconfig.Result,
	control config.Config,
	executor config.Config,
	root VerifiedRoot,
) (ManifestEvidence, error) {
	if err := validateSecureRead("release manifest", read, uint64(releasemanifest.MaximumDocumentBytes)); err != nil {
		return ManifestEvidence{}, preflightError(ErrorManifest, "release manifest evidence is invalid", err)
	}
	if !windowsPathEqual(read.File.Path, control.Installation.ManifestPath) ||
		!windowsPathEqual(read.File.Path, executor.Installation.ManifestPath) {
		return ManifestEvidence{}, preflightError(ErrorManifest, "release manifest read path does not match both configurations", nil)
	}
	if err := tieReadToRoot(read, root); err != nil {
		return ManifestEvidence{}, preflightError(ErrorManifest, "release manifest is not bound to the verified installation root", err)
	}
	relative, err := ManifestRelativePath(root.Path, read.File.Path)
	if err != nil {
		return ManifestEvidence{}, preflightError(ErrorManifest, "release manifest path is outside the installation root", err)
	}
	manifest, err := releasemanifest.Parse(read.Data)
	if err != nil {
		return ManifestEvidence{}, preflightError(ErrorManifest, "release manifest is invalid", err)
	}
	canonical, err := releasemanifest.MarshalCanonical(manifest)
	if err != nil {
		return ManifestEvidence{}, preflightError(ErrorManifest, "release manifest cannot be canonicalized", err)
	}
	canonicalDigest := sha256.Sum256(canonical)
	if canonicalDigest != [sha256.Size]byte(read.ContentSHA256) {
		return ManifestEvidence{}, preflightError(ErrorManifest, "release manifest canonical digest does not match its handle-bound content", nil)
	}
	digest := hex.EncodeToString(canonicalDigest[:])
	if subtle.ConstantTimeCompare([]byte(digest), []byte(control.Installation.ManifestSHA256)) != 1 ||
		subtle.ConstantTimeCompare([]byte(digest), []byte(executor.Installation.ManifestSHA256)) != 1 {
		return ManifestEvidence{}, preflightError(ErrorManifestBinding, "release manifest digest does not match both configuration pins", nil)
	}
	if manifest.ReleaseID != control.Installation.ReleaseID || manifest.ReleaseID != executor.Installation.ReleaseID {
		return ManifestEvidence{}, preflightError(ErrorManifestBinding, "release manifest ID does not match both configurations", nil)
	}
	if manifest.Compatibility != CompiledCompatibility() || localrpc.ProtocolVersion != "1.0" {
		return ManifestEvidence{}, preflightError(ErrorCompatibility, "release manifest compatibility differs from compiled protocol constants", nil)
	}
	if _, listed := manifest.LookupFile(releasemanifest.RootInstallation, relative); listed {
		return ManifestEvidence{}, preflightError(ErrorManifest, "release manifest must not list itself", nil)
	}
	return ManifestEvidence{
		Manifest: cloneManifest(manifest),
		Read:     cloneRead(read),
		SHA256:   digest,
	}, nil
}

func validateVerifiedFiles(
	values []VerifiedFile,
	manifest releasemanifest.Manifest,
	roots map[releasemanifest.FileRoot]VerifiedRoot,
) ([]VerifiedFile, map[string]VerifiedFile, error) {
	if len(values) != len(manifest.Files) {
		return nil, nil, preflightError(ErrorInstallation, "verified file count does not match the release manifest", nil)
	}
	rawIndex := make(map[string]VerifiedFile, len(values))
	for _, original := range values {
		value := cloneFile(original)
		root, exists := roots[value.Root]
		if !exists {
			return nil, nil, preflightError(ErrorInstallation, "verified file names an unknown root", nil)
		}
		if err := validateManifestRelativePath(value.Path); err != nil {
			return nil, nil, preflightError(ErrorInstallation, "verified file has an invalid relative path", err)
		}
		key := manifestFileKey(value.Root, value.Path)
		if _, duplicate := rawIndex[key]; duplicate {
			return nil, nil, preflightError(ErrorInstallation, "verified files contain a duplicate root and path", nil)
		}
		relative, err := ManifestRelativePath(root.Path, value.AbsolutePath)
		if err != nil || !strings.EqualFold(relative, value.Path) {
			return nil, nil, preflightError(ErrorInstallation, "verified file absolute and relative paths disagree", err)
		}
		expectedAbsolute, err := joinManifestPath(root.Path, value.Path)
		if err != nil || !windowsPathEqual(expectedAbsolute, value.AbsolutePath) {
			return nil, nil, preflightError(ErrorInstallation, "verified file path does not resolve below its verified root", err)
		}
		if value.Object.Path != value.AbsolutePath {
			return nil, nil, preflightError(ErrorInstallation, "verified file object path is inconsistent", nil)
		}
		size := value.Size
		if err := validateObjectEvidence("verified file", value.Object, winfile.ObjectKindFile, &size); err != nil {
			return nil, nil, preflightError(ErrorInstallation, "verified file object is invalid", err)
		}
		if value.Object.Evidence.Identity.VolumeSerialNumber != root.Object.Evidence.Identity.VolumeSerialNumber {
			return nil, nil, preflightError(ErrorInstallation, "verified file and root volume identities differ", nil)
		}
		if !validSHA256(value.SHA256) {
			return nil, nil, preflightError(ErrorInstallation, "verified file digest is invalid", nil)
		}
		rawIndex[key] = value
	}

	ordered := make([]VerifiedFile, 0, len(manifest.Files))
	index := make(map[string]VerifiedFile, len(manifest.Files))
	for _, entry := range manifest.Files {
		key := manifestFileKey(entry.Root, entry.Path)
		verified, exists := rawIndex[key]
		if !exists {
			return nil, nil, preflightError(ErrorInstallation, "release manifest file lacks installation evidence", nil)
		}
		expectedSize, err := strconv.ParseUint(entry.Size, 10, 64)
		if err != nil || verified.Role != entry.Role || verified.SHA256 != entry.SHA256 || verified.Size != expectedSize {
			return nil, nil, preflightError(ErrorInstallation, "verified file metadata differs from the release manifest", err)
		}
		ordered = append(ordered, verified)
		index[key] = verified
	}
	return ordered, index, nil
}

func bindConfiguredFiles(
	control config.Config,
	executor config.Config,
	manifest ManifestEvidence,
	roots map[releasemanifest.FileRoot]VerifiedRoot,
	files map[string]VerifiedFile,
) ([]FileBindingEvidence, error) {
	type configuredRequirement struct {
		purpose string
		root    releasemanifest.FileRoot
		path    string
		role    releasemanifest.FileRole
		digest  string
	}
	requirements := []configuredRequirement{
		{"control/node", releasemanifest.RootInstallation, control.Node.ExecutablePath, releasemanifest.RoleNodeRuntime, control.Node.ExecutableSHA256},
		{"control/bundle", releasemanifest.RootInstallation, control.Node.BundlePath, releasemanifest.RoleControlBundle, control.Node.BundleSHA256},
		{"executor/node", releasemanifest.RootInstallation, executor.Node.ExecutablePath, releasemanifest.RoleNodeRuntime, executor.Node.ExecutableSHA256},
		{"executor/bundle", releasemanifest.RootInstallation, executor.Node.BundlePath, releasemanifest.RoleExecutorBundle, executor.Node.BundleSHA256},
		{"executor/process-host", releasemanifest.RootInstallation, executor.Executor.ProcessHostPath, releasemanifest.RoleProcessHost, executor.Executor.ProcessHostSHA256},
		{"control/root-ca", releasemanifest.RootTrustedConfiguration, control.Control.RootCertificatePath, releasemanifest.RoleCABundle, control.Control.RootCertificateSHA256},
		{"executor/local-authority-spki", releasemanifest.RootTrustedConfiguration, executor.Executor.LocalAuthorityPublicKeyPath, releasemanifest.RoleTrustedConfig, executor.Executor.LocalAuthorityPublicKeySHA256},
		{"executor/codex-policy", releasemanifest.RootTrustedConfiguration, executor.Executor.CodexPolicyPath, releasemanifest.RolePolicy, executor.Executor.CodexPolicySHA256},
	}
	result := make([]FileBindingEvidence, 0, len(requirements))
	for _, requirement := range requirements {
		root := roots[requirement.root]
		relative, err := ManifestRelativePath(root.Path, requirement.path)
		if err != nil {
			return nil, preflightError(ErrorManifestBinding, requirement.purpose+" path is outside its verified root", err)
		}
		binding, err := requireBinding(
			requirement.purpose,
			releasemanifest.FileBindingRequirement{
				Root: requirement.root, Path: relative, Role: requirement.role, SHA256: requirement.digest,
			},
			manifest,
			files,
		)
		if err != nil {
			return nil, err
		}
		result = append(result, binding)
	}
	return result, nil
}

func requireBinding(
	purpose string,
	requirement releasemanifest.FileBindingRequirement,
	manifest ManifestEvidence,
	files map[string]VerifiedFile,
) (FileBindingEvidence, error) {
	binding, err := manifest.Manifest.RequireFileBinding(requirement)
	if err != nil {
		return FileBindingEvidence{}, preflightError(ErrorManifestBinding, purpose+" is not pinned by the release manifest", err)
	}
	if binding.ManifestSHA256 != manifest.SHA256 || binding.ReleaseID != manifest.Manifest.ReleaseID ||
		binding.Compatibility != CompiledCompatibility() {
		return FileBindingEvidence{}, preflightError(ErrorManifestBinding, purpose+" binding provenance is inconsistent", nil)
	}
	verified, exists := files[manifestFileKey(requirement.Root, requirement.Path)]
	if !exists || verified.Role != binding.File.Role || verified.SHA256 != binding.File.SHA256 {
		return FileBindingEvidence{}, preflightError(ErrorManifestBinding, purpose+" lacks matching verified file evidence", nil)
	}
	return FileBindingEvidence{Purpose: purpose, Manifest: binding, VerifiedFile: cloneFile(verified)}, nil
}

func validateSecureRead(label string, read secureconfig.Result, maximumBytes uint64) error {
	if len(read.Data) == 0 || uint64(len(read.Data)) > maximumBytes {
		return fmt.Errorf("%s bytes are empty or exceed the limit", label)
	}
	digest := sha256.Sum256(read.Data)
	if subtle.ConstantTimeCompare(digest[:], read.ContentSHA256[:]) != 1 {
		return fmt.Errorf("%s content digest does not match its bytes", label)
	}
	if err := validateObjectEvidence(label, read.File, winfile.ObjectKindFile, pointerToUint64(uint64(len(read.Data)))); err != nil {
		return err
	}
	if len(read.Ancestors) == 0 {
		return fmt.Errorf("%s has no ancestor evidence", label)
	}
	seen := make(map[fileIdentity]string, len(read.Ancestors)+1)
	for index, ancestor := range read.Ancestors {
		if err := validateObjectEvidence(label+" ancestor", ancestor, winfile.ObjectKindDirectory, nil); err != nil {
			return err
		}
		if index > 0 && !isDirectWindowsChild(read.Ancestors[index-1].Path, ancestor.Path) {
			return fmt.Errorf("%s ancestor chain is not component-relative", label)
		}
		if err := registerFileIdentity(seen, label+" ancestor", ancestor); err != nil {
			return err
		}
		if ancestor.Evidence.Identity.VolumeSerialNumber != read.File.Evidence.Identity.VolumeSerialNumber {
			return fmt.Errorf("%s ancestors and file use different volume identities", label)
		}
	}
	if !isDirectWindowsChild(read.Ancestors[len(read.Ancestors)-1].Path, read.File.Path) {
		return fmt.Errorf("%s file is not a direct child of its retained parent", label)
	}
	return registerFileIdentity(seen, label, read.File)
}

func validateObjectEvidence(
	label string,
	object secureconfig.ObjectEvidence,
	kind winfile.ObjectKind,
	expectedSize *uint64,
) error {
	if _, err := parseCanonicalWindowsPath(object.Path, kind == winfile.ObjectKindDirectory); err != nil {
		return fmt.Errorf("%s path: %w", label, err)
	}
	evidence := object.Evidence
	if evidence.Kind != kind || evidence.Path.RequestedPath != object.Path {
		return fmt.Errorf("%s object kind or requested path is inconsistent", label)
	}
	canonical, err := secureconfig.NewObjectEvidenceForMode(object.Path, evidence.SecurityMode, evidence)
	if err != nil || canonical.EvidenceSHA256 != object.EvidenceSHA256 ||
		canonical.SecurityDescriptorSHA256 != object.SecurityDescriptorSHA256 {
		return fmt.Errorf("%s canonical object evidence is inconsistent: %w", label, err)
	}
	if kind == winfile.ObjectKindFile && evidence.SecurityMode != winfile.SecurityModeManaged {
		return fmt.Errorf("%s file was not verified with managed security", label)
	}
	if evidence.Path.Ancestors != winfile.AncestorValidationNotPerformed ||
		!evidence.Path.TerminalComponentReparseFree || evidence.Attributes&fileAttributeReparsePoint != 0 {
		return fmt.Errorf("%s lacks terminal-component reparse evidence", label)
	}
	if kind == winfile.ObjectKindFile && evidence.LinkCount != 1 {
		return fmt.Errorf("%s does not have exactly one hard link", label)
	}
	if expectedSize != nil && evidence.Size != *expectedSize {
		return fmt.Errorf("%s size differs from handle evidence", label)
	}
	if evidence.Identity.FileID == ([16]byte{}) {
		return fmt.Errorf("%s file identity is empty", label)
	}
	if !strings.EqualFold(evidence.Volume.FileSystem, "NTFS") || !evidence.Volume.PersistentACLs ||
		evidence.Volume.DriveType != 3 || !evidence.Volume.PathIdentityCrossCheck ||
		evidence.Volume.HandleSerialNumber != evidence.Volume.PathSerialNumber ||
		evidence.Volume.RequiredUse != winfile.VolumeUseReadOnly {
		return fmt.Errorf("%s volume evidence is incomplete", label)
	}
	return nil
}

func tieReadToRoot(read secureconfig.Result, root VerifiedRoot) error {
	if _, err := ManifestRelativePath(root.Path, read.File.Path); err != nil {
		return err
	}
	for _, ancestor := range read.Ancestors {
		if !windowsPathEqual(ancestor.Path, root.Path) {
			continue
		}
		if !sameObjectEvidence(ancestor, root.Object) {
			return fmt.Errorf("retained root ancestor differs from installation evidence")
		}
		return nil
	}
	return fmt.Errorf("retained ancestor chain does not include the verified root")
}

func sameObjectEvidence(left secureconfig.ObjectEvidence, right secureconfig.ObjectEvidence) bool {
	return windowsPathEqual(left.Path, right.Path) &&
		left.Evidence.Identity == right.Evidence.Identity &&
		left.Evidence.Attributes == right.Evidence.Attributes &&
		left.Evidence.Size == right.Evidence.Size &&
		left.Evidence.LinkCount == right.Evidence.LinkCount &&
		left.EvidenceSHA256 == right.EvidenceSHA256 &&
		left.SecurityDescriptorSHA256 == right.SecurityDescriptorSHA256
}

func isDirectWindowsChild(parent string, child string) bool {
	parentPath, parentErr := parseCanonicalWindowsPath(parent, true)
	childPath, childErr := parseCanonicalWindowsPath(child, false)
	if parentErr != nil || childErr != nil || parentPath.drive != childPath.drive ||
		len(childPath.components) != len(parentPath.components)+1 {
		return false
	}
	for index := range parentPath.components {
		if !strings.EqualFold(parentPath.components[index], childPath.components[index]) {
			return false
		}
	}
	return true
}

func validateUniqueFileIdentities(
	roots []VerifiedRoot,
	control secureconfig.Result,
	executor secureconfig.Result,
	manifest secureconfig.Result,
	files []VerifiedFile,
) error {
	seen := make(map[fileIdentity]string, len(files)+len(roots)+3)
	for _, root := range roots {
		if err := registerFileIdentity(seen, string(root.Root)+" root", root.Object); err != nil {
			return preflightError(ErrorInstallation, "preflight roots reuse one filesystem identity", err)
		}
	}
	for _, candidate := range []struct {
		label  string
		object secureconfig.ObjectEvidence
	}{
		{"Control bootstrap", control.File},
		{"Executor bootstrap", executor.File},
		{"release manifest", manifest.File},
	} {
		if err := registerFileIdentity(seen, candidate.label, candidate.object); err != nil {
			return preflightError(ErrorInstallation, "preflight files reuse one filesystem identity", err)
		}
	}
	for _, file := range files {
		if err := registerFileIdentity(seen, file.AbsolutePath, file.Object); err != nil {
			return preflightError(ErrorInstallation, "preflight files reuse one filesystem identity", err)
		}
	}
	return nil
}

type fileIdentity struct {
	volume uint64
	fileID [16]byte
}

func registerFileIdentity(
	seen map[fileIdentity]string,
	label string,
	object secureconfig.ObjectEvidence,
) error {
	identity := fileIdentity{
		volume: object.Evidence.Identity.VolumeSerialNumber,
		fileID: object.Evidence.Identity.FileID,
	}
	if previous, duplicate := seen[identity]; duplicate {
		return fmt.Errorf("%s and %s identify the same file", previous, label)
	}
	seen[identity] = label
	return nil
}

func manifestFileKey(root releasemanifest.FileRoot, path string) string {
	return string(root) + "\x00" + strings.ToLower(path)
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

func pointerToUint64(value uint64) *uint64 { return &value }
