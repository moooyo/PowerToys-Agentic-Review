package platform

import (
	"context"
	"errors"
)

var (
	ErrUnsupportedPlatform   = errors.New("ServiceHost requires Windows")
	ErrWindowsAdapterMissing = errors.New("ServiceHost Windows security adapter is not implemented")
)

// BootstrapOptions selects one of the two fixed trusted local role
// configuration files used by the Windows Host implementation.
type BootstrapOptions struct {
	ActualBootstrapPath string
	// Ready is called at most once after local identity, process security,
	// configuration, and role credentials have been validated and before the
	// host starts waiting for its peer service.
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
