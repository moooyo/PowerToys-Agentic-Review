//go:build !windows

package installverify

import (
	"context"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"
)

// Verify fails closed before inspecting paths outside Windows.
func Verify(context.Context, Options, releaseprofile.Evidence) (Evidence, error) {
	return Evidence{}, ErrUnsupportedPlatform
}
