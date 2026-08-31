//go:build !windows

package servicebootstrap

// Open fails closed outside Windows.
func Open(Options) (Session, error) {
	return nil, ErrUnsupportedPlatform
}
