//go:build !windows

package cng

// Signer is unavailable outside Windows.
type Signer struct{}

// Open fails explicitly because persisted CNG keys are a Windows-only facility.
func Open(string, string) (*Signer, error) {
	return nil, ErrUnsupported
}

// SignDigest fails explicitly because persisted CNG keys are a Windows-only facility.
func (*Signer) SignDigest([]byte) ([]byte, error) {
	return nil, ErrUnsupported
}

// Close is idempotent for the unavailable non-Windows signer.
func (*Signer) Close() error {
	return nil
}
