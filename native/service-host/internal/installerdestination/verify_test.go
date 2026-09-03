package installerdestination

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installerprofile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/stagedpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

func TestVerifyWithDependenciesReopensCompleteDestinationAndOwnsSource(t *testing.T) {
	resetCleanupForTest(t)
	fixture := newDestinationFixture(t)
	evidence := fixture.verify(t)
	if err := evidence.Validate(); err != nil {
		t.Fatal(err)
	}
	if evidence.PackageID() != fixture.plan.index.PackageID || len(evidence.Roots()) != 3 ||
		len(evidence.Files()) != len(fixture.plan.index.Payloads)+2 {
		t.Fatal("destination evidence did not retain the complete signed closure")
	}
	if _, err := json.Marshal(evidence); !errors.Is(err, ErrSerialization) {
		t.Fatalf("MarshalJSON returned %v, want ErrSerialization", err)
	}
	if repeated, err := verifyWithDependencies(context.Background(), fixture.dependencies()); err == nil || repeated.state != nil {
		t.Fatal("one staged source gate was accepted more than once")
	}
	if fixture.source.closed {
		t.Fatal("a rejected repeated borrow closed the source owned by the first evidence")
	}
	if err := evidence.Close(); err != nil {
		t.Fatal(err)
	}
	if err := evidence.Validate(); !errors.Is(err, ErrClosed) {
		t.Fatalf("Validate after Close returned %v, want ErrClosed", err)
	}
	if evidence.PackageID() != "" || evidence.Roots() != nil || evidence.Files() != nil {
		t.Fatal("closed destination evidence still exposed detached data")
	}
	if err := evidence.Close(); err != nil {
		t.Fatalf("second Close returned %v", err)
	}
	if !fixture.source.closed {
		t.Fatal("destination evidence did not close the originating staged source")
	}
}

func TestSourcePlanRejectsRootAndSignatureDrift(t *testing.T) {
	fixture := newDestinationFixture(t)
	tests := []struct {
		name   string
		mutate func(*sourcePlan)
	}{
		{
			name: "alternate installation root",
			mutate: func(plan *sourcePlan) {
				plan.index.TargetRoots.Installation = `C:\Alternate\Worker`
				document, _ := outerpackage.MarshalIndexCanonical(plan.index)
				plan.indexDocument = document
			},
		},
		{
			name:   "signature envelope",
			mutate: func(plan *sourcePlan) { plan.envelopeDocument[0] ^= 1 },
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			plan := cloneSourcePlan(fixture.plan)
			test.mutate(&plan)
			if _, err := parseSourcePlan(plan.indexDocument, plan.envelopeDocument, plan.controlDocument, plan.executorDocument, plan.signerKeyID); err == nil {
				t.Fatal("drifted source plan was accepted")
			}
		})
	}
}

func TestVerifyRejectsRootCaseTreeAndByteDrift(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*destinationFixture)
	}{
		{
			name: "root case",
			mutate: func(fixture *destinationFixture) {
				fixture.fs.mustNode(installerprofile.TrustedConfigurationRoot).name = "trustedconfig"
			},
		},
		{
			name: "unexpected file",
			mutate: func(fixture *destinationFixture) {
				fixture.fs.addFile(joinPath(fixture.plan.index.TargetRoots.Metadata, "unexpected.txt"), []byte("unexpected"))
			},
		},
		{
			name: "payload bytes",
			mutate: func(fixture *destinationFixture) {
				fixture.fs.mustNode(joinPath(fixture.plan.index.TargetRoots.Installation, `app\control.mjs`)).data = []byte("drift")
			},
		},
		{
			name: "metadata index bytes",
			mutate: func(fixture *destinationFixture) {
				fixture.fs.mustNode(joinPath(fixture.plan.index.TargetRoots.Metadata, outerpackage.PackageIndexPath)).data[0] ^= 1
			},
		},
		{
			name: "metadata signature bytes",
			mutate: func(fixture *destinationFixture) {
				fixture.fs.mustNode(joinPath(fixture.plan.index.TargetRoots.Metadata, outerpackage.SignatureEnvelopePath)).data[0] ^= 1
			},
		},
		{
			name: "bootstrap bytes",
			mutate: func(fixture *destinationFixture) {
				fixture.fs.mustNode(joinPath(fixture.plan.index.TargetRoots.TrustedConfiguration, outerpackage.ControlBootstrapPath)).data[0] ^= 1
			},
		},
		{
			name: "payload path case",
			mutate: func(fixture *destinationFixture) {
				fixture.fs.mustNode(joinPath(fixture.plan.index.TargetRoots.Installation, `app\control.mjs`)).name = "Control.mjs"
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			resetCleanupForTest(t)
			fixture := newDestinationFixture(t)
			test.mutate(fixture)
			evidence, err := verifyWithDependencies(context.Background(), fixture.dependencies())
			if err == nil || evidence.state != nil {
				t.Fatal("drifted destination was accepted")
			}
			if !fixture.source.closed {
				t.Fatal("failed destination verification leaked the staged source")
			}
		})
	}
}

func TestVerifyBindsMetadataEnvelopeToExactIndex(t *testing.T) {
	resetCleanupForTest(t)
	fixture := newDestinationFixture(t)
	fixture.plan.signerKeyID = strings.Repeat("b", 64)
	fixture.source.plan = fixture.plan
	evidence, err := verifyWithDependencies(context.Background(), fixture.dependencies())
	if err == nil || evidence.state != nil {
		t.Fatal("source signer drift was accepted")
	}
}

func TestVerifyRequiresDestinationReadmission(t *testing.T) {
	resetCleanupForTest(t)
	fixture := newDestinationFixture(t)
	deps := fixture.dependencies()
	deps.admitDestination = func(sourcePlan) error { return errors.New("compiled trust rejected destination") }
	evidence, err := verifyWithDependencies(context.Background(), deps)
	if !errors.Is(err, ErrInvalidSource) || evidence.state != nil {
		t.Fatalf("Verify returned evidence=%#v err=%v", evidence, err)
	}
	if !fixture.source.closed {
		t.Fatal("destination re-admission failure leaked the staged source")
	}
}

func TestOrdinarySourceDriftIsInvalidNotCleanupFatal(t *testing.T) {
	resetCleanupForTest(t)
	fixture := newDestinationFixture(t)
	fixture.source.validateErr = errors.New("source drift")
	evidence, err := verifyWithDependencies(context.Background(), fixture.dependencies())
	if !errors.Is(err, ErrInvalidSource) || errors.Is(err, ErrCleanupFatal) || evidence.state != nil {
		t.Fatalf("Verify returned evidence=%#v err=%v", evidence, err)
	}
	if !fixture.source.closed {
		t.Fatal("verification that began borrowing the source did not close it after ordinary drift")
	}
}

func TestDestinationCleanupFailurePublishesFatalState(t *testing.T) {
	resetCleanupForTest(t)
	fixture := newDestinationFixture(t)
	evidence := fixture.verify(t)
	fixture.fs.mustNode(joinPath(fixture.plan.index.TargetRoots.Metadata, outerpackage.PackageIndexPath)).closeFailures = 100
	if err := evidence.Close(); !errors.Is(err, ErrCleanupFatal) {
		t.Fatalf("Close returned %v, want ErrCleanupFatal", err)
	}
	if err := evidence.Close(); !errors.Is(err, ErrCleanupFatal) {
		t.Fatalf("second Close returned %v, want cached ErrCleanupFatal", err)
	}
	if err := evidence.Validate(); !errors.Is(err, ErrCleanupFatal) {
		t.Fatalf("Validate after fatal cleanup returned %v, want ErrCleanupFatal", err)
	}
}

func TestPostOpenEvidenceFailureRetainsHandleForBoundedCleanup(t *testing.T) {
	t.Run("retry converges", func(t *testing.T) {
		resetCleanupForTest(t)
		fixture := newDestinationFixture(t)
		fixture.fs.root.identity = winfile.FileIdentity{}
		fixture.fs.root.closeFailures = closeAttempts - 1
		evidence, err := verifyWithDependencies(context.Background(), fixture.dependencies())
		if err == nil || errors.Is(err, ErrCleanupFatal) || evidence.state != nil {
			t.Fatalf("Verify returned evidence=%#v err=%v", evidence, err)
		}
		if fixture.fs.root.closeFailures != 0 || !fixture.source.closed || !cleanupHealthy() {
			t.Fatal("post-open rejection did not retain and close the handle through the owner")
		}
	})

	t.Run("unresolved close is fatal", func(t *testing.T) {
		resetCleanupForTest(t)
		fixture := newDestinationFixture(t)
		fixture.fs.root.identity = winfile.FileIdentity{}
		fixture.fs.root.closeFailures = closeAttempts + 1
		evidence, err := verifyWithDependencies(context.Background(), fixture.dependencies())
		if !errors.Is(err, ErrCleanupFatal) || evidence.state != nil || cleanupHealthy() {
			t.Fatalf("Verify returned evidence=%#v err=%v", evidence, err)
		}
	})
}

func TestStagedCleanupFatalMapsAcrossInitialValidateAndClose(t *testing.T) {
	t.Run("initial borrow failure", func(t *testing.T) {
		resetCleanupForTest(t)
		fixture := newDestinationFixture(t)
		deps := fixture.dependencies()
		deps.acquireSource = func() sourceLease {
			return sourceLease{
				withBinding: func(func(sourcePlan) error) error { return stagedpackage.ErrCleanupFatal },
				validate:    func() error { return nil },
				close:       func() error { return nil },
				commit:      func(cleanupOperation, func()) error { return nil },
			}
		}
		if evidence, err := verifyWithDependencies(context.Background(), deps); !errors.Is(err, ErrCleanupFatal) || evidence.state != nil {
			t.Fatalf("Verify returned evidence=%#v err=%v", evidence, err)
		}
	})

	t.Run("evidence validate", func(t *testing.T) {
		resetCleanupForTest(t)
		fixture := newDestinationFixture(t)
		evidence := fixture.verify(t)
		fixture.source.validateErr = stagedpackage.ErrCleanupFatal
		if err := evidence.Validate(); !errors.Is(err, ErrCleanupFatal) {
			t.Fatalf("Validate returned %v, want ErrCleanupFatal", err)
		}
		fixture.source.validateErr = nil
		if err := evidence.Close(); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("source close", func(t *testing.T) {
		resetCleanupForTest(t)
		fixture := newDestinationFixture(t)
		evidence := fixture.verify(t)
		fixture.source.closeErr = stagedpackage.ErrCleanupFatal
		if err := evidence.Close(); !errors.Is(err, ErrCleanupFatal) {
			t.Fatalf("Close returned %v, want ErrCleanupFatal", err)
		}
		if err := evidence.Close(); !errors.Is(err, ErrCleanupFatal) {
			t.Fatalf("second Close returned %v, want cached ErrCleanupFatal", err)
		}
	})
}

func resetCleanupForTest(t *testing.T) {
	t.Helper()
	original := processCleanup
	processCleanup = &cleanupState{
		platformStatus: func() error { return nil },
		platformCommit: func(commit func()) error { commit(); return nil },
	}
	t.Cleanup(func() { processCleanup = original })
}
