package main

import (
	"bytes"
	"strings"
	"testing"
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

func TestRunRejectsInvalidCommandLine(t *testing.T) {
	var standardOutput bytes.Buffer
	var standardError bytes.Buffer
	if code := run(nil, &standardOutput, &standardError); code != exitInvalidConfig {
		t.Fatalf("run returned exit code %d", code)
	}
	if standardError.Len() == 0 {
		t.Fatal("run did not report its error")
	}
}

func TestRunDelegatesConfigurationPathToFailClosedPlatform(t *testing.T) {
	path := `C:\ProgramData\AgenticReview\TrustedConfig\control.json`
	var standardOutput bytes.Buffer
	var standardError bytes.Buffer
	if code := run([]string{"--config", path}, &standardOutput, &standardError); code != exitPreflight {
		t.Fatalf("run returned exit code %d", code)
	}
	if !strings.Contains(standardError.String(), "preflight failed") {
		t.Fatalf("run returned the wrong error: %q", standardError.String())
	}
}
