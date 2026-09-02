package releasepackage

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/servicehostreceipt"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

func TestPrepareIsDeterministicCanonicalAndRoundTrips(t *testing.T) {
	request := validPrepareRequest(t)
	first, err := Prepare(request)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Prepare(request)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first.ReceiptDocument(), second.ReceiptDocument()) ||
		!bytes.Equal(first.CompiledTemplateDocument(), second.CompiledTemplateDocument()) ||
		first.ReceiptSHA256() != second.ReceiptSHA256() ||
		first.CompiledTemplateSHA256() != second.CompiledTemplateSHA256() {
		t.Fatal("identical prepare inputs did not produce identical canonical output")
	}
	if err := releaseprofile.ValidateDocument(first.CompiledTemplateDocument()); err != nil {
		t.Fatalf("compiled template is invalid: %v", err)
	}
	parsed, err := ParsePrepareReceipt(first.ReceiptDocument(), request.ReviewedClosure)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.ReceiptSHA256() != first.ReceiptSHA256() ||
		parsed.CompiledTemplateSHA256() != first.CompiledTemplateSHA256() ||
		!bytes.Equal(parsed.CompiledTemplateDocument(), first.CompiledTemplateDocument()) {
		t.Fatal("parsed prepare receipt changed its template or digest")
	}

	receipt := first.ReceiptDocument()
	if bytes.HasSuffix(receipt, []byte{'\n'}) ||
		!bytes.Contains(receipt, []byte(`"packageProfile":"role-config-v2-node-specific"`)) ||
		!bytes.Contains(receipt, []byte(`"foundationVersion":2`)) ||
		!bytes.Contains(receipt, []byte(`"executionAuthority":false`)) {
		t.Fatalf("prepare receipt is not the expected zero-authority canonical document: %s", receipt)
	}
	if got := hexDigest(first.CompiledTemplateSHA256()); got != compiledTemplateGoldenSHA256 {
		t.Fatalf("compiled template golden SHA-256 = %s, want %s", got, compiledTemplateGoldenSHA256)
	}
	if got := hexDigest(first.ReceiptSHA256()); got != prepareReceiptGoldenSHA256 {
		t.Fatalf("prepare receipt golden SHA-256 = %s, want %s", got, prepareReceiptGoldenSHA256)
	}
	if got := hexDigest(request.ReviewedClosure.SHA256()); got != reviewedClosureGoldenSHA256 {
		t.Fatalf("reviewed closure golden SHA-256 = %s, want %s", got, reviewedClosureGoldenSHA256)
	}
}

func TestFinalizeBuildsCanonicalManifestAndZeroAuthorityDescriptor(t *testing.T) {
	prepared, request := validFinalization(t)
	finalized, err := Finalize(prepared, request)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := releasemanifest.Parse(finalized.ManifestDocument())
	if err != nil {
		t.Fatal(err)
	}
	if manifest.ReleaseID != request.ReleaseID || len(manifest.Files) != len(request.Dependencies)+1 {
		t.Fatalf("unexpected runtime manifest: %#v", manifest)
	}
	for _, expected := range []struct {
		path string
		role releasemanifest.FileRole
	}{
		{ControlServiceWrapperPath, releasemanifest.RoleServiceWrapper},
		{ExecutorServiceWrapperPath, releasemanifest.RoleServiceWrapper},
		{ControlServiceConfigPath, releasemanifest.RoleServiceConfig},
		{ExecutorServiceConfigPath, releasemanifest.RoleServiceConfig},
	} {
		file, found := manifest.LookupFile(releasemanifest.RootInstallation, expected.path)
		if !found || file.Path != expected.path || file.Role != expected.role {
			t.Fatalf("runtime manifest fixed WinSW slot = %#v, found=%v", file, found)
		}
	}
	self, found := manifest.LookupFile(releasemanifest.RootInstallation, releaseprofile.ServiceHostRelativePath)
	serviceHost := request.ServiceHost.state.metadata
	if !found || self.SHA256 != serviceHost.SHA256 || self.Size != serviceHost.Size {
		t.Fatalf("runtime manifest ServiceHost = %#v", self)
	}
	descriptor, err := parsePackageDescriptor(finalized.DescriptorDocument())
	if err != nil {
		t.Fatal(err)
	}
	if descriptor.ExecutionAuthority || descriptor.FoundationVersion != FoundationVersion ||
		descriptor.PackageProfile != PackageProfile || descriptor.RuntimeManifestSHA256 != hexDigest(finalized.ManifestSHA256()) ||
		descriptor.CompiledReleaseTemplateSHA256 != hexDigest(prepared.CompiledTemplateSHA256()) ||
		descriptor.NodeSpecificSPKI != request.NodeSpecificSPKI ||
		descriptor.ServiceHostBuildReceiptSHA256 != hexDigest(request.ServiceHostBuild.state.sha256) ||
		descriptor.ReviewedClosureSHA256 != hexDigest(prepared.state.closure.SHA256()) {
		t.Fatalf("unexpected package descriptor: %#v", descriptor)
	}
	if got := hexDigest(finalized.ManifestSHA256()); got != runtimeManifestGoldenSHA256 {
		t.Fatalf("runtime manifest golden SHA-256 = %s, want %s", got, runtimeManifestGoldenSHA256)
	}
	if got := hexDigest(finalized.DescriptorSHA256()); got != packageDescriptorGoldenSHA256 {
		t.Fatalf("package descriptor golden SHA-256 = %s, want %s", got, packageDescriptorGoldenSHA256)
	}
}

func TestAssemblySnapshotRetainsExactIndependentDocumentCopies(t *testing.T) {
	prepared, request := validFinalization(t)
	finalized, err := Finalize(prepared, request)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := finalized.SnapshotForAssembly()
	if err != nil {
		t.Fatal(err)
	}
	expected := []struct {
		name         string
		document     []byte
		digest       [sha256.Size]byte
		snapshotRead func() []byte
		snapshotHash func() [sha256.Size]byte
	}{
		{"reviewed closure", prepared.state.closure.Document(), prepared.state.closure.SHA256(), snapshot.ReviewedClosureDocument, snapshot.ReviewedClosureSHA256},
		{"prepare receipt", prepared.ReceiptDocument(), prepared.ReceiptSHA256(), snapshot.PrepareReceiptDocument, snapshot.PrepareReceiptSHA256},
		{"compiled template", prepared.CompiledTemplateDocument(), prepared.CompiledTemplateSHA256(), snapshot.CompiledTemplateDocument, snapshot.CompiledTemplateSHA256},
		{"ServiceHost build receipt", request.ServiceHostBuild.state.document, request.ServiceHostBuild.state.sha256, snapshot.ServiceHostBuildReceiptDocument, snapshot.ServiceHostBuildReceiptSHA256},
		{"runtime manifest", finalized.ManifestDocument(), finalized.ManifestSHA256(), snapshot.ManifestDocument, snapshot.ManifestSHA256},
		{"package descriptor", finalized.DescriptorDocument(), finalized.DescriptorSHA256(), snapshot.DescriptorDocument, snapshot.DescriptorSHA256},
	}
	for _, value := range expected {
		t.Run(value.name, func(t *testing.T) {
			snapshotDocument := value.snapshotRead()
			if !bytes.Equal(snapshotDocument, value.document) || value.snapshotHash() != value.digest ||
				sha256.Sum256(snapshotDocument) != value.digest {
				t.Fatalf("assembly snapshot %s differs from its exact source", value.name)
			}
			snapshotDocument[0] ^= 0xff
			if !bytes.Equal(value.snapshotRead(), value.document) || value.snapshotHash() != value.digest {
				t.Fatalf("assembly snapshot %s aliases caller-visible bytes", value.name)
			}
		})
	}
	manifestDocument := finalized.ManifestDocument()
	descriptorDocument := finalized.DescriptorDocument()
	manifestDocument[0] ^= 0xff
	descriptorDocument[0] ^= 0xff
	if !bytes.Equal(finalized.ManifestDocument(), snapshot.ManifestDocument()) ||
		!bytes.Equal(finalized.DescriptorDocument(), snapshot.DescriptorDocument()) {
		t.Fatal("existing FinalizedRelease document getters alias caller-visible bytes")
	}
	if snapshot.Descriptor() != finalized.Descriptor() {
		t.Fatal("assembly snapshot descriptor differs from finalized descriptor")
	}
}

func TestAssemblySnapshotRejectsCorruptedFinalizedState(t *testing.T) {
	prepared, request := validFinalization(t)
	finalized, err := Finalize(prepared, request)
	if err != nil {
		t.Fatal(err)
	}
	finalized.state.prepareReceiptDocument[0] ^= 0xff
	if snapshot, err := finalized.SnapshotForAssembly(); !errors.Is(err, ErrInvalid) || snapshot.state != nil {
		t.Fatalf("SnapshotForAssembly returned snapshot=%#v err=%v, want ErrInvalid", snapshot, err)
	}
}

func TestInspectFinalizedDocumentsReturnsOnlyConsistentDetachedFacts(t *testing.T) {
	prepared, request := validFinalization(t)
	finalized, err := Finalize(prepared, request)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := finalized.SnapshotForAssembly()
	if err != nil {
		t.Fatal(err)
	}
	documents := FinalizedDocuments{
		ReviewedClosure:         snapshot.ReviewedClosureDocument(),
		PrepareReceipt:          snapshot.PrepareReceiptDocument(),
		CompiledTemplate:        snapshot.CompiledTemplateDocument(),
		ServiceHostBuildReceipt: snapshot.ServiceHostBuildReceiptDocument(),
		RuntimeManifest:         snapshot.ManifestDocument(),
		PackageDescriptor:       snapshot.DescriptorDocument(),
	}
	facts, err := InspectFinalizedDocuments(documents)
	if err != nil {
		t.Fatal(err)
	}
	if facts.Descriptor != finalized.Descriptor() || facts.Manifest.ReleaseID != request.ReleaseID ||
		facts.ServiceHostBuild.ReleaseID != request.ReleaseID {
		t.Fatalf("unexpected finalized document facts: %#v", facts)
	}
	facts.Manifest.Files[0].Path = "mutated"
	again, err := InspectFinalizedDocuments(documents)
	if err != nil || again.Manifest.Files[0].Path == "mutated" {
		t.Fatal("InspectFinalizedDocuments returned aliased facts")
	}
	documents.PrepareReceipt[0] ^= 0xff
	if _, err := InspectFinalizedDocuments(documents); !errors.Is(err, ErrInvalid) {
		t.Fatalf("corrupted finalized documents returned %v, want ErrInvalid", err)
	}
}

func TestFinalizeRejectsMixedPhaseContextAndServiceHost(t *testing.T) {
	prepared, baseline := validFinalization(t)
	tests := []struct {
		name   string
		mutate func(*FinalizeRequest)
	}{
		{name: "release", mutate: func(value *FinalizeRequest) { value.ReleaseID = "other-release" }},
		{name: "architecture", mutate: func(value *FinalizeRequest) { value.TargetArchitecture = ArchitectureARM64 }},
		{name: "source commit", mutate: func(value *FinalizeRequest) { value.Source.Commit = strings.Repeat("f", 40) }},
		{name: "source tree", mutate: func(value *FinalizeRequest) { value.Source.Tree = strings.Repeat("f", 40) }},
		{name: "signer", mutate: func(value *FinalizeRequest) {
			value.AuthenticodeLeafSignerCertificateDERSHA256 = strings.Repeat("1", 64)
		}},
		{name: "SPKI", mutate: func(value *FinalizeRequest) { value.NodeSpecificSPKI.SHA256 = strings.Repeat("1", 64) }},
		{name: "ServiceHost release", mutate: func(value *FinalizeRequest) {
			mutateVerifiedServiceHost(value, func(metadata *serviceHostMetadata) {
				metadata.ReleaseID = "other-release"
			})
		}},
		{name: "ServiceHost architecture", mutate: func(value *FinalizeRequest) {
			mutateVerifiedServiceHost(value, func(metadata *serviceHostMetadata) {
				metadata.TargetArchitecture = ArchitectureARM64
			})
		}},
		{name: "ServiceHost source", mutate: func(value *FinalizeRequest) {
			mutateVerifiedServiceHost(value, func(metadata *serviceHostMetadata) {
				metadata.Source.Tree = strings.Repeat("f", 40)
			})
		}},
		{name: "ServiceHost template", mutate: func(value *FinalizeRequest) {
			mutateVerifiedServiceHost(value, func(metadata *serviceHostMetadata) {
				metadata.CompiledReleaseTemplateSHA256 = strings.Repeat("1", 64)
			})
		}},
		{name: "ServiceHost signer", mutate: func(value *FinalizeRequest) {
			mutateVerifiedServiceHost(value, func(metadata *serviceHostMetadata) {
				metadata.VerifiedAuthenticodeLeafCertificateDERSHA256 = strings.Repeat("1", 64)
			})
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := cloneFinalizeRequest(baseline)
			test.mutate(&request)
			if _, err := Finalize(prepared, request); !errors.Is(err, ErrMismatch) {
				t.Fatalf("Finalize returned %v, want ErrMismatch", err)
			}
		})
	}
}

func TestFinalizeRejectsDependencyMutationBetweenPhases(t *testing.T) {
	prepared, request := validFinalization(t)
	request.Dependencies[0].SHA256 = strings.Repeat("f", 64)
	if _, err := Finalize(prepared, request); !errors.Is(err, ErrMismatch) {
		t.Fatalf("Finalize returned %v, want ErrMismatch", err)
	}
}

func TestFinalizeRejectsUnverifiedServiceHostMetadata(t *testing.T) {
	prepared, request := validFinalization(t)
	request.ServiceHost = VerifiedServiceHostEvidence{}
	if _, err := Finalize(prepared, request); !errors.Is(err, ErrInvalid) {
		t.Fatalf("Finalize returned %v, want ErrInvalid", err)
	}
}

func TestFinalizeRejectsAbsentOrMixedServiceHostBuildReceipt(t *testing.T) {
	prepared, request := validFinalization(t)
	baseline := request.ServiceHostBuild
	request.ServiceHostBuild = ServiceHostBuildEvidence{}
	if _, err := Finalize(prepared, request); !errors.Is(err, ErrMismatch) {
		t.Fatalf("Finalize without build receipt returned %v, want ErrMismatch", err)
	}
	request.ServiceHostBuild = cloneBuildEvidence(baseline)
	request.ServiceHostBuild.state.receipt.Source.Tree = strings.Repeat("f", 40)
	document, err := servicehostreceipt.MarshalCanonical(request.ServiceHostBuild.state.receipt)
	if err != nil {
		t.Fatal(err)
	}
	request.ServiceHostBuild.state.document = document
	request.ServiceHostBuild.state.sha256 = sha256.Sum256(document)
	if _, err := Finalize(prepared, request); !errors.Is(err, ErrMismatch) {
		t.Fatalf("Finalize with mixed build receipt returned %v, want ErrMismatch", err)
	}
}

func TestPrepareRejectsNoncanonicalUnsafeAndUnreviewedInventory(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*PrepareRequest)
		want   error
	}{
		{name: "noncanonical order", mutate: func(value *PrepareRequest) {
			value.Dependencies[0], value.Dependencies[1] = value.Dependencies[1], value.Dependencies[0]
		}, want: ErrInvalid},
		{name: "case conflict", mutate: func(value *PrepareRequest) {
			value.Dependencies[1] = value.Dependencies[0]
			value.Dependencies[1].Path = strings.ToUpper(value.Dependencies[1].Path)
		}, want: ErrInvalid},
		{name: "unsafe path", mutate: func(value *PrepareRequest) {
			index := dependencyIndex(value.Dependencies, releasemanifest.RolePolicy)
			value.Dependencies[index].Path = `policy\..\escape.json`
		}, want: ErrInvalid},
		{name: "legacy bundle", mutate: func(value *PrepareRequest) {
			index := dependencyIndex(value.Dependencies, releasemanifest.RoleControlBundle)
			value.Dependencies[index].Path = `app\dist\worker.mjs`
		}, want: ErrInvalid},
		{name: "source map", mutate: func(value *PrepareRequest) {
			dependency := releaseprofile.Dependency{
				Root: releasemanifest.RootInstallation, Path: `app\control.mjs.map`,
				Role: releasemanifest.RoleRuntimeData, SHA256: strings.Repeat("e", 64), Size: "1",
			}
			value.Dependencies = append(value.Dependencies, dependency)
		}, want: ErrInvalid},
		{name: "bundle metadata", mutate: func(value *PrepareRequest) {
			dependency := releaseprofile.Dependency{
				Root: releasemanifest.RootInstallation, Path: `app\control.meta.json`,
				Role: releasemanifest.RoleRuntimeData, SHA256: strings.Repeat("e", 64), Size: "1",
			}
			value.Dependencies = append(value.Dependencies, dependency)
		}, want: ErrInvalid},
		{name: "extra inventory", mutate: func(value *PrepareRequest) {
			value.Dependencies = addCanonicalDependency(value.Dependencies, releaseprofile.Dependency{
				Root: releasemanifest.RootInstallation, Path: `assets\extra.json`,
				Role: releasemanifest.RoleRuntimeData, SHA256: strings.Repeat("e", 64), Size: "1",
			})
		}, want: ErrMismatch},
		{name: "SPKI digest", mutate: func(value *PrepareRequest) {
			value.NodeSpecificSPKI.SHA256 = strings.Repeat("f", 64)
		}, want: ErrMismatch},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := validPrepareRequest(t)
			test.mutate(&request)
			if _, err := Prepare(request); !errors.Is(err, test.want) {
				t.Fatalf("Prepare returned %v, want %v", err, test.want)
			}
		})
	}
}

func TestReviewedClosureRejectsInvalidFixedWinSWSlotsWithMatchingApproval(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*[]releaseprofile.Dependency)
	}{
		{name: "alternate wrapper path", mutate: func(values *[]releaseprofile.Dependency) {
			(*values)[dependencyPathIndex(*values, ControlServiceWrapperPath)].Path = `bin\AgenticReview.Worker.Control.exe`
		}},
		{name: "wrapper path casing", mutate: func(values *[]releaseprofile.Dependency) {
			(*values)[dependencyPathIndex(*values, ControlServiceWrapperPath)].Path = strings.ToLower(ControlServiceWrapperPath)
		}},
		{name: "wrapper root", mutate: func(values *[]releaseprofile.Dependency) {
			(*values)[dependencyPathIndex(*values, ControlServiceWrapperPath)].Root = releasemanifest.RootTrustedConfiguration
		}},
		{name: "alternate service config path", mutate: func(values *[]releaseprofile.Dependency) {
			(*values)[dependencyPathIndex(*values, ControlServiceConfigPath)].Path = `service\control.xml`
		}},
		{name: "service config path casing", mutate: func(values *[]releaseprofile.Dependency) {
			(*values)[dependencyPathIndex(*values, ExecutorServiceConfigPath)].Path = strings.ToLower(ExecutorServiceConfigPath)
		}},
		{name: "service roles exchanged", mutate: func(values *[]releaseprofile.Dependency) {
			wrapper := dependencyPathIndex(*values, ControlServiceWrapperPath)
			configuration := dependencyPathIndex(*values, ControlServiceConfigPath)
			(*values)[wrapper].Role, (*values)[configuration].Role =
				(*values)[configuration].Role, (*values)[wrapper].Role
		}},
		{name: "missing wrapper", mutate: func(values *[]releaseprofile.Dependency) {
			*values = removeDependencyPath(*values, ControlServiceWrapperPath)
		}},
		{name: "duplicate service config", mutate: func(values *[]releaseprofile.Dependency) {
			(*values)[dependencyPathIndex(*values, ControlServiceConfigPath)].Path = ExecutorServiceConfigPath
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			dependencies := validDependencies()
			test.mutate(&dependencies)
			document := reviewedClosureDocumentForTest(t, dependencies)
			digest := sha256.Sum256(document)
			if _, err := parseReviewedClosure(document, hexDigest(digest)); !errors.Is(err, ErrInvalid) {
				t.Fatalf("parseReviewedClosure returned %v, want ErrInvalid", err)
			}
		})
	}
}

func TestParsePrepareReceiptRejectsAlternateFixedWinSWSlot(t *testing.T) {
	request := validPrepareRequest(t)
	prepared, err := Prepare(request)
	if err != nil {
		t.Fatal(err)
	}
	var receipt prepareReceiptDocument
	if err := parseCanonical(prepared.ReceiptDocument(), &receipt); err != nil {
		t.Fatal(err)
	}
	receipt.Dependencies[dependencyPathIndex(receipt.Dependencies, ControlServiceConfigPath)].Path =
		`service\control.xml`
	document, err := marshalCanonical(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParsePrepareReceipt(document, request.ReviewedClosure); !errors.Is(err, ErrInvalid) {
		t.Fatalf("ParsePrepareReceipt returned %v, want ErrInvalid", err)
	}
}

func TestReviewedClosureRejectsCoordinatedValidExtrasWithoutIndependentApproval(t *testing.T) {
	tests := []struct {
		name       string
		dependency releaseprofile.Dependency
	}{
		{
			name: "runtime data",
			dependency: releaseprofile.Dependency{
				Root: releasemanifest.RootInstallation, Path: `assets\extra.json`,
				Role: releasemanifest.RoleRuntimeData, SHA256: strings.Repeat("e", 64), Size: "1",
			},
		},
		{
			name: "Git helper",
			dependency: releaseprofile.Dependency{
				Root: releasemanifest.RootInstallation, Path: `git\cmd\helper.exe`,
				Role: releasemanifest.RoleGitHelper, SHA256: strings.Repeat("e", 64), Size: "1",
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := validPrepareRequest(t)
			changed := addCanonicalDependency(request.Dependencies, test.dependency)
			forgedClosure := reviewedClosureDocumentForTest(t, changed)
			forgedDigest := sha256.Sum256(forgedClosure)
			if _, err := parseReviewedClosure(forgedClosure, hexDigest(forgedDigest)); err != nil {
				t.Fatalf("extra dependency fixture is not a valid reviewed closure: %v", err)
			}
			if _, err := parseReviewedClosure(
				forgedClosure,
				hexDigest(request.ReviewedClosure.SHA256()),
			); !errors.Is(err, ErrMismatch) {
				t.Fatalf("parseReviewedClosure returned %v, want ErrMismatch", err)
			}

			request.Dependencies = changed
			if _, err := Prepare(request); !errors.Is(err, ErrMismatch) {
				t.Fatalf("Prepare returned %v, want ErrMismatch", err)
			}
		})
	}
}

func TestReviewedClosureParserRequiresExactPolicyCanonicalDocumentAndDigest(t *testing.T) {
	request := validPrepareRequest(t)
	document := request.ReviewedClosure.Document()

	wrongPolicy := bytes.Replace(
		document,
		[]byte(`"policyId":"role-config-v2-package-files"`),
		[]byte(`"policyId":"unreviewed-policy"`),
		1,
	)
	wrongPolicyDigest := sha256.Sum256(wrongPolicy)
	if _, err := parseReviewedClosure(wrongPolicy, hexDigest(wrongPolicyDigest)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("parseReviewedClosure with wrong policy returned %v, want ErrInvalid", err)
	}

	formatted := append(append([]byte(nil), document...), '\n')
	formattedDigest := sha256.Sum256(formatted)
	if _, err := parseReviewedClosure(formatted, hexDigest(formattedDigest)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("parseReviewedClosure with formatting change returned %v, want ErrInvalid", err)
	}
	if _, err := parseReviewedClosure(document, strings.Repeat("A", 64)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("parseReviewedClosure with invalid expected digest returned %v, want ErrInvalid", err)
	}
}

func TestParsePrepareReceiptRejectsForgedExtraDependency(t *testing.T) {
	request := validPrepareRequest(t)
	prepared, err := Prepare(request)
	if err != nil {
		t.Fatal(err)
	}
	var receipt prepareReceiptDocument
	if err := parseCanonical(prepared.ReceiptDocument(), &receipt); err != nil {
		t.Fatal(err)
	}
	receipt.Dependencies = addCanonicalDependency(receipt.Dependencies, releaseprofile.Dependency{
		Root: releasemanifest.RootInstallation, Path: `assets\extra.json`,
		Role: releasemanifest.RoleRuntimeData, SHA256: strings.Repeat("e", 64), Size: "1",
	})
	forged, err := marshalCanonical(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParsePrepareReceipt(forged, request.ReviewedClosure); !errors.Is(err, ErrMismatch) {
		t.Fatalf("ParsePrepareReceipt returned %v, want ErrMismatch", err)
	}
}

func TestCanonicalDocumentsRejectAuthorityInjectionAndFormattingChanges(t *testing.T) {
	prepared, request := validFinalization(t)
	receipt := prepared.ReceiptDocument()
	for _, document := range [][]byte{
		bytes.Replace(receipt, []byte(`"executionAuthority":false`), []byte(`"executionAuthority":true`), 1),
		append(append([]byte(nil), receipt...), '\n'),
	} {
		if _, err := ParsePrepareReceipt(document, prepared.state.closure); !errors.Is(err, ErrInvalid) {
			t.Fatalf("ParsePrepareReceipt returned %v, want ErrInvalid", err)
		}
	}
	if _, err := ParsePrepareReceipt(receipt, ReviewedClosureEvidence{}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("ParsePrepareReceipt without reviewed closure returned %v, want ErrInvalid", err)
	}
	finalized, err := Finalize(prepared, request)
	if err != nil {
		t.Fatal(err)
	}
	descriptor := bytes.Replace(
		finalized.DescriptorDocument(),
		[]byte(`"executionAuthority":false`),
		[]byte(`"executionAuthority":true`),
		1,
	)
	if _, err := parsePackageDescriptor(descriptor); !errors.Is(err, ErrInvalid) {
		t.Fatalf("parsePackageDescriptor returned %v, want ErrInvalid", err)
	}
}

func validFinalization(t *testing.T) (PreparedRelease, FinalizeRequest) {
	t.Helper()
	prepare := validPrepareRequest(t)
	prepared, err := Prepare(prepare)
	if err != nil {
		t.Fatal(err)
	}
	templateDigest := hexDigest(prepared.CompiledTemplateSHA256())
	build := validServiceHostBuild(t, prepared)
	metadata := serviceHostMetadata{
		ReleaseID:                     prepare.ReleaseID,
		TargetArchitecture:            prepare.TargetArchitecture,
		Source:                        prepare.Source,
		CompiledReleaseTemplateSHA256: templateDigest,
		VerifiedAuthenticodeLeafCertificateDERSHA256: prepare.AuthenticodeLeafSignerCertificateDERSHA256,
		SHA256: strings.Repeat("f", 64),
		Size:   "4096",
	}
	return prepared, FinalizeRequest{
		ReleaseID:          prepare.ReleaseID,
		TargetArchitecture: prepare.TargetArchitecture,
		Source:             prepare.Source,
		AuthenticodeLeafSignerCertificateDERSHA256: prepare.AuthenticodeLeafSignerCertificateDERSHA256,
		NodeSpecificSPKI: prepare.NodeSpecificSPKI,
		Dependencies:     cloneDependencies(prepare.Dependencies),
		ServiceHostBuild: build,
		ServiceHost:      verifiedServiceHostFixture(t, prepared, build, metadata),
	}
}

func validPrepareRequest(t *testing.T) PrepareRequest {
	t.Helper()
	dependencies := validDependencies()
	return PrepareRequest{
		ReleaseID:          "worker-2026.09.02.1",
		TargetArchitecture: ArchitectureAMD64,
		Source:             SourceReceipt{Commit: strings.Repeat("a", 40), Tree: strings.Repeat("b", 40)},
		AuthenticodeLeafSignerCertificateDERSHA256: strings.Repeat("e", 64),
		NodeSpecificSPKI: NodeSpecificSPKI{
			Path: `keys\local-authority.spki`, SHA256: strings.Repeat("c", 64),
		},
		ReviewedClosure: validReviewedClosure(t, dependencies),
		Dependencies:    dependencies,
	}
}

func validReviewedClosure(
	t *testing.T,
	dependencies []releaseprofile.Dependency,
) ReviewedClosureEvidence {
	t.Helper()
	document := reviewedClosureDocumentForTest(t, dependencies)
	digest := sha256.Sum256(document)
	evidence, err := parseReviewedClosure(document, hexDigest(digest))
	if err != nil {
		t.Fatal(err)
	}
	return evidence
}

func reviewedClosureDocumentForTest(
	t *testing.T,
	dependencies []releaseprofile.Dependency,
) []byte {
	t.Helper()
	identities := make([]DependencyIdentity, len(dependencies))
	for index, dependency := range dependencies {
		identities[index] = identityOf(dependency)
	}
	document, err := marshalCanonical(reviewedClosureDocument{
		Dependencies:   identities,
		PackageProfile: PackageProfile,
		PolicyID:       ReviewedClosurePolicyID,
		PolicyVersion:  ReviewedClosurePolicyVersion,
		SchemaVersion:  ReviewedClosureSchemaVersion,
	})
	if err != nil {
		t.Fatal(err)
	}
	return document
}

func validServiceHostBuild(t *testing.T, prepared PreparedRelease) ServiceHostBuildEvidence {
	t.Helper()
	receipt := servicehostreceipt.Receipt{
		CompiledReleaseTemplateSHA256: hexDigest(prepared.CompiledTemplateSHA256()),
		PackageProfile:                servicehostreceipt.PackageProfile,
		ReleaseID:                     prepared.state.receipt.ReleaseID,
		SchemaVersion:                 servicehostreceipt.SchemaVersion,
		SigningInvariantSHA256:        strings.Repeat("1", 64),
		Source: servicehostreceipt.Source{
			Commit: prepared.state.receipt.Source.Commit,
			Tree:   prepared.state.receipt.Source.Tree,
		},
		TargetArchitecture: string(prepared.state.receipt.TargetArchitecture),
		UnsignedSHA256:     strings.Repeat("2", 64),
		UnsignedSize:       "4096",
	}
	document, err := servicehostreceipt.MarshalCanonical(receipt)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(document)
	return ServiceHostBuildEvidence{state: &serviceHostBuildState{
		document: document,
		sha256:   digest,
		receipt:  receipt,
	}}
}

func verifiedServiceHostFixture(
	t *testing.T,
	prepared PreparedRelease,
	build ServiceHostBuildEvidence,
	metadata serviceHostMetadata,
) VerifiedServiceHostEvidence {
	t.Helper()
	digestBytes, err := hex.DecodeString(metadata.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	var digest [sha256.Size]byte
	copy(digest[:], digestBytes)
	size, err := strconv.ParseUint(metadata.Size, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	signature := validAuthenticodeFixture(metadata.VerifiedAuthenticodeLeafCertificateDERSHA256)
	return VerifiedServiceHostEvidence{state: &verifiedServiceHostState{
		metadata:              metadata,
		preparedReceiptSHA256: prepared.state.receiptSHA256,
		buildReceiptSHA256:    build.state.sha256,
		fileIdentity: winfile.FileIdentity{
			VolumeSerialNumber: 1,
			FileID:             [16]byte{1},
		},
		digest:       digest,
		size:         size,
		authenticode: signature,
	}}
}

func mutateVerifiedServiceHost(
	request *FinalizeRequest,
	mutate func(*serviceHostMetadata),
) {
	state := *request.ServiceHost.state
	metadata := request.ServiceHost.state.metadata
	mutate(&metadata)
	state.metadata = metadata
	request.ServiceHost = VerifiedServiceHostEvidence{state: &state}
}

func validAuthenticodeFixture(signer string) authenticode.Evidence {
	return authenticode.Evidence{
		Trusted:                                true,
		SignatureKind:                          authenticode.SignatureKindEmbedded,
		SignatureCount:                         1,
		VerifiedSignatureIndex:                 0,
		RevocationPolicy:                       authenticode.RevocationPolicyRuntimeCacheOnlyNoCheck,
		DigestPolicy:                           authenticode.DigestPolicySHA256Only,
		StrongSignaturePolicy:                  authenticode.StrongSignaturePolicyWindowsOSCurrent,
		SignerDigestAlgorithmOID:               authenticode.SHA256ObjectIdentifier,
		FileDigestAlgorithmOID:                 authenticode.SHA256ObjectIdentifier,
		SignerIdentity:                         "test signer",
		VerifiedLeafSignerCertificateDERSHA256: signer,
	}
}

func addCanonicalDependency(
	dependencies []releaseprofile.Dependency,
	dependency releaseprofile.Dependency,
) []releaseprofile.Dependency {
	result := append(cloneDependencies(dependencies), dependency)
	sort.Slice(result, func(left, right int) bool {
		if result[left].Root != result[right].Root {
			return result[left].Root == releasemanifest.RootInstallation
		}
		return strings.ToLower(result[left].Path) < strings.ToLower(result[right].Path)
	})
	return result
}

func validDependencies() []releaseprofile.Dependency {
	file := func(path string, role releasemanifest.FileRole, digit string) releaseprofile.Dependency {
		return releaseprofile.Dependency{
			Root: releasemanifest.RootInstallation, Path: path, Role: role,
			SHA256: strings.Repeat(digit, 64), Size: "1",
		}
	}
	trusted := func(path string, role releasemanifest.FileRole, digit string) releaseprofile.Dependency {
		value := file(path, role, digit)
		value.Root = releasemanifest.RootTrustedConfiguration
		return value
	}
	return []releaseprofile.Dependency{
		file(ControlServiceWrapperPath, releasemanifest.RoleServiceWrapper, "1"),
		file(ControlServiceConfigPath, releasemanifest.RoleServiceConfig, "9"),
		file(ExecutorServiceWrapperPath, releasemanifest.RoleServiceWrapper, "2"),
		file(ExecutorServiceConfigPath, releasemanifest.RoleServiceConfig, "a"),
		file(ControlBundlePath, releasemanifest.RoleControlBundle, "3"),
		file(ExecutorBundlePath, releasemanifest.RoleExecutorBundle, "4"),
		file(`codex\codex.exe`, releasemanifest.RoleCodexCLI, "5"),
		file(`git\cmd\git.exe`, releasemanifest.RoleGitCLI, "6"),
		file(`native\AgenticReview.ProcessHost.exe`, releasemanifest.RoleProcessHost, "7"),
		file(`runtime\node.exe`, releasemanifest.RoleNodeRuntime, "8"),
		trusted(`certificates\server-root.cer`, releasemanifest.RoleCABundle, "b"),
		trusted(`keys\local-authority.spki`, releasemanifest.RoleTrustedConfig, "c"),
		trusted(`policy\codex-requirements.toml`, releasemanifest.RolePolicy, "d"),
	}
}

func identityOf(value releaseprofile.Dependency) DependencyIdentity {
	return DependencyIdentity{Root: value.Root, Path: value.Path, Role: value.Role}
}

func dependencyIndex(values []releaseprofile.Dependency, role releasemanifest.FileRole) int {
	for index, value := range values {
		if value.Role == role {
			return index
		}
	}
	panic("fixture role is missing: " + string(role))
}

func dependencyPathIndex(values []releaseprofile.Dependency, path string) int {
	for index, value := range values {
		if value.Path == path {
			return index
		}
	}
	panic("test dependency path is missing: " + path)
}

func removeDependencyPath(values []releaseprofile.Dependency, path string) []releaseprofile.Dependency {
	result := make([]releaseprofile.Dependency, 0, len(values))
	for _, value := range values {
		if value.Path != path {
			result = append(result, value)
		}
	}
	return result
}

func cloneFinalizeRequest(value FinalizeRequest) FinalizeRequest {
	value.Dependencies = cloneDependencies(value.Dependencies)
	return value
}

func hexDigest(value [sha256.Size]byte) string { return hex.EncodeToString(value[:]) }

const (
	compiledTemplateGoldenSHA256  = "87bf868e15b0ba6e47899f75f888147470eff634ab754d2f99cc8e015c66cb1a"
	reviewedClosureGoldenSHA256   = "54b9ae2accb633cd6ce5dcb5cb3bf9a5b0ebc859f6451f9664fbdd2f6cf19cf2"
	prepareReceiptGoldenSHA256    = "44405499a5eb16d68f6a19371f3fd9b897a4d9d49ae35d67d79e5f694736c933"
	runtimeManifestGoldenSHA256   = "716eb10405be9c6b45a8a30b0752718bd1928f9104f044692e2d786ecad2d21a"
	packageDescriptorGoldenSHA256 = "fb9ed77e0b6fa554eb9457a77d5c18ac20e0796dffe36c43bd771dcb4c939ac4"
)
