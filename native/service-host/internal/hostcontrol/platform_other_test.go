//go:build !windows

package hostcontrol

import (
	"errors"
	"testing"
)

func TestPrepareFailsClosedOutsideWindows(t *testing.T) {
	if _, err := Prepare(Options{}); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("Prepare error = %v, want ErrUnsupportedPlatform", err)
	}
}
