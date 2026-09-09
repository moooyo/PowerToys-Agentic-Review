package protocol

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestValidateWindowsLocalAbsolutePath(t *testing.T) {
	tests := []struct {
		name       string
		path       string
		executable bool
		valid      bool
	}{
		{name: "executable", path: `C:\Program Files\Codex\codex.exe`, executable: true, valid: true},
		{name: "forward separators", path: `D:/agent/work`, valid: true},
		{name: "drive root", path: `E:\`, valid: true},
		{name: "relative", path: `tools\codex.exe`, executable: true},
		{name: "root relative", path: `\tools\codex.exe`, executable: true},
		{name: "UNC", path: `\\server\share\codex.exe`, executable: true},
		{name: "extended device", path: `\\?\C:\tools\codex.exe`, executable: true},
		{name: "device", path: `\\.\C:\tools\codex.exe`, executable: true},
		{name: "alternate stream", path: `C:\tools\codex.exe:payload`, executable: true},
		{name: "parent component", path: `C:\tools\..\codex.exe`, executable: true},
		{name: "wrong extension", path: `C:\tools\codex.cmd`, executable: true},
		{name: "trailing dot", path: `C:\tools.\codex.exe`, executable: true},
		{name: "reserved device", path: `C:\tools\NUL.txt\codex.exe`, executable: true},
		{name: "reserved console input", path: `C:\CONIN$\codex.exe`, executable: true},
		{name: "reserved COM port", path: `C:\tools\com9.exe`, executable: true},
		{name: "non-reserved COM port", path: `C:\tools\com10\codex.exe`, executable: true, valid: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := ValidateWindowsLocalAbsolutePath(test.path, test.executable)
			if test.valid && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !test.valid && err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func TestResolveLimits(t *testing.T) {
	limits, err := ResolveLimits(ProcessResourceLimits{
		HardTimeoutMS:       30_000,
		MaximumProcessCount: 8,
		MaximumMemoryBytes:  minimumMemoryBytes,
		MaximumOutputBytes:  4096,
	})
	if err != nil {
		t.Fatal(err)
	}
	if limits.HardTimeout != 30*time.Second || limits.MaximumProcessCount != 8 || limits.MaximumMemoryBytes != minimumMemoryBytes || limits.MaximumOutputBytes != 4096 {
		t.Fatalf("unexpected effective limits: %+v", limits)
	}

	minimums := ProcessResourceLimits{
		HardTimeoutMS:       minimumHardTimeoutMS,
		MaximumProcessCount: minimumProcessCount,
		MaximumMemoryBytes:  minimumMemoryBytes,
		MaximumOutputBytes:  minimumOutputBytes,
	}
	maximums := ProcessResourceLimits{
		HardTimeoutMS:       maximumHardTimeoutMS,
		MaximumProcessCount: maximumProcessCount,
		MaximumMemoryBytes:  maximumMemoryBytes,
		MaximumOutputBytes:  maximumOutputBytes,
	}
	if _, err := ResolveLimits(minimums); err != nil {
		t.Fatalf("minimum bounds rejected: %v", err)
	}
	if _, err := ResolveLimits(maximums); err != nil {
		t.Fatalf("maximum bounds rejected: %v", err)
	}

	invalid := []ProcessResourceLimits{
		{HardTimeoutMS: minimumHardTimeoutMS - 1, MaximumProcessCount: 1, MaximumMemoryBytes: minimumMemoryBytes, MaximumOutputBytes: minimumOutputBytes},
		{HardTimeoutMS: maximumHardTimeoutMS + 1, MaximumProcessCount: 1, MaximumMemoryBytes: minimumMemoryBytes, MaximumOutputBytes: minimumOutputBytes},
		{HardTimeoutMS: minimumHardTimeoutMS, MaximumProcessCount: maximumProcessCount + 1, MaximumMemoryBytes: minimumMemoryBytes, MaximumOutputBytes: minimumOutputBytes},
		{HardTimeoutMS: minimumHardTimeoutMS, MaximumProcessCount: 1, MaximumMemoryBytes: minimumMemoryBytes - 1, MaximumOutputBytes: minimumOutputBytes},
		{HardTimeoutMS: minimumHardTimeoutMS, MaximumProcessCount: 1, MaximumMemoryBytes: maximumMemoryBytes + 1, MaximumOutputBytes: minimumOutputBytes},
		{HardTimeoutMS: minimumHardTimeoutMS, MaximumProcessCount: 1, MaximumMemoryBytes: minimumMemoryBytes, MaximumOutputBytes: minimumOutputBytes - 1},
		{HardTimeoutMS: minimumHardTimeoutMS, MaximumProcessCount: 1, MaximumMemoryBytes: minimumMemoryBytes, MaximumOutputBytes: maximumOutputBytes + 1},
	}
	for index, limits := range invalid {
		if _, err := ResolveLimits(limits); err == nil {
			t.Fatalf("invalid bounds case %d was accepted: %+v", index, limits)
		}
	}
}

func TestValidateEnvironment(t *testing.T) {
	if err := ValidateEnvironment(nil); err == nil {
		t.Fatal("expected missing environment error")
	}
	if err := ValidateEnvironment(map[string]string{}); err != nil {
		t.Fatalf("empty environment rejected: %v", err)
	}
	if err := ValidateEnvironment(map[string]string{"Path": "one", "PATH": "two"}); err == nil {
		t.Fatal("expected case-insensitive collision error")
	}
	if err := ValidateEnvironment(map[string]string{
		"PATH":                    `C:\Windows`,
		"EMPTY":                   "",
		"ProgramFiles(x86)":       `C:\Program Files (x86)`,
		"CommonProgramFiles(x86)": `C:\Program Files (x86)\Common Files`,
		"dash.dot-name":           "value",
		"CLI_TOKEN":               "synthetic",
	}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := ValidateEnvironment(map[string]string{"BAD": strings.Repeat("x", 8) + "\x00"}); err == nil {
		t.Fatal("expected NUL value error")
	}
}

func TestValidateEnvironmentNameBoundaries(t *testing.T) {
	tests := []struct {
		name  string
		value string
		valid bool
	}{
		{name: "ASCII boundary", value: strings.Repeat("a", 128), valid: true},
		{name: "ASCII overflow", value: strings.Repeat("a", 129)},
		{name: "BMP boundary", value: strings.Repeat("\u754c", 128), valid: true},
		{name: "BMP overflow", value: strings.Repeat("\u754c", 129)},
		{name: "astral boundary", value: strings.Repeat("\U0001f680", 64), valid: true},
		{name: "astral overflow", value: strings.Repeat("\U0001f680", 65)},
		{name: "mixed UTF-16 boundary", value: strings.Repeat("\U0001f680", 63) + "ab", valid: true},
		{name: "mixed UTF-16 overflow", value: strings.Repeat("\U0001f680", 64) + "a"},
		{name: "space", value: "space name", valid: true},
		{name: "digit prefix", value: "1_NAME", valid: true},
		{name: "non-control before DEL", value: "name~", valid: true},
		{name: "non-control after C1", value: "name\u00a0", valid: true},
		{name: "empty", value: ""},
		{name: "equal", value: "BAD=NAME"},
		{name: "equal prefix", value: "=C:"},
		{name: "equal suffix", value: "NAME="},
		{name: "malformed UTF-8", value: string([]byte{'B', 0xff})},
		{name: "surrogate UTF-8", value: string([]byte{0xed, 0xa0, 0x80})},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := ValidateEnvironment(map[string]string{test.value: "synthetic-secret-value"})
			if test.valid && err != nil {
				t.Fatalf("valid name rejected: %v", err)
			}
			if !test.valid && err == nil {
				t.Fatal("expected invalid name error")
			}
			if err != nil && strings.Contains(err.Error(), "synthetic-secret-value") {
				t.Fatal("validation error exposed the environment value")
			}
		})
	}
}

func TestValidateEnvironmentRejectsControlCharactersInNames(t *testing.T) {
	for character := rune(0); character <= 0x9f; character++ {
		if character > 0x1f && character < 0x7f {
			continue
		}
		t.Run(fmt.Sprintf("U+%04X", character), func(t *testing.T) {
			name := "before" + string(character) + "after"
			err := ValidateEnvironment(map[string]string{name: "synthetic-secret-value"})
			if err == nil {
				t.Fatal("expected control character in name to be rejected")
			}
			if strings.Contains(err.Error(), "synthetic-secret-value") {
				t.Fatal("validation error exposed the environment value")
			}
		})
	}
}

func TestValidateEnvironmentCountBoundary(t *testing.T) {
	environment := make(map[string]string, 513)
	for index := 0; index < 512; index++ {
		environment[fmt.Sprintf("ENV_%03d", index)] = "synthetic-secret-value"
	}
	if err := ValidateEnvironment(environment); err != nil {
		t.Fatalf("512 environment properties rejected: %v", err)
	}
	environment["EXTRA"] = "synthetic-secret-value"
	err := ValidateEnvironment(environment)
	if err == nil {
		t.Fatal("expected 513 environment properties to be rejected")
	}
	if strings.Contains(err.Error(), "synthetic-secret-value") {
		t.Fatal("validation error exposed the environment value")
	}
}

func TestValidateEnvironmentErrorsDoNotExposeValues(t *testing.T) {
	const secret = "synthetic-secret-value"
	tests := []struct {
		name        string
		environment map[string]string
	}{
		{name: "case-insensitive collision", environment: map[string]string{"Path": secret, "PATH": secret}},
		{name: "NUL value", environment: map[string]string{"CLI_TOKEN": secret + "\x00"}},
		{name: "malformed UTF-8 value", environment: map[string]string{"CLI_TOKEN": secret + string([]byte{0xff})}},
		{name: "oversized value", environment: map[string]string{"CLI_TOKEN": secret + strings.Repeat("x", maximumBoundedTextUnits)}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := ValidateEnvironment(test.environment)
			if err == nil {
				t.Fatal("expected invalid environment error")
			}
			if strings.Contains(err.Error(), secret) {
				t.Fatal("validation error exposed the environment value")
			}
		})
	}
}

func TestValidateStandardInputUsesUTF8ByteLimit(t *testing.T) {
	exactASCII := strings.Repeat("a", maximumStandardInputBytes)
	if err := validateStandardInput(exactASCII); err != nil {
		t.Fatalf("exact ASCII boundary rejected: %v", err)
	}
	exactMultibyte := strings.Repeat("\u00e9", maximumStandardInputBytes/2)
	if len(exactMultibyte) != maximumStandardInputBytes {
		t.Fatalf("test input has %d bytes, want %d", len(exactMultibyte), maximumStandardInputBytes)
	}
	if err := validateStandardInput(exactMultibyte); err != nil {
		t.Fatalf("exact multibyte boundary rejected: %v", err)
	}
	if err := validateStandardInput(exactASCII + "a"); err == nil {
		t.Fatal("expected input above the UTF-8 byte limit to be rejected")
	}
}

func TestDecodeRequestIsStrictAndSchemaCompatible(t *testing.T) {
	valid := `{"protocolVersion":"1.0","type":"start","requestId":"review-42","spec":{"executable":"C:\\Tools\\codex.exe","arguments":["exec","-"],"workingDirectory":"D:\\work\\42","environmentMode":"replace","environment":{"PATH":"C:\\Windows"},"standardInput":"review this","limits":{"hardTimeoutMs":60000,"maximumProcessCount":32,"maximumMemoryBytes":8589934592,"maximumOutputBytes":67108864}}}`
	request, err := DecodeRequest([]byte(valid))
	if err != nil {
		t.Fatal(err)
	}
	start, ok := request.(StartRequest)
	if !ok || start.ID != "review-42" || start.Spec.EnvironmentMode != "replace" {
		t.Fatalf("unexpected request: %#v", request)
	}

	tests := []struct {
		name string
		json string
		code string
	}{
		{name: "duplicate", json: `{"protocolVersion":"1.0","type":"shutdown","requestId":"one","requestId":"two"}`, code: "INVALID_REQUEST"},
		{name: "unknown", json: `{"protocolVersion":"1.0","type":"shutdown","requestId":"one","extra":true}`, code: "INVALID_REQUEST"},
		{name: "wrong version", json: `{"protocolVersion":"2.0","type":"shutdown","requestId":"one"}`, code: "UNSUPPORTED_PROTOCOL_VERSION"},
		{name: "invalid id", json: `{"protocolVersion":"1.0","type":"shutdown","requestId":"bad id"}`, code: "INVALID_REQUEST"},
		{name: "unknown type", json: `{"protocolVersion":"1.0","type":"launch","requestId":"one"}`, code: "UNKNOWN_REQUEST_TYPE"},
		{name: "null standard input", json: `{"protocolVersion":"1.0","type":"start","requestId":"one","spec":{"executable":"C:\\Tools\\codex.exe","arguments":[],"workingDirectory":"D:\\work","environmentMode":"replace","environment":{},"standardInput":null,"limits":{"hardTimeoutMs":1,"maximumProcessCount":1,"maximumMemoryBytes":1,"maximumOutputBytes":1}}}`, code: "INVALID_REQUEST"},
		{name: "wrong nested property case", json: `{"protocolVersion":"1.0","type":"start","requestId":"one","spec":{"Executable":"C:\\Tools\\codex.exe","arguments":[],"workingDirectory":"D:\\work","environmentMode":"replace","environment":{},"limits":{"hardTimeoutMs":1,"maximumProcessCount":1,"maximumMemoryBytes":1,"maximumOutputBytes":1}}}`, code: "INVALID_REQUEST"},
		{name: "unknown limits property", json: `{"protocolVersion":"1.0","type":"start","requestId":"one","spec":{"executable":"C:\\Tools\\codex.exe","arguments":[],"workingDirectory":"D:\\work","environmentMode":"replace","environment":{},"limits":{"hardTimeoutMs":1,"maximumProcessCount":1,"maximumMemoryBytes":1,"maximumOutputBytes":1,"future":1}}}`, code: "INVALID_REQUEST"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := DecodeRequest([]byte(test.json))
			var requestErr *RequestError
			if !errors.As(err, &requestErr) {
				t.Fatalf("error = %v, want RequestError", err)
			}
			if requestErr.Code != test.code {
				t.Fatalf("code = %q, want %q", requestErr.Code, test.code)
			}
		})
	}
}
