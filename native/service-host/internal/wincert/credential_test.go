package wincert

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"math/big"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	testControlServiceSID  = "S-1-5-80-1-2-3-4-5"
	testExecutorServiceSID = "S-1-5-80-6-7-8-9-10"
)

func TestConfigAcceptsOnlyCanonicalLocalMachineMYDigest(t *testing.T) {
	raw := sha256.Sum256([]byte("certificate"))
	config := Config{
		StoreName:                           LocalMachinePersonalStore,
		CertificateSHA256:                   hex.EncodeToString(raw[:]),
		ExpectedKeySecurityDescriptorSHA256: hex.EncodeToString(raw[:]),
		ControlServiceSID:                   testControlServiceSID,
		ExecutorServiceSID:                  testExecutorServiceSID,
	}
	digest, err := validateConfig(config)
	if err != nil {
		t.Fatalf("validateConfig returned an error: %v", err)
	}
	if digest != raw {
		t.Fatalf("validateConfig returned %x instead of %x", digest, raw)
	}

	tests := []Config{
		{},
		{StoreName: "my", CertificateSHA256: config.CertificateSHA256},
		{StoreName: "ROOT", CertificateSHA256: config.CertificateSHA256},
		func() Config { value := config; value.CertificateSHA256 = value.CertificateSHA256[:63]; return value }(),
		func() Config {
			value := config
			value.CertificateSHA256 = "A" + value.CertificateSHA256[1:]
			return value
		}(),
		func() Config {
			value := config
			value.ExpectedKeySecurityDescriptorSHA256 = "g" + value.ExpectedKeySecurityDescriptorSHA256[1:]
			return value
		}(),
		func() Config { value := config; value.ControlServiceSID = "S-1-5-18"; return value }(),
		func() Config { value := config; value.ExecutorServiceSID = value.ControlServiceSID; return value }(),
	}
	for _, invalid := range tests {
		if _, err := validateConfig(invalid); !errors.Is(err, ErrInvalidConfiguration) {
			t.Fatalf("validateConfig accepted %#v: %v", invalid, err)
		}
	}
}

func TestCertificateProviderInfoRequiresFixedMachineCNGProvider(t *testing.T) {
	valid := certificateProviderInfo{
		containerName: "machine-key",
		providerName:  approvedKeyStorageProvider,
		flags:         cryptMachineKeysetFlag,
		keySpec:       cngProviderKeySpec,
	}
	if err := validateCertificateProviderInfo(valid); err != nil {
		t.Fatalf("validateCertificateProviderInfo rejected valid information: %v", err)
	}
	tests := []struct {
		name   string
		mutate func(*certificateProviderInfo)
	}{
		{name: "container", mutate: func(value *certificateProviderInfo) { value.containerName = "" }},
		{name: "provider", mutate: func(value *certificateProviderInfo) { value.providerName = "Other KSP" }},
		{name: "legacy type", mutate: func(value *certificateProviderInfo) { value.providerType = 24 }},
		{name: "user key", mutate: func(value *certificateProviderInfo) { value.flags = 0 }},
		{name: "extra flag", mutate: func(value *certificateProviderInfo) { value.flags |= 1 }},
		{name: "parameters", mutate: func(value *certificateProviderInfo) { value.parameterCount = 1; value.hasProviderParameters = true }},
		{name: "legacy key spec", mutate: func(value *certificateProviderInfo) { value.keySpec = 2 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := valid
			test.mutate(&candidate)
			if err := validateCertificateProviderInfo(candidate); !errors.Is(err, ErrInvalidProviderInfo) {
				t.Fatalf("expected ErrInvalidProviderInfo, got %v", err)
			}
		})
	}
}

func TestKeySecurityEvidenceRequiresPinnedProtectedThreeTrusteeDACL(t *testing.T) {
	evidence := validTestKeySecurityEvidence()
	digest := sha256.Sum256(evidence.raw)
	expectedDigest := hex.EncodeToString(digest[:])
	if err := validateKeySecurityEvidence(
		evidence,
		expectedDigest,
		testControlServiceSID,
		testExecutorServiceSID,
	); err != nil {
		t.Fatalf("validateKeySecurityEvidence rejected valid evidence: %v", err)
	}
	tests := []struct {
		name   string
		mutate func(*keySecurityEvidence)
	}{
		{name: "digest", mutate: func(value *keySecurityEvidence) { value.raw[0] ^= 0xff }},
		{name: "unprotected", mutate: func(value *keySecurityEvidence) { value.control &^= securityDACLProtected }},
		{name: "defaulted control", mutate: func(value *keySecurityEvidence) { value.control |= securityDACLDefaulted }},
		{name: "defaulted DACL", mutate: func(value *keySecurityEvidence) { value.daclDefaulted = true }},
		{name: "null DACL", mutate: func(value *keySecurityEvidence) { value.daclNull = true }},
		{name: "owner", mutate: func(value *keySecurityEvidence) { value.ownerSID = testControlServiceSID }},
		{name: "owner defaulted", mutate: func(value *keySecurityEvidence) { value.ownerDefaulted = true }},
		{name: "executor", mutate: func(value *keySecurityEvidence) { value.entries[2].sid = testExecutorServiceSID }},
		{name: "broad trustee", mutate: func(value *keySecurityEvidence) { value.entries[2].sid = "S-1-1-0" }},
		{name: "duplicate", mutate: func(value *keySecurityEvidence) { value.entries[2].sid = systemSID }},
		{name: "deny ACE", mutate: func(value *keySecurityEvidence) { value.entries[2].aceType = 1 }},
		{name: "inherited ACE", mutate: func(value *keySecurityEvidence) { value.entries[2].flags = 0x10 }},
		{name: "zero mask", mutate: func(value *keySecurityEvidence) { value.entries[2].mask = 0 }},
		{name: "control changes DACL", mutate: func(value *keySecurityEvidence) { value.entries[2].mask |= writeDACLAccess }},
		{name: "recovery lacks control", mutate: func(value *keySecurityEvidence) { value.entries[0].mask = genericReadAccess }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := evidence
			candidate.raw = bytes.Clone(evidence.raw)
			candidate.entries = append([]keySecurityACE(nil), evidence.entries...)
			test.mutate(&candidate)
			if err := validateKeySecurityEvidence(candidate, expectedDigest, testControlServiceSID, testExecutorServiceSID); !errors.Is(err, ErrInvalidKeySecurity) {
				t.Fatalf("expected ErrInvalidKeySecurity, got %v", err)
			}
		})
	}
}

func TestParseKeySecurityDescriptorUsesBoundedCanonicalOffsets(t *testing.T) {
	raw := encodeTestKeySecurityDescriptor(
		systemSID,
		[]keySecurityACE{
			{sid: systemSID, mask: genericAllAccess, aceType: accessAllowedACEType},
			{sid: administratorsSID, mask: genericAllAccess, aceType: accessAllowedACEType},
			{sid: testControlServiceSID, mask: genericReadAccess, aceType: accessAllowedACEType},
		},
	)
	evidence, err := parseKeySecurityDescriptor(raw)
	if err != nil {
		t.Fatalf("parseKeySecurityDescriptor returned an error: %v", err)
	}
	digest := sha256.Sum256(raw)
	if err := validateKeySecurityEvidence(
		evidence,
		hex.EncodeToString(digest[:]),
		testControlServiceSID,
		testExecutorServiceSID,
	); err != nil {
		t.Fatalf("validateKeySecurityEvidence rejected parsed descriptor: %v", err)
	}
	evidence.raw[0] ^= 0xff
	if raw[0] != 1 {
		t.Fatal("parsed security evidence aliases the native descriptor")
	}

	invalid := [][]byte{
		nil,
		func() []byte { value := bytes.Clone(raw); value[0] = 2; return value }(),
		func() []byte {
			value := bytes.Clone(raw)
			binary.LittleEndian.PutUint32(value[4:8], uint32(len(value)+1))
			return value
		}(),
		func() []byte {
			value := bytes.Clone(raw)
			binary.LittleEndian.PutUint32(value[16:20], uint32(len(value)+1))
			return value
		}(),
	}
	for _, value := range invalid {
		if _, err := parseKeySecurityDescriptor(value); !errors.Is(err, ErrInvalidKeySecurity) {
			t.Fatalf("expected ErrInvalidKeySecurity for malformed descriptor, got %v", err)
		}
	}
}

func validTestKeySecurityEvidence() keySecurityEvidence {
	return keySecurityEvidence{
		raw:         bytes.Repeat([]byte{0x5a}, 32),
		control:     securityDACLPresent | securityDACLProtected | securityDescriptorSelfRelative,
		ownerSID:    systemSID,
		daclPresent: true,
		entries: []keySecurityACE{
			{sid: systemSID, mask: genericAllAccess, aceType: accessAllowedACEType},
			{sid: administratorsSID, mask: genericAllAccess, aceType: accessAllowedACEType},
			{sid: testControlServiceSID, mask: genericReadAccess, aceType: accessAllowedACEType},
		},
	}
}

func TestCertificateDigestMatchesExactDER(t *testing.T) {
	der := []byte{1, 2, 3, 4}
	digest := sha256.Sum256(der)
	if !certificateDigestMatches(digest, der) {
		t.Fatal("certificateDigestMatches rejected the exact DER digest")
	}
	changed := bytes.Clone(der)
	changed[0] ^= 0xff
	if certificateDigestMatches(digest, changed) {
		t.Fatal("certificateDigestMatches accepted different DER")
	}
}

func TestP256KeyPropertiesRequireNonExportableSigningOnlyKey(t *testing.T) {
	valid := keyProperties{
		algorithm:    "ECDSA_P256",
		length:       256,
		exportPolicy: 0,
		keyUsage:     ncryptAllowSigningFlag,
	}
	if err := validateP256SigningProperties(valid); err != nil {
		t.Fatalf("validateP256SigningProperties rejected the valid policy: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*keyProperties)
	}{
		{name: "algorithm", mutate: func(value *keyProperties) { value.algorithm = "ECDSA" }},
		{name: "length", mutate: func(value *keyProperties) { value.length = 384 }},
		{name: "export policy", mutate: func(value *keyProperties) { value.exportPolicy = 1 }},
		{name: "no usage", mutate: func(value *keyProperties) { value.keyUsage = 0 }},
		{name: "extra usage", mutate: func(value *keyProperties) { value.keyUsage |= 1 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			properties := valid
			test.mutate(&properties)
			if err := validateP256SigningProperties(properties); !errors.Is(err, ErrInvalidKey) {
				t.Fatalf("expected ErrInvalidKey, got %v", err)
			}
		})
	}
}

func TestParseKeyPropertiesRejectsMalformedNativeValues(t *testing.T) {
	properties, err := parseKeyProperties(
		encodeUTF16Property("ECDSA_P256"),
		encodeUint32Property(256),
		encodeUint32Property(0),
		encodeUint32Property(ncryptAllowSigningFlag),
	)
	if err != nil {
		t.Fatalf("parseKeyProperties returned an error: %v", err)
	}
	if err := validateP256SigningProperties(properties); err != nil {
		t.Fatalf("parsed properties failed validation: %v", err)
	}

	malformed := []struct {
		name      string
		algorithm []byte
		length    []byte
		export    []byte
		keyUsage  []byte
	}{
		{name: "algorithm", algorithm: []byte{'E', 0}, length: encodeUint32Property(256), export: encodeUint32Property(0), keyUsage: encodeUint32Property(2)},
		{name: "length", algorithm: encodeUTF16Property("ECDSA_P256"), length: []byte{0, 1, 2}, export: encodeUint32Property(0), keyUsage: encodeUint32Property(2)},
		{name: "export", algorithm: encodeUTF16Property("ECDSA_P256"), length: encodeUint32Property(256), export: nil, keyUsage: encodeUint32Property(2)},
		{name: "usage", algorithm: encodeUTF16Property("ECDSA_P256"), length: encodeUint32Property(256), export: encodeUint32Property(0), keyUsage: make([]byte, 5)},
	}
	for _, test := range malformed {
		t.Run(test.name, func(t *testing.T) {
			if _, err := parseKeyProperties(test.algorithm, test.length, test.export, test.keyUsage); err == nil {
				t.Fatal("parseKeyProperties accepted malformed input")
			}
		})
	}
}

func TestParseP256PublicBlob(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate P-256 key: %v", err)
	}
	blob := encodeP256PublicBlob(&key.PublicKey)
	publicKey, err := parseP256PublicBlob(blob)
	if err != nil {
		t.Fatalf("parseP256PublicBlob returned an error: %v", err)
	}
	if publicKey.X.Cmp(key.X) != 0 || publicKey.Y.Cmp(key.Y) != 0 {
		t.Fatal("parseP256PublicBlob returned the wrong public key")
	}

	tests := [][]byte{
		nil,
		blob[:len(blob)-1],
		append(bytes.Clone(blob), 0),
		func() []byte { value := bytes.Clone(blob); binary.LittleEndian.PutUint32(value[:4], 0); return value }(),
		func() []byte { value := bytes.Clone(blob); binary.LittleEndian.PutUint32(value[4:8], 48); return value }(),
		func() []byte { value := bytes.Clone(blob); clear(value[8:]); return value }(),
	}
	for _, invalid := range tests {
		if _, err := parseP256PublicBlob(invalid); !errors.Is(err, ErrInvalidKey) {
			t.Fatalf("expected ErrInvalidKey for %x, got %v", invalid, err)
		}
	}
}

func TestP256SignatureToASN1NormalizesHighS(t *testing.T) {
	n := elliptic.P256().Params().N
	one := big.NewInt(1)
	highS := new(big.Int).Sub(new(big.Int).Set(n), one)
	raw := append(fixedWidthScalar(one), fixedWidthScalar(highS)...)
	encoded, err := p256SignatureToASN1(raw)
	if err != nil {
		t.Fatalf("p256SignatureToASN1 returned an error: %v", err)
	}
	var signature ecdsaASN1Signature
	rest, err := asn1.Unmarshal(encoded, &signature)
	if err != nil || len(rest) != 0 {
		t.Fatalf("decode ASN.1 signature: rest=%x err=%v", rest, err)
	}
	if signature.R.Cmp(one) != 0 || signature.S.Cmp(one) != 0 {
		t.Fatalf("signature was not normalized to (1, 1): R=%s S=%s", signature.R, signature.S)
	}
}

func TestP256SignatureToASN1RejectsInvalidScalars(t *testing.T) {
	n := elliptic.P256().Params().N
	one := fixedWidthScalar(big.NewInt(1))
	zero := make([]byte, p256DigestBytes)
	order := fixedWidthScalar(n)
	tests := [][]byte{
		nil,
		make([]byte, p256SignatureBytes-1),
		make([]byte, p256SignatureBytes+1),
		append(bytes.Clone(zero), one...),
		append(bytes.Clone(order), one...),
		append(bytes.Clone(one), zero...),
		append(bytes.Clone(one), order...),
	}
	for _, invalid := range tests {
		if _, err := p256SignatureToASN1(invalid); !errors.Is(err, ErrInvalidSignature) {
			t.Fatalf("expected ErrInvalidSignature, got %v", err)
		}
	}
}

func TestPrepareTLSCertificateCopiesChainAndOmitsRoot(t *testing.T) {
	chain, leafKey := testCertificateChain(t)
	certificate, publicKey, err := prepareTLSCertificate(chain, chain[0])
	if err != nil {
		t.Fatalf("prepareTLSCertificate returned an error: %v", err)
	}
	if len(certificate.Certificate) != 2 {
		t.Fatalf("certificate chain has %d entries instead of leaf and intermediate", len(certificate.Certificate))
	}
	if certificate.Leaf == nil || certificate.Leaf.IsCA {
		t.Fatal("certificate leaf was not parsed")
	}
	if publicKey.X.Cmp(leafKey.X) != 0 || publicKey.Y.Cmp(leafKey.Y) != 0 {
		t.Fatal("prepareTLSCertificate returned the wrong public key")
	}
	if len(certificate.SupportedSignatureAlgorithms) != 1 ||
		certificate.SupportedSignatureAlgorithms[0] != tls.ECDSAWithP256AndSHA256 {
		t.Fatalf("unexpected signature schemes: %v", certificate.SupportedSignatureAlgorithms)
	}

	originalLeafByte := certificate.Certificate[0][0]
	chain[0][0] ^= 0xff
	if certificate.Certificate[0][0] != originalLeafByte {
		t.Fatal("certificate chain aliases native DER")
	}
	cloned := cloneTLSCertificate(certificate, nil)
	cloned.Certificate[0][0] ^= 0xff
	cloned.Leaf.Raw[0] ^= 0xff
	if certificate.Certificate[0][0] != originalLeafByte || certificate.Leaf.Raw[0] != originalLeafByte {
		t.Fatal("cloneTLSCertificate returned aliased certificate data")
	}
}

func TestPrepareTLSCertificateRejectsWrongLeafAndBrokenChain(t *testing.T) {
	chain, _ := testCertificateChain(t)
	if _, _, err := prepareTLSCertificate(chain, chain[1]); !errors.Is(err, ErrInvalidCertificate) {
		t.Fatalf("expected ErrInvalidCertificate for a different selected leaf, got %v", err)
	}
	broken := [][]byte{bytes.Clone(chain[0]), bytes.Clone(chain[2])}
	if _, _, err := prepareTLSCertificate(broken, broken[0]); !errors.Is(err, ErrInvalidCertificate) {
		t.Fatalf("expected ErrInvalidCertificate for a broken chain, got %v", err)
	}
}

func TestClientLeafPolicyRequiresCurrentEndEntitySigningClientCertificate(t *testing.T) {
	chain, _ := testCertificateChain(t)
	leaf, err := x509.ParseCertificate(chain[0])
	if err != nil {
		t.Fatalf("parse leaf certificate: %v", err)
	}
	currentTime := leaf.NotBefore.Add(time.Minute)
	if err := validateClientLeaf(leaf, currentTime); err != nil {
		t.Fatalf("validateClientLeaf rejected the valid leaf: %v", err)
	}
	tests := []struct {
		name   string
		mutate func(*x509.Certificate)
	}{
		{name: "CA", mutate: func(value *x509.Certificate) { value.IsCA = true }},
		{name: "not yet valid", mutate: func(value *x509.Certificate) { value.NotBefore = currentTime.Add(time.Minute) }},
		{name: "expired", mutate: func(value *x509.Certificate) { value.NotAfter = currentTime.Add(-time.Minute) }},
		{name: "no digital signature", mutate: func(value *x509.Certificate) { value.KeyUsage = x509.KeyUsageKeyEncipherment }},
		{name: "no client auth", mutate: func(value *x509.Certificate) { value.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth} }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := *leaf
			test.mutate(&candidate)
			if err := validateClientLeaf(&candidate, currentTime); !errors.Is(err, ErrInvalidCertificate) {
				t.Fatalf("expected ErrInvalidCertificate, got %v", err)
			}
		})
	}
}

func TestCertificateChainPolicyValidatesEveryIssuerWithoutSystemTrust(t *testing.T) {
	encoded, _ := testCertificateChain(t)
	chain := parseTestCertificateChain(t, encoded)
	currentTime := chain[0].NotBefore.Add(time.Minute)
	if err := validateCertificateChain(chain, currentTime); err != nil {
		t.Fatalf("validateCertificateChain rejected the valid detached chain: %v", err)
	}

	tests := []struct {
		name   string
		mutate func([]*x509.Certificate)
	}{
		{name: "expired intermediate", mutate: func(value []*x509.Certificate) { value[1].NotAfter = currentTime.Add(-time.Minute) }},
		{name: "issuer is not CA", mutate: func(value []*x509.Certificate) { value[1].IsCA = false }},
		{name: "missing basic constraints", mutate: func(value []*x509.Certificate) { value[1].BasicConstraintsValid = false }},
		{name: "missing CertSign", mutate: func(value []*x509.Certificate) { value[1].KeyUsage = x509.KeyUsageDigitalSignature }},
		{name: "unknown critical extension", mutate: func(value []*x509.Certificate) {
			value[1].UnhandledCriticalExtensions = []asn1.ObjectIdentifier{{1, 2, 3, 4}}
		}},
		{name: "broken leaf signature", mutate: func(value []*x509.Certificate) {
			value[0].Signature = bytes.Clone(value[0].Signature)
			value[0].Signature[0] ^= 0xff
		}},
		{name: "chain without self-signed root", mutate: func(value []*x509.Certificate) {
			value[2].RawIssuer = bytes.Clone(value[2].RawIssuer)
			value[2].RawIssuer[0] ^= 0xff
		}},
		{name: "path length", mutate: func(value []*x509.Certificate) {
			value[2].MaxPathLen = 0
			value[2].MaxPathLenZero = true
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := parseTestCertificateChain(t, encoded)
			test.mutate(candidate)
			if err := validateCertificateChain(candidate, currentTime); !errors.Is(err, ErrInvalidCertificate) {
				t.Fatalf("expected ErrInvalidCertificate, got %v", err)
			}
		})
	}
}

func parseTestCertificateChain(t *testing.T, encoded [][]byte) []*x509.Certificate {
	t.Helper()
	result := make([]*x509.Certificate, len(encoded))
	for index, der := range encoded {
		certificate, err := x509.ParseCertificate(bytes.Clone(der))
		if err != nil {
			t.Fatalf("parse chain certificate %d: %v", index, err)
		}
		result[index] = certificate
	}
	return result
}

func encodeUTF16Property(value string) []byte {
	encoded := make([]byte, 2*(len(value)+1))
	for index, character := range []byte(value) {
		binary.LittleEndian.PutUint16(encoded[index*2:], uint16(character))
	}
	return encoded
}

func encodeUint32Property(value uint32) []byte {
	encoded := make([]byte, 4)
	binary.LittleEndian.PutUint32(encoded, value)
	return encoded
}

func encodeP256PublicBlob(key *ecdsa.PublicKey) []byte {
	value := make([]byte, 8+2*p256DigestBytes)
	binary.LittleEndian.PutUint32(value[:4], ecdsaPublicP256Magic)
	binary.LittleEndian.PutUint32(value[4:8], p256DigestBytes)
	key.X.FillBytes(value[8 : 8+p256DigestBytes])
	key.Y.FillBytes(value[8+p256DigestBytes:])
	return value
}

func fixedWidthScalar(value *big.Int) []byte {
	result := make([]byte, p256DigestBytes)
	value.FillBytes(result)
	return result
}

func testCertificateChain(t *testing.T) ([][]byte, *ecdsa.PrivateKey) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Second)
	rootKey := generateTestKey(t)
	intermediateKey := generateTestKey(t)
	leafKey := generateTestKey(t)

	rootTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Test Root"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	rootDER, err := x509.CreateCertificate(rand.Reader, rootTemplate, rootTemplate, &rootKey.PublicKey, rootKey)
	if err != nil {
		t.Fatalf("create root certificate: %v", err)
	}
	rootCertificate, err := x509.ParseCertificate(rootDER)
	if err != nil {
		t.Fatalf("parse root certificate: %v", err)
	}

	intermediateTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(2),
		Subject:               pkix.Name{CommonName: "Test Intermediate"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(12 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	intermediateDER, err := x509.CreateCertificate(
		rand.Reader,
		intermediateTemplate,
		rootCertificate,
		&intermediateKey.PublicKey,
		rootKey,
	)
	if err != nil {
		t.Fatalf("create intermediate certificate: %v", err)
	}
	intermediateCertificate, err := x509.ParseCertificate(intermediateDER)
	if err != nil {
		t.Fatalf("parse intermediate certificate: %v", err)
	}

	leafTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(3),
		Subject:      pkix.Name{CommonName: "Test Client"},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(6 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	leafDER, err := x509.CreateCertificate(
		rand.Reader,
		leafTemplate,
		intermediateCertificate,
		&leafKey.PublicKey,
		intermediateKey,
	)
	if err != nil {
		t.Fatalf("create leaf certificate: %v", err)
	}
	return [][]byte{leafDER, intermediateDER, rootDER}, leafKey
}

func generateTestKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate P-256 key: %v", err)
	}
	return key
}

func encodeTestKeySecurityDescriptor(owner string, entries []keySecurityACE) []byte {
	ownerBytes := encodeTestSID(owner)
	daclBytes := encodeTestDACL(entries)
	value := make([]byte, 20+len(ownerBytes)+len(daclBytes))
	value[0] = 1
	binary.LittleEndian.PutUint16(
		value[2:4],
		securityDACLPresent|securityDACLProtected|securityDescriptorSelfRelative,
	)
	binary.LittleEndian.PutUint32(value[4:8], 20)
	binary.LittleEndian.PutUint32(value[16:20], uint32(20+len(ownerBytes)))
	copy(value[20:], ownerBytes)
	copy(value[20+len(ownerBytes):], daclBytes)
	return value
}

func encodeTestDACL(entries []keySecurityACE) []byte {
	aces := make([][]byte, len(entries))
	total := 8
	for index, entry := range entries {
		sid := encodeTestSID(entry.sid)
		ace := make([]byte, 8+len(sid))
		ace[0] = entry.aceType
		ace[1] = entry.flags
		binary.LittleEndian.PutUint16(ace[2:4], uint16(len(ace)))
		binary.LittleEndian.PutUint32(ace[4:8], entry.mask)
		copy(ace[8:], sid)
		aces[index] = ace
		total += len(ace)
	}
	value := make([]byte, total)
	value[0] = aclRevision
	binary.LittleEndian.PutUint16(value[2:4], uint16(total))
	binary.LittleEndian.PutUint16(value[4:6], uint16(len(entries)))
	offset := 8
	for _, ace := range aces {
		copy(value[offset:], ace)
		offset += len(ace)
	}
	return value
}

func encodeTestSID(value string) []byte {
	parts := strings.Split(value, "-")
	authority, _ := strconv.ParseUint(parts[2], 10, 48)
	result := make([]byte, 8+4*(len(parts)-3))
	result[0] = 1
	result[1] = byte(len(parts) - 3)
	for index := 0; index < 6; index++ {
		result[7-index] = byte(authority)
		authority >>= 8
	}
	for index, part := range parts[3:] {
		subauthority, _ := strconv.ParseUint(part, 10, 32)
		binary.LittleEndian.PutUint32(result[8+index*4:], uint32(subauthority))
	}
	return result
}
