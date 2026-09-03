package installverify

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winidentity"
)

const (
	testInstallationRoot = `C:\Program Files\AgenticReview\Worker`
	testTrustedRoot      = `C:\ProgramData\AgenticReview\TrustedConfig`
	testSignerDigest     = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
)

func TestVerifyWithDependenciesProducesOpaqueDetachedEvidence(t *testing.T) {
	fixture := newInstallFixture(t)
	evidence, err := verifyWithDependencies(context.Background(), fixture.options, fixture.authority, fixture.dependencies())
	if err != nil {
		t.Fatalf("verifyWithDependencies returned an error: %v", err)
	}
	if err := evidence.Validate(); err != nil {
		t.Fatalf("Evidence.Validate rejected successful evidence: %v", err)
	}
	if evidence.Role() != config.RoleControl || evidence.ActualBootstrapPath() != fixture.options.ActualBootstrapPath {
		t.Fatalf("unexpected evidence identity: role=%q path=%q", evidence.Role(), evidence.ActualBootstrapPath())
	}
	roots := evidence.Roots()
	if len(roots) != 2 || len(roots[0].Ancestors()) == 0 || len(roots[1].Ancestors()) == 0 {
		t.Fatalf("root evidence omitted retained ancestor chains: %#v", roots)
	}
	for _, root := range roots {
		if root.Object().Evidence.SecurityMode != winfile.SecurityModeManaged {
			t.Fatalf("managed root reported security mode %d", root.Object().Evidence.SecurityMode)
		}
		ancestors := root.Ancestors()
		if ancestors[0].Evidence.SecurityMode != winfile.SecurityModeAmbientAncestor ||
			ancestors[len(ancestors)-1].Evidence.SecurityMode != winfile.SecurityModeManaged {
			t.Fatalf("root ancestor modes do not transition from ambient to managed: %#v", ancestors)
		}
	}
	if len(evidence.Files()) != len(fixture.manifest.Files) {
		t.Fatalf("verified files = %d, want %d", len(evidence.Files()), len(fixture.manifest.Files))
	}

	control := evidence.ControlConfiguration()
	originalWorkerNodeID := control.WorkerNodeID
	originalReserve := control.Limits.ForceTerminationReserveMilliseconds
	control.WorkerNodeID = "changed-node"
	control.Limits.ForceTerminationReserveMilliseconds++
	control.Node.Environment["PATH"] = `C:\tampered`
	controlAgain := evidence.ControlConfiguration()
	if controlAgain.WorkerNodeID != originalWorkerNodeID ||
		controlAgain.Limits.ForceTerminationReserveMilliseconds != originalReserve ||
		controlAgain.Node.Environment["PATH"] == `C:\tampered` {
		t.Fatal("configuration getter retained caller-owned storage")
	}
	manifest := evidence.Manifest()
	manifest.Files[0].Path = `tampered.exe`
	if evidence.Manifest().Files[0].Path == `tampered.exe` {
		t.Fatal("manifest getter retained caller-owned slice storage")
	}
	identity := evidence.Identity()
	identity.Token.Groups = append(identity.Token.Groups, winidentity.SIDEntry{SID: "S-1-5-18"})
	if len(evidence.Identity().Token.Groups) == len(identity.Token.Groups) {
		t.Fatal("identity getter retained caller-owned slice storage")
	}
	rootObject := roots[0].Object()
	rootObject.Evidence.Security.SelfRelativeDescriptor[0] ^= 0xff
	if roots[0].Object().Evidence.Security.SelfRelativeDescriptor[0] == rootObject.Evidence.Security.SelfRelativeDescriptor[0] {
		t.Fatal("root getter retained caller-owned descriptor storage")
	}
}

func TestVerifyWithDependenciesAcceptsSchemaVersion4BootstrapPair(t *testing.T) {
	fixture := newInstallFixture(t)
	controlPath := testTrustedRoot + `\` + releasemanifest.ControlBootstrapConfigurationPath
	executorPath := testTrustedRoot + `\` + releasemanifest.ExecutorBootstrapConfigurationPath
	control, err := config.Parse(fixture.fs.mustNode(controlPath).data)
	if err != nil {
		t.Fatal(err)
	}
	executor, err := config.Parse(fixture.fs.mustNode(executorPath).data)
	if err != nil {
		t.Fatal(err)
	}
	control.SchemaVersion = config.BearerTokenSchemaVersion
	control.Control.WorkerAuthenticationProfile = config.WorkerAuthenticationProfileBearerTokenV1
	control.Control.ClientCertificateStore = ""
	control.Control.ClientCertificateDERSHA256 = ""
	control.Control.ClientPrivateKeySecurityDescriptorSHA256 = ""
	executor.SchemaVersion = config.BearerTokenSchemaVersion
	fixture.fs.mustNode(controlPath).data = mustConfigDocument(t, control)
	fixture.fs.mustNode(executorPath).data = mustConfigDocument(t, executor)

	evidence, err := verifyWithDependencies(context.Background(), fixture.options, fixture.authority, fixture.dependencies())
	if err != nil {
		t.Fatal(err)
	}
	if evidence.ControlConfiguration().SchemaVersion != config.BearerTokenSchemaVersion ||
		evidence.ExecutorConfiguration().SchemaVersion != config.BearerTokenSchemaVersion {
		t.Fatal("installation evidence omitted the schemaVersion 4 bootstrap pair")
	}
}

func TestVerifyWithDependenciesRejectsSchemaVersion4OutsideInstallerV2DataRoots(t *testing.T) {
	fixture := newInstallFixture(t)
	controlPath := testTrustedRoot + `\` + releasemanifest.ControlBootstrapConfigurationPath
	executorPath := testTrustedRoot + `\` + releasemanifest.ExecutorBootstrapConfigurationPath
	control, err := config.Parse(fixture.fs.mustNode(controlPath).data)
	if err != nil {
		t.Fatal(err)
	}
	executor, err := config.Parse(fixture.fs.mustNode(executorPath).data)
	if err != nil {
		t.Fatal(err)
	}
	control.SchemaVersion = config.BearerTokenSchemaVersion
	control.Control.WorkerAuthenticationProfile = config.WorkerAuthenticationProfileBearerTokenV1
	control.Control.ClientCertificateStore = ""
	control.Control.ClientCertificateDERSHA256 = ""
	control.Control.ClientPrivateKeySecurityDescriptorSHA256 = ""
	executor.SchemaVersion = config.BearerTokenSchemaVersion
	oldRoot := executor.Node.DataRoot
	executor.Node.DataRoot = `D:\AgenticReview\Executor`
	executor.Node.WorkingDirectory = strings.Replace(executor.Node.WorkingDirectory, oldRoot, executor.Node.DataRoot, 1)
	for name, value := range executor.Node.Environment {
		executor.Node.Environment[name] = strings.Replace(value, oldRoot, executor.Node.DataRoot, 1)
	}
	fixture.fs.mustNode(controlPath).data = mustConfigDocument(t, control)
	fixture.fs.mustNode(executorPath).data = mustConfigDocument(t, executor)

	if _, err := verifyWithDependencies(
		context.Background(),
		fixture.options,
		fixture.authority,
		fixture.dependencies(),
	); !errors.Is(err, ErrConfiguration) {
		t.Fatalf("verifyWithDependencies returned %v, want ErrConfiguration", err)
	}
}

func TestVerifyWithDependenciesRejectsClosedTreeAndIdentityViolations(t *testing.T) {
	t.Run("unexpected file", func(t *testing.T) {
		fixture := newInstallFixture(t)
		fixture.fs.addFile(testInstallationRoot+`\unexpected.txt`, []byte("unexpected"))
		assertVerificationError(t, fixture, ErrClosedTree)
	})

	t.Run("reused file identity", func(t *testing.T) {
		fixture := newInstallFixture(t)
		first := fixture.fs.mustNode(testInstallationRoot + `\runtime\node.exe`)
		second := fixture.fs.mustNode(testInstallationRoot + `\` + releaseprofile.ServiceHostRelativePath)
		second.identity = first.identity
		assertVerificationError(t, fixture, ErrFileIdentity)
	})

	t.Run("aliased roots", func(t *testing.T) {
		fixture := newInstallFixture(t)
		fixture.fs.mustNode(testTrustedRoot).identity = fixture.fs.mustNode(testInstallationRoot).identity
		assertVerificationError(t, fixture, ErrFileIdentity)
	})

	t.Run("manifest file content mismatch", func(t *testing.T) {
		fixture := newInstallFixture(t)
		fixture.fs.mustNode(testInstallationRoot + `\runtime\node.exe`).data = []byte("MZ-tampered")
		assertVerificationError(t, fixture, ErrFileContent)
	})

	t.Run("bootstrap changed", func(t *testing.T) {
		fixture := newInstallFixture(t)
		fixture.fs.afterBootstrapReads = func() {
			fixture.fs.mustNode(testTrustedRoot + `\` + releasemanifest.ControlBootstrapConfigurationPath).data = []byte("changed")
		}
		assertVerificationError(t, fixture, ErrClosedTree)
	})
}

func TestVerifyWithDependenciesRejectsSignerAndCleanupFailures(t *testing.T) {
	t.Run("wrong signer", func(t *testing.T) {
		fixture := newInstallFixture(t)
		fixture.signerDigest = strings.Repeat("e", 64)
		assertVerificationError(t, fixture, ErrAuthenticode)
	})

	t.Run("close failure suppresses evidence", func(t *testing.T) {
		fixture := newInstallFixture(t)
		fixture.fs.mustNode(testInstallationRoot + `\runtime\node.exe`).closeFailures = 1
		evidence, err := verifyWithDependencies(context.Background(), fixture.options, fixture.authority, fixture.dependencies())
		if !errors.Is(err, ErrCleanup) {
			t.Fatalf("close failure returned %v, want ErrCleanup", err)
		}
		if evidence.Validate() == nil {
			t.Fatal("close failure returned usable evidence")
		}
	})

	t.Run("final enumeration drift suppresses evidence", func(t *testing.T) {
		fixture := newInstallFixture(t)
		root := fixture.fs.mustNode(testInstallationRoot)
		root.afterEnumerate = func() {
			fixture.fs.addFile(testInstallationRoot+`\late.txt`, []byte("late"))
		}
		evidence, err := verifyWithDependencies(context.Background(), fixture.options, fixture.authority, fixture.dependencies())
		if !errors.Is(err, ErrCleanup) {
			t.Fatalf("enumeration drift returned %v, want ErrCleanup", err)
		}
		if evidence.Validate() == nil {
			t.Fatal("enumeration drift returned usable evidence")
		}
	})
}

func TestValidateConfigurationPairRejectsSharedIdentityAndProtocolLimitMismatches(t *testing.T) {
	fixture := newInstallFixture(t)
	controlDocument := fixture.fs.mustNode(
		testTrustedRoot + `\` + releasemanifest.ControlBootstrapConfigurationPath,
	).data
	executorDocument := fixture.fs.mustNode(
		testTrustedRoot + `\` + releasemanifest.ExecutorBootstrapConfigurationPath,
	).data
	control, err := config.Parse(controlDocument)
	if err != nil {
		t.Fatalf("parse Control fixture: %v", err)
	}
	executor, err := config.Parse(executorDocument)
	if err != nil {
		t.Fatalf("parse Executor fixture: %v", err)
	}
	tests := []struct {
		name   string
		mutate func(*config.Config)
	}{
		{"schema version", func(value *config.Config) { value.SchemaVersion = config.BearerTokenSchemaVersion }},
		{"worker node ID", func(value *config.Config) { value.WorkerNodeID = "powertoys-node:02" }},
		{"maximum frame", func(value *config.Config) { value.Limits.MaximumFrameBytes-- }},
		{"maximum queue", func(value *config.Config) { value.Limits.MaximumQueuedBytesPerDirection++ }},
		{"connect timeout", func(value *config.Config) { value.Limits.ConnectTimeoutMilliseconds++ }},
		{"shutdown total", func(value *config.Config) { value.Limits.ShutdownTimeoutMilliseconds++ }},
		{"force termination reserve", func(value *config.Config) {
			value.Limits.ForceTerminationReserveMilliseconds++
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := cloneConfig(executor)
			test.mutate(&candidate)
			if err := validateConfigurationPair(control, candidate); !errors.Is(err, ErrConfiguration) {
				t.Fatalf("validateConfigurationPair returned %v, want ErrConfiguration", err)
			}
		})
	}
}

func TestPublicInputsCannotAmplifyLimitsOrUseZeroEvidence(t *testing.T) {
	if (Evidence{}).Validate() == nil {
		t.Fatal("zero Evidence validated")
	}
	tooLarge := ProductionLimits()
	tooLarge.MaximumTotalEntries++
	if _, err := normalizeOptions(Options{
		Role:                config.RoleControl,
		ActualBootstrapPath: testTrustedRoot + `\` + releasemanifest.ControlBootstrapConfigurationPath,
		Limits:              tooLarge,
	}); !errors.Is(err, ErrInvalidOptions) {
		t.Fatalf("amplified limits returned %v, want ErrInvalidOptions", err)
	}
	if _, err := normalizeOptions(Options{
		Role:                config.RoleControl,
		ActualBootstrapPath: testTrustedRoot + `\CONTROL~1.JSON`,
	}); !errors.Is(err, ErrInvalidOptions) {
		t.Fatalf("tilde bootstrap path returned %v, want ErrInvalidOptions", err)
	}
}

func TestVerifyFailsClosedOutsideWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("non-Windows contract")
	}
	if _, err := Verify(context.Background(), Options{}, releaseprofile.Evidence{}); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("Verify returned %v, want ErrUnsupportedPlatform", err)
	}
}

func assertVerificationError(t *testing.T, fixture *installFixture, target error) {
	t.Helper()
	evidence, err := verifyWithDependencies(context.Background(), fixture.options, fixture.authority, fixture.dependencies())
	if !errors.Is(err, target) {
		t.Fatalf("verification returned %v, want %v", err, target)
	}
	if evidence.Validate() == nil {
		t.Fatal("failed verification returned usable evidence")
	}
}

func mustConfigDocument(t *testing.T, value config.Config) []byte {
	t.Helper()
	document, err := config.MarshalCanonical(value)
	if err != nil {
		t.Fatal(err)
	}
	return document
}

type installFixture struct {
	fs           *fakeFileSystem
	options      Options
	authority    releaseAuthorityFacts
	manifest     releasemanifest.Manifest
	signerDigest string
}

func newInstallFixture(t *testing.T) *installFixture {
	return newInstallFixtureWithTrustedContent(
		t,
		[]byte("certificate"),
		[]byte("public-key"),
		[]byte("sandbox='required'"),
	)
}

func newInstallFixtureWithTrustedContent(
	t *testing.T,
	rootCertificate []byte,
	localAuthoritySPKI []byte,
	codexPolicy []byte,
) *installFixture {
	t.Helper()
	fs := newFakeFileSystem()
	files := []struct {
		root releasemanifest.FileRoot
		path string
		role releasemanifest.FileRole
		data []byte
	}{
		{releasemanifest.RootInstallation, config.ControlServiceName + `.exe`, releasemanifest.RoleServiceWrapper, []byte("MZ-control-wrapper")},
		{releasemanifest.RootInstallation, config.ExecutorServiceName + `.exe`, releasemanifest.RoleServiceWrapper, []byte("MZ-executor-wrapper")},
		{releasemanifest.RootInstallation, releaseprofile.ServiceHostRelativePath, releasemanifest.RoleServiceHost, []byte("MZ-service-host")},
		{releasemanifest.RootInstallation, `runtime\node.exe`, releasemanifest.RoleNodeRuntime, []byte("MZ-node")},
		{releasemanifest.RootInstallation, `app\control.mjs`, releasemanifest.RoleControlBundle, []byte("export const role='control';")},
		{releasemanifest.RootInstallation, `app\executor.mjs`, releasemanifest.RoleExecutorBundle, []byte("export const role='executor';")},
		{releasemanifest.RootInstallation, `native\processhost.exe`, releasemanifest.RoleProcessHost, []byte("MZ-process-host")},
		{releasemanifest.RootInstallation, `codex\codex.exe`, releasemanifest.RoleCodexCLI, []byte("MZ-codex")},
		{releasemanifest.RootInstallation, `git\git.exe`, releasemanifest.RoleGitCLI, []byte("MZ-git")},
		{releasemanifest.RootInstallation, `service\control.xml`, releasemanifest.RoleServiceConfig, []byte("<service id='control'/>")},
		{releasemanifest.RootInstallation, `service\executor.xml`, releasemanifest.RoleServiceConfig, []byte("<service id='executor'/>")},
		{releasemanifest.RootTrustedConfiguration, `certificates\server-root.cer`, releasemanifest.RoleCABundle, append([]byte(nil), rootCertificate...)},
		{releasemanifest.RootTrustedConfiguration, `keys\local-authority.spki`, releasemanifest.RoleTrustedConfig, append([]byte(nil), localAuthoritySPKI...)},
		{releasemanifest.RootTrustedConfiguration, `policy\codex.toml`, releasemanifest.RolePolicy, append([]byte(nil), codexPolicy...)},
	}
	manifest := releasemanifest.Manifest{
		SchemaVersion:   releasemanifest.SchemaVersion,
		PublisherPolicy: releasemanifest.PublisherPolicy,
		ReleaseID:       "worker-test-1",
		Compatibility:   releasemanifest.RequiredCompatibility(),
	}
	dataByKey := make(map[string][]byte, len(files))
	for _, file := range files {
		digest := sha256.Sum256(file.data)
		manifest.Files = append(manifest.Files, releasemanifest.File{
			Root: file.root, Path: file.path, Role: file.role,
			SHA256: fmt.Sprintf("%x", digest), Size: strconv.Itoa(len(file.data)),
		})
		dataByKey[manifestFileKey(file.root, file.path)] = file.data
	}
	manifestDocument, err := releasemanifest.MarshalCanonical(manifest)
	if err != nil {
		t.Fatalf("create fixture manifest: %v", err)
	}
	manifest, err = releasemanifest.Parse(manifestDocument)
	if err != nil {
		t.Fatalf("parse fixture manifest: %v", err)
	}
	manifestDigest := sha256.Sum256(manifestDocument)
	authority := fixtureReleaseAuthority(manifest)

	for _, file := range manifest.Files {
		root := testInstallationRoot
		if file.Root == releasemanifest.RootTrustedConfiguration {
			root = testTrustedRoot
		}
		fs.addFile(joinPath(root, file.Path), dataByKey[manifestFileKey(file.Root, file.Path)])
	}
	fs.addFile(testInstallationRoot+`\release-manifest.json`, manifestDocument)

	lookup := func(root releasemanifest.FileRoot, path string) releasemanifest.File {
		file, exists := manifest.LookupFile(root, path)
		if !exists {
			t.Fatalf("fixture manifest lacks %s/%s", root, path)
		}
		return file
	}
	node := lookup(releasemanifest.RootInstallation, `runtime\node.exe`)
	controlBundle := lookup(releasemanifest.RootInstallation, `app\control.mjs`)
	executorBundle := lookup(releasemanifest.RootInstallation, `app\executor.mjs`)
	processHost := lookup(releasemanifest.RootInstallation, `native\processhost.exe`)
	rootCA := lookup(releasemanifest.RootTrustedConfiguration, `certificates\server-root.cer`)
	publicKey := lookup(releasemanifest.RootTrustedConfiguration, `keys\local-authority.spki`)
	policy := lookup(releasemanifest.RootTrustedConfiguration, `policy\codex.toml`)

	base := config.Config{
		SchemaVersion: config.SchemaVersion,
		WorkerNodeID:  "powertoys-node:01",
		PipeName:      config.ControlExecutorPipeName,
		Installation: config.Installation{
			Root: testInstallationRoot, TrustedConfigurationRoot: testTrustedRoot,
			ReleaseID:      manifest.ReleaseID,
			ManifestPath:   testInstallationRoot + `\release-manifest.json`,
			ManifestSHA256: fmt.Sprintf("%x", manifestDigest),
			ApprovedAuthenticodeSignerCertificateDERSHA256: testSignerDigest,
		},
		Limits: config.Limits{
			RootJobMaximumProcesses: 16, RootJobMaximumMemoryBytes: "1073741824",
			MaximumFrameBytes: config.MaximumFrameBytes, MaximumQueuedBytesPerDirection: 4 * 1024 * 1024,
			ConnectTimeoutMilliseconds: 30_000, ShutdownTimeoutMilliseconds: 30_000,
			ForceTerminationReserveMilliseconds: 5_000,
		},
	}
	control := base
	control.Role = config.RoleControl
	control.OwnService = config.ServiceIdentity{Name: config.ControlServiceName, SID: config.ControlServiceSID}
	control.PeerService = config.ServiceIdentity{Name: config.ExecutorServiceName, SID: config.ExecutorServiceSID}
	control.Node = fixtureNode(`Control`, node, controlBundle)
	control.Control = &config.ControlConfiguration{
		ServerOrigin: "https://review.example.test", ServerName: "review.example.test",
		RootCertificatePath:                       testTrustedRoot + `\` + rootCA.Path,
		RootCertificateSHA256:                     rootCA.SHA256,
		ClientCertificateStore:                    config.WindowsCertificateStore,
		ClientCertificateDERSHA256:                strings.Repeat("1", 64),
		ClientPrivateKeySecurityDescriptorSHA256:  strings.Repeat("2", 64),
		LocalAuthorityCNGKeyName:                  "AgenticReview.Control.LocalAuthority",
		LocalAuthorityKeySecurityDescriptorSHA256: strings.Repeat("3", 64),
		LocalAuthorityPublicKeySHA256:             publicKey.SHA256,
	}
	executor := base
	executor.Role = config.RoleExecutor
	executor.OwnService = control.PeerService
	executor.PeerService = control.OwnService
	executor.Node = fixtureNode(`Executor`, node, executorBundle)
	executor.Executor = &config.ExecutorConfiguration{
		LocalAuthorityPublicKeyPath:   testTrustedRoot + `\` + publicKey.Path,
		LocalAuthorityPublicKeySHA256: publicKey.SHA256,
		CodexPolicyPath:               testTrustedRoot + `\` + policy.Path,
		CodexPolicySHA256:             policy.SHA256,
		ProcessHostPath:               testInstallationRoot + `\` + processHost.Path,
		ProcessHostSHA256:             processHost.SHA256,
	}
	controlDocument, err := config.MarshalCanonical(control)
	if err != nil {
		t.Fatalf("create Control bootstrap: %v", err)
	}
	executorDocument, err := config.MarshalCanonical(executor)
	if err != nil {
		t.Fatalf("create Executor bootstrap: %v", err)
	}
	fs.addFile(testTrustedRoot+`\`+releasemanifest.ControlBootstrapConfigurationPath, controlDocument)
	fs.addFile(testTrustedRoot+`\`+releasemanifest.ExecutorBootstrapConfigurationPath, executorDocument)

	return &installFixture{
		fs: fs,
		options: Options{
			Role:                config.RoleControl,
			ActualBootstrapPath: testTrustedRoot + `\` + releasemanifest.ControlBootstrapConfigurationPath,
			Limits:              ProductionLimits(),
		},
		authority:    authority,
		manifest:     manifest,
		signerDigest: testSignerDigest,
	}
}

func fixtureReleaseAuthority(manifest releasemanifest.Manifest) releaseAuthorityFacts {
	dependencies := make([]releaseprofile.Dependency, 0, len(manifest.Files)-1)
	for _, file := range manifest.Files {
		if file.Role == releasemanifest.RoleServiceHost {
			continue
		}
		dependencies = append(dependencies, releaseprofile.Dependency{
			Root: file.Root, Path: file.Path, Role: file.Role, SHA256: file.SHA256, Size: file.Size,
		})
	}
	return releaseAuthorityFacts{
		templateDigest: sha256.Sum256([]byte("fixture compiled release template")),
		schemaVersion:  releaseprofile.SchemaVersion,
		profileID:      releaseprofile.ProductionProfileID,
		releaseID:      manifest.ReleaseID,
		compatibility:  manifest.Compatibility,
		signerPin:      testSignerDigest,
		dependencies:   dependencies,
		serviceHost: releaseprofile.SelfRequirement{
			Root: releasemanifest.RootInstallation,
			Path: releaseprofile.ServiceHostRelativePath,
			Role: releasemanifest.RoleServiceHost,
		},
	}
}

func fixtureNode(role string, node, bundle releasemanifest.File) config.Node {
	dataRoot := `C:\ProgramData\AgenticReview\` + role
	result := config.Node{
		ExecutablePath:   testInstallationRoot + `\` + node.Path,
		ExecutableSHA256: node.SHA256,
		BundlePath:       testInstallationRoot + `\` + bundle.Path,
		BundleSHA256:     bundle.SHA256,
		DataRoot:         dataRoot,
		WorkingDirectory: dataRoot + `\Work`,
		Environment: map[string]string{
			"APPDATA":      dataRoot + `\Profile\AppData`,
			"LOCALAPPDATA": dataRoot + `\Profile\LocalAppData`,
			"NODE_ENV":     "production",
			"PATH":         testInstallationRoot + `\runtime`,
			"SYSTEMROOT":   `C:\Windows`,
			"TEMP":         dataRoot + `\Temp`,
			"TMP":          dataRoot + `\Temp`,
			"USERPROFILE":  dataRoot + `\Profile`,
		},
	}
	if role == "Executor" {
		result.Environment["HOME"] = dataRoot + `\Profile`
		result.Environment["CODEX_HOME"] = dataRoot + `\Codex`
		result.Environment["GIT_CONFIG_GLOBAL"] = dataRoot + `\Profile\.gitconfig`
		result.Environment["GIT_CONFIG_NOSYSTEM"] = "1"
		result.Environment["GIT_TERMINAL_PROMPT"] = "0"
		result.Environment["GCM_INTERACTIVE"] = "never"
	}
	return result
}

func (fixture *installFixture) dependencies() dependencies {
	fixture.fs.signerDigest = fixture.signerDigest
	policy := allowSecurityPolicy{}
	return dependencies{
		identityPreflight: func(options winidentity.Options) (winidentity.Evidence, error) {
			return fakeIdentityEvidence(options), nil
		},
		newSecurityPolicy: func(winidentity.Evidence) (filesystemSecurityPolicy, error) {
			return policy, nil
		},
		newAuthenticodeVerifier: func() (authenticode.Verifier, error) {
			return fakeAuthenticodeVerifier{}, nil
		},
		managedAnchor: func(root releasemanifest.FileRoot, _ string) (string, error) {
			if root == releasemanifest.RootInstallation {
				return `C:\Program Files\AgenticReview`, nil
			}
			if root == releasemanifest.RootTrustedConfiguration {
				return `C:\ProgramData\AgenticReview`, nil
			}
			return "", errors.New("unexpected fixture root")
		},
		secureRead:        fixture.fs.secureRead,
		openTraversalRoot: fixture.fs.openTraversalRoot,
	}
}

type allowSecurityPolicy struct{}

func (allowSecurityPolicy) CheckDirectory(directorySecurityRequest) error { return nil }
func (allowSecurityPolicy) CheckFile(fileSecurityRequest) error           { return nil }

func fakeIdentityEvidence(options winidentity.Options) winidentity.Evidence {
	return winidentity.Evidence{
		ProcessID: 42,
		OwnService: winidentity.ServiceEvidence{
			Name: options.OwnService.Name, SID: options.OwnService.SID,
			SIDType: winidentity.ServiceSIDTypeRestricted,
		},
		PeerService: winidentity.ServiceEvidence{
			Name: options.PeerService.Name, SID: options.PeerService.SID,
			SIDType: winidentity.ServiceSIDTypeRestricted,
		},
		Token: winidentity.TokenEvidence{
			HasRestrictions: true,
			User:            winidentity.SIDEntry{SID: options.OwnService.SID},
			Groups:          []winidentity.SIDEntry{{SID: options.OwnService.SID}},
			RestrictedSIDs:  []winidentity.SIDEntry{{SID: options.OwnService.SID}},
		},
	}
}

type fakeAuthenticodeVerifier struct{}

func (fakeAuthenticodeVerifier) Verify(authenticode.Subject) (authenticode.Evidence, error) {
	return authenticode.Evidence{}, errors.New("fake file must intercept Authenticode verification")
}

type fakeNode struct {
	name                   string
	path                   string
	directory              bool
	data                   []byte
	children               map[string]*fakeNode
	identity               winfile.FileIdentity
	closeFailures          int
	afterEnumerate         func()
	afterHash              func()
	reinspectSecurityError error
	enumerations           int
}

type fakeFileSystem struct {
	root                *fakeNode
	nextID              uint64
	signerDigest        string
	authenticodeCount   int
	secureReadCount     int
	afterBootstrapReads func()
}

func newFakeFileSystem() *fakeFileSystem {
	fs := &fakeFileSystem{nextID: 1}
	fs.root = fs.newNode("", `C:\`, true)
	return fs
}

func (fs *fakeFileSystem) newNode(name, path string, directory bool) *fakeNode {
	var id [16]byte
	binary.LittleEndian.PutUint64(id[:8], fs.nextID)
	fs.nextID++
	return &fakeNode{
		name: name, path: path, directory: directory,
		children: make(map[string]*fakeNode),
		identity: winfile.FileIdentity{VolumeSerialNumber: 0x12345678, FileID: id},
	}
}

func (fs *fakeFileSystem) addFile(path string, data []byte) {
	parsed, err := parseWindowsPath(path, true)
	if err != nil {
		panic(err)
	}
	current := fs.root
	for index, component := range parsed.components {
		key := strings.ToLower(component)
		node := current.children[key]
		last := index == len(parsed.components)-1
		if node == nil {
			nodePath := joinPath(current.path, component)
			node = fs.newNode(component, nodePath, !last)
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
	node, err := fs.lookup(path)
	if err != nil {
		panic(err)
	}
	return node
}

func (fs *fakeFileSystem) lookup(path string) (*fakeNode, error) {
	parsed, err := parseWindowsPath(path, false)
	if err != nil {
		return nil, err
	}
	current := fs.root
	for _, component := range parsed.components {
		current = current.children[strings.ToLower(component)]
		if current == nil {
			return nil, fmt.Errorf("missing fake path %s", path)
		}
	}
	return current, nil
}

func (fs *fakeFileSystem) secureRead(path string, options secureconfig.Options) (secureconfig.Result, error) {
	node, err := fs.lookup(path)
	if err != nil || node.directory || uint64(len(node.data)) > options.MaximumBytes {
		return secureconfig.Result{}, errors.Join(err, winfile.ErrTooLarge)
	}
	parsed, _ := parseWindowsPath(path, true)
	ancestors := make([]secureconfig.ObjectEvidence, 0, len(parsed.components))
	current := fs.root
	rootObject := mustObjectEvidenceWithMode(current, winfile.SecurityModeAmbientAncestor)
	if err := options.Policy.CheckAncestor(secureconfig.AncestorSecurityRequest{
		Index: 0, Count: len(parsed.components), IsVolumeRoot: true, Object: rootObject,
	}); err != nil {
		return secureconfig.Result{}, err
	}
	ancestors = append(ancestors, rootObject)
	managed := false
	for index, component := range parsed.components[:len(parsed.components)-1] {
		current = current.children[strings.ToLower(component)]
		if windowsPathEqual(current.path, options.ManagedAnchorPath) {
			managed = true
		}
		securityMode := winfile.SecurityModeAmbientAncestor
		if managed {
			securityMode = winfile.SecurityModeManaged
		}
		object := mustObjectEvidenceWithMode(current, securityMode)
		if err := options.Policy.CheckAncestor(secureconfig.AncestorSecurityRequest{
			Index: index + 1, Count: len(parsed.components), Object: object,
		}); err != nil {
			return secureconfig.Result{}, err
		}
		ancestors = append(ancestors, object)
	}
	fileObject := mustObjectEvidenceWithMode(node, winfile.SecurityModeManaged)
	if err := options.Policy.CheckFile(secureconfig.FileSecurityRequest{Object: fileObject}); err != nil {
		return secureconfig.Result{}, err
	}
	digest := sha256.Sum256(node.data)
	result := secureconfig.Result{
		Data: append([]byte(nil), node.data...), ContentSHA256: secureconfig.Digest(digest),
		File: fileObject, Ancestors: ancestors,
	}
	fs.secureReadCount++
	if fs.secureReadCount == 2 && fs.afterBootstrapReads != nil {
		fs.afterBootstrapReads()
	}
	return result, nil
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
	return fakeEvidenceWithMode(directory.node, directory.securityMode)
}
func (directory *fakeDirectory) OpenDirectoryComponent(
	component string,
	options winfile.OpenOptions,
) (directoryHandle, error) {
	node := directory.node.children[strings.ToLower(component)]
	if node == nil || !node.directory {
		return nil, winfile.ErrWrongObjectType
	}
	return &fakeDirectory{fs: directory.fs, node: node, securityMode: options.SecurityMode}, nil
}
func (directory *fakeDirectory) OpenFileComponent(
	component string,
	options winfile.OpenOptions,
) (fileHandle, error) {
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
	var total uint64
	for _, node := range directory.node.children {
		kind := winfile.ObjectKindFile
		if node.directory {
			kind = winfile.ObjectKindDirectory
		}
		units := uint64(len([]rune(node.name)))
		total += units
		entries = append(entries, winfile.DirectoryEntry{
			Name: node.name, Kind: kind, Identity: node.identity,
			Attributes: fakeAttributes(node), Size: uint64(len(node.data)),
		})
	}
	if uint32(len(entries)) > options.MaximumEntries || total > options.MaximumTotalNameUTF16Units {
		return winfile.DirectoryEnumeration{}, winfile.ErrDirectoryBudget
	}
	sort.Slice(entries, func(left, right int) bool {
		return strings.ToLower(entries[left].Name) < strings.ToLower(entries[right].Name)
	})
	directory.node.enumerations++
	if directory.node.enumerations == 1 && directory.node.afterEnumerate != nil {
		directory.node.afterEnumerate()
	}
	return winfile.DirectoryEnumeration{Entries: entries, NameUTF16Units: total}, nil
}
func (directory *fakeDirectory) VerifyUnchanged() error {
	if directory.closed {
		return winfile.ErrClosed
	}
	return nil
}
func (directory *fakeDirectory) ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error) {
	return fakeSecurityForMode(directory.securityMode), nil
}
func (directory *fakeDirectory) ReinspectDataStreams() ([]winfile.DataStream, error) {
	return nil, nil
}
func (directory *fakeDirectory) ReinspectCaseSensitivity() (bool, error) { return false, nil }
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
	fs           *fakeFileSystem
	node         *fakeNode
	securityMode winfile.SecurityMode
	closed       bool
}

func (file *fakeFile) Evidence() winfile.Evidence {
	return fakeEvidenceWithMode(file.node, file.securityMode)
}
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
	data := append([]byte(nil), file.node.data...)
	digest := sha256.Sum256(data)
	if file.node.afterHash != nil {
		afterHash := file.node.afterHash
		file.node.afterHash = nil
		afterHash()
	}
	prefixBytes := int(options.PrefixBytes)
	if prefixBytes > len(data) {
		prefixBytes = len(data)
	}
	return winfile.HashResult{
		SHA256: digest, Size: uint64(len(data)),
		Prefix: append([]byte(nil), data[:prefixBytes]...),
	}, nil
}
func (file *fakeFile) VerifyAuthenticode(authenticode.Verifier) (authenticode.Evidence, error) {
	file.fs.authenticodeCount++
	fixtureSigner := file.fs.signerDigest
	return authenticode.Evidence{
		Trusted: true, SignatureKind: authenticode.SignatureKindEmbedded,
		SignatureCount: 1, VerifiedSignatureIndex: 0,
		RevocationPolicy:                       authenticode.RevocationPolicyRuntimeCacheOnlyNoCheck,
		DigestPolicy:                           authenticode.DigestPolicySHA256Only,
		StrongSignaturePolicy:                  authenticode.StrongSignaturePolicyWindowsOSCurrent,
		SignerDigestAlgorithmOID:               authenticode.SHA256ObjectIdentifier,
		FileDigestAlgorithmOID:                 authenticode.SHA256ObjectIdentifier,
		SignerIdentity:                         "fixture signer",
		VerifiedLeafSignerCertificateDERSHA256: fixtureSigner,
	}, nil
}
func (file *fakeFile) VerifyUnchanged() error {
	if file.closed {
		return winfile.ErrClosed
	}
	return nil
}
func (file *fakeFile) ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error) {
	if file.node.reinspectSecurityError != nil {
		return winfile.SecurityDescriptorEvidence{}, file.node.reinspectSecurityError
	}
	return fakeSecurityForMode(file.securityMode), nil
}
func (file *fakeFile) ReinspectDataStreams() ([]winfile.DataStream, error) {
	return []winfile.DataStream{{Name: "::$DATA", Size: uint64(len(file.node.data)), AllocationSize: uint64(len(file.node.data))}}, nil
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

func fakeEvidenceWithMode(node *fakeNode, mode winfile.SecurityMode) winfile.Evidence {
	return winfile.Evidence{
		Kind: func() winfile.ObjectKind {
			if node.directory {
				return winfile.ObjectKindDirectory
			}
			return winfile.ObjectKindFile
		}(),
		Identity: node.identity, Attributes: fakeAttributes(node),
		Size: uint64(len(node.data)), LinkCount: 1,
		Path: winfile.PathEvidence{
			RequestedPath: node.path, TerminalComponentReparseFree: true,
			Ancestors: winfile.AncestorValidationNotPerformed,
		},
		Volume: winfile.VolumeEvidence{
			FileSystem: "NTFS", FileSystemFlags: 0x8,
			HandleSerialNumber: 0x12345678, PathSerialNumber: 0x12345678,
			DriveType: 3, PersistentACLs: true, RequiredUse: winfile.VolumeUseReadOnly,
			PathIdentityCrossCheck: true,
		},
		SecurityMode: mode,
		Security:     fakeSecurityForMode(mode),
	}
}

func fakeAttributes(node *fakeNode) uint32 {
	if node.directory {
		return 0x10
	}
	return 0x80
}

func fakeSecurityForMode(mode winfile.SecurityMode) winfile.SecurityDescriptorEvidence {
	if mode == winfile.SecurityModeAmbientAncestor {
		return winfile.SecurityDescriptorEvidence{
			OwnerSID: "S-1-5-18", GroupSID: "S-1-5-18",
			OwnerDefaulted: true, GroupDefaulted: true,
			DACLPresent: true, DACLDefaulted: true,
			Control: 0x8000 | 0x0004, Revision: 1,
			SelfRelativeDescriptor: []byte{5, 6, 7, 8},
		}
	}
	return winfile.SecurityDescriptorEvidence{
		OwnerSID: "S-1-5-18", GroupSID: "S-1-5-18",
		DACLPresent: true, DACLProtected: true,
		Control: 0x8000 | 0x1000 | 0x0004, Revision: 1,
		SelfRelativeDescriptor: []byte{1, 2, 3, 4},
	}
}

func mustObjectEvidenceWithMode(node *fakeNode, mode winfile.SecurityMode) secureconfig.ObjectEvidence {
	evidence := fakeEvidenceWithMode(node, mode)
	object, err := secureconfig.NewObjectEvidence(node.path, evidence)
	if err != nil {
		panic(err)
	}
	return object
}
