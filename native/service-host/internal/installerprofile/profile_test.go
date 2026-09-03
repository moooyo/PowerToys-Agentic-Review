package installerprofile

import (
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
)

func TestWorkerAuthenticationPathMatchesRuntimeProfile(t *testing.T) {
	if ControlDataRoot+`\`+WorkerAuthenticationFileName != config.WorkerAuthenticationProfilePath {
		t.Fatal("installer and runtime Worker authentication paths differ")
	}
}

func TestCurrentProfileAcceptsFixedPackageAndBootstrapSelections(t *testing.T) {
	if err := ValidatePackageRoots(
		ProfileID,
		"worker-package-001",
		MetadataRootParent+`\worker-package-001`,
		InstallationRoot,
		TrustedConfigurationRoot,
	); err != nil {
		t.Fatal(err)
	}
	control, executor := validBootstrapPair()
	if err := ValidateBootstrapPair(ProfileID, control, executor); err != nil {
		t.Fatal(err)
	}
}

func TestCurrentProfileRejectsAlternateRootsAndBootstrapSelections(t *testing.T) {
	packageTests := []struct {
		name         string
		profileID    string
		metadataRoot string
		installRoot  string
		trustedRoot  string
	}{
		{name: "profile", profileID: "other", metadataRoot: MetadataRootParent + `\worker-package-001`, installRoot: InstallationRoot, trustedRoot: TrustedConfigurationRoot},
		{name: "metadata", profileID: ProfileID, metadataRoot: MetadataRootParent + `\other`, installRoot: InstallationRoot, trustedRoot: TrustedConfigurationRoot},
		{name: "installation", profileID: ProfileID, metadataRoot: MetadataRootParent + `\worker-package-001`, installRoot: `D:\Worker`, trustedRoot: TrustedConfigurationRoot},
		{name: "trusted", profileID: ProfileID, metadataRoot: MetadataRootParent + `\worker-package-001`, installRoot: InstallationRoot, trustedRoot: `D:\Trusted`},
	}
	for _, test := range packageTests {
		t.Run("package "+test.name, func(t *testing.T) {
			if err := ValidatePackageRoots(test.profileID, "worker-package-001", test.metadataRoot, test.installRoot, test.trustedRoot); err == nil {
				t.Fatal("invalid package roots were accepted")
			}
		})
	}
	for _, packageID := range []string{".", "..", "con", "com1", "lpt9", "Worker-package", "worker:package", "worker.", "worker "} {
		t.Run("package ID "+packageID, func(t *testing.T) {
			if err := ValidatePackageRoots(
				ProfileID,
				packageID,
				MetadataRootParent+`\`+packageID,
				InstallationRoot,
				TrustedConfigurationRoot,
			); err == nil {
				t.Fatal("noncanonical package ID was accepted")
			}
		})
	}

	bootstrapTests := []struct {
		name   string
		mutate func(*config.Config, *config.Config)
	}{
		{name: "Control data root", mutate: func(control, _ *config.Config) {
			control.Node.DataRoot = `D:\Control`
		}},
		{name: "Executor data root", mutate: func(_, executor *config.Config) {
			executor.Node.DataRoot = `D:\Executor`
		}},
		{name: "authentication profile", mutate: func(control, _ *config.Config) {
			control.Control.WorkerAuthenticationProfile = "other"
		}},
		{name: "Token-shaped bootstrap key name", mutate: func(control, _ *config.Config) {
			control.Control.LocalAuthorityCNGKeyName = `AgenticReview.arw1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
		}},
	}
	for _, test := range bootstrapTests {
		t.Run("bootstrap "+test.name, func(t *testing.T) {
			control, executor := validBootstrapPair()
			test.mutate(&control, &executor)
			if err := ValidateBootstrapPair(ProfileID, control, executor); err == nil {
				t.Fatal("invalid bootstrap pair was accepted")
			}
		})
	}
}

func validBootstrapPair() (config.Config, config.Config) {
	control := config.Config{
		SchemaVersion: config.SchemaVersion,
		Role:          config.RoleControl,
		WorkerNodeID:  "worker-node-001",
		OwnService:    config.ServiceIdentity{Name: config.ControlServiceName, SID: config.ControlServiceSID},
		PeerService:   config.ServiceIdentity{Name: config.ExecutorServiceName, SID: config.ExecutorServiceSID},
		PipeName:      config.ControlExecutorPipeName,
		Installation: config.Installation{
			Root:                     InstallationRoot,
			TrustedConfigurationRoot: TrustedConfigurationRoot,
			ReleaseID:                "worker-2026.09.04.1",
			ManifestPath:             InstallationRoot + `\release-manifest.json`,
			ManifestSHA256:           strings.Repeat("1", 64),
			ApprovedAuthenticodeSignerCertificateDERSHA256: strings.Repeat("2", 64),
		},
		Node: installerProfileNode(ControlDataRoot, `app\control.mjs`, false),
		Control: &config.ControlConfiguration{
			ServerOrigin:                              "https://review.example.test",
			ServerName:                                "review.example.test",
			RootCertificatePath:                       TrustedConfigurationRoot + `\certificates\server-root.cer`,
			RootCertificateSHA256:                     strings.Repeat("3", 64),
			WorkerAuthenticationProfile:               config.WorkerAuthenticationProfileBearerTokenV1,
			LocalAuthorityCNGKeyName:                  "AgenticReview.Worker.Control.LocalAuthority",
			LocalAuthorityKeySecurityDescriptorSHA256: strings.Repeat("4", 64),
			LocalAuthorityPublicKeySHA256:             strings.Repeat("5", 64),
		},
		Limits: installerProfileLimits(),
	}
	executor := control
	executor.Role = config.RoleExecutor
	executor.OwnService, executor.PeerService = control.PeerService, control.OwnService
	executor.Node = installerProfileNode(ExecutorDataRoot, `app\executor.mjs`, true)
	executor.Control = nil
	executor.Executor = &config.ExecutorConfiguration{
		LocalAuthorityPublicKeyPath:   TrustedConfigurationRoot + `\keys\local-authority.spki`,
		LocalAuthorityPublicKeySHA256: strings.Repeat("5", 64),
		CodexPolicyPath:               TrustedConfigurationRoot + `\policy\codex-requirements.toml`,
		CodexPolicySHA256:             strings.Repeat("6", 64),
		ProcessHostPath:               InstallationRoot + `\native\AgenticReview.ProcessHost.exe`,
		ProcessHostSHA256:             strings.Repeat("7", 64),
	}
	return control, executor
}

func installerProfileNode(dataRoot string, bundlePath string, executor bool) config.Node {
	environment := map[string]string{
		"APPDATA":      dataRoot + `\Profile\AppData`,
		"LOCALAPPDATA": dataRoot + `\Profile\LocalAppData`,
		"NODE_ENV":     "production",
		"PATH":         InstallationRoot + `\runtime`,
		"SYSTEMROOT":   `C:\Windows`,
		"TEMP":         dataRoot + `\Temp`,
		"TMP":          dataRoot + `\Temp`,
		"USERPROFILE":  dataRoot + `\Profile`,
	}
	if executor {
		environment["CODEX_HOME"] = dataRoot + `\Codex`
		environment["GCM_INTERACTIVE"] = "never"
		environment["GIT_CONFIG_GLOBAL"] = dataRoot + `\Profile\.gitconfig`
		environment["GIT_CONFIG_NOSYSTEM"] = "1"
		environment["GIT_TERMINAL_PROMPT"] = "0"
		environment["HOME"] = dataRoot + `\Profile`
	}
	return config.Node{
		ExecutablePath:   InstallationRoot + `\runtime\node.exe`,
		ExecutableSHA256: strings.Repeat("8", 64),
		BundlePath:       InstallationRoot + `\` + bundlePath,
		BundleSHA256:     strings.Repeat("9", 64),
		DataRoot:         dataRoot,
		WorkingDirectory: dataRoot + `\Work`,
		Environment:      environment,
	}
}

func installerProfileLimits() config.Limits {
	return config.Limits{
		RootJobMaximumProcesses:             128,
		RootJobMaximumMemoryBytes:           "17179869184",
		MaximumFrameBytes:                   config.MaximumFrameBytes,
		MaximumQueuedBytesPerDirection:      4 * 1024 * 1024,
		ConnectTimeoutMilliseconds:          30_000,
		ShutdownTimeoutMilliseconds:         120_000,
		ForceTerminationReserveMilliseconds: 15_000,
	}
}
