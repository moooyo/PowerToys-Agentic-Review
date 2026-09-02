//go:build agenticreview_outertrust

package outertrust

import "testing"

func TestProductionLoadsGeneratedOuterTrust(t *testing.T) {
	evidence, err := Production()
	if err != nil {
		t.Fatal(err)
	}
	if err := evidence.Validate(); err != nil || evidence.SignerKeyID() != compiledOuterSignerSPKISHA256 {
		t.Fatalf("unexpected generated trust evidence: keyID=%q err=%v", evidence.SignerKeyID(), err)
	}
}
