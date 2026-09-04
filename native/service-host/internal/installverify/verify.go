package installverify

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winidentity"
)

type openedDirectory struct {
	handle        directoryHandle
	object        secureconfig.ObjectEvidence
	resourceIndex int
	relativePath  string
	depth         uint32
}

type openedFile struct {
	handle        fileHandle
	object        secureconfig.ObjectEvidence
	resourceIndex int
	relativePath  string
	security      *fileSecurityBinding
}

type fileSecurityBinding struct {
	root         releasemanifest.FileRoot
	relativePath string
	purpose      filePurpose
	role         releasemanifest.FileRole
}

type verifiedTree struct {
	rootType    releasemanifest.FileRoot
	path        string
	root        *openedDirectory
	ancestors   []secureconfig.ObjectEvidence
	directories map[string]*openedDirectory
	files       map[string]*openedFile
}

type verifier struct {
	ctx                       context.Context
	options                   Options
	deps                      dependencies
	resources                 retainedResources
	identity                  winidentity.Evidence
	releaseAuthority          releaseAuthorityFacts
	releaseBinding            ReleaseBinding
	policy                    filesystemSecurityPolicy
	signatureVerifier         authenticode.Verifier
	installationManagedAnchor string
	trustedManagedAnchor      string

	seenIdentities map[winfile.FileIdentity]string
	directoryCount uint32
	totalEntries   uint32
	totalNameUnits uint64

	controlBootstrap  secureconfig.Result
	executorBootstrap secureconfig.Result
	controlConfig     config.Config
	executorConfig    config.Config
	manifestRead      secureconfig.Result
	manifest          releasemanifest.Manifest
	installation      *verifiedTree
	trusted           *verifiedTree
	verifiedFiles     map[string]FileSnapshot
	contentTargets    map[string]verifiedContentTarget
	verifiedContents  map[string]VerifiedContent
}

func verifyWithDependencies(
	ctx context.Context,
	options Options,
	authority releaseAuthorityFacts,
	deps dependencies,
) (result Evidence, err error) {
	if ctx == nil {
		return Evidence{}, verificationError(ErrorInput, "verification context is required", ErrInvalidOptions)
	}
	if err := validateReleaseAuthorityFacts(authority); err != nil {
		return Evidence{}, releaseAuthorityError("compiled release authority is invalid", err)
	}
	options, err = normalizeOptions(options)
	if err != nil {
		return Evidence{}, err
	}
	if err := validateDependencies(deps); err != nil {
		return Evidence{}, err
	}
	if cause := context.Cause(ctx); cause != nil {
		return Evidence{}, cause
	}
	identityOptions, err := fixedIdentityOptions(options.Role)
	if err != nil {
		return Evidence{}, verificationError(ErrorIdentity, "select fixed service identity", errors.Join(ErrServiceIdentity, err))
	}
	identity, err := deps.identityPreflight(identityOptions)
	if err != nil {
		return Evidence{}, verificationError(
			ErrorIdentity,
			"prove current restricted service identity",
			errors.Join(ErrServiceIdentity, err),
		)
	}
	observedRole, err := roleFromIdentityEvidence(identity)
	if err != nil || observedRole != options.Role {
		return Evidence{}, verificationError(
			ErrorIdentity,
			"current restricted service identity does not match the selected role",
			errors.Join(ErrServiceIdentity, err),
		)
	}
	policy, err := deps.newSecurityPolicy(identity)
	if err != nil {
		return Evidence{}, verificationError(ErrorIdentity, "construct production filesystem policy", err)
	}
	if isNilInterface(policy) {
		return Evidence{}, verificationError(ErrorIdentity, "filesystem policy factory returned nil", ErrServiceIdentity)
	}
	signatureVerifier, err := deps.newAuthenticodeVerifier()
	if err != nil {
		return Evidence{}, verificationError(
			ErrorSignature,
			"construct Authenticode verifier after service identity proof",
			errors.Join(ErrAuthenticode, err),
		)
	}
	if isNilInterface(signatureVerifier) {
		return Evidence{}, verificationError(ErrorSignature, "Authenticode verifier factory returned nil", ErrAuthenticode)
	}

	state := &verifier{
		ctx:               ctx,
		options:           options,
		deps:              deps,
		identity:          cloneIdentityEvidence(identity),
		releaseAuthority:  cloneReleaseAuthorityFacts(authority),
		policy:            policy,
		signatureVerifier: signatureVerifier,
		seenIdentities:    make(map[winfile.FileIdentity]string),
		verifiedFiles:     make(map[string]FileSnapshot),
		verifiedContents:  make(map[string]VerifiedContent),
	}
	defer func() {
		cleanupErr := state.resources.finalize()
		if cleanupErr != nil {
			result = Evidence{}
			err = errors.Join(err, verificationError(ErrorCleanup, "final installation reinspection or cleanup failed", errors.Join(ErrCleanup, cleanupErr)))
		}
		if err != nil {
			result = Evidence{}
		}
	}()

	if err = state.readBootstraps(); err != nil {
		return Evidence{}, err
	}
	if err = state.openRootsAndManifest(); err != nil {
		return Evidence{}, err
	}
	if err = state.verifyClosedTrees(); err != nil {
		return Evidence{}, err
	}
	if cause := context.Cause(ctx); cause != nil {
		return Evidence{}, cause
	}

	files := make([]FileSnapshot, 0, len(state.manifest.Files))
	for _, manifestFile := range state.manifest.Files {
		file, exists := state.verifiedFiles[manifestFileKey(manifestFile.Root, manifestFile.Path)]
		if !exists {
			return Evidence{}, verificationError(ErrorTree, "release manifest entry lacks verified file evidence", ErrClosedTree)
		}
		files = append(files, file)
	}
	result = Evidence{state: &evidenceState{
		role:                observedRole,
		identity:            cloneIdentityEvidence(state.identity),
		actualBootstrapPath: options.ActualBootstrapPath,
		controlBootstrap:    cloneSecureResult(state.controlBootstrap),
		executorBootstrap:   cloneSecureResult(state.executorBootstrap),
		controlConfig:       cloneConfig(state.controlConfig),
		executorConfig:      cloneConfig(state.executorConfig),
		manifestRead:        cloneSecureResult(state.manifestRead),
		manifest:            cloneManifest(state.manifest),
		releaseBinding:      cloneReleaseBinding(state.releaseBinding),
		roots: []RootSnapshot{
			state.installation.rootSnapshot(),
			state.trusted.rootSnapshot(),
		},
		files:    cloneFiles(files),
		contents: cloneVerifiedContents(state.verifiedContents),
	}}
	if validateErr := result.Validate(); validateErr != nil {
		return Evidence{}, verificationError(ErrorInput, "constructed installation evidence is incomplete", validateErr)
	}
	return result, nil
}

func (v *verifier) readBootstraps() error {
	parent, _, err := parentAndLeaf(v.options.ActualBootstrapPath)
	if err != nil {
		return verificationError(ErrorBootstrap, "derive bootstrap root", errors.Join(ErrBootstrap, err))
	}
	v.trustedManagedAnchor, err = v.deps.managedAnchor(releasemanifest.RootTrustedConfiguration, parent)
	if err != nil {
		return verificationError(ErrorBootstrap, "resolve trusted configuration managed anchor", errors.Join(ErrBootstrap, err))
	}
	controlPath := joinPath(parent, releasemanifest.ControlBootstrapConfigurationPath)
	executorPath := joinPath(parent, releasemanifest.ExecutorBootstrapConfigurationPath)
	if v.options.Role == config.RoleControl {
		controlPath = v.options.ActualBootstrapPath
	} else {
		executorPath = v.options.ActualBootstrapPath
	}

	v.controlBootstrap, err = v.readBootstrap("Control", controlPath, purposeControlBootstrap, parent)
	if err != nil {
		return err
	}
	v.executorBootstrap, err = v.readBootstrap("Executor", executorPath, purposeExecutorBootstrap, parent)
	if err != nil {
		return err
	}
	v.controlConfig, err = config.Parse(v.controlBootstrap.Data)
	if err != nil {
		return verificationError(ErrorConfiguration, "parse Control bootstrap configuration", errors.Join(ErrConfiguration, err))
	}
	v.executorConfig, err = config.Parse(v.executorBootstrap.Data)
	if err != nil {
		return verificationError(ErrorConfiguration, "parse Executor bootstrap configuration", errors.Join(ErrConfiguration, err))
	}
	if err := validateConfigurationPair(v.controlConfig, v.executorConfig); err != nil {
		return verificationError(ErrorConfiguration, "cross-check bootstrap configurations", err)
	}
	if err := validateConfigurationAuthority(v.controlConfig, v.executorConfig, v.releaseAuthority); err != nil {
		return err
	}
	if !windowsPathEqual(parent, v.controlConfig.Installation.TrustedConfigurationRoot) ||
		!windowsPathEqual(parent, v.executorConfig.Installation.TrustedConfigurationRoot) {
		return verificationError(ErrorConfiguration, "bootstrap directory does not match both trusted configuration roots", ErrConfiguration)
	}
	selected := v.controlBootstrap.File.Path
	if v.options.Role == config.RoleExecutor {
		selected = v.executorBootstrap.File.Path
	}
	if !windowsPathEqual(selected, v.options.ActualBootstrapPath) {
		return verificationError(ErrorBootstrap, "selected secure bootstrap read does not match the command-line path", ErrBootstrap)
	}
	if err := bindBootstrapRead(v.controlBootstrap, releasemanifest.BootstrapControl, v.controlConfig.Installation.TrustedConfigurationRoot); err != nil {
		return verificationError(ErrorBootstrap, "bind Control bootstrap", errors.Join(ErrBootstrap, err))
	}
	if err := bindBootstrapRead(v.executorBootstrap, releasemanifest.BootstrapExecutor, v.executorConfig.Installation.TrustedConfigurationRoot); err != nil {
		return verificationError(ErrorBootstrap, "bind Executor bootstrap", errors.Join(ErrBootstrap, err))
	}
	return nil
}

func (v *verifier) readBootstrap(
	label string,
	path string,
	purpose filePurpose,
	rootPath string,
) (secureconfig.Result, error) {
	if cause := context.Cause(v.ctx); cause != nil {
		return secureconfig.Result{}, cause
	}
	result, err := v.deps.secureRead(path, secureconfig.Options{
		MaximumBytes:      config.MaximumDocumentBytes,
		ManagedAnchorPath: v.trustedManagedAnchor,
		Policy: secureReadPolicy{
			policy: v.policy, root: releasemanifest.RootTrustedConfiguration,
			rootPath: rootPath, expectedPath: path, purpose: purpose,
		},
	})
	if err != nil {
		return secureconfig.Result{}, verificationError(ErrorBootstrap, "securely read "+label+" bootstrap", errors.Join(ErrBootstrap, err))
	}
	if cause := context.Cause(v.ctx); cause != nil {
		return secureconfig.Result{}, cause
	}
	if err := validateSecureRead(
		label+" bootstrap",
		path,
		v.trustedManagedAnchor,
		result,
		config.MaximumDocumentBytes,
	); err != nil {
		return secureconfig.Result{}, verificationError(ErrorBootstrap, label+" bootstrap evidence is invalid", errors.Join(ErrBootstrap, err))
	}
	return result, nil
}

func bindBootstrapRead(
	read secureconfig.Result,
	expected releasemanifest.BootstrapConfigurationKind,
	root string,
) error {
	relative, err := relativePath(root, read.File.Path)
	if err != nil {
		return err
	}
	binding, err := releasemanifest.NewBootstrapConfigurationEvidence(
		releasemanifest.RootTrustedConfiguration,
		relative,
		read.ContentSHA256.String(),
		strconv.FormatUint(uint64(len(read.Data)), 10),
	)
	if err != nil {
		return err
	}
	if binding.Kind != expected {
		return errors.New("bootstrap kind does not match its fixed path")
	}
	return nil
}

func (v *verifier) openRootsAndManifest() error {
	var err error
	v.installationManagedAnchor, err = v.deps.managedAnchor(
		releasemanifest.RootInstallation,
		v.controlConfig.Installation.Root,
	)
	if err != nil {
		return verificationError(ErrorTree, "resolve installation managed anchor", errors.Join(ErrClosedTree, err))
	}
	v.installation, err = v.openTree(
		releasemanifest.RootInstallation,
		v.controlConfig.Installation.Root,
		v.installationManagedAnchor,
	)
	if err != nil {
		return verificationError(ErrorTree, "open verified installation root", errors.Join(ErrClosedTree, err))
	}
	v.trusted, err = v.openTree(
		releasemanifest.RootTrustedConfiguration,
		v.controlConfig.Installation.TrustedConfigurationRoot,
		v.trustedManagedAnchor,
	)
	if err != nil {
		return verificationError(ErrorTree, "open verified trusted configuration root", errors.Join(ErrClosedTree, err))
	}

	manifestRelative, err := relativePath(v.installation.path, v.controlConfig.Installation.ManifestPath)
	if err != nil {
		return verificationError(ErrorManifest, "manifest path is outside the installation root", errors.Join(ErrManifest, err))
	}
	manifestFile, ancestors, err := v.installation.openFilePath(v, manifestRelative)
	if err != nil {
		return verificationError(ErrorManifest, "open release manifest relative to its retained root", errors.Join(ErrManifest, err))
	}
	if err := v.checkFileSecurity(
		v.installation,
		manifestFile,
		expectedFile{purpose: purposeManifest},
	); err != nil {
		return verificationError(ErrorManifest, "release manifest ACL is invalid", errors.Join(ErrManifest, err))
	}
	document, err := manifestFile.handle.ReadAll(releasemanifest.MaximumDocumentBytes)
	if err != nil {
		return verificationError(ErrorManifest, "read release manifest from retained handle", errors.Join(ErrManifest, err))
	}
	digest := sha256.Sum256(document)
	if subtle.ConstantTimeCompare(
		[]byte(fmt.Sprintf("%x", digest)),
		[]byte(v.controlConfig.Installation.ManifestSHA256),
	) != 1 {
		return verificationError(ErrorManifest, "release manifest digest differs from both bootstrap pins", ErrManifest)
	}
	v.manifest, err = releasemanifest.Parse(document)
	if err != nil {
		return verificationError(ErrorManifest, "parse canonical release manifest", errors.Join(ErrManifest, err))
	}
	v.releaseBinding, err = bindReleaseManifest(
		v.releaseAuthority,
		v.manifest,
		fmt.Sprintf("%x", digest),
	)
	if err != nil {
		return err
	}
	if _, listed := v.manifest.LookupFile(releasemanifest.RootInstallation, manifestRelative); listed {
		return verificationError(ErrorManifest, "release manifest lists itself", ErrManifest)
	}
	v.manifestRead = secureconfig.Result{
		Data:          append([]byte(nil), document...),
		ContentSHA256: secureconfig.Digest(digest),
		File:          cloneObjectEvidence(manifestFile.object),
		Ancestors:     cloneObjectEvidenceSlice(ancestors),
	}
	if err := validateSecureRead(
		"release manifest",
		manifestFile.object.Path,
		v.installationManagedAnchor,
		v.manifestRead,
		releasemanifest.MaximumDocumentBytes,
	); err != nil {
		return verificationError(ErrorManifest, "release manifest evidence is invalid", errors.Join(ErrManifest, err))
	}
	if err := v.validateManifestBudgets(); err != nil {
		return err
	}
	if err := validateConfiguredBindings(v.controlConfig, v.executorConfig, v.manifest); err != nil {
		return verificationError(ErrorManifest, "configuration path is not bound by the release manifest", errors.Join(ErrManifest, err))
	}
	if err := v.prepareVerifiedContentTargets(); err != nil {
		return verificationError(ErrorManifest, "prepare role-required trusted content", errors.Join(ErrManifest, err))
	}
	return nil
}

func (v *verifier) openTree(
	rootType releasemanifest.FileRoot,
	path string,
	managedAnchor string,
) (*verifiedTree, error) {
	parsed, err := parseWindowsPath(path, false)
	if err != nil || len(parsed.components) == 0 || uint32(len(parsed.components)) > v.options.Limits.MaximumPathDepth {
		return nil, errors.Join(ErrClosedTree, err)
	}
	managedDepth, err := managedAnchorDepth(parsed, managedAnchor)
	if err != nil {
		return nil, errors.Join(ErrClosedTree, err)
	}
	tree := &verifiedTree{
		rootType:    rootType,
		path:        path,
		directories: make(map[string]*openedDirectory),
		files:       make(map[string]*openedFile),
	}
	current, err := v.openTraversalDirectory(parsed.drive, rootType, 0, uint32(len(parsed.components)+1))
	if err != nil {
		return nil, err
	}
	ancestors := []secureconfig.ObjectEvidence{cloneObjectEvidence(current.object)}
	for index, component := range parsed.components {
		if cause := context.Cause(v.ctx); cause != nil {
			return nil, cause
		}
		last := index == len(parsed.components)-1
		childPath := joinPath(current.object.Path, component)
		if err := v.reserveDirectory(); err != nil {
			return nil, err
		}
		securityMode := winfile.SecurityModeAmbientAncestor
		if index+1 >= managedDepth {
			securityMode = winfile.SecurityModeManaged
		}
		child, err := current.handle.OpenDirectoryComponent(component, winfile.OpenOptions{
			VolumeUse:            winfile.VolumeUseReadOnly,
			DirectoryEnumeration: last,
			SecurityMode:         securityMode,
		})
		if err != nil {
			return nil, fmt.Errorf("open retained directory component %s: %w", childPath, err)
		}
		opened, err := v.retainDirectory(
			childPath,
			child,
			rootType,
			securityMode,
			uint32(index+1),
			uint32(len(parsed.components)+1),
		)
		if err != nil {
			return nil, err
		}
		if opened.object.Evidence.Identity.VolumeSerialNumber != current.object.Evidence.Identity.VolumeSerialNumber {
			return nil, fmt.Errorf("directory traversal changes volume at %s", childPath)
		}
		current = opened
		if !last {
			ancestors = append(ancestors, cloneObjectEvidence(current.object))
		}
	}
	tree.root = current
	tree.ancestors = ancestors
	tree.directories[""] = current
	current.relativePath = ""
	return tree, nil
}

func (v *verifier) openTraversalDirectory(
	path string,
	rootType releasemanifest.FileRoot,
	index uint32,
	count uint32,
) (*openedDirectory, error) {
	if err := v.reserveDirectory(); err != nil {
		return nil, err
	}
	directory, err := v.deps.openTraversalRoot(path, winfile.OpenOptions{
		VolumeUse: winfile.VolumeUseReadOnly, SecurityMode: winfile.SecurityModeAmbientAncestor,
	})
	if err != nil {
		return nil, err
	}
	return v.retainDirectory(path, directory, rootType, winfile.SecurityModeAmbientAncestor, index, count)
}

func (v *verifier) retainDirectory(
	path string,
	handle directoryHandle,
	rootType releasemanifest.FileRoot,
	securityMode winfile.SecurityMode,
	index uint32,
	count uint32,
) (*openedDirectory, error) {
	evidence := handle.Evidence()
	if evidence.SecurityMode != securityMode {
		return nil, errors.Join(
			fmt.Errorf("directory %s reported security mode %d, expected %d", path, evidence.SecurityMode, securityMode),
			closeRejectedDirectory(handle),
		)
	}
	object, err := secureconfig.NewObjectEvidenceForMode(path, securityMode, evidence)
	if err != nil {
		return nil, errors.Join(err, closeRejectedDirectory(handle))
	}
	resourceIndex := v.resources.addDirectory(path, handle, object)
	if err := registerIdentity(v.seenIdentities, path, object.Evidence.Identity); err != nil {
		return nil, err
	}
	if err := v.policy.CheckDirectory(directorySecurityRequest{
		root: rootType, isVolumeRoot: len(path) == 3, object: cloneObjectEvidence(object),
	}); err != nil {
		return nil, fmt.Errorf("directory security policy rejected %s: %w", path, err)
	}
	caseSensitive, err := handle.ReinspectCaseSensitivity()
	if err != nil {
		return nil, fmt.Errorf("verify directory case mode %s: %w", path, err)
	}
	if caseSensitive {
		return nil, fmt.Errorf("%w: %s", winfile.ErrCaseSensitiveDirectory, path)
	}
	return &openedDirectory{
		handle: handle, object: object, resourceIndex: resourceIndex, depth: index,
	}, nil
}

func (v *verifier) reserveDirectory() error {
	if v.directoryCount >= v.options.Limits.MaximumDirectories {
		return fmt.Errorf("directory count exceeds %d", v.options.Limits.MaximumDirectories)
	}
	v.directoryCount++
	return nil
}

func (tree *verifiedTree) rootSnapshot() RootSnapshot {
	return RootSnapshot{
		root: tree.rootType, path: tree.path,
		ancestors: cloneObjectEvidenceSlice(tree.ancestors),
		object:    cloneObjectEvidence(tree.root.object),
	}
}

func (v *verifier) validateManifestBudgets() error {
	if len(v.manifest.Files) > int(v.options.Limits.MaximumTotalEntries) {
		return verificationError(ErrorManifest, "release manifest exceeds the total entry limit", ErrManifest)
	}
	var total uint64
	for _, file := range v.manifest.Files {
		size, err := parseManifestSize(file.Size)
		if err != nil || size == 0 || size > v.options.Limits.MaximumFileBytes ||
			size > v.options.Limits.MaximumTotalFileBytes ||
			total > v.options.Limits.MaximumTotalFileBytes-size {
			return verificationError(ErrorManifest, "release manifest exceeds file byte limits", errors.Join(ErrManifest, err))
		}
		total += size
	}
	return nil
}

func validateConfiguredBindings(control, executor config.Config, manifest releasemanifest.Manifest) error {
	type requirement struct {
		root     releasemanifest.FileRoot
		rootPath string
		path     string
		role     releasemanifest.FileRole
		digest   string
	}
	requirements := []requirement{
		{releasemanifest.RootInstallation, control.Installation.Root, control.Node.ExecutablePath, releasemanifest.RoleNodeRuntime, control.Node.ExecutableSHA256},
		{releasemanifest.RootInstallation, control.Installation.Root, control.Node.BundlePath, releasemanifest.RoleControlBundle, control.Node.BundleSHA256},
		{releasemanifest.RootInstallation, executor.Installation.Root, executor.Node.ExecutablePath, releasemanifest.RoleNodeRuntime, executor.Node.ExecutableSHA256},
		{releasemanifest.RootInstallation, executor.Installation.Root, executor.Node.BundlePath, releasemanifest.RoleExecutorBundle, executor.Node.BundleSHA256},
		{releasemanifest.RootInstallation, executor.Installation.Root, executor.Executor.ProcessHostPath, releasemanifest.RoleProcessHost, executor.Executor.ProcessHostSHA256},
		{releasemanifest.RootTrustedConfiguration, control.Installation.TrustedConfigurationRoot, control.Control.RootCertificatePath, releasemanifest.RoleCABundle, control.Control.RootCertificateSHA256},
		{releasemanifest.RootTrustedConfiguration, executor.Installation.TrustedConfigurationRoot, executor.Executor.CodexPolicyPath, releasemanifest.RolePolicy, executor.Executor.CodexPolicySHA256},
	}
	for _, candidate := range requirements {
		relative, err := relativePath(candidate.rootPath, candidate.path)
		if err != nil {
			return err
		}
		binding, err := manifest.RequireFileBinding(releasemanifest.FileBindingRequirement{
			Root: candidate.root, Path: relative, Role: candidate.role, SHA256: candidate.digest,
		})
		if err != nil {
			return err
		}
		if binding.ReleaseID != manifest.ReleaseID || binding.Compatibility != releasemanifest.RequiredCompatibility() {
			return errors.New("configured binding provenance is inconsistent")
		}
	}
	return nil
}

func closeRejectedDirectory(directory directoryHandle) error {
	if directory == nil {
		return nil
	}
	return directory.Close()
}

func manifestFileKey(root releasemanifest.FileRoot, path string) string {
	return string(root) + "\x00" + strings.ToLower(path)
}
