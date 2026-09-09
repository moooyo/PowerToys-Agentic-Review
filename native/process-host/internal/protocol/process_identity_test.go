package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
)

func TestDecodeCaptureProcessIdentityRequiresTrueWhenPresent(t *testing.T) {
	for _, test := range []struct {
		name     string
		property string
		valid    bool
		capture  bool
	}{
		{name: "omitted", valid: true},
		{name: "true", property: `,"captureProcessIdentity":true`, valid: true, capture: true},
		{name: "false", property: `,"captureProcessIdentity":false`},
		{name: "null", property: `,"captureProcessIdentity":null`},
		{name: "string", property: `,"captureProcessIdentity":"true"`},
		{name: "number", property: `,"captureProcessIdentity":1`},
		{name: "object", property: `,"captureProcessIdentity":{}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			frame := fmt.Sprintf(`{"protocolVersion":"1.0","type":"start","requestId":"identity:one","spec":{"executable":"C:\\Tools\\codex.exe","arguments":[],"workingDirectory":"C:\\work","environmentMode":"replace","environment":{}%s,"limits":{"hardTimeoutMs":10000,"maximumProcessCount":1,"maximumMemoryBytes":134217728,"maximumOutputBytes":4096}}}`, test.property)
			request, err := DecodeRequest([]byte(frame))
			if test.valid {
				if err != nil {
					t.Fatal(err)
				}
				if got := request.(StartRequest).Spec.CaptureProcessIdentity; got != test.capture {
					t.Fatalf("CaptureProcessIdentity = %v, want %v", got, test.capture)
				}
				return
			}
			var requestErr *RequestError
			if !errors.As(err, &requestErr) || requestErr.Code != "INVALID_REQUEST" {
				t.Fatalf("decode error = %v, want INVALID_REQUEST", err)
			}
		})
	}
}

func TestIdentityFieldsAreOmittedFromLegacyProtocol(t *testing.T) {
	for _, value := range []any{
		ProcessLaunchSpec{},
		StartedEvent{ProtocolVersion: Version, Type: "started", RequestID: "identity:legacy", ProcessID: 42},
	} {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		var object map[string]json.RawMessage
		if err := json.Unmarshal(encoded, &object); err != nil {
			t.Fatal(err)
		}
		for _, property := range []string{"captureProcessIdentity", "processCreationTimeFileTime"} {
			if _, exists := object[property]; exists {
				t.Fatalf("legacy %T includes %s: %s", value, property, encoded)
			}
		}
	}
}
