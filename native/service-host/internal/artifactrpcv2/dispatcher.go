package artifactrpcv2

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/workertransport"
)

var ErrInvalidDependencies = errors.New("invalid artifact RPC v2 dispatcher dependencies")

const (
	requestInvalidMessage   = "The artifact request is invalid."
	requestCancelledMessage = "The artifact request was cancelled before dispatch."
	requestTimeoutMessage   = "The artifact request expired before dispatch."
	outcomeUnknownMessage   = "The artifact operation outcome is unknown."
	serverRejectedMessage   = "The Worker API rejected the artifact operation."
)

type artifactClient interface {
	CreateArtifactUpload(
		context.Context,
		workertransport.CreateArtifactUploadRequest,
	) (workertransport.CreateArtifactUploadResponse, error)
	PutArtifactChunk(
		context.Context,
		workertransport.PutArtifactChunkRequest,
	) (workertransport.PutArtifactChunkResponse, error)
	FinalizeArtifactUpload(
		context.Context,
		workertransport.FinalizeArtifactUploadRequest,
	) (workertransport.FinalizeArtifactUploadResponse, error)
	TerminateArtifactUpload(
		context.Context,
		workertransport.TerminateArtifactUploadRequest,
	) (workertransport.TerminateArtifactUploadResponse, error)
	CompleteArtifactRun(
		context.Context,
		workertransport.CompleteArtifactRunRequest,
	) (workertransport.CompleteArtifactRunResponse, error)
}

type artifactServerError interface {
	error
	StatusCode() int
	Details() (code string, retryable bool, ok bool)
}

var _ artifactServerError = (*workertransport.ArtifactServerError)(nil)

// Dispatcher forwards the closed version-two operation set to a borrowed ArtifactClientV2. It
// owns no transport and has no production composition entry point.
type Dispatcher struct {
	client artifactClient
}

func New(client *workertransport.ArtifactClientV2) (*Dispatcher, error) {
	return newDispatcher(client)
}

func newDispatcher(client artifactClient) (*Dispatcher, error) {
	if isNilArtifactClient(client) {
		return nil, ErrInvalidDependencies
	}
	return &Dispatcher{client: client}, nil
}

func (d *Dispatcher) Dispatch(ctx context.Context, call Call) (json.RawMessage, error) {
	if d == nil || d.client == nil {
		return nil, requestInvalidError()
	}
	if ctx == nil {
		return nil, requestInvalidError()
	}
	if err := ctx.Err(); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, requestTimeoutError()
		}
		return nil, requestCancelledError()
	}
	bodyMaximum, _, ok := operationLimits(call.Operation)
	if !ok || !validEntityID(call.ID) {
		return nil, requestInvalidError()
	}
	body, err := localrpc.CopyWorkerAPIBody(call.Body, bodyMaximum)
	if err != nil {
		return nil, requestInvalidError()
	}
	call.Body = json.RawMessage(body)

	var response json.RawMessage
	switch call.Operation {
	case OperationCreateArtifactUpload:
		if !validEntityID(call.RunAttemptID) || call.UploadID != "" || call.ChunkIndex != 0 {
			return nil, requestInvalidError()
		}
		result, err := d.client.CreateArtifactUpload(ctx, workertransport.CreateArtifactUploadRequest{
			RunAttemptID: call.RunAttemptID,
			Body:         call.Body,
		})
		if err != nil {
			return nil, classifyDispatchedError(call.Operation, err)
		}
		response = result.Body
	case OperationPutArtifactChunk:
		if call.RunAttemptID != "" || !validEntityID(call.UploadID) ||
			call.ChunkIndex < 0 || call.ChunkIndex > MaximumChunkIndex {
			return nil, requestInvalidError()
		}
		result, err := d.client.PutArtifactChunk(ctx, workertransport.PutArtifactChunkRequest{
			UploadID:   call.UploadID,
			ChunkIndex: call.ChunkIndex,
			Body:       call.Body,
		})
		if err != nil {
			return nil, classifyDispatchedError(call.Operation, err)
		}
		response = result.Body
	case OperationFinalizeArtifactUpload:
		if call.RunAttemptID != "" || !validEntityID(call.UploadID) || call.ChunkIndex != 0 {
			return nil, requestInvalidError()
		}
		result, err := d.client.FinalizeArtifactUpload(ctx, workertransport.FinalizeArtifactUploadRequest{
			UploadID: call.UploadID,
			Body:     call.Body,
		})
		if err != nil {
			return nil, classifyDispatchedError(call.Operation, err)
		}
		response = result.Body
	case OperationTerminateArtifactUpload:
		if call.RunAttemptID != "" || !validEntityID(call.UploadID) || call.ChunkIndex != 0 {
			return nil, requestInvalidError()
		}
		result, err := d.client.TerminateArtifactUpload(ctx, workertransport.TerminateArtifactUploadRequest{
			UploadID: call.UploadID,
			Body:     call.Body,
		})
		if err != nil {
			return nil, classifyDispatchedError(call.Operation, err)
		}
		response = result.Body
	case OperationCompleteArtifactRun:
		if !validEntityID(call.RunAttemptID) || call.UploadID != "" || call.ChunkIndex != 0 {
			return nil, requestInvalidError()
		}
		result, err := d.client.CompleteArtifactRun(ctx, workertransport.CompleteArtifactRunRequest{
			RunAttemptID: call.RunAttemptID,
			Body:         call.Body,
		})
		if err != nil {
			return nil, classifyDispatchedError(call.Operation, err)
		}
		response = result.Body
	}

	if ctx.Err() != nil {
		return nil, outcomeUnknownError()
	}
	snapshot, err := localrpc.CopyWorkerAPIBody(response, MaximumResponseBodyBytes)
	if err != nil {
		return nil, outcomeUnknownError()
	}
	return json.RawMessage(snapshot), nil
}

type statusDetails struct {
	Code      string
	Retryable bool
}

func classifyDispatchedError(operation Operation, err error) error {
	var serverError artifactServerError
	if errors.As(err, &serverError) && serverError != nil &&
		serverError.StatusCode() >= 400 && serverError.StatusCode() <= 599 {
		if code, retryable, ok := serverError.Details(); ok {
			details := statusDetails{Code: code, Retryable: retryable}
			if statusTupleMatches(
				serverError.StatusCode(),
				details,
				503,
				false,
				"artifact_service_unavailable",
			) {
				return outcomeUnknownErrorWithRetryability(false)
			}
			if allowlistedServerStatus(operation, serverError.StatusCode(), details) {
				return &PublicError{
					code:      details.Code,
					message:   serverRejectedMessage,
					retryable: details.Retryable,
				}
			}
		}
	}
	return outcomeUnknownError()
}

func allowlistedServerStatus(operation Operation, status int, details statusDetails) bool {
	switch operation {
	case OperationCreateArtifactUpload:
		return createArtifactUploadServerStatus(status, details)
	case OperationPutArtifactChunk:
		return putArtifactChunkServerStatus(status, details)
	case OperationFinalizeArtifactUpload:
		return finalizeArtifactUploadServerStatus(status, details)
	case OperationTerminateArtifactUpload:
		return terminateArtifactUploadServerStatus(status, details)
	case OperationCompleteArtifactRun:
		return completeArtifactRunServerStatus(status, details)
	default:
		return false
	}
}

func createArtifactUploadServerStatus(status int, details statusDetails) bool {
	return statusTupleMatches(
		status,
		details,
		400,
		false,
		"request_validation_failed",
		"worker_identity_missing",
		"run_attempt_mismatch",
		"artifact_request_invalid",
	) ||
		statusTupleMatches(
			status,
			details,
			401,
			false,
			"worker_authentication_failed",
			"worker_authentication_state_invalid",
			"worker_authentication_state_missing",
		) ||
		statusTupleMatches(
			status,
			details,
			403,
			false,
			"insecure_worker_auth_loopback_only",
			"worker_identity_mismatch",
			"worker_registration_required",
		) ||
		statusTupleMatches(
			status,
			details,
			409,
			false,
			"artifact_completion_mode_mismatch",
			"artifact_upload_conflict",
			"lease_lost",
			"artifact_upload_quota_exceeded",
		) ||
		statusTupleMatches(status, details, 413, false, "request_body_too_large") ||
		statusTupleMatches(status, details, 429, true, "artifact_transaction_busy", "request_rate_limited") ||
		statusTupleMatches(
			status,
			details,
			503,
			true,
			"artifact_transaction_cancelled",
			"artifact_transaction_not_ready",
			"artifact_transaction_timeout",
			"worker_authentication_unavailable",
		) ||
		statusTupleMatches(
			status,
			details,
			503,
			false,
			"artifact_transaction_closed",
			"artifact_storage_integrity",
		) ||
		statusTupleMatches(status, details, 507, true, "artifact_storage_capacity")
}

func putArtifactChunkServerStatus(status int, details statusDetails) bool {
	return statusTupleMatches(
		status,
		details,
		400,
		false,
		"request_validation_failed",
		"worker_identity_missing",
		"artifact_request_invalid",
		"artifact_chunk_index_mismatch",
		"artifact_chunk_digest_mismatch",
		"artifact_chunk_encoding_invalid",
		"artifact_chunk_length_mismatch",
		"artifact_chunk_range_invalid",
		"artifact_chunk_request_invalid",
	) ||
		statusTupleMatches(
			status,
			details,
			401,
			false,
			"worker_authentication_failed",
			"worker_authentication_state_invalid",
			"worker_authentication_state_missing",
		) ||
		statusTupleMatches(
			status,
			details,
			403,
			false,
			"insecure_worker_auth_loopback_only",
			"worker_identity_mismatch",
			"worker_registration_required",
		) ||
		statusTupleMatches(
			status,
			details,
			409,
			false,
			"artifact_completion_mode_mismatch",
			"artifact_upload_conflict",
			"lease_lost",
		) ||
		statusTupleMatches(status, details, 413, false, "request_body_too_large") ||
		statusTupleMatches(status, details, 429, true, "artifact_transaction_busy", "request_rate_limited") ||
		statusTupleMatches(
			status,
			details,
			503,
			true,
			"artifact_transaction_cancelled",
			"artifact_transaction_not_ready",
			"artifact_transaction_timeout",
			"worker_authentication_unavailable",
		) ||
		statusTupleMatches(
			status,
			details,
			503,
			false,
			"artifact_transaction_closed",
			"artifact_storage_integrity",
		)
}

func finalizeArtifactUploadServerStatus(status int, details statusDetails) bool {
	return statusTupleMatches(
		status,
		details,
		400,
		false,
		"request_validation_failed",
		"worker_identity_missing",
		"artifact_request_invalid",
	) ||
		statusTupleMatches(
			status,
			details,
			401,
			false,
			"worker_authentication_failed",
			"worker_authentication_state_invalid",
			"worker_authentication_state_missing",
		) ||
		statusTupleMatches(
			status,
			details,
			403,
			false,
			"insecure_worker_auth_loopback_only",
			"worker_identity_mismatch",
			"worker_registration_required",
		) ||
		statusTupleMatches(
			status,
			details,
			409,
			false,
			"artifact_completion_mode_mismatch",
			"artifact_upload_conflict",
			"lease_lost",
		) ||
		statusTupleMatches(status, details, 413, false, "request_body_too_large") ||
		statusTupleMatches(status, details, 429, true, "artifact_transaction_busy", "request_rate_limited") ||
		statusTupleMatches(
			status,
			details,
			503,
			true,
			"artifact_transaction_cancelled",
			"artifact_transaction_not_ready",
			"artifact_transaction_timeout",
			"worker_authentication_unavailable",
		) ||
		statusTupleMatches(
			status,
			details,
			503,
			false,
			"artifact_transaction_closed",
			"artifact_storage_integrity",
		)
}

func terminateArtifactUploadServerStatus(status int, details statusDetails) bool {
	return statusTupleMatches(
		status,
		details,
		400,
		false,
		"request_validation_failed",
		"worker_identity_missing",
		"artifact_request_invalid",
	) ||
		statusTupleMatches(
			status,
			details,
			401,
			false,
			"worker_authentication_failed",
			"worker_authentication_state_invalid",
			"worker_authentication_state_missing",
		) ||
		statusTupleMatches(
			status,
			details,
			403,
			false,
			"insecure_worker_auth_loopback_only",
			"worker_identity_mismatch",
			"worker_registration_required",
		) ||
		statusTupleMatches(
			status,
			details,
			409,
			false,
			"artifact_completion_mode_mismatch",
			"artifact_upload_conflict",
			"lease_lost",
		) ||
		statusTupleMatches(status, details, 413, false, "request_body_too_large") ||
		statusTupleMatches(status, details, 429, true, "artifact_transaction_busy", "request_rate_limited") ||
		statusTupleMatches(
			status,
			details,
			503,
			true,
			"artifact_transaction_cancelled",
			"artifact_transaction_not_ready",
			"artifact_transaction_timeout",
			"worker_authentication_unavailable",
		) ||
		statusTupleMatches(
			status,
			details,
			503,
			false,
			"artifact_transaction_closed",
			"artifact_storage_integrity",
		)
}

func completeArtifactRunServerStatus(status int, details statusDetails) bool {
	return statusTupleMatches(
		status,
		details,
		400,
		false,
		"request_validation_failed",
		"worker_identity_missing",
		"run_attempt_mismatch",
		"result_digest_mismatch",
	) ||
		statusTupleMatches(
			status,
			details,
			401,
			false,
			"worker_authentication_failed",
			"worker_authentication_state_invalid",
			"worker_authentication_state_missing",
		) ||
		statusTupleMatches(
			status,
			details,
			403,
			false,
			"insecure_worker_auth_loopback_only",
			"worker_identity_mismatch",
			"worker_registration_required",
		) ||
		statusTupleMatches(
			status,
			details,
			409,
			false,
			"terminal_submission_conflict",
			"artifact_completion_mode_mismatch",
			"lease_lost",
		) ||
		statusTupleMatches(status, details, 413, false, "request_body_too_large") ||
		statusTupleMatches(
			status,
			details,
			422,
			false,
			"artifact_result_encoding_invalid",
			"artifact_result_json_invalid",
			"review_result_invalid",
			"stored_execution_template_invalid",
		) ||
		statusTupleMatches(status, details, 429, true, "artifact_transaction_busy", "request_rate_limited") ||
		statusTupleMatches(
			status,
			details,
			503,
			true,
			"artifact_transaction_cancelled",
			"artifact_transaction_not_ready",
			"artifact_transaction_timeout",
			"worker_authentication_unavailable",
		) ||
		statusTupleMatches(status, details, 503, false, "artifact_storage_integrity")
}

func statusTupleMatches(
	status int,
	details statusDetails,
	expectedStatus int,
	expectedRetryable bool,
	codes ...string,
) bool {
	if status != expectedStatus || details.Retryable != expectedRetryable {
		return false
	}
	for _, code := range codes {
		if details.Code == code {
			return true
		}
	}
	return false
}

func requestInvalidError() error {
	return &PublicError{code: "artifact_request_invalid", message: requestInvalidMessage, retryable: false}
}

func requestCancelledError() error {
	return &PublicError{code: "artifact_request_cancelled", message: requestCancelledMessage, retryable: false}
}

func requestTimeoutError() error {
	return &PublicError{code: "artifact_request_timeout", message: requestTimeoutMessage, retryable: false}
}

func outcomeUnknownError() error {
	return outcomeUnknownErrorWithRetryability(true)
}

func outcomeUnknownErrorWithRetryability(retryable bool) error {
	return &PublicError{
		code: "artifact_outcome_unknown", message: outcomeUnknownMessage, retryable: retryable,
	}
}

func isNilArtifactClient(client artifactClient) bool {
	if client == nil {
		return true
	}
	value := reflect.ValueOf(client)
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return value.IsNil()
	default:
		return false
	}
}
