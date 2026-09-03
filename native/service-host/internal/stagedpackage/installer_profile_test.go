package stagedpackage

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installerprofile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
)

func TestInstallerPackageGatePreservesCleanupFatal(t *testing.T) {
	original := processCleanup
	processCleanup = &cleanupState{
		fatal:          true,
		platformStatus: func() error { return nil },
		platformCommit: func(commit func()) error { commit(); return nil },
	}
	t.Cleanup(func() { processCleanup = original })

	if _, err := (StagedPackageEvidence{}).SelectInstallerPackage(); !errors.Is(err, ErrCleanupFatal) {
		t.Fatalf("SelectInstallerPackage returned %v, want ErrCleanupFatal", err)
	}
	selection := InstallerPackage{state: &evidenceState{}, digest: [32]byte{1}}
	if err := selection.Validate(); !errors.Is(err, ErrCleanupFatal) {
		t.Fatalf("InstallerPackage.Validate returned %v, want ErrCleanupFatal", err)
	}
	selection = InstallerPackage{
		state:  &evidenceState{owner: &handleOwner{}},
		digest: [32]byte{1},
	}
	if err := selection.Close(); !errors.Is(err, ErrCleanupFatal) {
		t.Fatalf("InstallerPackage.Close returned %v, want ErrCleanupFatal", err)
	}
}

func TestInstallerPackageGateAcceptsOnlyMatchingCurrentPackageAndBootstraps(t *testing.T) {
	index := validTestIndex(t)
	document, err := outerpackage.MarshalIndexCanonical(index)
	if err != nil {
		t.Fatal(err)
	}
	index, err = outerpackage.ParseIndex(document)
	if err != nil {
		t.Fatal(err)
	}
	control, executor := stagedInstallerBootstrapPair()
	if err := validateInstallerPackage(index, control, executor); err != nil {
		t.Fatal(err)
	}

	control.Control.WorkerAuthenticationProfile = "other"
	if err := validateInstallerPackage(index, control, executor); err == nil {
		t.Fatal("installer package gate accepted a different Worker authentication profile")
	}
}

func TestDestinationBindingIsOpaqueAndExpiresAfterItsBorrow(t *testing.T) {
	index := validTestIndex(t)
	control, executor := stagedInstallerBootstrapPair()
	controlDocument, err := config.MarshalCanonical(control)
	if err != nil {
		t.Fatal(err)
	}
	executorDocument, err := config.MarshalCanonical(executor)
	if err != nil {
		t.Fatal(err)
	}
	for payloadIndex := range index.Payloads {
		payload := &index.Payloads[payloadIndex]
		var document []byte
		switch payload.Role {
		case outerpackage.RoleControlBootstrap:
			document = controlDocument
		case outerpackage.RoleExecutorBootstrap:
			document = executorDocument
		default:
			continue
		}
		digest := sha256.Sum256(document)
		payload.SHA256 = hex.EncodeToString(digest[:])
		payload.Size = strconv.Itoa(len(document))
	}
	indexDocument, err := outerpackage.MarshalIndexCanonical(index)
	if err != nil {
		t.Fatal(err)
	}
	indexDigest := sha256.Sum256(indexDocument)
	signature := make([]byte, 64)
	signature[31], signature[63] = 1, 1
	signerKeyID := strings.Repeat("a", 64)
	envelope, err := outerpackage.MarshalSignatureEnvelopeCanonical(outerpackage.SignatureEnvelope{
		Algorithm: outerpackage.SignatureAlgorithm, IndexSHA256: hex.EncodeToString(indexDigest[:]),
		SchemaVersion: outerpackage.SignatureSchemaVersion,
		Signature:     base64.RawURLEncoding.EncodeToString(signature), SignerKeyID: signerKeyID,
	})
	if err != nil {
		t.Fatal(err)
	}
	borrow := &destinationBorrowState{active: true}
	binding := DestinationBinding{
		issuer: successfulDestinationBindingIssuer, borrow: borrow, sourceDigest: [32]byte{1},
		indexDocument: indexDocument, envelopeDocument: envelope,
		controlDocument: controlDocument, executorDocument: executorDocument, signerKeyID: signerKeyID,
	}
	binding.digest = digestDestinationBinding(binding)
	if err := binding.Validate(); err != nil || len(binding.IndexDocument()) == 0 {
		t.Fatalf("live destination binding was invalid: %v", err)
	}
	if _, err := json.Marshal(binding); !errors.Is(err, ErrSerialization) {
		t.Fatalf("MarshalJSON returned %v, want ErrSerialization", err)
	}
	borrow.active = false
	if err := binding.Validate(); !errors.Is(err, ErrInstallerProfile) || binding.IndexDocument() != nil || binding.SignerKeyID() != "" {
		t.Fatal("expired destination binding remained usable")
	}
	borrowed := StagedPackageEvidence{state: &evidenceState{destinationBorrowed: true}}
	if err := borrowed.Close(); !errors.Is(err, ErrInstallerProfile) {
		t.Fatalf("Close during a destination borrow returned %v", err)
	}
	owner := &destinationOwnership{marker: 1}
	transferred := StagedPackageEvidence{state: &evidenceState{
		destinationConsumed: true, destinationOwner: owner,
	}}
	if err := transferred.Close(); !errors.Is(err, ErrInstallerProfile) {
		t.Fatalf("unowned Close after destination transfer returned %v", err)
	}
	zeroLease := DestinationLease{}
	if !errors.Is(zeroLease.Validate(), ErrInstallerProfile) ||
		!errors.Is(zeroLease.Close(), ErrInstallerProfile) {
		t.Fatal("zero destination lease behaved as an ownership capability")
	}
	if _, err := json.Marshal(zeroLease); !errors.Is(err, ErrSerialization) {
		t.Fatalf("destination lease MarshalJSON returned %v, want ErrSerialization", err)
	}
}

func stagedInstallerBootstrapPair() (config.Config, config.Config) {
	control := config.Config{
		SchemaVersion: config.SchemaVersion,
		Role:          config.RoleControl,
		WorkerNodeID:  "worker-node-001",
		OwnService:    config.ServiceIdentity{Name: config.ControlServiceName, SID: config.ControlServiceSID},
		PeerService:   config.ServiceIdentity{Name: config.ExecutorServiceName, SID: config.ExecutorServiceSID},
		PipeName:      config.ControlExecutorPipeName,
		Installation: config.Installation{
			Root:                     installerprofile.InstallationRoot,
			TrustedConfigurationRoot: installerprofile.TrustedConfigurationRoot,
			ReleaseID:                "worker-2026.09.04.1",
			ManifestPath:             installerprofile.InstallationRoot + `\release-manifest.json`,
			ManifestSHA256:           strings.Repeat("1", 64),
			ApprovedAuthenticodeSignerCertificateDERSHA256: strings.Repeat("2", 64),
		},
		Node: stagedInstallerNode(installerprofile.ControlDataRoot, `app\control.mjs`, false),
		Control: &config.ControlConfiguration{
			ServerOrigin:                              "https://review.example.test",
			ServerName:                                "review.example.test",
			RootCertificatePath:                       installerprofile.TrustedConfigurationRoot + `\certificates\server-root.cer`,
			RootCertificateSHA256:                     strings.Repeat("3", 64),
			WorkerAuthenticationProfile:               config.WorkerAuthenticationProfileBearerTokenV1,
			LocalAuthorityCNGKeyName:                  "AgenticReview.Worker.Control.LocalAuthority",
			LocalAuthorityKeySecurityDescriptorSHA256: strings.Repeat("4", 64),
			LocalAuthorityPublicKeySHA256:             strings.Repeat("5", 64),
		},
		Limits: stagedInstallerLimits(),
	}
	executor := control
	executor.Role = config.RoleExecutor
	executor.OwnService, executor.PeerService = control.PeerService, control.OwnService
	executor.Node = stagedInstallerNode(installerprofile.ExecutorDataRoot, `app\executor.mjs`, true)
	executor.Control = nil
	executor.Executor = &config.ExecutorConfiguration{
		LocalAuthorityPublicKeyPath:   installerprofile.TrustedConfigurationRoot + `\keys\local-authority.spki`,
		LocalAuthorityPublicKeySHA256: strings.Repeat("5", 64),
		CodexPolicyPath:               installerprofile.TrustedConfigurationRoot + `\policy\codex-requirements.toml`,
		CodexPolicySHA256:             strings.Repeat("6", 64),
		ProcessHostPath:               installerprofile.InstallationRoot + `\native\AgenticReview.ProcessHost.exe`,
		ProcessHostSHA256:             strings.Repeat("7", 64),
	}
	return control, executor
}

func stagedInstallerNode(dataRoot string, bundle string, executor bool) config.Node {
	environment := map[string]string{
		"APPDATA": dataRoot + `\Profile\AppData`, "LOCALAPPDATA": dataRoot + `\Profile\LocalAppData`,
		"NODE_ENV": "production", "PATH": installerprofile.InstallationRoot + `\runtime`,
		"SYSTEMROOT": `C:\Windows`, "TEMP": dataRoot + `\Temp`, "TMP": dataRoot + `\Temp`,
		"USERPROFILE": dataRoot + `\Profile`,
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
		ExecutablePath: installerprofile.InstallationRoot + `\runtime\node.exe`, ExecutableSHA256: strings.Repeat("8", 64),
		BundlePath: installerprofile.InstallationRoot + `\` + bundle, BundleSHA256: strings.Repeat("9", 64),
		DataRoot: dataRoot, WorkingDirectory: dataRoot + `\Work`, Environment: environment,
	}
}

func stagedInstallerLimits() config.Limits {
	return config.Limits{
		RootJobMaximumProcesses: 128, RootJobMaximumMemoryBytes: "17179869184",
		MaximumFrameBytes: config.MaximumFrameBytes, MaximumQueuedBytesPerDirection: 4 * 1024 * 1024,
		ConnectTimeoutMilliseconds: 30_000, ShutdownTimeoutMilliseconds: 120_000,
		ForceTerminationReserveMilliseconds: 15_000,
	}
}
