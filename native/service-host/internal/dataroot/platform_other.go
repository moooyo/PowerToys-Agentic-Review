//go:build !windows

package dataroot

import (
	"context"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installverify"
)

// VerifyRuntime fails closed outside Windows because handle-relative NTFS and
// Windows security-descriptor evidence cannot be collected.
func VerifyRuntime(
	context.Context,
	installverify.Evidence,
) (Evidence, error) {
	return Evidence{}, ErrUnsupportedPlatform
}
