package workerinstaller

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/workerpackage"
)

type fakeSystem struct {
	events      []string
	failAt      string
	files       []InstallFile
	localConfig LocalConfig
}

func (system *fakeSystem) step(name string) error {
	system.events = append(system.events, name)
	if system.failAt == name {
		return errors.New("injected failure")
	}
	return nil
}

func (system *fakeSystem) EnsureClean() error { return system.step("ensure-clean") }
func (system *fakeSystem) InstallFiles(files []InstallFile) error {
	system.files = append([]InstallFile(nil), files...)
	return system.step("install-files")
}
func (system *fakeSystem) WriteLocalConfig(value LocalConfig) error {
	system.localConfig = value
	return system.step("write-local-config")
}
func (system *fakeSystem) CreateServicesDisabled() error { return system.step("create-disabled") }
func (system *fakeSystem) EnableServicesManual() error   { return system.step("enable-manual") }
func (system *fakeSystem) StartExecutor() error           { return system.step("start-executor") }
func (system *fakeSystem) StartControl() error            { return system.step("start-control") }
func (system *fakeSystem) SetServicesAutomatic() error    { return system.step("set-automatic") }
func (system *fakeSystem) StopAndDisable() error           { return system.step("stop-disable") }

func TestInstallCleanVerifiesBeforeMutationAndUsesFixedOrder(t *testing.T) {
	input := validInputs(t)
	system := &fakeSystem{}
	if err := InstallClean(system, input); err != nil {
		t.Fatalf("InstallClean error = %v", err)
	}
	wantEvents := []string{
		"ensure-clean", "install-files", "write-local-config", "create-disabled",
		"enable-manual", "start-executor", "start-control", "set-automatic",
	}
	if !reflect.DeepEqual(system.events, wantEvents) {
		t.Fatalf("events = %v, want %v", system.events, wantEvents)
	}
	if strings.Contains(string(input.ManifestBytes), input.Token) {
		t.Fatal("Token entered the package manifest")
	}
	if !bytes.Contains(system.localConfig.WorkerAuthDocument, []byte(input.Token)) {
		t.Fatal("fixed Worker auth document omitted the Token")
	}
	if bytes.Contains(system.localConfig.ExecutorDocument, []byte("serverOrigin")) {
		t.Fatal("Executor config contains Server origin")
	}
	if system.localConfig.ControlPath != config.ControlBootstrapPath ||
		system.localConfig.ExecutorPath != config.ExecutorBootstrapPath ||
		system.localConfig.WorkerAuthPath != config.WorkerAuthenticationProfilePath {
		t.Fatalf("unexpected local paths: %+v", system.localConfig)
	}
	foundTrusted := false
	for _, file := range system.files {
		if strings.HasSuffix(file.SourcePath, filepath.FromSlash(trustedCodexRequirementsPath)) {
			foundTrusted = file.DestinationPath == config.ExecutorCodexPolicyPath
		}
	}
	if !foundTrusted {
		t.Fatal("trusted Codex policy was not mapped to the fixed trusted configuration path")
	}
}

func TestInstallCleanRejectsInvalidPackageBeforeSystemAccess(t *testing.T) {
	input := validInputs(t)
	input.RawSignature[0] ^= 0xff
	system := &fakeSystem{}
	if err := InstallClean(system, input); err == nil {
		t.Fatal("invalid package signature was accepted")
	}
	if len(system.events) != 0 {
		t.Fatalf("system was accessed before package verification: %v", system.events)
	}
}

func TestInstallCleanStopsAndDisablesAfterMutationFailure(t *testing.T) {
	input := validInputs(t)
	system := &fakeSystem{failAt: "start-control"}
	if err := InstallClean(system, input); err == nil {
		t.Fatal("injected mutation failure was accepted")
	}
	if got := system.events[len(system.events)-1]; got != "stop-disable" {
		t.Fatalf("last event = %q, want stop-disable", got)
	}
	count := 0
	for _, event := range system.events {
		if event == "stop-disable" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("stop-disable calls = %d, want 1", count)
	}
}

func validInputs(t *testing.T) Inputs {
	t.Helper()
	root := t.TempDir()
	files := make([]workerpackage.File, 0, len(requiredEntries))
	for index, relative := range requiredEntries {
		content := []byte(fmt.Sprintf("payload-%d", index))
		path := filepath.Join(root, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, content, 0o644); err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(content)
		files = append(files, workerpackage.File{
			RelativePath: relative,
			Size:         uint64(len(content)),
			SHA256:       fmt.Sprintf("%x", digest),
		})
	}
	manifest, err := workerpackage.MarshalManifestCanonical(workerpackage.Manifest{
		ReleaseID:    "2026.09.04.1",
		Architecture: workerpackage.ArchitectureAMD64,
		Files:        files,
	})
	if err != nil {
		t.Fatal(err)
	}
	seed := bytes.Repeat([]byte{7}, ed25519.SeedSize)
	privateKey := ed25519.NewKeyFromSeed(seed)
	publicKey := privateKey.Public().(ed25519.PublicKey)
	token := "arw1_" + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
	return Inputs{
		SourceRoot:          root,
		ManifestBytes:       manifest,
		RawSignature:        ed25519.Sign(privateKey, manifest),
		ReleasePublicKey:    append([]byte(nil), publicKey...),
		ServerOrigin:        "https://review.example.test",
		WorkerNodeID:        "powertoys-node:01",
		Token:               token,
		CurrentArchitecture: workerpackage.ArchitectureAMD64,
	}
}
