//go:build !windows

package stagedpackage

import (
	"context"
	"errors"
	"testing"
)

func TestVerifyFailsClosedOutsideWindows(t *testing.T) {
	if evidence, err := Verify(context.Background(), `C:\Stage`); !errors.Is(err, ErrUnsupportedPlatform) ||
		evidence.state != nil {
		t.Fatalf("Verify returned evidence=%#v err=%v", evidence, err)
	}
}
