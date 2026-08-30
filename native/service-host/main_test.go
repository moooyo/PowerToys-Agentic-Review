package main

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
)

func TestCommandLineAcceptsOnlyConfigOrVersion(t *testing.T) {
	tests := []struct {
		name      string
		arguments []string
		valid     bool
	}{
		{name: "config pair", arguments: []string{"--config", `C:\config.json`}, valid: true},
		{name: "config equals", arguments: []string{`--config=C:\config.json`}, valid: true},
		{name: "version", arguments: []string{"--version"}, valid: true},
		{name: "empty", arguments: nil},
		{name: "single dash", arguments: []string{"-config", `C:\config.json`}},
		{name: "missing path", arguments: []string{"--config"}},
		{name: "empty path", arguments: []string{"--config", " "}},
		{name: "version plus config", arguments: []string{"--version", "--config", `C:\config.json`}},
		{name: "arbitrary child argument", arguments: []string{"--config", `C:\config.json`, "--child-argument=unsafe"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := parseCommandLine(test.arguments)
			if test.valid && err != nil {
				t.Fatalf("parseCommandLine returned an error: %v", err)
			}
			if !test.valid && err == nil {
				t.Fatal("parseCommandLine accepted an invalid command line")
			}
		})
	}
}

func TestRunPrintsVersionWithoutLoadingConfiguration(t *testing.T) {
	var standardOutput bytes.Buffer
	var standardError bytes.Buffer
	if code := run([]string{"--version"}, &standardOutput, &standardError); code != exitSuccess {
		t.Fatalf("run returned exit code %d", code)
	}
	if standardOutput.String() != "AgenticReview.ServiceHost "+version+"\n" {
		t.Fatalf("unexpected version output: %q", standardOutput.String())
	}
	if standardError.Len() != 0 {
		t.Fatalf("unexpected standard error: %q", standardError.String())
	}
}

func TestRunRejectsMissingAndInvalidConfiguration(t *testing.T) {
	for _, arguments := range [][]string{nil, {"--config", filepath.Join(t.TempDir(), "missing.json")}} {
		var standardOutput bytes.Buffer
		var standardError bytes.Buffer
		if code := run(arguments, &standardOutput, &standardError); code != exitInvalidConfig {
			t.Fatalf("run(%v) returned exit code %d", arguments, code)
		}
		if standardError.Len() == 0 {
			t.Fatalf("run(%v) did not report its error", arguments)
		}
	}
}

func TestRunFailsClosedAtTheUnimplementedPlatformBoundary(t *testing.T) {
	document, err := config.MarshalCanonical(validMainConfig())
	if err != nil {
		t.Fatalf("MarshalCanonical returned an error: %v", err)
	}
	path := filepath.Join(t.TempDir(), "service-host.json")
	if err := os.WriteFile(path, document, 0o600); err != nil {
		t.Fatalf("write configuration fixture: %v", err)
	}
	var standardOutput bytes.Buffer
	var standardError bytes.Buffer
	expectedCode := exitPreflight
	if runtime.GOOS == "windows" {
		// Windows intentionally rejects every source before opening it until the native
		// handle-bound configuration reader is implemented.
		expectedCode = exitInvalidConfig
	}
	if code := run([]string{"--config", path}, &standardOutput, &standardError); code != expectedCode {
		t.Fatalf("run returned exit code %d", code)
	}
	expectedError := "preflight failed"
	if runtime.GOOS == "windows" {
		expectedError = "configuration rejected"
	}
	if !strings.Contains(standardError.String(), expectedError) {
		t.Fatalf("run returned the wrong error: %q", standardError.String())
	}
}

func validMainConfig() config.Config {
	return config.Config{
		SchemaVersion: config.SchemaVersion,
		Role:          config.RoleControl,
		OwnService: config.ServiceIdentity{
			Name: config.ControlServiceName,
		},
		PeerService: config.ServiceIdentity{
			Name: config.ExecutorServiceName,
		},
		PipeName: config.ControlExecutorPipeName,
		Installation: config.Installation{
			Root:           `C:\Program Files\AgenticReview\Worker`,
			ManifestPath:   `C:\Program Files\AgenticReview\Worker\release-manifest.json`,
			ManifestSHA256: strings.Repeat("a", 64),
		},
		Node: config.Node{
			ExecutablePath:   `C:\Program Files\AgenticReview\Worker\runtime\node.exe`,
			ExecutableSHA256: strings.Repeat("b", 64),
			BundlePath:       `C:\Program Files\AgenticReview\Worker\app\control.mjs`,
			BundleSHA256:     strings.Repeat("c", 64),
			WorkingDirectory: `C:\ProgramData\AgenticReview\Control`,
			Environment: map[string]string{
				"NODE_ENV":    "production",
				"PATH":        `C:\Program Files\AgenticReview\Worker\runtime`,
				"SYSTEMROOT":  `C:\Windows`,
				"TEMP":        `C:\ProgramData\AgenticReview\Control\Temp`,
				"TMP":         `C:\ProgramData\AgenticReview\Control\Temp`,
				"USERPROFILE": `C:\ProgramData\AgenticReview\Control\Profile`,
			},
		},
		Limits: config.Limits{
			RootJobMaximumProcesses:        128,
			RootJobMaximumMemoryBytes:      "17179869184",
			MaximumFrameBytes:              config.MaximumFrameBytes,
			MaximumQueuedBytesPerDirection: 4 * 1024 * 1024,
			ConnectTimeoutMilliseconds:     30_000,
			ShutdownTimeoutMilliseconds:    120_000,
		},
	}
}
