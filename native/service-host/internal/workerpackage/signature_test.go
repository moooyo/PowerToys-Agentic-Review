package workerpackage

import (
	"crypto/ed25519"
	"errors"
	"strings"
	"testing"
)

func TestVerifySignatureAcceptsCanonicalManifestAndValidSignature(t *testing.T) {
	manifestBytes, err := MarshalManifestCanonical(validManifest())
	if err != nil {
		t.Fatal(err)
	}

	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = byte(index + 1)
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	publicKey := privateKey.Public().(ed25519.PublicKey)
	signature := ed25519.Sign(privateKey, manifestBytes)

	if err := VerifySignature(manifestBytes, signature, publicKey); err != nil {
		t.Fatalf("VerifySignature error = %v", err)
	}
}

func TestVerifySignatureRejectsInvalidInputLengths(t *testing.T) {
	manifestBytes, err := MarshalManifestCanonical(validManifest())
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifySignature(manifestBytes, []byte("short"), make([]byte, ed25519.PublicKeySize)); err == nil || !errors.Is(err, ErrSignature) {
		t.Fatalf("VerifySignature(short signature) error = %v, want ErrSignature", err)
	}
	if err := VerifySignature(manifestBytes, make([]byte, ed25519.SignatureSize), []byte("short")); err == nil || !errors.Is(err, ErrSignature) {
		t.Fatalf("VerifySignature(short public key) error = %v, want ErrSignature", err)
	}
}

func TestVerifySignatureRejectsTamperedManifest(t *testing.T) {
	manifestBytes, err := MarshalManifestCanonical(validManifest())
	if err != nil {
		t.Fatal(err)
	}
	publicKey, privateKey, err := ed25519.GenerateKey(strings.NewReader(strings.Repeat("x", 128)))
	if err != nil {
		t.Fatal(err)
	}
	signature := ed25519.Sign(privateKey, manifestBytes)

	tamperedManifest := validManifest()
	tamperedManifest.ReleaseID = "R-2"
	tampered, err := MarshalManifestCanonical(tamperedManifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifySignature(tampered, signature, publicKey); err == nil || !errors.Is(err, ErrSignature) {
		t.Fatalf("VerifySignature(tampered) error = %v, want ErrSignature", err)
	}
}

func TestVerifySignatureRequiresCanonicalManifestBytes(t *testing.T) {
	manifestBytes, err := MarshalManifestCanonical(validManifest())
	if err != nil {
		t.Fatal(err)
	}
	nonCanonical := append(append([]byte(nil), manifestBytes...), '\n')
	if err := VerifySignature(nonCanonical, make([]byte, ed25519.SignatureSize), make([]byte, ed25519.PublicKeySize)); err == nil || !errors.Is(err, ErrCanonical) {
		t.Fatalf("VerifySignature(non-canonical) error = %v, want ErrCanonical", err)
	}
}
