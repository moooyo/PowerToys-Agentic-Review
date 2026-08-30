package workertransport

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestNewClientPinsTLSOriginAndTransportPolicy(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://attacker.invalid:8080")
	config, signer := validConfig(t)
	originalLeafByte := config.ClientCertificate.Certificate[0][0]
	originalRootByte := config.RootCertificateDER[0][0]
	client, err := NewClient(config)
	if err != nil {
		t.Fatalf("NewClient returned an error: %v", err)
	}

	transport, ok := client.httpClient.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("NewClient installed transport type %T", client.httpClient.Transport)
	}
	if transport.Proxy != nil {
		t.Fatal("transport enabled proxy discovery")
	}
	if !transport.DisableCompression {
		t.Fatal("transport enabled automatic response compression")
	}
	if transport.MaxConnsPerHost != config.Limits.MaximumConcurrentRequests ||
		transport.MaxIdleConnsPerHost != config.Limits.MaximumConcurrentRequests {
		t.Fatal("transport connection limits do not match the concurrency bound")
	}
	if transport.MaxResponseHeaderBytes != maximumResponseHeaders {
		t.Fatalf("unexpected response header limit: %d", transport.MaxResponseHeaderBytes)
	}
	if transport.TLSClientConfig == nil {
		t.Fatal("transport has no TLS configuration")
	}
	tlsConfig := transport.TLSClientConfig
	if tlsConfig.MinVersion != tls.VersionTLS13 || tlsConfig.InsecureSkipVerify {
		t.Fatal("transport does not require verified TLS 1.3 or newer")
	}
	if tlsConfig.ServerName != config.ServerName {
		t.Fatalf("unexpected ServerName: %q", tlsConfig.ServerName)
	}
	if tlsConfig.RootCAs == nil || len(tlsConfig.RootCAs.Subjects()) != 1 {
		t.Fatal("transport did not build one private pinned root pool")
	}
	rootSubjects := tlsConfig.RootCAs.Subjects()
	if len(tlsConfig.Certificates) != 1 || tlsConfig.Certificates[0].PrivateKey != signer {
		t.Fatal("transport did not bind the supplied crypto.Signer to one client certificate")
	}
	if tlsConfig.Certificates[0].Leaf == nil {
		t.Fatal("transport did not parse the client certificate leaf")
	}

	config.ClientCertificate.Certificate[0][0] ^= 0xff
	config.RootCertificateDER[0][0] ^= 0xff
	if tlsConfig.Certificates[0].Certificate[0][0] != originalLeafByte {
		t.Fatal("transport retained mutable client certificate DER")
	}
	if config.RootCertificateDER[0][0] == originalRootByte {
		t.Fatal("test did not mutate the caller root DER")
	}
	if !reflect.DeepEqual(tlsConfig.RootCAs.Subjects(), rootSubjects) {
		t.Fatal("transport root pool changed after caller DER mutation")
	}
	if client.origin.String() != "https://api.worker.test:8443" {
		t.Fatalf("client stored the wrong origin: %s", client.origin.String())
	}
	if err := client.httpClient.CheckRedirect(&http.Request{}, nil); !errors.Is(err, http.ErrUseLastResponse) {
		t.Fatalf("redirect callback returned %v", err)
	}
}

func TestNewClientRejectsUnsafeConfiguration(t *testing.T) {
	base, _ := validConfig(t)
	_, otherSigner := testCertificate(t, "other.worker.test")
	var nilSigner *ecdsa.PrivateKey
	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{name: "HTTP origin", mutate: func(value *Config) { value.Origin = "http://api.worker.test" }},
		{name: "origin credentials", mutate: func(value *Config) { value.Origin = "https://user@api.worker.test" }},
		{name: "origin path", mutate: func(value *Config) { value.Origin = "https://api.worker.test/base" }},
		{name: "origin query", mutate: func(value *Config) { value.Origin = "https://api.worker.test?next=elsewhere" }},
		{name: "origin fragment", mutate: func(value *Config) { value.Origin = "https://api.worker.test/#fragment" }},
		{name: "empty origin fragment", mutate: func(value *Config) { value.Origin = "https://api.worker.test/#" }},
		{name: "empty origin port", mutate: func(value *Config) { value.Origin = "https://api.worker.test:" }},
		{name: "noncanonical port", mutate: func(value *Config) { value.Origin = "https://api.worker.test:0443" }},
		{name: "empty ServerName", mutate: func(value *Config) { value.ServerName = "" }},
		{name: "ServerName with port", mutate: func(value *Config) { value.ServerName = "api.worker.test:443" }},
		{name: "missing roots", mutate: func(value *Config) { value.RootCertificateDER = nil }},
		{name: "empty root", mutate: func(value *Config) { value.RootCertificateDER = [][]byte{{}} }},
		{name: "invalid root", mutate: func(value *Config) { value.RootCertificateDER = [][]byte{{1, 2, 3}} }},
		{name: "missing certificate", mutate: func(value *Config) { value.ClientCertificate = tls.Certificate{} }},
		{name: "missing signer", mutate: func(value *Config) { value.ClientSigner = nil }},
		{name: "typed nil signer", mutate: func(value *Config) { value.ClientSigner = nilSigner }},
		{name: "mismatched signer", mutate: func(value *Config) { value.ClientSigner = otherSigner }},
		{name: "zero request bytes", mutate: func(value *Config) { value.Limits.MaximumRequestBytes = 0 }},
		{name: "excess response bytes", mutate: func(value *Config) { value.Limits.MaximumResponseBytes = maximumConfiguredBytes + 1 }},
		{name: "zero request timeout", mutate: func(value *Config) { value.Limits.RequestTimeout = 0 }},
		{name: "excess claim timeout", mutate: func(value *Config) { value.Limits.ClaimTimeout = maximumConfiguredTimeout + 1 }},
		{name: "zero concurrency", mutate: func(value *Config) { value.Limits.MaximumConcurrentRequests = 0 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			config := base
			test.mutate(&config)
			if _, err := NewClient(config); !errors.Is(err, ErrInvalidConfiguration) {
				t.Fatalf("expected invalid configuration, got %v", err)
			}
		})
	}
}

func TestTransportHeaderTimeoutCoversEveryOperationDeadline(t *testing.T) {
	config, _ := validConfig(t)
	config.Limits.RequestTimeout = 2 * time.Minute
	config.Limits.ClaimTimeout = 30 * time.Second
	client, err := NewClient(config)
	if err != nil {
		t.Fatalf("NewClient returned an error: %v", err)
	}
	transport := client.httpClient.Transport.(*http.Transport)
	if transport.ResponseHeaderTimeout != config.Limits.RequestTimeout {
		t.Fatalf("response header timeout = %v, want %v", transport.ResponseHeaderTimeout, config.Limits.RequestTimeout)
	}
}

func TestInvalidOriginErrorDoesNotEchoRawSecret(t *testing.T) {
	secret := "do-not-log-this-token"
	config, _ := validConfig(t)
	config.Origin = "https://user:" + secret + "@api.worker.test/%zz?token=" + secret
	_, err := NewClient(config)
	if !errors.Is(err, ErrInvalidConfiguration) {
		t.Fatalf("expected invalid configuration, got %v", err)
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("origin parse error disclosed the raw secret: %v", err)
	}
}

func TestClientExportsOnlyTypedWorkerOperations(t *testing.T) {
	typeOfClient := reflect.TypeOf((*Client)(nil))
	expected := map[string]bool{
		"Claim":             true,
		"CompleteRun":       true,
		"FailRun":           true,
		"HeartbeatInstance": true,
		"Register":          true,
	}
	if typeOfClient.NumMethod() != len(expected) {
		t.Fatalf("Client exposes %d methods, expected %d", typeOfClient.NumMethod(), len(expected))
	}
	for index := 0; index < typeOfClient.NumMethod(); index++ {
		method := typeOfClient.Method(index)
		if !expected[method.Name] {
			t.Errorf("Client exposes unexpected method %s", method.Name)
		}
	}
}

func TestTypedOperationsUseOnlyFixedOriginRoutesAndHeaders(t *testing.T) {
	type observation struct {
		method        string
		url           string
		host          string
		headers       http.Header
		contentLength int64
		body          string
		hasDeadline   bool
	}
	var observations []observation
	roundTripper := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			return nil, err
		}
		_, hasDeadline := request.Context().Deadline()
		observations = append(observations, observation{
			method:        request.Method,
			url:           request.URL.String(),
			host:          request.Host,
			headers:       request.Header.Clone(),
			contentLength: request.ContentLength,
			body:          string(body),
			hasDeadline:   hasDeadline,
		})
		return jsonHTTPResponse(http.StatusOK, `{"accepted":true}`), nil
	})
	client := testClient(t, roundTripper, testLimits())
	requestBody := json.RawMessage(`{"request":true}`)

	if response, err := client.Register(context.Background(), RegisterRequest{Body: requestBody}); err != nil || string(response.Body) != `{"accepted":true}` {
		t.Fatalf("Register returned (%s, %v)", response.Body, err)
	}
	if response, err := client.Claim(context.Background(), ClaimRequest{Body: requestBody}); err != nil || string(response.Body) != `{"accepted":true}` {
		t.Fatalf("Claim returned (%s, %v)", response.Body, err)
	}
	if response, err := client.HeartbeatInstance(context.Background(), InstanceHeartbeatRequest{
		WorkerInstanceID: "worker:instance_1.test-2",
		Body:             requestBody,
	}); err != nil || string(response.Body) != `{"accepted":true}` {
		t.Fatalf("HeartbeatInstance returned (%s, %v)", response.Body, err)
	}
	if err := client.CompleteRun(context.Background(), RunCompleteRequest{
		RunAttemptID: "run:attempt_1.test-2",
		Body:         requestBody,
	}); err != nil {
		t.Fatalf("CompleteRun returned an error: %v", err)
	}
	if err := client.FailRun(context.Background(), RunFailRequest{
		RunAttemptID: "run:attempt_1.test-2",
		Body:         requestBody,
	}); err != nil {
		t.Fatalf("FailRun returned an error: %v", err)
	}

	expected := []struct {
		method string
		url    string
	}{
		{method: http.MethodPost, url: "https://api.worker.test:8443/api/v1/worker/instances"},
		{method: http.MethodPost, url: "https://api.worker.test:8443/api/v1/worker/leases/claim"},
		{method: http.MethodPut, url: "https://api.worker.test:8443/api/v1/worker/instances/worker:instance_1.test-2/heartbeat"},
		{method: http.MethodPost, url: "https://api.worker.test:8443/api/v1/worker/runs/run:attempt_1.test-2/complete"},
		{method: http.MethodPost, url: "https://api.worker.test:8443/api/v1/worker/runs/run:attempt_1.test-2/fail"},
	}
	if len(observations) != len(expected) {
		t.Fatalf("observed %d requests, expected %d", len(observations), len(expected))
	}
	for index, want := range expected {
		got := observations[index]
		if got.method != want.method || got.url != want.url {
			t.Errorf("request %d was %s %s, expected %s %s", index, got.method, got.url, want.method, want.url)
		}
		if got.host != "api.worker.test:8443" {
			t.Errorf("request %d used Host %q outside the fixed origin", index, got.host)
		}
		if !got.hasDeadline {
			t.Errorf("request %d had no absolute deadline", index)
		}
		if got.contentLength != int64(len(requestBody)) || got.body != string(requestBody) {
			t.Errorf("request %d changed the request body", index)
		}
		expectedHeaders := http.Header{
			"Accept":       {"application/json"},
			"Content-Type": {"application/json"},
			"User-Agent":   {workerUserAgent},
		}
		if !headersEqual(got.headers, expectedHeaders) {
			t.Errorf("request %d sent unexpected headers: %#v", index, got.headers)
		}
		for _, name := range []string{
			"Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization",
			"TE", "Trailer", "Transfer-Encoding", "Upgrade",
		} {
			if got.headers.Get(name) != "" {
				t.Errorf("request %d sent hop-by-hop header %s", index, name)
			}
		}
	}
}

func TestEntityIdentifiersAreValidatedBeforeSingleSegmentEscaping(t *testing.T) {
	var calls atomic.Int32
	client := testClient(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return jsonHTTPResponse(http.StatusOK, `{}`), nil
	}), testLimits())
	invalid := []string{
		"", ".starts-with-dot", "_starts-with-underscore", "-starts-with-dash",
		"contains/slash", `contains\\backslash`, "percent%2fescape", "query?part",
		"white space", "caf\xc3\xa9", strings.Repeat("a", 129),
	}
	for _, value := range invalid {
		_, heartbeatError := client.HeartbeatInstance(context.Background(), InstanceHeartbeatRequest{
			WorkerInstanceID: value,
			Body:             json.RawMessage(`{}`),
		})
		if !errors.Is(heartbeatError, ErrInvalidEntityID) {
			t.Errorf("HeartbeatInstance accepted %q: %v", value, heartbeatError)
		}
		completeError := client.CompleteRun(context.Background(), RunCompleteRequest{
			RunAttemptID: value,
			Body:         json.RawMessage(`{}`),
		})
		if !errors.Is(completeError, ErrInvalidEntityID) {
			t.Errorf("CompleteRun accepted %q: %v", value, completeError)
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("invalid identifiers reached the HTTP transport %d times", calls.Load())
	}

	target, err := client.entityTarget(runPathStart, "A0._:-z", completePathEnd)
	if err != nil {
		t.Fatalf("valid EntityId was rejected: %v", err)
	}
	if target.EscapedPath() != "/api/v1/worker/runs/A0._:-z/complete" {
		t.Fatalf("unexpected escaped path: %q", target.EscapedPath())
	}
}

func TestRedirectIsRejectedBeforeASecondRequest(t *testing.T) {
	var calls atomic.Int32
	client := testClient(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return &http.Response{
			StatusCode: http.StatusTemporaryRedirect,
			Header: http.Header{
				"Content-Type": {"application/json"},
				"Location":     {"https://attacker.invalid/collect"},
			},
			Body: io.NopCloser(strings.NewReader(`{"redirect":true}`)),
		}, nil
	}), testLimits())

	_, err := client.Register(context.Background(), RegisterRequest{Body: json.RawMessage(`{}`)})
	if !errors.Is(err, ErrRedirect) {
		t.Fatalf("expected redirect rejection, got %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("redirect caused %d transport calls", calls.Load())
	}
}

func TestRedirectBodyStillUsesTheConfiguredInboundLimit(t *testing.T) {
	limits := testLimits()
	limits.MaximumResponseBytes = 8
	body := &countingBody{reader: bytes.NewReader([]byte(`{"redirect":true}`))}
	client := testClient(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode:    http.StatusTemporaryRedirect,
			Header:        http.Header{"Content-Type": {"application/json"}, "Location": {"https://attacker.invalid"}},
			Body:          body,
			ContentLength: -1,
		}, nil
	}), limits)

	_, err := client.Register(context.Background(), RegisterRequest{Body: json.RawMessage(`{}`)})
	if !errors.Is(err, ErrResponseTooLarge) {
		t.Fatalf("expected response limit error, got %v", err)
	}
	if body.bytesRead.Load() != 9 || !body.closed.Load() {
		t.Fatalf("redirect body read=%d closed=%t", body.bytesRead.Load(), body.closed.Load())
	}
}

func TestRequestAndResponseByteLimits(t *testing.T) {
	t.Run("request", func(t *testing.T) {
		limits := testLimits()
		limits.MaximumRequestBytes = 8
		var calls atomic.Int32
		client := testClient(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
			calls.Add(1)
			return jsonHTTPResponse(http.StatusOK, `{}`), nil
		}), limits)
		_, err := client.Register(context.Background(), RegisterRequest{
			Body: json.RawMessage(`{"value":1}`),
		})
		if !errors.Is(err, ErrRequestTooLarge) {
			t.Fatalf("expected request limit error, got %v", err)
		}
		if calls.Load() != 0 {
			t.Fatal("oversized request reached the HTTP transport")
		}
	})

	t.Run("declared response length", func(t *testing.T) {
		limits := testLimits()
		limits.MaximumResponseBytes = 8
		body := &countingBody{reader: bytes.NewReader([]byte(`{"too":"large"}`))}
		client := testClient(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
			response := jsonHTTPResponse(http.StatusOK, "")
			response.Body = body
			response.ContentLength = 9
			return response, nil
		}), limits)
		_, err := client.Register(context.Background(), RegisterRequest{Body: json.RawMessage(`{}`)})
		if !errors.Is(err, ErrResponseTooLarge) {
			t.Fatalf("expected response limit error, got %v", err)
		}
		if body.bytesRead.Load() != 0 || !body.closed.Load() {
			t.Fatalf("declared oversized body read=%d closed=%t", body.bytesRead.Load(), body.closed.Load())
		}
	})

	t.Run("streamed response", func(t *testing.T) {
		limits := testLimits()
		limits.MaximumResponseBytes = 8
		body := &countingBody{reader: bytes.NewReader(bytes.Repeat([]byte{'x'}, 1024))}
		client := testClient(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
			response := jsonHTTPResponse(http.StatusOK, "")
			response.Body = body
			response.ContentLength = -1
			return response, nil
		}), limits)
		_, err := client.Register(context.Background(), RegisterRequest{Body: json.RawMessage(`{}`)})
		if !errors.Is(err, ErrResponseTooLarge) {
			t.Fatalf("expected response limit error, got %v", err)
		}
		if body.bytesRead.Load() != 9 || !body.closed.Load() {
			t.Fatalf("streamed oversized body read=%d closed=%t", body.bytesRead.Load(), body.closed.Load())
		}
	})
}

func TestResponseMetadataAndStatusAreStrict(t *testing.T) {
	tests := []struct {
		name        string
		status      int
		contentType []string
		encoding    []string
		body        string
		target      error
	}{
		{name: "missing media type", status: http.StatusOK, body: `{}`, target: ErrUnexpectedMediaType},
		{name: "wrong media type", status: http.StatusOK, contentType: []string{"text/plain"}, body: `{}`, target: ErrUnexpectedMediaType},
		{name: "unsupported charset", status: http.StatusOK, contentType: []string{"application/json; charset=iso-8859-1"}, body: `{}`, target: ErrUnexpectedMediaType},
		{name: "multiple media types", status: http.StatusOK, contentType: []string{"application/json", "application/json"}, body: `{}`, target: ErrUnexpectedMediaType},
		{name: "content encoding", status: http.StatusOK, contentType: []string{"application/json"}, encoding: []string{"gzip"}, body: `{}`, target: ErrContentEncoded},
		{name: "created status", status: http.StatusCreated, contentType: []string{"application/json"}, body: `{"error":"wrong status"}`, target: ErrUnexpectedStatus},
		{name: "empty error body", status: http.StatusInternalServerError, contentType: []string{"application/json"}, body: "", target: ErrUnexpectedStatus},
		{name: "invalid error JSON", status: http.StatusInternalServerError, contentType: []string{"application/json"}, body: `{`, target: ErrInvalidResponseJSON},
		{name: "invalid JSON", status: http.StatusOK, contentType: []string{"application/json"}, body: `{`, target: ErrInvalidResponseJSON},
		{name: "valid charset", status: http.StatusOK, contentType: []string{"application/json; charset=UTF-8"}, body: `{}`, target: nil},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := testClient(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
				response := jsonHTTPResponse(test.status, test.body)
				response.Header.Del("Content-Type")
				for _, value := range test.contentType {
					response.Header.Add("Content-Type", value)
				}
				for _, value := range test.encoding {
					response.Header.Add("Content-Encoding", value)
				}
				return response, nil
			}), testLimits())
			_, err := client.Register(context.Background(), RegisterRequest{Body: json.RawMessage(`{}`)})
			if !errors.Is(err, test.target) {
				t.Fatalf("expected %v, got %v", test.target, err)
			}
			if errors.Is(test.target, ErrUnexpectedStatus) {
				var statusError *StatusError
				if !errors.As(err, &statusError) || statusError.StatusCode != test.status ||
					string(statusError.Body) != test.body {
					t.Fatalf("unexpected status error: %#v", statusError)
				}
			}
		})
	}
}

func TestInvalidRequestJSONDoesNotReachTransport(t *testing.T) {
	var calls atomic.Int32
	client := testClient(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return jsonHTTPResponse(http.StatusOK, `{}`), nil
	}), testLimits())
	for _, body := range []json.RawMessage{nil, json.RawMessage(`{`)} {
		if _, err := client.Register(context.Background(), RegisterRequest{Body: body}); !errors.Is(err, ErrInvalidRequestJSON) {
			t.Fatalf("expected invalid request JSON error, got %v", err)
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("invalid JSON reached the HTTP transport %d times", calls.Load())
	}
}

func TestCancellationAndAbsoluteDeadlineReachTransport(t *testing.T) {
	t.Run("caller cancellation", func(t *testing.T) {
		started := make(chan struct{})
		client := testClient(t, roundTripFunc(func(request *http.Request) (*http.Response, error) {
			close(started)
			<-request.Context().Done()
			return nil, request.Context().Err()
		}), testLimits())
		ctx, cancel := context.WithCancel(context.Background())
		result := make(chan error, 1)
		go func() {
			_, err := client.Register(ctx, RegisterRequest{Body: json.RawMessage(`{}`)})
			result <- err
		}()
		<-started
		cancel()
		select {
		case err := <-result:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("expected cancellation, got %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("cancelled request did not return")
		}
	})

	t.Run("absolute deadline", func(t *testing.T) {
		limits := testLimits()
		limits.RequestTimeout = 50 * time.Millisecond
		client := testClient(t, roundTripFunc(func(request *http.Request) (*http.Response, error) {
			<-request.Context().Done()
			return nil, request.Context().Err()
		}), limits)
		result := make(chan error, 1)
		go func() {
			_, err := client.Register(context.Background(), RegisterRequest{Body: json.RawMessage(`{}`)})
			result <- err
		}()
		select {
		case err := <-result:
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("expected deadline, got %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("request exceeded its absolute deadline")
		}
	})
}

func TestConcurrentRequestsNeverExceedPinnedLimit(t *testing.T) {
	const (
		maximum = 2
		total   = 12
	)
	entered := make(chan struct{}, total)
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseAll := func() { releaseOnce.Do(func() { close(release) }) }
	defer releaseAll()
	var active atomic.Int32
	var maximumObserved atomic.Int32
	roundTripper := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		current := active.Add(1)
		defer active.Add(-1)
		for {
			observed := maximumObserved.Load()
			if current <= observed || maximumObserved.CompareAndSwap(observed, current) {
				break
			}
		}
		entered <- struct{}{}
		select {
		case <-release:
			return jsonHTTPResponse(http.StatusOK, `{}`), nil
		case <-request.Context().Done():
			return nil, request.Context().Err()
		}
	})
	limits := testLimits()
	limits.MaximumConcurrentRequests = maximum
	client := testClient(t, roundTripper, limits)

	var workers sync.WaitGroup
	errorsReturned := make(chan error, total)
	workers.Add(total)
	for index := 0; index < total; index++ {
		go func() {
			defer workers.Done()
			_, err := client.Register(context.Background(), RegisterRequest{Body: json.RawMessage(`{}`)})
			errorsReturned <- err
		}()
	}
	for index := 0; index < maximum; index++ {
		select {
		case <-entered:
		case <-time.After(2 * time.Second):
			t.Fatal("requests did not reach the concurrency limit")
		}
	}
	select {
	case <-entered:
		t.Fatal("request entered the transport above the concurrency limit")
	case <-time.After(100 * time.Millisecond):
	}
	releaseAll()
	workers.Wait()
	close(errorsReturned)
	for err := range errorsReturned {
		if err != nil {
			t.Errorf("concurrent request returned an error: %v", err)
		}
	}
	if maximumObserved.Load() != maximum {
		t.Fatalf("maximum transport concurrency was %d", maximumObserved.Load())
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

type countingBody struct {
	reader    *bytes.Reader
	bytesRead atomic.Int64
	closed    atomic.Bool
}

func (b *countingBody) Read(value []byte) (int, error) {
	read, err := b.reader.Read(value)
	b.bytesRead.Add(int64(read))
	return read, err
}

func (b *countingBody) Close() error {
	b.closed.Store(true)
	return nil
}

func testClient(t *testing.T, roundTripper http.RoundTripper, limits Limits) *Client {
	t.Helper()
	origin, err := parseOrigin("https://api.worker.test:8443")
	if err != nil {
		t.Fatalf("parse test origin: %v", err)
	}
	return newClient(origin, roundTripper, limits)
}

func testLimits() Limits {
	return Limits{
		MaximumRequestBytes:       1024,
		MaximumResponseBytes:      1024,
		RequestTimeout:            time.Second,
		ClaimTimeout:              2 * time.Second,
		MaximumConcurrentRequests: 4,
	}
}

func jsonHTTPResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode:    status,
		Header:        http.Header{"Content-Type": {"application/json"}},
		Body:          io.NopCloser(strings.NewReader(body)),
		ContentLength: int64(len(body)),
	}
}

func headersEqual(left http.Header, right http.Header) bool {
	if len(left) != len(right) {
		return false
	}
	for name, rightValues := range right {
		leftValues := left.Values(name)
		if len(leftValues) != len(rightValues) {
			return false
		}
		for index := range rightValues {
			if leftValues[index] != rightValues[index] {
				return false
			}
		}
	}
	return true
}

func validConfig(t *testing.T) (Config, *ecdsa.PrivateKey) {
	t.Helper()
	certificate, signer := testCertificate(t, "control.worker.test")
	return Config{
		Origin:             "https://api.worker.test:8443/",
		ServerName:         "api.worker.test",
		RootCertificateDER: [][]byte{bytes.Clone(certificate.Certificate[0])},
		ClientCertificate:  certificate,
		ClientSigner:       signer,
		Limits: Limits{
			MaximumRequestBytes:       2*1024*1024 + 16*1024,
			MaximumResponseBytes:      2 * 1024 * 1024,
			RequestTimeout:            30 * time.Second,
			ClaimTimeout:              90 * time.Second,
			MaximumConcurrentRequests: 8,
		},
	}, signer
}

func testCertificate(t *testing.T, commonName string) (tls.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: commonName},
		DNSNames:              []string{commonName},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	return tls.Certificate{Certificate: [][]byte{der}}, key
}

var _ http.RoundTripper = roundTripFunc(nil)
var _ io.ReadCloser = (*countingBody)(nil)
