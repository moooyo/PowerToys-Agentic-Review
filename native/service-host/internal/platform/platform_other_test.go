//go:build !windows

package platform

import (
	"context"
	"errors"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
)

func TestNonWindowsHostFailsClosed(t *testing.T) {
	err := NewHost().Run(context.Background(), config.Config{})
	if !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("non-Windows host returned the wrong error: %v", err)
	}
}
