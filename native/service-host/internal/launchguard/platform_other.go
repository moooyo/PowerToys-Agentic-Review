//go:build !windows

package launchguard

import (
	"context"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/preflight"
)

// Open fails closed before interpreting Windows-only authority evidence.
func Open(context.Context, preflight.Evidence, preflight.RuntimePlan) (*Guard, error) {
	return nil, ErrUnsupportedPlatform
}

func openPlatform(context.Context, authoritySnapshot) (*Guard, error) {
	return nil, ErrUnsupportedPlatform
}
