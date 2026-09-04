package localrpc

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestDecodeControlOperations(t *testing.T) {
	tests := []struct {
		operation Operation
		payload   map[string]any
		body      []byte
		check     func(t *testing.T, request CallRequest)
	}{
		{OperationRegister, map[string]any{}, []byte(crossLanguageWorkerAPIBody), nil},
		{OperationClaim, map[string]any{}, []byte(" { \"availableSlots\" : 1 } "), nil},
		{OperationInstanceHeartbeat, map[string]any{
			"workerInstanceId": "worker-instance:1",
		}, []byte(`{"heartbeatSequence":1.0}`), func(t *testing.T, request CallRequest) {
			if request.WorkerInstanceID != "worker-instance:1" {
				t.Fatalf("workerInstanceId = %q", request.WorkerInstanceID)
			}
		}},
		{OperationCompleteRun, map[string]any{
			"runAttemptId": "run:1",
		}, []byte(`{"confidence":0.8,"resultDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`), func(t *testing.T, request CallRequest) {
			if request.RunAttemptID != "run:1" {
				t.Fatalf("runAttemptId = %q", request.RunAttemptID)
			}
		}},
		{OperationFailRun, map[string]any{
			"runAttemptId": "run:2",
		}, []byte(`{"code":"FAILED"}`), nil},
	}

	for _, test := range tests {
		t.Run(string(test.operation), func(t *testing.T) {
			payload := cloneObjectForTest(test.payload)
			if test.body != nil {
				payload["body"] = rawBodyDescriptorForTest(test.body)
			}
			document := canonicalForTest(t, map[string]any{
				"operation": test.operation, "payload": payload,
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
			if test.body != nil && !bytes.Equal(request.Body, test.body) {
				t.Fatalf("body = %q, want %q", request.Body, test.body)
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
		"operation":       OperationRegister,
		"payload":         map[string]any{"body": rawBodyDescriptorForTest([]byte(`{}`))},
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
			value["payload"] = map[string]any{"body": rawBodyDescriptorForTest([]byte(`{}`)), "command": "cmd.exe"}
		}, ErrInvalidMessage},
		{"mis-cased outer property", RoleControl, func(value map[string]any) {
			value["Operation"] = value["operation"]
			delete(value, "operation")
		}, ErrInvalidMessage},
		{"mis-cased payload property", RoleControl, func(value map[string]any) {
			value["payload"] = map[string]any{"Body": rawBodyDescriptorForTest([]byte(`{}`))}
		}, ErrInvalidMessage},
		{"case-colliding payload properties", RoleControl, func(value map[string]any) {
			descriptor := rawBodyDescriptorForTest([]byte(`{}`))
			value["payload"] = map[string]any{"Body": descriptor, "body": descriptor}
		}, ErrInvalidMessage},
		{"retired signing operation", RoleControl, func(value map[string]any) {
			value["operation"] = "SignLocalDigest"
			value["payload"] = map[string]any{"digestSha256": strings.Repeat("a", 64)}
		}, ErrUnknownOperation},
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

	nonCanonical := []byte(`{"operation":"Register", "payload":{"body":{"base64Url":"e30","byteLength":2,"sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"}},"protocolVersion":"1.0","requestId":"request:1","type":"call"}`)
	if _, err := DecodeMessage(nonCanonical, RoleControl); !errors.Is(err, ErrInvalidCanonicalJSON) {
		t.Fatalf("noncanonical error = %v", err)
	}
}

func TestCompleteRunUsesItsDedicatedRequestBudget(t *testing.T) {
	requestID := strings.Repeat("r", maximumIdentifierBytes)
	runAttemptID := strings.Repeat("a", maximumIdentifierBytes)
	bodyOverhead := len(`{"result":""}`)
	body := []byte(`{"result":"` +
		strings.Repeat("x", MaximumRunCompletionRequestBodyBytes-bodyOverhead) + `"}`)
	document := canonicalForTest(t, map[string]any{
		"operation": OperationCompleteRun,
		"payload": map[string]any{
			"body": rawBodyDescriptorForTest(body), "runAttemptId": runAttemptID,
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
	if len(request.Body) != MaximumRunCompletionRequestBodyBytes || !bytes.Equal(request.Body, body) {
		t.Fatalf("completion body has %d bytes", len(request.Body))
	}

	tooLargeBody := []byte(`{"result":"` +
		strings.Repeat("x", MaximumRunCompletionRequestBodyBytes-bodyOverhead+1) + `"}`)
	tooLarge := canonicalForTest(t, map[string]any{
		"operation": OperationCompleteRun,
		"payload": map[string]any{
			"body": rawBodyDescriptorForTest(tooLargeBody), "runAttemptId": "run:1",
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

func TestOrdinaryWorkerAPIRequestUsesDescriptorFrameBudget(t *testing.T) {
	requestID := strings.Repeat("r", maximumIdentifierBytes)
	workerInstanceID := strings.Repeat("w", maximumIdentifierBytes)
	bodyOverhead := len(`{"value":""}`)
	body := []byte(`{"value":"` + strings.Repeat("x", MaximumWorkerAPIBodyBytes-bodyOverhead) + `"}`)
	document := canonicalForTest(t, map[string]any{
		"operation": OperationInstanceHeartbeat,
		"payload": map[string]any{
			"body": rawBodyDescriptorForTest(body), "workerInstanceId": workerInstanceID,
		},
		"protocolVersion": ProtocolVersion,
		"requestId":       requestID,
		"type":            "call",
	})
	if len(document) != MaximumFrameBytes {
		t.Fatalf("maximum ordinary frame has %d bytes, want %d", len(document), MaximumFrameBytes)
	}
	message, err := DecodeMessage(document, RoleControl)
	if err != nil {
		t.Fatalf("maximum ordinary request was rejected: %v", err)
	}
	request := message.(CallRequest)
	if !bytes.Equal(request.Body, body) {
		t.Fatal("maximum ordinary body was not preserved")
	}
}

func TestNonCompletionMessagesRetainTheOneMiBFrameBudget(t *testing.T) {
	largeBody := []byte(`{"value":"` + strings.Repeat("x", MaximumWorkerAPIBodyBytes) + `"}`)
	for _, operation := range []Operation{OperationRegister, OperationFailRun} {
		payload := map[string]any{"body": rawBodyDescriptorForTest(largeBody)}
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
		"padding":         strings.Repeat("x", MaximumCanonicalControlFrameBytes),
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
	body := json.RawMessage(" { \"value\" : 0.8, \"escaped\" : \"\\u0061\" } ")
	success, err := MarshalSuccessResponse("request:1", body, MaximumWorkerAPIBodyBytes)
	if err != nil {
		t.Fatal(err)
	}
	value, err := ParseCanonicalJSON(success, MaximumFrameBytes)
	if err != nil {
		t.Fatalf("success response is not canonical: %v", err)
	}
	response := value.(map[string]any)
	descriptorDocument := canonicalForTest(t, response["body"])
	decoded, err := decodeWorkerAPIBodyDescriptor(descriptorDocument, MaximumWorkerAPIBodyBytes)
	if err != nil || !bytes.Equal(decoded, body) {
		t.Fatalf("success body returned (%q, %v)", decoded, err)
	}

	sanitized := sanitizeOperationError(errors.New("secret=https://server.invalid token=abc"))
	errorResponse, err := MarshalErrorResponse("request:2", sanitized)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(errorResponse, []byte("secret")) || bytes.Contains(errorResponse, []byte("token")) {
		t.Fatalf("error response disclosed its cause: %s", errorResponse)
	}
	if _, err := ParseCanonicalJSON(errorResponse, MaximumCanonicalControlFrameBytes); err != nil {
		t.Fatalf("error response is not canonical: %v", err)
	}
}

func TestWorkerAPIBodyDescriptorMatchesCrossLanguageGolden(t *testing.T) {
	body := []byte(crossLanguageWorkerAPIBody)
	descriptor := rawBodyDescriptorForTest(body)
	if descriptor["base64Url"] !=
		"eyJjb25maWRlbmNlIjowLjgsIm1heGltdW0iOjEuNzk3NjkzMTM0ODYyMzE1N2UrMzA4LCJtaW5pbXVtIjo1ZS0zMjR9" ||
		descriptor["byteLength"] != 69 ||
		descriptor["sha256"] != "75740ca3678e2efea5c080c5950accbe75f3eeb673facefc373b9eb0ee802dba" {
		t.Fatalf("descriptor = %#v", descriptor)
	}
	document := canonicalForTest(t, descriptor)
	decoded, err := decodeWorkerAPIBodyDescriptor(document, MaximumWorkerAPIBodyBytes)
	if err != nil || !bytes.Equal(decoded, body) {
		t.Fatalf("golden descriptor returned (%q, %v)", decoded, err)
	}
}

func TestWorkerAPIBodyDescriptorRejectsTampering(t *testing.T) {
	body := []byte(`{"value":0.8}`)
	valid := rawBodyDescriptorForTest(body)
	tests := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"missing field", func(value map[string]any) { delete(value, "sha256") }},
		{"extra field", func(value map[string]any) { value["extra"] = true }},
		{"wrong length", func(value map[string]any) { value["byteLength"] = len(body) + 1 }},
		{"zero length", func(value map[string]any) { value["byteLength"] = 0 }},
		{"excess length", func(value map[string]any) { value["byteLength"] = MaximumWorkerAPIBodyBytes + 1 }},
		{"string length", func(value map[string]any) { value["byteLength"] = "13" }},
		{"padded base64", func(value map[string]any) { value["base64Url"] = value["base64Url"].(string) + "=" }},
		{"nonzero trailing bits", func(value map[string]any) { value["base64Url"] = "eB"; value["byteLength"] = 1 }},
		{"wrong digest", func(value map[string]any) { value["sha256"] = strings.Repeat("0", 64) }},
		{"uppercase digest", func(value map[string]any) { value["sha256"] = strings.ToUpper(value["sha256"].(string)) }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := cloneObjectForTest(valid)
			test.mutate(value)
			document := canonicalForTest(t, value)
			if _, err := decodeWorkerAPIBodyDescriptor(document, MaximumWorkerAPIBodyBytes); err == nil {
				t.Fatal("tampered descriptor was accepted")
			}
		})
	}
	for _, invalidBody := range [][]byte{
		[]byte(`[]`),
		[]byte(`{"value":1,"value":2}`),
		[]byte(`{"value":1e309}`),
	} {
		document := canonicalForTest(t, rawBodyDescriptorForTest(invalidBody))
		if _, err := decodeWorkerAPIBodyDescriptor(document, MaximumWorkerAPIBodyBytes); err == nil {
			t.Errorf("descriptor accepted invalid body %q", invalidBody)
		}
	}
}

func TestCanonicalControlResponseWireFormatRemainsInline(t *testing.T) {
	cancel, err := marshalCanonicalSuccessResponse("cancel:1", successBooleanBody("cancelled", true))
	if err != nil {
		t.Fatal(err)
	}
	const expectedCancel = `{"body":{"cancelled":true},"outcome":"ok","protocolVersion":"1.0","requestId":"cancel:1","type":"response"}`
	if string(cancel) != expectedCancel {
		t.Fatalf("cancel response = %s", cancel)
	}

	errorResponse, err := MarshalErrorResponse("request:1", errorBody{
		Code: "INTERNAL_ERROR", Message: "The ServiceHost operation failed.", Retryable: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	const expectedError = `{"error":{"code":"INTERNAL_ERROR","message":"The ServiceHost operation failed.","retryable":true},"outcome":"error","protocolVersion":"1.0","requestId":"request:1","type":"response"}`
	if string(errorResponse) != expectedError {
		t.Fatalf("error response = %s", errorResponse)
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

func rawBodyDescriptorForTest(body []byte) map[string]any {
	digest := sha256.Sum256(body)
	return map[string]any{
		"base64Url":  base64.RawURLEncoding.EncodeToString(body),
		"byteLength": len(body),
		"sha256":     hex.EncodeToString(digest[:]),
	}
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
