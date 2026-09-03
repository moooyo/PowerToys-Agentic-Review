package workertransport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

func TestArtifactClientV2ExposesOnlyTheFiveFixedOperations(t *testing.T) {
	clientType := reflect.TypeOf((*ArtifactClientV2)(nil))
	expected := map[string]bool{
		"CompleteArtifactRun":     true,
		"CreateArtifactUpload":    true,
		"FinalizeArtifactUpload":  true,
		"PutArtifactChunk":        true,
		"TerminateArtifactUpload": true,
	}
	if clientType.NumMethod() != len(expected) {
		t.Fatalf("ArtifactClientV2 exposes %d methods, want %d", clientType.NumMethod(), len(expected))
	}
	for index := 0; index < clientType.NumMethod(); index++ {
		method := clientType.Method(index)
		if !expected[method.Name] {
			t.Errorf("ArtifactClientV2 exposes unexpected method %s", method.Name)
		}
	}
	if ArtifactControlRequestMaximumBytes != 16_384 ||
		ArtifactChunkRequestMaximumBytes != 365_910 ||
		ArtifactResponseMaximumBytes != 16_384 || ArtifactMaximumChunkIndex != 7 {
		t.Fatal("artifact transport constants drifted from the reviewed contract")
	}
	assertArtifactStructFields(t, reflect.TypeOf(CreateArtifactUploadRequest{}), "RunAttemptID", "Body")
	assertArtifactStructFields(t, reflect.TypeOf(PutArtifactChunkRequest{}), "UploadID", "ChunkIndex", "Body")
	assertArtifactStructFields(t, reflect.TypeOf(FinalizeArtifactUploadRequest{}), "UploadID", "Body")
	assertArtifactStructFields(t, reflect.TypeOf(TerminateArtifactUploadRequest{}), "UploadID", "Body")
	assertArtifactStructFields(t, reflect.TypeOf(CompleteArtifactRunRequest{}), "RunAttemptID", "Body")
}

func TestArtifactClientV2UsesOnlyFixedRoutesMethodsAndHeaders(t *testing.T) {
	type observation struct {
		method  string
		target  string
		headers http.Header
		body    string
	}
	var observations []observation
	client := artifactTestClient(t, roundTripFunc(func(request *http.Request) (*http.Response, error) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			return nil, err
		}
		observations = append(observations, observation{
			method: request.Method, target: request.URL.String(), headers: request.Header.Clone(), body: string(body),
		})
		status := http.StatusOK
		if strings.HasSuffix(request.URL.Path, "/artifacts") {
			status = http.StatusCreated
		}
		return jsonHTTPResponse(status, `{"accepted":true}`), nil
	}))
	body := json.RawMessage(`{"request":true}`)

	if _, err := client.CreateArtifactUpload(context.Background(), CreateArtifactUploadRequest{
		RunAttemptID: "run:1", Body: body,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.PutArtifactChunk(context.Background(), PutArtifactChunkRequest{
		UploadID: "upload:1", ChunkIndex: 7, Body: body,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.FinalizeArtifactUpload(context.Background(), FinalizeArtifactUploadRequest{
		UploadID: "upload:1", Body: body,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.TerminateArtifactUpload(context.Background(), TerminateArtifactUploadRequest{
		UploadID: "upload:1", Body: body,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.CompleteArtifactRun(context.Background(), CompleteArtifactRunRequest{
		RunAttemptID: "run:1", Body: body,
	}); err != nil {
		t.Fatal(err)
	}

	expected := []struct {
		method string
		target string
	}{
		{http.MethodPost, "https://api.worker.test:8443/api/v1/worker/runs/run:1/artifacts"},
		{http.MethodPut, "https://api.worker.test:8443/api/v1/worker/artifact-uploads/upload:1/chunks/7"},
		{http.MethodPost, "https://api.worker.test:8443/api/v1/worker/artifact-uploads/upload:1/complete"},
		{http.MethodPost, "https://api.worker.test:8443/api/v1/worker/artifact-uploads/upload:1/terminate"},
		{http.MethodPost, "https://api.worker.test:8443/api/v1/worker/runs/run:1/complete"},
	}
	if len(observations) != len(expected) {
		t.Fatalf("transport calls = %d, want %d", len(observations), len(expected))
	}
	for index, want := range expected {
		got := observations[index]
		if got.method != want.method || got.target != want.target || got.body != string(body) {
			t.Errorf("request %d = %s %s %q", index, got.method, got.target, got.body)
		}
		if !headersEqual(got.headers, http.Header{
			"Accept": {"application/json"}, "Authorization": {"Bearer " + testWorkerToken},
			"Content-Type": {"application/json"}, "User-Agent": {workerUserAgent},
		}) {
			t.Errorf("request %d sent unexpected headers: %#v", index, got.headers)
		}
	}
}

func TestArtifactClientV2PinsSuccessStatuses(t *testing.T) {
	tests := []struct {
		name   string
		status int
		invoke func(*ArtifactClientV2) error
		ok     bool
	}{
		{name: "create 200", status: 200, ok: true, invoke: invokeArtifactCreate},
		{name: "create 201", status: 201, ok: true, invoke: invokeArtifactCreate},
		{name: "create 202", status: 202, invoke: invokeArtifactCreate},
		{name: "put 200", status: 200, ok: true, invoke: invokeArtifactPut},
		{name: "put 201", status: 201, invoke: invokeArtifactPut},
		{name: "finalize 204", status: 204, invoke: invokeArtifactFinalize},
		{name: "terminate 202", status: 202, invoke: invokeArtifactTerminate},
		{name: "complete 201", status: 201, invoke: invokeArtifactComplete},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := artifactTestClient(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
				return jsonHTTPResponse(test.status, `{"ok":true}`), nil
			}))
			err := test.invoke(client)
			if test.ok && err != nil {
				t.Fatalf("expected success, got %v", err)
			}
			if !test.ok && !errors.Is(err, ErrUnexpectedStatus) {
				t.Fatalf("expected exact-status rejection, got %v", err)
			}
		})
	}
}

func TestArtifactClientV2SanitizesServerErrorsBeforeReturning(t *testing.T) {
	secret := strings.Repeat("a", 32)
	tests := []struct {
		name          string
		body          string
		wantCode      string
		wantRetryable bool
		wantDetails   bool
	}{
		{
			name:     "strict details",
			body:     `{"code":"lease_lost","message":"` + secret + `","retryable":false}`,
			wantCode: "lease_lost", wantRetryable: false, wantDetails: true,
		},
		{
			name: "null retryable",
			body: `{"code":"lease_lost","message":"` + secret + `","retryable":null}`,
		},
		{
			name: "null code",
			body: `{"code":null,"message":"` + secret + `","retryable":false}`,
		},
		{
			name: "unknown reflected code",
			body: `{"code":"` + secret + `","message":"` + secret + `","retryable":false}`,
		},
		{
			name: "duplicate code",
			body: `{"code":"lease_lost","code":"artifact_storage_integrity","message":"` + secret + `","retryable":false}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := artifactTestClient(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
				return jsonHTTPResponse(http.StatusConflict, test.body), nil
			}))
			err := invokeArtifactCreate(client)
			var serverError *ArtifactServerError
			if !errors.As(err, &serverError) || serverError == nil {
				t.Fatalf("server error = %T, want *ArtifactServerError", err)
			}
			if serverError.StatusCode() != http.StatusConflict {
				t.Fatalf("status = %d", serverError.StatusCode())
			}
			code, retryable, ok := serverError.Details()
			if code != test.wantCode || retryable != test.wantRetryable || ok != test.wantDetails {
				t.Fatalf("details = (%q, %t, %t)", code, retryable, ok)
			}
			var rawStatus *StatusError
			if errors.As(err, &rawStatus) {
				t.Fatal("ArtifactClientV2 returned a raw StatusError")
			}
			encoded, marshalErr := json.Marshal(err)
			if marshalErr != nil {
				t.Fatal(marshalErr)
			}
			diagnostic := string(encoded) + err.Error() + fmt.Sprintf("%#v", err)
			if strings.Contains(diagnostic, secret) || strings.Contains(diagnostic, test.body) {
				t.Fatalf("sanitized error retained response data: %s", diagnostic)
			}
		})
	}
}

func TestArtifactClientV2AppliesOperationSpecificByteLimits(t *testing.T) {
	var calls atomic.Int32
	client := artifactTestClient(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return jsonHTTPResponse(http.StatusOK, `{"ok":true}`), nil
	}))
	controlBody := exactJSONBody(ArtifactControlRequestMaximumBytes)
	chunkBody := exactJSONBody(ArtifactChunkRequestMaximumBytes)
	if _, err := client.CreateArtifactUpload(context.Background(), CreateArtifactUploadRequest{
		RunAttemptID: "run:1", Body: controlBody,
	}); err != nil {
		t.Fatalf("exact control body failed: %v", err)
	}
	if _, err := client.PutArtifactChunk(context.Background(), PutArtifactChunkRequest{
		UploadID: "upload:1", ChunkIndex: 0, Body: chunkBody,
	}); err != nil {
		t.Fatalf("exact chunk body failed: %v", err)
	}
	if _, err := client.CreateArtifactUpload(context.Background(), CreateArtifactUploadRequest{
		RunAttemptID: "run:1", Body: append(controlBody, ' '),
	}); !errors.Is(err, ErrRequestTooLarge) {
		t.Fatalf("oversized control body returned %v", err)
	}
	if _, err := client.PutArtifactChunk(context.Background(), PutArtifactChunkRequest{
		UploadID: "upload:1", ChunkIndex: 0, Body: append(chunkBody, ' '),
	}); !errors.Is(err, ErrRequestTooLarge) {
		t.Fatalf("oversized chunk body returned %v", err)
	}
	if calls.Load() != 2 {
		t.Fatalf("transport calls = %d, want 2", calls.Load())
	}

	oversizedResponse := string(exactJSONBody(ArtifactResponseMaximumBytes + 1))
	client = artifactTestClient(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
		return jsonHTTPResponse(http.StatusOK, oversizedResponse), nil
	}))
	if err := invokeArtifactPut(client); !errors.Is(err, ErrResponseTooLarge) {
		t.Fatalf("oversized artifact response returned %v", err)
	}
}

func TestArtifactClientV2RejectsInvalidRoutesBeforeTransport(t *testing.T) {
	var calls atomic.Int32
	client := artifactTestClient(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return jsonHTTPResponse(http.StatusOK, `{}`), nil
	}))
	for _, identifier := range []string{"", "../escape", "white space", strings.Repeat("a", 129)} {
		if _, err := client.CreateArtifactUpload(context.Background(), CreateArtifactUploadRequest{
			RunAttemptID: identifier, Body: json.RawMessage(`{}`),
		}); !errors.Is(err, ErrInvalidEntityID) {
			t.Errorf("create accepted route ID %q: %v", identifier, err)
		}
		if _, err := client.FinalizeArtifactUpload(context.Background(), FinalizeArtifactUploadRequest{
			UploadID: identifier, Body: json.RawMessage(`{}`),
		}); !errors.Is(err, ErrInvalidEntityID) {
			t.Errorf("finalize accepted route ID %q: %v", identifier, err)
		}
	}
	for _, index := range []int{-1, 8} {
		if _, err := client.PutArtifactChunk(context.Background(), PutArtifactChunkRequest{
			UploadID: "upload:1", ChunkIndex: index, Body: json.RawMessage(`{}`),
		}); !errors.Is(err, ErrInvalidArtifactChunkIndex) {
			t.Errorf("put accepted chunk index %d: %v", index, err)
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("invalid routes reached transport %d times", calls.Load())
	}
}

func TestArtifactClientV2BorrowsClientLifecycle(t *testing.T) {
	base := testClient(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
		return jsonHTTPResponse(http.StatusOK, `{}`), nil
	}), artifactTestLimits())
	capability, err := NewArtifactClientV2(base)
	if err != nil {
		t.Fatal(err)
	}
	if err := base.Close(); err != nil {
		t.Fatal(err)
	}
	if err := invokeArtifactCreate(capability); !errors.Is(err, ErrClosed) {
		t.Fatalf("borrowed capability survived Client.Close: %v", err)
	}
	if _, err := NewArtifactClientV2(nil); !errors.Is(err, ErrClosed) {
		t.Fatalf("nil Client returned %v", err)
	}
}

func artifactTestClient(t *testing.T, roundTripper http.RoundTripper) *ArtifactClientV2 {
	t.Helper()
	base := testClient(t, roundTripper, artifactTestLimits())
	client, err := NewArtifactClientV2(base)
	if err != nil {
		t.Fatalf("derive ArtifactClientV2: %v", err)
	}
	return client
}

func artifactTestLimits() Limits {
	limits := testLimits()
	limits.MaximumRequestBytes = ArtifactChunkRequestMaximumBytes
	limits.MaximumResponseBytes = ArtifactResponseMaximumBytes + 1
	return limits
}

func exactJSONBody(maximum int64) json.RawMessage {
	return json.RawMessage(`{"value":"` + strings.Repeat("x", int(maximum)-12) + `"}`)
}

func invokeArtifactCreate(client *ArtifactClientV2) error {
	_, err := client.CreateArtifactUpload(context.Background(), CreateArtifactUploadRequest{
		RunAttemptID: "run:1", Body: json.RawMessage(`{}`),
	})
	return err
}

func invokeArtifactPut(client *ArtifactClientV2) error {
	_, err := client.PutArtifactChunk(context.Background(), PutArtifactChunkRequest{
		UploadID: "upload:1", ChunkIndex: 0, Body: json.RawMessage(`{}`),
	})
	return err
}

func invokeArtifactFinalize(client *ArtifactClientV2) error {
	_, err := client.FinalizeArtifactUpload(context.Background(), FinalizeArtifactUploadRequest{
		UploadID: "upload:1", Body: json.RawMessage(`{}`),
	})
	return err
}

func invokeArtifactTerminate(client *ArtifactClientV2) error {
	_, err := client.TerminateArtifactUpload(context.Background(), TerminateArtifactUploadRequest{
		UploadID: "upload:1", Body: json.RawMessage(`{}`),
	})
	return err
}

func invokeArtifactComplete(client *ArtifactClientV2) error {
	_, err := client.CompleteArtifactRun(context.Background(), CompleteArtifactRunRequest{
		RunAttemptID: "run:1", Body: json.RawMessage(`{}`),
	})
	return err
}

func assertArtifactStructFields(t *testing.T, structure reflect.Type, expected ...string) {
	t.Helper()
	if structure.NumField() != len(expected) {
		t.Fatalf("%s fields = %d, want %d", structure.Name(), structure.NumField(), len(expected))
	}
	for index, name := range expected {
		if structure.Field(index).Name != name {
			t.Fatalf("%s field %d = %s, want %s", structure.Name(), index, structure.Field(index).Name, name)
		}
	}
}
