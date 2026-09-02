//go:build !agenticreview_outertrust

package outeradmission

import (
	"errors"
	"testing"
)

func TestProductionAdmissionFailsClosedWithoutCompiledOuterTrust(t *testing.T) {
	fixture := newAdmissionFixture(t)
	plan, err := Admit(
		fixture.indexDocument,
		fixture.envelopeDocument,
		fixture.controlDocument,
		fixture.executorDocument,
	)
	if !errors.Is(err, ErrUnavailable) || plan.state != nil {
		t.Fatalf("Admit returned plan=%#v err=%v, want ErrUnavailable", plan, err)
	}
}
