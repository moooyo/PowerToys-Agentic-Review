//go:build !windows

package peerverify

// VerifyWindows fails closed outside Windows without observing the pipe or
// opening any native resource.
func VerifyWindows(Options) (*Session, error) {
	return nil, ErrUnsupportedPlatform
}
