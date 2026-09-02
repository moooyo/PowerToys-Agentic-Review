package generator

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"strings"
	"testing"
)

func TestRenderIsDeterministicApprovedAndConstantsOnly(t *testing.T) {
	spki := generatorSPKI(t, elliptic.P256())
	digest := sha256.Sum256(spki)
	expected := hex.EncodeToString(digest[:])
	first, err := Render(spki, expected)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Render(spki, expected)
	if err != nil || !bytes.Equal(first, second) {
		t.Fatal("outer trust generator is not deterministic")
	}
	for _, expectedText := range []string{
		"//go:build " + ReleaseBuildTag,
		"compiledOuterSignerSPKIBase64URL",
		"compiledOuterSignerSPKISHA256",
		expected,
	} {
		if !bytes.Contains(first, []byte(expectedText)) {
			t.Fatalf("generated source omits %q", expectedText)
		}
	}
	for _, addition := range []string{
		"\nfunc init() {}\n",
		"\nvar injected = true\n",
		"\ntype injected struct{}\n",
		"\nconst injected = \"value\"\n",
	} {
		candidate := append(append([]byte(nil), first...), addition...)
		if err := Validate(candidate, spki, expected); err == nil {
			t.Fatalf("Validate accepted executable addition %q", strings.TrimSpace(addition))
		}
	}
}

func TestRenderRejectsUnapprovedAndNonP256Inputs(t *testing.T) {
	spki := generatorSPKI(t, elliptic.P256())
	digest := sha256.Sum256(spki)
	p384 := generatorSPKI(t, elliptic.P384())
	for _, test := range []struct {
		name   string
		spki   []byte
		digest string
	}{
		{name: "missing digest", spki: spki},
		{name: "uppercase digest", spki: spki, digest: strings.ToUpper(hex.EncodeToString(digest[:]))},
		{name: "wrong digest", spki: spki, digest: strings.Repeat("f", 64)},
		{name: "P-384", spki: p384, digest: documentDigest(p384)},
		{name: "trailing DER", spki: append(append([]byte(nil), spki...), 0), digest: documentDigest(append(append([]byte(nil), spki...), 0))},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := Render(test.spki, test.digest); err == nil {
				t.Fatal("Render accepted invalid trust input")
			}
		})
	}
}

func generatorSPKI(t *testing.T, curve elliptic.Curve) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(curve, rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	document, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return document
}

func documentDigest(document []byte) string {
	digest := sha256.Sum256(document)
	return hex.EncodeToString(digest[:])
}
