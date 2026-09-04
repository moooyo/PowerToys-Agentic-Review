package workerpackage

import "crypto/ed25519"

// VerifySignature validates a canonical manifest and verifies a raw Ed25519 signature.
func VerifySignature(manifestBytes, raw64Signature, publicKey32 []byte) error {
	if _, err := ParseManifest(manifestBytes); err != nil {
		return err
	}
	if len(raw64Signature) != ed25519.SignatureSize {
		return newError(ErrSignature, "", "signature must be exactly 64 bytes", nil)
	}
	if len(publicKey32) != ed25519.PublicKeySize {
		return newError(ErrSignature, "", "public key must be exactly 32 bytes", nil)
	}
	if !ed25519.Verify(ed25519.PublicKey(publicKey32), manifestBytes, raw64Signature) {
		return newError(ErrSignature, "", "Ed25519 signature verification failed", nil)
	}
	return nil
}
