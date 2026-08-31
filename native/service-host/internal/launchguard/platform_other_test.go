//go:build !windows

package launchguard

import (
	"context"
	"errors"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/preflight"
)

func TestNonWindowsLaunchGuardFailsClosed(t *testing.T) {
	fixture := newGuardFixture(t, config.RoleControl)
	guard, err := openPlatform(context.Background(), fixture.authority)
	if guard != nil || !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("openPlatform = (%v, %v)", guard, err)
	}
}

func TestPublicOpenFailsUnsupportedBeforeWindowsEvidenceCapture(t *testing.T) {
	guard, err := Open(context.Background(), preflight.Evidence{}, preflight.RuntimePlan{})
	if guard != nil || !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("Open = (%v, %v)", guard, err)
	}
}
