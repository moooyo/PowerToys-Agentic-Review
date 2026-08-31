//go:build !windows

package wincert

import (
	"crypto"
	"crypto/tls"
	"io"
)

// Credential is unavailable outside Windows.
type Credential struct{}

// Acquire fails closed because the Windows Local Machine certificate store and
// CNG are unavailable on this platform.
func Acquire(config Config) (*Credential, error) {
	if _, err := validateConfig(config); err != nil {
		return nil, err
	}
	return nil, ErrUnsupportedPlatform
}

// TLSCertificate returns an empty certificate on unsupported platforms.
func (*Credential) TLSCertificate() tls.Certificate {
	return tls.Certificate{}
}

// Public returns no public key on unsupported platforms.
func (*Credential) Public() crypto.PublicKey {
	return nil
}

// Identity returns no identity on unsupported platforms.
func (*Credential) Identity() KeyIdentity {
	return KeyIdentity{}
}

// KeyIdentity returns the same empty identity as Identity.
func (c *Credential) KeyIdentity() KeyIdentity {
	return c.Identity()
}

// Attestation fails closed because no native certificate or key can be observed.
func (*Credential) Attestation() (Attestation, error) {
	return Attestation{}, ErrUnsupportedPlatform
}

// Sign fails closed on unsupported platforms.
func (*Credential) Sign(io.Reader, []byte, crypto.SignerOpts) ([]byte, error) {
	return nil, ErrUnsupportedPlatform
}

// Close is idempotent for the unavailable credential.
func (*Credential) Close() error {
	return nil
}

var _ crypto.Signer = (*Credential)(nil)
