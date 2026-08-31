//go:build !windows

package winidentity

import (
	"errors"
	"reflect"
	"testing"
)

func TestNonWindowsPreflightFailsClosed(t *testing.T) {
	evidence, err := Preflight(validOptions())
	if !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("Preflight returned %v, want ErrUnsupportedPlatform", err)
	}
	if !reflect.DeepEqual(evidence, Evidence{}) {
		t.Fatalf("Preflight returned unsupported evidence: %#v", evidence)
	}
}
