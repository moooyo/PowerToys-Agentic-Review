package installerdestination

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installerprofile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasepackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

type destinationFixture struct {
	plan   sourcePlan
	fs     *fakeFileSystem
	source *fakeSource
}

func newDestinationFixture(t testing.TB) *destinationFixture {
	t.Helper()
	data := make(map[string][]byte)
	specs := []struct {
		root outerpackage.Root
		path string
		role outerpackage.Role
		pe   bool
	}{
		{outerpackage.RootMetadata, outerpackage.PackageDescriptorPath, outerpackage.RolePackageDescriptor, false},
		{outerpackage.RootMetadata, outerpackage.PrepareReceiptPath, outerpackage.RolePrepareReceipt, false},
		{outerpackage.RootMetadata, outerpackage.ReviewedClosurePath, outerpackage.RoleReviewedClosure, false},
		{outerpackage.RootMetadata, outerpackage.CompiledReleaseTemplatePath, outerpackage.RoleCompiledReleaseTemplate, false},
		{outerpackage.RootMetadata, outerpackage.ServiceHostBuildReceiptPath, outerpackage.RoleServiceHostBuildReceipt, false},
		{outerpackage.RootInstallation, outerpackage.RuntimeManifestPath, outerpackage.RoleRuntimeManifest, false},
		{outerpackage.RootTrustedConfiguration, outerpackage.ControlBootstrapPath, outerpackage.RoleControlBootstrap, false},
		{outerpackage.RootTrustedConfiguration, outerpackage.ExecutorBootstrapPath, outerpackage.RoleExecutorBootstrap, false},
		{outerpackage.RootInstallation, releasepackage.ControlServiceWrapperPath, outerpackage.RoleServiceWrapper, true},
		{outerpackage.RootInstallation, releasepackage.ExecutorServiceWrapperPath, outerpackage.RoleServiceWrapper, true},
		{outerpackage.RootInstallation, `app\control.mjs`, outerpackage.RoleControlBundle, false},
		{outerpackage.RootInstallation, `app\executor.mjs`, outerpackage.RoleExecutorBundle, false},
		{outerpackage.RootInstallation, `codex\codex.exe`, outerpackage.RoleCodexCLI, true},
		{outerpackage.RootInstallation, `git\cmd\git.exe`, outerpackage.RoleGitCLI, true},
		{outerpackage.RootInstallation, `native\AgenticReview.ProcessHost.exe`, outerpackage.RoleProcessHost, true},
		{outerpackage.RootInstallation, `native\AgenticReview.ServiceHost.exe`, outerpackage.RoleServiceHost, true},
		{outerpackage.RootInstallation, `runtime\node.exe`, outerpackage.RoleNodeRuntime, true},
		{outerpackage.RootInstallation, releasepackage.ControlServiceConfigPath, outerpackage.RoleServiceConfig, false},
		{outerpackage.RootInstallation, releasepackage.ExecutorServiceConfigPath, outerpackage.RoleServiceConfig, false},
		{outerpackage.RootTrustedConfiguration, `keys\local-authority.spki`, outerpackage.RoleTrustedConfig, false},
	}
	for _, spec := range specs {
		data[fileKey(string(spec.root), spec.path)] = []byte("destination fixture: " + string(spec.root) + ":" + spec.path)
	}
	runtimeManifest := data[fileKey(string(outerpackage.RootInstallation), outerpackage.RuntimeManifestPath)]
	manifestDigest := sha256.Sum256(runtimeManifest)
	control, executor := fixtureBootstrapPair(hex.EncodeToString(manifestDigest[:]))
	controlDocument, err := config.MarshalCanonical(control)
	if err != nil {
		t.Fatal(err)
	}
	executorDocument, err := config.MarshalCanonical(executor)
	if err != nil {
		t.Fatal(err)
	}
	data[fileKey(string(outerpackage.RootTrustedConfiguration), outerpackage.ControlBootstrapPath)] = controlDocument
	data[fileKey(string(outerpackage.RootTrustedConfiguration), outerpackage.ExecutorBootstrapPath)] = executorDocument

	payloads := make([]outerpackage.Payload, 0, len(specs))
	for _, spec := range specs {
		content := data[fileKey(string(spec.root), spec.path)]
		digest := sha256.Sum256(content)
		payload := outerpackage.Payload{
			Root: spec.root, Path: spec.path, Role: spec.role,
			SHA256: hex.EncodeToString(digest[:]), Size: strconv.Itoa(len(content)),
		}
		if spec.pe {
			architecture := outerpackage.ArchitectureAMD64
			payload.TargetArchitecture = &architecture
		}
		payloads = append(payloads, payload)
	}
	spkiDigest := sha256.Sum256(data[fileKey(string(outerpackage.RootTrustedConfiguration), `keys\local-authority.spki`)])
	index := outerpackage.Index{
		InstallationID: "installation-node-001",
		LocalAuthorityCNG: outerpackage.LocalAuthorityCNGIdentity{
			KeyName: "AgenticReview.Worker.Control.LocalAuthority", SecurityDescriptorSHA256: strings.Repeat("5", 64),
		},
		NodeSpecificLocalAuthorityPublicSPKI: outerpackage.NodeSpecificSPKI{
			Path: `keys\local-authority.spki`, SHA256: hex.EncodeToString(spkiDigest[:]),
		},
		PackageID: "worker-package-001", Payloads: payloads,
		ProfileID: outerpackage.BearerTokenIndexProfileID, ReleaseID: "worker-2026.09.04.1",
		SchemaVersion:      outerpackage.BearerTokenIndexSchemaVersion,
		Source:             outerpackage.SourceIdentity{Commit: strings.Repeat("8", 40), Tree: strings.Repeat("9", 40)},
		TargetArchitecture: outerpackage.ArchitectureAMD64,
		TargetRoots: outerpackage.TargetRoots{
			Installation:         installerprofile.InstallationRoot,
			Metadata:             installerprofile.MetadataRootParent + `\worker-package-001`,
			TrustedConfiguration: installerprofile.TrustedConfigurationRoot,
		},
		WorkerNodeID: "worker-node-001",
	}
	indexDocument, err := outerpackage.MarshalIndexCanonical(index)
	if err != nil {
		t.Fatal(err)
	}
	indexDigest := sha256.Sum256(indexDocument)
	signature := make([]byte, 64)
	signature[31], signature[63] = 1, 1
	signerKeyID := strings.Repeat("a", 64)
	envelopeDocument, err := outerpackage.MarshalSignatureEnvelopeCanonical(outerpackage.SignatureEnvelope{
		Algorithm: outerpackage.SignatureAlgorithm, IndexSHA256: hex.EncodeToString(indexDigest[:]),
		SchemaVersion: outerpackage.SignatureSchemaVersion,
		Signature:     base64.RawURLEncoding.EncodeToString(signature), SignerKeyID: signerKeyID,
	})
	if err != nil {
		t.Fatal(err)
	}
	plan, err := parseSourcePlan(indexDocument, envelopeDocument, controlDocument, executorDocument, signerKeyID)
	if err != nil {
		t.Fatal(err)
	}
	fs := newFakeFileSystem(control.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256)
	for _, payload := range plan.index.Payloads {
		fs.addFile(joinPath(rootPath(plan.index, payload.Root), payload.Path), data[fileKey(string(payload.Root), payload.Path)])
	}
	fs.addFile(joinPath(plan.index.TargetRoots.Metadata, outerpackage.PackageIndexPath), indexDocument)
	fs.addFile(joinPath(plan.index.TargetRoots.Metadata, outerpackage.SignatureEnvelopePath), envelopeDocument)
	return &destinationFixture{plan: plan, fs: fs, source: &fakeSource{plan: plan}}
}

func (fixture *destinationFixture) dependencies() dependencies {
	return dependencies{
		acquireSource:           func() sourceLease { return fixture.source.lease() },
		openTraversalRoot:       fixture.fs.openTraversalRoot,
		newAuthenticodeVerifier: func() (authenticode.Verifier, error) { return fakeVerifier{}, nil },
		checkSecurity:           func(outerpackage.Root, outerpackage.Role, string, winfile.Evidence, bool) error { return nil },
		admitDestination:        func(sourcePlan) error { return nil },
	}
}

func (fixture *destinationFixture) verify(t testing.TB) Evidence {
	t.Helper()
	evidence, err := verifyWithDependencies(context.Background(), fixture.dependencies())
	if err != nil {
		t.Fatal(err)
	}
	return evidence
}

type fakeSource struct {
	plan        sourcePlan
	closed      bool
	consumed    bool
	validateErr error
	closeErr    error
}

func (source *fakeSource) lease() sourceLease {
	return sourceLease{
		withBinding: func(use func(sourcePlan) error) error {
			if source.closed || source.consumed {
				return ErrInvalidSource
			}
			err := use(cloneSourcePlan(source.plan))
			if err == nil {
				source.consumed = true
			}
			return err
		},
		validate: func() error {
			if source.closed {
				return ErrInvalidSource
			}
			return source.validateErr
		},
		close: func() error { source.closed = true; return source.closeErr },
		commit: func(operation cleanupOperation, commit func()) error {
			if source.closed {
				return ErrInvalidSource
			}
			if err := source.validateErr; err != nil {
				return err
			}
			return operation.commit(commit)
		},
	}
}

type fakeVerifier struct{}

func (fakeVerifier) Verify(authenticode.Subject) (authenticode.Evidence, error) {
	return authenticode.Evidence{}, nil
}

type fakeNode struct {
	name          string
	path          string
	directory     bool
	data          []byte
	children      map[string]*fakeNode
	identity      winfile.FileIdentity
	closeFailures int
}

type fakeFileSystem struct {
	root         *fakeNode
	nextID       uint64
	signerDigest string
}

func newFakeFileSystem(signerDigest string) *fakeFileSystem {
	fs := &fakeFileSystem{nextID: 1, signerDigest: signerDigest}
	fs.root = fs.newNode("", `C:\`, true)
	return fs
}

func (fs *fakeFileSystem) newNode(name, path string, directory bool) *fakeNode {
	var id [16]byte
	binary.LittleEndian.PutUint64(id[:8], fs.nextID)
	fs.nextID++
	return &fakeNode{name: name, path: path, directory: directory, children: make(map[string]*fakeNode), identity: winfile.FileIdentity{VolumeSerialNumber: 0x12345678, FileID: id}}
}

func (fs *fakeFileSystem) addFile(path string, data []byte) {
	parsed, err := parseWindowsPath(path)
	if err != nil {
		panic(err)
	}
	current := fs.root
	for index, component := range parsed.components {
		key := strings.ToLower(component)
		node := current.children[key]
		last := index == len(parsed.components)-1
		if node == nil {
			node = fs.newNode(component, joinPath(current.path, component), !last)
			current.children[key] = node
		}
		if last {
			node.directory = false
			node.data = append([]byte(nil), data...)
		}
		current = node
	}
}

func (fs *fakeFileSystem) mustNode(path string) *fakeNode {
	parsed, err := parseWindowsPath(path)
	if err != nil {
		panic(err)
	}
	current := fs.root
	for _, component := range parsed.components {
		current = current.children[strings.ToLower(component)]
		if current == nil {
			panic("missing fake path " + path)
		}
	}
	return current
}

func (fs *fakeFileSystem) openTraversalRoot(path string, options winfile.OpenOptions) (directoryHandle, error) {
	if path != `C:\` || options.VolumeUse != winfile.VolumeUseReadOnly {
		return nil, winfile.ErrInvalidPath
	}
	return &fakeDirectory{fs: fs, node: fs.root, securityMode: options.SecurityMode}, nil
}

type fakeDirectory struct {
	fs           *fakeFileSystem
	node         *fakeNode
	securityMode winfile.SecurityMode
	closed       bool
}

func (directory *fakeDirectory) Evidence() winfile.Evidence {
	return fakeEvidence(directory.node, directory.securityMode)
}
func (directory *fakeDirectory) OpenDirectoryComponent(component string, options winfile.OpenOptions) (directoryHandle, error) {
	node := directory.node.children[strings.ToLower(component)]
	if node == nil || !node.directory {
		return nil, winfile.ErrWrongObjectType
	}
	return &fakeDirectory{fs: directory.fs, node: node, securityMode: options.SecurityMode}, nil
}
func (directory *fakeDirectory) OpenFileComponent(component string, options winfile.OpenOptions) (fileHandle, error) {
	node := directory.node.children[strings.ToLower(component)]
	if node == nil || node.directory {
		return nil, winfile.ErrWrongObjectType
	}
	return &fakeFile{fs: directory.fs, node: node, securityMode: options.SecurityMode}, nil
}
func (directory *fakeDirectory) Enumerate(options winfile.DirectoryEnumerationOptions) (winfile.DirectoryEnumeration, error) {
	if directory.closed {
		return winfile.DirectoryEnumeration{}, winfile.ErrClosed
	}
	entries := make([]winfile.DirectoryEntry, 0, len(directory.node.children))
	var units uint64
	for _, node := range directory.node.children {
		kind := winfile.ObjectKindFile
		if node.directory {
			kind = winfile.ObjectKindDirectory
		}
		units += uint64(len([]rune(node.name)))
		entries = append(entries, winfile.DirectoryEntry{Name: node.name, Kind: kind, Identity: node.identity, Attributes: fakeAttributes(node), Size: uint64(len(node.data))})
	}
	if uint32(len(entries)) > options.MaximumEntries || units > options.MaximumTotalNameUTF16Units {
		return winfile.DirectoryEnumeration{}, winfile.ErrDirectoryBudget
	}
	sort.Slice(entries, func(left, right int) bool {
		return strings.ToLower(entries[left].Name) < strings.ToLower(entries[right].Name)
	})
	return winfile.DirectoryEnumeration{Entries: entries, NameUTF16Units: units}, nil
}
func (directory *fakeDirectory) VerifyUnchanged() error {
	if directory.closed {
		return winfile.ErrClosed
	}
	return nil
}
func (directory *fakeDirectory) ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error) {
	return fakeSecurity(directory.securityMode), nil
}
func (directory *fakeDirectory) ReinspectDataStreams() ([]winfile.DataStream, error) { return nil, nil }
func (directory *fakeDirectory) ReinspectCaseSensitivity() (bool, error)             { return false, nil }
func (directory *fakeDirectory) Close() error                                        { return closeFake(directory.node, &directory.closed) }

type fakeFile struct {
	fs           *fakeFileSystem
	node         *fakeNode
	securityMode winfile.SecurityMode
	closed       bool
}

func (file *fakeFile) Evidence() winfile.Evidence { return fakeEvidence(file.node, file.securityMode) }
func (file *fakeFile) ReadAll(maximum uint64) ([]byte, error) {
	if file.closed {
		return nil, winfile.ErrClosed
	}
	if uint64(len(file.node.data)) > maximum {
		return nil, winfile.ErrTooLarge
	}
	return append([]byte(nil), file.node.data...), nil
}
func (file *fakeFile) HashSHA256(options winfile.HashOptions) (winfile.HashResult, error) {
	if file.closed {
		return winfile.HashResult{}, winfile.ErrClosed
	}
	if options.ExpectedSize != uint64(len(file.node.data)) || options.ExpectedSize > options.MaximumBytes {
		return winfile.HashResult{}, winfile.ErrSizeMismatch
	}
	digest := sha256.Sum256(file.node.data)
	return winfile.HashResult{SHA256: digest, Size: uint64(len(file.node.data))}, nil
}
func (file *fakeFile) VerifyAuthenticode(authenticode.Verifier) (authenticode.Evidence, error) {
	return authenticode.Evidence{
		Trusted: true, SignatureKind: authenticode.SignatureKindEmbedded, SignatureCount: 1,
		VerifiedSignatureIndex: 0, RevocationPolicy: authenticode.RevocationPolicyRuntimeCacheOnlyNoCheck,
		DigestPolicy: authenticode.DigestPolicySHA256Only, StrongSignaturePolicy: authenticode.StrongSignaturePolicyWindowsOSCurrent,
		SignerDigestAlgorithmOID: authenticode.SHA256ObjectIdentifier, FileDigestAlgorithmOID: authenticode.SHA256ObjectIdentifier,
		SignerIdentity: "fixture signer", VerifiedLeafSignerCertificateDERSHA256: file.fs.signerDigest,
	}, nil
}
func (file *fakeFile) VerifyUnchanged() error {
	if file.closed {
		return winfile.ErrClosed
	}
	return nil
}
func (file *fakeFile) ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error) {
	return fakeSecurity(file.securityMode), nil
}
func (file *fakeFile) ReinspectDataStreams() ([]winfile.DataStream, error) { return nil, nil }
func (file *fakeFile) Close() error                                        { return closeFake(file.node, &file.closed) }

func closeFake(node *fakeNode, closed *bool) error {
	if *closed {
		return nil
	}
	if node.closeFailures > 0 {
		node.closeFailures--
		return errors.New("fixture close failure")
	}
	*closed = true
	return nil
}

func fakeEvidence(node *fakeNode, mode winfile.SecurityMode) winfile.Evidence {
	kind := winfile.ObjectKindFile
	if node.directory {
		kind = winfile.ObjectKindDirectory
	}
	return winfile.Evidence{
		Kind: kind, Identity: node.identity, Attributes: fakeAttributes(node), Size: uint64(len(node.data)), LinkCount: 1,
		Path:         winfile.PathEvidence{RequestedPath: node.path, TerminalComponentReparseFree: true, Ancestors: winfile.AncestorValidationNotPerformed},
		Volume:       winfile.VolumeEvidence{FileSystem: "NTFS", FileSystemFlags: 0x8, HandleSerialNumber: 0x12345678, PathSerialNumber: 0x12345678, DriveType: 3, PersistentACLs: true, RequiredUse: winfile.VolumeUseReadOnly, PathIdentityCrossCheck: true},
		SecurityMode: mode, Security: fakeSecurity(mode),
	}
}

func fakeAttributes(node *fakeNode) uint32 {
	if node.directory {
		return 0x10
	}
	return 0x80
}

func fakeSecurity(mode winfile.SecurityMode) winfile.SecurityDescriptorEvidence {
	if mode == winfile.SecurityModeAmbientAncestor {
		return winfile.SecurityDescriptorEvidence{OwnerSID: "S-1-5-18", GroupSID: "S-1-5-18", OwnerDefaulted: true, GroupDefaulted: true, DACLPresent: true, DACLDefaulted: true, Control: 0x8004, Revision: 1, SelfRelativeDescriptor: []byte{5, 6, 7, 8}}
	}
	return winfile.SecurityDescriptorEvidence{OwnerSID: "S-1-5-18", GroupSID: "S-1-5-18", DACLPresent: true, DACLProtected: true, Control: 0x9004, Revision: 1, SelfRelativeDescriptor: []byte{1, 2, 3, 4}}
}

func fixtureBootstrapPair(manifestSHA256 string) (config.Config, config.Config) {
	control := config.Config{
		SchemaVersion: config.BearerTokenSchemaVersion, Role: config.RoleControl, WorkerNodeID: "worker-node-001",
		OwnService:  config.ServiceIdentity{Name: config.ControlServiceName, SID: config.ControlServiceSID},
		PeerService: config.ServiceIdentity{Name: config.ExecutorServiceName, SID: config.ExecutorServiceSID},
		PipeName:    config.ControlExecutorPipeName,
		Installation: config.Installation{
			Root: installerprofile.InstallationRoot, TrustedConfigurationRoot: installerprofile.TrustedConfigurationRoot,
			ReleaseID: "worker-2026.09.04.1", ManifestPath: installerprofile.InstallationRoot + `\release-manifest.json`,
			ManifestSHA256: manifestSHA256, ApprovedAuthenticodeSignerCertificateDERSHA256: strings.Repeat("2", 64),
		},
		Node: fixtureNode(installerprofile.ControlDataRoot, `app\control.mjs`, false),
		Control: &config.ControlConfiguration{
			ServerOrigin: "https://review.example.test", ServerName: "review.example.test",
			RootCertificatePath: installerprofile.TrustedConfigurationRoot + `\certificates\server-root.cer`, RootCertificateSHA256: strings.Repeat("3", 64),
			WorkerAuthenticationProfile: config.WorkerAuthenticationProfileBearerTokenV1,
			LocalAuthorityCNGKeyName:    "AgenticReview.Worker.Control.LocalAuthority", LocalAuthorityKeySecurityDescriptorSHA256: strings.Repeat("4", 64), LocalAuthorityPublicKeySHA256: strings.Repeat("5", 64),
		},
		Limits: fixtureLimits(),
	}
	executor := control
	executor.Role = config.RoleExecutor
	executor.OwnService, executor.PeerService = control.PeerService, control.OwnService
	executor.Node = fixtureNode(installerprofile.ExecutorDataRoot, `app\executor.mjs`, true)
	executor.Control = nil
	executor.Executor = &config.ExecutorConfiguration{
		LocalAuthorityPublicKeyPath: installerprofile.TrustedConfigurationRoot + `\keys\local-authority.spki`, LocalAuthorityPublicKeySHA256: strings.Repeat("5", 64),
		CodexPolicyPath: installerprofile.TrustedConfigurationRoot + `\policy\codex-requirements.toml`, CodexPolicySHA256: strings.Repeat("6", 64),
		ProcessHostPath: installerprofile.InstallationRoot + `\native\AgenticReview.ProcessHost.exe`, ProcessHostSHA256: strings.Repeat("7", 64),
	}
	return control, executor
}

func fixtureNode(dataRoot, bundle string, executor bool) config.Node {
	environment := map[string]string{
		"APPDATA": dataRoot + `\Profile\AppData`, "LOCALAPPDATA": dataRoot + `\Profile\LocalAppData`, "NODE_ENV": "production",
		"PATH": installerprofile.InstallationRoot + `\runtime`, "SYSTEMROOT": `C:\Windows`, "TEMP": dataRoot + `\Temp`, "TMP": dataRoot + `\Temp`, "USERPROFILE": dataRoot + `\Profile`,
	}
	if executor {
		environment["CODEX_HOME"] = dataRoot + `\Codex`
		environment["GCM_INTERACTIVE"] = "never"
		environment["GIT_CONFIG_GLOBAL"] = dataRoot + `\Profile\.gitconfig`
		environment["GIT_CONFIG_NOSYSTEM"] = "1"
		environment["GIT_TERMINAL_PROMPT"] = "0"
		environment["HOME"] = dataRoot + `\Profile`
	}
	return config.Node{ExecutablePath: installerprofile.InstallationRoot + `\runtime\node.exe`, ExecutableSHA256: strings.Repeat("8", 64), BundlePath: installerprofile.InstallationRoot + `\` + bundle, BundleSHA256: strings.Repeat("9", 64), DataRoot: dataRoot, WorkingDirectory: dataRoot + `\Work`, Environment: environment}
}

func fixtureLimits() config.Limits {
	return config.Limits{RootJobMaximumProcesses: 128, RootJobMaximumMemoryBytes: "17179869184", MaximumFrameBytes: config.MaximumFrameBytes, MaximumQueuedBytesPerDirection: 4 * 1024 * 1024, ConnectTimeoutMilliseconds: 30_000, ShutdownTimeoutMilliseconds: 120_000, ForceTerminationReserveMilliseconds: 15_000}
}
