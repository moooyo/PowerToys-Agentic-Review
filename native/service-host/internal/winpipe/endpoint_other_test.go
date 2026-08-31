//go:build !windows

package winpipe

import (
	"context"
	"errors"
	"testing"
)

func TestNonWindowsTransportFailsClosed(t *testing.T) {
	if endpoint, err := Accept(context.Background(), ServerOptions{}); endpoint != nil ||
		!errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("Accept returned endpoint %#v and error %v", endpoint, err)
	}
	if endpoint, err := Dial(context.Background(), ClientOptions{}); endpoint != nil ||
		!errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("Dial returned endpoint %#v and error %v", endpoint, err)
	}

	endpoint := &Endpoint{}
	if _, err := endpoint.ReadFrame(context.Background()); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("ReadFrame returned %v", err)
	}
	if err := endpoint.WriteFrame(context.Background(), nil); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("WriteFrame returned %v", err)
	}
	if err := endpoint.Close(); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("Close returned %v", err)
	}
	if side, err := endpoint.LocalSide(); side != EndpointSideUnknown || !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("LocalSide returned (%d, %v)", side, err)
	}
	if _, err := endpoint.GetNamedPipeClientProcessID(); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("GetNamedPipeClientProcessID returned %v", err)
	}
	if _, err := endpoint.GetNamedPipeServerProcessID(); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("GetNamedPipeServerProcessID returned %v", err)
	}
}
