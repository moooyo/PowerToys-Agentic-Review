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
	for _, original := range []Config{validConfig(), validExecutorConfig()} {
		t.Run(string(original.Role), func(t *testing.T) {
			document, err := MarshalCanonical(original)
			if err != nil {
				t.Fatalf("MarshalCanonical returned an error: %v", err)
			}
			parsed, err := Parse(document)
			if err != nil {
				t.Fatalf("Parse returned an error: %v", err)
			}
			if parsed.Role != original.Role || parsed.WorkerNodeID != original.WorkerNodeID ||
				parsed.Node.ExecutablePath != original.Node.ExecutablePath {
				t.Fatalf("Parse returned the wrong configuration: %#v", parsed)
			}
		})
	}
}

func TestCurrentSchemaIsCanonicalAndTokenOnly(t *testing.T) {
	control := validConfig()
	document := mustCanonical(t, control)
	if !bytes.Contains(document, []byte(`"workerAuthenticationProfile":"agentic-review-worker-auth-v1"`)) ||
		bytes.Contains(document, []byte("clientCertificate")) ||
		bytes.Contains(document, []byte("clientPrivateKey")) {
		t.Fatalf("current Control document selected the wrong authentication fields: %s", document)
	}
	if parsed, err := Parse(document); err != nil || parsed.SchemaVersion != SchemaVersion ||
		parsed.Control == nil || parsed.Control.WorkerAuthenticationProfile != WorkerAuthenticationProfileBearerTokenV1 {
		t.Fatalf("Parse current schema = %#v, %v", parsed, err)
	}
	for _, field := range []string{
		`"clientCertificateStore":"",`,
		`"clientCertificateDerSha256":"",`,
		`"clientPrivateKeySecurityDescriptorSha256":"",`,
		`"localAuthorityCngKeyName":"legacy",`,
		`"localAuthorityKeySecurityDescriptorSha256":"9999999999999999999999999999999999999999999999999999999999999999",`,
		`"localAuthorityPublicKeySha256":"1111111111111111111111111111111111111111111111111111111111111111",`,
	} {
		t.Run(field, func(t *testing.T) {
			withLegacyField := bytes.Replace(
				document,
				[]byte(`"workerAuthenticationProfile":`),
				[]byte(field+`"workerAuthenticationProfile":`),
				1,
			)
			_, err := Parse(withLegacyField)
			assertConfigErrorCode(t, err, ErrorFormat)
		})
	}
	executorDocument := mustCanonical(t, validExecutorConfig())
	for _, field := range []string{
		`"localAuthorityPublicKeyPath":"C:\\ProgramData\\AgenticReview\\TrustedConfig\\local-authority.spki",`,
		`"localAuthorityPublicKeySha256":"1111111111111111111111111111111111111111111111111111111111111111",`,
	} {
		t.Run(field, func(t *testing.T) {
			withLegacyField := bytes.Replace(
				executorDocument,
				[]byte(`"codexPolicyPath":`),
				[]byte(field+`"codexPolicyPath":`),
				1,
			)
			_, err := Parse(withLegacyField)
			assertConfigErrorCode(t, err, ErrorFormat)
		})
	}

	tests := []struct {
		name   string
		value  Config
		mutate func(*Config)
	}{
		{name: "missing profile", value: control, mutate: func(value *Config) {
			value.Control.WorkerAuthenticationProfile = ""
		}},
		{name: "wrong profile", value: control, mutate: func(value *Config) {
			value.Control.WorkerAuthenticationProfile = "other"
		}},
		{name: "alternate data root", value: control, mutate: func(value *Config) {
			value.Node.DataRoot = `D:\AgenticReview\Control`
			value.Node.WorkingDirectory = value.Node.DataRoot + `\Work`
			rewriteEnvironmentRoot(value.Node.Environment, `C:\ProgramData\AgenticReview\Control`, value.Node.DataRoot)
		}},
		{name: "schema version 3", value: control, mutate: func(value *Config) {
			value.SchemaVersion = 3
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := cloneConfig(test.value)
			test.mutate(&value)
			assertConfigErrorCode(t, value.Validate(), ErrorValidation)
		})
	}
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
			data: bytes.Replace(document, []byte(`"schemaVersion":4`), []byte(`"schemaVersion":4,"schemaVersion":4`), 1),
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

func TestParseRejectsMissingRequiredCurrentFields(t *testing.T) {
	document := mustCanonical(t, validConfig())
	tests := []struct {
		name string
		old  []byte
		new  []byte
	}{
		{
			name: "schema version 3",
			old:  []byte(`"schemaVersion":4`),
			new:  []byte(`"schemaVersion":3`),
		},
		{name: "worker node ID", old: []byte(`"workerNodeId":"powertoys-node:01",`)},
		{name: "force termination reserve", old: []byte(`,"forceTerminationReserveMilliseconds":15000`)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			mutated := bytes.Replace(document, test.old, test.new, 1)
			if bytes.Equal(mutated, document) {
				t.Fatal("required field fixture was not found")
			}
			_, err := Parse(mutated)
			assertConfigErrorCode(t, err, ErrorValidation)
		})
	}
}

func TestReadmeConfigurationExamplesAreCanonical(t *testing.T) {
	document, err := os.ReadFile(filepath.Join("..", "..", "README.md"))
	if err != nil {
		t.Fatalf("read README configuration examples: %v", err)
	}
	remaining := string(document)
	roles := []Role{RoleControl, RoleExecutor}
	for _, expectedRole := range roles {
		const openingFence = "```json\n"
		start := strings.Index(remaining, openingFence)
		if start < 0 {
			t.Fatalf("README is missing the %s JSON example", expectedRole)
		}
		remaining = remaining[start+len(openingFence):]
		end := strings.Index(remaining, "\n```")
		if end < 0 {
			t.Fatalf("README has an unterminated %s JSON example", expectedRole)
		}
		parsed, parseErr := Parse([]byte(remaining[:end]))
		if parseErr != nil {
			t.Fatalf("README %s JSON example is invalid: %v", expectedRole, parseErr)
		}
		if parsed.Role != expectedRole || parsed.SchemaVersion != SchemaVersion {
			t.Fatalf("README JSON example role/schema = %s/%d, want %s/%d",
				parsed.Role, parsed.SchemaVersion, expectedRole, SchemaVersion)
		}
		if expectedRole == RoleControl && (parsed.Control == nil ||
			parsed.Control.WorkerAuthenticationProfile != WorkerAuthenticationProfileBearerTokenV1) {
			t.Fatalf("README Control JSON example does not select Token-only authentication: %#v", parsed.Control)
		}
		remaining = remaining[end+len("\n```"):]
	}
	if strings.Contains(remaining, "```json\n") {
		t.Fatal("README contains an unexpected additional JSON example")
	}
}

func TestConfigurationValidationRejectsUnsafeValues(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{name: "old schema", mutate: func(value *Config) { value.SchemaVersion = 3 }},
		{name: "unsupported role", mutate: func(value *Config) { value.Role = "combined" }},
		{name: "missing worker node ID", mutate: func(value *Config) { value.WorkerNodeID = "" }},
		{name: "worker node ID prefix", mutate: func(value *Config) { value.WorkerNodeID = ":node" }},
		{name: "worker node ID plus", mutate: func(value *Config) { value.WorkerNodeID = "node+1" }},
		{name: "worker node ID non-ASCII", mutate: func(value *Config) {
			value.WorkerNodeID = "node-" + string([]byte{0xc3, 0xa9})
		}},
		{name: "worker node ID length", mutate: func(value *Config) { value.WorkerNodeID = "n" + strings.Repeat("x", 128) }},
		{name: "wrong own service", mutate: func(value *Config) { value.OwnService.Name = ExecutorServiceName }},
		{name: "wrong own service SID", mutate: func(value *Config) { value.OwnService.SID = `S-1-5-80-1-2-3-4-5` }},
		{name: "same service SID", mutate: func(value *Config) { value.PeerService.SID = value.OwnService.SID }},
		{name: "wrong pipe", mutate: func(value *Config) { value.PipeName = `\\.\pipe\other` }},
		{name: "UNC installation", mutate: func(value *Config) { value.Installation.Root = `\\server\share\app` }},
		{name: "lowercase drive", mutate: func(value *Config) { value.Installation.Root = `c:\Program Files\AgenticReview` }},
		{name: "UNC trusted configuration root", mutate: func(value *Config) {
			value.Installation.TrustedConfigurationRoot = `\\server\share\config`
		}},
		{name: "trusted configuration overlaps installation", mutate: func(value *Config) {
			value.Installation.TrustedConfigurationRoot = value.Installation.Root + `\config`
		}},
		{name: "invalid release ID", mutate: func(value *Config) { value.Installation.ReleaseID = "release 1" }},
		{name: "manifest escape", mutate: func(value *Config) { value.Installation.ManifestPath = `C:\manifest.json` }},
		{name: "signer digest", mutate: func(value *Config) {
			value.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256 = strings.Repeat("A", 64)
		}},
		{name: "reserved component", mutate: func(value *Config) { value.Node.BundlePath = `C:\Program Files\AgenticReview\Worker\CON.mjs` }},
		{name: "superscript reserved component", mutate: func(value *Config) { value.Node.BundlePath = `C:\Program Files\AgenticReview\Worker\COM¹.mjs` }},
		{name: "alternate data stream", mutate: func(value *Config) { value.Node.BundlePath += ":payload" }},
		{name: "bundle outside install", mutate: func(value *Config) { value.Node.BundlePath = `C:\Elsewhere\control.mjs` }},
		{name: "data root overlap", mutate: func(value *Config) { value.Node.DataRoot = value.Installation.Root + `\data` }},
		{name: "data root overlaps trusted configuration", mutate: func(value *Config) {
			value.Node.DataRoot = value.Installation.TrustedConfigurationRoot + `\Control`
		}},
		{name: "working directory escape", mutate: func(value *Config) { value.Node.WorkingDirectory = `C:\ProgramData\AgenticReview\Other\Work` }},
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
		{name: "missing APPDATA", mutate: func(value *Config) { delete(value.Node.Environment, "APPDATA") }},
		{name: "missing LOCALAPPDATA", mutate: func(value *Config) { delete(value.Node.Environment, "LOCALAPPDATA") }},
		{name: "unsafe PATH", mutate: func(value *Config) { value.Node.Environment["PATH"] = `C:\Trusted;;C:\Other` }},
		{name: "PATH outside installation", mutate: func(value *Config) { value.Node.Environment["PATH"] = `C:\Windows\System32` }},
		{name: "TEMP outside data root", mutate: func(value *Config) { value.Node.Environment["TEMP"] = `C:\Temp` }},
		{name: "application data outside data root", mutate: func(value *Config) { value.Node.Environment["APPDATA"] = `C:\Users\operator\AppData` }},
		{name: "WINDIR mismatch", mutate: func(value *Config) { value.Node.Environment["WINDIR"] = `D:\Windows` }},
		{name: "nil control", mutate: func(value *Config) { value.Control = nil }},
		{name: "both role objects", mutate: func(value *Config) { value.Executor = validExecutorConfiguration() }},
		{name: "HTTP server origin", mutate: func(value *Config) { value.Control.ServerOrigin = "http://review.example.test" }},
		{name: "server origin path", mutate: func(value *Config) { value.Control.ServerOrigin = "https://review.example.test/api" }},
		{name: "server origin credentials", mutate: func(value *Config) { value.Control.ServerOrigin = "https://user@review.example.test" }},
		{name: "server origin query", mutate: func(value *Config) { value.Control.ServerOrigin = "https://review.example.test?target=other" }},
		{name: "server origin uppercase", mutate: func(value *Config) { value.Control.ServerOrigin = "https://Review.example.test" }},
		{name: "server origin default port", mutate: func(value *Config) { value.Control.ServerOrigin = "https://review.example.test:443" }},
		{name: "server name mismatch", mutate: func(value *Config) { value.Control.ServerName = "other.example.test" }},
		{name: "root certificate escape", mutate: func(value *Config) { value.Control.RootCertificatePath = `C:\ProgramData\root.cer` }},
		{name: "root certificate digest", mutate: func(value *Config) { value.Control.RootCertificateSHA256 = strings.Repeat("A", 64) }},
		{name: "process limit", mutate: func(value *Config) { value.Limits.RootJobMaximumProcesses = 0 }},
		{name: "noncanonical memory", mutate: func(value *Config) { value.Limits.RootJobMaximumMemoryBytes = "0268435456" }},
		{name: "small memory", mutate: func(value *Config) { value.Limits.RootJobMaximumMemoryBytes = "1" }},
		{name: "frame limit", mutate: func(value *Config) { value.Limits.MaximumFrameBytes-- }},
		{name: "queue smaller than frame", mutate: func(value *Config) { value.Limits.MaximumQueuedBytesPerDirection = MaximumFrameBytes - 1 }},
		{name: "connect timeout", mutate: func(value *Config) { value.Limits.ConnectTimeoutMilliseconds = 999 }},
		{name: "shutdown timeout", mutate: func(value *Config) { value.Limits.ShutdownTimeoutMilliseconds = 300_001 }},
		{name: "missing force termination reserve", mutate: func(value *Config) {
			value.Limits.ForceTerminationReserveMilliseconds = 0
		}},
		{name: "force termination reserve equals total", mutate: func(value *Config) {
			value.Limits.ForceTerminationReserveMilliseconds = value.Limits.ShutdownTimeoutMilliseconds
		}},
		{name: "force termination reserve exceeds total", mutate: func(value *Config) {
			value.Limits.ForceTerminationReserveMilliseconds = value.Limits.ShutdownTimeoutMilliseconds + 1
		}},
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

func TestWorkerNodeIDAndShutdownBudgetBoundaries(t *testing.T) {
	tests := []struct {
		name    string
		worker  string
		total   uint32
		reserve uint32
	}{
		{name: "minimum", worker: "0", total: 1_000, reserve: 1},
		{name: "all entity punctuation", worker: "A.b_c:d-0", total: 1_000, reserve: 999},
		{name: "maximum", worker: "A" + strings.Repeat("z", 127), total: 300_000, reserve: 299_999},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := validConfig()
			value.WorkerNodeID = test.worker
			value.Limits.ShutdownTimeoutMilliseconds = test.total
			value.Limits.ForceTerminationReserveMilliseconds = test.reserve
			if err := value.Validate(); err != nil {
				t.Fatalf("Validate rejected a boundary value: %v", err)
			}
		})
	}
}

func TestExecutorEnvironmentAllowsOnlyItsReviewedExtensions(t *testing.T) {
	value := validExecutorConfig()
	if err := value.Validate(); err != nil {
		t.Fatalf("Validate rejected the reviewed Executor environment: %v", err)
	}
	control := validConfig()
	control.Node.Environment["CODEX_HOME"] = `C:\ProgramData\AgenticReview\Control\Codex`
	control.Node.Environment["GIT_CONFIG_NOSYSTEM"] = "1"
	control.Node.Environment["GIT_TERMINAL_PROMPT"] = "0"
	control.Node.Environment["GCM_INTERACTIVE"] = "never"
	if err := control.Validate(); err == nil {
		t.Fatal("Validate allowed Executor-only environment variables for Control")
	}
}

func TestExecutorRequiresCompleteEnvironmentAndDirectGlobalGitConfig(t *testing.T) {
	for _, name := range []string{
		"APPDATA", "LOCALAPPDATA", "HOME", "CODEX_HOME", "GIT_CONFIG_GLOBAL",
		"GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "GCM_INTERACTIVE",
	} {
		t.Run("missing "+name, func(t *testing.T) {
			value := validExecutorConfig()
			delete(value.Node.Environment, name)
			assertConfigErrorCode(t, value.Validate(), ErrorValidation)
		})
	}
	for _, path := range []string{
		`C:\ProgramData\AgenticReview\Executor\.gitconfig`,
		`C:\ProgramData\AgenticReview\Executor\Profile\Config\.gitconfig`,
	} {
		t.Run(path, func(t *testing.T) {
			value := validExecutorConfig()
			value.Node.Environment["GIT_CONFIG_GLOBAL"] = path
			assertConfigErrorCode(t, value.Validate(), ErrorValidation)
		})
	}
}

func TestExecutorConfigurationRejectsUnsafeValues(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{name: "nil executor", mutate: func(value *Config) { value.Executor = nil }},
		{name: "control object", mutate: func(value *Config) { value.Control = validControlConfiguration() }},
		{name: "policy escape", mutate: func(value *Config) { value.Executor.CodexPolicyPath = `D:\policy.toml` }},
		{name: "policy digest", mutate: func(value *Config) { value.Executor.CodexPolicySHA256 = strings.Repeat("F", 64) }},
		{name: "process host escape", mutate: func(value *Config) { value.Executor.ProcessHostPath = `C:\ProcessHost.exe` }},
		{name: "process host extension", mutate: func(value *Config) {
			value.Executor.ProcessHostPath = `C:\Program Files\AgenticReview\Worker\bin\ProcessHost.com`
		}},
		{name: "process host digest", mutate: func(value *Config) { value.Executor.ProcessHostSHA256 = "invalid" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := cloneConfig(validExecutorConfig())
			test.mutate(&value)
			assertConfigErrorCode(t, value.Validate(), ErrorValidation)
		})
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
		WorkerNodeID:  "powertoys-node:01",
		OwnService: ServiceIdentity{
			Name: ControlServiceName,
			SID:  ControlServiceSID,
		},
		PeerService: ServiceIdentity{
			Name: ExecutorServiceName,
			SID:  ExecutorServiceSID,
		},
		PipeName: ControlExecutorPipeName,
		Installation: Installation{
			Root:                     `C:\Program Files\AgenticReview\Worker`,
			TrustedConfigurationRoot: `C:\ProgramData\AgenticReview\TrustedConfig`,
			ReleaseID:                "worker-2026.08.31.1",
			ManifestPath:             `C:\Program Files\AgenticReview\Worker\release-manifest.json`,
			ManifestSHA256:           strings.Repeat("a", 64),
			ApprovedAuthenticodeSignerCertificateDERSHA256: strings.Repeat("d", 64),
		},
		Node: Node{
			ExecutablePath:   `C:\Program Files\AgenticReview\Worker\runtime\node.exe`,
			ExecutableSHA256: strings.Repeat("b", 64),
			BundlePath:       `C:\Program Files\AgenticReview\Worker\app\control.mjs`,
			BundleSHA256:     strings.Repeat("c", 64),
			DataRoot:         `C:\ProgramData\AgenticReview\Control`,
			WorkingDirectory: `C:\ProgramData\AgenticReview\Control\Work`,
			Environment: map[string]string{
				"APPDATA":      `C:\ProgramData\AgenticReview\Control\Profile\AppData`,
				"LOCALAPPDATA": `C:\ProgramData\AgenticReview\Control\Profile\LocalAppData`,
				"NODE_ENV":     "production",
				"PATH":         `C:\Program Files\AgenticReview\Worker\runtime`,
				"SYSTEMROOT":   `C:\Windows`,
				"TEMP":         `C:\ProgramData\AgenticReview\Control\Temp`,
				"TMP":          `C:\ProgramData\AgenticReview\Control\Temp`,
				"USERPROFILE":  `C:\ProgramData\AgenticReview\Control\Profile`,
			},
		},
		Control:  validControlConfiguration(),
		Executor: nil,
		Limits: Limits{
			RootJobMaximumProcesses:             128,
			RootJobMaximumMemoryBytes:           "17179869184",
			MaximumFrameBytes:                   MaximumFrameBytes,
			MaximumQueuedBytesPerDirection:      4 * 1024 * 1024,
			ConnectTimeoutMilliseconds:          30_000,
			ShutdownTimeoutMilliseconds:         120_000,
			ForceTerminationReserveMilliseconds: 15_000,
		},
	}
}

func validControlConfiguration() *ControlConfiguration {
	return &ControlConfiguration{
		ServerOrigin:                "https://review.example.test",
		ServerName:                  "review.example.test",
		RootCertificatePath:         `C:\ProgramData\AgenticReview\TrustedConfig\server-root.cer`,
		RootCertificateSHA256:       strings.Repeat("e", 64),
		WorkerAuthenticationProfile: WorkerAuthenticationProfileBearerTokenV1,
	}
}

func validExecutorConfiguration() *ExecutorConfiguration {
	return &ExecutorConfiguration{
		CodexPolicyPath:   `C:\ProgramData\AgenticReview\TrustedConfig\codex-requirements.toml`,
		CodexPolicySHA256: strings.Repeat("2", 64),
		ProcessHostPath:   `C:\Program Files\AgenticReview\Worker\bin\AgenticReview.ProcessHost.exe`,
		ProcessHostSHA256: strings.Repeat("3", 64),
	}
}

func validExecutorConfig() Config {
	value := validConfig()
	value.Role = RoleExecutor
	value.OwnService = ServiceIdentity{
		Name: ExecutorServiceName,
		SID:  ExecutorServiceSID,
	}
	value.PeerService = ServiceIdentity{
		Name: ControlServiceName,
		SID:  ControlServiceSID,
	}
	value.Node.BundlePath = `C:\Program Files\AgenticReview\Worker\app\executor.mjs`
	value.Node.DataRoot = `C:\ProgramData\AgenticReview\Executor`
	value.Node.WorkingDirectory = `C:\ProgramData\AgenticReview\Executor\Work`
	value.Node.Environment["TEMP"] = `C:\ProgramData\AgenticReview\Executor\Temp`
	value.Node.Environment["TMP"] = `C:\ProgramData\AgenticReview\Executor\Temp`
	value.Node.Environment["USERPROFILE"] = `C:\ProgramData\AgenticReview\Executor\Profile`
	value.Node.Environment["APPDATA"] = `C:\ProgramData\AgenticReview\Executor\Profile\AppData`
	value.Node.Environment["LOCALAPPDATA"] = `C:\ProgramData\AgenticReview\Executor\Profile\LocalAppData`
	value.Node.Environment["HOME"] = `C:\ProgramData\AgenticReview\Executor\Profile`
	value.Node.Environment["CODEX_HOME"] = `C:\ProgramData\AgenticReview\Executor\Codex`
	value.Node.Environment["GIT_CONFIG_GLOBAL"] = `C:\ProgramData\AgenticReview\Executor\Profile\.gitconfig`
	value.Node.Environment["GIT_CONFIG_NOSYSTEM"] = "1"
	value.Node.Environment["GIT_TERMINAL_PROMPT"] = "0"
	value.Node.Environment["GCM_INTERACTIVE"] = "never"
	value.Control = nil
	value.Executor = validExecutorConfiguration()
	return value
}

func rewriteEnvironmentRoot(environment map[string]string, oldRoot, newRoot string) {
	for name, value := range environment {
		if strings.HasPrefix(value, oldRoot+`\`) {
			environment[name] = newRoot + value[len(oldRoot):]
		}
	}
}

func cloneConfig(value Config) Config {
	copy := value
	copy.Node.Environment = make(map[string]string, len(value.Node.Environment))
	for name, environmentValue := range value.Node.Environment {
		copy.Node.Environment[name] = environmentValue
	}
	if value.Control != nil {
		control := *value.Control
		copy.Control = &control
	}
	if value.Executor != nil {
		executor := *value.Executor
		copy.Executor = &executor
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
