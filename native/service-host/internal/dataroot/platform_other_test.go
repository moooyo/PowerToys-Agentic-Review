//go:build !windows

package dataroot

import (
	"context"
	"errors"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installverify"
)

func TestVerifyRuntimeFailsClosedOutsideWindows(t *testing.T) {
	if _, err := VerifyRuntime(context.Background(), installverify.Evidence{}); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("VerifyRuntime error = %v, want ErrUnsupportedPlatform", err)
	}
}
