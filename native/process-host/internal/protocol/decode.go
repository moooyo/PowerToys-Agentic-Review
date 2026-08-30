package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

type RequestError struct {
	Code      string
	RequestID *string
	Message   string
}

func (e *RequestError) Error() string {
	return e.Message
}

func DecodeRequest(frame []byte) (HostRequest, error) {
	if err := rejectDuplicateKeys(frame); err != nil {
		return nil, requestError("INVALID_REQUEST", nil, err)
	}

	var object map[string]json.RawMessage
	if err := json.Unmarshal(frame, &object); err != nil {
		return nil, requestError("INVALID_REQUEST", nil, fmt.Errorf("decode request object: %w", err))
	}
	if object == nil {
		return nil, requestError("INVALID_REQUEST", nil, errors.New("request must be a JSON object"))
	}

	requestID := extractValidRequestID(object["requestId"])
	requestType, err := requiredJSONString(object, "type")
	if err != nil {
		return nil, requestError("INVALID_REQUEST", requestID, err)
	}

	switch requestType {
	case "start":
		if err := requireProperties(object, []string{"protocolVersion", "type", "requestId", "spec"}); err != nil {
			return nil, requestError("INVALID_REQUEST", requestID, err)
		}
		if err := validateStartObjectShape(object["spec"]); err != nil {
			return nil, requestError("INVALID_REQUEST", requestID, err)
		}
		var request StartRequest
		if err := decodeStrict(frame, &request); err != nil {
			return nil, requestError("INVALID_REQUEST", requestID, err)
		}
		if err := ValidateStartRequest(request); err != nil {
			return nil, classifyValidationError(requestID, err)
		}
		return request, nil
	case "terminate":
		if err := requireProperties(object, []string{"protocolVersion", "type", "requestId", "reason"}); err != nil {
			return nil, requestError("INVALID_REQUEST", requestID, err)
		}
		var request TerminateRequest
		if err := decodeStrict(frame, &request); err != nil {
			return nil, requestError("INVALID_REQUEST", requestID, err)
		}
		if err := ValidateTerminateRequest(request); err != nil {
			return nil, classifyValidationError(requestID, err)
		}
		return request, nil
	case "shutdown":
		if err := requireProperties(object, []string{"protocolVersion", "type", "requestId"}); err != nil {
			return nil, requestError("INVALID_REQUEST", requestID, err)
		}
		var request ShutdownRequest
		if err := decodeStrict(frame, &request); err != nil {
			return nil, requestError("INVALID_REQUEST", requestID, err)
		}
		if err := ValidateShutdownRequest(request); err != nil {
			return nil, classifyValidationError(requestID, err)
		}
		return request, nil
	default:
		return nil, requestError("UNKNOWN_REQUEST_TYPE", requestID, fmt.Errorf("unknown request type %q", requestType))
	}
}

func validateStartObjectShape(rawSpec json.RawMessage) error {
	var spec map[string]json.RawMessage
	if err := json.Unmarshal(rawSpec, &spec); err != nil {
		return fmt.Errorf("spec must be an object: %w", err)
	}
	if spec == nil {
		return errors.New("spec must be an object")
	}
	if err := requirePropertiesWithOptional(
		spec,
		[]string{"executable", "arguments", "workingDirectory", "environmentMode", "environment", "limits"},
		[]string{"standardInput"},
	); err != nil {
		return fmt.Errorf("spec: %w", err)
	}
	standardInput, exists := spec["standardInput"]
	if exists && bytes.Equal(bytes.TrimSpace(standardInput), []byte("null")) {
		return errors.New("optional property \"standardInput\" must be a string when present")
	}

	var limits map[string]json.RawMessage
	if err := json.Unmarshal(spec["limits"], &limits); err != nil {
		return fmt.Errorf("spec.limits must be an object: %w", err)
	}
	if limits == nil {
		return errors.New("spec.limits must be an object")
	}
	if err := requireProperties(limits, []string{"hardTimeoutMs", "maximumProcessCount", "maximumMemoryBytes", "maximumOutputBytes"}); err != nil {
		return fmt.Errorf("spec.limits: %w", err)
	}
	return nil
}

func decodeStrict(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode request: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("request contains multiple JSON values")
		}
		return fmt.Errorf("decode trailing request data: %w", err)
	}
	return nil
}

func requireProperties(object map[string]json.RawMessage, expected []string) error {
	return requirePropertiesWithOptional(object, expected, nil)
}

func requirePropertiesWithOptional(object map[string]json.RawMessage, required, optional []string) error {
	allowed := make(map[string]struct{}, len(required)+len(optional))
	for _, property := range required {
		allowed[property] = struct{}{}
		value, exists := object[property]
		if !exists {
			return fmt.Errorf("required property %q is missing", property)
		}
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return fmt.Errorf("required property %q must not be null", property)
		}
	}
	for _, property := range optional {
		allowed[property] = struct{}{}
	}
	for property := range object {
		if _, exists := allowed[property]; !exists {
			return fmt.Errorf("unknown property %q", property)
		}
	}
	return nil
}

func requiredJSONString(object map[string]json.RawMessage, property string) (string, error) {
	raw, exists := object[property]
	if !exists {
		return "", fmt.Errorf("required property %q is missing", property)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("property %q must be a string", property)
	}
	return value, nil
}

func extractValidRequestID(raw json.RawMessage) *string {
	if len(raw) == 0 {
		return nil
	}
	var requestID string
	if err := json.Unmarshal(raw, &requestID); err != nil || ValidateRequestID(requestID) != nil {
		return nil
	}
	return &requestID
}

func classifyValidationError(requestID *string, err error) error {
	var versionError *UnsupportedVersionError
	if errors.As(err, &versionError) {
		return requestError("UNSUPPORTED_PROTOCOL_VERSION", requestID, err)
	}
	return requestError("INVALID_REQUEST", requestID, err)
}

func requestError(code string, requestID *string, err error) *RequestError {
	return &RequestError{Code: code, RequestID: requestID, Message: err.Error()}
}
