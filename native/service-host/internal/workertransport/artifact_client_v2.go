package workertransport

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"unicode/utf8"
)

const (
	ArtifactControlRequestMaximumBytes int64 = 16 * 1024
	ArtifactChunkRequestMaximumBytes   int64 = (256*1024*4+2)/3 + 16*1024
	ArtifactResponseMaximumBytes       int64 = 16 * 1024
	ArtifactMaximumChunkIndex                = 7

	artifactRunPathStart     = "/api/v1/worker/runs/"
	artifactCreatePathEnd    = "/artifacts"
	artifactUploadPathStart  = "/api/v1/worker/artifact-uploads/"
	artifactChunkPathMiddle  = "/chunks/"
	artifactFinalizePathEnd  = "/complete"
	artifactTerminatePathEnd = "/terminate"
)

var ErrInvalidArtifactChunkIndex = errors.New("invalid artifact chunk index")

// ArtifactServerError is the sanitized non-success Server response exposed by ArtifactClientV2.
// It intentionally retains no response body, Server message, URL, request body, or cause.
type ArtifactServerError struct {
	statusCode int
	code       string
	retryable  bool
	hasDetails bool
}

func (e *ArtifactServerError) Error() string {
	if e == nil {
		return "artifact worker API returned an invalid response"
	}
	return fmt.Sprintf("artifact worker API returned HTTP %d", e.statusCode)
}

func (e *ArtifactServerError) Unwrap() error { return ErrUnexpectedStatus }

func (e *ArtifactServerError) StatusCode() int {
	if e == nil {
		return 0
	}
	return e.statusCode
}

func (e *ArtifactServerError) Details() (code string, retryable bool, ok bool) {
	if e == nil || !e.hasDetails {
		return "", false, false
	}
	return e.code, e.retryable, true
}

type CreateArtifactUploadRequest struct {
	RunAttemptID string
	Body         json.RawMessage
}

type CreateArtifactUploadResponse struct {
	Body json.RawMessage
}

type PutArtifactChunkRequest struct {
	UploadID   string
	ChunkIndex int
	Body       json.RawMessage
}

type PutArtifactChunkResponse struct {
	Body json.RawMessage
}

type FinalizeArtifactUploadRequest struct {
	UploadID string
	Body     json.RawMessage
}

type FinalizeArtifactUploadResponse struct {
	Body json.RawMessage
}

type TerminateArtifactUploadRequest struct {
	UploadID string
	Body     json.RawMessage
}

type TerminateArtifactUploadResponse struct {
	Body json.RawMessage
}

type CompleteArtifactRunRequest struct {
	RunAttemptID string
	Body         json.RawMessage
}

type CompleteArtifactRunResponse struct {
	Body json.RawMessage
}

// ArtifactClientV2 is a source-only, dormant capability for the version-two result-artifact
// transport. It borrows the fixed origin, selected Worker authentication, request concurrency,
// timeout, and lifecycle of an existing Client. It cannot configure a URL, headers, TLS, or
// connection ownership and becomes closed when the borrowed Client closes.
type ArtifactClientV2 struct {
	state *clientState
}

// NewArtifactClientV2 derives a narrow artifact capability from an already configured Client.
// It does not change ownership: the caller must keep the Client open for the capability lifetime.
func NewArtifactClientV2(client *Client) (*ArtifactClientV2, error) {
	if client == nil || client.state == nil {
		return nil, ErrClosed
	}
	return &ArtifactClientV2{state: client.state}, nil
}

func (c *ArtifactClientV2) CreateArtifactUpload(
	ctx context.Context,
	request CreateArtifactUploadRequest,
) (CreateArtifactUploadResponse, error) {
	state, err := c.clientState()
	if err != nil {
		return CreateArtifactUploadResponse{}, err
	}
	target, err := state.entityTarget(artifactRunPathStart, request.RunAttemptID, artifactCreatePathEnd)
	if err != nil {
		return CreateArtifactUploadResponse{}, err
	}
	response, err := state.executeArtifact(
		ctx,
		http.MethodPost,
		target,
		request.Body,
		ArtifactControlRequestMaximumBytes,
		http.StatusOK,
		http.StatusCreated,
	)
	if err != nil {
		return CreateArtifactUploadResponse{}, err
	}
	return CreateArtifactUploadResponse{Body: response}, nil
}

func (c *ArtifactClientV2) PutArtifactChunk(
	ctx context.Context,
	request PutArtifactChunkRequest,
) (PutArtifactChunkResponse, error) {
	state, err := c.clientState()
	if err != nil {
		return PutArtifactChunkResponse{}, err
	}
	if request.ChunkIndex < 0 || request.ChunkIndex > ArtifactMaximumChunkIndex {
		return PutArtifactChunkResponse{}, ErrInvalidArtifactChunkIndex
	}
	target, err := state.entityTarget(
		artifactUploadPathStart,
		request.UploadID,
		artifactChunkPathMiddle+strconv.Itoa(request.ChunkIndex),
	)
	if err != nil {
		return PutArtifactChunkResponse{}, err
	}
	response, err := state.executeArtifact(
		ctx,
		http.MethodPut,
		target,
		request.Body,
		ArtifactChunkRequestMaximumBytes,
		http.StatusOK,
		0,
	)
	if err != nil {
		return PutArtifactChunkResponse{}, err
	}
	return PutArtifactChunkResponse{Body: response}, nil
}

func (c *ArtifactClientV2) FinalizeArtifactUpload(
	ctx context.Context,
	request FinalizeArtifactUploadRequest,
) (FinalizeArtifactUploadResponse, error) {
	state, err := c.clientState()
	if err != nil {
		return FinalizeArtifactUploadResponse{}, err
	}
	target, err := state.entityTarget(artifactUploadPathStart, request.UploadID, artifactFinalizePathEnd)
	if err != nil {
		return FinalizeArtifactUploadResponse{}, err
	}
	response, err := state.executeArtifact(
		ctx,
		http.MethodPost,
		target,
		request.Body,
		ArtifactControlRequestMaximumBytes,
		http.StatusOK,
		0,
	)
	if err != nil {
		return FinalizeArtifactUploadResponse{}, err
	}
	return FinalizeArtifactUploadResponse{Body: response}, nil
}

func (c *ArtifactClientV2) TerminateArtifactUpload(
	ctx context.Context,
	request TerminateArtifactUploadRequest,
) (TerminateArtifactUploadResponse, error) {
	state, err := c.clientState()
	if err != nil {
		return TerminateArtifactUploadResponse{}, err
	}
	target, err := state.entityTarget(artifactUploadPathStart, request.UploadID, artifactTerminatePathEnd)
	if err != nil {
		return TerminateArtifactUploadResponse{}, err
	}
	response, err := state.executeArtifact(
		ctx,
		http.MethodPost,
		target,
		request.Body,
		ArtifactControlRequestMaximumBytes,
		http.StatusOK,
		0,
	)
	if err != nil {
		return TerminateArtifactUploadResponse{}, err
	}
	return TerminateArtifactUploadResponse{Body: response}, nil
}

func (c *ArtifactClientV2) CompleteArtifactRun(
	ctx context.Context,
	request CompleteArtifactRunRequest,
) (CompleteArtifactRunResponse, error) {
	state, err := c.clientState()
	if err != nil {
		return CompleteArtifactRunResponse{}, err
	}
	target, err := state.entityTarget(artifactRunPathStart, request.RunAttemptID, completePathEnd)
	if err != nil {
		return CompleteArtifactRunResponse{}, err
	}
	response, err := state.executeArtifact(
		ctx,
		http.MethodPost,
		target,
		request.Body,
		ArtifactControlRequestMaximumBytes,
		http.StatusOK,
		0,
	)
	if err != nil {
		return CompleteArtifactRunResponse{}, err
	}
	return CompleteArtifactRunResponse{Body: response}, nil
}

func (c *ArtifactClientV2) clientState() (*clientState, error) {
	if c == nil || c.state == nil {
		return nil, ErrClosed
	}
	return c.state, nil
}

func (c *clientState) executeArtifact(
	ctx context.Context,
	method string,
	target url.URL,
	body json.RawMessage,
	maximumRequestBytes int64,
	primarySuccessStatus int,
	secondSuccessStatus int,
) (json.RawMessage, error) {
	response, err := c.executeWithPolicy(ctx, method, target, body, c.requestTimeout, executePolicy{
		maximumRequestBytes:  min(c.maximumRequestBytes, maximumRequestBytes),
		maximumResponseBytes: min(c.maximumResponseBytes, ArtifactResponseMaximumBytes),
		primarySuccessStatus: primarySuccessStatus,
		secondSuccessStatus:  secondSuccessStatus,
	})
	if err == nil {
		return response, nil
	}
	var statusError *StatusError
	if !errors.As(err, &statusError) || statusError == nil {
		return nil, err
	}
	sanitized := &ArtifactServerError{statusCode: statusError.StatusCode}
	if details, ok := parseArtifactServerErrorDetails(statusError.Body); ok {
		sanitized.code = details.code
		sanitized.retryable = details.retryable
		sanitized.hasDetails = true
	}
	statusError.Body = nil
	return nil, sanitized
}

type artifactServerErrorDetails struct {
	code      string
	retryable bool
}

func parseArtifactServerErrorDetails(body []byte) (artifactServerErrorDetails, bool) {
	if len(body) == 0 || len(body) > int(ArtifactResponseMaximumBytes) || !utf8.Valid(body) {
		return artifactServerErrorDetails{}, false
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return artifactServerErrorDetails{}, false
	}
	seen := make(map[string]struct{}, 3)
	var code string
	var message string
	var retryable bool
	for decoder.More() {
		keyValue, err := decoder.Token()
		key, keyOK := keyValue.(string)
		if err != nil || !keyOK {
			return artifactServerErrorDetails{}, false
		}
		if _, duplicate := seen[key]; duplicate {
			return artifactServerErrorDetails{}, false
		}
		seen[key] = struct{}{}
		var value any
		if err := decoder.Decode(&value); err != nil {
			return artifactServerErrorDetails{}, false
		}
		switch key {
		case "code":
			code, keyOK = value.(string)
		case "message":
			message, keyOK = value.(string)
		case "retryable":
			retryable, keyOK = value.(bool)
		default:
			keyOK = false
		}
		if !keyOK {
			return artifactServerErrorDetails{}, false
		}
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') || len(seen) != 3 {
		return artifactServerErrorDetails{}, false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return artifactServerErrorDetails{}, false
	}
	if !knownArtifactServerErrorCode(code) || len(message) == 0 || len(message) > 2_048 {
		return artifactServerErrorDetails{}, false
	}
	for _, character := range message {
		if character < 0x20 || character == 0x7f {
			return artifactServerErrorDetails{}, false
		}
	}
	return artifactServerErrorDetails{code: code, retryable: retryable}, true
}

func knownArtifactServerErrorCode(code string) bool {
	switch code {
	case "request_validation_failed",
		"worker_identity_missing",
		"worker_authentication_failed",
		"worker_mtls_required",
		"worker_certificate_unauthorized",
		"worker_certificate_missing",
		"worker_transport_authentication_failed",
		"worker_authentication_state_invalid",
		"worker_authentication_state_missing",
		"insecure_worker_auth_loopback_only",
		"worker_certificate_unmapped",
		"worker_identity_mismatch",
		"worker_registration_required",
		"request_body_too_large",
		"request_rate_limited",
		"run_attempt_mismatch",
		"artifact_upload_quota_exceeded",
		"artifact_storage_capacity",
		"artifact_chunk_index_mismatch",
		"artifact_chunk_digest_mismatch",
		"artifact_chunk_encoding_invalid",
		"artifact_chunk_length_mismatch",
		"artifact_chunk_range_invalid",
		"artifact_chunk_request_invalid",
		"artifact_request_invalid",
		"artifact_completion_mode_mismatch",
		"artifact_upload_conflict",
		"lease_lost",
		"artifact_transaction_busy",
		"artifact_transaction_cancelled",
		"artifact_transaction_not_ready",
		"artifact_transaction_timeout",
		"artifact_transaction_closed",
		"artifact_storage_integrity",
		"worker_authentication_unavailable",
		"terminal_submission_conflict",
		"result_digest_mismatch",
		"artifact_result_encoding_invalid",
		"artifact_result_json_invalid",
		"review_result_invalid",
		"stored_execution_template_invalid",
		"artifact_service_unavailable":
		return true
	default:
		return false
	}
}
