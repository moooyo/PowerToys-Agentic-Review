//go:build !windows

package peerverify

// NewWindowsAuthenticodeVerifier fails closed outside Windows.
func NewWindowsAuthenticodeVerifier() (AuthenticodeVerifier, error) {
	return nil, ErrUnsupportedPlatform
}
