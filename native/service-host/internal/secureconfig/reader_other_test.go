//go:build !windows

package secureconfig

import (
	"errors"
	"testing"
)

func TestReadFailsClosedOutsideWindows(t *testing.T) {
	result, err := Read(
		`C:\trusted\config.json`,
		Options{MaximumBytes: 64, ManagedAnchorPath: `C:\trusted`, Policy: &fixturePolicy{}},
	)
	if !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("Read returned %v", err)
	}
	if len(result.Data) != 0 || len(result.Ancestors) != 0 {
		t.Fatalf("Read returned evidence outside Windows: %#v", result)
	}
}
