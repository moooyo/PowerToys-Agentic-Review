package localrpc

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestDecodeControlOperations(t *testing.T) {
	tests := []struct {
		operation Operation
		payload   map[string]any
		check     func(t *testing.T, request CallRequest)
	}{
		{OperationRegister, map[string]any{"body": map[string]any{"protocolVersion": "1.0"}}, nil},
		{OperationClaim, map[string]any{"body": map[string]any{"availableSlots": 1}}, nil},
		{OperationInstanceHeartbeat, map[string]any{
			"body": map[string]any{"heartbeatSequence": 1}, "workerInstanceId": "worker-instance:1",
		}, func(t *testing.T, request CallRequest) {
			if request.WorkerInstanceID != "worker-instance:1" {
				t.Fatalf("workerInstanceId = %q", request.WorkerInstanceID)
			}
		}},
		{OperationCompleteRun, map[string]any{
			"body": map[string]any{"resultDigest": strings.Repeat("a", 64)}, "runAttemptId": "run:1",
		}, func(t *testing.T, request CallRequest) {
			if request.RunAttemptID != "run:1" {
				t.Fatalf("runAttemptId = %q", request.RunAttemptID)
			}
		}},
		{OperationFailRun, map[string]any{
			"body": map[string]any{"code": "FAILED"}, "runAttemptId": "run:2",
		}, nil},
		{OperationSignLocalDigest, map[string]any{
			"digestSha256": strings.Repeat("a", 64),
		}, func(t *testing.T, request CallRequest) {
			if !bytes.Equal(request.Digest[:], bytes.Repeat([]byte{0xaa}, 32)) {
				t.Fatalf("digest = %x", request.Digest)
			}
		}},
	}

	for _, test := range tests {
		t.Run(string(test.operation), func(t *testing.T) {
			document := canonicalForTest(t, map[string]any{
				"operation": test.operation, "payload": test.payload,
				"protocolVersion": ProtocolVersion, "requestId": "request:1", "type": "call",
			})
			message, err := DecodeMessage(document, RoleControl)
			if err != nil {
				t.Fatalf("DecodeMessage returned an error: %v", err)
			}
			request, ok := message.(CallRequest)
			if !ok || request.ID != "request:1" || request.Operation != test.operation {
				t.Fatalf("request = %#v", message)
			}
			if test.check != nil {
				test.check(t, request)
			}
		})
	}
}

func TestDecodeCancelTransportControl(t *testing.T) {
	document := canonicalForTest(t, map[string]any{
		"protocolVersion": ProtocolVersion,
		"requestId":       "cancel:1",
		"targetRequestId": "request:1",
		"type":            "cancel",
	})
	message, err := DecodeMessage(document, RoleControl)
	if err != nil {
		t.Fatal(err)
	}
	cancel, ok := message.(CancelRequest)
	if !ok || cancel.TargetRequestID != "request:1" {
		t.Fatalf("cancel = %#v", message)
	}
	if _, err := DecodeMessage(document, RoleExecutor); !errors.Is(err, ErrOperationNotAllowed) {
		t.Fatalf("executor accepted cancel control frame: %v", err)
	}
}

func TestDecodeFailsClosedForRoleOperationAndShape(t *testing.T) {
	valid := map[string]any{
		"operation": OperationRegister, "payload": map[string]any{"body": map[string]any{}},
		"protocolVersion": ProtocolVersion, "requestId": "request:1", "type": "call",
	}
	tests := []struct {
		name     string
		role     Role
		mutate   func(map[string]any)
		expected error
	}{
		{"executor role", RoleExecutor, func(map[string]any) {}, ErrOperationNotAllowed},
		{"unknown operation", RoleControl, func(value map[string]any) { value["operation"] = "OpenURL" }, ErrUnknownOperation},
		{"top-level URL", RoleControl, func(value map[string]any) { value["url"] = "https://example.test" }, ErrInvalidMessage},
		{"missing payload", RoleControl, func(value map[string]any) { delete(value, "payload") }, ErrInvalidMessage},
		{"payload command", RoleControl, func(value map[string]any) {
			value["payload"] = map[string]any{"body": map[string]any{}, "command": "cmd.exe"}
		}, ErrInvalidMessage},
		{"mis-cased outer property", RoleControl, func(value map[string]any) {
			value["Operation"] = value["operation"]
			delete(value, "operation")
		}, ErrInvalidMessage},
		{"mis-cased payload property", RoleControl, func(value map[string]any) {
			value["payload"] = map[string]any{"Body": map[string]any{}}
		}, ErrInvalidMessage},
		{"case-colliding payload properties", RoleControl, func(value map[string]any) {
			value["payload"] = map[string]any{"Body": map[string]any{}, "body": map[string]any{}}
		}, ErrInvalidMessage},
		{"signing key handle", RoleControl, func(value map[string]any) {
			value["operation"] = OperationSignLocalDigest
			value["payload"] = map[string]any{"digestSha256": strings.Repeat("a", 64), "keyHandle": 1}
		}, ErrInvalidMessage},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := cloneObjectForTest(valid)
			test.mutate(value)
			_, err := DecodeMessage(canonicalForTest(t, value), test.role)
			if !errors.Is(err, test.expected) {
				t.Fatalf("DecodeMessage error = %v, want %v", err, test.expected)
			}
		})
	}

	nonCanonical := []byte(`{"operation":"Register", "payload":{"body":{}},"protocolVersion":"1.0","requestId":"request:1","type":"call"}`)
	if _, err := DecodeMessage(nonCanonical, RoleControl); !errors.Is(err, ErrInvalidCanonicalJSON) {
		t.Fatalf("noncanonical error = %v", err)
	}
}

func TestDecodeSigningDigestIsExactlyCanonical32Bytes(t *testing.T) {
	for _, digest := range []string{strings.Repeat("a", 63), strings.Repeat("a", 65), strings.Repeat("A", 64), strings.Repeat("z", 64)} {
		document := canonicalForTest(t, map[string]any{
			"operation":       OperationSignLocalDigest,
			"payload":         map[string]any{"digestSha256": digest},
			"protocolVersion": ProtocolVersion, "requestId": "sign:1", "type": "call",
		})
		if _, err := DecodeMessage(document, RoleControl); err == nil {
			t.Errorf("DecodeMessage accepted digest %q", digest)
		}
	}
}

func TestCompleteRunUsesItsDedicatedRequestBudget(t *testing.T) {
	requestID := strings.Repeat("r", maximumIdentifierBytes)
	runAttemptID := strings.Repeat("a", maximumIdentifierBytes)
	bodyOverhead := len(`{"result":""}`)
	body := map[string]any{
		"result": strings.Repeat("x", MaximumRunCompletionRequestBodyBytes-bodyOverhead),
	}
	document := canonicalForTest(t, map[string]any{
		"operation": OperationCompleteRun,
		"payload": map[string]any{
			"body": body, "runAttemptId": runAttemptID,
		},
		"protocolVersion": ProtocolVersion,
		"requestId":       requestID,
		"type":            "call",
	})
	if len(document) != MaximumRequestFrameBytes {
		t.Fatalf("maximum completion frame has %d bytes, want %d", len(document), MaximumRequestFrameBytes)
	}
	message, err := DecodeMessage(document, RoleControl)
	if err != nil {
		t.Fatalf("maximum completion request was rejected: %v", err)
	}
	request := message.(CallRequest)
	if len(request.Body) != MaximumRunCompletionRequestBodyBytes {
		t.Fatalf("completion body has %d bytes", len(request.Body))
	}

	tooLargeBody := map[string]any{
		"result": strings.Repeat("x", MaximumRunCompletionRequestBodyBytes-bodyOverhead+1),
	}
	tooLarge := canonicalForTest(t, map[string]any{
		"operation": OperationCompleteRun,
		"payload": map[string]any{
			"body": tooLargeBody, "runAttemptId": "run:1",
		},
		"protocolVersion": ProtocolVersion,
		"requestId":       "request:1",
		"type":            "call",
	})
	if len(tooLarge) > MaximumRequestFrameBytes {
		t.Fatal("body-boundary fixture exceeded the physical request limit")
	}
	_, err = DecodeMessage(tooLarge, RoleControl)
	var protocolFailure *ProtocolError
	if !errors.As(err, &protocolFailure) || protocolFailure.Code != "REQUEST_TOO_LARGE" {
		t.Fatalf("oversized completion error = %v", err)
	}
}

func TestNonCompletionMessagesRetainTheOneMiBFrameBudget(t *testing.T) {
	largeBody := map[string]any{"value": strings.Repeat("x", MaximumFrameBytes)}
	for _, operation := range []Operation{OperationRegister, OperationFailRun} {
		payload := map[string]any{"body": largeBody}
		if operation == OperationFailRun {
			payload["runAttemptId"] = "run:1"
		}
		document := canonicalForTest(t, map[string]any{
			"operation": operation, "payload": payload,
			"protocolVersion": ProtocolVersion, "requestId": "request:1", "type": "call",
		})
		_, err := DecodeMessage(document, RoleControl)
		var protocolFailure *ProtocolError
		if !errors.As(err, &protocolFailure) || protocolFailure.Code != "REQUEST_TOO_LARGE" {
			t.Errorf("%s oversized frame error = %v", operation, err)
		}
	}

	cancel := canonicalForTest(t, map[string]any{
		"padding":         strings.Repeat("x", MaximumFrameBytes),
		"protocolVersion": ProtocolVersion,
		"requestId":       "cancel:1",
		"targetRequestId": "request:1",
		"type":            "cancel",
	})
	_, err := DecodeMessage(cancel, RoleControl)
	var protocolFailure *ProtocolError
	if !errors.As(err, &protocolFailure) || protocolFailure.Code != "REQUEST_TOO_LARGE" {
		t.Fatalf("oversized cancel error = %v", err)
	}
}

func TestClaimSuccessSeparatesBodyAndFrameBudgets(t *testing.T) {
	requestID := strings.Repeat("r", maximumIdentifierBytes)
	bodyOverhead := len(`{"value":""}`)
	body := json.RawMessage(`{"value":"` + strings.Repeat("x", MaximumClaimResponseBodyBytes-bodyOverhead) + `"}`)
	document, err := marshalSuccessResponse(
		requestID,
		body,
		MaximumClaimResponseBodyBytes,
		MaximumClaimResponseFrameBytes,
	)
	if err != nil {
		t.Fatalf("maximum claim response was rejected: %v", err)
	}
	if len(document) != MaximumClaimResponseFrameBytes {
		t.Fatalf("maximum claim frame has %d bytes, want %d", len(document), MaximumClaimResponseFrameBytes)
	}

	tooLarge := append(bytes.Clone(body[:len(body)-2]), 'x', '"', '}')
	if _, err := marshalSuccessResponse(
		requestID,
		tooLarge,
		MaximumClaimResponseBodyBytes,
		MaximumClaimResponseFrameBytes,
	); !errors.Is(err, ErrInvalidHandlerResult) {
		t.Fatalf("oversized claim body error = %v", err)
	}
}

func TestResponsesAreCanonicalAndErrorsAreSanitized(t *testing.T) {
	body := json.RawMessage(`{"value":1}`)
	success, err := MarshalSuccessResponse("request:1", body, MaximumFrameBytes)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseCanonicalJSON(success, MaximumFrameBytes); err != nil {
		t.Fatalf("success response is not canonical: %v", err)
	}

	sanitized := sanitizeOperationError(errors.New("secret=https://server.invalid token=abc"))
	response, err := MarshalErrorResponse("request:2", sanitized)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(response, []byte("secret")) || bytes.Contains(response, []byte("token")) {
		t.Fatalf("error response disclosed its cause: %s", response)
	}
	if _, err := ParseCanonicalJSON(response, MaximumFrameBytes); err != nil {
		t.Fatalf("error response is not canonical: %v", err)
	}
}

func TestSigningResponseRequiresCanonicalP1363LowS(t *testing.T) {
	valid := bytes.Repeat([]byte{1}, 64)
	if _, err := signatureBody(valid); err != nil {
		t.Fatalf("valid low-S signature was rejected: %v", err)
	}
	zeroR := bytes.Clone(valid)
	clear(zeroR[:32])
	orderR := bytes.Clone(valid)
	copy(orderR[:32], p256Order[:])
	halfOrderS := bytes.Clone(valid)
	copy(halfOrderS[32:], p256HalfOrder[:])
	if _, err := signatureBody(halfOrderS); err != nil {
		t.Fatalf("s == half order was rejected: %v", err)
	}
	highS := bytes.Clone(halfOrderS)
	for index := len(highS) - 1; index >= 32; index-- {
		highS[index]++
		if highS[index] != 0 {
			break
		}
	}
	for _, invalid := range [][]byte{nil, make([]byte, 64), zeroR, orderR, highS} {
		if _, err := signatureBody(invalid); !errors.Is(err, ErrInvalidHandlerResult) {
			t.Errorf("signatureBody error = %v, want ErrInvalidHandlerResult", err)
		}
	}
}

func canonicalForTest(t *testing.T, value any) []byte {
	t.Helper()
	document, err := MarshalCanonicalJSON(value, MaximumClaimResponseFrameBytes)
	if err != nil {
		t.Fatalf("MarshalCanonicalJSON returned an error: %v", err)
	}
	return document
}

func cloneObjectForTest(value map[string]any) map[string]any {
	result := make(map[string]any, len(value))
	for key, item := range value {
		if object, ok := item.(map[string]any); ok {
			result[key] = cloneObjectForTest(object)
		} else {
			result[key] = item
		}
	}
	return result
}
