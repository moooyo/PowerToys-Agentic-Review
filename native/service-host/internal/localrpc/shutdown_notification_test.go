package localrpc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"testing"
	"time"
)

func TestShutdownRequestedCrossLanguageGolden(t *testing.T) {
	document, err := marshalShutdownRequested(ShutdownRequestedV1{
		ProtocolVersion:        ProtocolVersion,
		Type:                   "notification",
		Notification:           ShutdownRequestedNotification,
		BootstrapID:            "123e4567-e89b-42d3-a456-426614174000",
		Role:                   RoleControl,
		ReasonCode:             ShutdownRequestedReason,
		RequestedAtUnixMS:      1_700_000_000_000,
		ShutdownDeadlineUnixMS: 1_700_000_015_000,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []byte(`{"bootstrapId":"123e4567-e89b-42d3-a456-426614174000","notification":"ShutdownRequested","protocolVersion":"1.0","reasonCode":"SERVICE_STOP","requestedAtUnixMs":1700000000000,"role":"control","shutdownDeadlineUnixMs":1700000015000,"type":"notification"}`)
	if !bytes.Equal(document, want) {
		t.Fatalf("ShutdownRequestedV1 = %s", document)
	}
	if _, err := DecodeMessage(document, RoleControl); !errors.Is(err, ErrUnknownMessageType) {
		t.Fatalf("Node-originated shutdown notification error = %v", err)
	}
}

func TestShutdownRequestDeadlineCapsLaterArmClaim(t *testing.T) {
	cap := time.Now().Add(time.Second).UTC().Truncate(time.Millisecond)
	binding := committedRuntimeBootstrapBinding{
		role:                       RoleControl,
		bootstrapID:                "123e4567-e89b-42d3-a456-426614174000",
		maximumFrameBytes:          RuntimeBootstrapARWXMaximumFrameBytes,
		maximumRemainingShutdownMS: 105_000,
	}
	gate := &arwxShutdownGate{
		binding: binding, serveBound: true, requestedDeadline: cap,
	}
	_, authorization, err := gate.prepare(armArwxShutdownClaim(RoleControl), cap.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if authorization == nil || !authorization.deadline.Equal(cap) {
		t.Fatalf("Arm deadline = %v, want %v", authorization.deadline, cap)
	}
	failArwxShutdownAuthorization(authorization)
}

func TestShutdownNotificationCanRacePreparedArmBeforeAcknowledgement(t *testing.T) {
	harness := newServerHarness(t, &fakeControlDispatcher{}, defaultServerOptions())
	defer harness.close(t)
	waitForShutdownNotificationReady(t, harness.server)
	requestedAt := time.Now().UTC().Truncate(time.Millisecond)
	deadline := requestedAt.Add(
		time.Duration(harness.server.notifications.binding.maximumRemainingShutdownMS) * time.Millisecond,
	)
	_, authorization, err := harness.server.shutdown.prepare(
		armArwxShutdownClaim(RoleControl),
		deadline,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, valid := harness.server.ArmedShutdownDeadline(); valid {
		t.Fatal("prepared Arm published its deadline before acknowledgement")
	}
	if err := harness.server.RequestShutdown(context.Background(), requestedAt, deadline); !errors.Is(err, ErrShutdownNotificationUnavailable) {
		t.Fatalf("prepared-Arm notification race error = %v", err)
	}
	if !markArwxShutdownAcknowledged(authorization) {
		t.Fatal("prepared Arm could not acknowledge after the notification race")
	}
	committed, valid := harness.server.ArmedShutdownDeadline()
	if !valid || !committed.Equal(deadline) {
		t.Fatalf("committed Arm deadline = (%v, %t), want %v", committed, valid, deadline)
	}
	failArwxShutdownAuthorization(authorization)
}

func TestServerSendsOneBootstrapBoundShutdownNotification(t *testing.T) {
	harness := newServerHarness(t, &fakeControlDispatcher{}, defaultServerOptions())
	defer harness.close(t)
	waitForShutdownNotificationReady(t, harness.server)

	requestedAt := time.Now().UTC().Truncate(time.Millisecond)
	deadline := requestedAt.Add(
		time.Duration(harness.server.notifications.binding.maximumRemainingShutdownMS) * time.Millisecond,
	)
	result := make(chan error, 1)
	go func() {
		result <- harness.server.RequestShutdown(context.Background(), requestedAt, deadline)
	}()
	notification := harness.readResponse(t, MaximumCanonicalControlFrameBytes)
	if notification["type"] != "notification" ||
		notification["notification"] != ShutdownRequestedNotification ||
		notification["bootstrapId"] != harness.server.notifications.binding.bootstrapID ||
		notification["role"] != string(RoleControl) ||
		notification["reasonCode"] != ShutdownRequestedReason ||
		notification["requestedAtUnixMs"] != json.Number(strconv.FormatInt(requestedAt.UnixMilli(), 10)) ||
		notification["shutdownDeadlineUnixMs"] != json.Number(strconv.FormatInt(deadline.UnixMilli(), 10)) {
		t.Fatalf("shutdown notification = %#v", notification)
	}
	if err := <-result; err != nil {
		t.Fatalf("RequestShutdown returned an error: %v", err)
	}
	if !harness.server.notifications.session.state.shutdownRequested() {
		t.Fatal("shutdown notification did not linearize the session state")
	}
	if err := harness.server.RequestShutdown(context.Background(), requestedAt, deadline); !errors.Is(err, ErrShutdownNotificationRepeated) {
		t.Fatalf("repeated RequestShutdown error = %v", err)
	}
}

func TestShutdownNotificationSerializesWithResponsesAndRejectsNewCalls(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	dispatcher := &fakeControlDispatcher{
		register: func(context.Context, json.RawMessage) (json.RawMessage, error) {
			close(started)
			<-release
			return json.RawMessage(`{"registered":true}`), nil
		},
	}
	harness := newServerHarness(t, dispatcher, defaultServerOptions())
	defer harness.close(t)
	harness.send(t, callDocument(t, "register:before", OperationRegister, map[string]any{
		"body": map[string]any{},
	}))
	<-started

	requestedAt := time.Now().UTC().Truncate(time.Millisecond)
	deadline := requestedAt.Add(
		time.Duration(harness.server.notifications.binding.maximumRemainingShutdownMS) * time.Millisecond,
	)
	notified := make(chan error, 1)
	go func() {
		notified <- harness.server.RequestShutdown(context.Background(), requestedAt, deadline)
	}()
	first := harness.readResponse(t, MaximumCanonicalControlFrameBytes)
	if first["notification"] != ShutdownRequestedNotification {
		t.Fatalf("first outbound frame = %#v, want shutdown notification", first)
	}
	if err := <-notified; err != nil {
		t.Fatal(err)
	}
	close(release)
	response := harness.readResponse(t, MaximumFrameBytes)
	if response["requestId"] != "register:before" || response["outcome"] != "ok" {
		t.Fatalf("pre-notification response = %#v", response)
	}

	harness.send(t, callDocument(t, "register:after", OperationRegister, map[string]any{
		"body": map[string]any{},
	}))
	rejected := harness.readResponse(t, MaximumCanonicalControlFrameBytes)
	if rejected["requestId"] != "register:after" || rejected["outcome"] != "error" {
		t.Fatalf("post-notification response = %#v", rejected)
	}
	errorBody, ok := rejected["error"].(map[string]any)
	if !ok || errorBody["code"] != "SHUTDOWN_REQUESTED" {
		t.Fatalf("post-notification error = %#v", rejected["error"])
	}
}

func TestShutdownNotificationRejectsUnavailableExecutorAndInvalidDeadline(t *testing.T) {
	control := newServerHarness(t, &fakeControlDispatcher{}, defaultServerOptions())
	requestedAt := time.Now().UTC().Truncate(time.Millisecond)
	deadline := requestedAt.Add(
		time.Duration(control.server.notifications.binding.maximumRemainingShutdownMS) * time.Millisecond,
	)
	control.close(t)
	if err := control.server.RequestShutdown(context.Background(), requestedAt, deadline); !errors.Is(err, ErrShutdownNotificationUnavailable) {
		t.Fatalf("stopped server RequestShutdown error = %v", err)
	}

	options := defaultServerOptions()
	options.Role = RoleExecutor
	input := &borrowedEOFChannel{}
	options = serverOptionsWithBootstrapForTest(t, options, input)
	executor, err := NewServer(options, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := executor.RequestShutdown(context.Background(), requestedAt, deadline); !errors.Is(err, ErrOperationNotAllowed) {
		t.Fatalf("Executor RequestShutdown error = %v", err)
	}

	unstartedOptions := defaultServerOptions()
	unstartedInput := &borrowedEOFChannel{}
	unstartedOptions = serverOptionsWithBootstrapForTest(t, unstartedOptions, unstartedInput)
	unstarted, err := NewServer(unstartedOptions, &fakeControlDispatcher{})
	if err != nil {
		t.Fatal(err)
	}
	unstartedDeadline := requestedAt.Add(
		time.Duration(unstarted.notifications.binding.maximumRemainingShutdownMS) * time.Millisecond,
	)
	if err := unstarted.RequestShutdown(context.Background(), requestedAt, unstartedDeadline); !errors.Is(err, ErrShutdownNotificationUnavailable) {
		t.Fatalf("unstarted server RequestShutdown error = %v", err)
	}

	invalidOptions := defaultServerOptions()
	invalidInput := &borrowedEOFChannel{}
	invalidOptions = serverOptionsWithBootstrapForTest(t, invalidOptions, invalidInput)
	invalidServer, err := NewServer(invalidOptions, &fakeControlDispatcher{})
	if err != nil {
		t.Fatal(err)
	}
	if err := invalidServer.RequestShutdown(
		context.Background(),
		requestedAt,
		deadline.Add(time.Millisecond),
	); !errors.Is(err, ErrShutdownNotificationInvalid) {
		t.Fatalf("invalid deadline RequestShutdown error = %v", err)
	}
}

func TestUnavailableShutdownRequestDoesNotConsumeLaterBoundSession(t *testing.T) {
	binding := committedRuntimeBootstrapBinding{
		role:                       RoleControl,
		bootstrapID:                "123e4567-e89b-42d3-a456-426614174000",
		maximumRemainingShutdownMS: 1_000,
	}
	shutdown := &arwxShutdownGate{binding: binding, serveBound: true}
	controller := newShutdownNotificationController(binding, shutdown)
	requestedAt := time.Now().UTC().Truncate(time.Millisecond)
	deadline := requestedAt.Add(time.Second)
	if err := controller.request(context.Background(), requestedAt, deadline); !errors.Is(err, ErrShutdownNotificationUnavailable) {
		t.Fatalf("unbound shutdown request error = %v", err)
	}
	waitStarted := make(chan struct{})
	waitResult := make(chan error, 1)
	go func() {
		close(waitStarted)
		waitResult <- controller.waitUntilBound(context.Background())
	}()
	<-waitStarted
	select {
	case err := <-waitResult:
		t.Fatalf("bind-ready barrier completed before bind: %v", err)
	default:
	}
	output := &signalingWriter{writes: make(chan []byte, 2)}
	writer := newResponseWriter(context.Background(), output, time.Second)
	state := newSessionState(10)
	if err := controller.bind(writer, state); err != nil {
		t.Fatal(err)
	}
	if err := <-waitResult; err != nil {
		t.Fatalf("bind-ready barrier returned an error: %v", err)
	}
	if err := controller.request(context.Background(), requestedAt, deadline); err != nil {
		t.Fatalf("bound retry returned an error: %v", err)
	}
	if !state.shutdownRequested() {
		t.Fatal("bound retry did not linearize shutdown state")
	}
}

func TestShutdownNotificationCannotWriteAfterServeSessionCancellation(t *testing.T) {
	binding := committedRuntimeBootstrapBinding{
		role:                       RoleControl,
		bootstrapID:                "123e4567-e89b-42d3-a456-426614174000",
		maximumRemainingShutdownMS: 1_000,
	}
	shutdown := &arwxShutdownGate{binding: binding, serveBound: true}
	controller := newShutdownNotificationController(binding, shutdown)
	output := &signalingWriter{writes: make(chan []byte, 2)}
	sessionContext, cancelSession := context.WithCancelCause(context.Background())
	sessionFailure := errors.New("Serve session ended")
	cancelSession(sessionFailure)
	writer := newResponseWriter(sessionContext, output, time.Second)
	state := newSessionState(10)
	if err := controller.bind(writer, state); err != nil {
		t.Fatal(err)
	}
	requestedAt := time.Now().UTC().Truncate(time.Millisecond)
	if err := controller.request(
		context.Background(),
		requestedAt,
		requestedAt.Add(time.Second),
	); !errors.Is(err, sessionFailure) {
		t.Fatalf("ended-session notification error = %v", err)
	}
	if state.shutdownRequested() {
		t.Fatal("ended Serve session published shutdown state")
	}
	select {
	case value := <-output.writes:
		t.Fatalf("ended Serve session wrote notification bytes: %x", value)
	default:
	}
}

func waitForShutdownNotificationReady(t *testing.T, server *Server) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := server.WaitUntilShutdownNotificationReady(ctx); err != nil {
		t.Fatalf("wait for shutdown notification readiness: %v", err)
	}
}
