package workertransport

import (
	"bytes"
	"context"
	"crypto"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	registerPath       = "/api/v1/worker/instances"
	claimPath          = "/api/v1/worker/leases/claim"
	heartbeatPathStart = "/api/v1/worker/instances/"
	heartbeatPathEnd   = "/heartbeat"
	runPathStart       = "/api/v1/worker/runs/"
	completePathEnd    = "/complete"
	failPathEnd        = "/fail"

	workerUserAgent              = "AgenticReview-ServiceHost/1.0"
	maximumConfiguredBytes       = 16 * 1024 * 1024
	maximumConfiguredTimeout     = 10 * time.Minute
	maximumConfiguredConcurrency = 1024
	maximumResponseHeaders       = 64 * 1024
	maximumRootCertificates      = 32
	maximumRootCertificateBytes  = 64 * 1024
	maximumRootCertificatesBytes = 512 * 1024
)

var (
	ErrInvalidConfiguration = errors.New("invalid worker transport configuration")
	ErrInvalidEntityID      = errors.New("invalid entity identifier")
	ErrInvalidRequestJSON   = errors.New("worker API request is not valid JSON")
	ErrInvalidResponseJSON  = errors.New("worker API response is not valid JSON")
	ErrRequestTooLarge      = errors.New("worker API request exceeds its byte limit")
	ErrResponseTooLarge     = errors.New("worker API response exceeds its byte limit")
	ErrUnexpectedStatus     = errors.New("worker API returned an unexpected HTTP status")
	ErrUnexpectedMediaType  = errors.New("worker API returned an unexpected media type")
	ErrContentEncoded       = errors.New("worker API returned a content-encoded response")
	ErrRedirect             = errors.New("worker API redirects are disabled")
	ErrClosed               = errors.New("worker API client is closed")
)

type Limits struct {
	MaximumRequestBytes       int64
	MaximumResponseBytes      int64
	RequestTimeout            time.Duration
	ClaimTimeout              time.Duration
	MaximumConcurrentRequests int
}

type Config struct {
	Origin             string
	ServerName         string
	RootCertificateDER [][]byte
	ClientCertificate  tls.Certificate
	// ClientSigner is borrowed by a successfully constructed Client until Client.Close succeeds.
	// The caller retains ownership and must close the signer only after that lifecycle barrier.
	ClientSigner crypto.Signer
	Limits       Limits
}

type RegisterRequest struct {
	Body json.RawMessage
}

type RegisterResponse struct {
	Body json.RawMessage
}

type ClaimRequest struct {
	Body json.RawMessage
}

type ClaimResponse struct {
	Body json.RawMessage
}

type InstanceHeartbeatRequest struct {
	WorkerInstanceID string
	Body             json.RawMessage
}

type InstanceHeartbeatResponse struct {
	Body json.RawMessage
}

type RunCompleteRequest struct {
	RunAttemptID string
	Body         json.RawMessage
}

type RunCompleteResponse struct {
	Body json.RawMessage
}

type RunFailRequest struct {
	RunAttemptID string
	Body         json.RawMessage
}

type RunFailResponse struct {
	Body json.RawMessage
}

type StatusError struct {
	StatusCode int
	Body       json.RawMessage
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("worker API returned HTTP %d", e.StatusCode)
}

func (e *StatusError) Unwrap() error {
	return ErrUnexpectedStatus
}

// Client is safe for concurrent requests and lifecycle calls. Value copies share one private
// lifecycle state; its zero value is closed and fail-closed for every Worker API operation.
type Client struct {
	state *clientState
}

type clientState struct {
	origin               url.URL
	httpClient           *http.Client
	maximumRequestBytes  int64
	maximumResponseBytes int64
	requestTimeout       time.Duration
	claimTimeout         time.Duration
	concurrentRequests   chan struct{}

	lifecycleMu sync.Mutex
	closed      bool
	drained     bool
	requests    map[uint64]context.CancelCauseFunc
	nextRequest uint64
	active      sync.WaitGroup
	closeOnce   sync.Once

	closeMu              sync.Mutex
	closeIdleConnections func() error
	transportReleased    bool
	signerGate           *clientSignerGate
}

type executePolicy struct {
	maximumRequestBytes  int64
	maximumResponseBytes int64
	primarySuccessStatus int
	secondSuccessStatus  int
}

type clientSignerGate struct {
	mu           sync.Mutex
	closed       bool
	signer       crypto.Signer
	publicKeyDER []byte
	active       sync.WaitGroup
}

type errorIdleConnectionCloser interface {
	CloseIdleConnections() error
}

type idleConnectionCloser interface {
	CloseIdleConnections()
}

func NewClient(config Config) (*Client, error) {
	origin, err := parseOrigin(config.Origin)
	if err != nil {
		return nil, err
	}
	if err := validateServerName(config.ServerName); err != nil {
		return nil, err
	}
	rootCAs, err := prepareRootCAs(config.RootCertificateDER)
	if err != nil {
		return nil, err
	}
	if err := validateLimits(config.Limits); err != nil {
		return nil, err
	}

	signerGate, err := newClientSignerGate(config.ClientSigner)
	if err != nil {
		return nil, err
	}
	certificate, err := prepareClientCertificate(config.ClientCertificate, signerGate)
	if err != nil {
		signerGate.closeAndWait()
		return nil, err
	}
	tlsConfig := &tls.Config{
		MinVersion:   tls.VersionTLS13,
		ServerName:   config.ServerName,
		RootCAs:      rootCAs,
		Certificates: []tls.Certificate{certificate},
	}
	dialTimeout := min(config.Limits.RequestTimeout, 30*time.Second)
	transport := &http.Transport{
		Proxy:                  nil,
		DialContext:            (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:      true,
		MaxIdleConns:           config.Limits.MaximumConcurrentRequests,
		MaxIdleConnsPerHost:    config.Limits.MaximumConcurrentRequests,
		MaxConnsPerHost:        config.Limits.MaximumConcurrentRequests,
		IdleConnTimeout:        90 * time.Second,
		TLSHandshakeTimeout:    dialTimeout,
		ResponseHeaderTimeout:  max(config.Limits.RequestTimeout, config.Limits.ClaimTimeout),
		ExpectContinueTimeout:  time.Second,
		TLSClientConfig:        tlsConfig,
		DisableCompression:     true,
		MaxResponseHeaderBytes: maximumResponseHeaders,
	}
	return newClient(origin, transport, signerGate, config.Limits), nil
}

func (c *Client) Register(ctx context.Context, request RegisterRequest) (RegisterResponse, error) {
	state, err := c.clientState()
	if err != nil {
		return RegisterResponse{}, err
	}
	response, err := state.execute(
		ctx,
		http.MethodPost,
		state.fixedTarget(registerPath),
		request.Body,
		state.requestTimeout,
	)
	if err != nil {
		return RegisterResponse{}, err
	}
	return RegisterResponse{Body: response}, nil
}

func (c *Client) Claim(ctx context.Context, request ClaimRequest) (ClaimResponse, error) {
	state, err := c.clientState()
	if err != nil {
		return ClaimResponse{}, err
	}
	response, err := state.execute(ctx, http.MethodPost, state.fixedTarget(claimPath), request.Body, state.claimTimeout)
	if err != nil {
		return ClaimResponse{}, err
	}
	return ClaimResponse{Body: response}, nil
}

func (c *Client) HeartbeatInstance(
	ctx context.Context,
	request InstanceHeartbeatRequest,
) (InstanceHeartbeatResponse, error) {
	state, err := c.clientState()
	if err != nil {
		return InstanceHeartbeatResponse{}, err
	}
	target, err := state.entityTarget(heartbeatPathStart, request.WorkerInstanceID, heartbeatPathEnd)
	if err != nil {
		return InstanceHeartbeatResponse{}, err
	}
	response, err := state.execute(ctx, http.MethodPut, target, request.Body, state.requestTimeout)
	if err != nil {
		return InstanceHeartbeatResponse{}, err
	}
	return InstanceHeartbeatResponse{Body: response}, nil
}

func (c *Client) CompleteRun(ctx context.Context, request RunCompleteRequest) (RunCompleteResponse, error) {
	state, err := c.clientState()
	if err != nil {
		return RunCompleteResponse{}, err
	}
	target, err := state.entityTarget(runPathStart, request.RunAttemptID, completePathEnd)
	if err != nil {
		return RunCompleteResponse{}, err
	}
	response, err := state.execute(ctx, http.MethodPost, target, request.Body, state.requestTimeout)
	if err != nil {
		return RunCompleteResponse{}, err
	}
	return RunCompleteResponse{Body: response}, nil
}

func (c *Client) FailRun(ctx context.Context, request RunFailRequest) (RunFailResponse, error) {
	state, err := c.clientState()
	if err != nil {
		return RunFailResponse{}, err
	}
	target, err := state.entityTarget(runPathStart, request.RunAttemptID, failPathEnd)
	if err != nil {
		return RunFailResponse{}, err
	}
	response, err := state.execute(ctx, http.MethodPost, target, request.Body, state.requestTimeout)
	if err != nil {
		return RunFailResponse{}, err
	}
	return RunFailResponse{Body: response}, nil
}

// Close rejects new requests, cancels and waits for active requests, and releases the HTTP
// transport's idle connections. A failed transport release may be retried by calling Close again.
// After Close succeeds, the client no longer retains the transport that borrows ClientSigner; it
// never closes that caller-owned signer.
func (c *Client) Close() error {
	if c == nil || c.state == nil {
		return nil
	}
	state := c.state
	state.closeOnce.Do(func() {
		state.lifecycleMu.Lock()
		state.closed = true
		cancellations := make([]context.CancelCauseFunc, 0, len(state.requests))
		for _, cancel := range state.requests {
			cancellations = append(cancellations, cancel)
		}
		signerGate := state.signerGate
		state.lifecycleMu.Unlock()

		signerGate.close()

		for _, cancel := range cancellations {
			cancel(ErrClosed)
		}
		state.active.Wait()
		signerGate.waitAndRelease()

		state.lifecycleMu.Lock()
		state.signerGate = nil
		state.drained = true
		state.lifecycleMu.Unlock()
	})
	return c.CloseIdleConnections()
}

// CloseIdleConnections closes pooled HTTP connections without closing an open client. Once Close
// has drained all active requests, a successful call also releases the transport reference. A
// failed call retains the transport so either lifecycle method can retry the release.
func (c *Client) CloseIdleConnections() error {
	if c == nil || c.state == nil {
		return nil
	}
	state := c.state
	state.closeMu.Lock()
	defer state.closeMu.Unlock()

	state.lifecycleMu.Lock()
	if state.transportReleased {
		state.lifecycleMu.Unlock()
		return nil
	}
	closeIdleConnections := state.closeIdleConnections
	finalRelease := state.closed && state.drained
	state.lifecycleMu.Unlock()

	if err := closeIdleConnections(); err != nil {
		return fmt.Errorf("close worker API idle connections: %w", err)
	}
	if finalRelease {
		state.lifecycleMu.Lock()
		state.httpClient = nil
		state.closeIdleConnections = nil
		state.transportReleased = true
		state.lifecycleMu.Unlock()
	}
	return nil
}

func newClient(
	origin url.URL,
	roundTripper http.RoundTripper,
	signerGate *clientSignerGate,
	limits Limits,
) *Client {
	return &Client{
		state: &clientState{
			origin: origin,
			httpClient: &http.Client{
				Transport:     roundTripper,
				CheckRedirect: rejectRedirect,
			},
			maximumRequestBytes:  limits.MaximumRequestBytes,
			maximumResponseBytes: limits.MaximumResponseBytes,
			requestTimeout:       limits.RequestTimeout,
			claimTimeout:         limits.ClaimTimeout,
			concurrentRequests:   make(chan struct{}, limits.MaximumConcurrentRequests),
			requests:             make(map[uint64]context.CancelCauseFunc),
			closeIdleConnections: prepareIdleConnectionCloser(roundTripper),
			signerGate:           signerGate,
		},
	}
}

func (c *Client) clientState() (*clientState, error) {
	if c == nil || c.state == nil {
		return nil, ErrClosed
	}
	return c.state, nil
}

func prepareIdleConnectionCloser(roundTripper http.RoundTripper) func() error {
	if closer, ok := roundTripper.(errorIdleConnectionCloser); ok {
		return closer.CloseIdleConnections
	}
	if closer, ok := roundTripper.(idleConnectionCloser); ok {
		return func() error {
			closer.CloseIdleConnections()
			return nil
		}
	}
	return func() error { return nil }
}

func newClientSignerGate(signer crypto.Signer) (*clientSignerGate, error) {
	if isNilSigner(signer) {
		return nil, configurationError("ClientSigner is required", nil)
	}
	publicKeyDER, err := x509.MarshalPKIXPublicKey(signer.Public())
	if err != nil {
		return nil, configurationError("ClientSigner public key is invalid", err)
	}
	if _, err := x509.ParsePKIXPublicKey(publicKeyDER); err != nil {
		return nil, configurationError("ClientSigner public key is invalid", err)
	}
	return &clientSignerGate{
		signer:       signer,
		publicKeyDER: bytes.Clone(publicKeyDER),
	}, nil
}

func (g *clientSignerGate) Public() crypto.PublicKey {
	if g == nil {
		return nil
	}
	publicKey, err := x509.ParsePKIXPublicKey(bytes.Clone(g.publicKeyDER))
	if err != nil {
		return nil
	}
	return publicKey
}

func (g *clientSignerGate) Sign(
	random io.Reader,
	digest []byte,
	options crypto.SignerOpts,
) ([]byte, error) {
	if g == nil {
		return nil, ErrClosed
	}
	g.mu.Lock()
	if g.closed {
		g.mu.Unlock()
		return nil, ErrClosed
	}
	g.active.Add(1)
	signer := g.signer
	g.mu.Unlock()

	defer g.active.Done()
	return signer.Sign(random, digest, options)
}

func (g *clientSignerGate) close() {
	if g == nil {
		return
	}
	g.mu.Lock()
	g.closed = true
	g.mu.Unlock()
}

func (g *clientSignerGate) waitAndRelease() {
	if g == nil {
		return
	}
	g.active.Wait()
	g.mu.Lock()
	g.signer = nil
	g.mu.Unlock()
}

func (g *clientSignerGate) closeAndWait() {
	g.close()
	g.waitAndRelease()
}

func rejectRedirect(*http.Request, []*http.Request) error {
	// Returning ErrUseLastResponse prevents net/http from reading and discarding a body outside
	// this package's response-byte and content-encoding checks.
	return http.ErrUseLastResponse
}

func (c *clientState) fixedTarget(path string) url.URL {
	target := c.origin
	target.Path = path
	target.RawPath = ""
	return target
}

func (c *clientState) entityTarget(prefix string, entityID string, suffix string) (url.URL, error) {
	if err := validateEntityID(entityID); err != nil {
		return url.URL{}, err
	}
	target := c.origin
	target.Path = prefix + entityID + suffix
	target.RawPath = prefix + url.PathEscape(entityID) + suffix
	return target, nil
}

func (c *clientState) execute(
	ctx context.Context,
	method string,
	target url.URL,
	body json.RawMessage,
	timeout time.Duration,
) (json.RawMessage, error) {
	return c.executeWithPolicy(ctx, method, target, body, timeout, executePolicy{
		maximumRequestBytes:  c.maximumRequestBytes,
		maximumResponseBytes: c.maximumResponseBytes,
		primarySuccessStatus: http.StatusOK,
	})
}

func (c *clientState) executeWithPolicy(
	ctx context.Context,
	method string,
	target url.URL,
	body json.RawMessage,
	timeout time.Duration,
	policy executePolicy,
) (json.RawMessage, error) {
	if ctx == nil {
		return nil, errors.New("worker API context is required")
	}
	requestContext, cancel := context.WithTimeout(ctx, timeout)
	if err := requestContext.Err(); err != nil {
		cancel()
		return nil, err
	}
	requestContext, httpClient, finish, err := c.beginRequest(requestContext, cancel)
	if err != nil {
		return nil, err
	}
	defer finish()
	if int64(len(body)) > policy.maximumRequestBytes {
		return nil, fmt.Errorf("%w: maximum is %d bytes", ErrRequestTooLarge, policy.maximumRequestBytes)
	}
	if len(body) == 0 || !json.Valid(body) {
		return nil, ErrInvalidRequestJSON
	}

	select {
	case c.concurrentRequests <- struct{}{}:
		defer func() { <-c.concurrentRequests }()
	case <-requestContext.Done():
		return nil, context.Cause(requestContext)
	}
	if err := context.Cause(requestContext); err != nil {
		return nil, err
	}
	requestBody := bytes.Clone(body)

	request, err := http.NewRequestWithContext(
		requestContext,
		method,
		target.String(),
		bytes.NewReader(requestBody),
	)
	if err != nil {
		return nil, fmt.Errorf("construct fixed-origin worker API request: %w", err)
	}
	request.Header = http.Header{
		"Accept":       {"application/json"},
		"Content-Type": {"application/json"},
		"User-Agent":   {workerUserAgent},
	}
	request.ContentLength = int64(len(requestBody))

	response, err := httpClient.Do(request)
	if err != nil {
		var closeError error
		if response != nil && response.Body != nil {
			closeError = response.Body.Close()
		}
		return nil, fmt.Errorf(
			"worker API request failed: %w",
			errors.Join(err, context.Cause(requestContext), closeError),
		)
	}
	if response == nil {
		return nil, errors.New("worker API transport returned a nil response")
	}
	if err := validateResponseHeaders(response.Header); err != nil {
		var closeError error
		if response.Body != nil {
			closeError = response.Body.Close()
		}
		return nil, errors.Join(err, closeError)
	}
	responseBody, err := readResponseBody(response, policy.maximumResponseBytes)
	if err != nil {
		return nil, errors.Join(err, context.Cause(requestContext))
	}
	if errors.Is(context.Cause(requestContext), ErrClosed) {
		return nil, ErrClosed
	}
	if response.StatusCode >= http.StatusMultipleChoices && response.StatusCode < http.StatusBadRequest {
		return nil, ErrRedirect
	}
	acceptedStatus := response.StatusCode == policy.primarySuccessStatus ||
		policy.secondSuccessStatus != 0 && response.StatusCode == policy.secondSuccessStatus
	if len(responseBody) == 0 {
		if !acceptedStatus {
			return nil, &StatusError{StatusCode: response.StatusCode}
		}
		return nil, ErrInvalidResponseJSON
	}
	if !json.Valid(responseBody) {
		return nil, ErrInvalidResponseJSON
	}
	if !acceptedStatus {
		return nil, &StatusError{
			StatusCode: response.StatusCode,
			Body:       json.RawMessage(bytes.Clone(responseBody)),
		}
	}
	return json.RawMessage(responseBody), nil
}

func (c *clientState) beginRequest(
	requestContext context.Context,
	timeoutCancel context.CancelFunc,
) (context.Context, *http.Client, func(), error) {
	operationContext, operationCancel := context.WithCancelCause(requestContext)

	c.lifecycleMu.Lock()
	if c.closed {
		c.lifecycleMu.Unlock()
		operationCancel(ErrClosed)
		timeoutCancel()
		return nil, nil, nil, ErrClosed
	}
	c.nextRequest++
	requestID := c.nextRequest
	c.requests[requestID] = operationCancel
	c.active.Add(1)
	httpClient := c.httpClient
	c.lifecycleMu.Unlock()

	var once sync.Once
	finish := func() {
		once.Do(func() {
			c.lifecycleMu.Lock()
			delete(c.requests, requestID)
			c.lifecycleMu.Unlock()
			operationCancel(nil)
			timeoutCancel()
			c.active.Done()
		})
	}
	return operationContext, httpClient, finish, nil
}

func readResponseBody(response *http.Response, maximumBytes int64) ([]byte, error) {
	if response.Body == nil {
		return nil, errors.New("worker API response body is missing")
	}
	if response.ContentLength > maximumBytes {
		closeError := response.Body.Close()
		limitError := fmt.Errorf("%w: maximum is %d bytes", ErrResponseTooLarge, maximumBytes)
		return nil, errors.Join(limitError, closeError)
	}

	limited := &io.LimitedReader{R: response.Body, N: maximumBytes + 1}
	body, readError := io.ReadAll(limited)
	closeError := response.Body.Close()
	if readError != nil {
		return nil, errors.Join(fmt.Errorf("read worker API response: %w", readError), closeError)
	}
	if int64(len(body)) > maximumBytes {
		limitError := fmt.Errorf("%w: maximum is %d bytes", ErrResponseTooLarge, maximumBytes)
		return nil, errors.Join(limitError, closeError)
	}
	if closeError != nil {
		return nil, fmt.Errorf("close worker API response: %w", closeError)
	}
	return body, nil
}

func validateResponseHeaders(header http.Header) error {
	if values := header.Values("Content-Encoding"); len(values) != 0 {
		return ErrContentEncoded
	}
	values := header.Values("Content-Type")
	if len(values) != 1 {
		return ErrUnexpectedMediaType
	}
	mediaType, parameters, err := mime.ParseMediaType(values[0])
	if err != nil || !strings.EqualFold(mediaType, "application/json") {
		return ErrUnexpectedMediaType
	}
	for name, value := range parameters {
		if !strings.EqualFold(name, "charset") || !strings.EqualFold(value, "utf-8") {
			return ErrUnexpectedMediaType
		}
	}
	return nil
}

func parseOrigin(raw string) (url.URL, error) {
	if raw == "" || strings.TrimSpace(raw) != raw {
		return url.URL{}, configurationError("Origin must be a non-empty canonical HTTPS origin", nil)
	}
	origin, err := url.Parse(raw)
	if err != nil {
		return url.URL{}, configurationError("Origin is not a valid URL", nil)
	}
	if origin.Scheme != "https" || origin.Host == "" || origin.Hostname() == "" ||
		origin.User != nil || origin.Opaque != "" ||
		(origin.Path != "" && origin.Path != "/") || origin.RawPath != "" ||
		origin.RawQuery != "" || origin.ForceQuery || origin.Fragment != "" {
		return url.URL{}, configurationError(
			"Origin must be HTTPS without credentials, a path, a query, or a fragment",
			nil,
		)
	}
	if strings.Contains(raw, "#") {
		return url.URL{}, configurationError("Origin must not contain a fragment delimiter", nil)
	}
	if strings.Contains(origin.Host, "%") {
		return url.URL{}, configurationError("Origin must not contain an IPv6 zone identifier or escaping", nil)
	}
	port := origin.Port()
	if port != "" {
		value, err := strconv.ParseUint(port, 10, 16)
		if err != nil || value == 0 || value > 65535 || strconv.FormatUint(value, 10) != port {
			return url.URL{}, configurationError("Origin port is invalid or noncanonical", nil)
		}
	} else if origin.Host != origin.Hostname() {
		hostname := origin.Hostname()
		if net.ParseIP(hostname) == nil || origin.Host != "["+hostname+"]" {
			return url.URL{}, configurationError("Origin authority has an empty or invalid port", nil)
		}
	}
	origin.Path = ""
	return *origin, nil
}

func prepareRootCAs(encoded [][]byte) (*x509.CertPool, error) {
	if len(encoded) == 0 || len(encoded) > maximumRootCertificates {
		return nil, configurationError("RootCertificateDER count is outside the supported range", nil)
	}
	pool := x509.NewCertPool()
	totalBytes := 0
	for _, der := range encoded {
		if len(der) == 0 || len(der) > maximumRootCertificateBytes {
			return nil, configurationError("RootCertificateDER contains an invalid certificate size", nil)
		}
		totalBytes += len(der)
		if totalBytes > maximumRootCertificatesBytes {
			return nil, configurationError("RootCertificateDER exceeds its aggregate byte limit", nil)
		}
		certificate, err := x509.ParseCertificate(bytes.Clone(der))
		if err != nil {
			return nil, configurationError("RootCertificateDER contains an invalid certificate", nil)
		}
		pool.AddCert(certificate)
	}
	return pool, nil
}

func validateServerName(value string) error {
	if value == "" || len(value) > 253 || strings.TrimSpace(value) != value {
		return configurationError("ServerName must be a bounded DNS name or IP address", nil)
	}
	if net.ParseIP(value) != nil {
		return nil
	}
	if strings.HasPrefix(value, ".") || strings.HasSuffix(value, ".") {
		return configurationError("ServerName must use canonical DNS spelling", nil)
	}
	for _, label := range strings.Split(value, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return configurationError("ServerName contains an invalid DNS label", nil)
		}
		for _, character := range label {
			if (character >= 'A' && character <= 'Z') ||
				(character >= 'a' && character <= 'z') ||
				(character >= '0' && character <= '9') || character == '-' {
				continue
			}
			return configurationError("ServerName contains an invalid DNS character", nil)
		}
	}
	return nil
}

func validateLimits(limits Limits) error {
	if limits.MaximumRequestBytes <= 0 || limits.MaximumRequestBytes > maximumConfiguredBytes {
		return configurationError("MaximumRequestBytes is outside the supported range", nil)
	}
	if limits.MaximumResponseBytes <= 0 || limits.MaximumResponseBytes > maximumConfiguredBytes {
		return configurationError("MaximumResponseBytes is outside the supported range", nil)
	}
	if limits.RequestTimeout <= 0 || limits.RequestTimeout > maximumConfiguredTimeout {
		return configurationError("RequestTimeout is outside the supported range", nil)
	}
	if limits.ClaimTimeout <= 0 || limits.ClaimTimeout > maximumConfiguredTimeout {
		return configurationError("ClaimTimeout is outside the supported range", nil)
	}
	if limits.MaximumConcurrentRequests <= 0 ||
		limits.MaximumConcurrentRequests > maximumConfiguredConcurrency {
		return configurationError("MaximumConcurrentRequests is outside the supported range", nil)
	}
	return nil
}

func prepareClientCertificate(source tls.Certificate, signer crypto.Signer) (tls.Certificate, error) {
	if isNilSigner(signer) {
		return tls.Certificate{}, configurationError("ClientSigner is required", nil)
	}
	if len(source.Certificate) == 0 {
		return tls.Certificate{}, configurationError("ClientCertificate must contain a certificate chain", nil)
	}
	certificate := source
	certificate.Certificate = make([][]byte, len(source.Certificate))
	for index, der := range source.Certificate {
		if len(der) == 0 {
			return tls.Certificate{}, configurationError("ClientCertificate chain contains an empty certificate", nil)
		}
		certificate.Certificate[index] = bytes.Clone(der)
	}
	leaf, err := x509.ParseCertificate(certificate.Certificate[0])
	if err != nil {
		return tls.Certificate{}, configurationError("ClientCertificate leaf is invalid", err)
	}
	leafPublicKey, err := x509.MarshalPKIXPublicKey(leaf.PublicKey)
	if err != nil {
		return tls.Certificate{}, configurationError("ClientCertificate public key is invalid", err)
	}
	signerPublicKey, err := x509.MarshalPKIXPublicKey(signer.Public())
	if err != nil {
		return tls.Certificate{}, configurationError("ClientSigner public key is invalid", err)
	}
	if !bytes.Equal(leafPublicKey, signerPublicKey) {
		return tls.Certificate{}, configurationError(
			"ClientSigner does not match the ClientCertificate leaf public key",
			nil,
		)
	}

	certificate.PrivateKey = signer
	certificate.Leaf = leaf
	certificate.OCSPStaple = bytes.Clone(source.OCSPStaple)
	certificate.SignedCertificateTimestamps = make([][]byte, len(source.SignedCertificateTimestamps))
	for index, timestamp := range source.SignedCertificateTimestamps {
		certificate.SignedCertificateTimestamps[index] = bytes.Clone(timestamp)
	}
	certificate.SupportedSignatureAlgorithms = append(
		[]tls.SignatureScheme(nil),
		source.SupportedSignatureAlgorithms...,
	)
	return certificate, nil
}

func isNilSigner(signer crypto.Signer) bool {
	if signer == nil {
		return true
	}
	value := reflect.ValueOf(signer)
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return value.IsNil()
	default:
		return false
	}
}

func validateEntityID(value string) error {
	if len(value) == 0 || len(value) > 128 || !isASCIIAlphaNumeric(value[0]) {
		return ErrInvalidEntityID
	}
	for index := 1; index < len(value); index++ {
		character := value[index]
		if isASCIIAlphaNumeric(character) || character == '.' || character == '_' ||
			character == ':' || character == '-' {
			continue
		}
		return ErrInvalidEntityID
	}
	return nil
}

func isASCIIAlphaNumeric(value byte) bool {
	return value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z' ||
		value >= '0' && value <= '9'
}

func configurationError(message string, cause error) error {
	if cause == nil {
		return fmt.Errorf("%w: %s", ErrInvalidConfiguration, message)
	}
	return fmt.Errorf("%w: %s: %w", ErrInvalidConfiguration, message, cause)
}
