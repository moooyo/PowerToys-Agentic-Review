package launchguard

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/preflight"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winprocess"
)

func TestOpenWithDependenciesRetainsExactRoleTargets(t *testing.T) {
	for _, role := range []config.Role{config.RoleControl, config.RoleExecutor} {
		t.Run(string(role), func(t *testing.T) {
			fixture := newGuardFixture(t, role)
			guard, err := openWithDependencies(context.Background(), fixture.authority, fixture.deps)
			if err != nil {
				t.Fatal(err)
			}
			wantFiles := 2
			if role == config.RoleExecutor {
				wantFiles = 3
			}
			if guard.Role() != role || guard.PreflightDigest() != fixture.authority.preflightDigest ||
				len(guard.state.files) != wantFiles || len(guard.state.directories) == 0 {
				t.Fatal("guard omitted role-local launch resources")
			}
			if fixture.fs.file(testNode).authCalls != 2 {
				t.Fatalf("Node Authenticode calls = %d, want 2", fixture.fs.file(testNode).authCalls)
			}
			bundlePath := testControlBundle
			if role == config.RoleExecutor {
				bundlePath = testExecutorBundle
				if fixture.fs.file(testProcessHost).authCalls != 2 {
					t.Fatalf("ProcessHost Authenticode calls = %d, want 2", fixture.fs.file(testProcessHost).authCalls)
				}
			}
			if fixture.fs.file(bundlePath).authCalls != 0 {
				t.Fatal("role bundle was treated as PE Authenticode authority")
			}
			for _, options := range fixture.fs.openOptions {
				if options.VolumeUse != winfile.VolumeUseReadOnly {
					t.Fatal("guard opened a launch object for writable volume use")
				}
			}
			if err := guard.Close(); err != nil {
				t.Fatal(err)
			}
			assertFilesClosedBeforeDirectories(t, fixture.fs.events)
		})
	}
}

func TestOpenHonorsCancellationBeforeFilesystemAccess(t *testing.T) {
	fixture := newGuardFixture(t, config.RoleControl)
	cause := errors.New("startup cancelled")
	ctx, cancel := context.WithCancelCause(context.Background())
	cancel(cause)
	guard, err := openWithDependencies(ctx, fixture.authority, fixture.deps)
	if guard != nil || !errors.Is(err, cause) || fixture.fs.openCalls != 0 {
		t.Fatalf("cancelled open = (%v, %v), calls=%d", guard, err, fixture.fs.openCalls)
	}
}

func TestAuthoritySnapshotSelectionIsRoleExact(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*authoritySnapshot)
	}{
		{"role", func(value *authoritySnapshot) { value.role = config.RoleExecutor }},
		{"digest", func(value *authoritySnapshot) { value.preflightDigest = [32]byte{} }},
		{"signer", func(value *authoritySnapshot) { value.signerPin = "bad" }},
		{"missing target", func(value *authoritySnapshot) { value.targets = value.targets[:1] }},
		{"duplicate kind", func(value *authoritySnapshot) { value.targets[1].kind = targetNode }},
		{"target role", func(value *authoritySnapshot) { value.targets[1].file.Role = releasemanifest.RoleExecutorBundle }},
		{"target path", func(value *authoritySnapshot) { value.targets[0].file.AbsolutePath += ".other" }},
		{"target digest", func(value *authoritySnapshot) { value.targets[0].file.SHA256 = strings.Repeat("b", 64) }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newGuardFixture(t, config.RoleControl)
			candidate := cloneAuthority(fixture.authority)
			test.mutate(&candidate)
			if err := validateAuthoritySnapshot(candidate); !errors.Is(err, ErrInvalidAuthority) {
				t.Fatalf("validateAuthoritySnapshot = %v", err)
			}
		})
	}
	if _, err := captureAuthorityOnce(preflight.Evidence{}, preflight.RuntimePlan{}); !errors.Is(err, ErrInvalidAuthority) {
		t.Fatalf("zero public authority capture = %v", err)
	}
}

func TestOpenRejectsReopenAndContentMismatches(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*guardFixture)
	}{
		{"file identity", func(f *guardFixture) { f.fs.file(testNode).evidence.Identity.FileID[0] ^= 1 }},
		{"file size", func(f *guardFixture) { f.fs.file(testNode).evidence.Size++ }},
		{"file hard link", func(f *guardFixture) { f.fs.file(testNode).evidence.LinkCount = 2 }},
		{"file reparse", func(f *guardFixture) { f.fs.file(testNode).evidence.Attributes = 0x400 }},
		{"file bytes", func(f *guardFixture) { f.fs.file(testNode).data[0] ^= 1 }},
		{"file streams", func(f *guardFixture) { f.fs.file(testNode).streamErr = winfile.ErrNamedDataStream }},
		{"signer", func(f *guardFixture) {
			f.fs.file(testNode).auth.VerifiedLeafSignerCertificateDERSHA256 = strings.Repeat("b", 64)
		}},
		{"ancestor identity", func(f *guardFixture) { f.fs.directory(`C:\Program Files`).evidence.Identity.FileID[0] ^= 1 }},
		{"directory case mode", func(f *guardFixture) { f.fs.directory(testRoot + `\runtime`).caseSensitive = true }},
		{"directory collision", func(f *guardFixture) {
			f.fs.directory(testRoot + `\runtime`).enumerateErr = winfile.ErrDirectoryCaseCollision
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newGuardFixture(t, config.RoleControl)
			test.mutate(fixture)
			guard, err := openWithDependencies(context.Background(), fixture.authority, fixture.deps)
			if err == nil || guard != nil {
				t.Fatal("mismatched reopen produced a guard")
			}
			if len(fixture.fs.events) == 0 {
				t.Fatal("rejected reopen did not clean up retained handles")
			}
			assertFilesClosedBeforeDirectories(t, fixture.fs.events)
		})
	}
}

func TestDiagnosticPathChangesDoNotAffectAuthority(t *testing.T) {
	fixture := newGuardFixture(t, config.RoleControl)
	fixture.fs.file(testNode).evidence.Path.FinalPathDiagnostic = `\\?\C:\diagnostic-only\node.exe`
	fixture.fs.file(testNode).evidence.Path.FinalPathDiagnosticError = "diagnostic only"
	fixture.fs.file(testNode).evidence.Volume.VolumePath = `\\?\Volume{diagnostic-only}\`
	guard, err := openWithDependencies(context.Background(), fixture.authority, fixture.deps)
	if err != nil {
		t.Fatalf("diagnostic-only change rejected: %v", err)
	}
	if err := guard.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyUnchangedDetectsPostOpenTampering(t *testing.T) {
	fixture := newGuardFixture(t, config.RoleControl)
	guard, err := openWithDependencies(context.Background(), fixture.authority, fixture.deps)
	if err != nil {
		t.Fatal(err)
	}
	fixture.fs.file(testControlBundle).data[0] ^= 1
	if err := guard.VerifyUnchanged(context.Background()); !errors.Is(err, ErrChanged) {
		t.Fatalf("VerifyUnchanged = %v, want ErrChanged", err)
	}
	if _, err := guard.LaunchNode(context.Background(), validPipeName()); !errors.Is(err, ErrChanged) {
		t.Fatalf("LaunchNode after tamper = %v, want ErrChanged", err)
	}
}

func TestNodeLaunchSpecUsesOnlyForceTerminationReserve(t *testing.T) {
	fixture := newGuardFixture(t, config.RoleControl)
	fixture.authority.configuration.Limits.ShutdownTimeoutMilliseconds = 120_000
	fixture.authority.configuration.Limits.ForceTerminationReserveMilliseconds = 7_000
	guard, err := openWithDependencies(context.Background(), fixture.authority, fixture.deps)
	if err != nil {
		t.Fatal(err)
	}
	spec, err := guard.state.nodeLaunchSpec(validPipeName())
	if err != nil {
		t.Fatal(err)
	}
	if spec.ShutdownTimeout != 7*time.Second {
		t.Fatalf("Node launch shutdown timeout = %v, want the 7s force-termination reserve", spec.ShutdownTimeout)
	}
	if err := guard.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestLaunchIsOneShotAndGuardLivesUntilJobDrain(t *testing.T) {
	for _, role := range []config.Role{config.RoleControl, config.RoleExecutor} {
		t.Run(string(role), func(t *testing.T) {
			fixture := newGuardFixture(t, role)
			guard, err := openWithDependencies(context.Background(), fixture.authority, fixture.deps)
			if err != nil {
				t.Fatal(err)
			}
			process, err := guard.LaunchNode(context.Background(), validPipeName())
			if err != nil {
				t.Fatal(err)
			}
			if len(fixture.launched) != 1 || fixture.launched[0].ExecutablePath != testNode ||
				fixture.launched[0].BundlePath != fixture.authority.configuration.Node.BundlePath {
				t.Fatal("guard did not derive raw launch paths from preflight")
			}
			if len(fixture.fs.events) != 0 {
				t.Fatal("guard resources closed before root Job drain")
			}
			if role == config.RoleExecutor && fixture.fs.file(testProcessHost).closeCalls != 0 {
				t.Fatal("Executor ProcessHost guard closed before root Job drain")
			}
			if _, err := guard.LaunchNode(context.Background(), validPipeName()); !errors.Is(err, ErrConsumed) {
				t.Fatalf("second launch = %v", err)
			}
			if err := guard.Close(); !errors.Is(err, ErrConsumed) {
				t.Fatalf("guard alias Close = %v", err)
			}
			if _, err := process.Wait(); err != nil {
				t.Fatal(err)
			}
			assertFilesClosedBeforeDirectories(t, fixture.fs.events)
		})
	}
}

func TestGuardedNodeRetainsHandlesUntilSuccessfulDrain(t *testing.T) {
	fixture := newGuardFixture(t, config.RoleExecutor)
	transient := errors.New("job did not drain")
	fixture.node.terminateErrors = []error{transient, nil}
	guard, err := openWithDependencies(context.Background(), fixture.authority, fixture.deps)
	if err != nil {
		t.Fatal(err)
	}
	process, err := guard.LaunchNode(context.Background(), validPipeName())
	if err != nil {
		t.Fatal(err)
	}
	if err := process.Terminate(); !errors.Is(err, transient) {
		t.Fatalf("first Terminate = %v", err)
	}
	if len(fixture.fs.events) != 0 {
		t.Fatal("failed Job drain released launch handles")
	}
	if err := process.Terminate(); err != nil {
		t.Fatal(err)
	}
	assertFilesClosedBeforeDirectories(t, fixture.fs.events)
}

func TestGuardedNodeWaitContextCancellationRetainsHandlesAndCanRetry(t *testing.T) {
	fixture := newGuardFixture(t, config.RoleExecutor)
	guard, err := openWithDependencies(context.Background(), fixture.authority, fixture.deps)
	if err != nil {
		t.Fatal(err)
	}
	process, err := guard.LaunchNode(context.Background(), validPipeName())
	if err != nil {
		t.Fatal(err)
	}
	cause := errors.New("stop observing Node")
	ctx, cancel := context.WithCancelCause(context.Background())
	cancel(cause)
	if _, err := process.WaitContext(ctx); !errors.Is(err, cause) {
		t.Fatalf("canceled WaitContext error=%v", err)
	}
	if len(fixture.fs.events) != 0 {
		t.Fatal("observational wait cancellation released launch handles")
	}
	if _, err := process.WaitContext(context.Background()); err != nil {
		t.Fatalf("retry WaitContext error=%v", err)
	}
	assertFilesClosedBeforeDirectories(t, fixture.fs.events)
}

func TestGuardedNodeWaitContextFatalCleanupQuarantinesCompositeOwner(t *testing.T) {
	fixture := newGuardFixture(t, config.RoleExecutor)
	fatalNode := errors.Join(winprocess.ErrLaunchCleanupFatal, errors.New("wait handle ownership unresolved"))
	fixture.node.waitErr = fatalNode
	guard, err := openWithDependencies(context.Background(), fixture.authority, fixture.deps)
	if err != nil {
		t.Fatal(err)
	}
	process, err := guard.LaunchNode(context.Background(), validPipeName())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := process.WaitContext(context.Background()); !errors.Is(err, ErrCleanupFatal) || !errors.Is(err, fatalNode) {
		t.Fatalf("guarded WaitContext error=%v", err)
	}
	fixture.deps.quarantine.mu.RLock()
	owners := append([]any(nil), fixture.deps.quarantine.owners...)
	fixture.deps.quarantine.mu.RUnlock()
	if len(owners) != 1 {
		t.Fatalf("quarantine owners=%d, want 1", len(owners))
	}
	owner, ok := owners[0].(*rejectedLaunchOwner)
	if !ok || owner.guard != guard.state || owner.node != fixture.node {
		t.Fatal("fatal WaitContext did not quarantine the composite owner")
	}
	if len(fixture.fs.events) != 0 {
		t.Fatal("fatal WaitContext released guarded installation handles")
	}
}

func TestGuardedNodeFatalCleanupQuarantinesCompositeOwner(t *testing.T) {
	fixture := newGuardFixture(t, config.RoleExecutor)
	fatalNode := errors.Join(winprocess.ErrLaunchCleanupFatal, errors.New("raw Node owner unresolved"))
	fixture.node.closeErrors = []error{fatalNode}
	guard, err := openWithDependencies(context.Background(), fixture.authority, fixture.deps)
	if err != nil {
		t.Fatal(err)
	}
	process, err := guard.LaunchNode(context.Background(), validPipeName())
	if err != nil {
		t.Fatal(err)
	}
	if err := process.Close(); !errors.Is(err, ErrCleanupFatal) || !errors.Is(err, fatalNode) {
		t.Fatalf("guarded Close = %v", err)
	}
	fixture.deps.quarantine.mu.RLock()
	owners := append([]any(nil), fixture.deps.quarantine.owners...)
	fixture.deps.quarantine.mu.RUnlock()
	if len(owners) != 1 {
		t.Fatalf("quarantine owners = %d, want 1", len(owners))
	}
	owner, ok := owners[0].(*rejectedLaunchOwner)
	if !ok || owner.guard != guard.state || owner.node != fixture.node || len(owner.guard.files) != 3 {
		t.Fatal("fatal guarded cleanup did not retain Node and installation handles together")
	}
	if len(fixture.fs.events) != 0 {
		t.Fatal("fatal Node cleanup released guarded installation handles")
	}
}

func TestCloseFailureQuarantinesAndPermanentlyRejectsOpen(t *testing.T) {
	fixture := newGuardFixture(t, config.RoleControl)
	persistent := errors.New("close failed")
	fixture.fs.file(testControlBundle).closeErr = persistent
	guard, err := openWithDependencies(context.Background(), fixture.authority, fixture.deps)
	if err != nil {
		t.Fatal(err)
	}
	if err := guard.Close(); !errors.Is(err, ErrCleanupFatal) || !errors.Is(err, persistent) {
		t.Fatalf("guard Close = %v", err)
	}
	openCalls := fixture.fs.openCalls
	second, err := openWithDependencies(context.Background(), fixture.authority, fixture.deps)
	if second != nil || !errors.Is(err, ErrCleanupFatal) || fixture.fs.openCalls != openCalls {
		t.Fatalf("post-fatal open = (%v, %v), calls=%d", second, err, fixture.fs.openCalls)
	}
}

func TestRawLaunchFailureConsumesAndClosesGuard(t *testing.T) {
	fixture := newGuardFixture(t, config.RoleControl)
	launchErr := errors.New("launch failed")
	fixture.deps.launchNode = func(winprocess.NodeLaunchSpec) (winprocess.NodeProcess, error) { return nil, launchErr }
	guard, err := openWithDependencies(context.Background(), fixture.authority, fixture.deps)
	if err != nil {
		t.Fatal(err)
	}
	if process, err := guard.LaunchNode(context.Background(), validPipeName()); process != nil || !errors.Is(err, launchErr) {
		t.Fatalf("LaunchNode = (%v, %v)", process, err)
	}
	assertFilesClosedBeforeDirectories(t, fixture.fs.events)
	if _, err := guard.LaunchNode(context.Background(), validPipeName()); !errors.Is(err, ErrConsumed) {
		t.Fatalf("repeated failed launch = %v", err)
	}
}

func TestNilNodeWithFatalRawLaunchCleanupRetainsGuard(t *testing.T) {
	fixture := newGuardFixture(t, config.RoleExecutor)
	rawFatal := errors.Join(winprocess.ErrLaunchCleanupFatal, errors.New("raw launcher ownership unresolved"))
	fixture.deps.launchNode = func(winprocess.NodeLaunchSpec) (winprocess.NodeProcess, error) {
		return nil, rawFatal
	}
	guard, err := openWithDependencies(context.Background(), fixture.authority, fixture.deps)
	if err != nil {
		t.Fatal(err)
	}
	process, err := guard.LaunchNode(context.Background(), validPipeName())
	if process != nil || !errors.Is(err, ErrCleanupFatal) || !errors.Is(err, rawFatal) {
		t.Fatalf("fatal nil-node launch = (%v, %v)", process, err)
	}
	fixture.deps.quarantine.mu.RLock()
	owners := append([]any(nil), fixture.deps.quarantine.owners...)
	fixture.deps.quarantine.mu.RUnlock()
	if len(owners) != 1 {
		t.Fatalf("quarantine owners = %d, want 1", len(owners))
	}
	owner, ok := owners[0].(*rejectedLaunchOwner)
	if !ok || owner.guard != guard.state || owner.node != nil || len(owner.guard.files) != 3 {
		t.Fatal("fatal nil-node launch did not retain guarded installation owners")
	}
	if len(fixture.fs.events) != 0 {
		t.Fatal("fatal nil-node launch released installation locks")
	}
}

func TestCancellationAfterRawLaunchRejectsNodeBeforeCommit(t *testing.T) {
	fixture := newGuardFixture(t, config.RoleControl)
	ctx, cancel := context.WithCancelCause(context.Background())
	cause := errors.New("launch cancelled after CreateProcess")
	fixture.deps.launchNode = func(winprocess.NodeLaunchSpec) (winprocess.NodeProcess, error) {
		cancel(cause)
		return fixture.node, nil
	}
	guard, err := openWithDependencies(context.Background(), fixture.authority, fixture.deps)
	if err != nil {
		t.Fatal(err)
	}
	process, err := guard.LaunchNode(ctx, validPipeName())
	if process != nil || !errors.Is(err, cause) || fixture.node.terminateCalls != 1 ||
		fixture.node.closeCalls != 1 {
		t.Fatalf("cancelled post-launch = (%v, %v), terminate=%d close=%d", process, err, fixture.node.terminateCalls, fixture.node.closeCalls)
	}
	assertFilesClosedBeforeDirectories(t, fixture.fs.events)
}

func TestProcessWideLaunchAttemptIsOneShot(t *testing.T) {
	first := newGuardFixture(t, config.RoleControl)
	second := newGuardFixture(t, config.RoleControl)
	second.deps.quarantine = first.deps.quarantine
	firstLaunchErr := errors.New("first launch failed")
	first.deps.launchNode = func(winprocess.NodeLaunchSpec) (winprocess.NodeProcess, error) {
		return nil, firstLaunchErr
	}
	firstGuard, err := openWithDependencies(context.Background(), first.authority, first.deps)
	if err != nil {
		t.Fatal(err)
	}
	secondGuard, err := openWithDependencies(context.Background(), second.authority, second.deps)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := firstGuard.LaunchNode(context.Background(), validPipeName()); !errors.Is(err, firstLaunchErr) {
		t.Fatalf("first launch = %v", err)
	}
	secondCalls := len(second.launched)
	if _, err := secondGuard.LaunchNode(context.Background(), validPipeName()); !errors.Is(err, ErrConsumed) ||
		len(second.launched) != secondCalls {
		t.Fatalf("second process launch = %v, calls=%d", err, len(second.launched))
	}
	if err := secondGuard.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentCleanupFatalInvalidatesInFlightLaunchCommit(t *testing.T) {
	first := newGuardFixture(t, config.RoleControl)
	second := newGuardFixture(t, config.RoleControl)
	second.deps.quarantine = first.deps.quarantine
	firstGuard, err := openWithDependencies(context.Background(), first.authority, first.deps)
	if err != nil {
		t.Fatal(err)
	}
	secondGuard, err := openWithDependencies(context.Background(), second.authority, second.deps)
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	first.deps.launchNode = func(winprocess.NodeLaunchSpec) (winprocess.NodeProcess, error) {
		close(entered)
		<-release
		return first.node, nil
	}
	firstGuard.state.deps.launchNode = first.deps.launchNode
	result := make(chan error, 1)
	go func() {
		_, launchErr := firstGuard.LaunchNode(context.Background(), validPipeName())
		result <- launchErr
	}()
	<-entered
	closeFailure := errors.New("concurrent guard close failed")
	second.fs.file(testControlBundle).closeErr = closeFailure
	if err := secondGuard.Close(); !errors.Is(err, ErrCleanupFatal) {
		t.Fatalf("concurrent Close = %v", err)
	}
	close(release)
	if err := <-result; !errors.Is(err, ErrCleanupFatal) || !errors.Is(err, closeFailure) {
		t.Fatalf("in-flight launch commit = %v", err)
	}
	if first.node.terminateCalls != 1 || first.node.closeCalls != 1 {
		t.Fatal("invalidated in-flight Node was not terminated and closed")
	}
}

func TestPlatformCleanupFatalAtFinalCommitRejectsStartedNode(t *testing.T) {
	fixture := newGuardFixture(t, config.RoleControl)
	platformFatal := errors.New("winfile cleanup became fatal")
	fixture.deps.commitPlatformHealthy = func(func()) error { return platformFatal }
	guard, err := openWithDependencies(context.Background(), fixture.authority, fixture.deps)
	if err != nil {
		t.Fatal(err)
	}
	process, err := guard.LaunchNode(context.Background(), validPipeName())
	if process != nil || !errors.Is(err, ErrCleanupFatal) || !errors.Is(err, platformFatal) {
		t.Fatalf("final platform-fatal commit = (%v, %v)", process, err)
	}
	if fixture.node.terminateCalls != 1 || fixture.node.closeCalls != 1 {
		t.Fatal("platform-fatal commit did not reject the already-started Node")
	}
	assertFilesClosedBeforeDirectories(t, fixture.fs.events)
}

func TestRejectedNonnilNodeAndGuardAreQuarantinedTogether(t *testing.T) {
	fixture := newGuardFixture(t, config.RoleExecutor)
	launchErr := errors.New("launcher returned an error with ownership")
	cleanupErr := errors.New("Node cleanup remained unresolved")
	fixture.node.terminateErrors = []error{cleanupErr}
	fixture.node.closeErrors = []error{cleanupErr}
	fixture.deps.launchNode = func(winprocess.NodeLaunchSpec) (winprocess.NodeProcess, error) {
		return fixture.node, launchErr
	}
	guard, err := openWithDependencies(context.Background(), fixture.authority, fixture.deps)
	if err != nil {
		t.Fatal(err)
	}
	process, err := guard.LaunchNode(context.Background(), validPipeName())
	if process != nil || !errors.Is(err, ErrCleanupFatal) || !errors.Is(err, launchErr) ||
		!errors.Is(err, cleanupErr) {
		t.Fatalf("LaunchNode = (%v, %v)", process, err)
	}
	fixture.deps.quarantine.mu.RLock()
	owners := append([]any(nil), fixture.deps.quarantine.owners...)
	fixture.deps.quarantine.mu.RUnlock()
	if len(owners) != 1 {
		t.Fatalf("quarantine owners = %d, want 1", len(owners))
	}
	owner, ok := owners[0].(*rejectedLaunchOwner)
	if !ok || owner.guard != guard.state || owner.node != fixture.node ||
		len(owner.guard.files) != 3 || len(owner.guard.directories) == 0 {
		t.Fatal("quarantine did not retain the composite Node and guard owner")
	}
	if len(fixture.fs.events) != 0 {
		t.Fatal("unresolved Node cleanup released guarded installation handles")
	}
}

func TestRejectedNodeTerminateErrorWithSuccessfulCloseReleasesGuard(t *testing.T) {
	fixture := newGuardFixture(t, config.RoleControl)
	launchErr := errors.New("launch returned an error")
	terminateErr := errors.New("terminate reported a transient diagnostic")
	fixture.node.terminateErrors = []error{terminateErr}
	fixture.deps.launchNode = func(winprocess.NodeLaunchSpec) (winprocess.NodeProcess, error) {
		return fixture.node, launchErr
	}
	guard, err := openWithDependencies(context.Background(), fixture.authority, fixture.deps)
	if err != nil {
		t.Fatal(err)
	}
	process, err := guard.LaunchNode(context.Background(), validPipeName())
	if process != nil || !errors.Is(err, launchErr) || !errors.Is(err, terminateErr) ||
		errors.Is(err, ErrCleanupFatal) {
		t.Fatalf("LaunchNode = (%v, %v)", process, err)
	}
	if fatal := fixture.deps.quarantine.fatalError(); fatal != nil {
		t.Fatalf("successful Node Close poisoned quarantine: %v", fatal)
	}
	assertFilesClosedBeforeDirectories(t, fixture.fs.events)
}

func TestPostLaunchVerificationFailureRetainsCompositeWhenNodeCloseFails(t *testing.T) {
	fixture := newGuardFixture(t, config.RoleControl)
	closeErr := errors.Join(winprocess.ErrLaunchCleanupFatal, errors.New("post-launch Node close failed"))
	fixture.node.closeErrors = []error{closeErr}
	fixture.deps.launchNode = func(winprocess.NodeLaunchSpec) (winprocess.NodeProcess, error) {
		fixture.fs.file(testNode).data[0] ^= 1
		return fixture.node, nil
	}
	guard, err := openWithDependencies(context.Background(), fixture.authority, fixture.deps)
	if err != nil {
		t.Fatal(err)
	}
	process, err := guard.LaunchNode(context.Background(), validPipeName())
	if process != nil || !errors.Is(err, ErrCleanupFatal) || !errors.Is(err, ErrChanged) ||
		!errors.Is(err, closeErr) {
		t.Fatalf("post-launch failure = (%v, %v)", process, err)
	}
	fixture.deps.quarantine.mu.RLock()
	owners := append([]any(nil), fixture.deps.quarantine.owners...)
	fixture.deps.quarantine.mu.RUnlock()
	if len(owners) != 1 {
		t.Fatalf("quarantine owners = %d, want 1", len(owners))
	}
	owner, ok := owners[0].(*rejectedLaunchOwner)
	if !ok || owner.guard != guard.state || owner.node != fixture.node {
		t.Fatal("post-launch rejection did not quarantine the composite owner")
	}
	if len(fixture.fs.events) != 0 {
		t.Fatal("post-launch unresolved cleanup released installation handles")
	}
}

func validPipeName() string {
	return `\\.\pipe\AgenticReview.ServiceHost.HostControl.v1.` + strings.Repeat("a", 64)
}

func assertFilesClosedBeforeDirectories(t *testing.T, events []string) {
	t.Helper()
	firstDirectory := len(events)
	hasFile := false
	for index, event := range events {
		if strings.HasPrefix(event, "close-file:") {
			hasFile = true
		}
		if strings.HasPrefix(event, "close-dir:") {
			firstDirectory = index
			break
		}
	}
	if hasFile && firstDirectory == 0 {
		t.Fatalf("directory closed before files: %v", events)
	}
	for index := firstDirectory; index < len(events); index++ {
		if strings.HasPrefix(events[index], "close-file:") {
			t.Fatalf("file closed after directory: %v", events)
		}
	}
}
