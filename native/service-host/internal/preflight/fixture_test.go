package preflight

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"strconv"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

const (
	testInstallationRoot = `C:\Program Files\AgenticReview\Worker`
	testTrustedRoot      = `C:\ProgramData\AgenticReview\TrustedConfig`
)

type compositionFixture struct {
	input        snapshotInput
	control      config.Config
	executor     config.Config
	manifest     releasemanifest.Manifest
	installation *installationSnapshot
	factory      *objectFactory
}

func newCompositionFixture(t *testing.T, role config.Role) compositionFixture {
	t.Helper()
	manifest := productionManifestFixture()
	manifestBytes, err := releasemanifest.MarshalCanonical(manifest)
	if err != nil {
		t.Fatalf("MarshalCanonical manifest fixture: %v", err)
	}
	parsedManifest, err := releasemanifest.Parse(manifestBytes)
	if err != nil {
		t.Fatalf("Parse manifest fixture: %v", err)
	}
	manifestDigest := sha256.Sum256(manifestBytes)
	control, executor := configurationFixtures(hexDigest(manifestDigest), parsedManifest)

	factory := newObjectFactory()
	installationRootObject := factory.directory(testInstallationRoot)
	trustedRootObject := factory.directory(testTrustedRoot)
	controlBytes := mustConfigurationBytes(t, control)
	executorBytes := mustConfigurationBytes(t, executor)
	controlRead := factory.read(
		testTrustedRoot+`\`+releasemanifest.ControlBootstrapConfigurationPath,
		controlBytes,
	)
	executorRead := factory.read(
		testTrustedRoot+`\`+releasemanifest.ExecutorBootstrapConfigurationPath,
		executorBytes,
	)
	manifestRead := factory.read(testInstallationRoot+`\release-manifest.json`, manifestBytes)

	verifiedFiles := make([]VerifiedFile, 0, len(parsedManifest.Files))
	for _, file := range parsedManifest.Files {
		root := testInstallationRoot
		if file.Root == releasemanifest.RootTrustedConfiguration {
			root = testTrustedRoot
		}
		size, parseErr := strconv.ParseUint(file.Size, 10, 64)
		if parseErr != nil {
			t.Fatalf("parse manifest fixture size: %v", parseErr)
		}
		absolute := root + `\` + file.Path
		verifiedFiles = append(verifiedFiles, VerifiedFile{
			Root: file.Root, Path: file.Path, AbsolutePath: absolute,
			Role: file.Role, SHA256: file.SHA256, Size: size,
			Object: factory.file(absolute, size),
		})
	}
	installation := &installationSnapshot{
		role:                role,
		actualBootstrapPath: controlRead.File.Path,
		controlBootstrap:    controlRead,
		executorBootstrap:   executorRead,
		controlConfig:       cloneConfig(control),
		executorConfig:      cloneConfig(executor),
		manifestRead:        manifestRead,
		manifest:            cloneManifest(parsedManifest),
		approvedSignerPin:   control.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256,
		roots: []VerifiedRoot{
			{Root: releasemanifest.RootInstallation, Path: testInstallationRoot, Object: installationRootObject},
			{Root: releasemanifest.RootTrustedConfiguration, Path: testTrustedRoot, Object: trustedRootObject},
		},
		files: verifiedFiles,
	}
	profile := profileFixture(parsedManifest)
	input := snapshotInput{
		role: role, actualBootstrapPath: controlRead.File.Path,
		installation: installation, releaseProfile: profile,
	}
	if role == config.RoleControl {
		input.credentials = &ControlCredentialEvidence{bound: true}
	} else {
		input.actualBootstrapPath = executorRead.File.Path
		installation.actualBootstrapPath = executorRead.File.Path
	}
	return compositionFixture{
		input: input, control: control, executor: executor,
		manifest: parsedManifest, installation: installation, factory: factory,
	}
}

func productionManifestFixture() releasemanifest.Manifest {
	files := []releasemanifest.File{
		manifestFixtureFile(releasemanifest.RootInstallation, `runtime\node.exe`, releasemanifest.RoleNodeRuntime, "1"),
		manifestFixtureFile(releasemanifest.RootInstallation, `AgenticReview.Worker.Control.exe`, releasemanifest.RoleServiceWrapper, "2"),
		manifestFixtureFile(releasemanifest.RootInstallation, `AgenticReview.Worker.Executor.exe`, releasemanifest.RoleServiceWrapper, "3"),
		manifestFixtureFile(releasemanifest.RootInstallation, `native\AgenticReview.ServiceHost.exe`, releasemanifest.RoleServiceHost, "4"),
		manifestFixtureFile(releasemanifest.RootInstallation, `app\control.mjs`, releasemanifest.RoleControlBundle, "5"),
		manifestFixtureFile(releasemanifest.RootInstallation, `app\executor.mjs`, releasemanifest.RoleExecutorBundle, "6"),
		manifestFixtureFile(releasemanifest.RootInstallation, `native\AgenticReview.ProcessHost.exe`, releasemanifest.RoleProcessHost, "7"),
		manifestFixtureFile(releasemanifest.RootInstallation, `codex\codex.exe`, releasemanifest.RoleCodexCLI, "8"),
		manifestFixtureFile(releasemanifest.RootInstallation, `git\cmd\git.exe`, releasemanifest.RoleGitCLI, "9"),
		manifestFixtureFile(releasemanifest.RootInstallation, `service\control.xml`, releasemanifest.RoleServiceConfig, "a"),
		manifestFixtureFile(releasemanifest.RootInstallation, `service\executor.xml`, releasemanifest.RoleServiceConfig, "b"),
		manifestFixtureFile(releasemanifest.RootInstallation, `git\mingw64\bin\git-remote-https.exe`, releasemanifest.RoleGitHelper, "c"),
		manifestFixtureFile(releasemanifest.RootInstallation, `codex\runtime\codex-runtime.dll`, releasemanifest.RoleCodexRuntime, "d"),
		manifestFixtureFile(releasemanifest.RootInstallation, `git\mingw64\bin\libcurl.dll`, releasemanifest.RoleNativeLibrary, "e"),
		manifestFixtureFile(releasemanifest.RootInstallation, `git\mingw64\ssl\cert.pem`, releasemanifest.RoleCABundle, "f"),
		manifestFixtureFile(releasemanifest.RootTrustedConfiguration, `server-root.cer`, releasemanifest.RoleCABundle, "0"),
		manifestFixtureFile(releasemanifest.RootTrustedConfiguration, `local-authority.spki`, releasemanifest.RoleTrustedConfig, "1"),
		manifestFixtureFile(releasemanifest.RootTrustedConfiguration, `codex-requirements.toml`, releasemanifest.RolePolicy, "2"),
		manifestFixtureFile(releasemanifest.RootTrustedConfiguration, `pull-request-review-v1.md`, releasemanifest.RolePrompt, "3"),
		manifestFixtureFile(releasemanifest.RootTrustedConfiguration, `schemas\review-result-v1.json`, releasemanifest.RoleSchema, "4"),
		manifestFixtureFile(releasemanifest.RootTrustedConfiguration, `recipes\static-review-v1.toml`, releasemanifest.RoleRecipe, "5"),
		manifestFixtureFile(releasemanifest.RootInstallation, `runtime\data\icudtl.dat`, releasemanifest.RoleRuntimeData, "6"),
		manifestFixtureFile(releasemanifest.RootTrustedConfiguration, `policy\repository-allowlist.json`, releasemanifest.RolePolicy, "7"),
		manifestFixtureFile(releasemanifest.RootTrustedConfiguration, `keys\secondary-authority.spki`, releasemanifest.RoleTrustedConfig, "8"),
		manifestFixtureFile(releasemanifest.RootInstallation, `LICENSE.txt`, releasemanifest.RoleLicense, "9"),
	}
	return releasemanifest.Manifest{
		Compatibility:   releasemanifest.RequiredCompatibility(),
		Files:           files,
		PublisherPolicy: releasemanifest.PublisherPolicy,
		ReleaseID:       "worker-2026.08.31.1",
		SchemaVersion:   releasemanifest.SchemaVersion,
	}
}

func manifestFixtureFile(
	root releasemanifest.FileRoot,
	path string,
	role releasemanifest.FileRole,
	digestByte string,
) releasemanifest.File {
	return releasemanifest.File{Root: root, Path: path, Role: role, SHA256: strings.Repeat(digestByte, 64), Size: "1"}
}

func configurationFixtures(
	manifestDigest string,
	manifest releasemanifest.Manifest,
) (config.Config, config.Config) {
	node := requireManifestFixture(manifest, releasemanifest.RoleNodeRuntime, `runtime\node.exe`)
	controlBundle := requireManifestFixture(manifest, releasemanifest.RoleControlBundle, `app\control.mjs`)
	executorBundle := requireManifestFixture(manifest, releasemanifest.RoleExecutorBundle, `app\executor.mjs`)
	rootCA := requireManifestFixture(manifest, releasemanifest.RoleCABundle, `server-root.cer`)
	spki := requireManifestFixture(manifest, releasemanifest.RoleTrustedConfig, `local-authority.spki`)
	policy := requireManifestFixture(manifest, releasemanifest.RolePolicy, `codex-requirements.toml`)
	processHost := requireManifestFixture(manifest, releasemanifest.RoleProcessHost, `native\AgenticReview.ProcessHost.exe`)
	control := config.Config{
		SchemaVersion: config.SchemaVersion,
		Role:          config.RoleControl,
		OwnService:    config.ServiceIdentity{Name: config.ControlServiceName, SID: config.ControlServiceSID},
		PeerService:   config.ServiceIdentity{Name: config.ExecutorServiceName, SID: config.ExecutorServiceSID},
		PipeName:      config.ControlExecutorPipeName,
		Installation: config.Installation{
			Root: testInstallationRoot, TrustedConfigurationRoot: testTrustedRoot,
			ReleaseID: manifest.ReleaseID, ManifestPath: testInstallationRoot + `\release-manifest.json`,
			ManifestSHA256: manifestDigest,
			ApprovedAuthenticodeSignerCertificateDERSHA256: strings.Repeat("4", 64),
		},
		Node: nodeConfiguration(
			config.RoleControl,
			node,
			controlBundle,
			`C:\ProgramData\AgenticReview\Control`,
		),
		Control: &config.ControlConfiguration{
			ServerOrigin: "https://review.example.test", ServerName: "review.example.test",
			RootCertificatePath:                       testTrustedRoot + `\` + rootCA.Path,
			RootCertificateSHA256:                     rootCA.SHA256,
			ClientCertificateStore:                    config.WindowsCertificateStore,
			ClientCertificateDERSHA256:                strings.Repeat("5", 64),
			ClientPrivateKeySecurityDescriptorSHA256:  strings.Repeat("6", 64),
			LocalAuthorityCNGKeyName:                  "AgenticReview.Worker.Control.LocalAuthority",
			LocalAuthorityKeySecurityDescriptorSHA256: strings.Repeat("7", 64),
			LocalAuthorityPublicKeySHA256:             spki.SHA256,
		},
		Limits: limitsFixture(),
	}
	executor := control
	executor.Role = config.RoleExecutor
	executor.OwnService, executor.PeerService = control.PeerService, control.OwnService
	executor.Node = nodeConfiguration(
		config.RoleExecutor,
		node,
		executorBundle,
		`C:\ProgramData\AgenticReview\Executor`,
	)
	executor.Control = nil
	executor.Executor = &config.ExecutorConfiguration{
		LocalAuthorityPublicKeyPath:   testTrustedRoot + `\` + spki.Path,
		LocalAuthorityPublicKeySHA256: spki.SHA256,
		CodexPolicyPath:               testTrustedRoot + `\` + policy.Path,
		CodexPolicySHA256:             policy.SHA256,
		ProcessHostPath:               testInstallationRoot + `\` + processHost.Path,
		ProcessHostSHA256:             processHost.SHA256,
	}
	return control, executor
}

func nodeConfiguration(role config.Role, node releasemanifest.File, bundle releasemanifest.File, dataRoot string) config.Node {
	result := config.Node{
		ExecutablePath: testInstallationRoot + `\` + node.Path, ExecutableSHA256: node.SHA256,
		BundlePath: testInstallationRoot + `\` + bundle.Path, BundleSHA256: bundle.SHA256,
		DataRoot: dataRoot, WorkingDirectory: dataRoot + `\Work`,
		Environment: map[string]string{
			"APPDATA": dataRoot + `\Profile\AppData`, "LOCALAPPDATA": dataRoot + `\Profile\LocalAppData`,
			"NODE_ENV": "production", "PATH": testInstallationRoot + `\runtime`,
			"SYSTEMROOT": `C:\Windows`, "TEMP": dataRoot + `\Temp`, "TMP": dataRoot + `\Temp`,
			"USERPROFILE": dataRoot + `\Profile`,
		},
	}
	if role == config.RoleExecutor {
		result.Environment["HOME"] = dataRoot + `\Profile`
		result.Environment["CODEX_HOME"] = dataRoot + `\Codex`
		result.Environment["GIT_CONFIG_GLOBAL"] = dataRoot + `\Profile\.gitconfig`
		result.Environment["GIT_CONFIG_NOSYSTEM"] = "1"
		result.Environment["GIT_TERMINAL_PROMPT"] = "0"
		result.Environment["GCM_INTERACTIVE"] = "never"
	}
	return result
}

func limitsFixture() config.Limits {
	return config.Limits{
		RootJobMaximumProcesses: 128, RootJobMaximumMemoryBytes: "17179869184",
		MaximumFrameBytes: config.MaximumFrameBytes, MaximumQueuedBytesPerDirection: 4 * 1024 * 1024,
		ConnectTimeoutMilliseconds: 30_000, ShutdownTimeoutMilliseconds: 120_000,
	}
}

func profileFixture(manifest releasemanifest.Manifest) ReleaseProfile {
	dependencies := make([]releasemanifest.FileBindingRequirement, len(manifest.Files))
	for index, file := range manifest.Files {
		dependencies[index] = releasemanifest.FileBindingRequirement{
			Root: file.Root, Path: file.Path, Role: file.Role, SHA256: file.SHA256,
		}
	}
	return ReleaseProfile{
		ID:           ProductionProfileID,
		Dependencies: dependencies,
	}
}

func requireManifestFixture(
	manifest releasemanifest.Manifest,
	role releasemanifest.FileRole,
	path string,
) releasemanifest.File {
	for _, file := range manifest.Files {
		if file.Role == role && strings.EqualFold(file.Path, path) {
			return file
		}
	}
	panic("manifest fixture file is missing: " + path)
}

func mustConfigurationBytes(t *testing.T, value config.Config) []byte {
	t.Helper()
	document, err := config.MarshalCanonical(value)
	if err != nil {
		t.Fatalf("MarshalCanonical configuration fixture: %v", err)
	}
	return document
}

func replaceConfigurationRead(t *testing.T, read *secureconfig.Result, value config.Config) {
	t.Helper()
	read.Data = mustConfigurationBytes(t, value)
	read.ContentSHA256 = secureconfig.Digest(sha256.Sum256(read.Data))
	read.File.Evidence.Size = uint64(len(read.Data))
	canonical, err := secureconfig.NewObjectEvidenceForMode(
		read.File.Path,
		read.File.Evidence.SecurityMode,
		read.File.Evidence,
	)
	if err != nil {
		t.Fatalf("rebuild configuration file evidence: %v", err)
	}
	read.File = canonical
}

func rebuildObjectEvidence(t *testing.T, object *secureconfig.ObjectEvidence) {
	t.Helper()
	canonical, err := secureconfig.NewObjectEvidenceForMode(
		object.Path,
		object.Evidence.SecurityMode,
		object.Evidence,
	)
	if err != nil {
		t.Fatalf("rebuild object evidence: %v", err)
	}
	*object = canonical
}

type objectFactory struct {
	next    uint64
	volume  uint64
	objects map[string]secureconfig.ObjectEvidence
}

func newObjectFactory() *objectFactory {
	return &objectFactory{next: 1, volume: 0x1020304050607080, objects: make(map[string]secureconfig.ObjectEvidence)}
}

func (f *objectFactory) directory(path string) secureconfig.ObjectEvidence {
	return f.object(path, winfile.ObjectKindDirectory, 0)
}

func (f *objectFactory) file(path string, size uint64) secureconfig.ObjectEvidence {
	return f.object(path, winfile.ObjectKindFile, size)
}

func (f *objectFactory) object(path string, kind winfile.ObjectKind, size uint64) secureconfig.ObjectEvidence {
	key := strings.ToLower(path)
	if existing, ok := f.objects[key]; ok {
		return cloneObject(existing)
	}
	id := f.next
	f.next++
	var fileID [16]byte
	binary.LittleEndian.PutUint64(fileID[:8], id)
	descriptor := []byte{1, byte(id), byte(id >> 8), 0x7f}
	linkCount := uint32(0)
	if kind == winfile.ObjectKindFile {
		linkCount = 1
	}
	evidence := winfile.Evidence{
		Kind: kind, Identity: winfile.FileIdentity{VolumeSerialNumber: f.volume, FileID: fileID},
		Size: size, LinkCount: linkCount,
		SecurityMode: winfile.SecurityModeManaged,
		Path: winfile.PathEvidence{
			RequestedPath: path, TerminalComponentReparseFree: true,
			Ancestors: winfile.AncestorValidationNotPerformed,
		},
		Volume: winfile.VolumeEvidence{
			FileSystem: "NTFS", FileSystemFlags: 0x00000008,
			HandleSerialNumber: 0x10203040, PathSerialNumber: 0x10203040,
			DriveType: 3, PersistentACLs: true, RequiredUse: winfile.VolumeUseReadOnly,
			PathIdentityCrossCheck: true,
		},
		Security: winfile.SecurityDescriptorEvidence{
			OwnerSID: "S-1-5-18", GroupSID: "S-1-5-32-544",
			DACLPresent: true, DACLProtected: true, Control: 0x9004, Revision: 1,
			SelfRelativeDescriptor: descriptor,
		},
	}
	result, err := secureconfig.NewObjectEvidence(path, evidence)
	if err != nil {
		panic(err)
	}
	f.objects[key] = cloneObject(result)
	return result
}

func (f *objectFactory) read(path string, data []byte) secureconfig.Result {
	ancestors := ancestorPaths(path)
	objects := make([]secureconfig.ObjectEvidence, len(ancestors))
	for index, ancestor := range ancestors {
		objects[index] = f.directory(ancestor)
	}
	bytes := append([]byte(nil), data...)
	return secureconfig.Result{
		Data: bytes, ContentSHA256: secureconfig.Digest(sha256.Sum256(bytes)),
		File: f.file(path, uint64(len(bytes))), Ancestors: objects,
	}
}

func ancestorPaths(path string) []string {
	components := strings.Split(path[3:], `\`)
	result := []string{path[:3]}
	current := path[:3]
	for _, component := range components[:len(components)-1] {
		if len(current) == 3 {
			current += component
		} else {
			current += `\` + component
		}
		result = append(result, current)
	}
	return result
}

func mustDecodeDigest(t *testing.T, value string) [sha256.Size]byte {
	t.Helper()
	decoded, err := hexDecode(value)
	if err != nil {
		t.Fatal(err)
	}
	var result [sha256.Size]byte
	copy(result[:], decoded)
	return result
}

func hexDecode(value string) ([]byte, error) {
	if len(value)%2 != 0 {
		return nil, fmt.Errorf("invalid hexadecimal length")
	}
	result := make([]byte, len(value)/2)
	for index := range result {
		high, ok := hexNibble(value[index*2])
		if !ok {
			return nil, fmt.Errorf("invalid hexadecimal digit")
		}
		low, ok := hexNibble(value[index*2+1])
		if !ok {
			return nil, fmt.Errorf("invalid hexadecimal digit")
		}
		result[index] = high<<4 | low
	}
	return result, nil
}

func hexNibble(value byte) (byte, bool) {
	switch {
	case value >= '0' && value <= '9':
		return value - '0', true
	case value >= 'a' && value <= 'f':
		return value - 'a' + 10, true
	default:
		return 0, false
	}
}

func hexDigest(value [sha256.Size]byte) string { return fmt.Sprintf("%x", value) }
