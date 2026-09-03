package serverbindingauthorityv1

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"math/big"
	"testing"
	"time"
)

func TestOrdinaryVerificationAcceptsExactP256P1363LowS(t *testing.T) {
	authority := newTestAuthority(t, time.Date(2026, 9, 3, 0, 0, 1, 0, time.UTC))
	if len(authority.spki) != canonicalP256SPKIBytes || ValidateIssuerSPKI(authority.spki) != nil {
		t.Fatal("generated P-256 SPKI did not have the canonical 91-byte form")
	}
	keyID, err := DeriveIssuerKeyID(authority.spki)
	if err != nil || keyID != mustIssuerKeyID(t, authority.spki) {
		t.Fatalf("issuer key ID = (%s, %v)", keyID, err)
	}
	receipt, receiptDocument := signReceipt(t, authority.private, authority.spki, testReceiptStatement())
	verifiedReceipt, err := VerifyReceiptWithSPKI(receiptDocument, authority.spki)
	if err != nil || verifiedReceipt != receipt {
		t.Fatalf("receipt verification = (%#v, %v)", verifiedReceipt, err)
	}

	nonce := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0xab}, 32))
	status, statusDocument := signActiveStatus(t, authority.private, authority.spki, testActiveStatusStatement(
		nonce, authority.clock.Now(), authority.clock.Now().Add(45*time.Second),
	))
	verifiedStatus, err := VerifyActiveStatusWithSPKI(statusDocument, authority.spki)
	if err != nil || verifiedStatus != status {
		t.Fatalf("active-status verification = (%#v, %v)", verifiedStatus, err)
	}
}

func TestOrdinaryVerificationRejectsWrongKeyIDKeyAndSignedMutation(t *testing.T) {
	authority := newTestAuthority(t, time.Date(2026, 9, 3, 0, 0, 1, 0, time.UTC))
	other := newTestAuthority(t, authority.clock.Now())
	receipt, document := signReceipt(t, authority.private, authority.spki, testReceiptStatement())
	if _, err := VerifyReceiptWithSPKI(document, other.spki); err == nil {
		t.Fatal("receipt verified with a different P-256 key")
	}
	receipt.IssuerKeyID = repeatHex("f")
	wrongKeyIDDocument, err := MarshalReceiptCanonical(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyReceiptWithSPKI(wrongKeyIDDocument, authority.spki); err == nil {
		t.Fatal("receipt verified with a mismatched key ID")
	}
	receipt.IssuerKeyID = mustIssuerKeyID(t, authority.spki)
	receipt.Statement.WorkerNodeID = "worker-other"
	mutatedDocument, err := MarshalReceiptCanonical(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyReceiptWithSPKI(mutatedDocument, authority.spki); err == nil {
		t.Fatal("receipt verified after signed tuple mutation")
	}
}

func TestSignatureShapeRejectsMalleabilityAndAlternateEncoding(t *testing.T) {
	authority := newTestAuthority(t, time.Date(2026, 9, 3, 0, 0, 1, 0, time.UTC))
	receipt, document := signReceipt(t, authority.private, authority.spki, testReceiptStatement())
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(receipt.Signature)
	if err != nil {
		t.Fatal(err)
	}
	order := elliptic.P256().Params().N
	lowS := new(big.Int).SetBytes(decoded[32:])
	highS := new(big.Int).Sub(order, lowS)
	highBytes := append([]byte(nil), decoded...)
	highS.FillBytes(highBytes[32:])
	zeroR := append([]byte(nil), decoded...)
	clear(zeroR[:32])
	outOfRange := make([]byte, 64)
	order.FillBytes(outOfRange[:32])
	outOfRange[63] = 1
	for name, signature := range map[string]string{
		"padded":                receipt.Signature + "=",
		"noncanonical-pad-bits": mutateUnusedSignatureBits(t, receipt.Signature),
		"zero-r":                base64.RawURLEncoding.EncodeToString(zeroR),
		"out-of-range":          base64.RawURLEncoding.EncodeToString(outOfRange),
		"high-s":                base64.RawURLEncoding.EncodeToString(highBytes),
		"DER":                   base64.RawURLEncoding.EncodeToString([]byte{0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01}),
	} {
		candidate := bytes.Replace(document, []byte(receipt.Signature), []byte(signature), 1)
		if _, err := ParseReceipt(candidate); err == nil {
			t.Errorf("%s signature was accepted", name)
		}
	}
}

func mutateUnusedSignatureBits(t *testing.T, value string) string {
	t.Helper()
	aliases := map[byte]byte{'A': 'B', 'Q': 'R', 'g': 'h', 'w': 'x'}
	last := value[len(value)-1]
	replacement, ok := aliases[last]
	if !ok {
		t.Fatalf("signature ended with unexpected canonical base64url character %q", last)
	}
	return value[:len(value)-1] + string(replacement)
}

func TestVerificationRejectsDoubleHashedPrehash(t *testing.T) {
	authority := newTestAuthority(t, time.Date(2026, 9, 3, 0, 0, 1, 0, time.UTC))
	statement := testReceiptStatement()
	digest, err := ReceiptSigningDigest(statement)
	if err != nil {
		t.Fatal(err)
	}
	doubleHash := sha256.Sum256(digest[:])
	value := ServerBindingReceiptV1{
		Algorithm:     SignatureAlgorithm,
		Issuer:        Issuer,
		IssuerKeyID:   mustIssuerKeyID(t, authority.spki),
		ProfileID:     ReceiptProfileID,
		SchemaVersion: SchemaVersion,
		Signature:     signP1363LowS(t, authority.private, doubleHash),
		Statement:     statement,
	}
	document, err := MarshalReceiptCanonical(value)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyReceiptWithSPKI(document, authority.spki); err == nil {
		t.Fatal("receipt accepted a signature over the double-hashed prehash")
	}
}

func TestActiveStatusSignatureBindsEveryFreshnessAndTupleField(t *testing.T) {
	authority := newTestAuthority(t, time.Date(2026, 9, 3, 0, 0, 1, 0, time.UTC))
	nonce := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0xab}, 32))
	status, _ := signActiveStatus(t, authority.private, authority.spki, testActiveStatusStatement(
		nonce,
		time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC),
		time.Date(2026, 9, 3, 0, 0, 45, 0, time.UTC),
	))
	mutations := []func(*ServerBindingActiveStatusStatementV1){
		func(value *ServerBindingActiveStatusStatementV1) {
			value.BindingID = "b8f7033b-d65c-4f70-8d37-83c8b1b3706d"
		},
		func(value *ServerBindingActiveStatusStatementV1) { value.CertificateDERSHA256 = repeatHex("b") },
		func(value *ServerBindingActiveStatusStatementV1) {
			value.ChallengeNonceBase64URL = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0xcd}, 32))
		},
		func(value *ServerBindingActiveStatusStatementV1) { value.ExpiresAt = "2026-09-03T00:00:44.000Z" },
		func(value *ServerBindingActiveStatusStatementV1) { value.InstallationID = "installation-node-002" },
		func(value *ServerBindingActiveStatusStatementV1) { value.IssuedAt = "2026-09-03T00:00:01.000Z" },
		func(value *ServerBindingActiveStatusStatementV1) { value.ReceiptSHA256 = repeatHex("e") },
		func(value *ServerBindingActiveStatusStatementV1) { value.RecordDocumentSHA256 = repeatHex("f") },
		func(value *ServerBindingActiveStatusStatementV1) { value.WorkerNodeID = "worker-other" },
	}
	for index, mutate := range mutations {
		candidate := status
		mutate(&candidate.Statement)
		document, err := MarshalActiveStatusCanonical(candidate)
		if err != nil {
			t.Fatalf("mutation %d was not structurally valid: %v", index, err)
		}
		if _, err := VerifyActiveStatusWithSPKI(document, authority.spki); err == nil {
			t.Errorf("active-status signed field mutation %d was accepted", index)
		}
	}
}

func TestIssuerSPKIRejectsCompressedNoncanonicalAndOtherCurves(t *testing.T) {
	authority := newTestAuthority(t, time.Date(2026, 9, 3, 0, 0, 1, 0, time.UTC))
	compressedPrefix, err := hex.DecodeString(
		"3039301306072a8648ce3d020106082a8648ce3d030107032200",
	)
	if err != nil {
		t.Fatal(err)
	}
	compressed := append(compressedPrefix, elliptic.MarshalCompressed(
		elliptic.P256(), authority.private.PublicKey.X, authority.private.PublicKey.Y,
	)...)
	p384, err := ecdsa.GenerateKey(elliptic.P384(), cryptorand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	p384SPKI, err := x509.MarshalPKIXPublicKey(&p384.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	for name, candidate := range map[string][]byte{
		"compressed":    compressed,
		"trailing-byte": append(append([]byte(nil), authority.spki...), 0),
		"P-384":         p384SPKI,
		"empty":         nil,
	} {
		if err := ValidateIssuerSPKI(candidate); err == nil {
			t.Errorf("%s issuer SPKI was accepted", name)
		}
		if _, err := DeriveIssuerKeyID(candidate); err == nil {
			t.Errorf("%s issuer SPKI produced a key ID", name)
		}
	}
}
