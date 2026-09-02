package releasepackage

import (
	"errors"
	"testing"
)

type outerPackageCleanupMode uint8

const (
	outerPackageCleanupHealthy outerPackageCleanupMode = iota
	outerPackageReleaseCleanupFatal
	outerPackagePlatformCleanupFatal
)

type outerPackageUnresolvedResource struct{}

func (*outerPackageUnresolvedResource) Close() error {
	return errors.New("outer package test resource remains unresolved")
}

// FinalizedReleaseForOuterPackageTest returns a real finalized release only to this package's
// external tests. It is absent from production builds.
func FinalizedReleaseForOuterPackageTest(t *testing.T) FinalizedRelease {
	t.Helper()
	return finalizedReleaseForOuterPackageTest(t, outerPackageCleanupHealthy)
}

// FinalizedReleaseWithReleaseCleanupFatalForOuterPackageTest returns a finalized release whose
// release cleanup coordinator has subsequently entered the fatal state.
func FinalizedReleaseWithReleaseCleanupFatalForOuterPackageTest(t *testing.T) FinalizedRelease {
	t.Helper()
	return finalizedReleaseForOuterPackageTest(t, outerPackageReleaseCleanupFatal)
}

// FinalizedReleaseWithPlatformCleanupFatalForOuterPackageTest returns a finalized release whose
// native cleanup gate has subsequently entered the fatal state.
func FinalizedReleaseWithPlatformCleanupFatalForOuterPackageTest(t *testing.T) FinalizedRelease {
	t.Helper()
	return finalizedReleaseForOuterPackageTest(t, outerPackagePlatformCleanupFatal)
}

func finalizedReleaseForOuterPackageTest(
	t *testing.T,
	mode outerPackageCleanupMode,
) FinalizedRelease {
	t.Helper()
	previous := releaseCleanupCoordinator
	platformFatal := false
	releaseCleanupCoordinator = &releaseCleanupState{
		platformStatus: func() error {
			if platformFatal {
				return errors.New("outer package test platform cleanup fatal")
			}
			return nil
		},
		platformCommit: func(commit func()) error {
			if platformFatal || commit == nil {
				return errors.New("outer package test platform cleanup fatal")
			}
			commit()
			return nil
		},
	}
	t.Cleanup(func() { releaseCleanupCoordinator = previous })
	prepared, request := validFinalization(t)
	finalized, err := Finalize(prepared, request)
	if err != nil {
		t.Fatal(err)
	}
	switch mode {
	case outerPackageCleanupHealthy:
	case outerPackageReleaseCleanupFatal:
		releaseCleanupCoordinator.publish(&outerPackageUnresolvedResource{})
	case outerPackagePlatformCleanupFatal:
		platformFatal = true
	default:
		t.Fatal("unsupported outer package cleanup test mode")
	}
	return finalized
}
