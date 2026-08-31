//go:build !windows

package installverify

import "context"

// Verify fails closed before inspecting paths outside Windows.
func Verify(context.Context, Options) (Evidence, error) {
	return Evidence{}, ErrUnsupportedPlatform
}
