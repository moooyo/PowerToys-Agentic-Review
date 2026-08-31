package localrpc

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"net"
	"os"
	"strings"
	"testing"
	"time"
)

func TestArmArwxShutdownMatchesSharedCrossLanguageGolden(t *testing.T) {
	lines := armArwxShutdownGoldenLines(t)
	tests := []struct {
		name         string
		role         Role
		callLine     int
		responseLine int
		expectedType int
		expectedSeq  string
	}{
		{name: "control", role: RoleControl, callLine: 0, responseLine: 1, expectedType: 14, expectedSeq: "18446744073709551615"},
		{name: "executor", role: RoleExecutor, callLine: 2, responseLine: 3, expectedType: 15, expectedSeq: "7"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			message, err := DecodeMessage(lines[test.callLine], test.role)
			if err != nil {
				t.Fatal(err)
			}
			request, ok := message.(CallRequest)
			if !ok || request.Operation != OperationArmArwxShutdown ||
				request.ArwxShutdown.FinalMessageType != test.expectedType ||
				request.ArwxShutdown.FinalSequence != test.expectedSeq {
				t.Fatalf("decoded request = %#v", message)
			}
			response, err := marshalArmArwxShutdownResult(
				request.ID,
				armArwxShutdownResult(request.ArwxShutdown),
			)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(response, lines[test.responseLine]) {
				t.Fatalf("response = %s, want %s", response, lines[test.responseLine])
			}
		})
	}
}

func TestArmArwxShutdownRejectsRoleAndFieldMutations(t *testing.T) {
	mutations := []struct {
		name   string
		mutate func(*ArmArwxShutdownV1)
	}{
		{name: "bootstrap", mutate: func(value *ArmArwxShutdownV1) { value.BootstrapID = "bad" }},
		{name: "shutdown", mutate: func(value *ArmArwxShutdownV1) { value.ShutdownID = strings.ToUpper(value.ShutdownID) }},
		{name: "remaining zero", mutate: func(value *ArmArwxShutdownV1) { value.RemainingShutdownMS = 0 }},
		{name: "remaining maximum", mutate: func(value *ArmArwxShutdownV1) { value.RemainingShutdownMS = 105_001 }},
		{name: "message type", mutate: func(value *ArmArwxShutdownV1) { value.FinalMessageType = 15 }},
		{name: "sequence zero", mutate: func(value *ArmArwxShutdownV1) { value.FinalSequence = "0" }},
		{name: "sequence leading zero", mutate: func(value *ArmArwxShutdownV1) { value.FinalSequence = "01" }},
		{name: "sequence overflow", mutate: func(value *ArmArwxShutdownV1) { value.FinalSequence = "18446744073709551616" }},
		{name: "correlation", mutate: func(value *ArmArwxShutdownV1) { value.FinalCorrelationID = "00112233-4455-4677-8899-aabbccddeeff" }},
		{name: "frame minimum", mutate: func(value *ArmArwxShutdownV1) { value.FinalFrameBytes = 47 }},
		{name: "frame maximum", mutate: func(value *ArmArwxShutdownV1) { value.FinalFrameBytes = RuntimeBootstrapARWXMaximumFrameBytes + 1 }},
		{name: "digest", mutate: func(value *ArmArwxShutdownV1) { value.FinalFrameSHA256 = strings.Repeat("A", 64) }},
	}
	for _, test := range mutations {
		t.Run(test.name, func(t *testing.T) {
			claim := armArwxShutdownClaim(RoleControl)
			test.mutate(&claim)
			binding := committedRuntimeBootstrapBinding{
				role: RoleControl, bootstrapID: armArwxShutdownClaim(RoleControl).BootstrapID,
				maximumFrameBytes:          RuntimeBootstrapARWXMaximumFrameBytes,
				maximumRemainingShutdownMS: 105_000,
			}
			if err := validateArmArwxShutdownClaim(claim, binding); !errors.Is(err, ErrArwxShutdownInvalid) {
				t.Fatalf("validation error = %v", err)
			}
		})
	}

	executor := armArwxShutdownClaim(RoleExecutor)
	if err := validateArmArwxShutdownSyntax(executor, RoleExecutor, RuntimeBootstrapARWXMaximumFrameBytes, 105_000); err != nil {
		t.Fatalf("executor claim rejected: %v", err)
	}
	if err := validateArmArwxShutdownSyntax(executor, RoleControl, RuntimeBootstrapARWXMaximumFrameBytes, 105_000); !errors.Is(err, ErrArwxShutdownInvalid) {
		t.Fatalf("control accepted Executor final type: %v", err)
	}
}

func TestCommittedRuntimeBootstrapIsCopySafeAndChannelBound(t *testing.T) {
	firstServer, firstClient := net.Pipe()
	defer firstClient.Close()
	firstChannel := &armRuntimeBootstrapChannel{Conn: firstServer}
	committed := committedRuntimeBootstrapForArmTest(t, firstChannel, RoleControl)
	copyOfCommitted := committed
	options := defaultServerOptions()
	options.RuntimeBootstrap = committed
	server, err := NewServer(options, &fakeControlDispatcher{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewServer(optionsWithBootstrap(defaultServerOptions(), copyOfCommitted), &fakeControlDispatcher{}); !errors.Is(err, ErrInvalidServerOptions) {
		t.Fatalf("copied bootstrap reuse error = %v", err)
	}

	secondServer, secondClient := net.Pipe()
	defer secondServer.Close()
	defer secondClient.Close()
	wrongChannel := &armRuntimeBootstrapChannel{Conn: secondServer}
	if err := server.Serve(context.Background(), wrongChannel, wrongChannel); !errors.Is(err, ErrArwxShutdownUnavailable) {
		t.Fatalf("wrong channel Serve error = %v", err)
	}
}

func TestServerArmsBothRolesAndStoresAcknowledgedEvidence(t *testing.T) {
	lines := armArwxShutdownGoldenLines(t)
	for _, test := range []struct {
		name         string
		role         Role
		callLine     int
		responseLine int
	}{
		{name: "control", role: RoleControl, callLine: 0, responseLine: 1},
		{name: "executor", role: RoleExecutor, callLine: 2, responseLine: 3},
	} {
		t.Run(test.name, func(t *testing.T) {
			serverConn, clientConn := net.Pipe()
			channel := &armRuntimeBootstrapChannel{Conn: serverConn}
			options := defaultServerOptions()
			options.Role = test.role
			options.RuntimeBootstrap = committedRuntimeBootstrapForArmTest(t, channel, test.role)
			var dispatcher ControlDispatcher
			if test.role == RoleControl {
				dispatcher = &fakeControlDispatcher{}
			}
			server, err := NewServer(options, dispatcher)
			if err != nil {
				t.Fatal(err)
			}
			served := make(chan error, 1)
			go func() { served <- server.Serve(context.Background(), channel, channel) }()
			if err := WriteFrame(clientConn, lines[test.callLine], MaximumArmArwxShutdownBytes); err != nil {
				t.Fatal(err)
			}
			response, err := ReadFrame(clientConn, MaximumArmArwxShutdownBytes)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(response, lines[test.responseLine]) {
				t.Fatalf("response = %s", response)
			}
			var authorization ArwxShutdownAuthorization
			var ok bool
			for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); {
				authorization, ok = server.ArwxShutdownAuthorization()
				if ok {
					break
				}
				time.Sleep(time.Millisecond)
			}
			if !ok || authorization.state == nil {
				t.Fatal("acknowledged authorization evidence is unavailable")
			}
			authorization.state.mu.Lock()
			valid := authorization.state.acknowledged && !authorization.state.failed
			authorization.state.mu.Unlock()
			if !valid {
				t.Fatal("authorization evidence is not acknowledged")
			}
			_ = clientConn.Close()
			select {
			case err := <-served:
				if err != nil {
					t.Fatalf("Serve returned %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("Serve did not accept clean armed EOF")
			}
		})
	}
}

func TestSessionStateRejectsArmDuringWorkAndAllRequestsAfterArm(t *testing.T) {
	state := newSessionState(10)
	requestContext, cancel, accepted := state.start(context.Background(), "request:1", 1, time.Second)
	if !accepted || requestContext == nil {
		t.Fatal("business request did not start")
	}
	if err := state.beginShutdownArm(context.Background(), time.Now().Add(time.Second)); !errors.Is(err, ErrArwxShutdownActive) {
		t.Fatalf("active Arm error = %v", err)
	}
	if !state.shutdownStarted() {
		t.Fatal("failed Arm attempt did not make the lifecycle terminal")
	}
	cancel(nil)
	state.finishDispatch("request:1")
	state.complete()
	if err := state.beginShutdownArm(context.Background(), time.Now().Add(time.Second)); !errors.Is(err, ErrArwxShutdownArmed) {
		t.Fatalf("repeated Arm error = %v", err)
	}
}

func TestSessionStateWaitsForCompletedResponseAccountingBeforeArm(t *testing.T) {
	state := newSessionState(10)
	_, cancel, accepted := state.start(context.Background(), "request:1", 1, time.Second)
	if !accepted {
		t.Fatal("business request did not start")
	}
	state.finishDispatch("request:1")
	armed := make(chan error, 1)
	go func() {
		armed <- state.beginShutdownArm(context.Background(), time.Now().Add(time.Second))
	}()
	select {
	case err := <-armed:
		t.Fatalf("Arm returned before response accounting completed: %v", err)
	case <-time.After(10 * time.Millisecond):
	}
	state.complete()
	cancel(nil)
	select {
	case err := <-armed:
		if err != nil {
			t.Fatalf("Arm rejected completed response accounting: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Arm did not observe completed response accounting")
	}
}

func TestArmAuthorizationIsStoredBeforeAckAndBecomesValidOnlyAfterAck(t *testing.T) {
	serverConn, clientConn := net.Pipe()
	defer serverConn.Close()
	defer clientConn.Close()
	channel := &armRuntimeBootstrapChannel{Conn: serverConn}
	committed := committedRuntimeBootstrapForArmTest(t, channel, RoleControl)
	binding, err := consumeCommittedRuntimeBootstrap(committed, RoleControl)
	if err != nil {
		t.Fatal(err)
	}
	gate := &arwxShutdownGate{binding: binding, serveBound: true}
	claim := armArwxShutdownClaim(RoleControl)
	_, authorization, err := gate.prepare(claim, time.Now().Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := gate.authorizationEvidence(); ok {
		t.Fatal("authorization became valid before its response acknowledgement")
	}
	if !markArwxShutdownAcknowledged(authorization) {
		t.Fatal("authorization acknowledgement was rejected")
	}
	if evidence, ok := gate.authorizationEvidence(); !ok || evidence.state != authorization.state {
		t.Fatal("acknowledged authorization evidence is unavailable")
	}
	if _, _, err := gate.prepare(claim, time.Now().Add(time.Second)); !errors.Is(err, ErrArwxShutdownUnavailable) {
		t.Fatalf("repeated gate prepare error = %v", err)
	}
	failArwxShutdownAuthorization(authorization)
	if _, ok := gate.authorizationEvidence(); ok {
		t.Fatal("failed authorization evidence remained usable")
	}
}

func TestArmedSessionExpiresBeforePeerEOFAndInvalidatesEvidence(t *testing.T) {
	serverConn, clientConn := net.Pipe()
	defer clientConn.Close()
	channel := &armRuntimeBootstrapChannel{Conn: serverConn}
	options := defaultServerOptions()
	options.RuntimeBootstrap = committedRuntimeBootstrapForArmTest(t, channel, RoleControl)
	server, err := NewServer(options, &fakeControlDispatcher{})
	if err != nil {
		t.Fatal(err)
	}
	claim := armArwxShutdownClaim(RoleControl)
	claim.RemainingShutdownMS = 250
	request := callDocument(t, "shutdown:deadline", OperationArmArwxShutdown, map[string]any{
		"bootstrapId": claim.BootstrapID, "shutdownId": claim.ShutdownID,
		"remainingShutdownMs": claim.RemainingShutdownMS, "finalMessageType": claim.FinalMessageType,
		"finalSequence": claim.FinalSequence, "finalCorrelationId": claim.FinalCorrelationID,
		"finalFrameBytes": claim.FinalFrameBytes, "finalFrameSha256": claim.FinalFrameSHA256,
	})
	served := make(chan error, 1)
	go func() { served <- server.Serve(context.Background(), channel, channel) }()
	if err := WriteFrame(clientConn, request, MaximumArmArwxShutdownBytes); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadFrame(clientConn, MaximumArmArwxShutdownBytes); err != nil {
		t.Fatal(err)
	}
	authorizationVisible := false
	for deadline := time.Now().Add(100 * time.Millisecond); time.Now().Before(deadline); {
		if _, ok := server.ArwxShutdownAuthorization(); ok {
			authorizationVisible = true
			break
		}
		time.Sleep(time.Millisecond)
	}
	if !authorizationVisible {
		t.Fatal("authorization was unavailable immediately after acknowledgement")
	}
	select {
	case err := <-served:
		if !errors.Is(err, ErrIOTimeout) {
			t.Fatalf("Serve error = %v, want ErrIOTimeout", err)
		}
	case <-time.After(time.Second):
		t.Fatal("armed session did not stop at its absolute deadline")
	}
	if _, ok := server.ArwxShutdownAuthorization(); ok {
		t.Fatal("expired authorization evidence remained usable")
	}
}

type armRuntimeBootstrapChannel struct {
	net.Conn
}

func (channel *armRuntimeBootstrapChannel) ReadContext(ctx context.Context, buffer []byte) (int, error) {
	if cause := context.Cause(ctx); cause != nil {
		return 0, cause
	}
	return channel.Read(buffer)
}

func (channel *armRuntimeBootstrapChannel) WriteContext(ctx context.Context, buffer []byte) (int, error) {
	if cause := context.Cause(ctx); cause != nil {
		return 0, cause
	}
	return channel.Write(buffer)
}

func committedRuntimeBootstrapForArmTest(
	t *testing.T,
	channel RuntimeBootstrapChannel,
	role Role,
) CommittedRuntimeBootstrap {
	t.Helper()
	options := validRuntimeBootstrapOptions()
	options.Role = role
	bootstrap, err := NewRuntimeBootstrap(options)
	if err != nil {
		t.Fatal(err)
	}
	document, err := EncodeRuntimeBootstrap(bootstrap)
	if err != nil {
		t.Fatal(err)
	}
	return CommittedRuntimeBootstrap{state: &committedRuntimeBootstrapState{
		channel: channel, bootstrap: bootstrap, digest: sha256.Sum256(document),
	}}
}

func optionsWithBootstrap(
	options ServerOptions,
	committed CommittedRuntimeBootstrap,
) ServerOptions {
	options.RuntimeBootstrap = committed
	return options
}

func armArwxShutdownClaim(role Role) ArmArwxShutdownV1 {
	messageType := ArmArwxShutdownControlFinalMessageType
	if role == RoleExecutor {
		messageType = ArmArwxShutdownExecutorFinalMessageType
	}
	return ArmArwxShutdownV1{
		BootstrapID:         "123e4567-e89b-42d3-a456-426614174000",
		ShutdownID:          "00112233-4455-4677-8899-aabbccddeeff",
		RemainingShutdownMS: 105_000,
		FinalMessageType:    messageType,
		FinalSequence:       "18446744073709551615",
		FinalCorrelationID:  armArwxShutdownNilCorrelationID,
		FinalFrameBytes:     512,
		FinalFrameSHA256:    strings.Repeat("a", 64),
	}
}

func armArwxShutdownGoldenLines(t *testing.T) [][]byte {
	t.Helper()
	document, err := os.ReadFile("testdata/arm_arwx_shutdown_v1.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	lines := bytes.Split(bytes.TrimSpace(document), []byte{'\n'})
	if len(lines) != 4 {
		t.Fatalf("golden line count = %d", len(lines))
	}
	for _, line := range lines {
		if _, err := ParseCanonicalJSON(line, MaximumArmArwxShutdownBytes); err != nil {
			t.Fatalf("golden is not canonical: %v", err)
		}
	}
	return lines
}
