package platform

import (
	"context"
	"errors"
)

var (
	ErrUnsupportedPlatform   = errors.New("ServiceHost requires Windows")
	ErrWindowsAdapterMissing = errors.New("ServiceHost Windows security adapter is not implemented")
)

// BootstrapOptions contains only the path selector allowed before native,
// handle-bound installation verification. Parsed configuration must come from
// installverify evidence inside the Windows Host implementation.
type BootstrapOptions struct {
	ActualBootstrapPath string
	// Ready is called at most once after the local preflight has completed and
	// before the host starts waiting for its peer service.
	Ready func()
}

type Host interface {
	Run(context.Context, BootstrapOptions) error
}

type unavailableHost struct {
	err error
}

func (h unavailableHost) Run(context.Context, BootstrapOptions) error {
	return h.err
}
