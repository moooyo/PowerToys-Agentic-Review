//go:build !windows

package winfile

import (
	"errors"
	"testing"
)

func TestNonWindowsOperationsFailClosed(t *testing.T) {
	if _, err := OpenFile(`C:\safe\config.json`, OpenOptions{VolumeUse: VolumeUseReadOnly}); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("OpenFile returned the wrong error: %v", err)
	}
	if _, err := OpenDirectory(`C:\safe`, OpenOptions{VolumeUse: VolumeUseReadOnly}); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("OpenDirectory returned the wrong error: %v", err)
	}
	if _, err := ReadFile(`C:\safe\config.json`, ReadOptions{MaximumBytes: 1024, VolumeUse: VolumeUseReadOnly}); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("ReadFile returned the wrong error: %v", err)
	}
	if _, err := InspectDirectory(`C:\safe`, OpenOptions{VolumeUse: VolumeUseReadOnly}); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("InspectDirectory returned the wrong error: %v", err)
	}
}
