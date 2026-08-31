//go:build !windows

package peerverify

// VerifyWindows is the non-Windows form of the low-level preflight bridge. It
// fails closed without observing the pipe or opening any native resource.
func VerifyWindows(Options) (*Session, error) {
	return nil, ErrUnsupportedPlatform
}
