package localrpc

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"unicode/utf8"
)

const ProtocolVersion = "1.0"

type Role string

const (
	RoleControl  Role = "control"
	RoleExecutor Role = "executor"
)

type Operation string

const (
	OperationRegister          Operation = "Register"
	OperationClaim             Operation = "Claim"
	OperationInstanceHeartbeat Operation = "InstanceHeartbeat"
	OperationCompleteRun       Operation = "CompleteRun"
	OperationFailRun           Operation = "FailRun"
	OperationArmArwxShutdown   Operation = "ArmArwxShutdown"
)

var (
	ErrInvalidMessage       = errors.New("invalid local RPC message")
	ErrUnknownMessageType   = errors.New("unknown local RPC message type")
	ErrUnknownOperation     = errors.New("unknown local RPC operation")
	ErrOperationNotAllowed  = errors.New("local RPC operation is not allowed for this role")
	ErrDuplicateRequestID   = errors.New("local RPC requestId was already used")
	ErrRequestIDCapacity    = errors.New("local RPC requestId capacity is exhausted")
	ErrRequestNotActive     = errors.New("local RPC target request is not active")
	ErrRequestCancelled     = errors.New("local RPC request was cancelled")
	ErrRequestTimeout       = errors.New("local RPC request timed out")
	ErrResponseTooLarge     = errors.New("local RPC response exceeds its byte limit")
	ErrInvalidHandlerResult = errors.New("local RPC handler returned an invalid result")
)

type Message interface {
	RequestID() string
	messageType() string
}

type CallRequest struct {
	ID               string
	Operation        Operation
	Body             json.RawMessage
	WorkerInstanceID string
	RunAttemptID     string
	ArwxShutdown     ArmArwxShutdownV1
}

func (r CallRequest) RequestID() string   { return r.ID }
func (r CallRequest) messageType() string { return "call" }

type CancelRequest struct {
	ID              string
	TargetRequestID string
}

func (r CancelRequest) RequestID() string   { return r.ID }
func (r CancelRequest) messageType() string { return "cancel" }

type ProtocolError struct {
	Code      string
	Message   string
	RequestID string
	Cause     error
}

func (e *ProtocolError) Error() string { return e.Message }
func (e *ProtocolError) Unwrap() error { return e.Cause }

// PublicError is the only handler error form whose text may cross to the Node payload.
type PublicError struct {
	Code      string
	Message   string
	Retryable bool
}

func (e *PublicError) Error() string { return e.Message }

func NewPublicError(code, message string, retryable bool) error {
	return &PublicError{Code: code, Message: message, Retryable: retryable}
}

type errorBody struct {
	Code      string
	Message   string
	Retryable bool
}

// DecodeMessage parses a canonical request and applies the role-specific operation allowlist.
func DecodeMessage(document []byte, role Role) (Message, error) {
	value, err := ParseCanonicalJSON(document, MaximumRequestFrameBytes)
	if err != nil {
		return nil, protocolError("INVALID_CANONICAL_JSON", "Local RPC input is not canonical JSON.", "", err)
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, protocolError("INVALID_MESSAGE", "Local RPC input must be an object.", "", ErrInvalidMessage)
	}
	requestID := validRequestIDFromObject(object)
	messageType, ok := object["type"].(string)
	if !ok {
		return nil, protocolError("INVALID_MESSAGE", "Local RPC message type is missing.", requestID, ErrInvalidMessage)
	}
	if role != RoleControl && role != RoleExecutor {
		return nil, protocolError(
			"OPERATION_NOT_ALLOWED",
			"Local RPC messages are not allowed for this service role.",
			requestID,
			ErrOperationNotAllowed,
		)
	}

	switch messageType {
	case "call":
		return decodeCall(document, requestID, role)
	case "cancel":
		if role != RoleControl {
			return nil, protocolError(
				"OPERATION_NOT_ALLOWED",
				"Local RPC cancellation is not allowed for this service role.",
				requestID,
				ErrOperationNotAllowed,
			)
		}
		if len(document) > MaximumCanonicalControlFrameBytes {
			return nil, requestTooLargeError(requestID)
		}
		return decodeCancel(document, requestID)
	default:
		return nil, protocolError("UNKNOWN_MESSAGE_TYPE", "Local RPC message type is not supported.", requestID, ErrUnknownMessageType)
	}
}

type wireCall struct {
	ProtocolVersion string          `json:"protocolVersion"`
	Type            string          `json:"type"`
	RequestID       string          `json:"requestId"`
	Operation       Operation       `json:"operation"`
	Payload         json.RawMessage `json:"payload"`
}

type bodyPayload struct {
	Body json.RawMessage `json:"body"`
}

type heartbeatPayload struct {
	Body             json.RawMessage `json:"body"`
	WorkerInstanceID string          `json:"workerInstanceId"`
}

type runPayload struct {
	Body         json.RawMessage `json:"body"`
	RunAttemptID string          `json:"runAttemptId"`
}

type armArwxShutdownPayload struct {
	BootstrapID         string `json:"bootstrapId"`
	ShutdownID          string `json:"shutdownId"`
	RemainingShutdownMS int    `json:"remainingShutdownMs"`
	FinalMessageType    int    `json:"finalMessageType"`
	FinalSequence       string `json:"finalSequence"`
	FinalCorrelationID  string `json:"finalCorrelationId"`
	FinalFrameBytes     int    `json:"finalFrameBytes"`
	FinalFrameSHA256    string `json:"finalFrameSha256"`
}

type bodyDescriptor struct {
	Base64URL  string `json:"base64Url"`
	ByteLength int    `json:"byteLength"`
	SHA256     string `json:"sha256"`
}

func decodeCall(document []byte, extractedRequestID string, role Role) (Message, error) {
	if !hasExactObjectKeys(document, MaximumRequestFrameBytes, "operation", "payload", "protocolVersion", "requestId", "type") {
		return nil, protocolError("INVALID_MESSAGE", "Local RPC call shape is invalid.", extractedRequestID, ErrInvalidMessage)
	}
	var wire wireCall
	if err := decodeExact(document, &wire); err != nil {
		return nil, protocolError("INVALID_MESSAGE", "Local RPC call shape is invalid.", extractedRequestID, errors.Join(ErrInvalidMessage, err))
	}
	if wire.ProtocolVersion != ProtocolVersion || wire.Type != "call" {
		return nil, protocolError("INVALID_MESSAGE", "Local RPC call version or type is invalid.", extractedRequestID, ErrInvalidMessage)
	}
	if err := validateRequestID(wire.RequestID); err != nil {
		return nil, protocolError("INVALID_REQUEST_ID", "Local RPC requestId is invalid.", "", err)
	}
	if wire.Operation != OperationArmArwxShutdown && role != RoleControl {
		return nil, protocolError(
			"OPERATION_NOT_ALLOWED",
			"Local RPC operation is not allowed for this service role.",
			wire.RequestID,
			ErrOperationNotAllowed,
		)
	}
	maximumFrameBytes := MaximumFrameBytes
	if wire.Operation == OperationCompleteRun {
		maximumFrameBytes = MaximumRequestFrameBytes
	} else if wire.Operation == OperationArmArwxShutdown {
		maximumFrameBytes = MaximumArmArwxShutdownBytes
	}
	if len(document) > maximumFrameBytes {
		return nil, requestTooLargeError(wire.RequestID)
	}
	request := CallRequest{ID: wire.RequestID, Operation: wire.Operation}
	switch wire.Operation {
	case OperationRegister, OperationClaim:
		if !hasExactObjectKeys(wire.Payload, maximumFrameBytes, "body") {
			return nil, protocolError("INVALID_PAYLOAD", "Local RPC operation payload is invalid.", wire.RequestID, ErrInvalidMessage)
		}
		var payload bodyPayload
		if err := decodeExact(wire.Payload, &payload); err != nil {
			return nil, protocolError("INVALID_PAYLOAD", "Local RPC operation payload is invalid.", wire.RequestID, ErrInvalidMessage)
		}
		body, err := decodeWorkerAPIBodyDescriptor(payload.Body, MaximumWorkerAPIBodyBytes)
		if errors.Is(err, ErrWorkerAPIBodyLimit) {
			return nil, requestTooLargeError(wire.RequestID)
		}
		if err != nil {
			return nil, protocolError("INVALID_PAYLOAD", "Local RPC operation payload is invalid.", wire.RequestID, ErrInvalidMessage)
		}
		request.Body = body
	case OperationInstanceHeartbeat:
		if !hasExactObjectKeys(wire.Payload, maximumFrameBytes, "body", "workerInstanceId") {
			return nil, protocolError("INVALID_PAYLOAD", "Local RPC operation payload is invalid.", wire.RequestID, ErrInvalidMessage)
		}
		var payload heartbeatPayload
		if err := decodeExact(wire.Payload, &payload); err != nil {
			return nil, protocolError("INVALID_PAYLOAD", "Local RPC operation payload is invalid.", wire.RequestID, ErrInvalidMessage)
		}
		body, err := decodeWorkerAPIBodyDescriptor(payload.Body, MaximumWorkerAPIBodyBytes)
		if errors.Is(err, ErrWorkerAPIBodyLimit) {
			return nil, requestTooLargeError(wire.RequestID)
		}
		if err != nil {
			return nil, protocolError("INVALID_PAYLOAD", "Local RPC operation payload is invalid.", wire.RequestID, ErrInvalidMessage)
		}
		if err := validateEntityID(payload.WorkerInstanceID); err != nil {
			return nil, protocolError("INVALID_PAYLOAD", "Local RPC workerInstanceId is invalid.", wire.RequestID, err)
		}
		request.Body = body
		request.WorkerInstanceID = payload.WorkerInstanceID
	case OperationCompleteRun, OperationFailRun:
		if !hasExactObjectKeys(wire.Payload, maximumFrameBytes, "body", "runAttemptId") {
			return nil, protocolError("INVALID_PAYLOAD", "Local RPC operation payload is invalid.", wire.RequestID, ErrInvalidMessage)
		}
		var payload runPayload
		if err := decodeExact(wire.Payload, &payload); err != nil {
			return nil, protocolError("INVALID_PAYLOAD", "Local RPC operation payload is invalid.", wire.RequestID, ErrInvalidMessage)
		}
		maximumBodyBytes := MaximumWorkerAPIBodyBytes
		if wire.Operation == OperationCompleteRun {
			maximumBodyBytes = MaximumRunCompletionRequestBodyBytes
		}
		body, err := decodeWorkerAPIBodyDescriptor(payload.Body, maximumBodyBytes)
		if errors.Is(err, ErrWorkerAPIBodyLimit) {
			return nil, requestTooLargeError(wire.RequestID)
		}
		if err != nil {
			return nil, protocolError("INVALID_PAYLOAD", "Local RPC operation payload is invalid.", wire.RequestID, ErrInvalidMessage)
		}
		if err := validateEntityID(payload.RunAttemptID); err != nil {
			return nil, protocolError("INVALID_PAYLOAD", "Local RPC runAttemptId is invalid.", wire.RequestID, err)
		}
		request.Body = body
		request.RunAttemptID = payload.RunAttemptID
	case OperationArmArwxShutdown:
		if !hasExactObjectKeys(
			wire.Payload,
			MaximumArmArwxShutdownBytes,
			"bootstrapId", "finalCorrelationId", "finalFrameBytes", "finalFrameSha256",
			"finalMessageType", "finalSequence", "remainingShutdownMs", "shutdownId",
		) {
			return nil, protocolError("INVALID_PAYLOAD", "ArmArwxShutdownV1 payload is invalid.", wire.RequestID, ErrArwxShutdownInvalid)
		}
		var payload armArwxShutdownPayload
		if err := decodeExact(wire.Payload, &payload); err != nil {
			return nil, protocolError("INVALID_PAYLOAD", "ArmArwxShutdownV1 payload is invalid.", wire.RequestID, ErrArwxShutdownInvalid)
		}
		claim := ArmArwxShutdownV1(payload)
		if err := validateArmArwxShutdownSyntax(
			claim,
			role,
			RuntimeBootstrapARWXMaximumFrameBytes,
			RuntimeBootstrapMaximumGracefulTimeoutMS-RuntimeBootstrapMinimumForceTerminationReserve,
		); err != nil {
			return nil, protocolError("INVALID_PAYLOAD", "ArmArwxShutdownV1 payload is invalid.", wire.RequestID, err)
		}
		request.ArwxShutdown = claim
	default:
		return nil, protocolError("UNKNOWN_OPERATION", "Local RPC operation is not supported.", wire.RequestID, ErrUnknownOperation)
	}
	return request, nil
}

type wireCancel struct {
	ProtocolVersion string `json:"protocolVersion"`
	Type            string `json:"type"`
	RequestID       string `json:"requestId"`
	TargetRequestID string `json:"targetRequestId"`
}

func decodeCancel(document []byte, extractedRequestID string) (Message, error) {
	if !hasExactObjectKeys(document, MaximumCanonicalControlFrameBytes, "protocolVersion", "requestId", "targetRequestId", "type") {
		return nil, protocolError("INVALID_MESSAGE", "Local RPC cancel shape is invalid.", extractedRequestID, ErrInvalidMessage)
	}
	var wire wireCancel
	if err := decodeExact(document, &wire); err != nil {
		return nil, protocolError("INVALID_MESSAGE", "Local RPC cancel shape is invalid.", extractedRequestID, errors.Join(ErrInvalidMessage, err))
	}
	if wire.ProtocolVersion != ProtocolVersion || wire.Type != "cancel" {
		return nil, protocolError("INVALID_MESSAGE", "Local RPC cancel version or type is invalid.", extractedRequestID, ErrInvalidMessage)
	}
	if err := validateRequestID(wire.RequestID); err != nil {
		return nil, protocolError("INVALID_REQUEST_ID", "Local RPC requestId is invalid.", "", err)
	}
	if err := validateRequestID(wire.TargetRequestID); err != nil || wire.TargetRequestID == wire.RequestID {
		return nil, protocolError("INVALID_TARGET_REQUEST_ID", "Local RPC cancel target is invalid.", wire.RequestID, ErrInvalidMessage)
	}
	return CancelRequest{ID: wire.RequestID, TargetRequestID: wire.TargetRequestID}, nil
}

func MarshalSuccessResponse(requestID string, body json.RawMessage, maximumBodyBytes int) ([]byte, error) {
	frameMaximumBytes := MaximumFrameBytes
	if maximumBodyBytes == MaximumClaimResponseBodyBytes {
		frameMaximumBytes = MaximumClaimResponseFrameBytes
	} else if maximumBodyBytes != MaximumWorkerAPIBodyBytes {
		return nil, errors.New("unsupported Worker API success body limit")
	}
	return marshalSuccessResponse(requestID, body, maximumBodyBytes, frameMaximumBytes)
}

func marshalSuccessResponse(
	requestID string,
	body json.RawMessage,
	bodyMaximumBytes int,
	frameMaximumBytes int,
) ([]byte, error) {
	if err := validateRequestID(requestID); err != nil {
		return nil, err
	}
	descriptor, err := describeWorkerAPIBody(body, bodyMaximumBytes)
	if err != nil {
		return nil, ErrInvalidHandlerResult
	}
	return MarshalCanonicalJSON(map[string]any{
		"body":            descriptor,
		"outcome":         "ok",
		"protocolVersion": ProtocolVersion,
		"requestId":       requestID,
		"type":            "response",
	}, frameMaximumBytes)
}

func marshalCanonicalSuccessResponse(requestID string, body json.RawMessage) ([]byte, error) {
	if err := validateRequestID(requestID); err != nil {
		return nil, err
	}
	value, err := ParseCanonicalJSON(body, MaximumCanonicalControlFrameBytes)
	if err != nil {
		return nil, ErrInvalidHandlerResult
	}
	if _, ok := value.(map[string]any); !ok {
		return nil, ErrInvalidHandlerResult
	}
	return MarshalCanonicalJSON(map[string]any{
		"body":            value,
		"outcome":         "ok",
		"protocolVersion": ProtocolVersion,
		"requestId":       requestID,
		"type":            "response",
	}, MaximumCanonicalControlFrameBytes)
}

func describeWorkerAPIBody(body []byte, maximumBytes int) (map[string]any, error) {
	snapshot, err := CopyWorkerAPIBody(body, maximumBytes)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(snapshot)
	return map[string]any{
		"base64Url":  base64.RawURLEncoding.EncodeToString(snapshot),
		"byteLength": len(snapshot),
		"sha256":     hex.EncodeToString(digest[:]),
	}, nil
}

func decodeWorkerAPIBodyDescriptor(document []byte, maximumBytes int) (json.RawMessage, error) {
	if !hasExactObjectKeys(
		document,
		MaximumClaimResponseFrameBytes,
		"base64Url",
		"byteLength",
		"sha256",
	) {
		return nil, ErrInvalidWorkerAPIBody
	}
	var descriptor bodyDescriptor
	if err := decodeExact(document, &descriptor); err != nil {
		return nil, ErrInvalidWorkerAPIBody
	}
	if descriptor.ByteLength < 1 {
		return nil, ErrInvalidWorkerAPIBody
	}
	if descriptor.ByteLength > maximumBytes {
		return nil, ErrWorkerAPIBodyLimit
	}
	encoding := base64.RawURLEncoding.Strict()
	if len(descriptor.Base64URL) != encoding.EncodedLen(descriptor.ByteLength) {
		return nil, ErrInvalidWorkerAPIBody
	}
	body, err := encoding.DecodeString(descriptor.Base64URL)
	if err != nil || len(body) != descriptor.ByteLength ||
		encoding.EncodeToString(body) != descriptor.Base64URL {
		return nil, ErrInvalidWorkerAPIBody
	}
	expectedDigest, err := decodeDigest(descriptor.SHA256)
	if err != nil {
		return nil, ErrInvalidWorkerAPIBody
	}
	digest := sha256.Sum256(body)
	if subtle.ConstantTimeCompare(digest[:], expectedDigest[:]) != 1 {
		return nil, ErrInvalidWorkerAPIBody
	}
	if err := validateWorkerAPIBody(body); err != nil {
		return nil, err
	}
	return json.RawMessage(body), nil
}

func MarshalErrorResponse(requestID string, publicError errorBody) ([]byte, error) {
	if err := validateRequestID(requestID); err != nil {
		return nil, err
	}
	if !validErrorCode(publicError.Code) || !validPublicMessage(publicError.Message) {
		return nil, errors.New("local RPC public error is invalid")
	}
	return MarshalCanonicalJSON(map[string]any{
		"error": map[string]any{
			"code":      publicError.Code,
			"message":   publicError.Message,
			"retryable": publicError.Retryable,
		},
		"outcome":         "error",
		"protocolVersion": ProtocolVersion,
		"requestId":       requestID,
		"type":            "response",
	}, MaximumCanonicalControlFrameBytes)
}

func successBooleanBody(name string, value bool) json.RawMessage {
	document, _ := MarshalCanonicalJSON(map[string]any{name: value}, MaximumCanonicalControlFrameBytes)
	return document
}

func sanitizeOperationError(err error) errorBody {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, ErrRequestTimeout) {
		return errorBody{Code: "REQUEST_TIMEOUT", Message: "The local RPC operation timed out.", Retryable: true}
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, ErrRequestCancelled) {
		return errorBody{Code: "REQUEST_CANCELLED", Message: "The local RPC operation was cancelled.", Retryable: true}
	}
	var publicError *PublicError
	if errors.As(err, &publicError) && publicError != nil && validErrorCode(publicError.Code) && validPublicMessage(publicError.Message) {
		return errorBody{Code: publicError.Code, Message: publicError.Message, Retryable: publicError.Retryable}
	}
	return errorBody{Code: "INTERNAL_ERROR", Message: "The ServiceHost operation failed.", Retryable: true}
}

func protocolError(code, message, requestID string, cause error) *ProtocolError {
	return &ProtocolError{Code: code, Message: message, RequestID: requestID, Cause: cause}
}

func decodeExact(document []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func hasExactObjectKeys(document []byte, maximumBytes int, expected ...string) bool {
	value, err := ParseCanonicalJSON(document, maximumBytes)
	if err != nil {
		return false
	}
	object, ok := value.(map[string]any)
	if !ok || len(object) != len(expected) {
		return false
	}
	for _, key := range expected {
		if _, exists := object[key]; !exists {
			return false
		}
	}
	return true
}

func requestTooLargeError(requestID string) *ProtocolError {
	return protocolError(
		"REQUEST_TOO_LARGE",
		"Local RPC request exceeds its byte limit.",
		requestID,
		ErrCanonicalJSONLimit,
	)
}

func decodeDigest(value string) ([32]byte, error) {
	var result [32]byte
	if len(value) != hex.EncodedLen(len(result)) || strings.ToLower(value) != value {
		return result, errors.New("digest is not canonical lowercase hexadecimal")
	}
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != len(result) {
		return result, errors.New("digest is not a 32-byte value")
	}
	copy(result[:], decoded)
	return result, nil
}

func validateRequestID(value string) error {
	if len(value) == 0 || len(value) > 128 || !asciiAlphaNumeric(value[0]) {
		return errors.New("requestId is outside the supported syntax")
	}
	for index := 1; index < len(value); index++ {
		character := value[index]
		if asciiAlphaNumeric(character) || character == '.' || character == '_' || character == ':' || character == '-' {
			continue
		}
		return errors.New("requestId contains an unsupported character")
	}
	return nil
}

func validateEntityID(value string) error { return validateRequestID(value) }

func validRequestIDFromObject(object map[string]any) string {
	value, ok := object["requestId"].(string)
	if !ok || validateRequestID(value) != nil {
		return ""
	}
	return value
}

func validErrorCode(value string) bool {
	if len(value) == 0 || len(value) > 64 || value[0] < 'A' || value[0] > 'Z' {
		return false
	}
	for _, character := range value {
		if character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || character == '_' {
			continue
		}
		return false
	}
	return true
}

func validPublicMessage(value string) bool {
	if value == "" || len(value) > 512 || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if character == 0 || character < 0x20 && character != '\t' {
			return false
		}
	}
	return true
}

func asciiAlphaNumeric(value byte) bool {
	return value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z' || value >= '0' && value <= '9'
}
