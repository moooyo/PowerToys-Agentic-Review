//go:build windows

package winpipe

import (
	"context"
	"testing"
)

type relayEndpointContract interface {
	ReadFrame(context.Context) ([]byte, error)
	WriteFrame(context.Context, []byte) error
	Close() error
}

func TestWindowsEndpointContractsCompile(t *testing.T) {
	var endpoint *Endpoint
	var relayContract relayEndpointContract = endpoint
	var processIDContract ProcessIDObserver = endpoint
	if relayContract == nil || processIDContract == nil {
		t.Fatal("typed nil endpoint did not populate interface contracts")
	}
}
