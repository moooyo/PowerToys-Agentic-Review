package stagedpackage

import (
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasepackage"
)

func validTestIndex(t testing.TB) outerpackage.Index {
	t.Helper()
	payloads := []outerpackage.Payload{
		testPayload(outerpackage.RootMetadata, outerpackage.PackageDescriptorPath, outerpackage.RolePackageDescriptor, "1", false),
		testPayload(outerpackage.RootMetadata, outerpackage.PrepareReceiptPath, outerpackage.RolePrepareReceipt, "2", false),
		testPayload(outerpackage.RootMetadata, outerpackage.ReviewedClosurePath, outerpackage.RoleReviewedClosure, "3", false),
		testPayload(outerpackage.RootMetadata, outerpackage.CompiledReleaseTemplatePath, outerpackage.RoleCompiledReleaseTemplate, "4", false),
		testPayload(outerpackage.RootMetadata, outerpackage.ServiceHostBuildReceiptPath, outerpackage.RoleServiceHostBuildReceipt, "5", false),
		testPayload(outerpackage.RootInstallation, outerpackage.RuntimeManifestPath, outerpackage.RoleRuntimeManifest, "6", false),
		testPayload(outerpackage.RootTrustedConfiguration, outerpackage.ControlBootstrapPath, outerpackage.RoleControlBootstrap, "7", false),
		testPayload(outerpackage.RootTrustedConfiguration, outerpackage.ExecutorBootstrapPath, outerpackage.RoleExecutorBootstrap, "8", false),
		testPayload(outerpackage.RootInstallation, releasepackage.ControlServiceWrapperPath, outerpackage.RoleServiceWrapper, "9", true),
		testPayload(outerpackage.RootInstallation, releasepackage.ExecutorServiceWrapperPath, outerpackage.RoleServiceWrapper, "a", true),
		testPayload(outerpackage.RootInstallation, `app\control.mjs`, outerpackage.RoleControlBundle, "b", false),
		testPayload(outerpackage.RootInstallation, `app\executor.mjs`, outerpackage.RoleExecutorBundle, "c", false),
		testPayload(outerpackage.RootInstallation, `codex\codex.exe`, outerpackage.RoleCodexCLI, "d", true),
		testPayload(outerpackage.RootInstallation, `git\cmd\git.exe`, outerpackage.RoleGitCLI, "e", true),
		testPayload(outerpackage.RootInstallation, `native\AgenticReview.ProcessHost.exe`, outerpackage.RoleProcessHost, "f", true),
		testPayload(outerpackage.RootInstallation, `native\AgenticReview.ServiceHost.exe`, outerpackage.RoleServiceHost, "0", true),
		testPayload(outerpackage.RootInstallation, `runtime\node.exe`, outerpackage.RoleNodeRuntime, "1", true),
		testPayload(outerpackage.RootInstallation, releasepackage.ControlServiceConfigPath, outerpackage.RoleServiceConfig, "2", false),
		testPayload(outerpackage.RootInstallation, releasepackage.ExecutorServiceConfigPath, outerpackage.RoleServiceConfig, "3", false),
		testPayload(outerpackage.RootTrustedConfiguration, `keys\local-authority.spki`, outerpackage.RoleTrustedConfig, "4", false),
	}
	value := outerpackage.Index{
		InstallationID: "installation-node-001",
		LocalAuthorityCNG: outerpackage.LocalAuthorityCNGIdentity{
			KeyName:                  "AgenticReview.Worker.Control.LocalAuthority",
			SecurityDescriptorSHA256: strings.Repeat("5", 64),
		},
		MTLSClientCredential: outerpackage.MTLSCredentialIdentity{
			CertificateDERSHA256:               strings.Repeat("6", 64),
			CertificateStore:                   outerpackage.MTLSCertificateStore,
			PrivateKeySecurityDescriptorSHA256: strings.Repeat("7", 64),
		},
		NodeSpecificLocalAuthorityPublicSPKI: outerpackage.NodeSpecificSPKI{
			Path: `keys\local-authority.spki`, SHA256: strings.Repeat("4", 64),
		},
		PackageID:          "worker-package-001",
		Payloads:           payloads,
		ProfileID:          outerpackage.IndexProfileID,
		ReleaseID:          "worker-2026.09.02.1",
		SchemaVersion:      outerpackage.IndexSchemaVersion,
		Source:             outerpackage.SourceIdentity{Commit: strings.Repeat("8", 40), Tree: strings.Repeat("9", 40)},
		TargetArchitecture: outerpackage.ArchitectureAMD64,
		TargetRoots: outerpackage.TargetRoots{
			Installation:         `C:\Program Files\AgenticReview\Worker`,
			Metadata:             `C:\ProgramData\AgenticReview\Packages\worker-package-001`,
			TrustedConfiguration: `C:\ProgramData\AgenticReview\TrustedConfig`,
		},
		WorkerNodeID: "worker-node-001",
	}
	document, err := outerpackage.MarshalIndexCanonical(value)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := outerpackage.ParseIndex(document)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func testPayload(
	root outerpackage.Root,
	path string,
	role outerpackage.Role,
	digit string,
	portableExecutable bool,
) outerpackage.Payload {
	payload := outerpackage.Payload{
		Path: path, Role: role, Root: root, SHA256: strings.Repeat(digit, 64), Size: "1",
	}
	if portableExecutable {
		architecture := outerpackage.ArchitectureAMD64
		payload.TargetArchitecture = &architecture
	}
	return payload
}
