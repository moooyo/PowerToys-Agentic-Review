package rootcert

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"testing"
	"time"
)

func TestParseAcceptsSingleDERAndReturnsDetachedBytes(t *testing.T) {
	der := testCertificateDER(t, certificateOptions{serial: 1, isCA: true, basicConstraints: true, keyUsage: x509.KeyUsageCertSign})
	input := bytes.Clone(der)
	roots, err := Parse(input)
	if err != nil {
		t.Fatalf("Parse returned an error: %v", err)
	}
	if len(roots) != 1 || !bytes.Equal(roots[0], der) {
		t.Fatalf("Parse returned the wrong DER roots: %d", len(roots))
	}

	first := roots[0][0]
	input[0] ^= 0xff
	if roots[0][0] != first {
		t.Fatal("returned DER aliases the input")
	}
	second := input[1]
	roots[0][1] ^= 0xff
	if input[1] != second {
		t.Fatal("input aliases the returned DER")
	}
}

func TestParseAcceptsStrictPEMBundleInOrder(t *testing.T) {
	first := testCertificateDER(t, certificateOptions{serial: 10, isCA: true, basicConstraints: true, keyUsage: x509.KeyUsageCertSign})
	second := testCertificateDER(t, certificateOptions{serial: 11, isCA: true, basicConstraints: true, keyUsage: x509.KeyUsageCertSign})
	bundle := append(pemForDER(first), pemForDER(second)...)
	bundle = []byte(" \t\r\n" + strings.ReplaceAll(string(bundle), "\n", "\r\n") + "\t ")
	original := bytes.Clone(bundle)

	roots, err := Parse(bundle)
	if err != nil {
		t.Fatalf("Parse returned an error: %v", err)
	}
	if len(roots) != 2 || !bytes.Equal(roots[0], first) || !bytes.Equal(roots[1], second) {
		t.Fatal("Parse did not preserve PEM certificate order")
	}
	if !bytes.Equal(bundle, original) {
		t.Fatal("Parse mutated PEM input")
	}

	value := roots[0][0]
	bundle[0] ^= 0xff
	if roots[0][0] != value {
		t.Fatal("returned PEM DER aliases the input")
	}
}

func TestParseRejectsEmptyAndJunkPEMContent(t *testing.T) {
	der := testCertificateDER(t, certificateOptions{serial: 20, isCA: true, basicConstraints: true, keyUsage: x509.KeyUsageCertSign})
	certificatePEM := pemForDER(der)
	headerPEM := pem.EncodeToMemory(&pem.Block{
		Type:    "CERTIFICATE",
		Headers: map[string]string{"Comment": "not permitted"},
		Bytes:   der,
	})
	nonCertificatePEM := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	spacedBody := bytes.Replace(bytes.Clone(certificatePEM), []byte("\n"), []byte("\n "), 1)
	emptyBodyLine := bytes.Replace(bytes.Clone(certificatePEM), []byte("\n"), []byte("\n\n"), 1)

	tests := []struct {
		name    string
		content []byte
	}{
		{name: "nil"},
		{name: "empty", content: []byte{}},
		{name: "whitespace", content: []byte(" \t\r\n")},
		{name: "junk only", content: []byte("not a certificate")},
		{name: "junk prefix", content: append([]byte("junk\n"), certificatePEM...)},
		{name: "junk suffix", content: append(bytes.Clone(certificatePEM), []byte("junk")...)},
		{name: "junk between", content: append(append(bytes.Clone(certificatePEM), []byte("junk\n")...), certificatePEM...)},
		{name: "non-certificate block", content: nonCertificatePEM},
		{name: "PEM header", content: headerPEM},
		{name: "space in base64", content: spacedBody},
		{name: "empty body line", content: emptyBodyLine},
		{name: "missing end", content: []byte(pemBeginLine + "\nAAAA\n")},
		{name: "bare carriage return", content: bytes.Replace(bytes.Clone(certificatePEM), []byte("\n"), []byte("\r"), 1)},
		{name: "empty block", content: []byte(pemBeginLine + "\n" + pemEndLine + "\n")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if roots, err := Parse(test.content); err == nil || roots != nil {
				t.Fatalf("Parse accepted invalid content and returned %d roots", len(roots))
			}
		})
	}
}

func TestParseRejectsNonCanonicalBase64(t *testing.T) {
	var der []byte
	for payloadBytes := 0; payloadBytes < 3; payloadBytes++ {
		candidate := testCertificateDER(t, certificateOptions{
			serial: 30, isCA: true, basicConstraints: true, keyUsage: x509.KeyUsageCertSign,
			payloadBytes: payloadBytes,
		})
		if len(candidate)%3 != 0 {
			der = candidate
			break
		}
	}
	if len(der) == 0 {
		t.Fatal("failed to create a padded base64 fixture")
	}
	encoded := []byte(base64.StdEncoding.EncodeToString(der))
	lastData := len(encoded) - 2
	unusedMask := byte(0x03)
	if encoded[len(encoded)-2] == '=' {
		lastData = len(encoded) - 3
		unusedMask = 0x0f
	}
	value := bytes.IndexByte([]byte("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"), encoded[lastData])
	if value < 0 {
		t.Fatal("base64 fixture contains an invalid alphabet byte")
	}
	encoded[lastData] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[byte(value)|unusedMask]
	if _, err := base64.StdEncoding.DecodeString(string(encoded)); err != nil {
		t.Fatalf("noncanonical fixture is not accepted by lenient base64: %v", err)
	}
	content := []byte(pemBeginLine + "\n" + string(encoded) + "\n" + pemEndLine + "\n")
	if _, err := Parse(content); !errors.Is(err, ErrInvalidContent) {
		t.Fatalf("Parse error = %v, want ErrInvalidContent", err)
	}
}

func TestParseRejectsNonCanonicalAndConcatenatedDER(t *testing.T) {
	der := testCertificateDER(t, certificateOptions{serial: 40, isCA: true, basicConstraints: true, keyUsage: x509.KeyUsageCertSign})
	nonCanonical := nonCanonicalOuterLength(der)
	tests := []struct {
		name    string
		content []byte
	}{
		{name: "nonminimal outer length", content: nonCanonical},
		{name: "trailing byte", content: append(bytes.Clone(der), 0)},
		{name: "concatenated DER", content: append(bytes.Clone(der), der...)},
		{name: "concatenated DER in PEM", content: pemForDER(append(bytes.Clone(der), der...))},
		{name: "nonminimal DER in PEM", content: pemForDER(nonCanonical)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := Parse(test.content); !errors.Is(err, ErrInvalidCertificate) {
				t.Fatalf("Parse error = %v, want ErrInvalidCertificate", err)
			}
		})
	}
}

func TestParseRejectsInternallyTrailingAndNonCanonicalDER(t *testing.T) {
	der := testCertificateDER(t, certificateOptions{serial: 41, isCA: true, basicConstraints: true, keyUsage: x509.KeyUsageCertSign})
	top, rest, ok := readDERElement(der)
	if !ok || len(rest) != 0 {
		t.Fatal("valid fixture did not contain one DER element")
	}
	trailingField := encodeDERElement(top.full[0], append(bytes.Clone(top.content), 0x05, 0x00))
	if _, err := x509.ParseCertificate(trailingField); err != nil {
		t.Fatalf("stdlib no longer accepts the internal-trailing fixture: %v", err)
	}

	missingSeconds := rewriteDERPath(t, der, []int{0, 4, 0}, func(element derElement) []byte {
		if element.tag != asn1.TagUTCTime || len(element.content) != 13 {
			t.Fatalf("unexpected notBefore element: tag=%d length=%d", element.tag, len(element.content))
		}
		shortened := append(bytes.Clone(element.content[:10]), element.content[12:]...)
		return encodeDERElement(element.full[0], shortened)
	})
	if _, err := x509.ParseCertificate(missingSeconds); err != nil {
		t.Fatalf("stdlib no longer accepts the missing-seconds fixture: %v", err)
	}

	for _, content := range [][]byte{trailingField, missingSeconds, pemForDER(trailingField), pemForDER(missingSeconds)} {
		if _, err := Parse(content); !errors.Is(err, ErrInvalidCertificate) {
			t.Fatalf("Parse error = %v, want ErrInvalidCertificate", err)
		}
	}
}

func TestParseRejectsNonCanonicalExtensionValues(t *testing.T) {
	keyUsageWithTrailingNull := []byte{0x03, 0x02, 0x02, 0x04, 0x05, 0x00}
	tests := []struct {
		name      string
		extension pkix.Extension
	}{
		{
			name: "known extension with trailing value",
			extension: pkix.Extension{
				Id:    asn1.ObjectIdentifier{2, 5, 29, 15},
				Value: keyUsageWithTrailingNull,
			},
		},
		{
			name: "unknown extension without DER value",
			extension: pkix.Extension{
				Id:    asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 55555, 2},
				Value: []byte{0x00},
			},
		},
	}
	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			der := testCertificateDER(t, certificateOptions{
				serial:           42 + int64(index),
				isCA:             true,
				basicConstraints: true,
				keyUsage:         x509.KeyUsageCertSign,
				extensions:       []pkix.Extension{test.extension},
			})
			parsed, err := x509.ParseCertificate(der)
			if err != nil || parsed.KeyUsage&x509.KeyUsageCertSign == 0 {
				t.Fatalf("stdlib did not accept the extension fixture: certificate=%v error=%v", parsed, err)
			}
			if _, err := Parse(der); !errors.Is(err, ErrInvalidCertificate) {
				t.Fatalf("Parse error = %v, want ErrInvalidCertificate", err)
			}
		})
	}
}

func TestParseRejectsCertificatesOutsideCAPolicy(t *testing.T) {
	tests := []struct {
		name    string
		options certificateOptions
	}{
		{
			name: "not a CA",
			options: certificateOptions{
				serial: 50, basicConstraints: true, keyUsage: x509.KeyUsageCertSign,
			},
		},
		{
			name: "missing basic constraints",
			options: certificateOptions{
				serial: 51, keyUsage: x509.KeyUsageCertSign,
			},
		},
		{
			name: "missing CertSign",
			options: certificateOptions{
				serial: 52, isCA: true, basicConstraints: true, keyUsage: x509.KeyUsageDigitalSignature,
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			der := testCertificateDER(t, test.options)
			if _, err := Parse(der); !errors.Is(err, ErrInvalidCertificate) {
				t.Fatalf("Parse error = %v, want ErrInvalidCertificate", err)
			}
		})
	}
}

func TestParseRejectsDuplicateCertificates(t *testing.T) {
	der := testCertificateDER(t, certificateOptions{serial: 60, isCA: true, basicConstraints: true, keyUsage: x509.KeyUsageCertSign})
	bundle := append(pemForDER(der), pemForDER(der)...)
	if _, err := Parse(bundle); !errors.Is(err, ErrDuplicateCertificate) {
		t.Fatalf("Parse error = %v, want ErrDuplicateCertificate", err)
	}
}

func TestParseEnforcesCertificateCountLimit(t *testing.T) {
	var maximumBundle []byte
	for index := 0; index < MaximumCertificates; index++ {
		der := testCertificateDER(t, certificateOptions{
			serial: 100 + int64(index), isCA: true, basicConstraints: true, keyUsage: x509.KeyUsageCertSign,
		})
		maximumBundle = append(maximumBundle, pemForDER(der)...)
	}
	roots, err := Parse(maximumBundle)
	if err != nil || len(roots) != MaximumCertificates {
		t.Fatalf("Parse at count limit = (%d roots, %v)", len(roots), err)
	}

	extra := testCertificateDER(t, certificateOptions{
		serial: 100 + MaximumCertificates, isCA: true, basicConstraints: true, keyUsage: x509.KeyUsageCertSign,
	})
	overLimit := append(bytes.Clone(maximumBundle), pemForDER(extra)...)
	if _, err := Parse(overLimit); !errors.Is(err, ErrLimitExceeded) {
		t.Fatalf("Parse count-limit error = %v, want ErrLimitExceeded", err)
	}
}

func TestParseEnforcesPerCertificateDERLimit(t *testing.T) {
	oversized := bytes.Repeat([]byte{0x30}, MaximumCertificateDERBytes+1)
	for _, content := range [][]byte{oversized, pemForDER(oversized)} {
		if _, err := Parse(content); !errors.Is(err, ErrLimitExceeded) {
			t.Fatalf("Parse size-limit error = %v, want ErrLimitExceeded", err)
		}
	}
}

func TestParseEnforcesAggregateDERLimit(t *testing.T) {
	var bundle []byte
	total := 0
	for index := 0; total <= MaximumBundleDERBytes; index++ {
		der := testCertificateDER(t, certificateOptions{
			serial:           200 + int64(index),
			isCA:             true,
			basicConstraints: true,
			keyUsage:         x509.KeyUsageCertSign,
			payloadBytes:     60 * 1024,
		})
		if len(der) > MaximumCertificateDERBytes {
			t.Fatalf("large fixture has %d DER bytes", len(der))
		}
		bundle = append(bundle, pemForDER(der)...)
		total += len(der)
	}
	if len(bundle) == 0 || total <= MaximumBundleDERBytes {
		t.Fatal("failed to construct an aggregate-limit fixture")
	}
	if _, err := Parse(bundle); !errors.Is(err, ErrLimitExceeded) {
		t.Fatalf("Parse aggregate-limit error = %v, want ErrLimitExceeded", err)
	}
}

type certificateOptions struct {
	serial           int64
	isCA             bool
	basicConstraints bool
	keyUsage         x509.KeyUsage
	payloadBytes     int
	extensions       []pkix.Extension
}

var testCertificateKey = ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x42}, ed25519.SeedSize))

func testCertificateDER(t *testing.T, options certificateOptions) []byte {
	t.Helper()
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(options.serial),
		Subject:               pkix.Name{CommonName: fmt.Sprintf("Root %d", options.serial)},
		NotBefore:             time.Unix(0, 0).UTC(),
		NotAfter:              time.Unix(4_102_444_800, 0).UTC(),
		KeyUsage:              options.keyUsage,
		BasicConstraintsValid: options.basicConstraints,
		IsCA:                  options.isCA,
	}
	if options.payloadBytes != 0 {
		template.ExtraExtensions = append(template.ExtraExtensions, pkix.Extension{
			Id:    []int{1, 3, 6, 1, 4, 1, 55555, 1},
			Value: encodeDERElement(0x04, bytes.Repeat([]byte{0x5a}, options.payloadBytes)),
		})
	}
	template.ExtraExtensions = append(template.ExtraExtensions, options.extensions...)
	der, err := x509.CreateCertificate(rand.Reader, template, template, testCertificateKey.Public(), testCertificateKey)
	if err != nil {
		t.Fatalf("create test certificate: %v", err)
	}
	return der
}

func pemForDER(der []byte) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func nonCanonicalOuterLength(der []byte) []byte {
	if len(der) < 2 {
		return bytes.Clone(der)
	}
	if der[1]&0x80 == 0 {
		result := make([]byte, len(der)+1)
		result[0] = der[0]
		result[1] = 0x81
		result[2] = der[1]
		copy(result[3:], der[2:])
		return result
	}

	lengthBytes := int(der[1] & 0x7f)
	result := make([]byte, len(der)+1)
	result[0] = der[0]
	result[1] = 0x80 | byte(lengthBytes+1)
	result[2] = 0
	copy(result[3:3+lengthBytes], der[2:2+lengthBytes])
	copy(result[3+lengthBytes:], der[2+lengthBytes:])
	return result
}

func rewriteDERPath(t *testing.T, document []byte, path []int, mutate func(derElement) []byte) []byte {
	t.Helper()
	element, rest, ok := readDERElement(document)
	if !ok || len(rest) != 0 {
		t.Fatal("rewrite input is not one DER element")
	}
	if len(path) == 0 {
		return mutate(element)
	}
	children, ok := splitDERElements(element.content)
	if !ok || path[0] < 0 || path[0] >= len(children) {
		t.Fatalf("DER rewrite path %v is invalid", path)
	}
	var content []byte
	for index, child := range children {
		if index == path[0] {
			content = append(content, rewriteDERPath(t, child.full, path[1:], mutate)...)
		} else {
			content = append(content, child.full...)
		}
	}
	return encodeDERElement(element.full[0], content)
}

func encodeDERElement(identifier byte, content []byte) []byte {
	if len(content) < 128 {
		result := make([]byte, 2+len(content))
		result[0] = identifier
		result[1] = byte(len(content))
		copy(result[2:], content)
		return result
	}

	length := len(content)
	lengthBytes := 0
	for value := length; value != 0; value >>= 8 {
		lengthBytes++
	}
	result := make([]byte, 2+lengthBytes+len(content))
	result[0] = identifier
	result[1] = 0x80 | byte(lengthBytes)
	for index := 0; index < lengthBytes; index++ {
		result[1+lengthBytes-index] = byte(length >> (8 * index))
	}
	copy(result[2+lengthBytes:], content)
	return result
}
