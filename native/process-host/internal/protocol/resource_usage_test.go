package protocol

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestDecodeResourceUsageCaptureRequiresExplicitTrue(t *testing.T) {
	for _, property := range []string{"", `,"captureResourceUsage":true`, `,"captureResourceUsage":false`, `,"captureResourceUsage":null`, `,"captureResourceUsage":"true"`, `,"captureResourceUsage":1`} {
		frame := fmt.Sprintf(`{"protocolVersion":"1.0","type":"start","requestId":"usage:one","spec":{"executable":"C:\\Tools\\fixture.exe","arguments":[],"workingDirectory":"C:\\work","environmentMode":"replace","environment":{}%s,"limits":{"hardTimeoutMs":10000,"maximumProcessCount":1,"maximumMemoryBytes":134217728,"maximumOutputBytes":4096}}}`, property)
		request, err := DecodeRequest([]byte(frame))
		valid := property == "" || property == `,"captureResourceUsage":true`
		if (err == nil) != valid {
			t.Fatalf("property %q: error = %v, valid = %v", property, err, valid)
		}
		if valid && request.(StartRequest).Spec.CaptureResourceUsage != (property != "") {
			t.Fatalf("property %q: unexpected capture flag", property)
		}
	}
}

func TestResourceUsageFieldsAreOmittedFromLegacyProtocol(t *testing.T) {
	for _, value := range []any{ProcessLaunchSpec{}, ExitedEvent{}} {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(encoded), "captureResourceUsage") || strings.Contains(string(encoded), "resourceUsage") {
			t.Fatalf("legacy value includes resource diagnostics: %s", encoded)
		}
	}
}
