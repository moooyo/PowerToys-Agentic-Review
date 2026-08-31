//go:build !windows

package wincert

import (
	"crypto"
	"errors"
	"testing"
)

func TestNonWindowsAcquisitionFailsClosed(t *testing.T) {
	config := Config{
		StoreName:                           LocalMachinePersonalStore,
		CertificateSHA256:                   "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		ExpectedKeySecurityDescriptorSHA256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
		ControlServiceSID:                   testControlServiceSID,
		ExecutorServiceSID:                  testExecutorServiceSID,
	}
	if _, err := Acquire(config); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("Acquire returned the wrong error: %v", err)
	}
	if _, err := Acquire(Config{}); !errors.Is(err, ErrInvalidConfiguration) {
		t.Fatalf("Acquire did not validate configuration before the platform: %v", err)
	}

	credential := &Credential{}
	if certificate := credential.TLSCertificate(); len(certificate.Certificate) != 0 {
		t.Fatal("unsupported credential returned a certificate")
	}
	if credential.Public() != nil {
		t.Fatal("unsupported credential returned a public key")
	}
	if identity := credential.KeyIdentity(); identity != (KeyIdentity{}) {
		t.Fatalf("unsupported credential returned a key identity: %#v", identity)
	}
	if identity := credential.Identity(); identity != (KeyIdentity{}) {
		t.Fatalf("unsupported credential returned an identity: %#v", identity)
	}
	if attestation, err := credential.Attestation(); !errors.Is(err, ErrUnsupportedPlatform) || attestation != (Attestation{}) {
		t.Fatalf("unsupported Attestation returned %#v, %v", attestation, err)
	}
	var nilCredential *Credential
	if _, err := nilCredential.Attestation(); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("nil unsupported Attestation returned the wrong error: %v", err)
	}
	if _, err := credential.Sign(nil, make([]byte, p256DigestBytes), crypto.SHA256); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("Sign returned the wrong error: %v", err)
	}
	if err := credential.Close(); err != nil {
		t.Fatalf("Close returned an error: %v", err)
	}
	if err := credential.Close(); err != nil {
		t.Fatalf("repeated Close returned an error: %v", err)
	}
}
