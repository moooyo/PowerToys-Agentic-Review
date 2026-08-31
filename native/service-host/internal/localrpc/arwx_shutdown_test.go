package localrpc

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"net"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	arwxframing "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/framing"
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

func TestServerArmsBothRolesAndAcceptsOrderlyHostControlEOF(t *testing.T) {
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

func TestAuthorizeArwxEOFRejectsEarlyEOFAndPermanentlyPoisonsGate(t *testing.T) {
	server, claim, frame := arwxEOFServerForTest(t, RoleControl)
	if _, err := server.AuthorizeArwxEOF(nil, frame); err == nil {
		t.Fatal("nil authorization context was accepted")
	}
	if _, err := server.AuthorizeArwxEOF(context.Background(), frame); !errors.Is(err, ErrArwxShutdownUnavailable) {
		t.Fatalf("pre-prepare EOF error = %v", err)
	}
	if _, _, err := server.shutdown.prepare(claim, time.Now().Add(time.Second)); !errors.Is(err, ErrArwxShutdownUnavailable) {
		t.Fatalf("Arm after pre-prepare EOF error = %v", err)
	}
	if _, err := server.AuthorizeArwxEOF(context.Background(), frame); !errors.Is(err, ErrArwxShutdownUnavailable) {
		t.Fatalf("replayed early EOF error = %v", err)
	}
}

func TestAuthorizeArwxEOFWaitsForPendingAcknowledgement(t *testing.T) {
	server, authorization, frame, deadline := preparedArwxEOFServerForTest(t, RoleControl)
	type result struct {
		deadline time.Time
		err      error
	}
	done := make(chan result, 1)
	go func() {
		got, err := server.AuthorizeArwxEOF(context.Background(), frame)
		done <- result{deadline: got, err: err}
	}()
	waitForArwxAuthorizationConsumed(t, authorization)
	select {
	case value := <-done:
		t.Fatalf("authorization returned before ACK settlement: %+v", value)
	default:
	}
	if !markArwxShutdownAcknowledged(authorization) {
		t.Fatal("authorization acknowledgement was rejected")
	}
	select {
	case value := <-done:
		if value.err != nil || !value.deadline.Equal(deadline) {
			t.Fatalf("pending authorization result = %+v, want deadline %v", value, deadline)
		}
	case <-time.After(time.Second):
		t.Fatal("authorization did not observe ACK settlement")
	}
}

func TestAuthorizeArwxEOFConsumesSuccessfulAuthorizationForBothRoles(t *testing.T) {
	for _, role := range []Role{RoleControl, RoleExecutor} {
		t.Run(string(role), func(t *testing.T) {
			server, authorization, frame, deadline := preparedArwxEOFServerForTest(t, role)
			if !markArwxShutdownAcknowledged(authorization) {
				t.Fatal("authorization acknowledgement was rejected")
			}
			got, err := server.AuthorizeArwxEOF(context.Background(), frame)
			if err != nil || !got.Equal(deadline) {
				t.Fatalf("authorization = (%v, %v), want (%v, nil)", got, err, deadline)
			}
			if _, err := server.AuthorizeArwxEOF(context.Background(), bytes.Clone(frame)); !errors.Is(err, ErrArwxShutdownUnavailable) {
				t.Fatalf("replayed authorization error = %v", err)
			}
		})
	}
}

func TestAuthorizeArwxEOFRejectsFinalFrameMutationsAndConsumesFailure(t *testing.T) {
	tests := []struct {
		name   string
		mutate func([]byte) []byte
	}{
		{name: "magic", mutate: func(value []byte) []byte { value[0] = 'X'; return value }},
		{name: "message type", mutate: func(value []byte) []byte {
			binary.LittleEndian.PutUint16(value[10:12], ArmArwxShutdownExecutorFinalMessageType)
			return value
		}},
		{name: "sequence", mutate: func(value []byte) []byte {
			binary.LittleEndian.PutUint64(value[20:28], binary.LittleEndian.Uint64(value[20:28])+1)
			return value
		}},
		{name: "correlation", mutate: func(value []byte) []byte { value[28] = 1; return value }},
		{name: "payload", mutate: func(value []byte) []byte { value[len(value)-1] ^= 1; return value }},
		{name: "truncated", mutate: func(value []byte) []byte { return value[:len(value)-1] }},
		{name: "trailing", mutate: func(value []byte) []byte { return append(value, 0) }},
		{name: "oversized", mutate: func([]byte) []byte {
			return make([]byte, RuntimeBootstrapARWXMaximumFrameBytes+1)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server, authorization, frame, _ := preparedArwxEOFServerForTest(t, RoleControl)
			if !markArwxShutdownAcknowledged(authorization) {
				t.Fatal("authorization acknowledgement was rejected")
			}
			mutated := test.mutate(bytes.Clone(frame))
			if _, err := server.AuthorizeArwxEOF(context.Background(), mutated); !errors.Is(err, ErrArwxShutdownInvalid) {
				t.Fatalf("mutated final frame error = %v", err)
			}
			authorization.mu.Lock()
			consumed, failed := authorization.consumed, authorization.failed
			authorization.mu.Unlock()
			if !consumed || !failed {
				t.Fatalf("failed state = consumed:%t failed:%t", consumed, failed)
			}
			if _, err := server.AuthorizeArwxEOF(context.Background(), frame); !errors.Is(err, ErrArwxShutdownUnavailable) {
				t.Fatalf("valid replay after mutation error = %v", err)
			}
		})
	}
}

func TestAuthorizeArwxEOFAllowsOnlyOneConcurrentFrameCopy(t *testing.T) {
	server, authorization, frame, deadline := preparedArwxEOFServerForTest(t, RoleControl)
	if !markArwxShutdownAcknowledged(authorization) {
		t.Fatal("authorization acknowledgement was rejected")
	}
	const callers = 16
	type result struct {
		deadline time.Time
		err      error
	}
	start := make(chan struct{})
	results := make(chan result, callers)
	for range callers {
		go func() {
			<-start
			got, err := server.AuthorizeArwxEOF(context.Background(), bytes.Clone(frame))
			results <- result{deadline: got, err: err}
		}()
	}
	close(start)
	successes := 0
	for range callers {
		value := <-results
		if value.err == nil {
			successes++
			if !value.deadline.Equal(deadline) {
				t.Fatalf("successful deadline = %v, want %v", value.deadline, deadline)
			}
			continue
		}
		if !errors.Is(value.err, ErrArwxShutdownUnavailable) {
			t.Fatalf("concurrent replay error = %v", value.err)
		}
	}
	if successes != 1 {
		t.Fatalf("successful concurrent authorizations = %d, want 1", successes)
	}
}

func TestAuthorizeArwxEOFCancellationFailsPendingAuthorization(t *testing.T) {
	server, authorization, frame, _ := preparedArwxEOFServerForTest(t, RoleControl)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := server.AuthorizeArwxEOF(ctx, frame)
		done <- err
	}()
	waitForArwxAuthorizationConsumed(t, authorization)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled authorization error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled authorization did not return")
	}
	if markArwxShutdownAcknowledged(authorization) {
		t.Fatal("cancelled authorization accepted a later acknowledgement")
	}
	if _, err := server.AuthorizeArwxEOF(context.Background(), frame); !errors.Is(err, ErrArwxShutdownUnavailable) {
		t.Fatalf("cancelled authorization replay error = %v", err)
	}
}

func TestAuthorizeArwxEOFRejectsExpiredAndNonOrderlyAuthorization(t *testing.T) {
	t.Run("expired", func(t *testing.T) {
		server, authorization, frame, _ := preparedArwxEOFServerForTest(t, RoleControl)
		if !markArwxShutdownAcknowledged(authorization) {
			t.Fatal("authorization acknowledgement was rejected")
		}
		authorization.mu.Lock()
		authorization.deadline = time.Now().Add(-time.Second)
		authorization.mu.Unlock()
		if _, err := server.AuthorizeArwxEOF(context.Background(), frame); !errors.Is(err, ErrIOTimeout) {
			t.Fatalf("expired authorization error = %v", err)
		}
	})

	t.Run("non-orderly", func(t *testing.T) {
		server, authorization, frame, _ := preparedArwxEOFServerForTest(t, RoleControl)
		if !markArwxShutdownAcknowledged(authorization) {
			t.Fatal("authorization acknowledgement was rejected")
		}
		server.shutdown.failCurrentAuthorization()
		if _, err := server.AuthorizeArwxEOF(context.Background(), frame); !errors.Is(err, ErrArwxShutdownUnavailable) {
			t.Fatalf("non-orderly authorization error = %v", err)
		}
	})
}

func TestArmedSessionExpiresBeforePeerEOFAndInvalidatesAuthorization(t *testing.T) {
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
	select {
	case err := <-served:
		if !errors.Is(err, ErrIOTimeout) {
			t.Fatalf("Serve error = %v, want ErrIOTimeout", err)
		}
	case <-time.After(time.Second):
		t.Fatal("armed session did not stop at its absolute deadline")
	}
	if _, err := server.AuthorizeArwxEOF(context.Background(), make([]byte, claim.FinalFrameBytes)); err == nil {
		t.Fatal("expired authorization remained usable")
	}
}

func arwxEOFServerForTest(
	t *testing.T,
	role Role,
) (*Server, ArmArwxShutdownV1, []byte) {
	t.Helper()
	serverConn, clientConn := net.Pipe()
	t.Cleanup(func() {
		_ = serverConn.Close()
		_ = clientConn.Close()
	})
	channel := &armRuntimeBootstrapChannel{Conn: serverConn}
	options := defaultServerOptions()
	options.Role = role
	options.RuntimeBootstrap = committedRuntimeBootstrapForArmTest(t, channel, role)
	var dispatcher ControlDispatcher
	if role == RoleControl {
		dispatcher = &fakeControlDispatcher{}
	}
	server, err := NewServer(options, dispatcher)
	if err != nil {
		t.Fatal(err)
	}
	if err := server.shutdown.bindServeStreams(channel, channel); err != nil {
		t.Fatal(err)
	}
	const sequence = uint64(17)
	frame := armArwxFinalFrame(role, sequence, []byte("final-frame"))
	digest := sha256.Sum256(frame)
	claim := armArwxShutdownClaim(role)
	claim.FinalSequence = strconv.FormatUint(sequence, 10)
	claim.FinalFrameBytes = len(frame)
	claim.FinalFrameSHA256 = hex.EncodeToString(digest[:])
	return server, claim, frame
}

func preparedArwxEOFServerForTest(
	t *testing.T,
	role Role,
) (*Server, *arwxShutdownAuthorizationState, []byte, time.Time) {
	t.Helper()
	server, claim, frame := arwxEOFServerForTest(t, role)
	deadline := time.Now().Add(time.Second)
	_, authorization, err := server.shutdown.prepare(claim, deadline)
	if err != nil {
		t.Fatal(err)
	}
	return server, authorization, frame, deadline
}

func waitForArwxAuthorizationConsumed(t *testing.T, authorization *arwxShutdownAuthorizationState) {
	t.Helper()
	for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); {
		authorization.mu.Lock()
		consumed := authorization.consumed
		authorization.mu.Unlock()
		if consumed {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("authorization was not consumed")
}

func armArwxFinalFrame(role Role, sequence uint64, payload []byte) []byte {
	messageType := ArmArwxShutdownControlFinalMessageType
	if role == RoleExecutor {
		messageType = ArmArwxShutdownExecutorFinalMessageType
	}
	frame := make([]byte, arwxframing.HeaderBytes+len(payload))
	copy(frame[0:4], arwxframing.Magic)
	binary.LittleEndian.PutUint16(frame[4:6], arwxframing.HeaderBytes)
	binary.LittleEndian.PutUint16(frame[6:8], arwxframing.MajorVersion)
	binary.LittleEndian.PutUint16(frame[8:10], arwxframing.MinorVersion)
	binary.LittleEndian.PutUint16(frame[10:12], uint16(messageType))
	binary.LittleEndian.PutUint32(frame[16:20], uint32(len(payload)))
	binary.LittleEndian.PutUint64(frame[20:28], sequence)
	copy(frame[arwxframing.HeaderBytes:], payload)
	return frame
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
