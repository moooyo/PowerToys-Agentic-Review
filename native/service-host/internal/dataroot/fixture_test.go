package dataroot

import (
	"encoding/binary"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

const (
	testInstallationRoot = `C:\Program Files\AgenticReview\Worker`
	testTrustedRoot      = `C:\ProgramData\AgenticReview\TrustedConfig`
	testControlRoot      = `C:\ProgramData\AgenticReview\Control`
	testExecutorRoot     = `C:\ProgramData\AgenticReview\Executor`

	testSystemSID         = "S-1-5-18"
	testAdministratorsSID = "S-1-5-32-544"
	testOwnerRightsSID    = "S-1-3-4"

	testReadData        winfile.AccessMask = 0x00000001
	testWriteData       winfile.AccessMask = 0x00000002
	testAppendData      winfile.AccessMask = 0x00000004
	testReadEA          winfile.AccessMask = 0x00000008
	testWriteEA         winfile.AccessMask = 0x00000010
	testExecute         winfile.AccessMask = 0x00000020
	testDeleteChild     winfile.AccessMask = 0x00000040
	testReadAttributes  winfile.AccessMask = 0x00000080
	testWriteAttributes winfile.AccessMask = 0x00000100
	testDelete          winfile.AccessMask = 0x00010000
	testReadControl     winfile.AccessMask = 0x00020000
	testWriteDACL       winfile.AccessMask = 0x00040000
	testWriteOwner      winfile.AccessMask = 0x00080000
	testSynchronize     winfile.AccessMask = 0x00100000

	testFileAll = testDelete | testReadControl | testWriteDACL | testWriteOwner | testSynchronize |
		testReadData | testWriteData | testAppendData | testReadEA | testWriteEA | testExecute |
		testDeleteChild | testReadAttributes | testWriteAttributes
	testFileRead  = testReadControl | testSynchronize | testReadData | testReadEA | testReadAttributes
	testFileWrite = testReadControl | testSynchronize | testWriteData | testAppendData |
		testWriteEA | testWriteAttributes
	testFileExecute             = testReadControl | testSynchronize | testExecute | testReadAttributes
	testDirectoryRead           = testFileRead | testFileExecute
	testDirectoryModify         = testDirectoryRead | testFileWrite | testDelete | testDeleteChild
	testBoundaryDirectoryModify = testDirectoryModify &^ (testDelete | testDeleteChild)
	testFileModify              = testFileRead | testFileWrite | testDelete
)

type testACE struct {
	flags uint8
	mask  winfile.AccessMask
	sid   string
}

type fakeNode struct {
	path          string
	kind          winfile.ObjectKind
	mode          winfile.SecurityMode
	identity      winfile.FileIdentity
	security      winfile.SecurityDescriptorEvidence
	finalPath     string
	changed       bool
	caseSensitive bool
	streamErr     error
	closeFailures int
}

type fakeFileSystem struct {
	nodes  map[string]*fakeNode
	opened []string
}

func newFakeFileSystem(current config.Config) *fakeFileSystem {
	fs := &fakeFileSystem{nodes: make(map[string]*fakeNode)}
	roleRoot := current.Node.DataRoot
	fs.addDirectory(`C:\`, winfile.SecurityModeAmbientAncestor, 1, ambientSecurity())
	fs.addDirectory(`C:\ProgramData`, winfile.SecurityModeAmbientAncestor, 2, ambientSecurity())
	fs.addDirectory(`C:\ProgramData\AgenticReview`, winfile.SecurityModeManaged, 3, productAnchorSecurity())
	fs.addDirectory(roleRoot, winfile.SecurityModeManaged, 4, roleDirectorySecurity(current))
	fs.addDirectory(current.Node.WorkingDirectory, winfile.SecurityModeManaged, 5, roleDirectorySecurity(current))
	fs.addDirectory(current.Node.Environment["TEMP"], winfile.SecurityModeManaged, 6, roleDirectorySecurity(current))
	fs.addDirectory(current.Node.Environment["USERPROFILE"], winfile.SecurityModeManaged, 7, roleDirectorySecurity(current))
	fs.addDirectory(current.Node.Environment["APPDATA"], winfile.SecurityModeManaged, 8, roleDirectorySecurity(current))
	fs.addDirectory(current.Node.Environment["LOCALAPPDATA"], winfile.SecurityModeManaged, 9, roleDirectorySecurity(current))
	if current.Role == config.RoleExecutor {
		fs.addDirectory(current.Node.Environment["CODEX_HOME"], winfile.SecurityModeManaged, 10, roleDirectorySecurity(current))
		fs.addFile(current.Node.Environment["GIT_CONFIG_GLOBAL"], 11, roleFileSecurity(current))
	}
	return fs
}

func (fs *fakeFileSystem) addDirectory(path string, mode winfile.SecurityMode, id byte, security winfile.SecurityDescriptorEvidence) {
	fs.nodes[path] = &fakeNode{
		path: path, kind: winfile.ObjectKindDirectory, mode: mode, identity: testIdentity(id),
		security: security, finalPath: `\\?\` + path,
	}
}

func (fs *fakeFileSystem) addFile(path string, id byte, security winfile.SecurityDescriptorEvidence) {
	fs.nodes[path] = &fakeNode{
		path: path, kind: winfile.ObjectKindFile, mode: winfile.SecurityModeRoleDataInherited,
		identity: testIdentity(id), security: security, finalPath: `\\?\` + path,
	}
}

func (fs *fakeFileSystem) openTraversalRoot(path string, options winfile.OpenOptions) (directoryHandle, error) {
	return fs.openDirectory(path, options)
}

func (fs *fakeFileSystem) openDirectory(path string, options winfile.OpenOptions) (directoryHandle, error) {
	node := fs.nodes[path]
	if node == nil || node.kind != winfile.ObjectKindDirectory {
		return nil, fmt.Errorf("directory %s does not exist", path)
	}
	if node.mode != options.SecurityMode || options.VolumeUse != winfile.VolumeUseWritable {
		return nil, errors.New("unexpected fake directory open options")
	}
	fs.opened = append(fs.opened, path)
	return &fakeDirectory{
		fs: fs, node: node, baseline: node.evidence(), enumerationAllowed: options.DirectoryEnumeration,
	}, nil
}

func (fs *fakeFileSystem) openFile(path string, options winfile.OpenOptions) (fileHandle, error) {
	node := fs.nodes[path]
	if node == nil || node.kind != winfile.ObjectKindFile {
		return nil, fmt.Errorf("file %s does not exist", path)
	}
	if node.mode != options.SecurityMode || options.VolumeUse != winfile.VolumeUseWritable {
		return nil, errors.New("unexpected fake file open options")
	}
	fs.opened = append(fs.opened, path)
	return &fakeFile{node: node, baseline: node.evidence()}, nil
}

func (node *fakeNode) evidence() winfile.Evidence {
	attributes := uint32(0x00000080)
	if node.kind == winfile.ObjectKindDirectory {
		attributes = 0x00000010
	}
	return winfile.Evidence{
		Kind: node.kind, Identity: node.identity, Attributes: attributes, LinkCount: 1,
		Path: winfile.PathEvidence{
			RequestedPath: node.path, TerminalComponentReparseFree: true,
			Ancestors: winfile.AncestorValidationNotPerformed, FinalPathDiagnostic: node.finalPath,
		},
		Volume: winfile.VolumeEvidence{
			FileSystem: "NTFS", FileSystemFlags: 0x00000008, HandleSerialNumber: 1,
			PathSerialNumber: 1, VolumePath: `C:\`, DriveType: 3, PersistentACLs: true,
			RequiredUse: winfile.VolumeUseWritable, PathIdentityCrossCheck: true,
		},
		SecurityMode: node.mode, Security: cloneSecurity(node.security),
	}
}

type fakeDirectory struct {
	fs                 *fakeFileSystem
	node               *fakeNode
	baseline           winfile.Evidence
	enumerationAllowed bool
	closed             bool
}

func (directory *fakeDirectory) Evidence() winfile.Evidence {
	return cloneWinfileEvidence(directory.baseline)
}
func (directory *fakeDirectory) OpenDirectoryComponent(component string, options winfile.OpenOptions) (directoryHandle, error) {
	if directory.closed {
		return nil, winfile.ErrClosed
	}
	return directory.fs.openDirectory(joinPath(directory.node.path, component), options)
}
func (directory *fakeDirectory) OpenFileComponent(component string, options winfile.OpenOptions) (fileHandle, error) {
	if directory.closed {
		return nil, winfile.ErrClosed
	}
	return directory.fs.openFile(joinPath(directory.node.path, component), options)
}
func (directory *fakeDirectory) Enumerate(options winfile.DirectoryEnumerationOptions) (winfile.DirectoryEnumeration, error) {
	if directory.closed {
		return winfile.DirectoryEnumeration{}, winfile.ErrClosed
	}
	if !directory.enumerationAllowed || options.MaximumEntries == 0 {
		return winfile.DirectoryEnumeration{}, winfile.ErrInvalidOptions
	}
	prefix := directory.node.path
	if len(prefix) != 3 {
		prefix += `\`
	}
	entries := make([]winfile.DirectoryEntry, 0)
	for path, node := range directory.fs.nodes {
		if !strings.HasPrefix(path, prefix) {
			continue
		}
		relative := strings.TrimPrefix(path, prefix)
		if relative == "" || strings.Contains(relative, `\`) {
			continue
		}
		entries = append(entries, winfile.DirectoryEntry{
			Name: relative, Kind: node.kind, Identity: node.identity,
		})
	}
	if uint32(len(entries)) > options.MaximumEntries {
		return winfile.DirectoryEnumeration{}, winfile.ErrDirectoryBudget
	}
	return winfile.DirectoryEnumeration{Entries: entries}, nil
}
func (directory *fakeDirectory) VerifyUnchanged() error {
	if directory.closed {
		return winfile.ErrClosed
	}
	if directory.node.changed || directory.node.identity != directory.baseline.Identity {
		return winfile.ErrObjectChanged
	}
	return nil
}
func (directory *fakeDirectory) ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error) {
	if directory.closed {
		return winfile.SecurityDescriptorEvidence{}, winfile.ErrClosed
	}
	return cloneSecurity(directory.node.security), nil
}
func (directory *fakeDirectory) ReinspectDataStreams() ([]winfile.DataStream, error) {
	return nil, directory.node.streamErr
}
func (directory *fakeDirectory) ReinspectCaseSensitivity() (bool, error) {
	if directory.closed {
		return false, winfile.ErrClosed
	}
	return directory.node.caseSensitive, nil
}
func (directory *fakeDirectory) Close() error {
	if directory.closed {
		return nil
	}
	if directory.node.closeFailures > 0 {
		directory.node.closeFailures--
		return errors.New("fixture close failure")
	}
	directory.closed = true
	return nil
}

type fakeFile struct {
	node     *fakeNode
	baseline winfile.Evidence
	closed   bool
}

func (file *fakeFile) Evidence() winfile.Evidence { return cloneWinfileEvidence(file.baseline) }
func (file *fakeFile) VerifyUnchanged() error {
	if file.closed {
		return winfile.ErrClosed
	}
	if file.node.changed || file.node.identity != file.baseline.Identity {
		return winfile.ErrObjectChanged
	}
	return nil
}
func (file *fakeFile) ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error) {
	if file.closed {
		return winfile.SecurityDescriptorEvidence{}, winfile.ErrClosed
	}
	return cloneSecurity(file.node.security), nil
}
func (file *fakeFile) ReinspectDataStreams() ([]winfile.DataStream, error) {
	return nil, file.node.streamErr
}
func (file *fakeFile) Close() error {
	if file.closed {
		return nil
	}
	if file.node.closeFailures > 0 {
		file.node.closeFailures--
		return errors.New("fixture close failure")
	}
	file.closed = true
	return nil
}

func pairedConfigs() (config.Config, config.Config) {
	control := baseConfig(config.RoleControl)
	executor := baseConfig(config.RoleExecutor)
	return control, executor
}

func baseConfig(role config.Role) config.Config {
	controlService := config.ServiceIdentity{Name: config.ControlServiceName, SID: config.ControlServiceSID}
	executorService := config.ServiceIdentity{Name: config.ExecutorServiceName, SID: config.ExecutorServiceSID}
	root := testControlRoot
	bundle := `app\control.mjs`
	own, peer := controlService, executorService
	if role == config.RoleExecutor {
		root = testExecutorRoot
		bundle = `app\executor.mjs`
		own, peer = peer, own
	}
	environment := map[string]string{
		"NODE_ENV": "production", "PATH": testInstallationRoot + `\runtime`, "SYSTEMROOT": `C:\Windows`,
		"TEMP": root + `\Temp`, "TMP": root + `\Temp`, "USERPROFILE": root + `\Profile`,
		"APPDATA": root + `\Profile\AppData`, "LOCALAPPDATA": root + `\Profile\LocalAppData`,
	}
	value := config.Config{
		SchemaVersion: config.SchemaVersion, Role: role, WorkerNodeID: "powertoys-node:01",
		OwnService: own, PeerService: peer,
		PipeName: config.ControlExecutorPipeName,
		Installation: config.Installation{
			Root: testInstallationRoot, TrustedConfigurationRoot: testTrustedRoot,
			ReleaseID: "worker-2026.08.31.1", ManifestPath: testInstallationRoot + `\release-manifest.json`,
			ManifestSHA256: strings.Repeat("a", 64),
			ApprovedAuthenticodeSignerCertificateDERSHA256: strings.Repeat("d", 64),
		},
		Node: config.Node{
			ExecutablePath: testInstallationRoot + `\runtime\node.exe`, ExecutableSHA256: strings.Repeat("b", 64),
			BundlePath: testInstallationRoot + `\` + bundle, BundleSHA256: strings.Repeat("c", 64),
			DataRoot: root, WorkingDirectory: root + `\Work`, Environment: environment,
		},
		Limits: config.Limits{
			RootJobMaximumProcesses: 16, RootJobMaximumMemoryBytes: "1073741824",
			MaximumFrameBytes: config.MaximumFrameBytes, MaximumQueuedBytesPerDirection: 4 * 1024 * 1024,
			ConnectTimeoutMilliseconds: 30_000, ShutdownTimeoutMilliseconds: 120_000,
			ForceTerminationReserveMilliseconds: 15_000,
		},
	}
	if role == config.RoleControl {
		value.Control = &config.ControlConfiguration{
			ServerOrigin: "https://review.example.test", ServerName: "review.example.test",
			RootCertificatePath: testTrustedRoot + `\server-root.cer`, RootCertificateSHA256: strings.Repeat("e", 64),
			ClientCertificateStore: config.WindowsCertificateStore, ClientCertificateDERSHA256: strings.Repeat("f", 64),
			ClientPrivateKeySecurityDescriptorSHA256:  strings.Repeat("0", 64),
			LocalAuthorityCNGKeyName:                  "AgenticReview.Worker.Control.LocalAuthority",
			LocalAuthorityKeySecurityDescriptorSHA256: strings.Repeat("9", 64),
			LocalAuthorityPublicKeySHA256:             strings.Repeat("1", 64),
		}
	} else {
		environment["HOME"] = environment["USERPROFILE"]
		environment["CODEX_HOME"] = root + `\Codex`
		environment["GIT_CONFIG_GLOBAL"] = environment["HOME"] + `\.gitconfig`
		environment["GIT_CONFIG_NOSYSTEM"] = "1"
		environment["GIT_TERMINAL_PROMPT"] = "0"
		environment["GCM_INTERACTIVE"] = "never"
		value.Executor = &config.ExecutorConfiguration{
			LocalAuthorityPublicKeyPath:   testTrustedRoot + `\local-authority.spki`,
			LocalAuthorityPublicKeySHA256: strings.Repeat("1", 64),
			CodexPolicyPath:               testTrustedRoot + `\codex-requirements.toml`, CodexPolicySHA256: strings.Repeat("2", 64),
			ProcessHostPath: testInstallationRoot + `\bin\AgenticReview.ProcessHost.exe`, ProcessHostSHA256: strings.Repeat("3", 64),
		}
	}
	return value
}

func fakeInstallationSnapshot(role config.Role, control, executor config.Config) installationSnapshot {
	return installationSnapshot{
		role: role, control: cloneConfig(control), executor: cloneConfig(executor),
		installDirectories: map[string]struct{}{
			testInstallationRoot + `\runtime`: {},
			testInstallationRoot + `\bin`:     {},
		},
		roots: []InstallationRootBinding{
			{
				root: releasemanifest.RootInstallation, path: testInstallationRoot,
				ancestorPaths: []string{`C:\`, `C:\Program Files`, `C:\Program Files\AgenticReview`},
				ancestors:     []winfile.FileIdentity{testIdentity(1), testIdentity(20), testIdentity(21)}, target: testIdentity(22),
			},
			{
				root: releasemanifest.RootTrustedConfiguration, path: testTrustedRoot,
				ancestorPaths: []string{`C:\`, `C:\ProgramData`, `C:\ProgramData\AgenticReview`},
				ancestors:     []winfile.FileIdentity{testIdentity(1), testIdentity(2), testIdentity(3)}, target: testIdentity(30),
			},
		},
	}
}

func testIdentity(value byte) winfile.FileIdentity {
	var id [16]byte
	id[0] = value
	return winfile.FileIdentity{VolumeSerialNumber: 1, FileID: id}
}

func ambientSecurity() winfile.SecurityDescriptorEvidence {
	return buildSecurityDescriptor(false, []testACE{
		{mask: testFileAll, sid: testSystemSID}, {mask: testFileAll, sid: testAdministratorsSID},
	})
}

func productAnchorSecurity() winfile.SecurityDescriptorEvidence {
	return buildSecurityDescriptor(true, []testACE{
		{mask: testFileAll, sid: testSystemSID}, {mask: testFileAll, sid: testAdministratorsSID},
		{mask: testDirectoryRead, sid: config.ControlServiceSID}, {mask: testDirectoryRead, sid: config.ExecutorServiceSID},
	})
}

func roleDirectorySecurity(current config.Config) winfile.SecurityDescriptorEvidence {
	return buildSecurityDescriptor(true, []testACE{
		{flags: 0x03, mask: testFileAll, sid: testSystemSID},
		{flags: 0x03, mask: testFileAll, sid: testAdministratorsSID},
		{mask: testBoundaryDirectoryModify, sid: current.OwnService.SID},
		{flags: 0x09, mask: testFileModify, sid: current.OwnService.SID},
		{flags: 0x0a, mask: testDirectoryModify, sid: current.OwnService.SID},
		{flags: 0x0b, mask: testReadControl, sid: testOwnerRightsSID},
	})
}

func inheritedDirectorySecurity(current config.Config) winfile.SecurityDescriptorEvidence {
	return buildInheritedSecurityDescriptor(current.OwnService.SID, []testACE{
		{flags: 0x13, mask: testFileAll, sid: testSystemSID},
		{flags: 0x13, mask: testFileAll, sid: testAdministratorsSID},
		{flags: 0x19, mask: testFileModify, sid: current.OwnService.SID},
		{flags: 0x12, mask: testDirectoryModify, sid: current.OwnService.SID},
		{flags: 0x13, mask: testReadControl, sid: testOwnerRightsSID},
	})
}

func roleFileSecurity(current config.Config) winfile.SecurityDescriptorEvidence {
	return buildInheritedSecurityDescriptor(current.OwnService.SID, []testACE{
		{flags: 0x10, mask: testFileAll, sid: testSystemSID},
		{flags: 0x10, mask: testFileAll, sid: testAdministratorsSID},
		{flags: 0x10, mask: testFileModify, sid: current.OwnService.SID},
		{flags: 0x10, mask: testReadControl, sid: testOwnerRightsSID},
	})
}

func buildInheritedSecurityDescriptor(ownerSID string, entries []testACE) winfile.SecurityDescriptorEvidence {
	result := buildSecurityDescriptorFor(ownerSID, ownerSID, false, true, entries)
	result.OwnerDefaulted = true
	result.GroupDefaulted = true
	result.DACLDefaulted = true
	result.Control |= 0x0001 | 0x0002 | 0x0008
	binary.LittleEndian.PutUint16(result.SelfRelativeDescriptor[2:4], result.Control)
	return result
}

func buildSecurityDescriptor(protected bool, entries []testACE) winfile.SecurityDescriptorEvidence {
	return buildSecurityDescriptorFor(testSystemSID, testAdministratorsSID, protected, false, entries)
}

func buildSecurityDescriptorFor(ownerSID, groupSID string, protected, autoInherited bool, entries []testACE) winfile.SecurityDescriptorEvidence {
	owner := encodeTestSID(ownerSID)
	group := encodeTestSID(groupSID)
	daclSize := 8
	encoded := make([][]byte, len(entries))
	for index, entry := range entries {
		sid := encodeTestSID(entry.sid)
		ace := make([]byte, 8+len(sid))
		ace[1] = entry.flags
		binary.LittleEndian.PutUint16(ace[2:4], uint16(len(ace)))
		binary.LittleEndian.PutUint32(ace[4:8], uint32(entry.mask))
		copy(ace[8:], sid)
		encoded[index] = ace
		daclSize += len(ace)
	}
	dacl := make([]byte, daclSize)
	dacl[0] = 2
	binary.LittleEndian.PutUint16(dacl[2:4], uint16(daclSize))
	binary.LittleEndian.PutUint16(dacl[4:6], uint16(len(entries)))
	offset := 8
	for _, ace := range encoded {
		copy(dacl[offset:], ace)
		offset += len(ace)
	}
	ownerOffset := 20
	groupOffset := ownerOffset + len(owner)
	daclOffset := groupOffset + len(group)
	raw := make([]byte, daclOffset+len(dacl))
	raw[0] = 1
	control := uint16(0x8004)
	if protected {
		control |= 0x1000
	}
	if autoInherited {
		control |= 0x0400
	}
	binary.LittleEndian.PutUint16(raw[2:4], control)
	binary.LittleEndian.PutUint32(raw[4:8], uint32(ownerOffset))
	binary.LittleEndian.PutUint32(raw[8:12], uint32(groupOffset))
	binary.LittleEndian.PutUint32(raw[16:20], uint32(daclOffset))
	copy(raw[ownerOffset:], owner)
	copy(raw[groupOffset:], group)
	copy(raw[daclOffset:], dacl)
	return winfile.SecurityDescriptorEvidence{
		OwnerSID: ownerSID, GroupSID: groupSID, DACLPresent: true,
		DACLProtected: protected, Control: control, Revision: 1, SelfRelativeDescriptor: raw,
	}
}

func encodeTestSID(value string) []byte {
	parts := strings.Split(value, "-")
	authority, _ := strconv.ParseUint(parts[2], 10, 48)
	result := make([]byte, 8+4*(len(parts)-3))
	result[0] = 1
	result[1] = byte(len(parts) - 3)
	for index := 0; index < 6; index++ {
		result[2+index] = byte(authority >> uint(8*(5-index)))
	}
	for index, part := range parts[3:] {
		value, _ := strconv.ParseUint(part, 10, 32)
		binary.LittleEndian.PutUint32(result[8+index*4:12+index*4], uint32(value))
	}
	return result
}

func cloneSecurity(value winfile.SecurityDescriptorEvidence) winfile.SecurityDescriptorEvidence {
	value.SelfRelativeDescriptor = append([]byte(nil), value.SelfRelativeDescriptor...)
	return value
}
