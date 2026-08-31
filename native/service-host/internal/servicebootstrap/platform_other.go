//go:build !windows

package servicebootstrap

// Open fails closed outside Windows.
func Open(options Options) (Session, error) {
	if err := validateOptions(options); err != nil {
		return nil, err
	}
	return nil, ErrUnsupportedPlatform
}
