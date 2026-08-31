package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile/generator"
)

func TestRenderGeneratedSourceIsDeterministicAndReleaseTagged(t *testing.T) {
	document := generatorTemplateDocument(t)
	digest := fmt.Sprintf("%x", sha256.Sum256(document))
	first, err := renderGeneratedSource(document, digest)
	if err != nil {
		t.Fatal(err)
	}
	second, err := renderGeneratedSource(document, digest)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) {
		t.Fatal("generator output is not deterministic")
	}
	for _, expected := range [][]byte{
		[]byte("//go:build agenticreview_release"),
		[]byte("compiledReleaseTemplateDocument"),
		[]byte("compiledReleaseTemplateSHA256"),
		[]byte(`"` + digest + `"`),
	} {
		if !bytes.Contains(first, expected) {
			t.Fatalf("generated source omits %q", expected)
		}
	}
}

func TestRenderGeneratedSourceRejectsUnpinnedOrInvalidInput(t *testing.T) {
	document := generatorTemplateDocument(t)
	digest := fmt.Sprintf("%x", sha256.Sum256(document))
	invalid := bytes.Replace(document, []byte(`"profileId":"static-review-v1"`), []byte(`"profileId":"other"`), 1)
	for _, test := range []struct {
		name     string
		document []byte
		digest   string
	}{
		{name: "missing expected digest", document: document},
		{name: "uppercase expected digest", document: document, digest: strings.ToUpper(digest)},
		{name: "wrong expected digest", document: document, digest: strings.Repeat("f", 64)},
		{name: "noncanonical", document: append(append([]byte(nil), document...), '\n'), digest: fmt.Sprintf("%x", sha256.Sum256(append(document, '\n')))},
		{name: "invalid template", document: invalid, digest: fmt.Sprintf("%x", sha256.Sum256(invalid))},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := renderGeneratedSource(test.document, test.digest); err == nil {
				t.Fatal("renderGeneratedSource unexpectedly succeeded")
			}
		})
	}
}

func TestRunWritesAndChecksExactOutput(t *testing.T) {
	directory := t.TempDir()
	input := filepath.Join(directory, "release-template.json")
	output := filepath.Join(directory, generatedFileName)
	document := generatorTemplateDocument(t)
	digest := fmt.Sprintf("%x", sha256.Sum256(document))
	if err := os.WriteFile(input, document, 0o600); err != nil {
		t.Fatal(err)
	}
	arguments := []string{"-input", input, "-output", output, "-expected-sha256", digest}
	if err := run(arguments); err != nil {
		t.Fatal(err)
	}
	if err := run(append(arguments, "-check")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(output, []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run(append(arguments, "-check")); err == nil {
		t.Fatal("check accepted stale output")
	}
}

func TestRunRejectsEveryExistingOutputKind(t *testing.T) {
	for _, kind := range []string{"regular", "directory", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			directory := t.TempDir()
			input := filepath.Join(directory, "release-template.json")
			output := filepath.Join(directory, generatedFileName)
			document := generatorTemplateDocument(t)
			digest := fmt.Sprintf("%x", sha256.Sum256(document))
			if err := os.WriteFile(input, document, 0o600); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "regular":
				if err := os.WriteFile(output, []byte("existing"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(output, 0o700); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Symlink(input, output); err != nil {
					t.Skipf("symlink is unavailable: %v", err)
				}
			}
			if err := run([]string{
				"-input", input, "-output", output, "-expected-sha256", digest,
			}); err == nil {
				t.Fatal("generator replaced an existing output")
			}
		})
	}
}

func TestCheckRejectsNonregularOutput(t *testing.T) {
	directory := t.TempDir()
	input := filepath.Join(directory, "release-template.json")
	output := filepath.Join(directory, generatedFileName)
	document := generatorTemplateDocument(t)
	digest := fmt.Sprintf("%x", sha256.Sum256(document))
	if err := os.WriteFile(input, document, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(output, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{
		"-input", input, "-output", output, "-expected-sha256", digest, "-check",
	}); err == nil {
		t.Fatal("check accepted a directory output")
	}
}

func TestGeneratedSourceLoadsUnderReleaseBuildTag(t *testing.T) {
	document := generatorTemplateDocument(t)
	digest := fmt.Sprintf("%x", sha256.Sum256(document))
	generated, err := renderGeneratedSource(document, digest)
	if err != nil {
		t.Fatal(err)
	}
	moduleRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	backing := filepath.Join(directory, generatedFileName)
	if err := os.WriteFile(backing, generated, 0o600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(moduleRoot, "internal", "releaseprofile", generatedFileName)
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
		"-run",
		"^$",
		"-tags",
		"agenticreview_release",
		"-overlay",
		overlay,
		".",
	)
	command.Dir = moduleRoot
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("generated release-tag test failed: %v\n%s", err, output)
	}
}

func TestReleaseBuildTagFailsWithoutOverlay(t *testing.T) {
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
		generator.ReleaseBuildTag,
		".",
	)
	command.Dir = moduleRoot
	output, err := command.CombinedOutput()
	if err == nil {
		t.Fatal("release build tag unexpectedly succeeded without a Go overlay")
	}
	if !bytes.Contains(output, []byte("undefined: compiledReleaseTemplate")) {
		t.Fatalf("release-tag build failed for the wrong reason: %v\n%s", err, output)
	}
}

func TestRootReleaseBridgeExecutesCompiledProfileValidation(t *testing.T) {
	document := generatorTemplateDocument(t)
	digest := fmt.Sprintf("%x", sha256.Sum256(document))
	generated, err := renderGeneratedSource(document, digest)
	if err != nil {
		t.Fatal(err)
	}
	corrupt := bytes.Replace(generated, []byte(`"`+digest+`"`), []byte(`"`+strings.Repeat("f", 64)+`"`), 1)
	if bytes.Equal(corrupt, generated) {
		t.Fatal("failed to corrupt generated digest fixture")
	}
	moduleRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	backing := filepath.Join(directory, generatedFileName)
	if err := os.WriteFile(backing, corrupt, 0o600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(moduleRoot, "internal", "releaseprofile", generatedFileName)
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
		"-run",
		"^$",
		"-tags",
		generator.ReleaseBuildTag,
		"-overlay",
		overlay,
		".",
	)
	command.Dir = moduleRoot
	output, err := command.CombinedOutput()
	if err == nil {
		t.Fatal("root release bridge accepted corrupt compiled profile constants")
	}
	if !bytes.Contains(output, []byte("load compiled ServiceHost release profile")) {
		t.Fatalf("root validation failed for the wrong reason: %v\n%s", err, output)
	}
}

type generatorDocument struct {
	AuthenticodeLeafSignerCertificateDERSHA256 string                         `json:"authenticodeLeafSignerCertificateDerSha256"`
	Compatibility                              releasemanifest.Compatibility  `json:"compatibility"`
	Dependencies                               []releaseprofile.Dependency    `json:"dependencies"`
	ProfileID                                  string                         `json:"profileId"`
	ReleaseID                                  string                         `json:"releaseId"`
	SchemaVersion                              uint32                         `json:"schemaVersion"`
	ServiceHost                                releaseprofile.SelfRequirement `json:"serviceHost"`
}

func generatorTemplateDocument(t *testing.T) []byte {
	t.Helper()
	file := func(root releasemanifest.FileRoot, path string, role releasemanifest.FileRole, digit string) releaseprofile.Dependency {
		return releaseprofile.Dependency{Root: root, Path: path, Role: role, SHA256: strings.Repeat(digit, 64), Size: "1"}
	}
	value := generatorDocument{
		AuthenticodeLeafSignerCertificateDERSHA256: strings.Repeat("c", 64),
		Compatibility: releasemanifest.RequiredCompatibility(),
		Dependencies: []releaseprofile.Dependency{
			file(releasemanifest.RootInstallation, `AgenticReview.Worker.Control.exe`, releasemanifest.RoleServiceWrapper, "1"),
			file(releasemanifest.RootInstallation, `AgenticReview.Worker.Executor.exe`, releasemanifest.RoleServiceWrapper, "2"),
			file(releasemanifest.RootInstallation, `app\control.mjs`, releasemanifest.RoleControlBundle, "3"),
			file(releasemanifest.RootInstallation, `app\executor.mjs`, releasemanifest.RoleExecutorBundle, "4"),
			file(releasemanifest.RootInstallation, `codex\codex.exe`, releasemanifest.RoleCodexCLI, "5"),
			file(releasemanifest.RootInstallation, `git\cmd\git.exe`, releasemanifest.RoleGitCLI, "6"),
			file(releasemanifest.RootInstallation, `native\AgenticReview.ProcessHost.exe`, releasemanifest.RoleProcessHost, "7"),
			file(releasemanifest.RootInstallation, `runtime\node.exe`, releasemanifest.RoleNodeRuntime, "8"),
			file(releasemanifest.RootInstallation, `service\control.xml`, releasemanifest.RoleServiceConfig, "9"),
			file(releasemanifest.RootInstallation, `service\executor.xml`, releasemanifest.RoleServiceConfig, "a"),
		},
		ProfileID:     releaseprofile.ProductionProfileID,
		ReleaseID:     "worker-test-1",
		SchemaVersion: releaseprofile.SchemaVersion,
		ServiceHost: releaseprofile.SelfRequirement{
			Root: releasemanifest.RootInstallation,
			Path: releaseprofile.ServiceHostRelativePath,
			Role: releasemanifest.RoleServiceHost,
		},
	}
	document, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := releaseprofile.ValidateDocument(document); err != nil {
		t.Fatalf("generator fixture is not canonical: %v\n%s", err, document)
	}
	return document
}
