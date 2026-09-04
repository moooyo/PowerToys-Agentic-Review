package launchguard

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/preflight"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winprocess"
)

const (
	testRoot           = `C:\Program Files\AgenticReview\Worker`
	testNode           = testRoot + `\runtime\node.exe`
	testControlBundle  = testRoot + `\app\control.mjs`
	testExecutorBundle = testRoot + `\app\executor.mjs`
	testProcessHost    = testRoot + `\native\AgenticReview.ProcessHost.exe`
)

type fakeDirectoryNode struct {
	path          string
	evidence      winfile.Evidence
	enumeration   winfile.DirectoryEnumeration
	caseSensitive bool
	enumerateErr  error
	verifyErr     error
	closeErr      error
}

type fakeFileNode struct {
	path       string
	evidence   winfile.Evidence
	data       []byte
	auth       authenticode.Evidence
	hashErr    error
	verifyErr  error
	streamErr  error
	authErr    error
	closeErr   error
	onClose    func()
	authCalls  int
	closeCalls int
}

type fakeFilesystem struct {
	directories map[string]*fakeDirectoryNode
	files       map[string]*fakeFileNode
	openOptions []winfile.OpenOptions
	events      []string
	openCalls   int
}

type fakeDirectoryHandle struct {
	fs     *fakeFilesystem
	node   *fakeDirectoryNode
	closed bool
}

func (handle *fakeDirectoryHandle) Evidence() winfile.Evidence {
	return cloneWinfileEvidence(handle.node.evidence)
}
func (handle *fakeDirectoryHandle) OpenDirectoryComponent(component string, options winfile.OpenOptions) (directoryHandle, error) {
	path := appendPath(handle.node.path, component)
	node := handle.fs.directories[strings.ToLower(path)]
	if node == nil {
		return nil, fmt.Errorf("missing fake directory %s", path)
	}
	handle.fs.openOptions = append(handle.fs.openOptions, options)
	handle.fs.openCalls++
	return &fakeDirectoryHandle{fs: handle.fs, node: node}, nil
}
func (handle *fakeDirectoryHandle) OpenFileComponent(component string, options winfile.OpenOptions) (fileHandle, error) {
	path := appendPath(handle.node.path, component)
	node := handle.fs.files[strings.ToLower(path)]
	if node == nil {
		return nil, fmt.Errorf("missing fake file %s", path)
	}
	handle.fs.openOptions = append(handle.fs.openOptions, options)
	handle.fs.openCalls++
	return &fakeFileHandle{fs: handle.fs, node: node}, nil
}
func (handle *fakeDirectoryHandle) Enumerate(winfile.DirectoryEnumerationOptions) (winfile.DirectoryEnumeration, error) {
	if handle.node.enumerateErr != nil {
		return winfile.DirectoryEnumeration{}, handle.node.enumerateErr
	}
	value := handle.node.enumeration
	value.Entries = append([]winfile.DirectoryEntry(nil), value.Entries...)
	return value, nil
}
func (handle *fakeDirectoryHandle) VerifyUnchanged() error { return handle.node.verifyErr }
func (handle *fakeDirectoryHandle) ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error) {
	return cloneWinfileEvidence(handle.node.evidence).Security, nil
}
func (handle *fakeDirectoryHandle) ReinspectDataStreams() ([]winfile.DataStream, error) {
	return nil, nil
}
func (handle *fakeDirectoryHandle) ReinspectCaseSensitivity() (bool, error) {
	return handle.node.caseSensitive, nil
}
func (handle *fakeDirectoryHandle) Close() error {
	if handle.closed {
		return nil
	}
	handle.closed = true
	handle.fs.events = append(handle.fs.events, "close-dir:"+handle.node.path)
	return handle.node.closeErr
}

type fakeFileHandle struct {
	fs     *fakeFilesystem
	node   *fakeFileNode
	closed bool
}

func (handle *fakeFileHandle) Evidence() winfile.Evidence {
	return cloneWinfileEvidence(handle.node.evidence)
}
func (handle *fakeFileHandle) HashSHA256(options winfile.HashOptions) (winfile.HashResult, error) {
	if handle.node.hashErr != nil {
		return winfile.HashResult{}, handle.node.hashErr
	}
	digest := sha256.Sum256(handle.node.data)
	return winfile.HashResult{SHA256: digest, Size: uint64(len(handle.node.data))}, nil
}
func (handle *fakeFileHandle) VerifyAuthenticode(authenticode.Verifier) (authenticode.Evidence, error) {
	handle.node.authCalls++
	return handle.node.auth, handle.node.authErr
}
func (handle *fakeFileHandle) VerifyUnchanged() error { return handle.node.verifyErr }
func (handle *fakeFileHandle) ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error) {
	return cloneWinfileEvidence(handle.node.evidence).Security, nil
}
func (handle *fakeFileHandle) ReinspectDataStreams() ([]winfile.DataStream, error) {
	if handle.node.streamErr != nil {
		return nil, handle.node.streamErr
	}
	return []winfile.DataStream{{Name: "::$DATA", Size: uint64(len(handle.node.data))}}, nil
}
func (handle *fakeFileHandle) Close() error {
	if handle.closed {
		return nil
	}
	handle.closed = true
	handle.node.closeCalls++
	handle.fs.events = append(handle.fs.events, "close-file:"+handle.node.path)
	if handle.node.onClose != nil {
		handle.node.onClose()
	}
	return handle.node.closeErr
}

type fakeVerifier struct{}

func (fakeVerifier) Verify(authenticode.Subject) (authenticode.Evidence, error) {
	return authenticode.Evidence{}, nil
}

type fakeNodeProcess struct {
	mu              sync.Mutex
	waitErr         error
	terminateErrors []error
	closeErrors     []error
	onActivate      func()
	activateCalls   int
	terminateCalls  int
	closeCalls      int
}

func (node *fakeNodeProcess) ProcessID() uint32 { return 42 }
func (node *fakeNodeProcess) StableIdentity() winprocess.NodeIdentity {
	return winprocess.NodeIdentity{ProcessID: 42, CreationTime: time.Unix(1, 0)}
}
func (node *fakeNodeProcess) ObserveIdentity() (winprocess.NodeIdentity, error) {
	return node.StableIdentity(), nil
}
func (node *fakeNodeProcess) RootJobActiveProcessCount() (uint32, error) { return 1, nil }
func (node *fakeNodeProcess) ActivateAfterHostControl() error {
	node.mu.Lock()
	defer node.mu.Unlock()
	node.activateCalls++
	if node.onActivate != nil {
		node.onActivate()
	}
	return nil
}
func (node *fakeNodeProcess) TakeStandardIO() (*winprocess.NodeStandardIO, error) { return nil, nil }
func (node *fakeNodeProcess) Wait() (uint32, error) {
	return node.WaitContext(context.Background())
}
func (node *fakeNodeProcess) WaitContext(ctx context.Context) (uint32, error) {
	if cause := context.Cause(ctx); cause != nil {
		return 0, cause
	}
	return 0, node.waitErr
}
func (node *fakeNodeProcess) Terminate() error {
	node.mu.Lock()
	defer node.mu.Unlock()
	index := node.terminateCalls
	node.terminateCalls++
	if index < len(node.terminateErrors) {
		return node.terminateErrors[index]
	}
	return nil
}
func (node *fakeNodeProcess) Close() error {
	node.mu.Lock()
	defer node.mu.Unlock()
	index := node.closeCalls
	node.closeCalls++
	if index < len(node.closeErrors) {
		return node.closeErrors[index]
	}
	return nil
}

type guardFixture struct {
	authority authoritySnapshot
	fs        *fakeFilesystem
	deps      dependencies
	node      *fakeNodeProcess
	launched  []winprocess.NodeLaunchSpec
}

func newGuardFixture(t *testing.T, role config.Role) *guardFixture {
	t.Helper()
	fs := &fakeFilesystem{directories: make(map[string]*fakeDirectoryNode), files: make(map[string]*fakeFileNode)}
	directoryPaths := []struct {
		path string
		mode winfile.SecurityMode
	}{
		{`C:\`, winfile.SecurityModeAmbientAncestor},
		{`C:\Program Files`, winfile.SecurityModeAmbientAncestor},
		{`C:\Program Files\AgenticReview`, winfile.SecurityModeManaged},
		{testRoot, winfile.SecurityModeManaged},
		{testRoot + `\runtime`, winfile.SecurityModeManaged},
		{testRoot + `\app`, winfile.SecurityModeManaged},
		{testRoot + `\native`, winfile.SecurityModeManaged},
	}
	for index, entry := range directoryPaths {
		fs.directories[strings.ToLower(entry.path)] = &fakeDirectoryNode{
			path:     entry.path,
			evidence: testWinfileEvidence(entry.path, winfile.ObjectKindDirectory, entry.mode, nil, byte(index+1)),
		}
	}
	fileEntries := []struct {
		path string
		data []byte
	}{
		{testNode, []byte("MZ-node")},
		{testControlBundle, []byte("control-bundle")},
		{testExecutorBundle, []byte("executor-bundle")},
		{testProcessHost, []byte("MZ-process-host")},
	}
	signer := strings.Repeat("a", 64)
	for index, entry := range fileEntries {
		fs.files[strings.ToLower(entry.path)] = &fakeFileNode{
			path:     entry.path,
			evidence: testWinfileEvidence(entry.path, winfile.ObjectKindFile, winfile.SecurityModeManaged, entry.data, byte(32+index)),
			data:     append([]byte(nil), entry.data...),
			auth:     validAuthenticodeEvidence(signer),
		}
	}
	buildEnumerations(fs)

	configuration := config.Config{
		Role:         role,
		WorkerNodeID: "powertoys-node:01",
		OwnService:   config.ServiceIdentity{Name: config.ControlServiceName, SID: config.ControlServiceSID},
		PeerService:  config.ServiceIdentity{Name: config.ExecutorServiceName, SID: config.ExecutorServiceSID},
		Installation: config.Installation{
			ReleaseID:      "2026.08.31-test+1",
			ManifestSHA256: strings.Repeat("b", 64),
		},
		Node: config.Node{
			ExecutablePath:   testNode,
			ExecutableSHA256: digestOf(fs.file(testNode).data),
			BundlePath:       testControlBundle,
			BundleSHA256:     digestOf(fs.file(testControlBundle).data),
			WorkingDirectory: `C:\ProgramData\AgenticReview\Control\Work`,
			Environment:      map[string]string{"SYSTEMROOT": `C:\Windows`},
		},
		Limits: config.Limits{
			RootJobMaximumProcesses:             32,
			RootJobMaximumMemoryBytes:           "1073741824",
			MaximumFrameBytes:                   config.MaximumFrameBytes,
			MaximumQueuedBytesPerDirection:      4 * 1024 * 1024,
			ShutdownTimeoutMilliseconds:         30000,
			ForceTerminationReserveMilliseconds: 5000,
		},
	}
	executorPolicySHA256 := strings.Repeat("6", 64)
	if role == config.RoleExecutor {
		configuration.OwnService, configuration.PeerService = configuration.PeerService, configuration.OwnService
		configuration.Node.BundlePath = testExecutorBundle
		configuration.Node.BundleSHA256 = digestOf(fs.file(testExecutorBundle).data)
		configuration.Node.WorkingDirectory = `C:\ProgramData\AgenticReview\Executor\Work`
		configuration.Executor = &config.ExecutorConfiguration{
			CodexPolicySHA256: executorPolicySHA256,
			ProcessHostPath:   testProcessHost,
			ProcessHostSHA256: digestOf(fs.file(testProcessHost).data),
		}
	} else {
		configuration.Control = &config.ControlConfiguration{}
	}
	root := preflight.VerifiedRoot{
		Root: releasemanifest.RootInstallation,
		Path: testRoot,
		Ancestors: []secureconfig.ObjectEvidence{
			mustObject(t, fs.directory(`C:\`).evidence),
			mustObject(t, fs.directory(`C:\Program Files`).evidence),
			mustObject(t, fs.directory(`C:\Program Files\AgenticReview`).evidence),
		},
		Object: mustObject(t, fs.directory(testRoot).evidence),
	}
	targets := []launchTarget{
		{kind: targetNode, file: verifiedFile(t, fs.file(testNode), releasemanifest.RoleNodeRuntime, `runtime\node.exe`)},
	}
	if role == config.RoleControl {
		targets = append(targets, launchTarget{kind: targetBundle, file: verifiedFile(t, fs.file(testControlBundle), releasemanifest.RoleControlBundle, `app\control.mjs`)})
	} else {
		targets = append(targets,
			launchTarget{kind: targetBundle, file: verifiedFile(t, fs.file(testExecutorBundle), releasemanifest.RoleExecutorBundle, `app\executor.mjs`)},
			launchTarget{kind: targetProcessHost, file: verifiedFile(t, fs.file(testProcessHost), releasemanifest.RoleProcessHost, `native\AgenticReview.ProcessHost.exe`)},
		)
	}
	node := &fakeNodeProcess{}
	releaseDigest := sha256.Sum256([]byte("release-template"))
	preflightDigest := sha256.Sum256([]byte("preflight-" + string(role)))
	bootstrapRole, err := launchRuntimeBootstrapRole(role)
	if err != nil {
		t.Fatal(err)
	}
	bootstrapOptions := localrpc.FoundationRuntimeBootstrapOptions{
		Role:                           bootstrapRole,
		WorkerNodeID:                   configuration.WorkerNodeID,
		ReleaseID:                      configuration.Installation.ReleaseID,
		ReleaseTemplateSHA256:          hex.EncodeToString(releaseDigest[:]),
		InstallationManifestSHA256:     configuration.Installation.ManifestSHA256,
		PreflightSHA256:                hex.EncodeToString(preflightDigest[:]),
		NodeBundleSHA256:               configuration.Node.BundleSHA256,
		ExecutorPolicySHA256:           executorPolicySHA256,
		MaximumQueuedBytesPerDirection: int(configuration.Limits.MaximumQueuedBytesPerDirection),
		TotalShutdownTimeoutMS:         int(configuration.Limits.ShutdownTimeoutMilliseconds),
		ForceTerminationReserveMS:      int(configuration.Limits.ForceTerminationReserveMilliseconds),
	}
	fixture := &guardFixture{
		authority: authoritySnapshot{
			role:             role,
			configuration:    configuration,
			preflightDigest:  preflightDigest,
			releaseDigest:    releaseDigest,
			bootstrapOptions: bootstrapOptions,
			root:             root,
			targets:          targets,
			signerPin:        signer,
		},
		fs:   fs,
		node: node,
	}
	fixture.deps = dependencies{
		openTraversalRoot: func(path string, options winfile.OpenOptions) (directoryHandle, error) {
			node := fs.directories[strings.ToLower(path)]
			if node == nil {
				return nil, fmt.Errorf("missing traversal root %s", path)
			}
			fs.openOptions = append(fs.openOptions, options)
			fs.openCalls++
			return &fakeDirectoryHandle{fs: fs, node: node}, nil
		},
		newAuthenticodeVerifier: func() (authenticode.Verifier, error) { return fakeVerifier{}, nil },
		launchNode: func(spec winprocess.NodeLaunchSpec) (winprocess.NodeProcess, error) {
			fixture.launched = append(fixture.launched, spec)
			return node, nil
		},
		platformCleanupStatus: func() error { return nil },
		commitPlatformHealthy: func(commit func()) error { commit(); return nil },
		quarantine:            &lifetimeQuarantine{},
	}
	return fixture
}

func (fixture *guardFixture) newRuntimeBootstrap(t *testing.T) localrpc.RuntimeBootstrapV1 {
	t.Helper()
	options := fixture.runtimeBootstrapOptions(t)
	bootstrap, err := localrpc.NewFoundationRuntimeBootstrap(options)
	if err != nil {
		t.Fatal(err)
	}
	return bootstrap
}

func (fixture *guardFixture) runtimeBootstrapOptions(t *testing.T) localrpc.FoundationRuntimeBootstrapOptions {
	t.Helper()
	options := fixture.authority.bootstrapOptions
	return options
}

func (fs *fakeFilesystem) directory(path string) *fakeDirectoryNode {
	return fs.directories[strings.ToLower(path)]
}
func (fs *fakeFilesystem) file(path string) *fakeFileNode { return fs.files[strings.ToLower(path)] }

func testWinfileEvidence(path string, kind winfile.ObjectKind, mode winfile.SecurityMode, data []byte, id byte) winfile.Evidence {
	control := uint16(0x8000 | 0x0004)
	protected := mode == winfile.SecurityModeManaged
	if protected {
		control |= 0x1000
	}
	linkCount := uint32(0)
	if kind == winfile.ObjectKindFile {
		linkCount = 1
	}
	return winfile.Evidence{
		Kind:      kind,
		Identity:  winfile.FileIdentity{VolumeSerialNumber: 7, FileID: [16]byte{id}},
		Size:      uint64(len(data)),
		LinkCount: linkCount,
		Path:      winfile.PathEvidence{RequestedPath: path, TerminalComponentReparseFree: true, Ancestors: winfile.AncestorValidationNotPerformed},
		Volume: winfile.VolumeEvidence{
			FileSystem: "NTFS", FileSystemFlags: 0x8, HandleSerialNumber: 7, PathSerialNumber: 7,
			DriveType: 3, PersistentACLs: true, RequiredUse: winfile.VolumeUseReadOnly, PathIdentityCrossCheck: true,
		},
		SecurityMode: mode,
		Security: winfile.SecurityDescriptorEvidence{
			OwnerSID: "S-1-5-18", GroupSID: "S-1-5-18", DACLPresent: true,
			DACLProtected: protected, Control: control, Revision: 1,
			SelfRelativeDescriptor: []byte{1, id, byte(mode)},
		},
	}
}

func mustObject(t *testing.T, evidence winfile.Evidence) secureconfig.ObjectEvidence {
	t.Helper()
	value, err := secureconfig.NewObjectEvidenceForMode(evidence.Path.RequestedPath, evidence.SecurityMode, evidence)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func verifiedFile(t *testing.T, node *fakeFileNode, role releasemanifest.FileRole, relative string) preflight.VerifiedFile {
	t.Helper()
	return preflight.VerifiedFile{
		Root: releasemanifest.RootInstallation, Path: relative, AbsolutePath: node.path,
		Role: role, SHA256: digestOf(node.data), Size: uint64(len(node.data)), Object: mustObject(t, node.evidence),
	}
}

func digestOf(data []byte) string { return fmt.Sprintf("%x", sha256.Sum256(data)) }

func validAuthenticodeEvidence(signer string) authenticode.Evidence {
	return authenticode.Evidence{
		Trusted: true, SignatureKind: authenticode.SignatureKindEmbedded,
		SignatureCount: 1, VerifiedSignatureIndex: 0,
		RevocationPolicy:         authenticode.RevocationPolicyRuntimeCacheOnlyNoCheck,
		DigestPolicy:             authenticode.DigestPolicySHA256Only,
		StrongSignaturePolicy:    authenticode.StrongSignaturePolicyWindowsOSCurrent,
		SignerDigestAlgorithmOID: authenticode.SHA256ObjectIdentifier,
		FileDigestAlgorithmOID:   authenticode.SHA256ObjectIdentifier,
		SignerIdentity:           "test signer", VerifiedLeafSignerCertificateDERSHA256: signer,
	}
}

func cloneWinfileEvidence(value winfile.Evidence) winfile.Evidence {
	value.Security.SelfRelativeDescriptor = append([]byte(nil), value.Security.SelfRelativeDescriptor...)
	return value
}

func buildEnumerations(fs *fakeFilesystem) {
	for _, directory := range fs.directories {
		directory.enumeration = winfile.DirectoryEnumeration{}
	}
	for _, directory := range fs.directories {
		parent := parentPath(directory.path)
		if parentNode := fs.directories[strings.ToLower(parent)]; parentNode != nil {
			parentNode.enumeration.Entries = append(parentNode.enumeration.Entries, winfile.DirectoryEntry{
				Name: leafName(directory.path), Kind: winfile.ObjectKindDirectory, Identity: directory.evidence.Identity,
			})
		}
	}
	for _, file := range fs.files {
		if parentNode := fs.directories[strings.ToLower(parentPath(file.path))]; parentNode != nil {
			parentNode.enumeration.Entries = append(parentNode.enumeration.Entries, winfile.DirectoryEntry{
				Name: leafName(file.path), Kind: winfile.ObjectKindFile, Identity: file.evidence.Identity, Size: file.evidence.Size,
			})
		}
	}
}

func parentPath(path string) string {
	index := strings.LastIndex(path, `\`)
	if index == 2 {
		return path[:3]
	}
	if index < 0 {
		return ""
	}
	return path[:index]
}
func leafName(path string) string { return path[strings.LastIndex(path, `\`)+1:] }

var _ winprocess.NodeProcess = (*fakeNodeProcess)(nil)
