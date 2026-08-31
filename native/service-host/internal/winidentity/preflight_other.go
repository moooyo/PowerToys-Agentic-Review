//go:build !windows

package winidentity

// Preflight fails closed outside Windows because neither SCM service
// configuration nor the current process token can be inspected there.
func Preflight(Options) (Evidence, error) {
	return Evidence{}, ErrUnsupportedPlatform
}
