//go:build !windows

package platform

import (
	"context"
	"errors"
	"testing"
)

func TestNonWindowsHostFailsClosed(t *testing.T) {
	err := NewHost().Run(context.Background(), BootstrapOptions{ActualBootstrapPath: `C:\config.json`})
	if !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("non-Windows host returned the wrong error: %v", err)
	}
}
