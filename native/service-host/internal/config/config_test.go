package config

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestCanonicalConfigurationRoundTrip(t *testing.T) {
	for _, original := range []Config{validControlConfig(), validExecutorConfig()} {
		t.Run(string(original.Role), func(t *testing.T) {
			document, err := MarshalCanonical(original)
			if err != nil {
				t.Fatalf("MarshalCanonical returned an error: %v", err)
			}
			parsed, err := Parse(document)
			if err != nil {
				t.Fatalf("Parse returned an error: %v", err)
			}
			if parsed != original {
				t.Fatalf("Parse returned %#v, want %#v", parsed, original)
			}
		})
	}
}

func TestSchema4JSONContainsOnlyMinimalFields(t *testing.T) {
	document := mustCanonical(t, validControlConfig())
	for _, forbidden := range []string{
		`"ownService"`,
		`"peerService"`,
		`"pipeName"`,
		`"installation"`,
		`"node"`,
		`"control":`,
		`"executor":`,
		`"limits"`,
		`"sha256"`,
		`"sha1"`,
	} {
		if bytes.Contains(document, []byte(forbidden)) {
			t.Fatalf("unexpected field in minimal schema4 JSON: %s", forbidden)
		}
	}
	if !bytes.Equal(
		document,
		[]byte(`{"schemaVersion":4,"role":"control","workerNodeId":"powertoys-node:01","serverOrigin":"https://review.example.test"}`),
	) {
		t.Fatalf("unexpected canonical JSON: %s", document)
	}

	executorDocument := mustCanonical(t, validExecutorConfig())
	if bytes.Contains(executorDocument, []byte(`"serverOrigin"`)) {
		t.Fatalf("executor JSON must omit empty serverOrigin: %s", executorDocument)
	}
}

func TestParseRejectsUnknownAndLegacyFields(t *testing.T) {
	document := mustCanonical(t, validControlConfig())
	for _, legacyField := range []string{
		`"ownService":{"name":"x","sid":"y"},`,
		`"peerService":{"name":"x","sid":"y"},`,
		`"pipeName":"\\\\.\\pipe\\other",`,
		`"installation":{"root":"C:\\\\x"},`,
		`"node":{"bundlePath":"C:\\\\x"},`,
		`"control":{"serverOrigin":"https://review.example.test"},`,
		`"executor":{"processHostPath":"C:\\\\x"},`,
		`"limits":{"maximumFrameBytes":1},`,
	} {
		mutated := bytes.Replace(document, []byte(`"serverOrigin":`), []byte(legacyField+`"serverOrigin":`), 1)
		_, err := Parse(mutated)
		assertConfigErrorCode(t, err, ErrorFormat)
	}
}

func TestParseRejectsNonCanonicalAndDuplicateDocuments(t *testing.T) {
	document := mustCanonical(t, validControlConfig())
	tests := []struct {
		name string
		data []byte
		code ErrorCode
	}{
		{name: "trailing newline", data: append(append([]byte(nil), document...), '\n'), code: ErrorCanonical},
		{
			name: "duplicate property",
			data: bytes.Replace(document, []byte(`"schemaVersion":4`), []byte(`"schemaVersion":4,"schemaVersion":4`), 1),
			code: ErrorCanonical,
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

func TestValidateRoleAndServerOriginRules(t *testing.T) {
	tests := []struct {
		name   string
		value  Config
		mutate func(*Config)
	}{
		{name: "old schema", value: validControlConfig(), mutate: func(value *Config) { value.SchemaVersion = 3 }},
		{name: "unsupported role", value: validControlConfig(), mutate: func(value *Config) { value.Role = "combined" }},
		{name: "missing worker node ID", value: validControlConfig(), mutate: func(value *Config) { value.WorkerNodeID = "" }},
		{name: "worker node ID plus", value: validControlConfig(), mutate: func(value *Config) { value.WorkerNodeID = "node+1" }},
		{name: "control missing origin", value: validControlConfig(), mutate: func(value *Config) { value.ServerOrigin = "" }},
		{name: "control http origin", value: validControlConfig(), mutate: func(value *Config) {
			value.ServerOrigin = "http://review.example.test"
		}},
		{name: "control origin path", value: validControlConfig(), mutate: func(value *Config) {
			value.ServerOrigin = "https://review.example.test/api"
		}},
		{name: "control origin credentials", value: validControlConfig(), mutate: func(value *Config) {
			value.ServerOrigin = "https://user@review.example.test"
		}},
		{name: "control origin uppercase host", value: validControlConfig(), mutate: func(value *Config) {
			value.ServerOrigin = "https://Review.example.test"
		}},
		{name: "control origin default port", value: validControlConfig(), mutate: func(value *Config) {
			value.ServerOrigin = "https://review.example.test:443"
		}},
		{name: "executor with server origin", value: validExecutorConfig(), mutate: func(value *Config) {
			value.ServerOrigin = "https://review.example.test"
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := test.value
			test.mutate(&value)
			assertConfigErrorCode(t, value.Validate(), ErrorValidation)
		})
	}
}

func TestRuntimeConfigForControlRole(t *testing.T) {
	runtimeConfig, err := validControlConfig().Runtime()
	if err != nil {
		t.Fatalf("Runtime returned an error: %v", err)
	}
	if runtimeConfig.OwnService != (ServiceIdentity{Name: ControlServiceName, SID: ControlServiceSID}) ||
		runtimeConfig.PeerService != (ServiceIdentity{Name: ExecutorServiceName, SID: ExecutorServiceSID}) {
		t.Fatalf("unexpected service identities: %#v", runtimeConfig)
	}
	if runtimeConfig.PipeName != ControlExecutorPipeName {
		t.Fatalf("pipe name = %q, want %q", runtimeConfig.PipeName, ControlExecutorPipeName)
	}
	if runtimeConfig.Installation.Root != InstallationRoot ||
		runtimeConfig.Installation.TrustedConfigurationRoot != TrustedConfigurationRoot {
		t.Fatalf("unexpected installation roots: %#v", runtimeConfig.Installation)
	}
	if runtimeConfig.Node.ExecutablePath != NodeExecutablePath ||
		runtimeConfig.Node.BundlePath != ControlBundlePath ||
		runtimeConfig.Node.DataRoot != ControlDataRoot ||
		runtimeConfig.Node.WorkingDirectory != ControlDataRoot+`\Work` {
		t.Fatalf("unexpected control node runtime: %#v", runtimeConfig.Node)
	}
	if runtimeConfig.Executor != nil {
		t.Fatalf("control runtime must not include executor config: %#v", runtimeConfig.Executor)
	}
	assertFixedLimits(t, runtimeConfig.Limits)
	assertMapEntry(t, runtimeConfig.Node.Environment, "PATH", InstallationRoot+`\runtime`)
	assertMapEntry(t, runtimeConfig.Node.Environment, "TEMP", ControlDataRoot+`\Temp`)

	runtimeConfig.Node.Environment["TEMP"] = `C:\Elsewhere`
	second, err := validControlConfig().Runtime()
	if err != nil {
		t.Fatalf("second Runtime returned an error: %v", err)
	}
	if second.Node.Environment["TEMP"] != ControlDataRoot+`\Temp` {
		t.Fatal("Runtime must return a fresh environment map copy")
	}
}

func TestRuntimeConfigForExecutorRole(t *testing.T) {
	runtimeConfig, err := validExecutorConfig().RuntimeConfig()
	if err != nil {
		t.Fatalf("RuntimeConfig returned an error: %v", err)
	}
	if runtimeConfig.OwnService != (ServiceIdentity{Name: ExecutorServiceName, SID: ExecutorServiceSID}) ||
		runtimeConfig.PeerService != (ServiceIdentity{Name: ControlServiceName, SID: ControlServiceSID}) {
		t.Fatalf("unexpected service identities: %#v", runtimeConfig)
	}
	if runtimeConfig.Node.BundlePath != ExecutorBundlePath ||
		runtimeConfig.Node.DataRoot != ExecutorDataRoot ||
		runtimeConfig.Node.WorkingDirectory != ExecutorDataRoot+`\Work` {
		t.Fatalf("unexpected executor node runtime: %#v", runtimeConfig.Node)
	}
	if runtimeConfig.Executor == nil {
		t.Fatal("executor runtime must include executor configuration")
	}
	if runtimeConfig.Executor.ProcessHostPath != ExecutorProcessHostPath ||
		runtimeConfig.Executor.CodexPolicyPath != ExecutorCodexPolicyPath {
		t.Fatalf("unexpected executor runtime configuration: %#v", runtimeConfig.Executor)
	}
	assertFixedLimits(t, runtimeConfig.Limits)
	assertMapEntry(t, runtimeConfig.Node.Environment, "CODEX_HOME", ExecutorDataRoot+`\Codex`)
	assertMapEntry(t, runtimeConfig.Node.Environment, "GIT_TERMINAL_PROMPT", "0")
	assertMapEntry(t, runtimeConfig.Node.Environment, "PATH", InstallationRoot+`\runtime`)
}

func TestRuntimeRejectsInvalidConfiguration(t *testing.T) {
	value := validControlConfig()
	value.WorkerNodeID = ""
	_, err := Runtime(value)
	assertConfigErrorCode(t, err, ErrorValidation)
}

func TestFixedServiceSIDsMatchWindowsDerivation(t *testing.T) {
	if ControlServiceSID != "S-1-5-80-2091717111-3815740202-2957909909-902494971-3397275836" ||
		deriveServiceSID(ControlServiceName) != ControlServiceSID {
		t.Fatalf("Control service SID %q does not match the Windows-derived golden value", ControlServiceSID)
	}
	if ExecutorServiceSID != "S-1-5-80-2741783613-3141871344-3258369507-3627446740-1359970993" ||
		deriveServiceSID(ExecutorServiceName) != ExecutorServiceSID {
		t.Fatalf("Executor service SID %q does not match the Windows-derived golden value", ExecutorServiceSID)
	}
}

func TestRoleFromTrustedBootstrapPathAcceptsOnlyFixedLocations(t *testing.T) {
	tests := []struct {
		name string
		path string
		want Role
		ok   bool
	}{
		{name: "Control", path: ControlBootstrapPath, want: RoleControl, ok: true},
		{name: "Executor", path: ExecutorBootstrapPath, want: RoleExecutor, ok: true},
		{name: "Control case-insensitive", path: `c:\programdata\agenticreview\trustedconfig\CONTROL.JSON`, want: RoleControl, ok: true},
		{name: "relative", path: `control.json`},
		{name: "other directory", path: `C:\ProgramData\AgenticReview\TrustedConfig\staged\control.json`},
		{name: "other file", path: `C:\ProgramData\AgenticReview\TrustedConfig\other.json`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			role, err := RoleFromTrustedBootstrapPath(test.path)
			if test.ok {
				if err != nil || role != test.want {
					t.Fatalf("RoleFromTrustedBootstrapPath(%q) = (%q, %v), want (%q, nil)", test.path, role, err, test.want)
				}
				return
			}
			if err == nil || role != "" {
				t.Fatalf("RoleFromTrustedBootstrapPath(%q) = (%q, %v), want empty role and error", test.path, role, err)
			}
		})
	}
}

func TestLoadRejectsUntrustedPath(t *testing.T) {
	_, err := Load(`C:\Temp\control.json`)
	assertConfigErrorCode(t, err, ErrorRead)
}

func validControlConfig() Config {
	return Config{
		SchemaVersion: SchemaVersion,
		Role:          RoleControl,
		WorkerNodeID:  "powertoys-node:01",
		ServerOrigin:  "https://review.example.test",
	}
}

func validExecutorConfig() Config {
	return Config{
		SchemaVersion: SchemaVersion,
		Role:          RoleExecutor,
		WorkerNodeID:  "powertoys-node:01",
	}
}

func mustCanonical(t *testing.T, value Config) []byte {
	t.Helper()
	document, err := MarshalCanonical(value)
	if err != nil {
		t.Fatalf("MarshalCanonical returned an error: %v", err)
	}
	return document
}

func assertFixedLimits(t *testing.T, limits Limits) {
	t.Helper()
	if limits.RootJobMaximumProcesses != 128 ||
		limits.RootJobMaximumMemoryBytes != "17179869184" ||
		limits.MaximumFrameBytes != MaximumFrameBytes ||
		limits.MaximumQueuedBytesPerDirection != 4*1024*1024 ||
		limits.ConnectTimeoutMilliseconds != 30_000 ||
		limits.ShutdownTimeoutMilliseconds != 120_000 ||
		limits.ForceTerminationReserveMilliseconds != 15_000 {
		t.Fatalf("unexpected fixed limits: %#v", limits)
	}
}

func assertMapEntry(t *testing.T, value map[string]string, key, want string) {
	t.Helper()
	if got, ok := value[key]; !ok || got != want {
		t.Fatalf("environment[%q] = %q, %v, want %q", key, got, ok, want)
	}
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

func TestWorkerNodeIDBoundary(t *testing.T) {
	for _, workerNodeID := range []string{"0", "A.b_c:d-0", "A" + strings.Repeat("z", 127)} {
		value := validControlConfig()
		value.WorkerNodeID = workerNodeID
		if err := value.Validate(); err != nil {
			t.Fatalf("Validate rejected workerNodeId %q: %v", workerNodeID, err)
		}
	}
}
