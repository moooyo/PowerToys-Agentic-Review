package protocol

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func interactiveWriteFixture() StdinWriteRequest {
	return StdinWriteRequest{
		ProtocolVersion: Version,
		Type:            "stdin_write",
		ID:              "process:fixture",
		StdinStreamID:   strings.Repeat("a", 64),
		Sequence:        1,
		DataBase64:      "e30K",
	}
}

func protocolJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestInteractiveStdinCapabilitiesAreExactAndOptIn(t *testing.T) {
	ordinary := ReadyCapabilities{ConcurrentRequests: true, MaximumFrameBytes: MaxFrameBytes, MaximumConcurrentRequests: 4}
	const legacy = `{"concurrentRequests":true,"maximumFrameBytes":1048576,"maximumConcurrentRequests":4}`
	if got := string(protocolJSON(t, ordinary)); got != legacy {
		t.Fatalf("legacy capabilities changed: %s", got)
	}
	capabilities := DefaultInteractiveStdinCapabilities()
	const expected = `{"version":1,"maximumChunkBytes":65536,"maximumTotalBytes":8388608,"maximumOperations":1024,"maximumPendingOperations":1,"writeTimeoutMs":10000}`
	if got := string(protocolJSON(t, capabilities)); got != expected {
		t.Fatalf("interactive capability differs from the frozen contract: %s", got)
	}
	ordinary.InteractiveStdin = capabilities
	if !bytes.Contains(protocolJSON(t, ordinary), []byte(`"interactiveStdin":`+expected)) {
		t.Fatal("interactive capability was not advertised")
	}
	capabilities.MaximumChunkBytes = 1
	if DefaultInteractiveStdinCapabilities().MaximumChunkBytes != MaxInteractiveStdinChunkBytes {
		t.Fatal("capability advertisements share mutable state")
	}
}

func TestInteractiveStdinLaunchOptInAndLegacyInputPresence(t *testing.T) {
	const start = `{"protocolVersion":"1.0","type":"start","requestId":"process:fixture","spec":{"executable":"C:\\Tools\\fixture.exe","arguments":[],"workingDirectory":"D:\\fixture","environmentMode":"replace","environment":{},"limits":{"hardTimeoutMs":60000,"maximumProcessCount":8,"maximumMemoryBytes":134217728,"maximumOutputBytes":4096}}}`
	for _, optional := range []string{"", `"standardInput":"",`, `"standardInput":"legacy",`, `"interactiveStdin":true,`} {
		frame := strings.Replace(start, `"limits":`, optional+`"limits":`, 1)
		decoded, err := DecodeRequest([]byte(frame))
		if err != nil {
			t.Fatalf("valid input mode %s rejected: %v", optional, err)
		}
		request := decoded.(StartRequest)
		if request.Spec.InteractiveStdin != strings.Contains(optional, "interactiveStdin") {
			t.Fatalf("wrong decoded input mode: %+v", request.Spec)
		}
		if optional == "" && bytes.Contains(protocolJSON(t, request.Spec), []byte("interactiveStdin")) {
			t.Fatal("legacy launch unexpectedly emits interactiveStdin")
		}
	}
	for _, optional := range []string{
		`"interactiveStdin":false,`, `"interactiveStdin":null,`, `"interactiveStdin":1,`, `"interactiveStdin":"true",`,
		`"interactiveStdin":true,"standardInput":"",`, `"interactiveStdin":true,"standardInput":"legacy",`,
		`"interactiveStdin":true,"standardInput":null,`, `"InteractiveStdin":true,`,
		`"interactiveStdin":true,"interactive\u0053tdin":true,`,
	} {
		frame := strings.Replace(start, `"limits":`, optional+`"limits":`, 1)
		if _, err := DecodeRequest([]byte(frame)); err == nil {
			t.Fatalf("invalid opt-in accepted: %s", optional)
		}
	}
	decoded, err := DecodeRequest([]byte(start))
	if err != nil {
		t.Fatal(err)
	}
	request := decoded.(StartRequest)
	empty := ""
	request.Spec.InteractiveStdin = true
	request.Spec.StandardInput = &empty
	if ValidateStartRequest(request) == nil {
		t.Fatal("typed launch with both input modes was accepted")
	}
}

func TestDecodeInteractiveStdinRequestsRetainsExactIdentity(t *testing.T) {
	write := interactiveWriteFixture()
	decoded, err := DecodeRequest(protocolJSON(t, write))
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := decoded.(StdinWriteRequest); !ok || got != write || got.RequestID() != write.ID || got.RequestType() != "stdin_write" {
		t.Fatalf("write identity changed: %#v", decoded)
	}
	closeRequest := StdinCloseRequest{
		ProtocolVersion: Version, Type: "stdin_close", ID: write.ID, StdinStreamID: write.StdinStreamID, Sequence: MaxSafeInteger,
	}
	decoded, err = DecodeRequest(protocolJSON(t, closeRequest))
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := decoded.(StdinCloseRequest); !ok || got != closeRequest || got.RequestID() != write.ID || got.RequestType() != "stdin_close" {
		t.Fatalf("close identity changed: %#v", decoded)
	}
}

func TestInteractiveStdinWriteDataPreservesBytesAndBounds(t *testing.T) {
	for _, data := range [][]byte{{0}, {0xff, 0xfe, 0, 0xc3}, []byte("{}\n"), bytes.Repeat([]byte{0xff}, MaxInteractiveStdinChunkBytes)} {
		encoded := base64.StdEncoding.EncodeToString(data)
		decoded, err := DecodeStdinWriteData(encoded)
		if err != nil || !bytes.Equal(decoded, data) {
			t.Fatalf("valid %d-byte payload changed or failed: %v", len(data), err)
		}
		request := interactiveWriteFixture()
		request.DataBase64 = encoded
		if _, err := DecodeRequest(protocolJSON(t, request)); err != nil {
			t.Fatalf("valid %d-byte wire payload rejected: %v", len(data), err)
		}
	}
	for _, encoded := range []string{"", "AA", "AA=", "AA===", "AB==", "AAB=", "_w==", "AA==\n", "AA\r\n==", " AA==", "AA== ", "é", base64.StdEncoding.EncodeToString(make([]byte, MaxInteractiveStdinChunkBytes+1))} {
		request := interactiveWriteFixture()
		request.DataBase64 = encoded
		if _, err := DecodeStdinWriteData(encoded); err == nil {
			t.Fatalf("invalid base64 payload of length %d accepted", len(encoded))
		}
		if _, err := DecodeRequest(protocolJSON(t, request)); err == nil {
			t.Fatalf("invalid wire payload of length %d accepted", len(encoded))
		}
	}
}

func TestDecodeInteractiveStdinRejectsMalformedFrames(t *testing.T) {
	valid := string(protocolJSON(t, interactiveWriteFixture()))
	mutations := []struct {
		name string
		from string
		to   string
		code string
	}{
		{"unsupported version", `"protocolVersion":"1.0"`, `"protocolVersion":"2.0"`, "UNSUPPORTED_PROTOCOL_VERSION"},
		{"missing stream", `"stdinStreamId":"` + strings.Repeat("a", 64) + `",`, "", "INVALID_REQUEST"},
		{"null stream", `"stdinStreamId":"` + strings.Repeat("a", 64) + `"`, `"stdinStreamId":null`, "INVALID_REQUEST"},
		{"uppercase stream", strings.Repeat("a", 64), strings.Repeat("A", 64), "INVALID_REQUEST"},
		{"short stream", strings.Repeat("a", 64), strings.Repeat("a", 63), "INVALID_REQUEST"},
		{"long stream", strings.Repeat("a", 64), strings.Repeat("a", 65), "INVALID_REQUEST"},
		{"nonhex stream", strings.Repeat("a", 64), strings.Repeat("g", 64), "INVALID_REQUEST"},
		{"stream newline", strings.Repeat("a", 64), strings.Repeat("a", 63) + `\n`, "INVALID_REQUEST"},
		{"missing sequence", `"sequence":1,`, "", "INVALID_REQUEST"},
		{"null sequence", `"sequence":1`, `"sequence":null`, "INVALID_REQUEST"},
		{"zero sequence", `"sequence":1`, `"sequence":0`, "INVALID_REQUEST"},
		{"negative sequence", `"sequence":1`, `"sequence":-1`, "INVALID_REQUEST"},
		{"fractional sequence", `"sequence":1`, `"sequence":1.5`, "INVALID_REQUEST"},
		{"string sequence", `"sequence":1`, `"sequence":"1"`, "INVALID_REQUEST"},
		{"unsafe sequence", `"sequence":1`, `"sequence":9007199254740992`, "INVALID_REQUEST"},
		{"overflow sequence", `"sequence":1`, `"sequence":18446744073709551616`, "INVALID_REQUEST"},
		{"duplicate sequence", `"sequence":1`, `"sequence":1,"\u0073equence":1`, "INVALID_REQUEST"},
		{"missing data", `,"dataBase64":"e30K"`, "", "INVALID_REQUEST"},
		{"null data", `"dataBase64":"e30K"`, `"dataBase64":null`, "INVALID_REQUEST"},
		{"wrong data case", `"dataBase64"`, `"DataBase64"`, "INVALID_REQUEST"},
		{"extra field", `"sequence":1`, `"sequence":1,"future":true`, "INVALID_REQUEST"},
		{"close with data", `"type":"stdin_write"`, `"type":"stdin_close"`, "INVALID_REQUEST"},
		{"invalid request ID", `"requestId":"process:fixture"`, `"requestId":"invalid id"`, "INVALID_REQUEST"},
	}
	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			_, err := DecodeRequest([]byte(strings.Replace(valid, mutation.from, mutation.to, 1)))
			var requestError *RequestError
			if !errors.As(err, &requestError) || requestError.Code != mutation.code {
				t.Fatalf("error = %v, want RequestError %s", err, mutation.code)
			}
		})
	}
	for _, frame := range []string{valid + valid, valid[:len(valid)-1], "[" + valid + "]"} {
		if _, err := DecodeRequest([]byte(frame)); err == nil {
			t.Fatal("malformed envelope accepted")
		}
	}
}

func stdinResultFixture() StdinResultEvent {
	request := interactiveWriteFixture()
	return StdinResultEvent{
		ProtocolVersion: Version, Type: "stdin_result", RequestID: request.ID,
		StdinStreamID: request.StdinStreamID, Sequence: request.Sequence,
		Operation: "write", Status: "succeeded", BytesWritten: 3, Code: nil,
	}
}

func TestInteractiveStdinResultContractAndSerialization(t *testing.T) {
	write := stdinResultFixture()
	closeEvent := write
	closeEvent.Operation, closeEvent.BytesWritten = "close", 0
	for _, event := range []StdinResultEvent{write, closeEvent} {
		if err := ValidateStdinResultEvent(event); err != nil {
			t.Fatalf("valid success rejected: %v", err)
		}
		var output bytes.Buffer
		if err := NewFrameWriter(&output, MaxFrameBytes).WriteFrame(event); err != nil {
			t.Fatal(err)
		}
		if !bytes.Contains(output.Bytes(), []byte(`"code":null`)) || !bytes.HasSuffix(output.Bytes(), []byte("\n")) {
			t.Fatalf("result did not retain explicit null code or framing: %s", output.String())
		}
	}
	for _, code := range []string{StdinNotEnabled, StdinProcessNotFound, StdinProcessNotRunning, StdinStreamMismatch, StdinSequenceMismatch, StdinBusy, StdinClosed, StdinLimitExceeded, StdinProcessExited, StdinWriteFailed, StdinWriteTimeout, StdinCloseFailed, StdinCancelled} {
		event := write
		event.Status, event.BytesWritten, event.Code = "failed", 0, &code
		if code == StdinCloseFailed {
			event.Operation = "close"
		}
		if err := ValidateStdinResultEvent(event); err != nil {
			t.Fatalf("documented result code %s rejected: %v", code, err)
		}
	}
	for _, code := range []string{StdinProcessExited, StdinWriteFailed, StdinWriteTimeout, StdinCancelled} {
		event := write
		event.Status, event.Code = "failed", &code
		if err := ValidateStdinResultEvent(event); err != nil {
			t.Fatalf("observed partial write for %s rejected: %v", code, err)
		}
	}
}

func TestInteractiveStdinResultsRejectInconsistentStates(t *testing.T) {
	unknown, failed, busy, closeFailed := "UNKNOWN", StdinWriteFailed, StdinBusy, StdinCloseFailed
	mutations := []func(*StdinResultEvent){
		func(event *StdinResultEvent) { event.ProtocolVersion = "2.0" },
		func(event *StdinResultEvent) { event.Type = "stdin_ack" },
		func(event *StdinResultEvent) { event.RequestID = "bad id" },
		func(event *StdinResultEvent) { event.StdinStreamID = strings.Repeat("A", 64) },
		func(event *StdinResultEvent) { event.Sequence = 0 },
		func(event *StdinResultEvent) { event.Sequence = MaxSafeInteger + 1 },
		func(event *StdinResultEvent) { event.Operation = "end" },
		func(event *StdinResultEvent) { event.Status = "pending" },
		func(event *StdinResultEvent) { event.BytesWritten = 0 },
		func(event *StdinResultEvent) { event.BytesWritten = MaxInteractiveStdinChunkBytes + 1 },
		func(event *StdinResultEvent) { event.Operation = "close" },
		func(event *StdinResultEvent) { event.Code = &failed },
		func(event *StdinResultEvent) { event.Status = "failed" },
		func(event *StdinResultEvent) { event.Status, event.Code = "failed", &unknown },
		func(event *StdinResultEvent) { event.Status, event.Code = "failed", &busy },
		func(event *StdinResultEvent) { event.Status, event.Code = "failed", &closeFailed },
		func(event *StdinResultEvent) {
			event.Status, event.Operation, event.BytesWritten, event.Code = "failed", "close", 0, &failed
		},
	}
	for index, mutate := range mutations {
		event := stdinResultFixture()
		mutate(&event)
		if err := ValidateStdinResultEvent(event); err == nil {
			t.Fatalf("invalid event %d accepted: %+v", index, event)
		}
		var output bytes.Buffer
		if err := NewFrameWriter(&output, MaxFrameBytes).WriteFrame(&event); err == nil || output.Len() != 0 {
			t.Fatalf("invalid event %d was emitted: %q, %v", index, output.String(), err)
		}
	}
}

func TestStartedInteractiveStreamIsOmittedUnlessPresent(t *testing.T) {
	legacy := StartedEvent{ProtocolVersion: Version, Type: "started", RequestID: "process:fixture", ProcessID: 42}
	if bytes.Contains(protocolJSON(t, legacy), []byte("stdinStreamId")) {
		t.Fatal("legacy started event advertises an input stream")
	}
	legacy.StdinStreamID = strings.Repeat("b", 64)
	if !bytes.Contains(protocolJSON(t, legacy), []byte(`"stdinStreamId":"`+legacy.StdinStreamID+`"`)) {
		t.Fatal("interactive started event did not include its exact stream ID")
	}
}
