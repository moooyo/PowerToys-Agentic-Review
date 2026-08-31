//go:build agenticreview_release

package releaseprofile

import (
	"crypto/sha256"
	"testing"
)

func TestProductionLoadsGeneratedReleaseTemplate(t *testing.T) {
	evidence, err := Production()
	if err != nil {
		t.Fatal(err)
	}
	if err := evidence.Validate(); err != nil {
		t.Fatal(err)
	}
	digest, err := evidence.Digest()
	if err != nil {
		t.Fatal(err)
	}
	if digest != sha256.Sum256([]byte(compiledReleaseTemplateDocument)) ||
		evidence.ProfileID() != ProductionProfileID ||
		evidence.ServiceHost().Path != ServiceHostRelativePath {
		t.Fatalf("unexpected generated production evidence: %#v", evidence)
	}
}
