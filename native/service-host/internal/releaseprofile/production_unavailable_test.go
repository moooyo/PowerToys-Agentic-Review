//go:build !agenticreview_release

package releaseprofile

import (
	"errors"
	"testing"
)

func TestProductionFailsClosedWithoutReleaseBuildTag(t *testing.T) {
	evidence, err := Production()
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Production error = %v, want ErrUnavailable", err)
	}
	if !errors.Is(evidence.Validate(), ErrInvalidEvidence) {
		t.Fatalf("Production returned valid evidence: %#v", evidence)
	}
}
