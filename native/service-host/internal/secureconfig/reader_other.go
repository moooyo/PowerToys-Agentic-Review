//go:build !windows

package secureconfig

// Read fails closed outside Windows before opening or inspecting any path.
func Read(string, Options) (Result, error) {
	return Result{}, ErrUnsupportedPlatform
}
