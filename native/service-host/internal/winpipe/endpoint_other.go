//go:build !windows

package winpipe

import "context"

// Endpoint is an unavailable placeholder on non-Windows platforms.
type Endpoint struct{}

func Accept(context.Context, ServerOptions) (*Endpoint, error) {
	return nil, ErrUnsupportedPlatform
}

func Dial(context.Context, ClientOptions) (*Endpoint, error) {
	return nil, ErrUnsupportedPlatform
}

func (*Endpoint) ReadFrame(context.Context) ([]byte, error) {
	return nil, ErrUnsupportedPlatform
}

func (*Endpoint) WriteFrame(context.Context, []byte) error {
	return ErrUnsupportedPlatform
}

func (*Endpoint) Close() error {
	return ErrUnsupportedPlatform
}

func (*Endpoint) GetNamedPipeClientProcessID() (uint32, error) {
	return 0, ErrUnsupportedPlatform
}

func (*Endpoint) GetNamedPipeServerProcessID() (uint32, error) {
	return 0, ErrUnsupportedPlatform
}

var _ ProcessIDObserver = (*Endpoint)(nil)
