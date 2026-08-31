package authenticode

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"errors"
	"math/big"
	"testing"
	"time"
)

func TestValidateSignaturePolicyAcceptsOnePrimarySignerAndTimestamp(t *testing.T) {
	err := validateSignaturePolicy(signaturePolicyFacts{
		PrimarySignerCount:          1,
		CertificateChainCount:       3,
		TimestampCounterSignerCount: 1,
	})
	if err != nil {
		t.Fatalf("validateSignaturePolicy returned an error: %v", err)
	}
}

func TestValidateSignaturePolicyFailsClosed(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*signaturePolicyFacts)
		want   error
	}{
		{name: "different verified signature", mutate: func(facts *signaturePolicyFacts) { facts.VerifiedSignatureIndex = 1 }, want: ErrAmbiguousSignature},
		{name: "secondary signature", mutate: func(facts *signaturePolicyFacts) { facts.SecondarySignatureCount = 1 }, want: ErrAmbiguousSignature},
		{name: "nested signature", mutate: func(facts *signaturePolicyFacts) { facts.NestedSignaturePresent = true }, want: ErrAmbiguousSignature},
		{name: "no primary signer", mutate: func(facts *signaturePolicyFacts) { facts.PrimarySignerCount = 0 }, want: ErrAmbiguousSignature},
		{name: "two primary signers", mutate: func(facts *signaturePolicyFacts) { facts.PrimarySignerCount = 2 }, want: ErrAmbiguousSignature},
		{name: "timestamp selected as primary", mutate: func(facts *signaturePolicyFacts) { facts.SignerType = signerTypeTimestamp }, want: ErrSignerBinding},
		{name: "signer verification error", mutate: func(facts *signaturePolicyFacts) { facts.SignerError = 1 }, want: ErrUntrustedSignature},
		{name: "empty chain", mutate: func(facts *signaturePolicyFacts) { facts.CertificateChainCount = 0 }, want: ErrSignerBinding},
		{name: "oversized chain", mutate: func(facts *signaturePolicyFacts) { facts.CertificateChainCount = maximumCertificateChain + 1 }, want: ErrSignerBinding},
		{name: "too many countersigners", mutate: func(facts *signaturePolicyFacts) { facts.TimestampCounterSignerCount = maximumCounterSigners + 1 }, want: ErrAmbiguousSignature},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			facts := signaturePolicyFacts{PrimarySignerCount: 1, CertificateChainCount: 1}
			test.mutate(&facts)
			if err := validateSignaturePolicy(facts); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestEvidenceFromLeafCertificateReportsExactDERDigestAndRuntimePolicy(t *testing.T) {
	der := makeTestCertificateDER(t)
	evidence, err := evidenceFromLeafCertificate(der, 2)
	if err != nil {
		t.Fatalf("evidenceFromLeafCertificate returned an error: %v", err)
	}
	digest := sha256.Sum256(der)
	if !evidence.Trusted ||
		evidence.SignatureKind != SignatureKindEmbedded ||
		evidence.SignatureCount != 1 ||
		evidence.VerifiedSignatureIndex != 0 ||
		evidence.TimestampCounterSignerCount != 2 ||
		evidence.RevocationPolicy != RevocationPolicyRuntimeCacheOnlyNoCheck ||
		evidence.DigestPolicy != DigestPolicySHA256Only ||
		evidence.StrongSignaturePolicy != StrongSignaturePolicyWindowsOSCurrent ||
		evidence.SignerDigestAlgorithmOID != SHA256ObjectIdentifier ||
		evidence.FileDigestAlgorithmOID != SHA256ObjectIdentifier ||
		evidence.VerifiedLeafSignerCertificateDERSHA256 != hex.EncodeToString(digest[:]) {
		t.Fatalf("unexpected evidence: %+v", evidence)
	}
	if evidence.SignerIdentity == "" {
		t.Fatal("SignerIdentity is empty")
	}
}

func TestEvidenceFromLeafCertificateRejectsInvalidOrUnboundedDER(t *testing.T) {
	tests := []struct {
		name string
		der  []byte
	}{
		{name: "empty"},
		{name: "malformed", der: []byte{1, 2, 3}},
		{name: "too large", der: make([]byte, maximumCertificateDERBytes+1)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := evidenceFromLeafCertificate(test.der, 0); !errors.Is(err, ErrInvalidCertificate) {
				t.Fatalf("error = %v, want ErrInvalidCertificate", err)
			}
		})
	}
}

func makeTestCertificateDER(t *testing.T) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate test key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(42),
		Subject:      pkix.Name{CommonName: "Authenticode Test Signer"},
		NotBefore:    time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		NotAfter:     time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageCodeSigning},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create test certificate: %v", err)
	}
	return der
}
