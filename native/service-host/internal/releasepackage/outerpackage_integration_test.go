package releasepackage_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasepackage"
)

func TestOuterPackagePublicEntryPointUsesRealFinalizedReleaseSnapshot(t *testing.T) {
	finalized := releasepackage.FinalizedReleaseForOuterPackageTest(t)
	options := outerPackageBuildOptions()
	document, err := outerpackage.BuildIndex(finalized, options)
	if err != nil {
		t.Fatal(err)
	}
	index, err := outerpackage.ParseIndex(document)
	if err != nil {
		t.Fatal(err)
	}
	if index.SchemaVersion != outerpackage.IndexSchemaVersion ||
		index.ProfileID != outerpackage.IndexProfileID ||
		index.LocalAuthorityCNG != options.LocalAuthorityCNG ||
		index.ReleaseID != finalized.Descriptor().ReleaseID ||
		index.Source.Commit != finalized.Descriptor().Source.Commit ||
		index.Source.Tree != finalized.Descriptor().Source.Tree {
		t.Fatalf("outer index differs from real finalized release: %#v", index)
	}
	if err := outerpackage.ValidateAgainstRelease(document, finalized); err != nil {
		t.Fatal(err)
	}
}

func TestOuterPackageBuildIndexRejectsCleanupFatalAfterFinalization(t *testing.T) {
	tests := []struct {
		name      string
		finalized func(*testing.T) releasepackage.FinalizedRelease
	}{
		{
			name:      "release cleanup fatal",
			finalized: releasepackage.FinalizedReleaseWithReleaseCleanupFatalForOuterPackageTest,
		},
		{
			name:      "platform cleanup fatal",
			finalized: releasepackage.FinalizedReleaseWithPlatformCleanupFatalForOuterPackageTest,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			finalized := test.finalized(t)
			if document, err := outerpackage.BuildIndex(finalized, outerPackageBuildOptions()); !errors.Is(err, releasepackage.ErrReleaseCleanupFatal) || document != nil {
				t.Fatalf("BuildIndex returned document=%q err=%v", document, err)
			}
		})
	}
}

func outerPackageBuildOptions() outerpackage.BuildOptions {
	return outerpackage.BuildOptions{
		PackageID:      "worker-package-2026.09.02.1",
		InstallationID: "installation-node-001",
		WorkerNodeID:   "worker-node-001",
		LocalAuthorityCNG: outerpackage.LocalAuthorityCNGIdentity{
			KeyName:                  "AgenticReview.Worker.Control.LocalAuthority",
			SecurityDescriptorSHA256: strings.Repeat("1", 64),
		},
		TargetRoots: outerpackage.TargetRoots{
			Installation:         `C:\Program Files\AgenticReview\Worker`,
			Metadata:             `C:\ProgramData\AgenticReview\Packages\worker-package-2026.09.02.1`,
			TrustedConfiguration: `C:\ProgramData\AgenticReview\TrustedConfig`,
		},
		ControlBootstrap: outerpackage.BootstrapPayload{
			SHA256: strings.Repeat("4", 64),
			Size:   "1024",
		},
		ExecutorBootstrap: outerpackage.BootstrapPayload{
			SHA256: strings.Repeat("5", 64),
			Size:   "1024",
		},
	}
}
