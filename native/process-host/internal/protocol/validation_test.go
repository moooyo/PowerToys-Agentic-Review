package protocol

import (
	"errors"
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
	if err := ValidateEnvironment(map[string]string{"Path": "one", "PATH": "two"}); err == nil {
		t.Fatal("expected case-insensitive collision error")
	}
	if err := ValidateEnvironment(map[string]string{"PATH": `C:\Windows`, "EMPTY": ""}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := ValidateEnvironment(map[string]string{"BAD-NAME": "value"}); err == nil {
		t.Fatal("expected invalid name error")
	}
	if err := ValidateEnvironment(map[string]string{"BAD": strings.Repeat("x", 8) + "\x00"}); err == nil {
		t.Fatal("expected NUL value error")
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
