//go:build !windows

package cng

// Signer is unavailable outside Windows.
type Signer struct{}

// Open fails explicitly because persisted CNG keys are a Windows-only facility.
func Open(Options) (*Signer, error) {
	return nil, ErrUnsupported
}

// Identity returns an empty detached identity on unsupported platforms.
func (*Signer) Identity() KeyIdentity {
	return KeyIdentity{}
}

// PublicKeySPKISHA256 returns an empty digest on unsupported platforms.
func (*Signer) PublicKeySPKISHA256() [DigestSize]byte {
	return [DigestSize]byte{}
}

// SignDigest fails explicitly because persisted CNG keys are a Windows-only facility.
func (*Signer) SignDigest([]byte) ([]byte, error) {
	return nil, ErrUnsupported
}

// Close is idempotent for the unavailable non-Windows signer.
func (*Signer) Close() error {
	return nil
}
