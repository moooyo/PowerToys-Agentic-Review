//go:build !windows

package winprocess

import (
	"errors"
	"testing"
)

func TestUnsupportedPlatformStubsFailClosed(t *testing.T) {
	if _, err := LaunchNode(validLaunchSpec()); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("LaunchNode error = %v, want ErrUnsupportedPlatform", err)
	}
	if _, err := OpenWrapperWatcher("AgenticReview.Worker.Control"); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("OpenWrapperWatcher error = %v, want ErrUnsupportedPlatform", err)
	}
}
