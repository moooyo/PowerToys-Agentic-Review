package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReleasePublicKeyRequiresExactCompiledLowercaseHex(t *testing.T) {
	original := compiledReleasePublicKeyHex
	t.Cleanup(func() { compiledReleasePublicKeyHex = original })
	compiledReleasePublicKeyHex = strings.Repeat("01", 32)
	key, err := releasePublicKey()
	if err != nil || len(key) != 32 {
		t.Fatalf("releasePublicKey = (%d bytes, %v)", len(key), err)
	}
	for _, invalid := range []string{"", strings.Repeat("A", 64), strings.Repeat("0", 62)} {
		compiledReleasePublicKeyHex = invalid
		if _, err := releasePublicKey(); err == nil {
			t.Fatalf("invalid compiled key %q was accepted", invalid)
		}
	}
}

func TestReadInstallConfigAcceptsOnlyStrictCompleteObject(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install.json")
	valid := `{"serverOrigin":"https://review.example.test","workerNodeId":"powertoys-node:01","token":"arw1_secret"}`
	if err := os.WriteFile(path, []byte(valid), 0o600); err != nil {
		t.Fatal(err)
	}
	value, err := readInstallConfig(path)
	if err != nil || value.ServerOrigin == "" || value.WorkerNodeID == "" || value.Token == "" {
		t.Fatalf("readInstallConfig = (%+v, %v)", value, err)
	}
	if err := os.WriteFile(path, []byte(valid+` {}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readInstallConfig(path); err == nil {
		t.Fatal("trailing install config content was accepted")
	}
}

func TestCurrentArchitectureIsSupportedForReleaseBuilds(t *testing.T) {
	architecture, err := currentArchitecture()
	if err != nil || architecture == "" {
		t.Fatalf("currentArchitecture = (%q, %v)", architecture, err)
	}
}
