//go:build !windows

package peerverify

import (
	"errors"
	"testing"
)

func TestVerifyFailsClosedAndClosesWrapperOutsideWindows(t *testing.T) {
	fixture := newVerificationFixture(PipePeerClient)
	session, err := Verify(fixture.observer, fixture.wrapper, fixture.options)
	if session != nil || !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("Verify returned (%v, %v), want nil and ErrUnsupportedPlatform", session, err)
	}
	if fixture.wrapper.closeCount != 1 {
		t.Fatalf("wrapper close count = %d, want 1", fixture.wrapper.closeCount)
	}
	if len(fixture.events) != 1 || fixture.events[0] != "wrapper-close" {
		t.Fatalf("events = %v, want only wrapper-close", fixture.events)
	}
}
