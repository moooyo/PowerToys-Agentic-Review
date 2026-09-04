package controlrpc

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"unicode/utf8"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/workertransport"
)

type publicErrorSpec struct {
	code      string
	message   string
	retryable bool
}

type statusMappingKey struct {
	operation     localrpc.Operation
	status        int
	upstreamCode  string
	bodyRetryable bool
}

type statusDetails struct {
	code      string
	retryable bool
}

var (
	internalErrorSpec = publicErrorSpec{
		code: "INTERNAL_ERROR", message: "The ServiceHost operation failed.", retryable: false,
	}
	upstreamErrorSpec = publicErrorSpec{
		code: "UPSTREAM_ERROR", message: "The Worker API returned an invalid response.", retryable: false,
	}
	upstreamUnavailableSpec = publicErrorSpec{
		code: "UPSTREAM_UNAVAILABLE", message: "The Worker API request failed.", retryable: true,
	}
	requestCancelledSpec = publicErrorSpec{
		code: "REQUEST_CANCELLED", message: "The local RPC operation was cancelled.", retryable: true,
	}
	requestTimeoutSpec = publicErrorSpec{
		code: "REQUEST_TIMEOUT", message: "The local RPC operation timed out.", retryable: true,
	}

	statusMappings = buildStatusMappings()
)

func buildStatusMappings() map[statusMappingKey]publicErrorSpec {
	mappings := make(map[statusMappingKey]publicErrorSpec)
	add := func(
		operation localrpc.Operation,
		status int,
		upstreamCode string,
		bodyRetryable bool,
		code string,
		message string,
		retryable bool,
	) {
		mappings[statusMappingKey{
			operation: operation, status: status, upstreamCode: upstreamCode, bodyRetryable: bodyRetryable,
		}] = publicErrorSpec{code: code, message: message, retryable: retryable}
	}

	workerOperations := []localrpc.Operation{
		localrpc.OperationRegister,
		localrpc.OperationClaim,
		localrpc.OperationInstanceHeartbeat,
		localrpc.OperationCompleteRun,
		localrpc.OperationFailRun,
	}
	for _, operation := range workerOperations {
		add(operation, 400, "request_validation_failed", false,
			"REQUEST_VALIDATION_FAILED", "The Worker API rejected the request.", false)
		add(operation, 400, "worker_identity_missing", false,
			"WORKER_IDENTITY_MISSING", "The Worker API request is missing a worker identity.", false)
		add(operation, 401, "worker_authentication_failed", false,
			"WORKER_AUTHENTICATION_FAILED", "The Worker API rejected the Worker Token.", false)
		add(operation, 403, "insecure_worker_auth_loopback_only", false,
			"INSECURE_WORKER_AUTH_LOOPBACK_ONLY", "The Worker API rejected insecure remote authentication.", false)
		add(operation, 403, "worker_identity_mismatch", false,
			"WORKER_IDENTITY_MISMATCH", "The Worker API rejected the worker identity.", false)
		add(operation, 413, "request_body_too_large", false,
			"REQUEST_BODY_TOO_LARGE", "The Worker API rejected an oversized request.", false)
		add(operation, 429, "request_rate_limited", true,
			"UPSTREAM_UNAVAILABLE", "The Worker API rate-limited the request.", true)
		add(operation, 500, "internal_error", true,
			"UPSTREAM_ERROR", "The Worker API could not complete the request.", true)
		add(operation, 503, "worker_authentication_unavailable", true,
			"UPSTREAM_UNAVAILABLE", "Worker authentication is temporarily unavailable.", true)
	}
	for _, operation := range []localrpc.Operation{
		localrpc.OperationClaim,
		localrpc.OperationInstanceHeartbeat,
		localrpc.OperationCompleteRun,
		localrpc.OperationFailRun,
	} {
		add(operation, 403, "worker_registration_required", false,
			"WORKER_REGISTRATION_REQUIRED", "The Worker must register before using this operation.", false)
	}

	add(localrpc.OperationRegister, 409, "protocol_version_unsupported", false,
		"PROTOCOL_VERSION_UNSUPPORTED", "The Worker API rejected the protocol version.", false)
	add(localrpc.OperationRegister, 409, "worker_instance_superseded", false,
		"WORKER_INSTANCE_SUPERSEDED", "The Worker API rejected a superseded worker instance.", false)

	add(localrpc.OperationInstanceHeartbeat, 400, "worker_instance_mismatch", false,
		"WORKER_INSTANCE_MISMATCH", "The Worker API rejected the worker instance identity.", false)
	add(localrpc.OperationInstanceHeartbeat, 409, "protocol_version_unsupported", false,
		"PROTOCOL_VERSION_UNSUPPORTED", "The Worker API rejected the protocol version.", false)
	add(localrpc.OperationInstanceHeartbeat, 409, "worker_unavailable", true,
		"WORKER_UNAVAILABLE", "The Worker API no longer recognizes this worker instance.", false)

	for _, operation := range []localrpc.Operation{localrpc.OperationCompleteRun, localrpc.OperationFailRun} {
		add(operation, 409, "lease_lost", false,
			"LEASE_LOST", "The Worker API rejected the lease authority.", false)
		add(operation, 409, "terminal_submission_conflict", false,
			"TERMINAL_SUBMISSION_CONFLICT", "The Worker API rejected a conflicting terminal submission.", false)
	}
	add(localrpc.OperationCompleteRun, 400, "result_digest_mismatch", false,
		"RESULT_DIGEST_MISMATCH", "The Worker API rejected the result digest.", false)
	add(localrpc.OperationCompleteRun, 413, "review_result_too_large", false,
		"REVIEW_RESULT_TOO_LARGE", "The Worker API rejected an oversized review result.", false)
	add(localrpc.OperationCompleteRun, 422, "review_result_invalid", false,
		"REVIEW_RESULT_INVALID", "The Worker API rejected the review result.", false)
	add(localrpc.OperationCompleteRun, 422, "stored_execution_template_invalid", false,
		"STORED_EXECUTION_TEMPLATE_INVALID", "The Worker API rejected the stored execution template.", false)

	return mappings
}

func classifyWorkerError(ctx context.Context, operation localrpc.Operation, err error) error {
	if contextErr := contextError(ctx); contextErr != nil {
		return contextErr
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, localrpc.ErrRequestTimeout) {
		return requestTimeoutSpec.newError()
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, localrpc.ErrRequestCancelled) {
		return requestCancelledSpec.newError()
	}

	var statusError *workertransport.StatusError
	if errors.As(err, &statusError) && statusError != nil {
		return classifyStatusError(operation, statusError).newError()
	}
	if errors.Is(err, workertransport.ErrInvalidConfiguration) ||
		errors.Is(err, workertransport.ErrInvalidEntityID) ||
		errors.Is(err, workertransport.ErrInvalidRequestJSON) ||
		errors.Is(err, workertransport.ErrRequestTooLarge) {
		return internalError()
	}
	if errors.Is(err, workertransport.ErrInvalidResponseJSON) ||
		errors.Is(err, workertransport.ErrResponseTooLarge) ||
		errors.Is(err, workertransport.ErrUnexpectedStatus) ||
		errors.Is(err, workertransport.ErrUnexpectedMediaType) ||
		errors.Is(err, workertransport.ErrContentEncoded) ||
		errors.Is(err, workertransport.ErrRedirect) {
		return upstreamProtocolError()
	}
	if isCertificateError(err) {
		return upstreamProtocolError()
	}
	if isTransportError(err) {
		return upstreamUnavailableSpec.newError()
	}
	return internalError()
}

func classifyStatusError(operation localrpc.Operation, statusError *workertransport.StatusError) publicErrorSpec {
	details, ok := parseStatusDetails(statusError.Body)
	if !ok {
		return fallbackStatusError(statusError.StatusCode)
	}
	key := statusMappingKey{
		operation: operation, status: statusError.StatusCode,
		upstreamCode: details.code, bodyRetryable: details.retryable,
	}
	if mapped, ok := statusMappings[key]; ok {
		return mapped
	}
	return fallbackStatusError(statusError.StatusCode)
}

func fallbackStatusError(statusCode int) publicErrorSpec {
	if statusCode == 408 || statusCode == 429 || statusCode >= 500 && statusCode <= 599 {
		return upstreamUnavailableSpec
	}
	return upstreamErrorSpec
}

func parseStatusDetails(body json.RawMessage) (statusDetails, bool) {
	if len(body) == 0 || len(body) > maximumStatusBodyBytes {
		return statusDetails{}, false
	}
	value, err := localrpc.ParseCanonicalJSON(body, maximumStatusBodyBytes)
	if err != nil {
		return statusDetails{}, false
	}
	object, ok := value.(map[string]any)
	if !ok || len(object) != 3 {
		return statusDetails{}, false
	}
	code, codeOK := object["code"].(string)
	message, messageOK := object["message"].(string)
	retryable, retryableOK := object["retryable"].(bool)
	if !codeOK || !messageOK || !retryableOK || len(message) == 0 || len(message) > 2048 ||
		!utf8.ValidString(message) || containsControlCharacter(message) {
		return statusDetails{}, false
	}
	return statusDetails{code: code, retryable: retryable}, true
}

func containsControlCharacter(value string) bool {
	for _, character := range value {
		if character < 0x20 {
			return true
		}
	}
	return false
}

func isTransportError(err error) bool {
	var urlError *url.Error
	if errors.As(err, &urlError) {
		if errors.Is(urlError.Err, io.EOF) || errors.Is(urlError.Err, io.ErrUnexpectedEOF) {
			return true
		}
		var innerNetworkError net.Error
		return errors.As(urlError.Err, &innerNetworkError)
	}
	var networkError net.Error
	return errors.As(err, &networkError)
}

func isCertificateError(err error) bool {
	var verificationError *tls.CertificateVerificationError
	if errors.As(err, &verificationError) {
		return true
	}
	var unknownAuthority x509.UnknownAuthorityError
	if errors.As(err, &unknownAuthority) {
		return true
	}
	var hostnameError x509.HostnameError
	if errors.As(err, &hostnameError) {
		return true
	}
	var certificateInvalid x509.CertificateInvalidError
	return errors.As(err, &certificateInvalid)
}

func contextError(ctx context.Context) error {
	if ctx == nil {
		return internalError()
	}
	if errors.Is(context.Cause(ctx), errDispatcherClosed) {
		return internalError()
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(context.Cause(ctx), localrpc.ErrRequestTimeout) {
		return requestTimeoutSpec.newError()
	}
	if ctx.Err() != nil {
		return requestCancelledSpec.newError()
	}
	return nil
}

func internalError() error {
	return internalErrorSpec.newError()
}

func upstreamProtocolError() error {
	return upstreamErrorSpec.newError()
}

func (spec publicErrorSpec) newError() error {
	return localrpc.NewPublicError(spec.code, spec.message, spec.retryable)
}
