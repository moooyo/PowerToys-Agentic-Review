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

// Attestation fails because no CNG key can be validated on this platform.
func (*Signer) Attestation() (Attestation, error) {
	return Attestation{}, ErrUnsupported
}

// IsOpen reports false because no CNG key can be opened on this platform.
func (*Signer) IsOpen() bool {
	return false
}

// SignDigest fails explicitly because persisted CNG keys are a Windows-only facility.
func (*Signer) SignDigest([]byte) ([]byte, error) {
	return nil, ErrUnsupported
}

// Close is idempotent for the unavailable non-Windows signer.
func (*Signer) Close() error {
	return nil
}
