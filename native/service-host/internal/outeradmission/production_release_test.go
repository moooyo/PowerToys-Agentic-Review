//go:build agenticreview_outertrust

package outeradmission

import (
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outertrust"
)

func TestProductionAdmissionUsesGeneratedOuterTrust(t *testing.T) {
	fixture := newAdmissionFixtureWithKey(t, deterministicAdmissionPrivateKey())
	authority, err := outertrust.Production()
	if err != nil {
		t.Fatal(err)
	}
	if authority.SignerKeyID() != fixture.authority.SignerKeyID() {
		t.Skip("compiled release signer is not the deterministic overlay test signer")
	}
	plan, err := Admit(
		fixture.indexDocument,
		fixture.envelopeDocument,
		fixture.controlDocument,
		fixture.executorDocument,
	)
	if err != nil || plan.Validate() != nil || plan.SignerKeyID() != fixture.authority.SignerKeyID() {
		t.Fatalf("production admission returned plan=%#v err=%v", plan, err)
	}
}
