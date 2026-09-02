package artifactrpcv2

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
)

const createCallGolden = `{"operation":"CreateArtifactUpload","payload":{"body":{"base64Url":"e30","byteLength":2,"sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"},"runAttemptId":"run:1"},"protocolVersion":"2.0","requestId":"request:1","type":"call"}`

func TestProtocolConstantsMatchTheCrossLanguageContract(t *testing.T) {
	if ProtocolVersion != "2.0" || MaximumControlRequestBodyBytes != 16_384 ||
		MaximumChunkRequestBodyBytes != 365_910 || MaximumResponseBodyBytes != 16_384 ||
		MaximumChunkIndex != 7 || MaximumControlFrameBytes != 32_768 ||
		MaximumChunkFrameBytes != 524_288 || MaximumRequestFrameBytes != 524_288 ||
		MaximumResponseFrameBytes != 32_768 {
		t.Fatal("artifact RPC v2 wire constants drifted")
	}
}

func TestDecodeCallMatchesTheCrossLanguageCreateGolden(t *testing.T) {
	document := []byte(createCallGolden)
	digest := sha256.Sum256(document)
	if hex.EncodeToString(digest[:]) != "c826868a3fc625e9b98e832d03b5d98bd0bf0e4479bc46609296d30d27ceb20a" {
		t.Fatalf("create golden digest = %x", digest)
	}
	call, err := DecodeCall(document)
	if err != nil {
		t.Fatal(err)
	}
	if call.ID != "request:1" || call.Operation != OperationCreateArtifactUpload ||
		call.RunAttemptID != "run:1" || call.UploadID != "" || call.ChunkIndex != 0 ||
		string(call.Body) != `{}` {
		t.Fatalf("decoded create call = %#v", call)
	}
}

func TestDecodeCallAcceptsExactlyFiveRouteShapes(t *testing.T) {
	tests := []struct {
		operation Operation
		payload   map[string]any
		check     func(Call) bool
	}{
		{
			operation: OperationCreateArtifactUpload,
			payload:   map[string]any{"body": descriptorFor([]byte(`{"create":true}`)), "runAttemptId": "run:1"},
			check:     func(call Call) bool { return call.RunAttemptID == "run:1" && call.UploadID == "" },
		},
		{
			operation: OperationPutArtifactChunk,
			payload:   map[string]any{"body": descriptorFor([]byte(`{"data":"YQ"}`)), "chunkIndex": 7, "uploadId": "upload:1"},
			check:     func(call Call) bool { return call.UploadID == "upload:1" && call.ChunkIndex == 7 },
		},
		{
			operation: OperationFinalizeArtifactUpload,
			payload:   map[string]any{"body": descriptorFor([]byte(`{"finalize":true}`)), "uploadId": "upload:1"},
			check:     func(call Call) bool { return call.UploadID == "upload:1" },
		},
		{
			operation: OperationTerminateArtifactUpload,
			payload:   map[string]any{"body": descriptorFor([]byte(`{"terminate":true}`)), "uploadId": "upload:1"},
			check:     func(call Call) bool { return call.UploadID == "upload:1" },
		},
		{
			operation: OperationCompleteArtifactRun,
			payload:   map[string]any{"body": descriptorFor([]byte(`{"artifactId":"artifact:1"}`)), "runAttemptId": "run:1"},
			check:     func(call Call) bool { return call.RunAttemptID == "run:1" },
		},
	}
	for _, test := range tests {
		t.Run(string(test.operation), func(t *testing.T) {
			document := marshalCallForTest(t, test.operation, "request:1", test.payload)
			call, err := DecodeCall(document)
			if err != nil || call.Operation != test.operation || !test.check(call) {
				t.Fatalf("DecodeCall returned (%#v, %v)", call, err)
			}
		})
	}
}

func TestDecodeCallEnforcesOperationBodyAndPhysicalLimits(t *testing.T) {
	exactControl := exactBody(MaximumControlRequestBodyBytes)
	exactChunk := exactBody(MaximumChunkRequestBodyBytes)
	controlDocument := marshalCallForTest(t, OperationCreateArtifactUpload, strings.Repeat("r", 128), map[string]any{
		"body": descriptorFor(exactControl), "runAttemptId": strings.Repeat("a", 128),
	})
	chunkDocument := marshalCallForTest(t, OperationPutArtifactChunk, strings.Repeat("r", 128), map[string]any{
		"body": descriptorFor(exactChunk), "chunkIndex": 7, "uploadId": strings.Repeat("u", 128),
	})
	if len(controlDocument) != 22_340 || len(chunkDocument) != 488_382 {
		t.Fatalf("valid physical maxima = control %d chunk %d", len(controlDocument), len(chunkDocument))
	}
	for _, document := range [][]byte{controlDocument, chunkDocument} {
		if _, err := DecodeCall(document); err != nil {
			t.Fatalf("exact boundary failed: %v", err)
		}
	}

	tooLargeBody := exactBody(MaximumControlRequestBodyBytes + 1)
	document := marshalCallForTest(t, OperationCreateArtifactUpload, "request:1", map[string]any{
		"body": descriptorFor(tooLargeBody), "runAttemptId": "run:1",
	})
	if _, err := DecodeCall(document); !errors.Is(err, ErrInvalidBody) {
		t.Fatalf("oversized decoded body returned %v", err)
	}

	physicalOverflow := marshalCallForTest(t, OperationCreateArtifactUpload, "request:1", map[string]any{
		"body": descriptorFor(exactBody(25_000)), "runAttemptId": "run:1",
	})
	if len(physicalOverflow) <= MaximumControlFrameBytes {
		t.Fatalf("physical overflow fixture has only %d bytes", len(physicalOverflow))
	}
	if _, err := DecodeCall(physicalOverflow); !errors.Is(err, ErrRequestTooLarge) {
		t.Fatalf("oversized control frame returned %v", err)
	}
}

func TestDecodeCallRejectsWideningAndInvalidRouteValues(t *testing.T) {
	body := descriptorFor([]byte(`{}`))
	tests := []map[string]any{
		{"operation": "Claim", "payload": map[string]any{"body": body, "runAttemptId": "run:1"}, "protocolVersion": "2.0", "requestId": "request:1", "type": "call"},
		{"operation": "CreateArtifactUpload", "payload": map[string]any{"body": body, "runAttemptId": "run:1", "url": "https://attacker.invalid"}, "protocolVersion": "2.0", "requestId": "request:1", "type": "call"},
		{"operation": "PutArtifactChunk", "payload": map[string]any{"body": body, "chunkIndex": nil, "uploadId": "upload:1"}, "protocolVersion": "2.0", "requestId": "request:1", "type": "call"},
		{"operation": "PutArtifactChunk", "payload": map[string]any{"body": body, "chunkIndex": "0", "uploadId": "upload:1"}, "protocolVersion": "2.0", "requestId": "request:1", "type": "call"},
		{"operation": "PutArtifactChunk", "payload": map[string]any{"body": body, "chunkIndex": 8, "uploadId": "upload:1"}, "protocolVersion": "2.0", "requestId": "request:1", "type": "call"},
		{"operation": "CompleteArtifactRun", "payload": map[string]any{"body": body, "runAttemptId": "../escape"}, "protocolVersion": "2.0", "requestId": "request:1", "type": "call"},
		{"operation": "CreateArtifactUpload", "payload": map[string]any{"body": body, "runAttemptId": "run:1"}, "protocolVersion": "1.0", "requestId": "request:1", "type": "call"},
	}
	for index, value := range tests {
		document, err := localrpc.MarshalCanonicalJSON(value, MaximumRequestFrameBytes)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := DecodeCall(document); err == nil {
			t.Errorf("invalid call %d was accepted", index)
		}
	}

	digestMismatch := descriptorFor([]byte(`{}`))
	digestMismatch["sha256"] = strings.Repeat("0", 64)
	document := marshalCallForTest(t, OperationCreateArtifactUpload, "request:1", map[string]any{
		"body": digestMismatch, "runAttemptId": "run:1",
	})
	if _, err := DecodeCall(document); !errors.Is(err, ErrInvalidBody) {
		t.Fatalf("digest mismatch returned %v", err)
	}
}

func TestMarshalSuccessResponseUsesTheBoundedOpaqueDescriptor(t *testing.T) {
	body := exactBody(MaximumResponseBodyBytes)
	document, err := MarshalSuccessResponse(strings.Repeat("r", 128), body)
	if err != nil {
		t.Fatal(err)
	}
	if len(document) != 22_166 || len(document) > MaximumResponseFrameBytes {
		t.Fatalf("maximum success response bytes = %d", len(document))
	}
	value, err := localrpc.ParseCanonicalJSON(document, MaximumResponseFrameBytes)
	if err != nil {
		t.Fatal(err)
	}
	object := value.(map[string]any)
	decoded, err := decodeBody(object["body"], MaximumResponseBodyBytes)
	if err != nil || !bytes.Equal(decoded, body) {
		t.Fatalf("response body round trip failed: %v", err)
	}
	if _, err := MarshalSuccessResponse("request:1", exactBody(MaximumResponseBodyBytes+1)); !errors.Is(err, ErrInvalidBody) {
		t.Fatalf("oversized response returned %v", err)
	}
}

func marshalCallForTest(t *testing.T, operation Operation, requestID string, payload map[string]any) []byte {
	t.Helper()
	document, err := localrpc.MarshalCanonicalJSON(map[string]any{
		"operation": operation, "payload": payload, "protocolVersion": ProtocolVersion,
		"requestId": requestID, "type": "call",
	}, MaximumRequestFrameBytes)
	if err != nil {
		t.Fatal(err)
	}
	return document
}

func descriptorFor(body []byte) map[string]any {
	digest := sha256.Sum256(body)
	return map[string]any{
		"base64Url": base64.RawURLEncoding.EncodeToString(body), "byteLength": len(body),
		"sha256": hex.EncodeToString(digest[:]),
	}
}

func exactBody(maximum int) json.RawMessage {
	return json.RawMessage(`{"value":"` + strings.Repeat("x", maximum-12) + `"}`)
}
