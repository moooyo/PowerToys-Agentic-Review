//go:build !windows

package winfile

// File is unavailable outside Windows.
type File struct{}

// Directory is unavailable outside Windows.
type Directory struct{}

// OpenFile fails closed outside Windows.
func OpenFile(string, OpenOptions) (*File, error) {
	return nil, ErrUnsupportedPlatform
}

// OpenDirectory fails closed outside Windows.
func OpenDirectory(string, OpenOptions) (*Directory, error) {
	return nil, ErrUnsupportedPlatform
}

// ReadFile fails closed outside Windows.
func ReadFile(string, ReadOptions) (ReadResult, error) {
	return ReadResult{}, ErrUnsupportedPlatform
}

// InspectDirectory fails closed outside Windows.
func InspectDirectory(string, OpenOptions) (Evidence, error) {
	return Evidence{}, ErrUnsupportedPlatform
}

// Evidence returns no evidence outside Windows.
func (*File) Evidence() Evidence {
	return Evidence{}
}

// Evidence returns no evidence outside Windows.
func (*Directory) Evidence() Evidence {
	return Evidence{}
}

// ReadAll fails closed outside Windows.
func (*File) ReadAll(uint64) ([]byte, error) {
	return nil, ErrUnsupportedPlatform
}

// VerifyUnchanged fails closed outside Windows.
func (*File) VerifyUnchanged() error {
	return ErrUnsupportedPlatform
}

// VerifyUnchanged fails closed outside Windows.
func (*Directory) VerifyUnchanged() error {
	return ErrUnsupportedPlatform
}

// Close reports that no Windows handle exists.
func (*File) Close() error {
	return ErrUnsupportedPlatform
}

// Close reports that no Windows handle exists.
func (*Directory) Close() error {
	return ErrUnsupportedPlatform
}
