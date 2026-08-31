//go:build !windows

package peerverify

func newPlatformProcessOpener() (processOpener, error) {
	return nil, ErrUnsupportedPlatform
}
