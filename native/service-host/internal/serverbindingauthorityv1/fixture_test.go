package serverbindingauthorityv1

import (
	"bytes"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

const (
	sharedFixtureIssuerSPKIBase64URL = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-v0lYTgE9BSFUPfyWOB4VptiDOX8QBdKpB90P_41slWTae5OaPqAyns6GVm8aAeOrfR09_g6AhFGmgT1LCM_nA"
	sharedFixtureIssuerKeyID         = "e28eb43c3d5c64b80fe4f26d45e801d1cf45601cbc095fdab74689e760129930"
)

func TestSharedGoldenReceiptAndActiveStatus(t *testing.T) {
	lines := sharedGoldenLines(t)
	spki, err := base64.RawURLEncoding.Strict().DecodeString(sharedFixtureIssuerSPKIBase64URL)
	if err != nil || base64.RawURLEncoding.EncodeToString(spki) != sharedFixtureIssuerSPKIBase64URL {
		t.Fatalf("decode shared fixture SPKI: %v", err)
	}
	if keyID, err := DeriveIssuerKeyID(spki); err != nil || keyID != sharedFixtureIssuerKeyID {
		t.Fatalf("shared fixture key ID = (%s, %v)", keyID, err)
	}
	receipt, err := VerifyReceiptWithSPKI(lines[0], spki)
	if err != nil {
		t.Fatalf("verify shared receipt: %v", err)
	}
	if receipt.IssuerKeyID != sharedFixtureIssuerKeyID ||
		receipt.Statement.BindingID != "a8f7033b-d65c-4f70-8d37-83c8b1b3706d" ||
		receipt.Statement.CertificateDERSHA256 != repeatFixtureHex('a') ||
		receipt.Statement.InstallationID != "installation-node-001" ||
		receipt.Statement.WorkerNodeID != "worker-node" ||
		receipt.Statement.BoundAt != "2026-09-03T00:00:00.000Z" {
		t.Fatalf("shared receipt fields differ: %#v", receipt)
	}
	status, err := VerifyActiveStatusWithSPKI(lines[1], spki)
	if err != nil {
		t.Fatalf("verify shared active status: %v", err)
	}
	if status.IssuerKeyID != sharedFixtureIssuerKeyID ||
		status.Statement.BindingID != receipt.Statement.BindingID ||
		status.Statement.CertificateDERSHA256 != repeatFixtureHex('a') ||
		status.Statement.InstallationID != "installation-node-001" ||
		status.Statement.WorkerNodeID != "worker-node" ||
		status.Statement.IssuedAt != "2026-09-03T00:00:00.000Z" ||
		status.Statement.ExpiresAt != "2026-09-03T00:00:45.000Z" ||
		status.Statement.ChallengeNonceBase64URL != base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0xab}, 32)) ||
		status.Statement.ReceiptSHA256 != repeatFixtureHex('c') ||
		status.Statement.RecordDocumentSHA256 != repeatFixtureHex('d') {
		t.Fatalf("shared active-status fields differ: %#v", status)
	}
}

func sharedGoldenLines(t *testing.T) [][]byte {
	t.Helper()
	repositoryRoot := filepath.Clean(filepath.Join(serviceHostRoot(t), "..", ".."))
	document, err := os.ReadFile(filepath.Join(repositoryRoot, "testdata", "server-binding-authority-v1.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if len(document) < 2 || document[len(document)-1] != '\n' ||
		(len(document) >= 2 && document[len(document)-2] == '\r') || bytes.ContainsRune(document, '\r') {
		t.Fatal("shared fixture must contain LF-delimited canonical documents")
	}
	lines := bytes.Split(document[:len(document)-1], []byte{'\n'})
	if len(lines) != 2 {
		t.Fatalf("shared fixture line count = %d, want 2", len(lines))
	}
	return [][]byte{bytes.Clone(lines[0]), bytes.Clone(lines[1])}
}

func repeatFixtureHex(character byte) string {
	return string(bytes.Repeat([]byte{character}, 64))
}
