package protocol

import (
	"encoding/base64"
	"errors"
	"fmt"
)

const (
	InteractiveStdinVersion              = 1
	MaxInteractiveStdinChunkBytes        = 65_536
	MaxInteractiveStdinTotalBytes        = 8_388_608
	MaxInteractiveStdinOperations        = 1_024
	MaxInteractiveStdinPendingOperations = 1
	InteractiveStdinWriteTimeoutMS       = 10_000

	StdinNotEnabled        = "STDIN_NOT_ENABLED"
	StdinProcessNotFound   = "STDIN_PROCESS_NOT_FOUND"
	StdinProcessNotRunning = "STDIN_PROCESS_NOT_RUNNING"
	StdinStreamMismatch    = "STDIN_STREAM_MISMATCH"
	StdinSequenceMismatch  = "STDIN_SEQUENCE_MISMATCH"
	StdinBusy              = "STDIN_BUSY"
	StdinClosed            = "STDIN_CLOSED"
	StdinLimitExceeded     = "STDIN_LIMIT_EXCEEDED"
	StdinProcessExited     = "STDIN_PROCESS_EXITED"
	StdinWriteFailed       = "STDIN_WRITE_FAILED"
	StdinWriteTimeout      = "STDIN_WRITE_TIMEOUT"
	StdinCloseFailed       = "STDIN_CLOSE_FAILED"
	StdinCancelled         = "STDIN_CANCELLED"
)

type InteractiveStdinCapabilities struct {
	Version                  int `json:"version"`
	MaximumChunkBytes        int `json:"maximumChunkBytes"`
	MaximumTotalBytes        int `json:"maximumTotalBytes"`
	MaximumOperations        int `json:"maximumOperations"`
	MaximumPendingOperations int `json:"maximumPendingOperations"`
	WriteTimeoutMS           int `json:"writeTimeoutMs"`
}

// Each advertisement owns its values; callers cannot mutate another Host's capabilities.
func DefaultInteractiveStdinCapabilities() *InteractiveStdinCapabilities {
	return &InteractiveStdinCapabilities{
		Version:                  InteractiveStdinVersion,
		MaximumChunkBytes:        MaxInteractiveStdinChunkBytes,
		MaximumTotalBytes:        MaxInteractiveStdinTotalBytes,
		MaximumOperations:        MaxInteractiveStdinOperations,
		MaximumPendingOperations: MaxInteractiveStdinPendingOperations,
		WriteTimeoutMS:           InteractiveStdinWriteTimeoutMS,
	}
}

type StdinWriteRequest struct {
	ProtocolVersion string `json:"protocolVersion"`
	Type            string `json:"type"`
	ID              string `json:"requestId"`
	StdinStreamID   string `json:"stdinStreamId"`
	Sequence        uint64 `json:"sequence"`
	DataBase64      string `json:"dataBase64"`
}

func (r StdinWriteRequest) RequestID() string   { return r.ID }
func (r StdinWriteRequest) RequestType() string { return r.Type }

type StdinCloseRequest struct {
	ProtocolVersion string `json:"protocolVersion"`
	Type            string `json:"type"`
	ID              string `json:"requestId"`
	StdinStreamID   string `json:"stdinStreamId"`
	Sequence        uint64 `json:"sequence"`
}

func (r StdinCloseRequest) RequestID() string   { return r.ID }
func (r StdinCloseRequest) RequestType() string { return r.Type }

type StdinResultEvent struct {
	ProtocolVersion string  `json:"protocolVersion"`
	Type            string  `json:"type"`
	RequestID       string  `json:"requestId"`
	StdinStreamID   string  `json:"stdinStreamId"`
	Sequence        uint64  `json:"sequence"`
	Operation       string  `json:"operation"`
	Status          string  `json:"status"`
	BytesWritten    uint64  `json:"bytesWritten"`
	Code            *string `json:"code"`
}

func ValidateStdinStreamID(streamID string) error {
	if len(streamID) != 64 {
		return errors.New("stdinStreamId must contain exactly 64 lowercase hexadecimal characters")
	}
	for index := range streamID {
		character := streamID[index]
		if !(character >= '0' && character <= '9' || character >= 'a' && character <= 'f') {
			return errors.New("stdinStreamId must contain exactly 64 lowercase hexadecimal characters")
		}
	}
	return nil
}

func validateStdinSequence(sequence uint64) error {
	if sequence < 1 || sequence > MaxSafeInteger {
		return errors.New("stdin sequence must be a positive JavaScript safe integer")
	}
	return nil
}

// DecodeStdinWriteData accepts arbitrary bytes while rejecting alternate base64 spellings.
func DecodeStdinWriteData(value string) ([]byte, error) {
	if len(value) == 0 || len(value) > base64.StdEncoding.EncodedLen(MaxInteractiveStdinChunkBytes) {
		return nil, fmt.Errorf("dataBase64 must encode between 1 and %d bytes", MaxInteractiveStdinChunkBytes)
	}
	data, err := base64.StdEncoding.Strict().DecodeString(value)
	if err != nil || len(data) == 0 || len(data) > MaxInteractiveStdinChunkBytes || base64.StdEncoding.EncodeToString(data) != value {
		return nil, errors.New("dataBase64 must contain canonical padded base64 within the stdin chunk limit")
	}
	return data, nil
}

func validateStdinRequest(version, requestType, expectedType, requestID, streamID string, sequence uint64) error {
	if err := validateEnvelope(version, requestType, expectedType, requestID); err != nil {
		return err
	}
	if err := ValidateStdinStreamID(streamID); err != nil {
		return err
	}
	return validateStdinSequence(sequence)
}

func ValidateStdinWriteRequest(request StdinWriteRequest) error {
	if err := validateStdinRequest(request.ProtocolVersion, request.Type, "stdin_write", request.ID, request.StdinStreamID, request.Sequence); err != nil {
		return err
	}
	_, err := DecodeStdinWriteData(request.DataBase64)
	return err
}

func ValidateStdinCloseRequest(request StdinCloseRequest) error {
	return validateStdinRequest(request.ProtocolVersion, request.Type, "stdin_close", request.ID, request.StdinStreamID, request.Sequence)
}

// Request-specific equality and byte counts are checked against the pending operation by the client.
func ValidateStdinResultEvent(event StdinResultEvent) error {
	if err := validateStdinRequest(event.ProtocolVersion, event.Type, "stdin_result", event.RequestID, event.StdinStreamID, event.Sequence); err != nil {
		return err
	}
	if event.Operation != "write" && event.Operation != "close" {
		return errors.New("stdin result operation must be write or close")
	}
	if event.BytesWritten > MaxInteractiveStdinChunkBytes || event.Operation == "close" && event.BytesWritten != 0 {
		return errors.New("stdin result bytesWritten does not match its operation bounds")
	}
	switch event.Status {
	case "succeeded":
		if event.Code != nil || event.Operation == "write" && event.BytesWritten == 0 {
			return errors.New("a successful stdin result must have null code and a complete operation")
		}
	case "failed":
		if event.Code == nil {
			return errors.New("a failed stdin result requires an error code")
		}
		switch *event.Code {
		case StdinNotEnabled, StdinProcessNotFound, StdinProcessNotRunning, StdinStreamMismatch, StdinSequenceMismatch, StdinBusy, StdinClosed, StdinLimitExceeded:
			if event.BytesWritten != 0 {
				return errors.New("stdin admission rejection must report zero bytesWritten")
			}
		case StdinProcessExited, StdinWriteFailed, StdinWriteTimeout, StdinCloseFailed, StdinCancelled:
			if event.Operation == "close" && (*event.Code == StdinWriteFailed || *event.Code == StdinWriteTimeout) || event.Operation == "write" && *event.Code == StdinCloseFailed {
				return errors.New("stdin result error code does not match its operation")
			}
		default:
			return errors.New("stdin result has an unknown error code")
		}
	default:
		return errors.New("stdin result status must be succeeded or failed")
	}
	return nil
}
