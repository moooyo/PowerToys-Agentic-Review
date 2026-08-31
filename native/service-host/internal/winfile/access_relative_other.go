//go:build !windows

package winfile

// OpenTraversalRoot fails closed outside Windows.
func OpenTraversalRoot(string, OpenOptions) (*Directory, error) {
	return nil, ErrUnsupportedPlatform
}

// OpenDirectoryComponent fails closed outside Windows.
func (*Directory) OpenDirectoryComponent(string, OpenOptions) (*Directory, error) {
	return nil, ErrUnsupportedPlatform
}

// OpenFileComponent fails closed outside Windows.
func (*Directory) OpenFileComponent(string, OpenOptions) (*File, error) {
	return nil, ErrUnsupportedPlatform
}

// ReinspectSecurity fails closed outside Windows.
func (*File) ReinspectSecurity() (SecurityDescriptorEvidence, error) {
	return SecurityDescriptorEvidence{}, ErrUnsupportedPlatform
}

// ReinspectSecurity fails closed outside Windows.
func (*Directory) ReinspectSecurity() (SecurityDescriptorEvidence, error) {
	return SecurityDescriptorEvidence{}, ErrUnsupportedPlatform
}
