//go:build !windows

package installerdestination

import (
	"context"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/stagedpackage"
)

// Verify fails closed outside Windows before opening any path.
func Verify(context.Context, stagedpackage.InstallerPackage) (Evidence, error) {
	return Evidence{}, ErrUnsupportedPlatform
}
