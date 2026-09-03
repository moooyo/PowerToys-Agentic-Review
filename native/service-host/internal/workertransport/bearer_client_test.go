package workertransport

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestNewBearerClientPinsServerTLSWithoutAClientCertificate(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://attacker.invalid:8080")
	configuration := validBearerConfig(t)
	originalRootByte := configuration.RootCertificateDER[0][0]
	client, err := NewBearerClient(configuration)
	if err != nil {
		t.Fatalf("NewBearerClient returned an error: %v", err)
	}
	defer client.Close()

	transport, ok := client.state.httpClient.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("NewBearerClient installed transport type %T", client.state.httpClient.Transport)
	}
	if transport.Proxy != nil || transport.TLSClientConfig == nil ||
		transport.TLSClientConfig.MinVersion != tls.VersionTLS13 || transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("Bearer transport did not require direct verified TLS 1.3")
	}
	if transport.TLSClientConfig.ServerName != configuration.ServerName ||
		len(transport.TLSClientConfig.RootCAs.Subjects()) != 1 {
		t.Fatal("Bearer transport did not retain the fixed Server name and private root pool")
	}
	if len(transport.TLSClientConfig.Certificates) != 0 ||
		transport.TLSClientConfig.GetClientCertificate != nil {
		t.Fatal("Bearer transport installed a TLS client credential")
	}
	configuration.RootCertificateDER[0][0] ^= 0xff
	if configuration.RootCertificateDER[0][0] == originalRootByte {
		t.Fatal("test did not mutate caller-owned root DER")
	}
	if len(transport.TLSClientConfig.RootCAs.Subjects()) != 1 {
		t.Fatal("Bearer transport root pool changed after caller mutation")
	}
}

func TestBearerClientAddsOneExactAuthorizationHeaderToWorkerAndArtifactRequests(t *testing.T) {
	var observations []struct {
		path          string
		authorization []string
	}
	roundTripper := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		observations = append(observations, struct {
			path          string
			authorization []string
		}{path: request.URL.Path, authorization: append([]string(nil), request.Header.Values("Authorization")...)})
		return jsonHTTPResponse(http.StatusOK, `{}`), nil
	})
	client := testBearerClient(t, roundTripper, testLimits())

	if _, err := client.Register(context.Background(), RegisterRequest{Body: json.RawMessage(`{}`)}); err != nil {
		t.Fatalf("Register returned an error: %v", err)
	}
	if _, err := client.Claim(context.Background(), ClaimRequest{Body: json.RawMessage(`{}`)}); err != nil {
		t.Fatalf("Claim returned an error: %v", err)
	}
	if _, err := client.HeartbeatInstance(context.Background(), InstanceHeartbeatRequest{
		WorkerInstanceID: "instance:1", Body: json.RawMessage(`{}`),
	}); err != nil {
		t.Fatalf("HeartbeatInstance returned an error: %v", err)
	}
	if _, err := client.CompleteRun(context.Background(), RunCompleteRequest{
		RunAttemptID: "run:1", Body: json.RawMessage(`{}`),
	}); err != nil {
		t.Fatalf("CompleteRun returned an error: %v", err)
	}
	if _, err := client.FailRun(context.Background(), RunFailRequest{
		RunAttemptID: "run:1", Body: json.RawMessage(`{}`),
	}); err != nil {
		t.Fatalf("FailRun returned an error: %v", err)
	}
	artifact, err := NewArtifactClientV2(client)
	if err != nil {
		t.Fatalf("NewArtifactClientV2 returned an error: %v", err)
	}
	if _, err := artifact.CreateArtifactUpload(context.Background(), CreateArtifactUploadRequest{
		RunAttemptID: "run:1", Body: json.RawMessage(`{}`),
	}); err != nil {
		t.Fatalf("CreateArtifactUpload returned an error: %v", err)
	}

	if len(observations) != 6 {
		t.Fatalf("observed %d requests, want 6", len(observations))
	}
	for _, observation := range observations {
		if len(observation.authorization) != 1 ||
			observation.authorization[0] != "Bearer "+testWorkerToken {
			t.Errorf("request %s used Authorization %#v", observation.path, observation.authorization)
		}
	}
}

func TestNewBearerClientRejectsMissingMismatchedOrMalformedProfilesWithoutDisclosure(t *testing.T) {
	valid := validBearerConfig(t)
	other := parseTestWorkerAuth(t, "other-node:1", testWorkerToken)
	tests := []struct {
		name   string
		mutate func(*BearerConfig)
	}{
		{name: "missing node", mutate: func(value *BearerConfig) { value.WorkerNodeID = "" }},
		{name: "missing profile", mutate: func(value *BearerConfig) { value.WorkerAuth = WorkerAuth{} }},
		{name: "mismatched profile", mutate: func(value *BearerConfig) { value.WorkerAuth = other }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			configuration := valid
			test.mutate(&configuration)
			_, err := NewBearerClient(configuration)
			if !errors.Is(err, ErrInvalidConfiguration) {
				t.Fatalf("NewBearerClient returned %v", err)
			}
			if strings.Contains(err.Error(), testWorkerToken) || strings.Contains(err.Error(), "Bearer") {
				t.Fatalf("configuration error disclosed authentication material: %v", err)
			}
		})
	}
}

func TestBearerClientRedactsTransportAndResponseCredentialDisclosure(t *testing.T) {
	client := testBearerClient(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("transport copied " + testWorkerToken)
	}), testLimits())
	_, err := client.Register(context.Background(), RegisterRequest{Body: json.RawMessage(`{}`)})
	if err == nil || strings.Contains(err.Error(), testWorkerToken) {
		t.Fatalf("transport error was not redacted: %v", err)
	}

	client = testBearerClient(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
		body := `{"echo":"` + testWorkerToken + `"}`
		return &http.Response{
			StatusCode: http.StatusUnauthorized,
			Header:     http.Header{"Content-Type": {"application/json"}},
			Body:       io.NopCloser(strings.NewReader(body)),
		}, nil
	}), testLimits())
	_, err = client.Register(context.Background(), RegisterRequest{Body: json.RawMessage(`{}`)})
	if !errors.Is(err, ErrInvalidResponseJSON) || strings.Contains(err.Error(), testWorkerToken) {
		t.Fatalf("credential-reflecting response returned %v", err)
	}

	escapedToken := strings.Replace(testWorkerToken, "A", `\u0041`, 1)
	client = testBearerClient(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
		body := `{"echo":"` + escapedToken + `"}`
		return &http.Response{
			StatusCode: http.StatusUnauthorized,
			Header:     http.Header{"Content-Type": {"application/json"}},
			Body:       io.NopCloser(strings.NewReader(body)),
		}, nil
	}), testLimits())
	_, err = client.Register(context.Background(), RegisterRequest{Body: json.RawMessage(`{}`)})
	if !errors.Is(err, ErrInvalidResponseJSON) {
		t.Fatalf("escaped credential-reflecting response returned %v", err)
	}

	digest := sha256.Sum256([]byte(testWorkerToken))
	encodedDigest := hex.EncodeToString(digest[:])
	client = testBearerClient(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("transport copied digest " + encodedDigest)
	}), testLimits())
	_, err = client.Register(context.Background(), RegisterRequest{Body: json.RawMessage(`{}`)})
	if err == nil || strings.Contains(err.Error(), encodedDigest) {
		t.Fatalf("transport digest error was not redacted: %v", err)
	}

	client = testBearerClient(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
		body := `{"digest":"` + encodedDigest + `"}`
		return &http.Response{
			StatusCode: http.StatusUnauthorized,
			Header:     http.Header{"Content-Type": {"application/json"}},
			Body:       io.NopCloser(strings.NewReader(body)),
		}, nil
	}), testLimits())
	_, err = client.Register(context.Background(), RegisterRequest{Body: json.RawMessage(`{}`)})
	if !errors.Is(err, ErrInvalidResponseJSON) {
		t.Fatalf("credential-digest response returned %v", err)
	}
}

func TestBearerClientCloseClearsItsRetainedToken(t *testing.T) {
	client := testBearerClient(t, roundTripFunc(func(*http.Request) (*http.Response, error) {
		return jsonHTTPResponse(http.StatusOK, `{}`), nil
	}), testLimits())
	if !bytes.Equal(client.state.workerToken, []byte(testWorkerToken)) {
		t.Fatal("Bearer client did not retain the expected private Token copy")
	}
	retained := client.state.workerToken
	if err := client.Close(); err != nil {
		t.Fatalf("Close returned an error: %v", err)
	}
	if client.state.workerToken != nil {
		t.Fatal("Close retained the Worker Token")
	}
	if !bytes.Equal(retained, make([]byte, len(retained))) {
		t.Fatal("Close did not clear the retained Worker Token bytes")
	}
}

func TestBearerClientCloseDoesNotExposeCredentialBearingTransportErrors(t *testing.T) {
	transport := &lifecycleRoundTripper{
		closeIdle: func() error { return errors.New("close copied " + testWorkerToken) },
	}
	client := testBearerClient(t, transport, testLimits())
	err := client.Close()
	if err == nil || strings.Contains(err.Error(), testWorkerToken) {
		t.Fatalf("Close error was not redacted: %v", err)
	}
}

func validBearerConfig(t *testing.T) BearerConfig {
	t.Helper()
	legacy, _ := validConfig(t)
	return BearerConfig{
		Origin:             legacy.Origin,
		ServerName:         legacy.ServerName,
		RootCertificateDER: legacy.RootCertificateDER,
		WorkerNodeID:       "powertoys-node:01",
		WorkerAuth:         parseTestWorkerAuth(t, "powertoys-node:01", testWorkerToken),
		Limits:             legacy.Limits,
	}
}

func testBearerClient(t *testing.T, roundTripper http.RoundTripper, limits Limits) *Client {
	t.Helper()
	origin, err := parseOrigin("https://api.worker.test:8443")
	if err != nil {
		t.Fatalf("parse test origin: %v", err)
	}
	return newBearerClient(
		origin,
		roundTripper,
		parseTestWorkerAuth(t, "powertoys-node:01", testWorkerToken),
		limits,
	)
}

func parseTestWorkerAuth(t *testing.T, workerNodeID string, token string) WorkerAuth {
	t.Helper()
	document := `{"profileId":"agentic-review-worker-auth-v1","token":"` + token +
		`","workerNodeId":"` + workerNodeID + `"}`
	auth, err := parseWorkerAuth([]byte(document))
	if err != nil {
		t.Fatalf("parseWorkerAuth fixture: %v", err)
	}
	return auth
}
