package platform

import (
	"context"
	"errors"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
)

var (
	ErrUnsupportedPlatform   = errors.New("ServiceHost requires Windows")
	ErrWindowsAdapterMissing = errors.New("ServiceHost Windows security adapter is not implemented")
)

type Host interface {
	Run(context.Context, config.Config) error
}

type unavailableHost struct {
	err error
}

func (h unavailableHost) Run(context.Context, config.Config) error {
	return h.err
}
