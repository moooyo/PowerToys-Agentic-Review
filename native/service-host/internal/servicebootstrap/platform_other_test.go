//go:build !windows

package servicebootstrap

import (
	"errors"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
)

func TestPrepareFailsClosedOutsideWindows(t *testing.T) {
	if err := Prepare(config.RoleControl); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("Prepare error = %v, want ErrUnsupportedPlatform", err)
	}
	if err := Prepare(config.Role("other")); !errors.Is(err, ErrInvalidRole) {
		t.Fatalf("invalid Prepare error = %v, want ErrInvalidRole", err)
	}
}
