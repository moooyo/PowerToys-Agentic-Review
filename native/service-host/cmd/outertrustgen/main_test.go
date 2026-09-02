package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	outertrustgenerator "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outertrust/generator"
)

func TestRunWritesAndChecksExactGeneratedTrust(t *testing.T) {
	directory := t.TempDir()
	spkiPath := filepath.Join(directory, "signer.spki")
	digestPath := filepath.Join(directory, "signer.sha256")
	outputPath := filepath.Join(directory, generatedFileName)
	spki := commandSPKI(t)
	digest := sha256.Sum256(spki)
	if err := os.WriteFile(spkiPath, spki, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(digestPath, []byte(hex.EncodeToString(digest[:])), 0o400); err != nil {
		t.Fatal(err)
	}
	arguments := []string{
		"-spki", spkiPath,
		"-approved-sha256-file", digestPath,
		"-output", outputPath,
	}
	if err := run(arguments); err != nil {
		t.Fatal(err)
	}
	if err := run(append(append([]string(nil), arguments...), "-check")); err != nil {
		t.Fatal(err)
	}
	generated, err := os.ReadFile(outputPath)
	if err != nil || !bytes.Contains(generated, []byte("//go:build agenticreview_outertrust")) {
		t.Fatalf("generated source is absent or invalid: %v", err)
	}
	if err := os.WriteFile(outputPath, []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run(append(append([]string(nil), arguments...), "-check")); err == nil {
		t.Fatal("check accepted stale generated source")
	}
}

func TestRunRejectsNonIndependentOrNonExactApproval(t *testing.T) {
	directory := t.TempDir()
	spkiPath := filepath.Join(directory, "signer.spki")
	digestPath := filepath.Join(directory, "signer.sha256")
	outputPath := filepath.Join(directory, generatedFileName)
	spki := commandSPKI(t)
	digest := sha256.Sum256(spki)
	if err := os.WriteFile(spkiPath, spki, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(digestPath, append([]byte(hex.EncodeToString(digest[:])), '\n'), 0o400); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{
		"-spki", spkiPath,
		"-approved-sha256-file", digestPath,
		"-output", outputPath,
	}); err == nil {
		t.Fatal("run accepted an approval digest with a newline")
	}
	if err := run([]string{
		"-spki", spkiPath,
		"-approved-sha256-file", spkiPath,
		"-output", outputPath,
	}); err == nil {
		t.Fatal("run accepted the SPKI as its own approval file")
	}
}

func TestGeneratedTrustLoadsAndDrivesProductionAdmission(t *testing.T) {
	moduleRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	spki := deterministicCommandSPKI(t)
	digest := sha256.Sum256(spki)
	generated, err := outertrustgenerator.Render(spki, hex.EncodeToString(digest[:]))
	if err != nil {
		t.Fatal(err)
	}
	backing := filepath.Join(directory, generatedFileName)
	if err := os.WriteFile(backing, generated, 0o600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(moduleRoot, "internal", "outertrust", generatedFileName)
	overlayDocument, err := json.Marshal(struct {
		Replace map[string]string `json:"Replace"`
	}{Replace: map[string]string{target: backing}})
	if err != nil {
		t.Fatal(err)
	}
	overlay := filepath.Join(directory, "overlay.json")
	if err := os.WriteFile(overlay, overlayDocument, 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	command := exec.CommandContext(
		ctx,
		"go",
		"test",
		"-count=1",
		"-tags",
		outertrustgenerator.ReleaseBuildTag,
		"-overlay",
		overlay,
		"./internal/outertrust",
		"./internal/outeradmission",
	)
	command.Dir = moduleRoot
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("generated outer trust tests failed: %v\n%s", err, output)
	}
}

func TestOuterTrustBuildTagFailsWithoutGeneratedSource(t *testing.T) {
	moduleRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	command := exec.CommandContext(
		ctx,
		"go",
		"test",
		"-count=1",
		"-run",
		"^$",
		"-tags",
		outertrustgenerator.ReleaseBuildTag,
		"./internal/outertrust",
	)
	command.Dir = moduleRoot
	output, err := command.CombinedOutput()
	if err == nil {
		t.Fatal("outer trust build tag unexpectedly succeeded without generated source")
	}
	if !bytes.Contains(output, []byte("undefined: compiledOuterSignerSPKI")) {
		t.Fatalf("release-tag build failed for the wrong reason: %v\n%s", err, output)
	}
}

func commandSPKI(t *testing.T) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	spki, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return spki
}

func deterministicCommandSPKI(t *testing.T) []byte {
	t.Helper()
	curve := elliptic.P256()
	x, y := curve.ScalarBaseMult([]byte{1})
	key := &ecdsa.PublicKey{Curve: curve, X: x, Y: y}
	spki, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return spki
}
