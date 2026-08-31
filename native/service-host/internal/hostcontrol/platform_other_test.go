//go:build !windows

package hostcontrol

import (
	"context"
	"errors"
	"testing"
)

func TestPrepareFailsClosedOutsideWindows(t *testing.T) {
	if _, err := Prepare(Options{}); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("Prepare error = %v, want ErrUnsupportedPlatform", err)
	}
}

func TestAcceptFailsWithoutConnectionOwnerOutsideWindows(t *testing.T) {
	listener := &Listener{}
	connection, err := listener.Accept(context.Background(), nil)
	if connection != nil || !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("Accept connection=%p error=%v, want nil/ErrUnsupportedPlatform", connection, err)
	}
}
