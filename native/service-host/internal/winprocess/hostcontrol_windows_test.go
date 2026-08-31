//go:build windows

package winprocess

import (
	"strings"
	"testing"
)

func TestHostControlActivationIsSingleUse(t *testing.T) {
	process := &windowsNodeProcess{hostControlActivated: true}
	err := process.ActivateAfterHostControl()
	if err == nil || !strings.Contains(err.Error(), "already activated") {
		t.Fatalf("second HostControl activation error = %v, want already activated", err)
	}
}
