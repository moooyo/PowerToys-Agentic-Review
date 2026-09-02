package artifactrpcv2

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/workertransport"
)

func TestDispatcherForwardsAllFiveOperationsWithDetachedBodies(t *testing.T) {
	body := json.RawMessage(` { "opaque" : true } `)
	client := &fakeArtifactClient{}
	var calls []string
	client.create = func(_ context.Context, request workertransport.CreateArtifactUploadRequest) (workertransport.CreateArtifactUploadResponse, error) {
		calls = append(calls, "create:"+request.RunAttemptID)
		assertDetachedBody(t, request.Body, body)
		return workertransport.CreateArtifactUploadResponse{Body: json.RawMessage(`{"operation":"create"}`)}, nil
	}
	client.put = func(_ context.Context, request workertransport.PutArtifactChunkRequest) (workertransport.PutArtifactChunkResponse, error) {
		calls = append(calls, "put:"+request.UploadID+":7")
		if request.ChunkIndex != 7 {
			t.Fatalf("chunk index = %d", request.ChunkIndex)
		}
		assertDetachedBody(t, request.Body, body)
		return workertransport.PutArtifactChunkResponse{Body: json.RawMessage(`{"operation":"put"}`)}, nil
	}
	client.finalize = func(_ context.Context, request workertransport.FinalizeArtifactUploadRequest) (workertransport.FinalizeArtifactUploadResponse, error) {
		calls = append(calls, "finalize:"+request.UploadID)
		assertDetachedBody(t, request.Body, body)
		return workertransport.FinalizeArtifactUploadResponse{Body: json.RawMessage(`{"operation":"finalize"}`)}, nil
	}
	client.terminate = func(_ context.Context, request workertransport.TerminateArtifactUploadRequest) (workertransport.TerminateArtifactUploadResponse, error) {
		calls = append(calls, "terminate:"+request.UploadID)
		assertDetachedBody(t, request.Body, body)
		return workertransport.TerminateArtifactUploadResponse{Body: json.RawMessage(`{"operation":"terminate"}`)}, nil
	}
	client.complete = func(_ context.Context, request workertransport.CompleteArtifactRunRequest) (workertransport.CompleteArtifactRunResponse, error) {
		calls = append(calls, "complete:"+request.RunAttemptID)
		assertDetachedBody(t, request.Body, body)
		return workertransport.CompleteArtifactRunResponse{Body: json.RawMessage(`{"operation":"complete"}`)}, nil
	}
	dispatcher := mustDispatcher(t, client)

	tests := []Call{
		{ID: "request:1", Operation: OperationCreateArtifactUpload, Body: body, RunAttemptID: "run:1"},
		{ID: "request:2", Operation: OperationPutArtifactChunk, Body: body, UploadID: "upload:1", ChunkIndex: 7},
		{ID: "request:3", Operation: OperationFinalizeArtifactUpload, Body: body, UploadID: "upload:1"},
		{ID: "request:4", Operation: OperationTerminateArtifactUpload, Body: body, UploadID: "upload:1"},
		{ID: "request:5", Operation: OperationCompleteArtifactRun, Body: body, RunAttemptID: "run:1"},
	}
	for _, call := range tests {
		response, err := dispatcher.Dispatch(context.Background(), call)
		if err != nil || !json.Valid(response) {
			t.Fatalf("Dispatch(%s) returned (%s, %v)", call.Operation, response, err)
		}
	}
	if strings.Join(calls, ",") != "create:run:1,put:upload:1:7,finalize:upload:1,terminate:upload:1,complete:run:1" {
		t.Fatalf("calls = %q", calls)
	}
	if body[0] != ' ' {
		t.Fatal("dependency mutation escaped into caller body")
	}
}

func TestDispatcherPreservesStrictServerCodeAndRetryabilityWithSanitizedMessage(t *testing.T) {
	client := &fakeArtifactClient{create: func(context.Context, workertransport.CreateArtifactUploadRequest) (workertransport.CreateArtifactUploadResponse, error) {
		return workertransport.CreateArtifactUploadResponse{}, fakeServerError(503, "artifact_storage_integrity", false)
	}}
	dispatcher := mustDispatcher(t, client)
	_, err := dispatcher.Dispatch(context.Background(), validCreateCall())
	assertPublicError(t, err, "artifact_storage_integrity", false)
	document, marshalErr := MarshalErrorResponse("request:status", err)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	want := `{"error":{"code":"artifact_storage_integrity","message":"The Worker API rejected the artifact operation.","retryable":false},"outcome":"error","protocolVersion":"2.0","requestId":"request:status","type":"response"}`
	if string(document) != want || strings.Contains(string(document), "secret") {
		t.Fatalf("status error golden = %s", document)
	}
}

func TestDispatcherMapsEveryUncertainDispatchedFailureToOneGolden(t *testing.T) {
	secret := "https://worker.invalid/private?leaseToken=secret"
	client := &fakeArtifactClient{create: func(context.Context, workertransport.CreateArtifactUploadRequest) (workertransport.CreateArtifactUploadResponse, error) {
		return workertransport.CreateArtifactUploadResponse{}, errors.New(secret)
	}}
	dispatcher := mustDispatcher(t, client)
	_, err := dispatcher.Dispatch(context.Background(), validCreateCall())
	assertPublicError(t, err, "artifact_outcome_unknown", true)
	document, marshalErr := MarshalErrorResponse("request:transport", err)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	want := `{"error":{"code":"artifact_outcome_unknown","message":"The artifact operation outcome is unknown.","retryable":true},"outcome":"error","protocolVersion":"2.0","requestId":"request:transport","type":"response"}`
	if string(document) != want || strings.Contains(string(document), secret) {
		t.Fatalf("transport error golden = %s", document)
	}

	client.create = func(context.Context, workertransport.CreateArtifactUploadRequest) (workertransport.CreateArtifactUploadResponse, error) {
		return workertransport.CreateArtifactUploadResponse{}, fakeServerError(503, "secret_lowercase_value", false)
	}
	_, err = dispatcher.Dispatch(context.Background(), validCreateCall())
	assertPublicError(t, err, "artifact_outcome_unknown", true)

	client.create = func(context.Context, workertransport.CreateArtifactUploadRequest) (workertransport.CreateArtifactUploadResponse, error) {
		return workertransport.CreateArtifactUploadResponse{}, fakeServerError(503, "artifact_transaction_not_ready", false)
	}
	_, err = dispatcher.Dispatch(context.Background(), validCreateCall())
	assertPublicError(t, err, "artifact_outcome_unknown", true)
}

func TestDispatcherRequiresAContractualLeaseLostStatus(t *testing.T) {
	status := 409
	client := &fakeArtifactClient{create: func(context.Context, workertransport.CreateArtifactUploadRequest) (workertransport.CreateArtifactUploadResponse, error) {
		return workertransport.CreateArtifactUploadResponse{}, fakeServerError(status, "lease_lost", false)
	}}
	dispatcher := mustDispatcher(t, client)
	_, err := dispatcher.Dispatch(context.Background(), validCreateCall())
	assertPublicError(t, err, "lease_lost", false)

	status = 503
	_, err = dispatcher.Dispatch(context.Background(), validCreateCall())
	assertPublicError(t, err, "artifact_outcome_unknown", true)

	client.create = func(context.Context, workertransport.CreateArtifactUploadRequest) (workertransport.CreateArtifactUploadResponse, error) {
		return workertransport.CreateArtifactUploadResponse{}, fakeServerError(400, "artifact_chunk_digest_mismatch", false)
	}
	_, err = dispatcher.Dispatch(context.Background(), validCreateCall())
	assertPublicError(t, err, "artifact_outcome_unknown", true)
}

func TestServerStatusAllowlistIsOperationSpecific(t *testing.T) {
	allOperations := []Operation{
		OperationCreateArtifactUpload,
		OperationPutArtifactChunk,
		OperationFinalizeArtifactUpload,
		OperationTerminateArtifactUpload,
		OperationCompleteArtifactRun,
	}
	uploadOperations := map[Operation]bool{
		OperationCreateArtifactUpload:    true,
		OperationPutArtifactChunk:        true,
		OperationFinalizeArtifactUpload:  true,
		OperationTerminateArtifactUpload: true,
	}
	allOperationSet := map[Operation]bool{
		OperationCreateArtifactUpload:    true,
		OperationPutArtifactChunk:        true,
		OperationFinalizeArtifactUpload:  true,
		OperationTerminateArtifactUpload: true,
		OperationCompleteArtifactRun:     true,
	}
	tests := []struct {
		name    string
		status  int
		details statusDetails
		allowed map[Operation]bool
	}{
		{
			name: "route identity", status: 400,
			details: statusDetails{Code: "run_attempt_mismatch"},
			allowed: map[Operation]bool{OperationCreateArtifactUpload: true, OperationCompleteArtifactRun: true},
		},
		{
			name: "upload request invalid", status: 400,
			details: statusDetails{Code: "artifact_request_invalid"}, allowed: uploadOperations,
		},
		{
			name: "chunk route identity", status: 400,
			details: statusDetails{Code: "artifact_chunk_index_mismatch"},
			allowed: map[Operation]bool{OperationPutArtifactChunk: true},
		},
		{
			name: "chunk digest", status: 400,
			details: statusDetails{Code: "artifact_chunk_digest_mismatch"},
			allowed: map[Operation]bool{OperationPutArtifactChunk: true},
		},
		{
			name: "chunk encoding", status: 400,
			details: statusDetails{Code: "artifact_chunk_encoding_invalid"},
			allowed: map[Operation]bool{OperationPutArtifactChunk: true},
		},
		{
			name: "chunk length", status: 400,
			details: statusDetails{Code: "artifact_chunk_length_mismatch"},
			allowed: map[Operation]bool{OperationPutArtifactChunk: true},
		},
		{
			name: "chunk range", status: 400,
			details: statusDetails{Code: "artifact_chunk_range_invalid"},
			allowed: map[Operation]bool{OperationPutArtifactChunk: true},
		},
		{
			name: "chunk request", status: 400,
			details: statusDetails{Code: "artifact_chunk_request_invalid"},
			allowed: map[Operation]bool{OperationPutArtifactChunk: true},
		},
		{
			name: "completion digest", status: 400,
			details: statusDetails{Code: "result_digest_mismatch"},
			allowed: map[Operation]bool{OperationCompleteArtifactRun: true},
		},
		{
			name: "completion terminal conflict", status: 409,
			details: statusDetails{Code: "terminal_submission_conflict"},
			allowed: map[Operation]bool{OperationCompleteArtifactRun: true},
		},
		{
			name: "completion mode", status: 409,
			details: statusDetails{Code: "artifact_completion_mode_mismatch"}, allowed: allOperationSet,
		},
		{
			name: "upload conflict", status: 409,
			details: statusDetails{Code: "artifact_upload_conflict"}, allowed: uploadOperations,
		},
		{
			name: "lease lost", status: 409,
			details: statusDetails{Code: "lease_lost"}, allowed: allOperationSet,
		},
		{
			name: "create quota", status: 409,
			details: statusDetails{Code: "artifact_upload_quota_exceeded"},
			allowed: map[Operation]bool{OperationCreateArtifactUpload: true},
		},
		{
			name: "upload closed", status: 503,
			details: statusDetails{Code: "artifact_transaction_closed"}, allowed: uploadOperations,
		},
		{
			name: "create capacity", status: 507,
			details: statusDetails{Code: "artifact_storage_capacity", Retryable: true},
			allowed: map[Operation]bool{OperationCreateArtifactUpload: true},
		},
	}
	for _, code := range []string{
		"artifact_result_encoding_invalid",
		"artifact_result_json_invalid",
		"review_result_invalid",
		"stored_execution_template_invalid",
	} {
		tests = append(tests, struct {
			name    string
			status  int
			details statusDetails
			allowed map[Operation]bool
		}{
			name: code, status: 422, details: statusDetails{Code: code},
			allowed: map[Operation]bool{OperationCompleteArtifactRun: true},
		})
	}
	for _, test := range []struct {
		name      string
		status    int
		code      string
		retryable bool
	}{
		{name: "request validation", status: 400, code: "request_validation_failed"},
		{name: "worker identity", status: 400, code: "worker_identity_missing"},
		{name: "mTLS required", status: 401, code: "worker_mtls_required"},
		{name: "certificate unauthorized", status: 401, code: "worker_certificate_unauthorized"},
		{name: "certificate missing", status: 401, code: "worker_certificate_missing"},
		{name: "transport authentication", status: 401, code: "worker_transport_authentication_failed"},
		{name: "authentication state invalid", status: 401, code: "worker_authentication_state_invalid"},
		{name: "authentication state missing", status: 401, code: "worker_authentication_state_missing"},
		{name: "insecure loopback", status: 403, code: "insecure_worker_auth_loopback_only"},
		{name: "certificate unmapped", status: 403, code: "worker_certificate_unmapped"},
		{name: "worker identity mismatch", status: 403, code: "worker_identity_mismatch"},
		{name: "body too large", status: 413, code: "request_body_too_large"},
		{name: "transaction busy", status: 429, code: "artifact_transaction_busy", retryable: true},
		{name: "transaction cancelled", status: 503, code: "artifact_transaction_cancelled", retryable: true},
		{name: "transaction not ready", status: 503, code: "artifact_transaction_not_ready", retryable: true},
		{name: "transaction timeout", status: 503, code: "artifact_transaction_timeout", retryable: true},
		{name: "storage integrity", status: 503, code: "artifact_storage_integrity"},
	} {
		tests = append(tests, struct {
			name    string
			status  int
			details statusDetails
			allowed map[Operation]bool
		}{
			name: test.name, status: test.status,
			details: statusDetails{Code: test.code, Retryable: test.retryable},
			allowed: allOperationSet,
		})
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			for _, operation := range allOperations {
				want := test.allowed[operation]
				if got := allowlistedServerStatus(operation, test.status, test.details); got != want {
					t.Errorf("allowlistedServerStatus(%s) = %t, want %t", operation, got, want)
				}
			}
		})
	}
}

func TestDispatcherPreservesServerFailStopAsNonRetryableAmbiguity(t *testing.T) {
	client := &fakeArtifactClient{
		create: func(context.Context, workertransport.CreateArtifactUploadRequest) (workertransport.CreateArtifactUploadResponse, error) {
			return workertransport.CreateArtifactUploadResponse{}, fakeServerError(503, "artifact_service_unavailable", false)
		},
		complete: func(context.Context, workertransport.CompleteArtifactRunRequest) (workertransport.CompleteArtifactRunResponse, error) {
			return workertransport.CompleteArtifactRunResponse{}, fakeServerError(503, "artifact_service_unavailable", false)
		},
	}
	dispatcher := mustDispatcher(t, client)
	_, err := dispatcher.Dispatch(context.Background(), validCreateCall())
	assertPublicError(t, err, "artifact_outcome_unknown", false)
	_, err = dispatcher.Dispatch(context.Background(), Call{
		ID: "request:complete", Operation: OperationCompleteArtifactRun,
		Body: json.RawMessage(`{}`), RunAttemptID: "run:1",
	})
	assertPublicError(t, err, "artifact_outcome_unknown", false)
}

func TestDispatcherDistinguishesOnlyProvablePreDispatchCancellation(t *testing.T) {
	var calls atomic.Int32
	client := &fakeArtifactClient{create: func(context.Context, workertransport.CreateArtifactUploadRequest) (workertransport.CreateArtifactUploadResponse, error) {
		calls.Add(1)
		return workertransport.CreateArtifactUploadResponse{Body: json.RawMessage(`{}`)}, nil
	}}
	dispatcher := mustDispatcher(t, client)
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := dispatcher.Dispatch(cancelled, validCreateCall())
	assertPublicError(t, err, "artifact_request_cancelled", false)
	expired, expire := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer expire()
	_, err = dispatcher.Dispatch(expired, validCreateCall())
	assertPublicError(t, err, "artifact_request_timeout", false)
	if calls.Load() != 0 {
		t.Fatal("pre-dispatch cancellation reached the transport")
	}
}

func TestDispatcherTreatsCancellationAfterInvocationAsAmbiguousUnlessAStatusArrives(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	client := &fakeArtifactClient{create: func(context.Context, workertransport.CreateArtifactUploadRequest) (workertransport.CreateArtifactUploadResponse, error) {
		cancel()
		return workertransport.CreateArtifactUploadResponse{Body: json.RawMessage(`{}`)}, nil
	}}
	dispatcher := mustDispatcher(t, client)
	_, err := dispatcher.Dispatch(ctx, validCreateCall())
	assertPublicError(t, err, "artifact_outcome_unknown", true)

	ctx, cancel = context.WithCancel(context.Background())
	client.create = func(context.Context, workertransport.CreateArtifactUploadRequest) (workertransport.CreateArtifactUploadResponse, error) {
		cancel()
		return workertransport.CreateArtifactUploadResponse{}, fakeServerError(409, "lease_lost", false)
	}
	_, err = dispatcher.Dispatch(ctx, validCreateCall())
	assertPublicError(t, err, "lease_lost", false)
}

func TestDispatcherRejectsInvalidCallsBeforeTransport(t *testing.T) {
	var calls atomic.Int32
	client := &fakeArtifactClient{create: func(context.Context, workertransport.CreateArtifactUploadRequest) (workertransport.CreateArtifactUploadResponse, error) {
		calls.Add(1)
		return workertransport.CreateArtifactUploadResponse{}, nil
	}}
	dispatcher := mustDispatcher(t, client)
	invalid := []Call{
		{},
		{ID: "request:1", Operation: OperationCreateArtifactUpload, Body: json.RawMessage(`[]`), RunAttemptID: "run:1"},
		{ID: "request:1", Operation: OperationCreateArtifactUpload, Body: json.RawMessage(`{}`), RunAttemptID: "../escape"},
		{ID: "request:1", Operation: OperationCreateArtifactUpload, Body: json.RawMessage(`{}`), RunAttemptID: "run:1", UploadID: "upload:1"},
	}
	for _, call := range invalid {
		_, err := dispatcher.Dispatch(context.Background(), call)
		assertPublicError(t, err, "artifact_request_invalid", false)
	}
	if calls.Load() != 0 {
		t.Fatal("invalid call reached the transport")
	}
}

func TestDispatcherTreatsInvalidOrLateSuccessAsUnknown(t *testing.T) {
	client := &fakeArtifactClient{create: func(context.Context, workertransport.CreateArtifactUploadRequest) (workertransport.CreateArtifactUploadResponse, error) {
		return workertransport.CreateArtifactUploadResponse{Body: json.RawMessage(`[]`)}, nil
	}}
	dispatcher := mustDispatcher(t, client)
	_, err := dispatcher.Dispatch(context.Background(), validCreateCall())
	assertPublicError(t, err, "artifact_outcome_unknown", true)
}

type fakeArtifactClient struct {
	create    func(context.Context, workertransport.CreateArtifactUploadRequest) (workertransport.CreateArtifactUploadResponse, error)
	put       func(context.Context, workertransport.PutArtifactChunkRequest) (workertransport.PutArtifactChunkResponse, error)
	finalize  func(context.Context, workertransport.FinalizeArtifactUploadRequest) (workertransport.FinalizeArtifactUploadResponse, error)
	terminate func(context.Context, workertransport.TerminateArtifactUploadRequest) (workertransport.TerminateArtifactUploadResponse, error)
	complete  func(context.Context, workertransport.CompleteArtifactRunRequest) (workertransport.CompleteArtifactRunResponse, error)
}

type fakeArtifactServerError struct {
	statusCode int
	code       string
	retryable  bool
}

func (e *fakeArtifactServerError) Error() string { return "sanitized fake Server error" }

func (e *fakeArtifactServerError) StatusCode() int { return e.statusCode }

func (e *fakeArtifactServerError) Details() (string, bool, bool) {
	return e.code, e.retryable, true
}

func fakeServerError(statusCode int, code string, retryable bool) error {
	return &fakeArtifactServerError{statusCode: statusCode, code: code, retryable: retryable}
}

func (c *fakeArtifactClient) CreateArtifactUpload(ctx context.Context, request workertransport.CreateArtifactUploadRequest) (workertransport.CreateArtifactUploadResponse, error) {
	return c.create(ctx, request)
}

func (c *fakeArtifactClient) PutArtifactChunk(ctx context.Context, request workertransport.PutArtifactChunkRequest) (workertransport.PutArtifactChunkResponse, error) {
	return c.put(ctx, request)
}

func (c *fakeArtifactClient) FinalizeArtifactUpload(ctx context.Context, request workertransport.FinalizeArtifactUploadRequest) (workertransport.FinalizeArtifactUploadResponse, error) {
	return c.finalize(ctx, request)
}

func (c *fakeArtifactClient) TerminateArtifactUpload(ctx context.Context, request workertransport.TerminateArtifactUploadRequest) (workertransport.TerminateArtifactUploadResponse, error) {
	return c.terminate(ctx, request)
}

func (c *fakeArtifactClient) CompleteArtifactRun(ctx context.Context, request workertransport.CompleteArtifactRunRequest) (workertransport.CompleteArtifactRunResponse, error) {
	return c.complete(ctx, request)
}

func validCreateCall() Call {
	return Call{ID: "request:1", Operation: OperationCreateArtifactUpload, Body: json.RawMessage(`{}`), RunAttemptID: "run:1"}
}

func mustDispatcher(t *testing.T, client artifactClient) *Dispatcher {
	t.Helper()
	dispatcher, err := newDispatcher(client)
	if err != nil {
		t.Fatal(err)
	}
	return dispatcher
}

func assertDetachedBody(t *testing.T, got, original json.RawMessage) {
	t.Helper()
	if !bytes.Equal(got, original) || len(got) == 0 {
		t.Fatalf("body = %q, want %q", got, original)
	}
	got[0] = '['
}

func assertPublicError(t *testing.T, err error, code string, retryable bool) {
	t.Helper()
	var public *PublicError
	if !errors.As(err, &public) || public == nil || public.Code() != code || public.Retryable() != retryable {
		t.Fatalf("public error = %#v, want code=%s retryable=%t", err, code, retryable)
	}
}
