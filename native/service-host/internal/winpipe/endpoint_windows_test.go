//go:build windows

package winpipe

import (
	"context"
	"errors"
	"testing"

	"golang.org/x/sys/windows"
)

type relayEndpointContract interface {
	ReadFrame(context.Context) ([]byte, error)
	WriteFrame(context.Context, []byte) error
	Close() error
}

func TestWindowsEndpointLocalSideComesFromLivePrivateState(t *testing.T) {
	tests := []struct {
		name     string
		endpoint *Endpoint
		want     EndpointSide
		wantErr  error
	}{
		{name: "server", endpoint: &Endpoint{state: &endpointState{handle: 1, server: true}}, want: EndpointSideServer},
		{name: "client", endpoint: &Endpoint{state: &endpointState{handle: 1}}, want: EndpointSideClient},
		{name: "zero value", endpoint: &Endpoint{}, wantErr: ErrClosed},
		{name: "closed", endpoint: &Endpoint{state: &endpointState{handle: 1, closed: true}}, wantErr: ErrClosed},
		{name: "nil", endpoint: nil, wantErr: ErrClosed},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := test.endpoint.LocalSide()
			if got != test.want || !errors.Is(err, test.wantErr) {
				t.Fatalf("LocalSide returned (%d, %v), want (%d, %v)", got, err, test.want, test.wantErr)
			}
		})
	}
}

func TestWindowsEndpointCopiesShareOneRawHandleOwner(t *testing.T) {
	closeCalls := 0
	var closedHandle windows.Handle
	endpoint := &Endpoint{state: &endpointState{
		handle: 123,
		cancelIO: func(windows.Handle, *windows.Overlapped) error {
			return nil
		},
		closeHandle: func(handle windows.Handle) error {
			closeCalls++
			closedHandle = handle
			return nil
		},
	}}
	copied := *endpoint
	if side, err := copied.LocalSide(); side != EndpointSideClient || err != nil {
		t.Fatalf("copied LocalSide returned (%d, %v)", side, err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	go func() {
		<-start
		results <- endpoint.Close()
	}()
	go func() {
		<-start
		results <- copied.Close()
	}()
	close(start)
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if closeCalls != 1 || closedHandle != 123 || endpoint.state.handle != 0 {
		t.Fatalf(
			"raw handle close calls = %d, closed handle = %d, retained handle = %d",
			closeCalls,
			closedHandle,
			endpoint.state.handle,
		)
	}
	if _, err := endpoint.LocalSide(); !errors.Is(err, ErrClosed) {
		t.Fatalf("original LocalSide after copied Close = %v", err)
	}
	if _, err := copied.GetNamedPipeClientProcessID(); !errors.Is(err, ErrClosed) {
		t.Fatalf("copied PID observation after Close = %v", err)
	}
}

func TestWindowsEndpointContractsCompile(t *testing.T) {
	var endpoint *Endpoint
	var relayContract relayEndpointContract = endpoint
	var processIDContract ProcessIDObserver = endpoint
	if relayContract == nil || processIDContract == nil {
		t.Fatal("typed nil endpoint did not populate interface contracts")
	}
}
