package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/platform"
)

type fakeMainHost struct {
	calls   int
	options platform.BootstrapOptions
	err     error
}

func (host *fakeMainHost) Run(_ context.Context, options platform.BootstrapOptions) error {
	host.calls++
	host.options = options
	return host.err
}

type fakeMainServiceRunner struct {
	calls   int
	command commandLine
	handled bool
	err     error
}

func (runner *fakeMainServiceRunner) RunIfService(
	command commandLine,
	_ platform.Host,
) (bool, error) {
	runner.calls++
	runner.command = command
	return runner.handled, runner.err
}

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
	host := &fakeMainHost{}
	services := &fakeMainServiceRunner{}
	if code := runWithDependencies(
		[]string{"--version"},
		&standardOutput,
		&standardError,
		host,
		services,
	); code != exitSuccess {
		t.Fatalf("run returned exit code %d", code)
	}
	if standardOutput.String() != "AgenticReview.ServiceHost "+version+"\n" {
		t.Fatalf("unexpected version output: %q", standardOutput.String())
	}
	if standardError.Len() != 0 {
		t.Fatalf("unexpected standard error: %q", standardError.String())
	}
	if host.calls != 0 || services.calls != 0 {
		t.Fatalf("version invoked host=%d service runner=%d times", host.calls, services.calls)
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
	hostFailure := errors.New("host failed")
	host := &fakeMainHost{err: hostFailure}
	services := &fakeMainServiceRunner{}
	if code := runWithDependencies(
		[]string{"--config", path},
		&standardOutput,
		&standardError,
		host,
		services,
	); code != exitPreflight {
		t.Fatalf("run returned exit code %d", code)
	}
	if !strings.Contains(standardError.String(), "preflight failed") {
		t.Fatalf("run returned the wrong error: %q", standardError.String())
	}
	if services.calls != 1 || services.command.configPath != path || host.calls != 1 ||
		host.options.ActualBootstrapPath != path {
		t.Fatalf(
			"service calls=%d command=%q host calls=%d options=%q",
			services.calls,
			services.command.configPath,
			host.calls,
			host.options.ActualBootstrapPath,
		)
	}
}

func TestRunReturnsAfterWindowsServiceRunnerHandlesProcess(t *testing.T) {
	path := `C:\ProgramData\AgenticReview\TrustedConfig\control.json`
	host := &fakeMainHost{}
	services := &fakeMainServiceRunner{handled: true}
	if code := runWithDependencies(
		[]string{"--config", path},
		&bytes.Buffer{},
		&bytes.Buffer{},
		host,
		services,
	); code != exitSuccess {
		t.Fatalf("run returned exit code %d", code)
	}
	if services.calls != 1 || host.calls != 0 {
		t.Fatalf("service calls=%d interactive host calls=%d", services.calls, host.calls)
	}
}

func TestRunFailsClosedWhenWindowsServiceDetectionFails(t *testing.T) {
	detectionFailure := errors.New("detection failed")
	host := &fakeMainHost{}
	services := &fakeMainServiceRunner{err: detectionFailure}
	var standardError bytes.Buffer
	if code := runWithDependencies(
		[]string{"--config", `C:\config.json`},
		&bytes.Buffer{},
		&standardError,
		host,
		services,
	); code != exitPreflight {
		t.Fatalf("run returned exit code %d", code)
	}
	if host.calls != 0 || !strings.Contains(standardError.String(), "Windows service failed") {
		t.Fatalf("interactive host calls=%d stderr=%q", host.calls, standardError.String())
	}
}
