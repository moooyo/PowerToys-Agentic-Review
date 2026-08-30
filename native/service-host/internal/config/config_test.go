package config

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCanonicalConfigurationRoundTrip(t *testing.T) {
	original := validConfig()
	document, err := MarshalCanonical(original)
	if err != nil {
		t.Fatalf("MarshalCanonical returned an error: %v", err)
	}
	parsed, err := Parse(document)
	if err != nil {
		t.Fatalf("Parse returned an error: %v", err)
	}
	if parsed.Role != original.Role || parsed.Node.ExecutablePath != original.Node.ExecutablePath {
		t.Fatalf("Parse returned the wrong configuration: %#v", parsed)
	}
}

func TestParseRejectsNonCanonicalAndDuplicateDocuments(t *testing.T) {
	document := mustCanonical(t, validConfig())
	tests := []struct {
		name string
		data []byte
		code ErrorCode
	}{
		{name: "trailing newline", data: append(append([]byte(nil), document...), '\n'), code: ErrorCanonical},
		{
			name: "duplicate property",
			data: bytes.Replace(document, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":1,"schemaVersion":1`), 1),
			code: ErrorCanonical,
		},
		{
			name: "unknown child arguments",
			data: bytes.Replace(document, []byte(`"workingDirectory":`), []byte(`"childArguments":[],"workingDirectory":`), 1),
			code: ErrorFormat,
		},
		{name: "byte-order mark", data: append([]byte{0xef, 0xbb, 0xbf}, document...), code: ErrorFormat},
		{name: "invalid UTF-8", data: []byte{'{', 0xff, '}'}, code: ErrorFormat},
		{name: "multiple values", data: append(append([]byte(nil), document...), []byte(`{}`)...), code: ErrorFormat},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Parse(test.data)
			assertConfigErrorCode(t, err, test.code)
		})
	}
}

func TestConfigurationValidationRejectsUnsafeValues(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{name: "unsupported role", mutate: func(value *Config) { value.Role = "combined" }},
		{name: "wrong own service", mutate: func(value *Config) { value.OwnService.Name = ExecutorServiceName }},
		{name: "wrong pipe", mutate: func(value *Config) { value.PipeName = `\\.\pipe\other` }},
		{name: "UNC installation", mutate: func(value *Config) { value.Installation.Root = `\\server\share\app` }},
		{name: "lowercase drive", mutate: func(value *Config) { value.Installation.Root = `c:\Program Files\AgenticReview` }},
		{name: "manifest escape", mutate: func(value *Config) { value.Installation.ManifestPath = `C:\manifest.json` }},
		{name: "reserved component", mutate: func(value *Config) { value.Node.BundlePath = `C:\Program Files\AgenticReview\Worker\CON.mjs` }},
		{name: "superscript reserved component", mutate: func(value *Config) { value.Node.BundlePath = `C:\Program Files\AgenticReview\Worker\COM¹.mjs` }},
		{name: "alternate data stream", mutate: func(value *Config) { value.Node.BundlePath += ":payload" }},
		{name: "bundle outside install", mutate: func(value *Config) { value.Node.BundlePath = `C:\Elsewhere\control.mjs` }},
		{name: "working directory overlap", mutate: func(value *Config) { value.Node.WorkingDirectory = value.Installation.Root + `\data` }},
		{name: "uppercase digest", mutate: func(value *Config) { value.Node.BundleSHA256 = strings.Repeat("A", 64) }},
		{name: "nil environment", mutate: func(value *Config) { value.Node.Environment = nil }},
		{name: "case duplicate environment", mutate: func(value *Config) { value.Node.Environment = map[string]string{"PATH": "x", "Path": "y"} }},
		{name: "Node options", mutate: func(value *Config) { value.Node.Environment["NODE_OPTIONS"] = "--require=x" }},
		{name: "disable TLS", mutate: func(value *Config) { value.Node.Environment["NODE_TLS_REJECT_UNAUTHORIZED"] = "0" }},
		{name: "proxy injection", mutate: func(value *Config) { value.Node.Environment["HTTPS_PROXY"] = "http://proxy" }},
		{name: "unknown variable", mutate: func(value *Config) { value.Node.Environment["UNREVIEWED"] = "x" }},
		{name: "noncanonical variable name", mutate: func(value *Config) { value.Node.Environment["Path"] = value.Node.Environment["PATH"] }},
		{name: "invalid environment name", mutate: func(value *Config) { value.Node.Environment["A=B"] = "x" }},
		{name: "environment control", mutate: func(value *Config) { value.Node.Environment["A"] = "x\ny" }},
		{name: "missing required environment", mutate: func(value *Config) { delete(value.Node.Environment, "SYSTEMROOT") }},
		{name: "unsafe PATH", mutate: func(value *Config) { value.Node.Environment["PATH"] = `C:\Trusted;;C:\Other` }},
		{name: "process limit", mutate: func(value *Config) { value.Limits.RootJobMaximumProcesses = 0 }},
		{name: "noncanonical memory", mutate: func(value *Config) { value.Limits.RootJobMaximumMemoryBytes = "0268435456" }},
		{name: "small memory", mutate: func(value *Config) { value.Limits.RootJobMaximumMemoryBytes = "1" }},
		{name: "frame limit", mutate: func(value *Config) { value.Limits.MaximumFrameBytes-- }},
		{name: "queue smaller than frame", mutate: func(value *Config) { value.Limits.MaximumQueuedBytesPerDirection = MaximumFrameBytes - 1 }},
		{name: "connect timeout", mutate: func(value *Config) { value.Limits.ConnectTimeoutMilliseconds = 999 }},
		{name: "shutdown timeout", mutate: func(value *Config) { value.Limits.ShutdownTimeoutMilliseconds = 300_001 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := cloneConfig(validConfig())
			test.mutate(&value)
			err := value.Validate()
			assertConfigErrorCode(t, err, ErrorValidation)
		})
	}
}

func TestExecutorEnvironmentAllowsOnlyItsReviewedExtensions(t *testing.T) {
	value := validConfig()
	value.Role = RoleExecutor
	value.OwnService.Name = ExecutorServiceName
	value.PeerService.Name = ControlServiceName
	value.Node.BundlePath = `C:\Program Files\AgenticReview\Worker\app\executor.mjs`
	value.Node.Environment["CODEX_HOME"] = `C:\ProgramData\AgenticReview\Executor\Codex`
	value.Node.Environment["GIT_CONFIG_NOSYSTEM"] = "1"
	value.Node.Environment["GIT_TERMINAL_PROMPT"] = "0"
	value.Node.Environment["GCM_INTERACTIVE"] = "never"
	if err := value.Validate(); err != nil {
		t.Fatalf("Validate rejected the reviewed Executor environment: %v", err)
	}
	value.Role = RoleControl
	if err := value.Validate(); err == nil {
		t.Fatal("Validate allowed Executor-only environment variables for Control")
	}
}

func TestLoadRejectsNonFilesAndOversizedFiles(t *testing.T) {
	directory := t.TempDir()
	if _, err := Load(directory); err == nil {
		t.Fatal("Load accepted a directory")
	}
	path := filepath.Join(directory, "large.json")
	if err := os.WriteFile(path, bytes.Repeat([]byte{'x'}, MaximumDocumentBytes+1), 0o600); err != nil {
		t.Fatalf("write oversized fixture: %v", err)
	}
	_, err := Load(path)
	assertConfigErrorCode(t, err, ErrorRead)
}

func validConfig() Config {
	return Config{
		SchemaVersion: SchemaVersion,
		Role:          RoleControl,
		OwnService: ServiceIdentity{
			Name: ControlServiceName,
		},
		PeerService: ServiceIdentity{
			Name: ExecutorServiceName,
		},
		PipeName: ControlExecutorPipeName,
		Installation: Installation{
			Root:           `C:\Program Files\AgenticReview\Worker`,
			ManifestPath:   `C:\Program Files\AgenticReview\Worker\release-manifest.json`,
			ManifestSHA256: strings.Repeat("a", 64),
		},
		Node: Node{
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
		Limits: Limits{
			RootJobMaximumProcesses:        128,
			RootJobMaximumMemoryBytes:      "17179869184",
			MaximumFrameBytes:              MaximumFrameBytes,
			MaximumQueuedBytesPerDirection: 4 * 1024 * 1024,
			ConnectTimeoutMilliseconds:     30_000,
			ShutdownTimeoutMilliseconds:    120_000,
		},
	}
}

func cloneConfig(value Config) Config {
	copy := value
	copy.Node.Environment = make(map[string]string, len(value.Node.Environment))
	for name, environmentValue := range value.Node.Environment {
		copy.Node.Environment[name] = environmentValue
	}
	return copy
}

func mustCanonical(t *testing.T, value Config) []byte {
	t.Helper()
	document, err := MarshalCanonical(value)
	if err != nil {
		t.Fatalf("MarshalCanonical returned an error: %v", err)
	}
	return document
}

func assertConfigErrorCode(t *testing.T, err error, code ErrorCode) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected configuration error %s", code)
	}
	var configErr *ConfigError
	if !errors.As(err, &configErr) || configErr.Code != code {
		t.Fatalf("expected configuration error %s, got %T: %v", code, err, err)
	}
}
