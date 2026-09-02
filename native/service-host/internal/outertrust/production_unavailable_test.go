//go:build !agenticreview_outertrust

package outertrust

import (
	"errors"
	"testing"
)

func TestProductionFailsClosedWithoutCompiledOuterTrust(t *testing.T) {
	evidence, err := Production()
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Production returned %v, want ErrUnavailable", err)
	}
	if !errors.Is(evidence.Validate(), ErrInvalidEvidence) || evidence.SignerKeyID() != "" {
		t.Fatalf("Production returned usable evidence: %#v", evidence)
	}
}
