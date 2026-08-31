//go:build !windows

package peerverify

import (
	"errors"
	"testing"
)

func TestVerifyWindowsFailsClosedOutsideWindows(t *testing.T) {
	session, err := VerifyWindows(Options{})
	if session != nil || !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("VerifyWindows returned (%v, %v), want nil and ErrUnsupportedPlatform", session, err)
	}
}

func TestNewWindowsAuthenticodeVerifierFailsClosedOutsideWindows(t *testing.T) {
	verifier, err := NewWindowsAuthenticodeVerifier()
	if verifier != nil || !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("NewWindowsAuthenticodeVerifier returned (%v, %v)", verifier, err)
	}
}
