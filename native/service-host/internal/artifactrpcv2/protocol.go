package artifactrpcv2

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/workertransport"
)

const (
	ProtocolVersion = "2.0"

	MaximumControlRequestBodyBytes = int(workertransport.ArtifactControlRequestMaximumBytes)
	MaximumChunkRequestBodyBytes   = int(workertransport.ArtifactChunkRequestMaximumBytes)
	MaximumResponseBodyBytes       = int(workertransport.ArtifactResponseMaximumBytes)
	MaximumChunkIndex              = workertransport.ArtifactMaximumChunkIndex

	MaximumControlFrameBytes       = 32 * 1024
	MaximumChunkFrameBytes         = 512 * 1024
	MaximumRequestFrameBytes       = MaximumChunkFrameBytes
	MaximumResponseFrameBytes      = 32 * 1024
	MaximumErrorResponseFrameBytes = 1024

	maximumEntityIDBytes = 128
)

type Operation string

const (
	OperationCreateArtifactUpload    Operation = "CreateArtifactUpload"
	OperationPutArtifactChunk        Operation = "PutArtifactChunk"
	OperationFinalizeArtifactUpload  Operation = "FinalizeArtifactUpload"
	OperationTerminateArtifactUpload Operation = "TerminateArtifactUpload"
	OperationCompleteArtifactRun     Operation = "CompleteArtifactRun"
)

var (
	ErrInvalidMessage   = errors.New("invalid artifact RPC v2 message")
	ErrUnknownOperation = errors.New("unknown artifact RPC v2 operation")
	ErrRequestTooLarge  = errors.New("artifact RPC v2 request exceeds its operation limit")
	ErrInvalidBody      = errors.New("invalid artifact RPC v2 opaque body")
)

type Call struct {
	ID           string
	Operation    Operation
	Body         json.RawMessage
	RunAttemptID string
	UploadID     string
	ChunkIndex   int
}

func (c Call) RequestID() string { return c.ID }

type ProtocolError struct {
	Code      string
	Message   string
	RequestID string
	Cause     error
}

func (e *ProtocolError) Error() string { return e.Message }
func (e *ProtocolError) Unwrap() error { return e.Cause }

type PublicError struct {
	code      string
	message   string
	retryable bool
}

func (e *PublicError) Error() string   { return e.message }
func (e *PublicError) Code() string    { return e.code }
func (e *PublicError) Retryable() bool { return e.retryable }

type wireCall struct {
	Operation       Operation       `json:"operation"`
	Payload         json.RawMessage `json:"payload"`
	ProtocolVersion string          `json:"protocolVersion"`
	RequestID       string          `json:"requestId"`
	Type            string          `json:"type"`
}

type bodyDescriptor struct {
	Base64URL  string `json:"base64Url"`
	ByteLength int    `json:"byteLength"`
	SHA256     string `json:"sha256"`
}

type runPayload struct {
	Body         json.RawMessage `json:"body"`
	RunAttemptID string          `json:"runAttemptId"`
}

type uploadPayload struct {
	Body     json.RawMessage `json:"body"`
	UploadID string          `json:"uploadId"`
}

type chunkPayload struct {
	Body       json.RawMessage `json:"body"`
	ChunkIndex int             `json:"chunkIndex"`
	UploadID   string          `json:"uploadId"`
}

func DecodeCall(document []byte) (Call, error) {
	if len(document) == 0 || len(document) > MaximumRequestFrameBytes {
		return Call{}, protocolError(
			"artifact_rpc_request_too_large",
			"The artifact RPC request exceeds its byte limit.",
			"",
			ErrRequestTooLarge,
		)
	}
	value, err := localrpc.ParseCanonicalJSON(document, MaximumRequestFrameBytes)
	if err != nil {
		return Call{}, protocolError(
			"artifact_rpc_invalid_message",
			"The artifact RPC request is not canonical JSON.",
			"",
			errors.Join(ErrInvalidMessage, err),
		)
	}
	object, ok := value.(map[string]any)
	if !ok || !hasExactKeys(object, "operation", "payload", "protocolVersion", "requestId", "type") {
		return Call{}, invalidMessageError("", ErrInvalidMessage)
	}
	extractedRequestID, _ := object["requestId"].(string)
	if !validEntityID(extractedRequestID) {
		extractedRequestID = ""
	}

	var wire wireCall
	if err := decodeExact(document, &wire); err != nil {
		return Call{}, invalidMessageError(extractedRequestID, err)
	}
	if wire.ProtocolVersion != ProtocolVersion || wire.Type != "call" || !validEntityID(wire.RequestID) {
		return Call{}, invalidMessageError(extractedRequestID, ErrInvalidMessage)
	}
	bodyMaximum, frameMaximum, ok := operationLimits(wire.Operation)
	if !ok {
		return Call{}, protocolError(
			"artifact_rpc_unknown_operation",
			"The artifact RPC operation is not supported.",
			wire.RequestID,
			ErrUnknownOperation,
		)
	}
	if len(document) > frameMaximum {
		return Call{}, protocolError(
			"artifact_rpc_request_too_large",
			"The artifact RPC request exceeds its operation limit.",
			wire.RequestID,
			ErrRequestTooLarge,
		)
	}

	call := Call{ID: wire.RequestID, Operation: wire.Operation}
	switch wire.Operation {
	case OperationCreateArtifactUpload, OperationCompleteArtifactRun:
		payloadValue, err := exactObject(wire.Payload, frameMaximum, "body", "runAttemptId")
		if err != nil {
			return Call{}, invalidMessageError(wire.RequestID, err)
		}
		var payload runPayload
		if err := decodeExact(wire.Payload, &payload); err != nil || !validEntityID(payload.RunAttemptID) {
			return Call{}, invalidMessageError(wire.RequestID, errors.Join(ErrInvalidMessage, err))
		}
		body, err := decodeBody(payloadValue["body"], bodyMaximum)
		if err != nil {
			return Call{}, invalidBodyError(wire.RequestID, err)
		}
		call.Body = body
		call.RunAttemptID = payload.RunAttemptID
	case OperationFinalizeArtifactUpload, OperationTerminateArtifactUpload:
		payloadValue, err := exactObject(wire.Payload, frameMaximum, "body", "uploadId")
		if err != nil {
			return Call{}, invalidMessageError(wire.RequestID, err)
		}
		var payload uploadPayload
		if err := decodeExact(wire.Payload, &payload); err != nil || !validEntityID(payload.UploadID) {
			return Call{}, invalidMessageError(wire.RequestID, errors.Join(ErrInvalidMessage, err))
		}
		body, err := decodeBody(payloadValue["body"], bodyMaximum)
		if err != nil {
			return Call{}, invalidBodyError(wire.RequestID, err)
		}
		call.Body = body
		call.UploadID = payload.UploadID
	case OperationPutArtifactChunk:
		payloadValue, err := exactObject(wire.Payload, frameMaximum, "body", "chunkIndex", "uploadId")
		if err != nil {
			return Call{}, invalidMessageError(wire.RequestID, err)
		}
		chunkIndex, validChunkIndex := exactChunkIndex(payloadValue["chunkIndex"])
		var payload chunkPayload
		if err := decodeExact(wire.Payload, &payload); err != nil ||
			!validChunkIndex || payload.ChunkIndex != chunkIndex || !validEntityID(payload.UploadID) {
			return Call{}, invalidMessageError(wire.RequestID, errors.Join(ErrInvalidMessage, err))
		}
		body, err := decodeBody(payloadValue["body"], bodyMaximum)
		if err != nil {
			return Call{}, invalidBodyError(wire.RequestID, err)
		}
		call.Body = body
		call.UploadID = payload.UploadID
		call.ChunkIndex = chunkIndex
	}
	return call, nil
}

func MarshalSuccessResponse(requestID string, body json.RawMessage) ([]byte, error) {
	if !validEntityID(requestID) {
		return nil, ErrInvalidMessage
	}
	descriptor, err := describeBody(body, MaximumResponseBodyBytes)
	if err != nil {
		return nil, ErrInvalidBody
	}
	return localrpc.MarshalCanonicalJSON(map[string]any{
		"body":            descriptor,
		"outcome":         "ok",
		"protocolVersion": ProtocolVersion,
		"requestId":       requestID,
		"type":            "response",
	}, MaximumResponseFrameBytes)
}

func MarshalErrorResponse(requestID string, publicError error) ([]byte, error) {
	if !validEntityID(requestID) {
		return nil, ErrInvalidMessage
	}
	var typed *PublicError
	if !errors.As(publicError, &typed) || typed == nil || !validPublicError(typed) {
		return nil, errors.New("artifact RPC v2 public error is invalid")
	}
	return localrpc.MarshalCanonicalJSON(map[string]any{
		"error": map[string]any{
			"code":      typed.code,
			"message":   typed.message,
			"retryable": typed.retryable,
		},
		"outcome":         "error",
		"protocolVersion": ProtocolVersion,
		"requestId":       requestID,
		"type":            "response",
	}, MaximumErrorResponseFrameBytes)
}

func operationLimits(operation Operation) (int, int, bool) {
	switch operation {
	case OperationCreateArtifactUpload:
		return MaximumControlRequestBodyBytes, MaximumControlFrameBytes, true
	case OperationPutArtifactChunk:
		return MaximumChunkRequestBodyBytes, MaximumChunkFrameBytes, true
	case OperationFinalizeArtifactUpload:
		return MaximumControlRequestBodyBytes, MaximumControlFrameBytes, true
	case OperationTerminateArtifactUpload:
		return MaximumControlRequestBodyBytes, MaximumControlFrameBytes, true
	case OperationCompleteArtifactRun:
		return MaximumControlRequestBodyBytes, MaximumControlFrameBytes, true
	default:
		return 0, 0, false
	}
}

func exactObject(document []byte, maximumBytes int, keys ...string) (map[string]any, error) {
	value, err := localrpc.ParseCanonicalJSON(document, maximumBytes)
	if err != nil {
		return nil, err
	}
	object, ok := value.(map[string]any)
	if !ok || !hasExactKeys(object, keys...) {
		return nil, ErrInvalidMessage
	}
	return object, nil
}

func decodeBody(value any, maximumBytes int) (json.RawMessage, error) {
	descriptorObject, ok := value.(map[string]any)
	if !ok || !hasExactKeys(descriptorObject, "base64Url", "byteLength", "sha256") {
		return nil, ErrInvalidBody
	}
	document, err := localrpc.MarshalCanonicalJSON(descriptorObject, MaximumRequestFrameBytes)
	if err != nil {
		return nil, ErrInvalidBody
	}
	var descriptor bodyDescriptor
	if err := decodeExact(document, &descriptor); err != nil ||
		descriptor.ByteLength < 1 || descriptor.ByteLength > maximumBytes ||
		len(descriptor.SHA256) != sha256.Size*2 || strings.ToLower(descriptor.SHA256) != descriptor.SHA256 {
		return nil, ErrInvalidBody
	}
	encoding := base64.RawURLEncoding.Strict()
	if len(descriptor.Base64URL) != encoding.EncodedLen(descriptor.ByteLength) {
		return nil, ErrInvalidBody
	}
	body, err := encoding.DecodeString(descriptor.Base64URL)
	if err != nil || len(body) != descriptor.ByteLength || encoding.EncodeToString(body) != descriptor.Base64URL {
		return nil, ErrInvalidBody
	}
	expectedDigest, err := hex.DecodeString(descriptor.SHA256)
	if err != nil || len(expectedDigest) != sha256.Size {
		return nil, ErrInvalidBody
	}
	digest := sha256.Sum256(body)
	if subtle.ConstantTimeCompare(digest[:], expectedDigest) != 1 {
		return nil, ErrInvalidBody
	}
	snapshot, err := localrpc.CopyWorkerAPIBody(body, maximumBytes)
	if err != nil {
		return nil, errors.Join(ErrInvalidBody, err)
	}
	return json.RawMessage(snapshot), nil
}

func describeBody(body []byte, maximumBytes int) (map[string]any, error) {
	snapshot, err := localrpc.CopyWorkerAPIBody(body, maximumBytes)
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

func decodeExact(document []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return ErrInvalidMessage
	}
	return nil
}

func hasExactKeys(object map[string]any, keys ...string) bool {
	if len(object) != len(keys) {
		return false
	}
	for _, key := range keys {
		if _, ok := object[key]; !ok {
			return false
		}
	}
	return true
}

func exactChunkIndex(value any) (int, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	integer, err := number.Int64()
	if err != nil || integer < 0 || integer > int64(MaximumChunkIndex) {
		return 0, false
	}
	return int(integer), true
}

func validEntityID(value string) bool {
	if len(value) == 0 || len(value) > maximumEntityIDBytes || !isASCIIAlphaNumeric(value[0]) {
		return false
	}
	for index := 1; index < len(value); index++ {
		character := value[index]
		if !isASCIIAlphaNumeric(character) && character != '.' && character != '_' &&
			character != ':' && character != '-' {
			return false
		}
	}
	return true
}

func isASCIIAlphaNumeric(value byte) bool {
	return value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' || value >= '0' && value <= '9'
}

func validPublicError(value *PublicError) bool {
	if value == nil || !validErrorCode(value.code) || !utf8.ValidString(value.message) ||
		len(value.message) == 0 || len(value.message) > 512 {
		return false
	}
	for _, character := range value.message {
		if character < 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}

func validErrorCode(value string) bool {
	if len(value) == 0 || len(value) > 128 || value[0] < 'a' || value[0] > 'z' {
		return false
	}
	for index := 1; index < len(value); index++ {
		character := value[index]
		if character < 'a' || character > 'z' {
			if character < '0' || character > '9' {
				if character != '_' {
					return false
				}
			}
		}
	}
	return true
}

func protocolError(code, message, requestID string, cause error) error {
	return &ProtocolError{Code: code, Message: message, RequestID: requestID, Cause: cause}
}

func invalidMessageError(requestID string, cause error) error {
	return protocolError(
		"artifact_rpc_invalid_message",
		"The artifact RPC request shape is invalid.",
		requestID,
		errors.Join(ErrInvalidMessage, cause),
	)
}

func invalidBodyError(requestID string, cause error) error {
	return protocolError(
		"artifact_rpc_invalid_body",
		"The artifact RPC request body is invalid.",
		requestID,
		errors.Join(ErrInvalidBody, cause),
	)
}
