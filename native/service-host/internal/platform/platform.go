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
	// Ready is called at most once. Executor reports after local setup so SCM
	// can start its dependent Control service. Control reports only after the
	// peer, Node, HostControl, role runtime, and supervision are constructed.
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
