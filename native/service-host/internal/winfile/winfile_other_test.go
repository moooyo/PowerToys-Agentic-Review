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
	file := &File{}
	if _, err := file.ReadAt(make([]byte, 1), 0); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("ReadAt returned the wrong error: %v", err)
	}
	if _, err := file.HashSHA256(HashOptions{MaximumBytes: 1}); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("HashSHA256 returned the wrong error: %v", err)
	}
	if _, err := file.ReinspectDataStreams(); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("file ReinspectDataStreams returned the wrong error: %v", err)
	}
	if _, err := file.VerifyAuthenticode(nil); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("VerifyAuthenticode returned the wrong error: %v", err)
	}
	directory := &Directory{}
	if _, err := directory.Enumerate(DirectoryEnumerationOptions{
		MaximumEntries: 1, MaximumNameUTF16Units: 1, MaximumTotalNameUTF16Units: 1,
	}); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("Enumerate returned the wrong error: %v", err)
	}
	if _, err := directory.ReinspectDataStreams(); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("directory ReinspectDataStreams returned the wrong error: %v", err)
	}
	if _, err := directory.ReinspectCaseSensitivity(); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("ReinspectCaseSensitivity returned the wrong error: %v", err)
	}
}
