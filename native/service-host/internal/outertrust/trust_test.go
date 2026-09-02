package outertrust

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
)

func TestCompiledTrustRequiresCanonicalApprovedP256SPKI(t *testing.T) {
	spki := testP256SPKI(t)
	digest := sha256.Sum256(spki)
	evidence, err := loadCompiled(
		base64.RawURLEncoding.EncodeToString(spki),
		hex.EncodeToString(digest[:]),
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := evidence.Validate(); err != nil || evidence.SignerKeyID() != hex.EncodeToString(digest[:]) {
		t.Fatalf("compiled evidence is invalid: keyID=%q err=%v", evidence.SignerKeyID(), err)
	}
	evidence.state.spki[0] ^= 0xff
	if !errors.Is(evidence.Validate(), ErrInvalidEvidence) {
		t.Fatal("mutated trust evidence remained valid")
	}
}

func TestCompiledTrustRejectsUnapprovedOrNoncanonicalKeys(t *testing.T) {
	spki := testP256SPKI(t)
	digest := sha256.Sum256(spki)
	encoded := base64.RawURLEncoding.EncodeToString(spki)
	p384, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	p384SPKI, err := x509.MarshalPKIXPublicKey(&p384.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name    string
		encoded string
		digest  string
	}{
		{name: "missing encoded key", digest: hex.EncodeToString(digest[:])},
		{name: "padded base64url", encoded: encoded + "=", digest: hex.EncodeToString(digest[:])},
		{name: "wrong digest", encoded: encoded, digest: strings.Repeat("f", 64)},
		{name: "uppercase digest", encoded: encoded, digest: strings.ToUpper(hex.EncodeToString(digest[:]))},
		{name: "P-384", encoded: base64.RawURLEncoding.EncodeToString(p384SPKI), digest: hexDigest(p384SPKI)},
		{name: "trailing DER", encoded: base64.RawURLEncoding.EncodeToString(append(append([]byte(nil), spki...), 0)), digest: hexDigest(append(append([]byte(nil), spki...), 0))},
	} {
		t.Run(test.name, func(t *testing.T) {
			if evidence, err := loadCompiled(test.encoded, test.digest); !errors.Is(err, ErrInvalid) || evidence.state != nil {
				t.Fatalf("loadCompiled returned evidence=%#v err=%v", evidence, err)
			}
		})
	}
}

func testP256SPKI(t *testing.T) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	document, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return document
}

func hexDigest(document []byte) string {
	digest := sha256.Sum256(document)
	return hex.EncodeToString(digest[:])
}
