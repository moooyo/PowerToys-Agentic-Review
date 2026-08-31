//go:build !windows

package authenticode

import (
	"errors"
	"testing"
)

func TestNewWindowsVerifierFailsClosedOutsideWindows(t *testing.T) {
	verifier, err := NewWindowsVerifier()
	if verifier != nil || !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("NewWindowsVerifier returned (%v, %v)", verifier, err)
	}
}
