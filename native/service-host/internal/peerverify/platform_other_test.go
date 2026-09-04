//go:build !windows

package peerverify

import (
	"errors"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
)

func TestVerifyWindowsFailsClosedOutsideWindows(t *testing.T) {
	if session, err := VerifyWindows(config.RoleControl, nil); session != nil || !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("VerifyWindows returned (%v, %v)", session, err)
	}
}

func TestVerifyWindowsHonorsNativeOwnershipFatalGuard(t *testing.T) {
	original := rejectedNativeOwners
	rejectedNativeOwners = &nativeOwnershipLifetimeQuarantine{fatal: ErrNativeHandleOwnershipFatal}
	t.Cleanup(func() { rejectedNativeOwners = original })

	if session, err := VerifyWindows(config.RoleControl, nil); session != nil || !errors.Is(err, ErrNativeHandleOwnershipFatal) {
		t.Fatalf("VerifyWindows returned (%v, %v)", session, err)
	}
}
