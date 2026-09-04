package outerpackage

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasepackage"
)

func TestBuildIndexIsCanonicalDeterministicAndBoundToRelease(t *testing.T) {
	release := validFinalizedSource(t, "a", "b")
	first, err := buildIndex(release, validBuildOptions())
	if err != nil {
		t.Fatal(err)
	}
	second, err := buildIndex(release, validBuildOptions())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) || bytes.HasSuffix(first, []byte{'\n'}) {
		t.Fatal("identical Token-profile inputs did not produce identical canonical index bytes")
	}
	parsed, err := ParseIndex(first)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.SchemaVersion != IndexSchemaVersion || parsed.ProfileID != IndexProfileID ||
		len(parsed.Payloads) != len(release.manifest.Files)+len(specialPayloadRules) ||
		parsed.Payloads[0].Root != RootMetadata || parsed.TargetArchitecture != ArchitectureAMD64 {
		t.Fatalf("unexpected package index: %#v", parsed)
	}
	if bytes.Contains(first, []byte("mtlsClientCredential")) ||
		bytes.Contains(first, []byte("localAuthorityCng")) ||
		bytes.Contains(first, []byte("nodeSpecificLocalAuthorityPublicKeySpki")) ||
		bytes.Contains(bytes.ToLower(first), []byte("worker-auth-v1.json")) ||
		bytes.Contains(first, []byte("arw1_")) {
		t.Fatalf("Token package index contains forbidden credential material: %s", first)
	}
	if err := validateAgainstRelease(first, release); err != nil {
		t.Fatal(err)
	}

	parsed.Payloads[0].Path = "mutated.json"
	reparsed, err := ParseIndex(first)
	if err != nil || reparsed.Payloads[0].Path == "mutated.json" {
		t.Fatal("ParseIndex returned aliased payload storage")
	}
}

func TestPublicReleaseEntryPointsRequireOpaqueFinalizedRelease(t *testing.T) {
	if _, err := BuildIndex(releasepackage.FinalizedRelease{}, validBuildOptions()); !errors.Is(err, releasepackage.ErrInvalid) {
		t.Fatalf("BuildIndex returned %v, want releasepackage.ErrInvalid", err)
	}
	if err := ValidateAgainstRelease([]byte(`{}`), releasepackage.FinalizedRelease{}); !errors.Is(err, releasepackage.ErrInvalid) {
		t.Fatalf("ValidateAgainstRelease returned %v, want releasepackage.ErrInvalid", err)
	}
}

func TestIndexRejectsUnsupportedSchemaRemovedFieldsLegacyProfileAndCredentialMaterial(t *testing.T) {
	document := mustBuildIndex(t, validFinalizedSource(t, "a", "b"))
	for name, candidate := range map[string][]byte{
		"schema 3": bytes.Replace(
			document,
			[]byte(`"schemaVersion":2`),
			[]byte(`"schemaVersion":3`),
			1,
		),
		"removed mTLS field": bytes.Replace(
			document,
			[]byte(`"packageId":`),
			[]byte(`"mtlsClientCredential":{"certificateDerSha256":"`+strings.Repeat("1", 64)+`","certificateStore":"MY","privateKeySecurityDescriptorSha256":"`+strings.Repeat("2", 64)+`"},"packageId":`),
			1,
		),
		"legacy profile": bytes.Replace(
			document,
			[]byte(`"profileId":"`+IndexProfileID+`"`),
			[]byte(`"profileId":"agentic-review-worker-outer-package-v1"`),
			1,
		),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseIndex(candidate); err == nil {
				t.Fatal("ParseIndex accepted an unsupported package profile")
			}
			if _, err := SigningDigest(candidate); err == nil {
				t.Fatal("SigningDigest accepted an unsupported package profile")
			}
		})
	}

	baseline := mustParseIndex(t, document)
	tests := []struct {
		name   string
		mutate func(*Index)
	}{
		{name: "schema 3", mutate: func(value *Index) { value.SchemaVersion = 3 }},
		{name: "legacy profile", mutate: func(value *Index) {
			value.ProfileID = "agentic-review-worker-outer-package-v1"
		}},
		{name: "alternate installation root", mutate: func(value *Index) {
			value.TargetRoots.Installation = `D:\AgenticReview\Worker`
		}},
		{name: "direct Worker auth payload", mutate: func(value *Index) {
			payload := findPayloadRole(value.Payloads, RolePolicy)
			payload.Path = `worker-auth-v1.json`
		}},
		{name: "nested case-aliased Worker auth payload", mutate: func(value *Index) {
			payload := findPayloadRole(value.Payloads, RolePolicy)
			payload.Path = `credentials\WORKER-AUTH-V1.JSON`
		}},
		{name: "Token-shaped Worker identity", mutate: func(value *Index) {
			value.WorkerNodeID = `arw1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := cloneIndex(baseline)
			test.mutate(&value)
			if _, err := MarshalIndexCanonical(value); err == nil {
				t.Fatal("unsupported or credential-bearing package index was accepted")
			}
		})
	}
}

func TestParseIndexRejectsUnknownFieldsAndNoncanonicalEncoding(t *testing.T) {
	document := mustBuildIndex(t, validFinalizedSource(t, "a", "b"))
	for _, candidate := range [][]byte{
		append(append([]byte(nil), document...), '\n'),
		append([]byte{0xef, 0xbb, 0xbf}, document...),
		[]byte(strings.Replace(string(document), `"schemaVersion":2`, `"unknown":true,"schemaVersion":2`, 1)),
	} {
		if _, err := ParseIndex(candidate); err == nil {
			t.Fatalf("ParseIndex accepted noncanonical document %q", candidate)
		}
	}
	parsed, err := ParseIndex(document)
	if err != nil {
		t.Fatal(err)
	}
	parsed.Payloads[0], parsed.Payloads[1] = parsed.Payloads[1], parsed.Payloads[0]
	formatted, err := marshalCanonical(parsed, MaximumIndexBytes)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseIndex(formatted); !errors.Is(err, ErrCanonical) {
		t.Fatalf("ParseIndex returned %v, want ErrCanonical", err)
	}
}

func TestIndexRejectsPathRoleRootSizeAndArchitectureAttacks(t *testing.T) {
	baseline := mustParseIndex(t, mustBuildIndex(t, validFinalizedSource(t, "a", "b")))
	tests := []struct {
		name   string
		mutate func(*Index)
	}{
		{name: "case collision", mutate: func(value *Index) {
			duplicate := value.Payloads[0]
			duplicate.Path = strings.ToUpper(duplicate.Path)
			value.Payloads = append(value.Payloads, duplicate)
		}},
		{name: "relative escape", mutate: func(value *Index) { value.Payloads[0].Path = `metadata\..\escape.json` }},
		{name: "absolute path", mutate: func(value *Index) {
			findPayloadRole(value.Payloads, RoleRuntimeData).Path = `C:\data\runtime.json`
		}},
		{name: "forward slash", mutate: func(value *Index) {
			findPayloadRole(value.Payloads, RoleRuntimeData).Path = `data/runtime.json`
		}},
		{name: "reserved component", mutate: func(value *Index) {
			findPayloadRole(value.Payloads, RoleRuntimeData).Path = `data\con.json`
		}},
		{name: "trailing dot", mutate: func(value *Index) {
			findPayloadRole(value.Payloads, RoleRuntimeData).Path = `data.\runtime.json`
		}},
		{name: "control character", mutate: func(value *Index) {
			findPayloadRole(value.Payloads, RoleRuntimeData).Path = "data\\runtime\n.json"
		}},
		{name: "unknown root", mutate: func(value *Index) { value.Payloads[0].Root = "other" }},
		{name: "unknown role", mutate: func(value *Index) { value.Payloads[0].Role = "other" }},
		{name: "uppercase digest", mutate: func(value *Index) { value.Payloads[0].SHA256 = strings.Repeat("A", 64) }},
		{name: "leading-zero size", mutate: func(value *Index) { value.Payloads[0].Size = "01" }},
		{name: "PE architecture absent", mutate: func(value *Index) {
			findPayloadRole(value.Payloads, RoleServiceHost).TargetArchitecture = nil
		}},
		{name: "PE architecture mismatch", mutate: func(value *Index) {
			architecture := ArchitectureARM64
			findPayloadRole(value.Payloads, RoleServiceHost).TargetArchitecture = &architecture
		}},
		{name: "non-PE architecture", mutate: func(value *Index) {
			architecture := ArchitectureAMD64
			findPayloadRole(value.Payloads, RoleRuntimeManifest).TargetArchitecture = &architecture
		}},
		{name: "obsolete worker bundle", mutate: func(value *Index) {
			findPayloadRole(value.Payloads, RoleControlBundle).Path = `app\worker.mjs`
		}},
		{name: "package index alias", mutate: func(value *Index) {
			findPayloadRole(value.Payloads, RoleRuntimeData).Path = `data\package-index.json`
		}},
		{name: "build metadata", mutate: func(value *Index) {
			findPayloadRole(value.Payloads, RoleRuntimeData).Path = `data\runtime.meta.json`
		}},
		{name: "hook", mutate: func(value *Index) {
			findPayloadRole(value.Payloads, RoleGitCLI).Path = `git\hooks\git.exe`
		}},
		{name: "installer", mutate: func(value *Index) {
			findPayloadRole(value.Payloads, RoleGitCLI).Path = `tools\node-installer.exe`
		}},
		{name: "setup executable", mutate: func(value *Index) {
			findPayloadRole(value.Payloads, RoleGitCLI).Path = `tools\setup-worker.exe`
		}},
		{name: "missing metadata", mutate: func(value *Index) {
			value.Payloads = removePayloadRole(value.Payloads, RoleReviewedClosure)
		}},
		{name: "overlapping target roots", mutate: func(value *Index) {
			value.TargetRoots.Metadata = value.TargetRoots.Installation + `\metadata`
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := cloneIndex(baseline)
			test.mutate(&value)
			if _, err := MarshalIndexCanonical(value); err == nil {
				t.Fatal("MarshalIndexCanonical accepted an invalid package")
			}
		})
	}
}

func TestBuildIndexRejectsWorkerAuthenticationFile(t *testing.T) {
	release := validFinalizedSource(t, "a", "b")
	policy := findManifestFileRole(release.manifest.Files, releasemanifest.RolePolicy)
	policy.Path = `credentials\WORKER-AUTH-V1.JSON`
	document, err := releasemanifest.MarshalCanonical(release.manifest)
	if err != nil {
		t.Fatal(err)
	}
	release.manifestDocument = document
	digest := sha256.Sum256(document)
	release.descriptor.RuntimeManifestSHA256 = hex.EncodeToString(digest[:])
	release.descriptorDocument, err = marshalCanonical(release.descriptor, releasemanifest.MaximumDocumentBytes)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := buildIndex(release, validBuildOptions()); err == nil {
		t.Fatal("buildIndex accepted worker-auth-v1.json as a signed payload")
	}
}

func TestValidateAgainstReleaseRejectsMixAndMatchAndUnreviewedPayloads(t *testing.T) {
	first := validFinalizedSource(t, "a", "b")
	second := validFinalizedSource(t, "d", "e")
	document := mustBuildIndex(t, first)
	if err := validateAgainstRelease(document, second); !errors.Is(err, ErrMismatch) {
		t.Fatalf("mixed release returned %v", err)
	}

	index := mustParseIndex(t, document)
	metadata := findPayloadRole(index.Payloads, RolePrepareReceipt)
	metadata.SHA256 = strings.Repeat("9", 64)
	changedMetadata, err := MarshalIndexCanonical(index)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateAgainstRelease(changedMetadata, first); !errors.Is(err, ErrMismatch) {
		t.Fatalf("changed metadata returned %v", err)
	}

	index = mustParseIndex(t, document)
	index.Payloads = append(index.Payloads, Payload{
		Path: `data\extra.json`, Role: RoleRuntimeData, Root: RootInstallation,
		SHA256: strings.Repeat("8", 64), Size: "1",
	})
	extra, err := MarshalIndexCanonical(index)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateAgainstRelease(extra, first); !errors.Is(err, ErrMismatch) {
		t.Fatalf("unreviewed payload returned %v", err)
	}
}

func TestIndexRejectsInvalidNodeAndInstallationIdentityBindings(t *testing.T) {
	baseline := mustParseIndex(t, mustBuildIndex(t, validFinalizedSource(t, "a", "b")))
	tests := []struct {
		name   string
		mutate func(*Index)
	}{
		{name: "package ID", mutate: func(value *Index) { value.PackageID = "invalid package" }},
		{name: "package ID uppercase", mutate: func(value *Index) { value.PackageID = "Worker-package" }},
		{name: "package ID device name", mutate: func(value *Index) { value.PackageID = "con" }},
		{name: "installation ID colon", mutate: func(value *Index) { value.InstallationID = "installation:node" }},
		{name: "worker node ID", mutate: func(value *Index) { value.WorkerNodeID = "" }},
		{name: "source", mutate: func(value *Index) { value.Source.Commit = strings.Repeat("A", 40) }},
		{name: "absolute root", mutate: func(value *Index) {
			value.TargetRoots.Installation = `c:\AgenticReview`
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := cloneIndex(baseline)
			test.mutate(&value)
			if _, err := MarshalIndexCanonical(value); err == nil {
				t.Fatal("invalid identity binding was accepted")
			}
		})
	}
}

type fakeFinalizedSource struct {
	reviewedClosure    []byte
	prepareReceipt     []byte
	compiledTemplate   []byte
	serviceHostBuild   []byte
	manifestDocument   []byte
	descriptorDocument []byte
	descriptor         releasepackage.PackageDescriptor
	manifest           releasemanifest.Manifest
}

func validFinalizedSource(t *testing.T, commitDigit, treeDigit string) *fakeFinalizedSource {
	t.Helper()
	releaseID := "worker-2026.09.02.1"
	manifest := validRuntimeManifest(releaseID)
	manifestDocument, err := releasemanifest.MarshalCanonical(manifest)
	if err != nil {
		t.Fatal(err)
	}
	reviewed := []byte(`{"reviewed":"closure"}`)
	prepare := []byte(`{"prepare":"receipt"}`)
	template := []byte(`{"compiled":"template"}`)
	build := []byte(`{"serviceHost":"build-receipt"}`)
	manifestDigest := sha256.Sum256(manifestDocument)
	reviewedDigest := sha256.Sum256(reviewed)
	prepareDigest := sha256.Sum256(prepare)
	templateDigest := sha256.Sum256(template)
	buildDigest := sha256.Sum256(build)
	serviceHost, found := manifest.LookupFile(releasemanifest.RootInstallation, `native\AgenticReview.ServiceHost.exe`)
	if !found {
		t.Fatal("fixture ServiceHost is absent")
	}
	descriptor := releasepackage.PackageDescriptor{
		AuthenticodeLeafSignerCertificateDERSHA256: strings.Repeat("e", 64),
		CompiledReleaseTemplateSHA256:              hex.EncodeToString(templateDigest[:]),
		ExecutionAuthority:                         false,
		FoundationVersion:                          releasepackage.FoundationVersion,
		PackageProfile:                             releasepackage.PackageProfile,
		PrepareReceiptSHA256:                       hex.EncodeToString(prepareDigest[:]),
		ReleaseID:                                  releaseID,
		ReviewedClosurePolicyID:                    releasepackage.ReviewedClosurePolicyID,
		ReviewedClosurePolicyVersion:               releasepackage.ReviewedClosurePolicyVersion,
		ReviewedClosureSHA256:                      hex.EncodeToString(reviewedDigest[:]),
		RuntimeManifestSHA256:                      hex.EncodeToString(manifestDigest[:]),
		SchemaVersion:                              releasepackage.PackageDescriptorSchemaVersion,
		ServiceHost:                                serviceHost,
		ServiceHostBuildReceiptSHA256:              hex.EncodeToString(buildDigest[:]),
		Source: releasepackage.SourceReceipt{
			Commit: strings.Repeat(commitDigit, 40), Tree: strings.Repeat(treeDigit, 40),
		},
		TargetArchitecture: releasepackage.ArchitectureAMD64,
	}
	descriptorDocument, err := marshalCanonical(descriptor, releasemanifest.MaximumDocumentBytes)
	if err != nil {
		t.Fatal(err)
	}
	return &fakeFinalizedSource{
		reviewedClosure: reviewed, prepareReceipt: prepare, compiledTemplate: template,
		serviceHostBuild: build, manifestDocument: manifestDocument,
		descriptorDocument: descriptorDocument, descriptor: descriptor, manifest: manifest,
	}
}

func validRuntimeManifest(releaseID string) releasemanifest.Manifest {
	file := func(root releasemanifest.FileRoot, path string, role releasemanifest.FileRole, digit string, size string) releasemanifest.File {
		return releasemanifest.File{Root: root, Path: path, Role: role, SHA256: strings.Repeat(digit, 64), Size: size}
	}
	return releasemanifest.Manifest{
		Compatibility:   releasemanifest.RequiredCompatibility(),
		PublisherPolicy: releasemanifest.PublisherPolicy,
		ReleaseID:       releaseID,
		SchemaVersion:   releasemanifest.SchemaVersion,
		Files: []releasemanifest.File{
			file(releasemanifest.RootInstallation, `app\control.mjs`, releasemanifest.RoleControlBundle, "3", "1"),
			file(releasemanifest.RootInstallation, `app\executor.mjs`, releasemanifest.RoleExecutorBundle, "4", "1"),
			file(releasemanifest.RootInstallation, `codex\codex.exe`, releasemanifest.RoleCodexCLI, "5", "1"),
			file(releasemanifest.RootInstallation, `git\cmd\git.exe`, releasemanifest.RoleGitCLI, "6", "1"),
			file(releasemanifest.RootInstallation, `native\AgenticReview.ProcessHost.exe`, releasemanifest.RoleProcessHost, "7", "1"),
			file(releasemanifest.RootInstallation, `native\AgenticReview.ServiceHost.exe`, releasemanifest.RoleServiceHost, "f", "4096"),
			file(releasemanifest.RootInstallation, `runtime\node.exe`, releasemanifest.RoleNodeRuntime, "8", "1"),
			file(releasemanifest.RootInstallation, `data\runtime.json`, releasemanifest.RoleRuntimeData, "0", "1"),
			file(releasemanifest.RootTrustedConfiguration, `certificates\server-root.cer`, releasemanifest.RoleCABundle, "b", "1"),
			file(releasemanifest.RootTrustedConfiguration, `policy\codex-requirements.toml`, releasemanifest.RolePolicy, "d", "1"),
		},
	}
}

func validBuildOptions() BuildOptions {
	return BuildOptions{
		PackageID:      "worker-package-2026.09.02.1",
		InstallationID: "installation-node-001",
		WorkerNodeID:   "worker-node-001",
		TargetRoots: TargetRoots{
			Installation:         `C:\Program Files\AgenticReview\Worker`,
			Metadata:             `C:\ProgramData\AgenticReview\Packages\worker-package-2026.09.02.1`,
			TrustedConfiguration: `C:\ProgramData\AgenticReview\TrustedConfig`,
		},
		ControlBootstrap:  BootstrapPayload{SHA256: strings.Repeat("4", 64), Size: "1024"},
		ExecutorBootstrap: BootstrapPayload{SHA256: strings.Repeat("5", 64), Size: "1024"},
	}
}

func (source *fakeFinalizedSource) ReviewedClosureDocument() []byte {
	return bytes.Clone(source.reviewedClosure)
}
func (source *fakeFinalizedSource) ReviewedClosureSHA256() [sha256.Size]byte {
	return sha256.Sum256(source.reviewedClosure)
}
func (source *fakeFinalizedSource) PrepareReceiptDocument() []byte {
	return bytes.Clone(source.prepareReceipt)
}
func (source *fakeFinalizedSource) PrepareReceiptSHA256() [sha256.Size]byte {
	return sha256.Sum256(source.prepareReceipt)
}
func (source *fakeFinalizedSource) CompiledTemplateDocument() []byte {
	return bytes.Clone(source.compiledTemplate)
}
func (source *fakeFinalizedSource) CompiledTemplateSHA256() [sha256.Size]byte {
	return sha256.Sum256(source.compiledTemplate)
}
func (source *fakeFinalizedSource) ServiceHostBuildReceiptDocument() []byte {
	return bytes.Clone(source.serviceHostBuild)
}
func (source *fakeFinalizedSource) ServiceHostBuildReceiptSHA256() [sha256.Size]byte {
	return sha256.Sum256(source.serviceHostBuild)
}
func (source *fakeFinalizedSource) ManifestDocument() []byte {
	return bytes.Clone(source.manifestDocument)
}
func (source *fakeFinalizedSource) ManifestSHA256() [sha256.Size]byte {
	return sha256.Sum256(source.manifestDocument)
}
func (source *fakeFinalizedSource) DescriptorDocument() []byte {
	return bytes.Clone(source.descriptorDocument)
}
func (source *fakeFinalizedSource) DescriptorSHA256() [sha256.Size]byte {
	return sha256.Sum256(source.descriptorDocument)
}
func (source *fakeFinalizedSource) Descriptor() releasepackage.PackageDescriptor {
	return source.descriptor
}

func mustBuildIndex(t *testing.T, source finalizedReleaseSource) []byte {
	t.Helper()
	document, err := buildIndex(source, validBuildOptions())
	if err != nil {
		t.Fatal(err)
	}
	return document
}

func mustParseIndex(t *testing.T, document []byte) Index {
	t.Helper()
	value, err := ParseIndex(document)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func findPayloadRole(payloads []Payload, role Role) *Payload {
	for index := range payloads {
		if payloads[index].Role == role {
			return &payloads[index]
		}
	}
	panic("payload role is absent: " + string(role))
}

func findPayloadPath(payloads []Payload, path string) *Payload {
	for index := range payloads {
		if payloads[index].Path == path {
			return &payloads[index]
		}
	}
	panic("payload path is absent: " + path)
}

func removePayloadPath(payloads []Payload, path string) []Payload {
	result := make([]Payload, 0, len(payloads))
	for _, payload := range payloads {
		if payload.Path != path {
			result = append(result, payload)
		}
	}
	return result
}

func findManifestFilePath(files []releasemanifest.File, path string) *releasemanifest.File {
	for index := range files {
		if files[index].Path == path {
			return &files[index]
		}
	}
	panic("manifest file path is absent: " + path)
}

func findManifestFileRole(files []releasemanifest.File, role releasemanifest.FileRole) *releasemanifest.File {
	for index := range files {
		if files[index].Role == role {
			return &files[index]
		}
	}
	panic("manifest file role is absent: " + string(role))
}

func removePayloadRole(payloads []Payload, role Role) []Payload {
	result := make([]Payload, 0, len(payloads))
	for _, payload := range payloads {
		if payload.Role != role {
			result = append(result, payload)
		}
	}
	return result
}
