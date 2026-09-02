package outeradmission

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"strconv"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
)

func TestAdmitSnapshotBindsSignedIndexAndBothCanonicalBootstraps(t *testing.T) {
	fixture := newAdmissionFixture(t)
	snapshot, err := cloneDocumentSnapshot(
		fixture.indexDocument,
		fixture.envelopeDocument,
		fixture.controlDocument,
		fixture.executorDocument,
	)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := admitSnapshot(snapshot, fixture.authority)
	if err != nil {
		t.Fatal(err)
	}
	if err := plan.Validate(); err != nil || plan.SignerKeyID() != fixture.authority.SignerKeyID() ||
		plan.Index().WorkerNodeID != fixture.index.WorkerNodeID ||
		plan.ControlConfiguration().Role != config.RoleControl ||
		plan.ExecutorConfiguration().Role != config.RoleExecutor {
		t.Fatalf("unexpected admitted plan: signer=%q err=%v", plan.SignerKeyID(), err)
	}
	indexDocument := plan.IndexDocument()
	controlDocument := plan.ControlBootstrapDocument()
	executorDocument := plan.ExecutorBootstrapDocument()
	indexDocument[0] ^= 0xff
	controlDocument[0] ^= 0xff
	executorDocument[0] ^= 0xff
	if !bytes.Equal(plan.IndexDocument(), fixture.indexDocument) ||
		!bytes.Equal(plan.ControlBootstrapDocument(), fixture.controlDocument) ||
		!bytes.Equal(plan.ExecutorBootstrapDocument(), fixture.executorDocument) {
		t.Fatal("plan document getters alias private state")
	}
	if document, err := json.Marshal(plan); !errors.Is(err, ErrSerialization) || document != nil {
		t.Fatalf("json.Marshal returned document=%q err=%v", document, err)
	}
}

func TestAdmissionRejectsEveryIndexAndBootstrapBindingMismatch(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*admissionFixture)
	}{
		{name: "index worker node", mutate: func(value *admissionFixture) { value.index.WorkerNodeID = "worker-node-002" }},
		{name: "index release", mutate: func(value *admissionFixture) { value.index.ReleaseID = "worker-2026.09.02.2" }},
		{name: "index installation root", mutate: func(value *admissionFixture) { value.index.TargetRoots.Installation = `D:\AgenticReview\Worker` }},
		{name: "index trusted root", mutate: func(value *admissionFixture) {
			value.index.TargetRoots.TrustedConfiguration = `D:\AgenticReview\Trusted`
		}},
		{name: "CNG key name", mutate: func(value *admissionFixture) { value.index.LocalAuthorityCNG.KeyName += ".Other" }},
		{name: "CNG security descriptor", mutate: func(value *admissionFixture) {
			value.index.LocalAuthorityCNG.SecurityDescriptorSHA256 = strings.Repeat("6", 64)
		}},
		{name: "mTLS certificate", mutate: func(value *admissionFixture) {
			value.index.MTLSClientCredential.CertificateDERSHA256 = strings.Repeat("6", 64)
		}},
		{name: "mTLS private key DACL", mutate: func(value *admissionFixture) {
			value.index.MTLSClientCredential.PrivateKeySecurityDescriptorSHA256 = strings.Repeat("6", 64)
		}},
		{name: "manifest digest", mutate: func(value *admissionFixture) {
			value.control.Installation.ManifestSHA256 = strings.Repeat("6", 64)
			value.executor.Installation.ManifestSHA256 = strings.Repeat("6", 64)
		}},
		{name: "pair release", mutate: func(value *admissionFixture) {
			value.executor.Installation.ReleaseID = "worker-2026.09.02.2"
		}},
		{name: "pair installation root", mutate: func(value *admissionFixture) {
			value.executor.Installation.Root = `D:\AgenticReview\Worker`
			value.executor.Installation.ManifestPath = `D:\AgenticReview\Worker\release-manifest.json`
			value.executor.Node.ExecutablePath = `D:\AgenticReview\Worker\runtime\node.exe`
			value.executor.Node.BundlePath = `D:\AgenticReview\Worker\app\executor.mjs`
			value.executor.Node.Environment["PATH"] = `D:\AgenticReview\Worker\runtime`
			value.executor.Executor.ProcessHostPath = `D:\AgenticReview\Worker\native\AgenticReview.ProcessHost.exe`
		}},
		{name: "pair trusted root", mutate: func(value *admissionFixture) {
			value.executor.Installation.TrustedConfigurationRoot = `D:\AgenticReview\Trusted`
			value.executor.Executor.LocalAuthorityPublicKeyPath = `D:\AgenticReview\Trusted\keys\local-authority.spki`
			value.executor.Executor.CodexPolicyPath = `D:\AgenticReview\Trusted\policy\codex-requirements.toml`
		}},
		{name: "manifest path", mutate: func(value *admissionFixture) {
			value.control.Installation.ManifestPath = value.control.Installation.Root + `\nested\release-manifest.json`
			value.executor.Installation.ManifestPath = value.control.Installation.ManifestPath
		}},
		{name: "bootstrap signer disagreement", mutate: func(value *admissionFixture) {
			value.executor.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256 = strings.Repeat("6", 64)
		}},
		{name: "Control Node runtime", mutate: func(value *admissionFixture) { value.control.Node.ExecutableSHA256 = strings.Repeat("6", 64) }},
		{name: "Executor Node runtime", mutate: func(value *admissionFixture) { value.executor.Node.ExecutableSHA256 = strings.Repeat("6", 64) }},
		{name: "Control bundle", mutate: func(value *admissionFixture) { value.control.Node.BundleSHA256 = strings.Repeat("6", 64) }},
		{name: "Executor bundle", mutate: func(value *admissionFixture) { value.executor.Node.BundleSHA256 = strings.Repeat("6", 64) }},
		{name: "root CA", mutate: func(value *admissionFixture) { value.control.Control.RootCertificateSHA256 = strings.Repeat("6", 64) }},
		{name: "local authority key", mutate: func(value *admissionFixture) {
			value.control.Control.LocalAuthorityPublicKeySHA256 = strings.Repeat("6", 64)
			value.executor.Executor.LocalAuthorityPublicKeySHA256 = strings.Repeat("6", 64)
		}},
		{name: "Executor policy", mutate: func(value *admissionFixture) { value.executor.Executor.CodexPolicySHA256 = strings.Repeat("6", 64) }},
		{name: "ProcessHost", mutate: func(value *admissionFixture) { value.executor.Executor.ProcessHostSHA256 = strings.Repeat("6", 64) }},
		{name: "pair worker node", mutate: func(value *admissionFixture) { value.executor.WorkerNodeID = "worker-node-002" }},
		{name: "pair data roots", mutate: func(value *admissionFixture) {
			value.executor.Node.DataRoot = value.control.Node.DataRoot
			value.executor.Node.WorkingDirectory = value.executor.Node.DataRoot + `\Work`
			rewriteExecutorEnvironmentRoot(&value.executor, value.executor.Node.DataRoot)
		}},
		{name: "pair queue limit", mutate: func(value *admissionFixture) { value.executor.Limits.MaximumQueuedBytesPerDirection++ }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newAdmissionFixture(t)
			test.mutate(fixture)
			fixture.rebuild(t)
			assertFixtureRejected(t, fixture)
		})
	}
}

func TestAdmissionRejectsBootstrapBytesMixNodeMixRoleAndSPKIMismatch(t *testing.T) {
	t.Run("unindexed valid bootstrap bytes", func(t *testing.T) {
		fixture := newAdmissionFixture(t)
		fixture.control.Control.ServerOrigin = "https://other.example.test"
		fixture.control.Control.ServerName = "other.example.test"
		document, err := config.MarshalCanonical(fixture.control)
		if err != nil {
			t.Fatal(err)
		}
		fixture.controlDocument = document
		assertFixtureRejected(t, fixture)
	})

	t.Run("mixed node", func(t *testing.T) {
		first := newAdmissionFixture(t)
		second := newAdmissionFixture(t)
		second.executor.WorkerNodeID = "worker-node-002"
		second.rebuild(t)
		first.executorDocument = second.executorDocument
		assertFixtureRejected(t, first)
	})

	t.Run("mixed roles", func(t *testing.T) {
		fixture := newAdmissionFixture(t)
		fixture.controlDocument, fixture.executorDocument = fixture.executorDocument, fixture.controlDocument
		assertFixtureRejected(t, fixture)
	})

	t.Run("index SPKI identity", func(t *testing.T) {
		fixture := newAdmissionFixture(t)
		fixture.index.NodeSpecificLocalAuthorityPublicSPKI.SHA256 = strings.Repeat("6", 64)
		findFixturePayload(fixture.index.Payloads, outerpackage.RoleTrustedConfig).SHA256 = strings.Repeat("6", 64)
		fixture.rebuild(t)
		assertFixtureRejected(t, fixture)
	})

	t.Run("index SPKI path", func(t *testing.T) {
		fixture := newAdmissionFixture(t)
		fixture.index.NodeSpecificLocalAuthorityPublicSPKI.Path = `keys\other-authority.spki`
		findFixturePayload(fixture.index.Payloads, outerpackage.RoleTrustedConfig).Path = `keys\other-authority.spki`
		fixture.rebuild(t)
		assertFixtureRejected(t, fixture)
	})
}

func TestAdmissionRejectsInvalidBootstrapServiceAndPipeAuthority(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*config.Config)
	}{
		{name: "role", mutate: func(value *config.Config) { value.Role = config.RoleExecutor }},
		{name: "own service", mutate: func(value *config.Config) { value.OwnService.Name = config.ExecutorServiceName }},
		{name: "own service SID", mutate: func(value *config.Config) { value.OwnService.SID = config.ExecutorServiceSID }},
		{name: "pipe", mutate: func(value *config.Config) { value.PipeName = `\\.\pipe\Other` }},
		{name: "mTLS store", mutate: func(value *config.Config) { value.Control.ClientCertificateStore = "ROOT" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newAdmissionFixture(t)
			test.mutate(&fixture.control)
			document, err := json.Marshal(fixture.control)
			if err != nil {
				t.Fatal(err)
			}
			fixture.controlDocument = document
			fixture.resignDocuments(t)
			assertFixtureRejected(t, fixture)
		})
	}
}

func TestAdmissionSnapshotsCallerBytesAndRejectsVerifierMutation(t *testing.T) {
	t.Run("caller mutation after clone", func(t *testing.T) {
		fixture := newAdmissionFixture(t)
		snapshot, err := cloneDocumentSnapshot(
			fixture.indexDocument,
			fixture.envelopeDocument,
			fixture.controlDocument,
			fixture.executorDocument,
		)
		if err != nil {
			t.Fatal(err)
		}
		fixture.authority.afterVerify = func([]byte, []byte) { fixture.indexDocument[0] ^= 0xff }
		if _, err := admitSnapshot(snapshot, fixture.authority); err != nil {
			t.Fatalf("caller mutation changed the cloned admission snapshot: %v", err)
		}
	})

	t.Run("verified snapshot mutation", func(t *testing.T) {
		fixture := newAdmissionFixture(t)
		snapshot, err := cloneDocumentSnapshot(
			fixture.indexDocument,
			fixture.envelopeDocument,
			fixture.controlDocument,
			fixture.executorDocument,
		)
		if err != nil {
			t.Fatal(err)
		}
		fixture.authority.afterVerify = func(index, _ []byte) { index[0] ^= 0xff }
		if plan, err := admitSnapshot(snapshot, fixture.authority); !errors.Is(err, ErrInvalid) || plan.state != nil {
			t.Fatalf("mutating verifier returned plan=%#v err=%v", plan, err)
		}
	})
}

func TestAdmissionRejectsSignatureAndSignerMixAndMatch(t *testing.T) {
	t.Run("signature bytes", func(t *testing.T) {
		fixture := newAdmissionFixture(t)
		envelope, err := outerpackage.ParseSignatureEnvelope(fixture.envelopeDocument)
		if err != nil {
			t.Fatal(err)
		}
		signature, err := base64.RawURLEncoding.DecodeString(envelope.Signature)
		if err != nil {
			t.Fatal(err)
		}
		r := new(big.Int).SetBytes(signature[:32])
		r.Add(r, big.NewInt(1))
		if r.Cmp(elliptic.P256().Params().N) >= 0 {
			r.SetInt64(1)
		}
		r.FillBytes(signature[:32])
		envelope.Signature = base64.RawURLEncoding.EncodeToString(signature)
		fixture.envelopeDocument, err = outerpackage.MarshalSignatureEnvelopeCanonical(envelope)
		if err != nil {
			t.Fatal(err)
		}
		assertFixtureRejected(t, fixture)
	})

	t.Run("other signer", func(t *testing.T) {
		fixture := newAdmissionFixture(t)
		other := newAdmissionFixture(t)
		fixture.envelopeDocument = signFixtureIndex(
			t,
			other.authority.key,
			other.authority.spki,
			fixture.indexDocument,
		)
		assertFixtureRejected(t, fixture)
	})
}

func TestSignedPackagePlanRejectsZeroAndPrivateStateMutation(t *testing.T) {
	if !errors.Is((SignedPackagePlan{}).Validate(), ErrInvalidPlan) {
		t.Fatal("zero SignedPackagePlan was accepted")
	}
	fixture := newAdmissionFixture(t)
	snapshot, err := cloneDocumentSnapshot(
		fixture.indexDocument,
		fixture.envelopeDocument,
		fixture.controlDocument,
		fixture.executorDocument,
	)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := admitSnapshot(snapshot, fixture.authority)
	if err != nil {
		t.Fatal(err)
	}
	plan.state.documents.control[0] ^= 0xff
	if !errors.Is(plan.Validate(), ErrInvalidPlan) || plan.IndexDocument() != nil {
		t.Fatal("mutated SignedPackagePlan remained usable")
	}
}

func TestAdmissionKeepsUnprovablePlacementFieldsAsSignedDataOnly(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*admissionFixture)
	}{
		{name: "package ID", mutate: func(value *admissionFixture) { value.index.PackageID = "worker-package-other" }},
		{name: "installation ID", mutate: func(value *admissionFixture) { value.index.InstallationID = "installation-other" }},
		{name: "metadata root", mutate: func(value *admissionFixture) { value.index.TargetRoots.Metadata = `D:\AgenticReview\Metadata` }},
		{name: "source identity", mutate: func(value *admissionFixture) { value.index.Source.Commit = strings.Repeat("9", 40) }},
		{name: "target architecture", mutate: func(value *admissionFixture) {
			value.index.TargetArchitecture = outerpackage.ArchitectureARM64
			for index := range value.index.Payloads {
				if value.index.Payloads[index].TargetArchitecture != nil {
					architecture := outerpackage.ArchitectureARM64
					value.index.Payloads[index].TargetArchitecture = &architecture
				}
			}
		}},
		{name: "bootstrap Authenticode signer claim", mutate: func(value *admissionFixture) {
			value.control.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256 = strings.Repeat("6", 64)
			value.executor.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256 = strings.Repeat("6", 64)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newAdmissionFixture(t)
			test.mutate(fixture)
			fixture.rebuild(t)
			snapshot, err := cloneDocumentSnapshot(
				fixture.indexDocument,
				fixture.envelopeDocument,
				fixture.controlDocument,
				fixture.executorDocument,
			)
			if err != nil {
				t.Fatal(err)
			}
			plan, err := admitSnapshot(snapshot, fixture.authority)
			if err != nil || plan.Validate() != nil {
				t.Fatalf("signed assembler-only field was incorrectly treated as bootstrap evidence: %v", err)
			}
		})
	}
}

type testSignatureAuthority struct {
	key         *ecdsa.PrivateKey
	spki        []byte
	afterVerify func([]byte, []byte)
}

func (authority *testSignatureAuthority) Validate() error {
	if authority == nil || authority.key == nil || len(authority.spki) == 0 {
		return errors.New("test signature authority is invalid")
	}
	return nil
}

func (authority *testSignatureAuthority) SignerKeyID() string {
	if authority.Validate() != nil {
		return ""
	}
	return documentSHA256(authority.spki)
}

func (authority *testSignatureAuthority) Verify(index, envelope []byte) error {
	if err := outerpackage.VerifyDetachedSignature(index, envelope, authority.spki); err != nil {
		return err
	}
	if authority.afterVerify != nil {
		authority.afterVerify(index, envelope)
	}
	return nil
}

type admissionFixture struct {
	index            outerpackage.Index
	control          config.Config
	executor         config.Config
	indexDocument    []byte
	envelopeDocument []byte
	controlDocument  []byte
	executorDocument []byte
	authority        *testSignatureAuthority
}

func newAdmissionFixture(t *testing.T) *admissionFixture {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return newAdmissionFixtureWithKey(t, key)
}

func newAdmissionFixtureWithKey(t *testing.T, key *ecdsa.PrivateKey) *admissionFixture {
	t.Helper()
	spki, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	fixture := &admissionFixture{
		control:   validAdmissionControlConfig(),
		executor:  validAdmissionExecutorConfig(),
		authority: &testSignatureAuthority{key: key, spki: spki},
	}
	fixture.index = validAdmissionIndex()
	fixture.rebuild(t)
	return fixture
}

func deterministicAdmissionPrivateKey() *ecdsa.PrivateKey {
	curve := elliptic.P256()
	x, y := curve.ScalarBaseMult([]byte{1})
	return &ecdsa.PrivateKey{
		PublicKey: ecdsa.PublicKey{Curve: curve, X: x, Y: y},
		D:         big.NewInt(1),
	}
}

func (fixture *admissionFixture) rebuild(t *testing.T) {
	t.Helper()
	var err error
	fixture.controlDocument, err = config.MarshalCanonical(fixture.control)
	if err != nil {
		t.Fatal(err)
	}
	fixture.executorDocument, err = config.MarshalCanonical(fixture.executor)
	if err != nil {
		t.Fatal(err)
	}
	fixture.resignDocuments(t)
}

func (fixture *admissionFixture) resignDocuments(t *testing.T) {
	t.Helper()
	setFixtureDocumentPayload(
		findFixturePayload(fixture.index.Payloads, outerpackage.RoleControlBootstrap),
		fixture.controlDocument,
	)
	setFixtureDocumentPayload(
		findFixturePayload(fixture.index.Payloads, outerpackage.RoleExecutorBootstrap),
		fixture.executorDocument,
	)
	var err error
	fixture.indexDocument, err = outerpackage.MarshalIndexCanonical(fixture.index)
	if err != nil {
		t.Fatal(err)
	}
	fixture.envelopeDocument = signFixtureIndex(t, fixture.authority.key, fixture.authority.spki, fixture.indexDocument)
}

func assertFixtureRejected(t *testing.T, fixture *admissionFixture) {
	t.Helper()
	snapshot, err := cloneDocumentSnapshot(
		fixture.indexDocument,
		fixture.envelopeDocument,
		fixture.controlDocument,
		fixture.executorDocument,
	)
	if err != nil {
		t.Fatal(err)
	}
	if plan, err := admitSnapshot(snapshot, fixture.authority); err == nil || plan.state != nil {
		t.Fatalf("admission accepted a mismatched fixture: plan=%#v err=%v", plan, err)
	}
}

func signFixtureIndex(t *testing.T, key *ecdsa.PrivateKey, spki, index []byte) []byte {
	t.Helper()
	digest, err := outerpackage.SigningDigest(index)
	if err != nil {
		t.Fatal(err)
	}
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	order := elliptic.P256().Params().N
	halfOrder := new(big.Int).Rsh(new(big.Int).Set(order), 1)
	if s.Cmp(halfOrder) > 0 {
		s = new(big.Int).Sub(order, s)
	}
	p1363 := make([]byte, 64)
	r.FillBytes(p1363[:32])
	s.FillBytes(p1363[32:])
	document, err := outerpackage.MarshalSignatureEnvelopeCanonical(outerpackage.SignatureEnvelope{
		Algorithm:     outerpackage.SignatureAlgorithm,
		IndexSHA256:   documentSHA256(index),
		SchemaVersion: outerpackage.SignatureSchemaVersion,
		Signature:     base64.RawURLEncoding.EncodeToString(p1363),
		SignerKeyID:   documentSHA256(spki),
	})
	if err != nil {
		t.Fatal(err)
	}
	return document
}

func validAdmissionIndex() outerpackage.Index {
	architecture := outerpackage.ArchitectureAMD64
	payload := func(root outerpackage.Root, path string, role outerpackage.Role, digit string, pe bool) outerpackage.Payload {
		value := outerpackage.Payload{Root: root, Path: path, Role: role, SHA256: strings.Repeat(digit, 64), Size: "1"}
		if pe {
			value.TargetArchitecture = &architecture
		}
		return value
	}
	return outerpackage.Index{
		InstallationID: "installation-node-001",
		LocalAuthorityCNG: outerpackage.LocalAuthorityCNGIdentity{
			KeyName:                  "AgenticReview.Worker.Control.LocalAuthority",
			SecurityDescriptorSHA256: strings.Repeat("1", 64),
		},
		MTLSClientCredential: outerpackage.MTLSCredentialIdentity{
			CertificateDERSHA256:               strings.Repeat("2", 64),
			CertificateStore:                   outerpackage.MTLSCertificateStore,
			PrivateKeySecurityDescriptorSHA256: strings.Repeat("3", 64),
		},
		NodeSpecificLocalAuthorityPublicSPKI: outerpackage.NodeSpecificSPKI{
			Path: `keys\local-authority.spki`, SHA256: strings.Repeat("c", 64),
		},
		PackageID:          "worker-package-2026.09.02.1",
		ProfileID:          outerpackage.IndexProfileID,
		ReleaseID:          "worker-2026.09.02.1",
		SchemaVersion:      outerpackage.IndexSchemaVersion,
		Source:             outerpackage.SourceIdentity{Commit: strings.Repeat("a", 40), Tree: strings.Repeat("b", 40)},
		TargetArchitecture: architecture,
		TargetRoots: outerpackage.TargetRoots{
			Installation:         `C:\Program Files\AgenticReview\Worker`,
			Metadata:             `C:\ProgramData\AgenticReview\Packages\worker-package-2026.09.02.1`,
			TrustedConfiguration: `C:\ProgramData\AgenticReview\TrustedConfig`,
		},
		WorkerNodeID: "worker-node-001",
		Payloads: []outerpackage.Payload{
			payload(outerpackage.RootMetadata, outerpackage.PackageDescriptorPath, outerpackage.RolePackageDescriptor, "0", false),
			payload(outerpackage.RootMetadata, outerpackage.PrepareReceiptPath, outerpackage.RolePrepareReceipt, "1", false),
			payload(outerpackage.RootMetadata, outerpackage.ReviewedClosurePath, outerpackage.RoleReviewedClosure, "2", false),
			payload(outerpackage.RootMetadata, outerpackage.CompiledReleaseTemplatePath, outerpackage.RoleCompiledReleaseTemplate, "3", false),
			payload(outerpackage.RootMetadata, outerpackage.ServiceHostBuildReceiptPath, outerpackage.RoleServiceHostBuildReceipt, "4", false),
			payload(outerpackage.RootInstallation, outerpackage.RuntimeManifestPath, outerpackage.RoleRuntimeManifest, "a", false),
			payload(outerpackage.RootTrustedConfiguration, outerpackage.ControlBootstrapPath, outerpackage.RoleControlBootstrap, "5", false),
			payload(outerpackage.RootTrustedConfiguration, outerpackage.ExecutorBootstrapPath, outerpackage.RoleExecutorBootstrap, "6", false),
			payload(outerpackage.RootInstallation, `AgenticReview.Worker.Control.exe`, outerpackage.RoleServiceWrapper, "1", true),
			payload(outerpackage.RootInstallation, `AgenticReview.Worker.Executor.exe`, outerpackage.RoleServiceWrapper, "2", true),
			payload(outerpackage.RootInstallation, `app\control.mjs`, outerpackage.RoleControlBundle, "3", false),
			payload(outerpackage.RootInstallation, `app\executor.mjs`, outerpackage.RoleExecutorBundle, "4", false),
			payload(outerpackage.RootInstallation, `codex\codex.exe`, outerpackage.RoleCodexCLI, "5", true),
			payload(outerpackage.RootInstallation, `git\cmd\git.exe`, outerpackage.RoleGitCLI, "6", true),
			payload(outerpackage.RootInstallation, `native\AgenticReview.ProcessHost.exe`, outerpackage.RoleProcessHost, "7", true),
			payload(outerpackage.RootInstallation, `native\AgenticReview.ServiceHost.exe`, outerpackage.RoleServiceHost, "f", true),
			payload(outerpackage.RootInstallation, `runtime\node.exe`, outerpackage.RoleNodeRuntime, "8", true),
			payload(outerpackage.RootInstallation, `service\control.xml`, outerpackage.RoleServiceConfig, "9", false),
			payload(outerpackage.RootInstallation, `service\executor.xml`, outerpackage.RoleServiceConfig, "a", false),
			payload(outerpackage.RootTrustedConfiguration, `certificates\server-root.cer`, outerpackage.RoleCABundle, "b", false),
			payload(outerpackage.RootTrustedConfiguration, `keys\local-authority.spki`, outerpackage.RoleTrustedConfig, "c", false),
			payload(outerpackage.RootTrustedConfiguration, `policy\codex-requirements.toml`, outerpackage.RolePolicy, "d", false),
		},
	}
}

func validAdmissionControlConfig() config.Config {
	return config.Config{
		SchemaVersion: config.SchemaVersion,
		Role:          config.RoleControl,
		WorkerNodeID:  "worker-node-001",
		OwnService:    config.ServiceIdentity{Name: config.ControlServiceName, SID: config.ControlServiceSID},
		PeerService:   config.ServiceIdentity{Name: config.ExecutorServiceName, SID: config.ExecutorServiceSID},
		PipeName:      config.ControlExecutorPipeName,
		Installation: config.Installation{
			Root: `C:\Program Files\AgenticReview\Worker`, TrustedConfigurationRoot: `C:\ProgramData\AgenticReview\TrustedConfig`,
			ReleaseID: "worker-2026.09.02.1", ManifestPath: `C:\Program Files\AgenticReview\Worker\release-manifest.json`,
			ManifestSHA256: strings.Repeat("a", 64), ApprovedAuthenticodeSignerCertificateDERSHA256: strings.Repeat("e", 64),
		},
		Node: config.Node{
			ExecutablePath: `C:\Program Files\AgenticReview\Worker\runtime\node.exe`, ExecutableSHA256: strings.Repeat("8", 64),
			BundlePath: `C:\Program Files\AgenticReview\Worker\app\control.mjs`, BundleSHA256: strings.Repeat("3", 64),
			DataRoot: `C:\ProgramData\AgenticReview\Control`, WorkingDirectory: `C:\ProgramData\AgenticReview\Control\Work`,
			Environment: admissionEnvironment(`C:\ProgramData\AgenticReview\Control`, false),
		},
		Control: &config.ControlConfiguration{
			ServerOrigin: "https://review.example.test", ServerName: "review.example.test",
			RootCertificatePath: `C:\ProgramData\AgenticReview\TrustedConfig\certificates\server-root.cer`, RootCertificateSHA256: strings.Repeat("b", 64),
			ClientCertificateStore: config.WindowsCertificateStore, ClientCertificateDERSHA256: strings.Repeat("2", 64),
			ClientPrivateKeySecurityDescriptorSHA256: strings.Repeat("3", 64),
			LocalAuthorityCNGKeyName:                 "AgenticReview.Worker.Control.LocalAuthority", LocalAuthorityKeySecurityDescriptorSHA256: strings.Repeat("1", 64),
			LocalAuthorityPublicKeySHA256: strings.Repeat("c", 64),
		},
		Limits: admissionLimits(),
	}
}

func validAdmissionExecutorConfig() config.Config {
	value := validAdmissionControlConfig()
	value.Role = config.RoleExecutor
	value.OwnService, value.PeerService = value.PeerService, value.OwnService
	value.Node.BundlePath = `C:\Program Files\AgenticReview\Worker\app\executor.mjs`
	value.Node.BundleSHA256 = strings.Repeat("4", 64)
	value.Node.DataRoot = `C:\ProgramData\AgenticReview\Executor`
	value.Node.WorkingDirectory = value.Node.DataRoot + `\Work`
	value.Node.Environment = admissionEnvironment(value.Node.DataRoot, true)
	value.Control = nil
	value.Executor = &config.ExecutorConfiguration{
		LocalAuthorityPublicKeyPath:   `C:\ProgramData\AgenticReview\TrustedConfig\keys\local-authority.spki`,
		LocalAuthorityPublicKeySHA256: strings.Repeat("c", 64),
		CodexPolicyPath:               `C:\ProgramData\AgenticReview\TrustedConfig\policy\codex-requirements.toml`,
		CodexPolicySHA256:             strings.Repeat("d", 64),
		ProcessHostPath:               `C:\Program Files\AgenticReview\Worker\native\AgenticReview.ProcessHost.exe`,
		ProcessHostSHA256:             strings.Repeat("7", 64),
	}
	return value
}

func admissionLimits() config.Limits {
	return config.Limits{
		RootJobMaximumProcesses: 128, RootJobMaximumMemoryBytes: "17179869184",
		MaximumFrameBytes: config.MaximumFrameBytes, MaximumQueuedBytesPerDirection: 4 * 1024 * 1024,
		ConnectTimeoutMilliseconds: 30_000, ShutdownTimeoutMilliseconds: 120_000,
		ForceTerminationReserveMilliseconds: 15_000,
	}
}

func admissionEnvironment(dataRoot string, executor bool) map[string]string {
	value := map[string]string{
		"APPDATA": dataRoot + `\Profile\AppData`, "LOCALAPPDATA": dataRoot + `\Profile\LocalAppData`,
		"NODE_ENV": "production", "PATH": `C:\Program Files\AgenticReview\Worker\runtime`,
		"SYSTEMROOT": `C:\Windows`, "TEMP": dataRoot + `\Temp`, "TMP": dataRoot + `\Temp`,
		"USERPROFILE": dataRoot + `\Profile`,
	}
	if executor {
		value["HOME"] = dataRoot + `\Profile`
		value["CODEX_HOME"] = dataRoot + `\Codex`
		value["GIT_CONFIG_GLOBAL"] = dataRoot + `\Profile\.gitconfig`
		value["GIT_CONFIG_NOSYSTEM"] = "1"
		value["GIT_TERMINAL_PROMPT"] = "0"
		value["GCM_INTERACTIVE"] = "never"
	}
	return value
}

func rewriteExecutorEnvironmentRoot(configuration *config.Config, root string) {
	configuration.Node.Environment = admissionEnvironment(root, true)
}

func findFixturePayload(payloads []outerpackage.Payload, role outerpackage.Role) *outerpackage.Payload {
	for index := range payloads {
		if payloads[index].Role == role {
			return &payloads[index]
		}
	}
	panic("fixture payload is absent: " + string(role))
}

func setFixtureDocumentPayload(payload *outerpackage.Payload, document []byte) {
	payload.SHA256 = documentSHA256(document)
	payload.Size = strconv.Itoa(len(document))
}

func documentSHA256(document []byte) string {
	digest := sha256.Sum256(document)
	return hex.EncodeToString(digest[:])
}
