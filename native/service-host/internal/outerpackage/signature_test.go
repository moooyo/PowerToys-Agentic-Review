package outerpackage

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/asn1"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"math/big"
	"strings"
	"testing"
)

func TestDetachedP256SignatureVerifiesCanonicalIndex(t *testing.T) {
	index := mustBuildIndex(t, validFinalizedSource(t, "a", "b"))
	_, spki, envelope := signedEnvelopeFixture(t, index)
	if err := VerifyDetachedSignature(index, envelope, spki); err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseSignatureEnvelope(envelope)
	if err != nil {
		t.Fatal(err)
	}
	indexDigest := sha256.Sum256(index)
	if parsed.Algorithm != SignatureAlgorithm || parsed.IndexSHA256 != hex.EncodeToString(indexDigest[:]) ||
		parsed.SchemaVersion != SignatureSchemaVersion {
		t.Fatalf("unexpected signature envelope: %#v", parsed)
	}
}

func TestSignaturePolicyRejectsSchema3MTLSAndLegacyProfile(t *testing.T) {
	index := mustBuildIndex(t, validFinalizedSource(t, "a", "b"))
	tests := []struct {
		name     string
		document []byte
	}{
		{
			name: "schema 3",
			document: bytes.Replace(
				index,
				[]byte(`"schemaVersion":2`),
				[]byte(`"schemaVersion":3`),
				1,
			),
		},
		{
			name: "mTLS field",
			document: bytes.Replace(
				index,
				[]byte(`"nodeSpecificLocalAuthorityPublicKeySpki":`),
				[]byte(`"mtlsClientCredential":{"certificateDerSha256":"`+strings.Repeat("1", 64)+`","certificateStore":"MY","privateKeySecurityDescriptorSha256":"`+strings.Repeat("2", 64)+`"},"nodeSpecificLocalAuthorityPublicKeySpki":`),
				1,
			),
		},
		{
			name: "legacy profile",
			document: bytes.Replace(
				index,
				[]byte(`"profileId":"`+IndexProfileID+`"`),
				[]byte(`"profileId":"agentic-review-worker-outer-package-v1"`),
				1,
			),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := SigningDigest(test.document); err == nil {
				t.Fatal("SigningDigest accepted an unsupported package profile")
			}
			_, spki, envelope := rawSignedEnvelopeFixture(t, test.document)
			if err := VerifyDetachedSignature(test.document, envelope, spki); !errors.Is(err, ErrSignature) {
				t.Fatalf("VerifyDetachedSignature returned %v", err)
			}
		})
	}
}

func TestSignatureEnvelopeRejectsMalleableAndNonP1363Signatures(t *testing.T) {
	index := mustBuildIndex(t, validFinalizedSource(t, "a", "b"))
	_, spki, envelopeDocument := signedEnvelopeFixture(t, index)
	envelope, err := ParseSignatureEnvelope(envelopeDocument)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := base64.RawURLEncoding.DecodeString(envelope.Signature)
	if err != nil {
		t.Fatal(err)
	}
	r := new(big.Int).SetBytes(signature[:32])
	s := new(big.Int).SetBytes(signature[32:])
	order := elliptic.P256().Params().N

	highS := cloneEnvelope(envelope)
	highS.Signature = encodeP1363(r, new(big.Int).Sub(order, s))
	assertEnvelopeRejected(t, index, spki, highS)

	for _, scalar := range []struct {
		name string
		r    *big.Int
		s    *big.Int
	}{
		{name: "zero r", r: new(big.Int), s: s},
		{name: "zero s", r: r, s: new(big.Int)},
		{name: "out-of-range r", r: new(big.Int).Set(order), s: s},
		{name: "out-of-range s", r: r, s: new(big.Int).Set(order)},
	} {
		t.Run(scalar.name, func(t *testing.T) {
			candidate := cloneEnvelope(envelope)
			candidate.Signature = encodeP1363(scalar.r, scalar.s)
			assertEnvelopeRejected(t, index, spki, candidate)
		})
	}

	der, err := asn1.Marshal(struct {
		R *big.Int
		S *big.Int
	}{big.NewInt(1), big.NewInt(1)})
	if err != nil {
		t.Fatal(err)
	}
	derEnvelope := cloneEnvelope(envelope)
	derEnvelope.Signature = base64.RawURLEncoding.EncodeToString(der)
	assertEnvelopeRejected(t, index, spki, derEnvelope)

	padded := cloneEnvelope(envelope)
	padded.Signature += "="
	assertEnvelopeRejected(t, index, spki, padded)

	noncanonicalPadBits := cloneEnvelope(envelope)
	alphabet := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	encoded := []byte(noncanonicalPadBits.Signature)
	last := strings.IndexByte(alphabet, encoded[len(encoded)-1])
	encoded[len(encoded)-1] = alphabet[(last&^3)|((last+1)&3)]
	noncanonicalPadBits.Signature = string(encoded)
	assertEnvelopeRejected(t, index, spki, noncanonicalPadBits)

	negotiated := cloneEnvelope(envelope)
	negotiated.Algorithm = "ecdsa-p384-sha384"
	assertEnvelopeRejected(t, index, spki, negotiated)
}

func TestDetachedSignatureRejectsIndexAndTrustedKeyMixAndMatch(t *testing.T) {
	index := mustBuildIndex(t, validFinalizedSource(t, "a", "b"))
	_, spki, envelope := signedEnvelopeFixture(t, index)
	parsed := mustParseIndex(t, index)
	parsed.Source.Commit = strings.Repeat("c", 40)
	changedIndex, err := MarshalIndexCanonical(parsed)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyDetachedSignature(changedIndex, envelope, spki); !errors.Is(err, ErrSignature) {
		t.Fatalf("changed index returned %v", err)
	}

	otherKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	otherSPKI, err := x509.MarshalPKIXPublicKey(&otherKey.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyDetachedSignature(index, envelope, otherSPKI); !errors.Is(err, ErrSignature) {
		t.Fatalf("wrong P-256 key returned %v", err)
	}

	p384, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	p384SPKI, err := x509.MarshalPKIXPublicKey(&p384.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	envelopeValue, err := ParseSignatureEnvelope(envelope)
	if err != nil {
		t.Fatal(err)
	}
	p384Digest := sha256.Sum256(p384SPKI)
	envelopeValue.SignerKeyID = hex.EncodeToString(p384Digest[:])
	p384Envelope, err := marshalCanonical(envelopeValue, MaximumEnvelopeBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyDetachedSignature(index, p384Envelope, p384SPKI); !errors.Is(err, ErrSignature) {
		t.Fatalf("P-384 SPKI returned %v", err)
	}

	trailingSPKI := append(append([]byte(nil), spki...), 0)
	if err := VerifyDetachedSignature(index, envelope, trailingSPKI); !errors.Is(err, ErrSignature) {
		t.Fatalf("noncanonical SPKI returned %v", err)
	}
}

func TestSignatureEnvelopeRequiresExactCanonicalKeys(t *testing.T) {
	index := mustBuildIndex(t, validFinalizedSource(t, "a", "b"))
	_, _, envelope := signedEnvelopeFixture(t, index)
	for _, candidate := range [][]byte{
		append(append([]byte(nil), envelope...), '\n'),
		[]byte(strings.Replace(string(envelope), `"schemaVersion":1`, `"extra":true,"schemaVersion":1`, 1)),
	} {
		if _, err := ParseSignatureEnvelope(candidate); err == nil {
			t.Fatalf("ParseSignatureEnvelope accepted %q", candidate)
		}
	}
}

func signedEnvelopeFixture(
	t *testing.T,
	index []byte,
) (*ecdsa.PrivateKey, []byte, []byte) {
	t.Helper()
	digest, err := SigningDigest(index)
	if err != nil {
		t.Fatal(err)
	}
	return signedEnvelopeFixtureForDigest(t, index, digest)
}

func rawSignedEnvelopeFixture(
	t *testing.T,
	index []byte,
) (*ecdsa.PrivateKey, []byte, []byte) {
	t.Helper()
	hash := sha256.New()
	_, _ = hash.Write([]byte(signatureDomain))
	_, _ = hash.Write(index)
	var digest [sha256.Size]byte
	copy(digest[:], hash.Sum(nil))
	return signedEnvelopeFixtureForDigest(t, index, digest)
}

func signedEnvelopeFixtureForDigest(
	t *testing.T,
	index []byte,
	digest [sha256.Size]byte,
) (*ecdsa.PrivateKey, []byte, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	spki, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	order := elliptic.P256().Params().N
	halfOrder := new(big.Int).Rsh(new(big.Int).Set(order), 1)
	if s.Cmp(halfOrder) > 0 {
		s = new(big.Int).Sub(order, s)
	}
	indexDigest := sha256.Sum256(index)
	keyDigest := sha256.Sum256(spki)
	envelope, err := MarshalSignatureEnvelopeCanonical(SignatureEnvelope{
		Algorithm:     SignatureAlgorithm,
		IndexSHA256:   hex.EncodeToString(indexDigest[:]),
		SchemaVersion: SignatureSchemaVersion,
		Signature:     encodeP1363(r, s),
		SignerKeyID:   hex.EncodeToString(keyDigest[:]),
	})
	if err != nil {
		t.Fatal(err)
	}
	return key, spki, envelope
}

func assertEnvelopeRejected(
	t *testing.T,
	index []byte,
	spki []byte,
	envelope SignatureEnvelope,
) {
	t.Helper()
	document, err := marshalCanonical(envelope, MaximumEnvelopeBytes)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseSignatureEnvelope(document); !errors.Is(err, ErrSignature) {
		t.Fatalf("ParseSignatureEnvelope returned %v", err)
	}
	if err := VerifyDetachedSignature(index, document, spki); !errors.Is(err, ErrSignature) {
		t.Fatalf("VerifyDetachedSignature returned %v", err)
	}
}

func encodeP1363(r, s *big.Int) string {
	encoded := make([]byte, 64)
	r.FillBytes(encoded[:32])
	s.FillBytes(encoded[32:])
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func cloneEnvelope(value SignatureEnvelope) SignatureEnvelope { return value }
