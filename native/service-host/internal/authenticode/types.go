package authenticode

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

var (
	ErrUnsupportedPlatform = errors.New("Authenticode verification requires Windows")
	ErrInvalidSubject      = errors.New("invalid borrowed Authenticode file subject")
	ErrSubjectConsumed     = errors.New("borrowed Authenticode file subject was already consumed")
	ErrUntrustedSignature  = errors.New("embedded Authenticode signature is not trusted")
	ErrAmbiguousSignature  = errors.New("embedded Authenticode signature selection is ambiguous")
	ErrWeakAlgorithm       = errors.New("Authenticode signature uses a disallowed cryptographic algorithm")
	ErrSignerBinding       = errors.New("Authenticode signer certificate is not bound to the verified SignerInfo")
	ErrInvalidCertificate  = errors.New("Authenticode leaf signer certificate is invalid")
	ErrStateCleanup        = errors.New("WinVerifyTrust state cleanup failed")
)

// SignatureKind identifies the signature container accepted by the verifier.
type SignatureKind string

const (
	// SignatureKindEmbedded is a PKCS#7 signature embedded in the verified PE.
	SignatureKindEmbedded SignatureKind = "embedded"
)

// RevocationPolicy identifies the exact offline runtime policy used by
// WinVerifyTrust. It is evidence about policy configuration, not a claim that
// CRL or OCSP revocation was checked.
type RevocationPolicy string

const (
	// RevocationPolicyRuntimeCacheOnlyNoCheck disables revocation checking and
	// all URL retrieval during runtime verification.
	RevocationPolicyRuntimeCacheOnlyNoCheck RevocationPolicy = "runtime-cache-only-no-revocation-check"
)

// DigestPolicy identifies the exact Authenticode digest algorithms accepted
// for both the PKCS#7 SignerInfo and the PE indirect-data digest.
type DigestPolicy string

const (
	// DigestPolicySHA256Only rejects every digest algorithm except SHA-256.
	DigestPolicySHA256Only DigestPolicy = "sha256-only"
)

// StrongSignaturePolicy identifies the Windows strong-sign policy supplied to
// WinVerifyTrust for PKCS#7 signatures and certificate chains.
type StrongSignaturePolicy string

const (
	// StrongSignaturePolicyWindowsOSCurrent is CERT_STRONG_SIGN_PARA_OS_CURRENT.
	StrongSignaturePolicyWindowsOSCurrent StrongSignaturePolicy = "windows-os-current-sha2"
)

// SHA256ObjectIdentifier is the NIST SHA-256 algorithm OID.
const SHA256ObjectIdentifier = "2.16.840.1.101.3.4.2.1"

// Evidence is detached from the WinVerifyTrust state before that state is
// closed. SignatureCount is one because the production policy rejects every
// secondary, nested, or additional primary signature.
type Evidence struct {
	Trusted                                bool
	SignatureKind                          SignatureKind
	SignatureCount                         uint32
	VerifiedSignatureIndex                 uint32
	TimestampCounterSignerCount            uint32
	RevocationPolicy                       RevocationPolicy
	DigestPolicy                           DigestPolicy
	StrongSignaturePolicy                  StrongSignaturePolicy
	SignerDigestAlgorithmOID               string
	FileDigestAlgorithmOID                 string
	SignerIdentity                         string
	VerifiedLeafSignerCertificateDERSHA256 string
}

// Subject is an opaque, single-use borrowed file capability. Its zero value is
// invalid. A Subject has no method that reveals the native file handle.
type Subject struct {
	state *subjectState
}

// Verifier validates one opaque, borrowed file subject. Implementations must
// consume the subject synchronously and must return only detached evidence.
type Verifier interface {
	Verify(Subject) (Evidence, error)
}

const (
	maximumCertificateDERBytes = 1 << 20
	maximumCertificateChain    = 64
	maximumCounterSigners      = 64
	maximumSignerIdentityBytes = 4 << 10
)

const signerTypeTimestamp = uint32(0x00000010)

type signaturePolicyFacts struct {
	VerifiedSignatureIndex      uint32
	SecondarySignatureCount     uint32
	PrimarySignerCount          uint32
	SignerType                  uint32
	SignerError                 uint32
	CertificateChainCount       uint32
	TimestampCounterSignerCount uint32
	NestedSignaturePresent      bool
}

func validateSignaturePolicy(facts signaturePolicyFacts) error {
	if facts.VerifiedSignatureIndex != 0 {
		return fmt.Errorf("%w: WinVerifyTrust selected signature index %d", ErrAmbiguousSignature, facts.VerifiedSignatureIndex)
	}
	if facts.SecondarySignatureCount != 0 || facts.NestedSignaturePresent {
		return fmt.Errorf(
			"%w: file has %d secondary signatures (nested attribute present: %t)",
			ErrAmbiguousSignature,
			facts.SecondarySignatureCount,
			facts.NestedSignaturePresent,
		)
	}
	if facts.PrimarySignerCount != 1 {
		return fmt.Errorf("%w: verified message has %d primary signers", ErrAmbiguousSignature, facts.PrimarySignerCount)
	}
	if facts.SignerType&signerTypeTimestamp != 0 {
		return fmt.Errorf("%w: selected primary signer is a timestamp signer", ErrSignerBinding)
	}
	if facts.SignerError != 0 {
		return fmt.Errorf("%w: primary signer state has error 0x%08x", ErrUntrustedSignature, facts.SignerError)
	}
	if facts.CertificateChainCount == 0 || facts.CertificateChainCount > maximumCertificateChain {
		return fmt.Errorf(
			"%w: primary signer certificate chain length %d is outside the supported range",
			ErrSignerBinding,
			facts.CertificateChainCount,
		)
	}
	if facts.TimestampCounterSignerCount > maximumCounterSigners {
		return fmt.Errorf(
			"%w: timestamp countersigner count %d exceeds the supported limit",
			ErrAmbiguousSignature,
			facts.TimestampCounterSignerCount,
		)
	}
	return nil
}

func evidenceFromLeafCertificate(der []byte, timestampCounterSignerCount uint32) (Evidence, error) {
	if len(der) == 0 || len(der) > maximumCertificateDERBytes {
		return Evidence{}, fmt.Errorf(
			"%w: leaf certificate DER length %d is outside the supported range",
			ErrInvalidCertificate,
			len(der),
		)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		return Evidence{}, fmt.Errorf("%w: parse leaf certificate DER: %v", ErrInvalidCertificate, err)
	}
	digestBytes := sha256.Sum256(der)
	digest := hex.EncodeToString(digestBytes[:])
	subject := strings.TrimSpace(certificate.Subject.String())
	serial := strings.ToLower(certificate.SerialNumber.Text(16))
	identity := "certificate-sha256=" + digest
	candidate := "serial=" + serial + "; " + identity
	if subject != "" {
		candidate = subject + "; " + candidate
	}
	if !strings.ContainsRune(candidate, '\x00') && len(candidate) <= maximumSignerIdentityBytes {
		identity = candidate
	}
	return Evidence{
		Trusted:                                true,
		SignatureKind:                          SignatureKindEmbedded,
		SignatureCount:                         1,
		VerifiedSignatureIndex:                 0,
		TimestampCounterSignerCount:            timestampCounterSignerCount,
		RevocationPolicy:                       RevocationPolicyRuntimeCacheOnlyNoCheck,
		DigestPolicy:                           DigestPolicySHA256Only,
		StrongSignaturePolicy:                  StrongSignaturePolicyWindowsOSCurrent,
		SignerDigestAlgorithmOID:               SHA256ObjectIdentifier,
		FileDigestAlgorithmOID:                 SHA256ObjectIdentifier,
		SignerIdentity:                         identity,
		VerifiedLeafSignerCertificateDERSHA256: digest,
	}, nil
}
