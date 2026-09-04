package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"

	buildworkerpackage "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/workerpackage"
)

func TestRunBuildsManifestAndSignatureWithRawPrivateKey(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	directory := t.TempDir()
	root := filepath.Join(directory, "payload")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "bin"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "bin", "worker.exe"), []byte("worker"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "readme.txt"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}

	privateKeyPath := filepath.Join(directory, "worker.key")
	if err := os.WriteFile(privateKeyPath, privateKey, 0o600); err != nil {
		t.Fatal(err)
	}

	manifestPath := filepath.Join(root, "manifest.json")
	signaturePath := filepath.Join(root, "manifest.sig")
	if err := os.WriteFile(manifestPath, []byte("stale-manifest"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(signaturePath, []byte("stale-signature"), 0o600); err != nil {
		t.Fatal(err)
	}

	err = run([]string{
		"-root", root,
		"-release-id", "release-42",
		"-architecture", "amd64",
		"-private-key", privateKeyPath,
		"-manifest", manifestPath,
		"-signature", signaturePath,
	})
	if err != nil {
		t.Fatal(err)
	}

	manifestDocument, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := buildworkerpackage.ParseManifest(manifestDocument)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.ReleaseID != "release-42" {
		t.Fatalf("unexpected release id: %q", manifest.ReleaseID)
	}
	if manifest.Architecture != buildworkerpackage.ArchitectureAMD64 {
		t.Fatalf("unexpected architecture: %q", manifest.Architecture)
	}
	if len(manifest.Files) != 2 {
		t.Fatalf("unexpected file count: %d", len(manifest.Files))
	}
	if manifest.Files[0].RelativePath != "bin/worker.exe" {
		t.Fatalf("unexpected first path: %q", manifest.Files[0].RelativePath)
	}
	if manifest.Files[1].RelativePath != "readme.txt" {
		t.Fatalf("unexpected second path: %q", manifest.Files[1].RelativePath)
	}
	readmeDigest := sha256.Sum256([]byte("hello"))
	if manifest.Files[1].SHA256 != hex.EncodeToString(readmeDigest[:]) {
		t.Fatalf("unexpected hash for readme.txt: %q", manifest.Files[1].SHA256)
	}

	signature, err := os.ReadFile(signaturePath)
	if err != nil {
		t.Fatal(err)
	}
	if len(signature) != ed25519.SignatureSize {
		t.Fatalf("unexpected signature size: %d", len(signature))
	}
	if !ed25519.Verify(privateKey.Public().(ed25519.PublicKey), manifestDocument, signature) {
		t.Fatal("signature verification failed")
	}
}

func TestRunAcceptsPKCS8PrivateKey(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	pkcs8, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}

	directory := t.TempDir()
	root := filepath.Join(directory, "payload")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "agent.txt"), []byte("agent"), 0o600); err != nil {
		t.Fatal(err)
	}
	privateKeyPath := filepath.Join(directory, "worker.pkcs8")
	if err := os.WriteFile(privateKeyPath, pkcs8, 0o600); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(directory, "manifest.json")
	signaturePath := filepath.Join(directory, "manifest.sig")

	err = run([]string{
		"-root", root,
		"-release-id", "release-7",
		"-architecture", "arm64",
		"-private-key", privateKeyPath,
		"-manifest", manifestPath,
		"-signature", signaturePath,
	})
	if err != nil {
		t.Fatal(err)
	}

	manifestDocument, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := os.ReadFile(signaturePath)
	if err != nil {
		t.Fatal(err)
	}
	if !ed25519.Verify(privateKey.Public().(ed25519.PublicKey), manifestDocument, signature) {
		t.Fatal("signature verification failed")
	}
}

func TestRunRejectsSymlinkEntries(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	directory := t.TempDir()
	root := filepath.Join(directory, "payload")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "target.txt")
	if err := os.WriteFile(target, []byte("target"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link.txt")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink is unavailable: %v", err)
	}

	privateKeyPath := filepath.Join(directory, "worker.key")
	if err := os.WriteFile(privateKeyPath, privateKey, 0o600); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(directory, "manifest.json")
	signaturePath := filepath.Join(directory, "manifest.sig")

	err = run([]string{
		"-root", root,
		"-release-id", "release-1",
		"-architecture", "amd64",
		"-private-key", privateKeyPath,
		"-manifest", manifestPath,
		"-signature", signaturePath,
	})
	if err == nil {
		t.Fatal("run unexpectedly accepted symlink entry")
	}
}

func TestParsePrivateKeyRejectsInvalidInput(t *testing.T) {
	if _, err := parsePrivateKey([]byte("not-a-key")); err == nil {
		t.Fatal("parsePrivateKey unexpectedly accepted invalid input")
	}
}

func TestWriteAtomicReplacesExistingFile(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "out.bin")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}

	document := []byte("new")
	if err := writeAtomic(path, document, 0o600); err != nil {
		t.Fatal(err)
	}

	actual, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, document) {
		t.Fatalf("unexpected output: %q", actual)
	}
}
