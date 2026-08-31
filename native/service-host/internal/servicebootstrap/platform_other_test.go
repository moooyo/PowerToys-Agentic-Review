//go:build !windows

package servicebootstrap

import (
	"errors"
	"testing"
)

func TestOpenFailsClosedOutsideWindows(t *testing.T) {
	if _, err := Open(validOptions()); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("Open error = %v, want ErrUnsupportedPlatform", err)
	}
}
