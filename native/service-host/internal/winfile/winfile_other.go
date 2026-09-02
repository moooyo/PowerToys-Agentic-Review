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

// ReadAt fails closed outside Windows.
func (*File) ReadAt([]byte, int64) (int, error) {
	return 0, ErrUnsupportedPlatform
}

// HashSHA256 fails closed outside Windows.
func (*File) HashSHA256(HashOptions) (HashResult, error) {
	return HashResult{}, ErrUnsupportedPlatform
}

// Enumerate fails closed outside Windows.
func (*Directory) Enumerate(DirectoryEnumerationOptions) (DirectoryEnumeration, error) {
	return DirectoryEnumeration{}, ErrUnsupportedPlatform
}

// ReinspectDataStreams fails closed outside Windows.
func (*File) ReinspectDataStreams() ([]DataStream, error) {
	return nil, ErrUnsupportedPlatform
}

// ReinspectDataStreams fails closed outside Windows.
func (*Directory) ReinspectDataStreams() ([]DataStream, error) {
	return nil, ErrUnsupportedPlatform
}

// ReinspectCaseSensitivity fails closed outside Windows.
func (*Directory) ReinspectCaseSensitivity() (bool, error) {
	return false, ErrUnsupportedPlatform
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
