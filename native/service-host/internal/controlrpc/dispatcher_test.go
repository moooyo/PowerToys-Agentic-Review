package controlrpc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/cng"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/workertransport"
)

func TestDispatcherForwardsEveryOperationWithDetachedExactBodies(t *testing.T) {
	registerBody := json.RawMessage(` { "operation" : "register", "confidence" : 0.8 } `)
	claimBody := json.RawMessage(` { "operation" : "claim", "minimum" : 5e-324 } `)
	heartbeatBody := json.RawMessage(` { "operation" : "heartbeat", "escaped" : "\u0061" } `)
	completeBody := json.RawMessage(` { "operation" : "complete", "maximum" : 1.7976931348623157e+308 } `)
	failBody := json.RawMessage(` { "operation" : "fail", "value" : -0 } `)
	registerResponse := json.RawMessage(` { "z" : 1, "a" : 2 } `)
	claimResponse := json.RawMessage(` { "retryAfterMs" : 1e0, "outcome" : "no_work" } `)
	heartbeatResponse := json.RawMessage(` { "workerState" : "online", "nextHeartbeatInMs" : 1.0 } `)
	completeResponse := json.RawMessage(
		` { "runState" : "succeeded", "runAttemptId" : "run:complete", "jobState" : "succeeded", "jobId" : "job:complete" } `,
	)
	failResponse := json.RawMessage(
		` { "runState" : "failed", "runAttemptId" : "run:fail", "jobState" : "failed", "jobId" : "job:fail" } `,
	)

	client := &fakeWorkerClient{}
	client.register = func(_ context.Context, request workertransport.RegisterRequest) (workertransport.RegisterResponse, error) {
		assertDetachedRequest(t, request.Body, registerBody)
		return workertransport.RegisterResponse{Body: registerResponse}, nil
	}
	client.claim = func(_ context.Context, request workertransport.ClaimRequest) (workertransport.ClaimResponse, error) {
		assertDetachedRequest(t, request.Body, claimBody)
		return workertransport.ClaimResponse{Body: claimResponse}, nil
	}
	client.heartbeat = func(
		_ context.Context,
		request workertransport.InstanceHeartbeatRequest,
	) (workertransport.InstanceHeartbeatResponse, error) {
		if request.WorkerInstanceID != "worker:instance" {
			t.Fatalf("unexpected worker instance ID %q", request.WorkerInstanceID)
		}
		assertDetachedRequest(t, request.Body, heartbeatBody)
		return workertransport.InstanceHeartbeatResponse{Body: heartbeatResponse}, nil
	}
	client.complete = func(
		_ context.Context,
		request workertransport.RunCompleteRequest,
	) (workertransport.RunCompleteResponse, error) {
		if request.RunAttemptID != "run:complete" {
			t.Fatalf("unexpected complete run ID %q", request.RunAttemptID)
		}
		assertDetachedRequest(t, request.Body, completeBody)
		return workertransport.RunCompleteResponse{Body: completeResponse}, nil
	}
	client.fail = func(
		_ context.Context,
		request workertransport.RunFailRequest,
	) (workertransport.RunFailResponse, error) {
		if request.RunAttemptID != "run:fail" {
			t.Fatalf("unexpected fail run ID %q", request.RunAttemptID)
		}
		assertDetachedRequest(t, request.Body, failBody)
		return workertransport.RunFailResponse{Body: failResponse}, nil
	}

	signatureSource := validTestSignature()
	signer := &fakeLocalAuthoritySigner{
		sign: func(digest []byte) ([]byte, error) {
			if !bytes.Equal(digest, bytes.Repeat([]byte{0x5a}, cng.DigestSize)) {
				t.Fatalf("unexpected digest: %x", digest)
			}
			digest[0] = 0
			return signatureSource, nil
		},
	}
	dispatcher := mustTestDispatcher(t, client, signer)
	t.Cleanup(func() { _ = dispatcher.Close() })

	registered, err := dispatcher.Register(context.Background(), registerBody)
	if err != nil || !bytes.Equal(registered, registerResponse) {
		t.Fatalf("Register returned (%s, %v)", registered, err)
	}
	claimed, err := dispatcher.Claim(context.Background(), claimBody)
	if err != nil || !bytes.Equal(claimed, claimResponse) {
		t.Fatalf("Claim returned (%s, %v)", claimed, err)
	}
	heartbeat, err := dispatcher.InstanceHeartbeat(context.Background(), "worker:instance", heartbeatBody)
	if err != nil || !bytes.Equal(heartbeat, heartbeatResponse) {
		t.Fatalf("InstanceHeartbeat returned (%s, %v)", heartbeat, err)
	}
	completed, err := dispatcher.CompleteRun(context.Background(), "run:complete", completeBody)
	if err != nil || !bytes.Equal(completed, completeResponse) {
		t.Fatalf("CompleteRun returned (%s, %v)", completed, err)
	}
	failed, err := dispatcher.FailRun(context.Background(), "run:fail", failBody)
	if err != nil || !bytes.Equal(failed, failResponse) {
		t.Fatalf("FailRun returned (%s, %v)", failed, err)
	}

	var digest [cng.DigestSize]byte
	for index := range digest {
		digest[index] = 0x5a
	}
	signature, err := dispatcher.SignLocalDigest(context.Background(), digest)
	if err != nil || !bytes.Equal(signature, signatureSource) {
		t.Fatalf("SignLocalDigest returned (%x, %v)", signature, err)
	}

	registerResponse[0] = '['
	claimResponse[0] = '['
	heartbeatResponse[0] = '['
	completeResponse[0] = '['
	failResponse[0] = '['
	signatureSource[0] = 0xff
	if registered[0] != ' ' || claimed[0] != ' ' || heartbeat[0] != ' ' ||
		completed[0] != ' ' || failed[0] != ' ' ||
		signature[0] != 0 {
		t.Fatal("dispatcher returned storage aliased to a dependency")
	}
	for _, body := range []json.RawMessage{registerBody, claimBody, heartbeatBody, completeBody, failBody} {
		if body[0] != ' ' {
			t.Fatal("dependency mutation escaped into a caller request body")
		}
	}
}

func TestDispatcherAppliesIndependentRequestAndResponseLimits(t *testing.T) {
	var registerCalls atomic.Int32
	client := &fakeWorkerClient{}
	client.register = func(context.Context, workertransport.RegisterRequest) (workertransport.RegisterResponse, error) {
		registerCalls.Add(1)
		return workertransport.RegisterResponse{Body: json.RawMessage(`{}`)}, nil
	}
	claimOverhead := len(`{"value":""}`)
	largeClaim := json.RawMessage(
		`{"value":"` + strings.Repeat("x", localrpc.MaximumClaimResponseBodyBytes-claimOverhead) + `"}`,
	)
	client.claim = func(context.Context, workertransport.ClaimRequest) (workertransport.ClaimResponse, error) {
		return workertransport.ClaimResponse{Body: largeClaim}, nil
	}
	dispatcher := mustTestDispatcher(t, client, &fakeLocalAuthoritySigner{})
	t.Cleanup(func() { _ = dispatcher.Close() })

	noncanonical := json.RawMessage(` { "z" : 1.0, "a" : 2e0 } `)
	if response, err := dispatcher.Register(context.Background(), noncanonical); err != nil || string(response) != `{}` {
		t.Fatalf("noncanonical request returned (%q, %v)", response, err)
	}
	invalidInputs := []json.RawMessage{
		json.RawMessage(`{"z":`),
		json.RawMessage(`[]`),
		json.RawMessage(`{"value":1,"value":2}`),
		json.RawMessage(`{"value":"` + strings.Repeat("x", localrpc.MaximumWorkerAPIBodyBytes) + `"}`),
	}
	for _, body := range invalidInputs {
		_, err := dispatcher.Register(context.Background(), body)
		assertPublicError(t, err, internalErrorSpec)
	}
	if registerCalls.Load() != 1 {
		t.Fatal("an invalid request reached the Worker API client")
	}

	claimed, err := dispatcher.Claim(context.Background(), json.RawMessage(`{}`))
	if err != nil || !bytes.Equal(claimed, largeClaim) {
		t.Fatalf("large bounded Claim response returned (%d bytes, %v)", len(claimed), err)
	}

	client.claim = func(context.Context, workertransport.ClaimRequest) (workertransport.ClaimResponse, error) {
		return workertransport.ClaimResponse{
			Body: json.RawMessage(bytes.Repeat([]byte{'x'}, localrpc.MaximumClaimResponseBodyBytes+1)),
		}, nil
	}
	_, err = dispatcher.Claim(context.Background(), json.RawMessage(`{}`))
	assertPublicError(t, err, upstreamErrorSpec)

	client.register = func(context.Context, workertransport.RegisterRequest) (workertransport.RegisterResponse, error) {
		return workertransport.RegisterResponse{Body: json.RawMessage(`{"nested":{"value":1,"value":2}}`)}, nil
	}
	_, err = dispatcher.Register(context.Background(), json.RawMessage(`{}`))
	assertPublicError(t, err, upstreamErrorSpec)
}

func TestCompleteRunUsesTheDedicatedBodyBudgetAndValidatesTerminalResponse(t *testing.T) {
	bodyOverhead := len(`{"result":""}`)
	maximumBody := json.RawMessage(
		`{"result":"` + strings.Repeat("x", localrpc.MaximumRunCompletionRequestBodyBytes-bodyOverhead) + `"}`,
	)
	terminalBody := json.RawMessage(
		`{"runState":"succeeded","runAttemptId":"run:large","jobState":"succeeded","jobId":"job:large"}`,
	)
	var calls atomic.Int32
	client := &fakeWorkerClient{
		complete: func(
			_ context.Context,
			request workertransport.RunCompleteRequest,
		) (workertransport.RunCompleteResponse, error) {
			calls.Add(1)
			if len(request.Body) != localrpc.MaximumRunCompletionRequestBodyBytes {
				t.Fatalf("completion body has %d bytes", len(request.Body))
			}
			request.Body[0] = '['
			return workertransport.RunCompleteResponse{Body: terminalBody}, nil
		},
		fail: func(
			context.Context,
			workertransport.RunFailRequest,
		) (workertransport.RunFailResponse, error) {
			return workertransport.RunFailResponse{Body: json.RawMessage(`[]`)}, nil
		},
	}
	dispatcher := mustTestDispatcher(t, client, &fakeLocalAuthoritySigner{})
	t.Cleanup(func() { _ = dispatcher.Close() })

	response, err := dispatcher.CompleteRun(context.Background(), "run:large", maximumBody)
	if err != nil || !bytes.Equal(response, terminalBody) {
		t.Fatalf("maximum CompleteRun returned (%s, %v)", response, err)
	}
	if maximumBody[0] != '{' {
		t.Fatal("completion transport mutation escaped into the caller body")
	}
	terminalBody[0] = '['
	if response[0] != '{' {
		t.Fatal("completion response aliases transport storage")
	}

	tooLarge := append(bytes.Clone(maximumBody[:len(maximumBody)-2]), 'x', '"', '}')
	_, err = dispatcher.CompleteRun(context.Background(), "run:large", tooLarge)
	assertPublicError(t, err, internalErrorSpec)
	if calls.Load() != 1 {
		t.Fatal("oversized completion reached the Worker API client")
	}

	_, err = dispatcher.FailRun(context.Background(), "run:fail", json.RawMessage(`{}`))
	assertPublicError(t, err, upstreamErrorSpec)
}

func TestDispatcherHonorsContextBeforeTransportAndAfterSigning(t *testing.T) {
	var transportCalls atomic.Int32
	client := &fakeWorkerClient{
		register: func(context.Context, workertransport.RegisterRequest) (workertransport.RegisterResponse, error) {
			transportCalls.Add(1)
			return workertransport.RegisterResponse{}, nil
		},
	}
	var signCalls atomic.Int32
	signer := &fakeLocalAuthoritySigner{
		sign: func([]byte) ([]byte, error) {
			signCalls.Add(1)
			return validTestSignature(), nil
		},
	}
	dispatcher := mustTestDispatcher(t, client, signer)
	t.Cleanup(func() { _ = dispatcher.Close() })

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := dispatcher.Register(cancelled, json.RawMessage(`{}`))
	assertPublicError(t, err, requestCancelledSpec)
	_, err = dispatcher.SignLocalDigest(cancelled, [cng.DigestSize]byte{})
	assertPublicError(t, err, requestCancelledSpec)

	expired, expire := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer expire()
	_, err = dispatcher.Register(expired, json.RawMessage(`{}`))
	assertPublicError(t, err, requestTimeoutSpec)
	if transportCalls.Load() != 0 || signCalls.Load() != 0 {
		t.Fatal("a pre-cancelled operation reached a dependency")
	}

	started := make(chan struct{})
	release := make(chan struct{})
	signer.sign = func([]byte) ([]byte, error) {
		close(started)
		<-release
		return validTestSignature(), nil
	}
	postContext, postCancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, signErr := dispatcher.SignLocalDigest(postContext, [cng.DigestSize]byte{})
		result <- signErr
	}()
	<-started
	postCancel()
	close(release)
	assertPublicError(t, <-result, requestCancelledSpec)
}

func TestDispatcherPropagatesCancellationIntoWorkerTransport(t *testing.T) {
	started := make(chan struct{})
	client := &fakeWorkerClient{
		register: func(ctx context.Context, _ workertransport.RegisterRequest) (workertransport.RegisterResponse, error) {
			close(started)
			<-ctx.Done()
			return workertransport.RegisterResponse{}, ctx.Err()
		},
	}
	dispatcher := mustTestDispatcher(t, client, &fakeLocalAuthoritySigner{})
	t.Cleanup(func() { _ = dispatcher.Close() })

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := dispatcher.Register(ctx, json.RawMessage(`{}`))
		result <- err
	}()
	<-started
	cancel()
	assertPublicError(t, <-result, requestCancelledSpec)
}

func TestStatusErrorsUseOnlyTheOperationSpecificAllowlist(t *testing.T) {
	for key, expected := range statusMappings {
		key := key
		expected := expected
		t.Run(fmt.Sprintf("%s/%d/%s", key.operation, key.status, key.upstreamCode), func(t *testing.T) {
			body := canonicalStatusBody(t, key.upstreamCode, "upstream secret message", key.bodyRetryable)
			err := classifyWorkerError(context.Background(), key.operation, &workertransport.StatusError{
				StatusCode: key.status,
				Body:       body,
			})
			assertPublicError(t, err, expected)
			if strings.Contains(err.Error(), "upstream secret message") {
				t.Fatal("allowlisted status error exposed its upstream message")
			}
		})
	}

	leaseLost := canonicalStatusBody(t, "lease_lost", "secret lease path", false)
	unknownCases := []struct {
		name      string
		operation localrpc.Operation
		status    int
		body      json.RawMessage
		expected  publicErrorSpec
	}{
		{name: "wrong operation", operation: localrpc.OperationRegister, status: 409, body: leaseLost, expected: upstreamErrorSpec},
		{name: "wrong status", operation: localrpc.OperationCompleteRun, status: 400, body: leaseLost, expected: upstreamErrorSpec},
		{name: "wrong retryable", operation: localrpc.OperationCompleteRun, status: 409,
			body: canonicalStatusBody(t, "lease_lost", "secret", true), expected: upstreamErrorSpec},
		{name: "unknown code", operation: localrpc.OperationCompleteRun, status: 409,
			body: canonicalStatusBody(t, "unknown_secret", "secret", false), expected: upstreamErrorSpec},
		{name: "unknown status", operation: localrpc.OperationCompleteRun, status: 418,
			body: canonicalStatusBody(t, "lease_lost", "secret", false), expected: upstreamErrorSpec},
		{name: "noncanonical", operation: localrpc.OperationCompleteRun, status: 409,
			body: json.RawMessage(`{"message":"secret","code":"lease_lost","retryable":false}`), expected: upstreamErrorSpec},
		{name: "additional field", operation: localrpc.OperationCompleteRun, status: 409,
			body: json.RawMessage(`{"code":"lease_lost","message":"secret","retryable":false,"url":"secret"}`), expected: upstreamErrorSpec},
		{name: "nested error", operation: localrpc.OperationCompleteRun, status: 409,
			body: json.RawMessage(`{"error":{"code":"lease_lost","message":"secret","retryable":false}}`), expected: upstreamErrorSpec},
		{name: "control character", operation: localrpc.OperationCompleteRun, status: 409,
			body: canonicalStatusBody(t, "lease_lost", "secret\npath", false), expected: upstreamErrorSpec},
		{name: "oversized", operation: localrpc.OperationCompleteRun, status: 409,
			body: json.RawMessage(bytes.Repeat([]byte{'x'}, maximumStatusBodyBytes+1)), expected: upstreamErrorSpec},
		{name: "empty service unavailable", operation: localrpc.OperationRegister, status: 503,
			body: nil, expected: upstreamUnavailableSpec},
		{name: "malformed rate limit", operation: localrpc.OperationClaim, status: 429,
			body: json.RawMessage(`{"secret":true}`), expected: upstreamUnavailableSpec},
	}
	for _, test := range unknownCases {
		t.Run(test.name, func(t *testing.T) {
			err := classifyWorkerError(context.Background(), test.operation, &workertransport.StatusError{
				StatusCode: test.status,
				Body:       test.body,
			})
			assertPublicError(t, err, test.expected)
			if strings.Contains(err.Error(), "secret") {
				t.Fatal("unrecognized status error exposed upstream content")
			}
		})
	}
}

func TestDependencyErrorsAreClassifiedWithoutSensitiveText(t *testing.T) {
	secret := "https://worker.invalid/private/key?header=secret"
	networkError := &url.Error{
		Op:  "Post",
		URL: secret,
		Err: &net.DNSError{Err: "secret resolver response", Name: "worker.invalid"},
	}
	tests := []struct {
		name     string
		err      error
		expected publicErrorSpec
	}{
		{name: "invalid configuration", err: workertransport.ErrInvalidConfiguration, expected: internalErrorSpec},
		{name: "invalid entity", err: workertransport.ErrInvalidEntityID, expected: internalErrorSpec},
		{name: "invalid request", err: workertransport.ErrInvalidRequestJSON, expected: internalErrorSpec},
		{name: "request too large", err: workertransport.ErrRequestTooLarge, expected: internalErrorSpec},
		{name: "invalid response", err: workertransport.ErrInvalidResponseJSON, expected: upstreamErrorSpec},
		{name: "response too large", err: workertransport.ErrResponseTooLarge, expected: upstreamErrorSpec},
		{name: "media type", err: workertransport.ErrUnexpectedMediaType, expected: upstreamErrorSpec},
		{name: "content encoding", err: workertransport.ErrContentEncoded, expected: upstreamErrorSpec},
		{name: "redirect", err: workertransport.ErrRedirect, expected: upstreamErrorSpec},
		{name: "network", err: fmt.Errorf("request to %s: %w", secret, networkError), expected: upstreamUnavailableSpec},
		{name: "local CNG failure wrapped as URL error", err: &url.Error{
			Op: "Post", URL: secret, Err: fmt.Errorf("TLS signer: %w", cng.ErrClosed),
		}, expected: internalErrorSpec},
		{name: "local CNG status wrapped as URL error", err: &url.Error{
			Op: "Post", URL: secret, Err: &cng.StatusError{Operation: "NCryptSignHash", Code: 0x80090016},
		}, expected: internalErrorSpec},
		{name: "unknown", err: errors.New("unknown path and key " + secret), expected: internalErrorSpec},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := classifyWorkerError(context.Background(), localrpc.OperationRegister, test.err)
			assertPublicError(t, err, test.expected)
			if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "resolver") {
				t.Fatalf("classified error exposed sensitive dependency text: %v", err)
			}
		})
	}
}

func TestSignerErrorsAndInvalidSignaturesAreSanitized(t *testing.T) {
	secret := `C:\ProgramData\AgenticReview\Keys\local-authority`
	signer := &fakeLocalAuthoritySigner{
		sign: func([]byte) ([]byte, error) {
			return nil, fmt.Errorf("NCrypt key %s failed: %w", secret, &cng.StatusError{
				Operation: "NCryptSignHash", Code: 0x80090016,
			})
		},
	}
	dispatcher := mustTestDispatcher(t, &fakeWorkerClient{}, signer)
	t.Cleanup(func() { _ = dispatcher.Close() })

	_, err := dispatcher.SignLocalDigest(context.Background(), [cng.DigestSize]byte{})
	assertPublicError(t, err, internalErrorSpec)
	if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "NCrypt") {
		t.Fatal("signing error exposed key or native operation details")
	}

	signer.sign = func([]byte) ([]byte, error) { return make([]byte, cng.SignatureSize-1), nil }
	_, err = dispatcher.SignLocalDigest(context.Background(), [cng.DigestSize]byte{})
	assertPublicError(t, err, internalErrorSpec)

	highS := validTestSignature()
	for index := cng.DigestSize; index < len(highS); index++ {
		highS[index] = 0xff
	}
	signer.sign = func([]byte) ([]byte, error) { return highS, nil }
	_, err = dispatcher.SignLocalDigest(context.Background(), [cng.DigestSize]byte{})
	assertPublicError(t, err, internalErrorSpec)
}

func TestCloseCancelsCallsClosesOnlyTheOwnedSignerAndIsIdempotent(t *testing.T) {
	started := make(chan struct{})
	client := &fakeWorkerClient{
		register: func(ctx context.Context, _ workertransport.RegisterRequest) (workertransport.RegisterResponse, error) {
			close(started)
			<-ctx.Done()
			return workertransport.RegisterResponse{}, ctx.Err()
		},
	}
	signer := &fakeLocalAuthoritySigner{}
	dispatcher := mustTestDispatcher(t, client, signer)

	operationResult := make(chan error, 1)
	go func() {
		_, err := dispatcher.Register(context.Background(), json.RawMessage(`{}`))
		operationResult <- err
	}()
	<-started
	closeResult := make(chan error, 1)
	go func() { closeResult <- dispatcher.Close() }()

	assertPublicError(t, <-operationResult, internalErrorSpec)
	if err := <-closeResult; err != nil {
		t.Fatalf("Close returned an error: %v", err)
	}
	if signer.closeCalls.Load() != 1 {
		t.Fatalf("signer closed %d times", signer.closeCalls.Load())
	}
	if client.closeCalls.Load() != 0 {
		t.Fatalf("borrowed Worker API client closed %d times", client.closeCalls.Load())
	}
	if err := dispatcher.Close(); err != nil || signer.closeCalls.Load() != 1 {
		t.Fatalf("repeated Close returned %v or closed the signer again", err)
	}
	_, err := dispatcher.Register(context.Background(), json.RawMessage(`{}`))
	assertPublicError(t, err, internalErrorSpec)
}

func TestCloseSanitizesSignerCloseFailure(t *testing.T) {
	secret := `C:\secret\local-authority.key`
	var attempts atomic.Int32
	dispatcher := mustTestDispatcher(t, &fakeWorkerClient{}, &fakeLocalAuthoritySigner{
		close: func() error {
			if attempts.Add(1) == 1 {
				return errors.New("close " + secret)
			}
			return nil
		},
	})
	err := dispatcher.Close()
	assertPublicError(t, err, internalErrorSpec)
	if strings.Contains(err.Error(), secret) {
		t.Fatal("Close exposed signer details")
	}
	if err := dispatcher.Close(); err != nil {
		t.Fatalf("second Close did not retry signer cleanup: %v", err)
	}
	if err := dispatcher.Close(); err != nil || attempts.Load() != 2 {
		t.Fatalf("successful signer cleanup was not idempotent: attempts=%d error=%v", attempts.Load(), err)
	}
}

func TestConcurrentCloseCallsReleaseTheSignerOnce(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	signer := &fakeLocalAuthoritySigner{
		close: func() error {
			close(entered)
			<-release
			return nil
		},
	}
	dispatcher := mustTestDispatcher(t, &fakeWorkerClient{}, signer)

	const callers = 16
	results := make(chan error, callers)
	for range callers {
		go func() { results <- dispatcher.Close() }()
	}
	<-entered
	close(release)
	for range callers {
		if err := <-results; err != nil {
			t.Fatalf("concurrent Close returned an error: %v", err)
		}
	}
	if signer.closeCalls.Load() != 1 {
		t.Fatalf("concurrent Close released the signer %d times", signer.closeCalls.Load())
	}
}

func TestWorkerResponseExactCopyRejectsInvalidUnicode(t *testing.T) {
	invalid := []json.RawMessage{
		json.RawMessage{'{', '"', 'v', '"', ':', '"', 0xff, '"', '}'},
		json.RawMessage(`{"v":"\ud800"}`),
		json.RawMessage(`{"v":"\udc00"}`),
		json.RawMessage(`{"v":"\ud800\u0041"}`),
	}
	for _, body := range invalid {
		if _, err := copyWorkerAPIResponse(body, localrpc.MaximumWorkerAPIBodyBytes); err == nil {
			t.Errorf("exact-copy validator accepted invalid Unicode %q", body)
		} else {
			assertPublicError(t, err, upstreamErrorSpec)
		}
	}

	valid := []json.RawMessage{
		json.RawMessage(`{"v":"\ud83d\ude00"}`),
		json.RawMessage("{\"v\":\"\xef\xbf\xbd\"}"),
		json.RawMessage(`{"v":"\ufffd"}`),
		json.RawMessage(` { "confidence" : 0.8 } `),
	}
	for _, body := range valid {
		copy, err := copyWorkerAPIResponse(body, localrpc.MaximumWorkerAPIBodyBytes)
		if err != nil || !bytes.Equal(copy, body) {
			t.Errorf("exact-copy validator returned (%q, %v) for %q", copy, err, body)
		}
	}
}

func TestDispatcherPanicsAreRecoveredByLocalRPCServer(t *testing.T) {
	client := &fakeWorkerClient{
		register: func(context.Context, workertransport.RegisterRequest) (workertransport.RegisterResponse, error) {
			panic("sensitive dependency panic")
		},
	}
	dispatcher := mustTestDispatcher(t, client, &fakeLocalAuthoritySigner{})
	t.Cleanup(func() { _ = dispatcher.Close() })
	serverConnection, clientConnection := net.Pipe()
	t.Cleanup(func() {
		_ = serverConnection.Close()
		_ = clientConnection.Close()
	})
	channel := &dispatcherRuntimeBootstrapChannel{Conn: serverConnection}
	committed := committedRuntimeBootstrapForDispatcherTest(t, channel, clientConnection)
	server, err := localrpc.NewServer(localrpc.ServerOptions{
		Role:                      localrpc.RoleControl,
		RuntimeBootstrap:          committed,
		MaximumConcurrentRequests: 1,
		MaximumRequestsPerSession: 4,
		RequestTimeout:            time.Second,
		ClaimTimeout:              time.Second,
		IOTimeout:                 time.Second,
		ShutdownTimeout:           time.Second,
	}, dispatcher)
	if err != nil {
		t.Fatalf("NewServer returned an error: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	serveResult := make(chan error, 1)
	go func() { serveResult <- server.Serve(ctx, channel, channel) }()

	request, err := localrpc.MarshalCanonicalJSON(map[string]any{
		"operation": localrpc.OperationRegister,
		"payload": map[string]any{"body": map[string]any{
			"base64Url": "e30", "byteLength": 2,
			"sha256": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
		}},
		"protocolVersion": localrpc.ProtocolVersion,
		"requestId":       "panic:1",
		"type":            "call",
	}, localrpc.MaximumFrameBytes)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	if err := localrpc.WriteFrame(clientConnection, request, localrpc.MaximumFrameBytes); err != nil {
		t.Fatalf("write request: %v", err)
	}

	responseResult := make(chan []byte, 1)
	responseError := make(chan error, 1)
	go func() {
		response, readErr := localrpc.ReadFrame(clientConnection, localrpc.MaximumCanonicalControlFrameBytes)
		if readErr != nil {
			responseError <- readErr
			return
		}
		responseResult <- response
	}()
	var response []byte
	select {
	case response = <-responseResult:
	case readErr := <-responseError:
		t.Fatalf("read response: %v", readErr)
	case <-time.After(2 * time.Second):
		t.Fatal("server did not recover the dispatcher panic")
	}
	value, err := localrpc.ParseCanonicalJSON(response, localrpc.MaximumCanonicalControlFrameBytes)
	if err != nil {
		t.Fatalf("parse response: %v", err)
	}
	responseObject := value.(map[string]any)
	errorObject := responseObject["error"].(map[string]any)
	if errorObject["code"] != "INTERNAL_ERROR" || errorObject["message"] != "The ServiceHost operation failed." {
		t.Fatalf("unexpected panic response: %#v", errorObject)
	}
	if strings.Contains(string(response), "sensitive") {
		t.Fatal("panic response exposed dependency text")
	}

	cancel()
	_ = clientConnection.Close()
	select {
	case <-serveResult:
	case <-time.After(2 * time.Second):
		t.Fatal("server did not stop after cancellation")
	}
}

type dispatcherRuntimeBootstrapChannel struct {
	net.Conn
}

func (channel *dispatcherRuntimeBootstrapChannel) ReadContext(
	ctx context.Context,
	buffer []byte,
) (int, error) {
	if cause := context.Cause(ctx); cause != nil {
		return 0, cause
	}
	return channel.Read(buffer)
}

func (channel *dispatcherRuntimeBootstrapChannel) WriteContext(
	ctx context.Context,
	buffer []byte,
) (int, error) {
	if cause := context.Cause(ctx); cause != nil {
		return 0, cause
	}
	return channel.Write(buffer)
}

func committedRuntimeBootstrapForDispatcherTest(
	t *testing.T,
	channel *dispatcherRuntimeBootstrapChannel,
	peer net.Conn,
) localrpc.CommittedRuntimeBootstrap {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	if err := channel.SetDeadline(deadline); err != nil {
		t.Fatal(err)
	}
	if err := peer.SetDeadline(deadline); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = channel.SetDeadline(time.Time{})
		_ = peer.SetDeadline(time.Time{})
	}()
	bootstrapOptions := localrpc.FoundationRuntimeBootstrapOptions{
		Role:                           localrpc.RoleControl,
		WorkerNodeID:                   "powertoys-node:01",
		ReleaseID:                      "2026.08.31-test+1",
		ReleaseTemplateSHA256:          strings.Repeat("1", 64),
		InstallationManifestSHA256:     strings.Repeat("2", 64),
		PreflightSHA256:                strings.Repeat("3", 64),
		NodeBundleSHA256:               strings.Repeat("4", 64),
		LocalAuthorityKeyID:            strings.Repeat("5", 64),
		ExecutorPolicySHA256:           strings.Repeat("6", 64),
		MaximumQueuedBytesPerDirection: 4 * 1024 * 1024,
		TotalShutdownTimeoutMS:         120_000,
		ForceTerminationReserveMS:      15_000,
	}
	bootstrap, err := localrpc.NewFoundationRuntimeBootstrap(bootstrapOptions)
	if err != nil {
		t.Fatal(err)
	}
	boundBootstrap, err := localrpc.BindRuntimeBootstrapToLaunch(bootstrap, bootstrapOptions)
	if err != nil {
		t.Fatal(err)
	}
	peerResult := make(chan error, 1)
	go func() {
		bootstrapDocument, readErr := localrpc.ReadFrame(peer, localrpc.RuntimeBootstrapMaximumBytes)
		if readErr != nil {
			peerResult <- readErr
			return
		}
		ack, encodeErr := localrpc.EncodeRuntimeBootstrapAck(bootstrapDocument, localrpc.RoleControl)
		if encodeErr != nil {
			peerResult <- encodeErr
			return
		}
		if writeErr := localrpc.WriteFrame(peer, ack, localrpc.RuntimeBootstrapMaximumBytes); writeErr != nil {
			peerResult <- writeErr
			return
		}
		commit, readErr := localrpc.ReadFrame(peer, localrpc.RuntimeBootstrapMaximumBytes)
		if readErr != nil {
			peerResult <- readErr
			return
		}
		peerResult <- localrpc.ValidateRuntimeBootstrapCommit(commit, bootstrapDocument, localrpc.RoleControl)
	}()
	pending, err := localrpc.BeginRuntimeBootstrapExchange(context.Background(), channel, boundBootstrap)
	if err != nil {
		t.Fatal(err)
	}
	committed, err := pending.Commit(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-peerResult:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("runtime bootstrap peer did not receive commit")
	}
	return committed
}

func TestDependencyValidationRejectsNilInterfaces(t *testing.T) {
	if _, err := New(nil, nil); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("New returned %v", err)
	}
	var client *fakeWorkerClient
	var signer *fakeLocalAuthoritySigner
	if _, err := newDispatcher(client, &fakeLocalAuthoritySigner{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("newDispatcher accepted a typed nil client: %v", err)
	}
	if _, err := newDispatcher(&fakeWorkerClient{}, signer); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("newDispatcher accepted a typed nil signer: %v", err)
	}
}

func TestProductionValidationRejectsAClosedLocalAuthoritySigner(t *testing.T) {
	client := &fakeWorkerClient{}
	signer := &fakeLocalAuthoritySigner{
		identity: cng.KeyIdentity{
			ProviderName: "Microsoft Software Key Storage Provider",
			UniqueName:   "local-authority-test-key",
			MachineKey:   true,
		},
		open: false,
	}
	if _, err := newProductionDispatcher(client, signer); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("closed production signer was accepted: %v", err)
	}
	if signer.closeCalls.Load() != 0 {
		t.Fatal("rejected signer ownership was transferred")
	}

	signer.open = true
	dispatcher, err := newProductionDispatcher(client, signer)
	if err != nil {
		t.Fatalf("open production signer was rejected: %v", err)
	}
	if err := dispatcher.Close(); err != nil {
		t.Fatalf("Close returned an error: %v", err)
	}
	if signer.closeCalls.Load() != 1 {
		t.Fatal("accepted signer ownership was not transferred")
	}
}

func canonicalStatusBody(t *testing.T, code, message string, retryable bool) json.RawMessage {
	t.Helper()
	body, err := localrpc.MarshalCanonicalJSON(map[string]any{
		"code": code, "message": message, "retryable": retryable,
	}, maximumStatusBodyBytes)
	if err != nil {
		t.Fatalf("marshal status body: %v", err)
	}
	return json.RawMessage(body)
}

func assertDetachedRequest(t *testing.T, actual, original json.RawMessage) {
	t.Helper()
	if !bytes.Equal(actual, original) {
		t.Fatalf("forwarded body %s, want %s", actual, original)
	}
	if len(actual) > 0 {
		actual[0] = '['
	}
}

func assertPublicError(t *testing.T, err error, expected publicErrorSpec) {
	t.Helper()
	var publicError *localrpc.PublicError
	if !errors.As(err, &publicError) || publicError == nil {
		t.Fatalf("error %v is not a localrpc.PublicError", err)
	}
	if publicError.Code != expected.code || publicError.Message != expected.message ||
		publicError.Retryable != expected.retryable {
		t.Fatalf("public error = %#v, want %#v", publicError, expected)
	}
}

func mustTestDispatcher(t *testing.T, client workerClient, signer localAuthoritySigner) *Dispatcher {
	t.Helper()
	dispatcher, err := newDispatcher(client, signer)
	if err != nil {
		t.Fatalf("newDispatcher returned an error: %v", err)
	}
	return dispatcher
}

func validTestSignature() []byte {
	signature := make([]byte, cng.SignatureSize)
	signature[cng.DigestSize-1] = 1
	signature[cng.SignatureSize-1] = 1
	return signature
}

type fakeWorkerClient struct {
	register   func(context.Context, workertransport.RegisterRequest) (workertransport.RegisterResponse, error)
	claim      func(context.Context, workertransport.ClaimRequest) (workertransport.ClaimResponse, error)
	heartbeat  func(context.Context, workertransport.InstanceHeartbeatRequest) (workertransport.InstanceHeartbeatResponse, error)
	complete   func(context.Context, workertransport.RunCompleteRequest) (workertransport.RunCompleteResponse, error)
	fail       func(context.Context, workertransport.RunFailRequest) (workertransport.RunFailResponse, error)
	closeCalls atomic.Int32
}

func (client *fakeWorkerClient) Register(
	ctx context.Context,
	request workertransport.RegisterRequest,
) (workertransport.RegisterResponse, error) {
	if client.register == nil {
		panic("unexpected Register call")
	}
	return client.register(ctx, request)
}

func (client *fakeWorkerClient) Claim(
	ctx context.Context,
	request workertransport.ClaimRequest,
) (workertransport.ClaimResponse, error) {
	if client.claim == nil {
		panic("unexpected Claim call")
	}
	return client.claim(ctx, request)
}

func (client *fakeWorkerClient) HeartbeatInstance(
	ctx context.Context,
	request workertransport.InstanceHeartbeatRequest,
) (workertransport.InstanceHeartbeatResponse, error) {
	if client.heartbeat == nil {
		panic("unexpected HeartbeatInstance call")
	}
	return client.heartbeat(ctx, request)
}

func (client *fakeWorkerClient) CompleteRun(
	ctx context.Context,
	request workertransport.RunCompleteRequest,
) (workertransport.RunCompleteResponse, error) {
	if client.complete == nil {
		panic("unexpected CompleteRun call")
	}
	return client.complete(ctx, request)
}

func (client *fakeWorkerClient) FailRun(
	ctx context.Context,
	request workertransport.RunFailRequest,
) (workertransport.RunFailResponse, error) {
	if client.fail == nil {
		panic("unexpected FailRun call")
	}
	return client.fail(ctx, request)
}

func (client *fakeWorkerClient) Close() error {
	client.closeCalls.Add(1)
	return nil
}

type fakeLocalAuthoritySigner struct {
	sign       func([]byte) ([]byte, error)
	close      func() error
	closeCalls atomic.Int32
	identity   cng.KeyIdentity
	open       bool
}

func (signer *fakeLocalAuthoritySigner) Identity() cng.KeyIdentity { return signer.identity }

func (signer *fakeLocalAuthoritySigner) IsOpen() bool { return signer.open }

func (signer *fakeLocalAuthoritySigner) SignDigest(digest []byte) ([]byte, error) {
	if signer.sign == nil {
		panic("unexpected SignDigest call")
	}
	return signer.sign(digest)
}

func (signer *fakeLocalAuthoritySigner) Close() error {
	signer.closeCalls.Add(1)
	if signer.close == nil {
		return nil
	}
	return signer.close()
}
