//go:build !windows

package releasepackage

import (
	"errors"
	"testing"
)

func TestProductionEvidenceMintingFailsClosedOutsideWindows(t *testing.T) {
	if _, err := LoadReviewedClosure("approval", "closure"); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("LoadReviewedClosure returned %v", err)
	}
	if _, err := LoadServiceHostBuildReceipt("approval", "receipt"); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("LoadServiceHostBuildReceipt returned %v", err)
	}
	if _, err := VerifyServiceHost(PreparedRelease{}, ServiceHostBuildEvidence{}, "service-host"); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("VerifyServiceHost returned %v", err)
	}
}
