package installverify

import (
	"context"
	"errors"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winidentity"
)

func TestAccessForFileExhaustivelyMapsManifestRoles(t *testing.T) {
	tests := []struct {
		name   string
		root   releasemanifest.FileRoot
		path   string
		role   releasemanifest.FileRole
		access serviceAccess
	}{
		{"Control wrapper", releasemanifest.RootInstallation, config.ControlServiceName + ".exe", releasemanifest.RoleServiceWrapper, executeControl},
		{"Executor wrapper", releasemanifest.RootInstallation, config.ExecutorServiceName + ".exe", releasemanifest.RoleServiceWrapper, executeExecutor},
		{"ServiceHost", releasemanifest.RootInstallation, `native\servicehost.exe`, releasemanifest.RoleServiceHost, executeBoth},
		{"Node", releasemanifest.RootInstallation, `runtime\node.exe`, releasemanifest.RoleNodeRuntime, executeBoth},
		{"Control bundle", releasemanifest.RootInstallation, `app\control.mjs`, releasemanifest.RoleControlBundle, executeControl},
		{"Executor bundle", releasemanifest.RootInstallation, `app\executor.mjs`, releasemanifest.RoleExecutorBundle, executeExecutor},
		{"ProcessHost", releasemanifest.RootInstallation, `native\processhost.exe`, releasemanifest.RoleProcessHost, executeExecutor},
		{"Codex CLI", releasemanifest.RootInstallation, `codex\codex.exe`, releasemanifest.RoleCodexCLI, executeExecutor},
		{"Git CLI", releasemanifest.RootInstallation, `git\cmd\git.exe`, releasemanifest.RoleGitCLI, executeExecutor},
		{"Git helper", releasemanifest.RootInstallation, `git\mingw64\bin\git-remote-https.exe`, releasemanifest.RoleGitHelper, executeExecutor},
		{"Codex runtime", releasemanifest.RootInstallation, `codex\runtime\codex-runtime.dll`, releasemanifest.RoleCodexRuntime, executeExecutor},
		{"shared Node library", releasemanifest.RootInstallation, `runtime\node.dll`, releasemanifest.RoleNativeLibrary, executeBoth},
		{"Executor library", releasemanifest.RootInstallation, `git\mingw64\bin\libcurl.dll`, releasemanifest.RoleNativeLibrary, executeExecutor},
		{"installation CA", releasemanifest.RootInstallation, `runtime\ca.pem`, releasemanifest.RoleCABundle, readBoth},
		{"service config", releasemanifest.RootInstallation, `service\control.xml`, releasemanifest.RoleServiceConfig, readBoth},
		{"runtime data", releasemanifest.RootInstallation, `runtime\snapshot.dat`, releasemanifest.RoleRuntimeData, readBoth},
		{"license", releasemanifest.RootInstallation, `LICENSE.txt`, releasemanifest.RoleLicense, readBoth},
		{"trusted CA", releasemanifest.RootTrustedConfiguration, `certificates\server-root.cer`, releasemanifest.RoleCABundle, readBoth},
		{"trusted key", releasemanifest.RootTrustedConfiguration, `keys\authority.spki`, releasemanifest.RoleTrustedConfig, readBoth},
		{"policy", releasemanifest.RootTrustedConfiguration, `policy\codex.toml`, releasemanifest.RolePolicy, readBoth},
		{"schema", releasemanifest.RootTrustedConfiguration, `schemas\job.json`, releasemanifest.RoleSchema, readBoth},
		{"prompt", releasemanifest.RootTrustedConfiguration, `prompts\review.md`, releasemanifest.RolePrompt, readBoth},
		{"recipe", releasemanifest.RootTrustedConfiguration, `recipes\review.json`, releasemanifest.RoleRecipe, readBoth},
	}

	covered := make(map[releasemanifest.FileRole]struct{})
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manifest := releasemanifest.File{Root: test.root, Path: test.path, Role: test.role}
			actual, err := accessForFile(fileSecurityRequest{
				root: test.root, relativePath: test.path,
				purpose: purposeManifestEntry, manifest: &manifest,
			})
			if err != nil {
				t.Fatalf("accessForFile returned an error: %v", err)
			}
			if actual != test.access {
				t.Fatalf("access = %#v, want %#v", actual, test.access)
			}
		})
		covered[test.role] = struct{}{}
	}

	allRoles := []releasemanifest.FileRole{
		releasemanifest.RoleServiceWrapper,
		releasemanifest.RoleServiceHost,
		releasemanifest.RoleNodeRuntime,
		releasemanifest.RoleControlBundle,
		releasemanifest.RoleExecutorBundle,
		releasemanifest.RoleProcessHost,
		releasemanifest.RoleCodexCLI,
		releasemanifest.RoleGitCLI,
		releasemanifest.RoleGitHelper,
		releasemanifest.RoleCodexRuntime,
		releasemanifest.RoleNativeLibrary,
		releasemanifest.RoleCABundle,
		releasemanifest.RoleServiceConfig,
		releasemanifest.RoleTrustedConfig,
		releasemanifest.RolePolicy,
		releasemanifest.RoleSchema,
		releasemanifest.RolePrompt,
		releasemanifest.RoleRecipe,
		releasemanifest.RoleRuntimeData,
		releasemanifest.RoleLicense,
	}
	for _, role := range allRoles {
		if _, exists := covered[role]; !exists {
			t.Fatalf("manifest role %q has no ACL mapping test", role)
		}
	}
}

func TestAccessForFileRejectsUnknownOrInconsistentPurpose(t *testing.T) {
	validInstallation := releasemanifest.File{
		Root: releasemanifest.RootInstallation, Path: `runtime\node.exe`, Role: releasemanifest.RoleNodeRuntime,
	}
	validTrusted := releasemanifest.File{
		Root: releasemanifest.RootTrustedConfiguration, Path: `policy\codex.toml`, Role: releasemanifest.RolePolicy,
	}
	tests := []fileSecurityRequest{
		{root: releasemanifest.RootInstallation, relativePath: `unknown.bin`, purpose: purposeManifestEntry, manifest: &releasemanifest.File{Root: releasemanifest.RootInstallation, Path: `unknown.bin`, Role: "unknown"}},
		{root: releasemanifest.RootTrustedConfiguration, relativePath: validInstallation.Path, purpose: purposeManifestEntry, manifest: &validInstallation},
		{root: releasemanifest.RootInstallation, relativePath: validTrusted.Path, purpose: purposeManifestEntry, manifest: &validTrusted},
		{root: releasemanifest.RootInstallation, relativePath: `other.exe`, purpose: purposeManifestEntry, manifest: &releasemanifest.File{Root: releasemanifest.RootInstallation, Path: `other.exe`, Role: releasemanifest.RoleServiceWrapper}},
		{root: releasemanifest.RootInstallation, relativePath: validInstallation.Path, purpose: purposeManifestEntry},
		{root: releasemanifest.RootInstallation, relativePath: `other\node.exe`, purpose: purposeManifestEntry, manifest: &validInstallation},
		{root: releasemanifest.RootTrustedConfiguration, relativePath: releasemanifest.ControlBootstrapConfigurationPath, purpose: purposeManifest},
		{root: releasemanifest.RootInstallation, relativePath: releasemanifest.ControlBootstrapConfigurationPath, purpose: purposeControlBootstrap},
		{root: releasemanifest.RootInstallation, relativePath: `release-manifest.json`, purpose: filePurpose(255)},
	}
	for index, request := range tests {
		if _, err := accessForFile(request); err == nil {
			t.Fatalf("case %d unexpectedly received an ACL mapping", index)
		}
	}
}

func TestFixedIdentityOptionsAndEvidenceDoNotTrustRoleLabel(t *testing.T) {
	controlOptions, err := fixedIdentityOptions(config.RoleControl)
	if err != nil {
		t.Fatalf("fixedIdentityOptions(Control): %v", err)
	}
	if controlOptions.OwnService.Name != config.ControlServiceName ||
		controlOptions.OwnService.SID != config.ControlServiceSID ||
		controlOptions.PeerService.Name != config.ExecutorServiceName ||
		controlOptions.PeerService.SID != config.ExecutorServiceSID {
		t.Fatalf("Control identity options are not the fixed pair: %#v", controlOptions)
	}
	executorOptions, err := fixedIdentityOptions(config.RoleExecutor)
	if err != nil {
		t.Fatalf("fixedIdentityOptions(Executor): %v", err)
	}
	if executorOptions.OwnService != controlOptions.PeerService ||
		executorOptions.PeerService != controlOptions.OwnService {
		t.Fatalf("Executor identity options are not the reversed fixed pair: %#v", executorOptions)
	}
	if _, err := fixedIdentityOptions(config.Role("other")); !errors.Is(err, ErrInvalidOptions) {
		t.Fatalf("unknown role returned %v, want ErrInvalidOptions", err)
	}

	identity := fakeIdentityEvidence(controlOptions)
	identity.Token.User.SID = config.ExecutorServiceSID
	if _, err := roleFromIdentityEvidence(identity); err == nil {
		t.Fatal("caller-selected Control role accepted Executor token evidence")
	}
}

func TestProductionPolicyRequiresIdentityEvidence(t *testing.T) {
	if _, err := newProductionFilesystemSecurityPolicy(winidentity.Evidence{}); !errors.Is(err, ErrServiceIdentity) {
		t.Fatalf("empty identity returned %v, want ErrServiceIdentity", err)
	}
	options, _ := fixedIdentityOptions(config.RoleControl)
	if _, err := newProductionFilesystemSecurityPolicy(fakeIdentityEvidence(options)); err != nil {
		t.Fatalf("fixed identity could not construct production ACL profiles: %v", err)
	}
}

func TestIdentityMismatchStopsBeforeFactoriesAndFilesystem(t *testing.T) {
	fixture := newInstallFixture(t)
	deps := fixture.dependencies()
	securityFactoryCalled := false
	signatureFactoryCalled := false
	deps.identityPreflight = func(options winidentity.Options) (winidentity.Evidence, error) {
		evidence := fakeIdentityEvidence(options)
		evidence.Token.User.SID = config.ExecutorServiceSID
		return evidence, nil
	}
	deps.newSecurityPolicy = func(winidentity.Evidence) (filesystemSecurityPolicy, error) {
		securityFactoryCalled = true
		return allowSecurityPolicy{}, nil
	}
	deps.newAuthenticodeVerifier = func() (authenticode.Verifier, error) {
		signatureFactoryCalled = true
		return fakeAuthenticodeVerifier{}, nil
	}

	evidence, err := verifyWithDependencies(context.Background(), fixture.options, deps)
	if !errors.Is(err, ErrServiceIdentity) {
		t.Fatalf("identity mismatch returned %v, want ErrServiceIdentity", err)
	}
	if evidence.Validate() == nil {
		t.Fatal("identity mismatch returned usable evidence")
	}
	if securityFactoryCalled || signatureFactoryCalled || fixture.fs.secureReadCount != 0 {
		t.Fatalf(
			"identity mismatch crossed a trust boundary: security=%t signature=%t reads=%d",
			securityFactoryCalled,
			signatureFactoryCalled,
			fixture.fs.secureReadCount,
		)
	}
}
