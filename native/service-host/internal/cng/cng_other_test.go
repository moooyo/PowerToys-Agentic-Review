//go:build !windows

package cng

import (
	"errors"
	"testing"
)

func TestNonWindowsCNGFailsExplicitly(t *testing.T) {
	if _, err := Open(Options{}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Open returned the wrong error: %v", err)
	}

	signer := &Signer{}
	if identity := signer.Identity(); identity != (KeyIdentity{}) {
		t.Fatalf("Identity returned %#v", identity)
	}
	if digest := signer.PublicKeySPKISHA256(); digest != ([DigestSize]byte{}) {
		t.Fatalf("PublicKeySPKISHA256 returned %x", digest)
	}
	if _, err := signer.SignDigest(make([]byte, DigestSize)); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("SignDigest returned the wrong error: %v", err)
	}
	if err := signer.Close(); err != nil {
		t.Fatalf("Close returned an error: %v", err)
	}
	if err := signer.Close(); err != nil {
		t.Fatalf("repeated Close returned an error: %v", err)
	}
}
