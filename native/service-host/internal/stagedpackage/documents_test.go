package stagedpackage

import (
	"errors"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasepackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/servicehostreceipt"
)

func TestDocumentBindingsCoverReleaseManifestSignerAndBuildLineage(t *testing.T) {
	index := validTestIndex(t)
	facts, control, executor := validDocumentBindingFixture(t, index)
	if err := validateDocumentBindings(index, control, executor, facts); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name   string
		mutate func(*outerpackage.Index, *config.Config, *config.Config, *releasepackage.FinalizedDocumentFacts)
	}{
		{name: "release", mutate: func(_ *outerpackage.Index, _ *config.Config, _ *config.Config, value *releasepackage.FinalizedDocumentFacts) {
			value.Descriptor.ReleaseID += ".other"
		}},
		{name: "source", mutate: func(_ *outerpackage.Index, _ *config.Config, _ *config.Config, value *releasepackage.FinalizedDocumentFacts) {
			value.ServiceHostBuild.Source.Tree = strings.Repeat("a", 40)
		}},
		{name: "architecture", mutate: func(_ *outerpackage.Index, _ *config.Config, _ *config.Config, value *releasepackage.FinalizedDocumentFacts) {
			value.Descriptor.TargetArchitecture = releasepackage.ArchitectureARM64
		}},
		{name: "bootstrap signer", mutate: func(_ *outerpackage.Index, control *config.Config, _ *config.Config, _ *releasepackage.FinalizedDocumentFacts) {
			control.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256 = strings.Repeat("a", 64)
		}},
		{name: "manifest payload", mutate: func(_ *outerpackage.Index, _ *config.Config, _ *config.Config, value *releasepackage.FinalizedDocumentFacts) {
			value.Manifest.Files[0].SHA256 = strings.Repeat("a", 64)
		}},
		{name: "build template", mutate: func(_ *outerpackage.Index, _ *config.Config, _ *config.Config, value *releasepackage.FinalizedDocumentFacts) {
			value.ServiceHostBuild.CompiledReleaseTemplateSHA256 = strings.Repeat("a", 64)
		}},
		{name: "ServiceHost descriptor", mutate: func(_ *outerpackage.Index, _ *config.Config, _ *config.Config, value *releasepackage.FinalizedDocumentFacts) {
			value.Descriptor.ServiceHost.SHA256 = strings.Repeat("a", 64)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			changedIndex := cloneIndex(index)
			changedControl := control
			changedExecutor := executor
			changedFacts := cloneDocumentFacts(facts)
			test.mutate(&changedIndex, &changedControl, &changedExecutor, &changedFacts)
			if err := validateDocumentBindings(changedIndex, changedControl, changedExecutor, changedFacts); !errors.Is(err, ErrDocuments) {
				t.Fatalf("mutated binding returned %v, want ErrDocuments", err)
			}
		})
	}
}

func validDocumentBindingFixture(
	t testing.TB,
	index outerpackage.Index,
) (releasepackage.FinalizedDocumentFacts, config.Config, config.Config) {
	t.Helper()
	manifest := releasemanifest.Manifest{
		Compatibility:   releasemanifest.RequiredCompatibility(),
		PublisherPolicy: releasemanifest.PublisherPolicy,
		ReleaseID:       index.ReleaseID,
		SchemaVersion:   releasemanifest.SchemaVersion,
	}
	for _, payload := range index.Payloads {
		if !isSpecialPayloadRole(payload.Role) {
			manifest.Files = append(manifest.Files, releasemanifest.File{
				Root: releasemanifest.FileRoot(payload.Root), Path: payload.Path,
				Role: releasemanifest.FileRole(payload.Role), SHA256: payload.SHA256, Size: payload.Size,
			})
		}
	}
	document, err := releasemanifest.MarshalCanonical(manifest)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err = releasemanifest.Parse(document)
	if err != nil {
		t.Fatal(err)
	}
	serviceHost, found := manifest.LookupFile(
		releasemanifest.RootInstallation,
		`native\AgenticReview.ServiceHost.exe`,
	)
	if !found {
		t.Fatal("fixture ServiceHost is absent")
	}
	signer := strings.Repeat("b", 64)
	descriptor := releasepackage.PackageDescriptor{
		AuthenticodeLeafSignerCertificateDERSHA256: signer,
		CompiledReleaseTemplateSHA256:              strings.Repeat("c", 64),
		ReleaseID:                                  index.ReleaseID,
		ServiceHost:                                serviceHost,
		Source:                                     releasepackage.SourceReceipt{Commit: index.Source.Commit, Tree: index.Source.Tree},
		TargetArchitecture:                         releasepackage.TargetArchitecture(index.TargetArchitecture),
	}
	build := servicehostreceipt.Receipt{
		CompiledReleaseTemplateSHA256: descriptor.CompiledReleaseTemplateSHA256,
		ReleaseID:                     index.ReleaseID,
		Source:                        servicehostreceipt.Source{Commit: index.Source.Commit, Tree: index.Source.Tree},
		TargetArchitecture:            string(index.TargetArchitecture),
	}
	control := config.Config{Installation: config.Installation{
		ApprovedAuthenticodeSignerCertificateDERSHA256: signer,
	}}
	executor := config.Config{Installation: config.Installation{
		ApprovedAuthenticodeSignerCertificateDERSHA256: signer,
	}}
	return releasepackage.FinalizedDocumentFacts{
		Descriptor: descriptor, Manifest: manifest, ServiceHostBuild: build,
	}, control, executor
}
