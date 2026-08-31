//go:build windows

package winpipe

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"runtime"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/framing"
	"golang.org/x/sys/windows"
)

var retainedEndpointTestQuarantines []*endpointLifetimeQuarantine

func retainEndpointTestQuarantine(quarantine *endpointLifetimeQuarantine) {
	retainedEndpointTestQuarantines = append(retainedEndpointTestQuarantines, quarantine)
}

func endpointTestQuarantineOwners(quarantine *endpointLifetimeQuarantine) []any {
	quarantine.mu.RLock()
	defer quarantine.mu.RUnlock()
	return append([]any(nil), quarantine.owners...)
}

func testEndpointFrame(payload []byte) []byte {
	value := make([]byte, framing.HeaderBytes+len(payload))
	copy(value[0:4], framing.Magic)
	binary.LittleEndian.PutUint16(value[4:6], framing.HeaderBytes)
	binary.LittleEndian.PutUint16(value[6:8], framing.MajorVersion)
	binary.LittleEndian.PutUint16(value[8:10], framing.MinorVersion)
	binary.LittleEndian.PutUint16(value[10:12], 1)
	binary.LittleEndian.PutUint32(value[16:20], uint32(len(payload)))
	binary.LittleEndian.PutUint64(value[20:28], 1)
	copy(value[framing.HeaderBytes:], payload)
	return value
}

func testEndpointWithQuarantine(
	handle windows.Handle,
	maximumFrameBytes uint32,
	quarantine *endpointLifetimeQuarantine,
) *Endpoint {
	endpoint := newEndpoint(handle, endpointMetadata{
		pipeName:          `\\.\pipe\AgenticReview.Worker.ControlExecutor.v1`,
		maximumFrameBytes: maximumFrameBytes,
		connected:         true,
	})
	endpoint.state.quarantine = quarantine
	endpoint.state.cleanupGrace = time.Millisecond
	endpoint.state.closeGrace = 10 * time.Millisecond
	return endpoint
}

type relayEndpointContract interface {
	ReadFrame(context.Context) ([]byte, error)
	WriteFrame(context.Context, []byte) error
	Close() error
}

type gracefulServerEndpointContract interface {
	FlushThenClose(context.Context) error
}

func TestWindowsEndpointLocalSideComesFromLivePrivateState(t *testing.T) {
	tests := []struct {
		name     string
		endpoint *Endpoint
		want     EndpointSide
		wantErr  error
	}{
		{name: "server", endpoint: &Endpoint{state: &endpointState{handle: 1, server: true}}, want: EndpointSideServer},
		{name: "client", endpoint: &Endpoint{state: &endpointState{handle: 1}}, want: EndpointSideClient},
		{name: "zero value", endpoint: &Endpoint{}, wantErr: ErrClosed},
		{name: "closed", endpoint: &Endpoint{state: &endpointState{handle: 1, closed: true}}, wantErr: ErrClosed},
		{name: "nil", endpoint: nil, wantErr: ErrClosed},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := test.endpoint.LocalSide()
			if got != test.want || !errors.Is(err, test.wantErr) {
				t.Fatalf("LocalSide returned (%d, %v), want (%d, %v)", got, err, test.want, test.wantErr)
			}
		})
	}
}

func TestWindowsEndpointAttestationComesFromSharedLiveState(t *testing.T) {
	quarantine := &endpointLifetimeQuarantine{}
	closeCalls := 0
	endpoint := newEndpoint(111, endpointMetadata{
		pipeName:               `\\.\pipe\AgenticReview.Worker.ControlExecutor.v1`,
		maximumFrameBytes:      framing.MaximumFrameBytes,
		server:                 true,
		connected:              true,
		ownServiceSID:          testOwnServiceSID,
		peerServiceSID:         testServiceSID,
		serverSecurityVerified: true,
	})
	endpoint.state.quarantine = quarantine
	endpoint.state.disconnect = func(windows.Handle) error { return nil }
	endpoint.state.closeHandle = func(windows.Handle) error {
		closeCalls++
		return nil
	}
	copied := *endpoint

	want, err := endpoint.Attestation()
	if err != nil || !want.Valid() {
		t.Fatalf("original Attestation returned (%#v, %v)", want, err)
	}
	got, err := copied.Attestation()
	if err != nil || got != want {
		t.Fatalf("copied Attestation returned (%#v, %v), want %#v", got, err, want)
	}
	if got.PipeName() != `\\.\pipe\AgenticReview.Worker.ControlExecutor.v1` ||
		got.MaximumFrameBytes() != framing.MaximumFrameBytes ||
		got.LocalSide() != EndpointSideServer || !got.Connected() ||
		got.ValidatedOwnServiceSID() != testOwnServiceSID ||
		got.ValidatedPeerServiceSID() != testServiceSID || !got.ServerDACLValidated() {
		t.Fatalf("Attestation omitted endpoint evidence: %#v", got)
	}

	if err := copied.Close(); err != nil {
		t.Fatal(err)
	}
	if err := endpoint.Close(); err != nil {
		t.Fatalf("idempotent original Close returned %v", err)
	}
	if closeCalls != 1 {
		t.Fatalf("CloseHandle calls = %d, want 1", closeCalls)
	}
	for name, value := range map[string]*Endpoint{"original": endpoint, "copy": &copied} {
		if attestation, err := value.Attestation(); attestation.Valid() || !errors.Is(err, ErrClosed) {
			t.Fatalf("%s Attestation after copied Close returned (%#v, %v)", name, attestation, err)
		}
	}
}

func TestWindowsEndpointAttestationRejectsIncompleteAndFatalState(t *testing.T) {
	pipeName := `\\.\pipe\AgenticReview.Worker.ControlExecutor.v1`
	tests := []struct {
		name     string
		endpoint *Endpoint
		wantErr  error
	}{
		{name: "nil", endpoint: nil, wantErr: ErrClosed},
		{name: "zero", endpoint: &Endpoint{}, wantErr: ErrClosed},
		{
			name: "not connected",
			endpoint: newEndpoint(112, endpointMetadata{
				pipeName:          pipeName,
				maximumFrameBytes: framing.MaximumFrameBytes,
			}),
			wantErr: ErrClosed,
		},
		{
			name: "missing server DACL evidence",
			endpoint: newEndpoint(113, endpointMetadata{
				pipeName:          pipeName,
				maximumFrameBytes: framing.MaximumFrameBytes,
				server:            true,
				connected:         true,
				ownServiceSID:     testOwnServiceSID,
				peerServiceSID:    testServiceSID,
			}),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.endpoint != nil && test.endpoint.state != nil {
				test.endpoint.state.quarantine = &endpointLifetimeQuarantine{}
			}
			attestation, err := test.endpoint.Attestation()
			if attestation.Valid() || (test.wantErr != nil && !errors.Is(err, test.wantErr)) ||
				(test.wantErr == nil && err == nil) {
				t.Fatalf("Attestation returned (%#v, %v), want invalid and %v", attestation, err, test.wantErr)
			}
		})
	}

	quarantine := &endpointLifetimeQuarantine{}
	endpoint := newEndpoint(114, endpointMetadata{
		pipeName:          pipeName,
		maximumFrameBytes: framing.MaximumFrameBytes,
		connected:         true,
	})
	endpoint.state.quarantine = quarantine
	fatal := quarantine.retain(&endpointRawHandleOwner{kind: "test", value: 114}, errors.New("test fatal"))
	attestation, err := endpoint.Attestation()
	if attestation.Valid() || !errors.Is(err, ErrIOUnresolvedFatal) || !errors.Is(err, fatal) {
		t.Fatalf("Attestation after process fatal returned (%#v, %v)", attestation, err)
	}
}

func TestWindowsEndpointConnectCommitsAttestableConnectionState(t *testing.T) {
	for _, connectErr := range []error{nil, windows.ERROR_PIPE_CONNECTED} {
		t.Run(fmt.Sprint(connectErr), func(t *testing.T) {
			quarantine := &endpointLifetimeQuarantine{}
			endpoint := newEndpoint(115, endpointMetadata{
				pipeName:               `\\.\pipe\AgenticReview.Worker.ControlExecutor.v1`,
				maximumFrameBytes:      framing.MaximumFrameBytes,
				server:                 true,
				ownServiceSID:          testOwnServiceSID,
				peerServiceSID:         testServiceSID,
				serverSecurityVerified: true,
			})
			endpoint.state.quarantine = quarantine
			endpoint.state.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
				return 116, nil
			}
			endpoint.state.connectPipe = func(windows.Handle, *windows.Overlapped) error {
				return connectErr
			}
			endpoint.state.closeHandle = func(windows.Handle) error { return nil }
			if err := endpoint.connect(context.Background()); err != nil {
				t.Fatal(err)
			}
			attestation, err := endpoint.Attestation()
			if err != nil || !attestation.Valid() || !attestation.Connected() {
				t.Fatalf("Attestation after connect returned (%#v, %v)", attestation, err)
			}
		})
	}
}

func TestWindowsCreatedServerSecurityPolicyIsExact(t *testing.T) {
	if serverSecurityInformation != windows.OWNER_SECURITY_INFORMATION|
		windows.GROUP_SECURITY_INFORMATION|
		windows.DACL_SECURITY_INFORMATION {
		t.Fatalf("server security information flags = 0x%x", serverSecurityInformation)
	}
	valid := endpointSecurityEvidence{
		ownerSID:     testOwnServiceSID,
		groupSID:     testOwnServiceSID,
		present:      true,
		protected:    true,
		selfRelative: true,
		entries: []endpointDACLEntry{
			{sid: localSystemSID, mask: fileAllAccess, aceType: windows.ACCESS_ALLOWED_ACE_TYPE},
			{sid: builtinAdministratorsSID, mask: fileAllAccess, aceType: windows.ACCESS_ALLOWED_ACE_TYPE},
			{sid: testServiceSID, mask: peerAccessRights, aceType: windows.ACCESS_ALLOWED_ACE_TYPE},
		},
	}
	if evidence, err := validateCreatedServerSecurity(valid, testOwnServiceSID, testServiceSID); err != nil ||
		evidence.ownServiceSID != testOwnServiceSID ||
		evidence.peerServiceSID != testServiceSID || !evidence.protected {
		t.Fatalf("valid security descriptor returned (%#v, %v)", evidence, err)
	}

	tests := []struct {
		name   string
		mutate func(*endpointSecurityEvidence)
	}{
		{name: "missing owner", mutate: func(value *endpointSecurityEvidence) { value.ownerSID = "" }},
		{name: "wrong owner", mutate: func(value *endpointSecurityEvidence) { value.ownerSID = testServiceSID }},
		{name: "defaulted owner", mutate: func(value *endpointSecurityEvidence) { value.ownerDefaulted = true }},
		{name: "missing group", mutate: func(value *endpointSecurityEvidence) { value.groupSID = "" }},
		{name: "wrong group", mutate: func(value *endpointSecurityEvidence) { value.groupSID = testServiceSID }},
		{name: "defaulted group", mutate: func(value *endpointSecurityEvidence) { value.groupDefaulted = true }},
		{name: "not present", mutate: func(value *endpointSecurityEvidence) { value.present = false }},
		{name: "not protected", mutate: func(value *endpointSecurityEvidence) { value.protected = false }},
		{name: "not self relative", mutate: func(value *endpointSecurityEvidence) { value.selfRelative = false }},
		{name: "null", mutate: func(value *endpointSecurityEvidence) { value.null = true }},
		{name: "defaulted", mutate: func(value *endpointSecurityEvidence) { value.defaulted = true }},
		{name: "missing ACE", mutate: func(value *endpointSecurityEvidence) { value.entries = value.entries[:2] }},
		{name: "extra ACE", mutate: func(value *endpointSecurityEvidence) { value.entries = append(value.entries, value.entries[0]) }},
		{name: "duplicate ACE", mutate: func(value *endpointSecurityEvidence) { value.entries[2] = value.entries[0] }},
		{name: "wrong mask", mutate: func(value *endpointSecurityEvidence) { value.entries[2].mask++ }},
		{name: "wrong type", mutate: func(value *endpointSecurityEvidence) { value.entries[2].aceType = windows.ACCESS_DENIED_ACE_TYPE }},
		{name: "flags", mutate: func(value *endpointSecurityEvidence) { value.entries[2].aceFlags = windows.INHERITED_ACE }},
		{name: "unexpected SID", mutate: func(value *endpointSecurityEvidence) { value.entries[2].sid = "S-1-5-19" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := valid
			value.entries = append([]endpointDACLEntry(nil), valid.entries...)
			test.mutate(&value)
			if _, err := validateCreatedServerSecurity(value, testOwnServiceSID, testServiceSID); err == nil {
				t.Fatalf("invalid security descriptor was accepted: %#v", value)
			}
		})
	}
	if _, err := validateCreatedServerSecurity(valid, testServiceSID, testServiceSID); !errors.Is(err, ErrInvalidOptions) {
		t.Fatalf("duplicate own/peer SID returned %v", err)
	}
}

func TestWindowsInvalidServerSecurityReadbackHandleIsQuarantinedWithoutClose(t *testing.T) {
	quarantine := &endpointLifetimeQuarantine{}
	retainEndpointTestQuarantine(quarantine)
	closeCalls := 0
	err := rejectUnattestedServerHandle(
		117,
		fmt.Errorf("GetSecurityInfo: %w", windows.ERROR_INVALID_HANDLE),
		func(windows.Handle) error {
			closeCalls++
			return nil
		},
		quarantine,
	)
	if !errors.Is(err, windows.ERROR_INVALID_HANDLE) || !errors.Is(err, ErrIOUnresolvedFatal) {
		t.Fatalf("invalid readback handle returned %v", err)
	}
	owners := endpointTestQuarantineOwners(quarantine)
	if closeCalls != 0 || len(owners) != 1 {
		t.Fatalf("CloseHandle calls = %d, quarantine owners = %#v", closeCalls, owners)
	}
	owner, ok := owners[0].(*endpointRawHandleOwner)
	if !ok || owner.value != 117 {
		t.Fatalf("quarantine owner = %#v, want raw handle 117", owners[0])
	}
}

func TestWindowsCreatedServerSecurityParsesGeneratedDescriptor(t *testing.T) {
	descriptor, err := windows.SecurityDescriptorFromString(securityDescriptorString(testOwnServiceSID, testServiceSID))
	if err != nil {
		t.Fatal(err)
	}
	evidence, err := endpointSecurityEvidenceFromDescriptor(descriptor)
	runtime.KeepAlive(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := validateCreatedServerSecurity(evidence, testOwnServiceSID, testServiceSID); err != nil {
		t.Fatalf("generated descriptor did not satisfy readback policy: %v", err)
	}
}

func TestWindowsEndpointCopiesShareOneRawHandleOwner(t *testing.T) {
	closeCalls := 0
	var closedHandle windows.Handle
	endpoint := &Endpoint{state: &endpointState{
		handle: 123,
		cancelIO: func(windows.Handle, *windows.Overlapped) error {
			return nil
		},
		closeHandle: func(handle windows.Handle) error {
			closeCalls++
			closedHandle = handle
			return nil
		},
	}}
	copied := *endpoint
	if side, err := copied.LocalSide(); side != EndpointSideClient || err != nil {
		t.Fatalf("copied LocalSide returned (%d, %v)", side, err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	go func() {
		<-start
		results <- endpoint.Close()
	}()
	go func() {
		<-start
		results <- copied.Close()
	}()
	close(start)
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if closeCalls != 1 || closedHandle != 123 || endpoint.state.handle != 0 {
		t.Fatalf(
			"raw handle close calls = %d, closed handle = %d, retained handle = %d",
			closeCalls,
			closedHandle,
			endpoint.state.handle,
		)
	}
	if _, err := endpoint.LocalSide(); !errors.Is(err, ErrClosed) {
		t.Fatalf("original LocalSide after copied Close = %v", err)
	}
	if _, err := copied.GetNamedPipeClientProcessID(); !errors.Is(err, ErrClosed) {
		t.Fatalf("copied PID observation after Close = %v", err)
	}
}

func TestWindowsEndpointCompletionClassificationIsKindAware(t *testing.T) {
	for _, err := range []error{
		nil,
		windows.ERROR_OPERATION_ABORTED,
		windows.ERROR_BROKEN_PIPE,
		windows.ERROR_NO_DATA,
		windows.ERROR_PIPE_NOT_CONNECTED,
	} {
		if completed, got := classifyEndpointCompletion(endpointOperationWrite, err); !completed || !errors.Is(got, err) {
			t.Fatalf("terminal completion %v = (%v, %v)", err, completed, got)
		}
	}
	if completed, err := classifyEndpointCompletion(endpointOperationRead, windows.ERROR_MORE_DATA); !completed ||
		!errors.Is(err, windows.ERROR_MORE_DATA) {
		t.Fatalf("read ERROR_MORE_DATA = (%v, %v)", completed, err)
	}
	for _, kind := range []endpointOperationKind{endpointOperationConnect, endpointOperationWrite} {
		if completed, err := classifyEndpointCompletion(kind, windows.ERROR_MORE_DATA); completed ||
			!errors.Is(err, windows.ERROR_MORE_DATA) {
			t.Fatalf("non-read ERROR_MORE_DATA for kind %d = (%v, %v)", kind, completed, err)
		}
	}
	for _, err := range []error{
		windows.ERROR_IO_INCOMPLETE,
		windows.ERROR_INVALID_HANDLE,
		windows.ERROR_INVALID_PARAMETER,
		windows.ERROR_IO_PENDING,
	} {
		if completed, got := classifyEndpointCompletion(endpointOperationRead, err); completed || !errors.Is(got, err) {
			t.Fatalf("unknown completion %v = (%v, %v)", err, completed, got)
		}
	}
}

func TestWindowsEndpointRetryableOpenErrorWithHandleIsFatal(t *testing.T) {
	quarantine := &endpointLifetimeQuarantine{}
	handle, err := adoptEndpointHandleOutput("test client", 599, windows.ERROR_PIPE_BUSY, quarantine)
	if handle != 0 || !errors.Is(err, windows.ERROR_PIPE_BUSY) || !errors.Is(err, ErrIOUnresolvedFatal) ||
		quarantine.count() != 1 || quarantine.fatalError() == nil {
		t.Fatalf("adopt retryable output = handle:%d error:%v quarantine:%d", handle, err, quarantine.count())
	}
}

func TestWindowsEndpointConnectUsesPinnedHeapOperation(t *testing.T) {
	quarantine := &endpointLifetimeQuarantine{}
	endpoint := testEndpointWithQuarantine(600, framing.HeaderBytes, quarantine)
	endpoint.state.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
		return 601, nil
	}
	var operation *endpointOperation
	endpoint.state.connectPipe = func(_ windows.Handle, overlapped *windows.Overlapped) error {
		for candidate := range endpoint.state.operations {
			operation = candidate
		}
		if operation == nil || overlapped != &operation.overlapped || !operation.pinned {
			return errors.New("ConnectNamedPipe did not receive the pinned heap operation")
		}
		return windows.ERROR_IO_PENDING
	}
	endpoint.state.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
		return windows.WAIT_OBJECT_0, nil
	}
	endpoint.state.getOverlappedResult = func(_ windows.Handle, _ *windows.Overlapped, _ *uint32, wait bool) error {
		if wait {
			return errors.New("GetOverlappedResult used a blocking wait")
		}
		return nil
	}
	closeCalls := 0
	endpoint.state.closeHandle = func(handle windows.Handle) error {
		closeCalls++
		if handle != 601 {
			return errors.New("unexpected event handle")
		}
		return nil
	}
	if err := endpoint.connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	if operation == nil || operation.pinned || closeCalls != 1 || quarantine.count() != 0 ||
		!endpoint.state.active.wait(time.Millisecond) {
		t.Fatalf("operation=%#v close=%d quarantine=%d", operation, closeCalls, quarantine.count())
	}
}

func TestWindowsEndpointReadUsesPinnedInternalBufferAndPublishesAfterCompletion(t *testing.T) {
	frame := testEndpointFrame([]byte("payload"))
	quarantine := &endpointLifetimeQuarantine{}
	endpoint := testEndpointWithQuarantine(700, uint32(len(frame)), quarantine)
	endpoint.state.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
		return 701, nil
	}
	var operation *endpointOperation
	endpoint.state.readFile = func(_ windows.Handle, kernel []byte, _ *uint32, overlapped *windows.Overlapped) error {
		for candidate := range endpoint.state.operations {
			operation = candidate
		}
		if operation == nil || overlapped != &operation.overlapped || !operation.pinned {
			return errors.New("ReadFile did not receive the pinned heap operation")
		}
		copy(kernel, frame)
		return windows.ERROR_IO_PENDING
	}
	endpoint.state.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
		runtime.GC()
		return windows.WAIT_OBJECT_0, nil
	}
	endpoint.state.getOverlappedResult = func(_ windows.Handle, _ *windows.Overlapped, transferred *uint32, wait bool) error {
		if wait {
			return errors.New("GetOverlappedResult used a blocking wait")
		}
		*transferred = uint32(len(frame))
		return nil
	}
	closeCalls := 0
	endpoint.state.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
	value, err := endpoint.ReadFrame(context.Background())
	if err != nil || !bytes.Equal(value, frame) {
		t.Fatalf("ReadFrame = (%x, %v)", value, err)
	}
	value[0] ^= 0xff
	if bytes.Equal(value, frame) {
		t.Fatal("ReadFrame returned an aliased internal buffer")
	}
	if operation == nil || operation.pinned || closeCalls != 1 || quarantine.count() != 0 ||
		!endpoint.state.active.wait(time.Millisecond) {
		t.Fatalf("operation=%#v close=%d quarantine=%d", operation, closeCalls, quarantine.count())
	}
}

func TestWindowsEndpointReadReturnsOnlyExactCleanEOF(t *testing.T) {
	quarantine := &endpointLifetimeQuarantine{}
	endpoint := testEndpointWithQuarantine(705, framing.HeaderBytes, quarantine)
	endpoint.state.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
		return 706, nil
	}
	endpoint.state.readFile = func(windows.Handle, []byte, *uint32, *windows.Overlapped) error {
		return windows.ERROR_BROKEN_PIPE
	}
	closedEvents := 0
	endpoint.state.closeHandle = func(handle windows.Handle) error {
		if handle != 706 {
			return errors.New("clean EOF closed the pipe handle")
		}
		closedEvents++
		return nil
	}
	value, err := endpoint.ReadFrame(context.Background())
	if value != nil || err != io.EOF || !errors.Is(err, io.EOF) {
		t.Fatalf("clean EOF returned (%x, %T %v), want exact io.EOF", value, err, err)
	}
	if closedEvents != 1 || quarantine.count() != 0 || endpoint.state.terminal != nil {
		t.Fatalf("clean EOF event closes=%d quarantine=%d terminal=%v", closedEvents, quarantine.count(), endpoint.state.terminal)
	}
}

func TestWindowsEndpointCleanEOFClassifierRejectsWrappedOrJoinedErrors(t *testing.T) {
	for _, err := range []error{
		fmt.Errorf("wrapped: %w", windows.ERROR_BROKEN_PIPE),
		errors.Join(windows.ERROR_BROKEN_PIPE),
		errors.Join(windows.ERROR_BROKEN_PIPE, context.Canceled),
	} {
		if isExactNamedPipeReadEOF(err) {
			t.Fatalf("classified %T %v as an exact clean EOF", err, err)
		}
	}
	for _, err := range []error{
		windows.ERROR_BROKEN_PIPE,
		windows.ERROR_NO_DATA,
		windows.ERROR_PIPE_NOT_CONNECTED,
	} {
		if !isExactNamedPipeReadEOF(err) {
			t.Fatalf("rejected exact clean EOF %v", err)
		}
	}
}

func TestWindowsEndpointTerminalReadPreservesFatalEventCleanupError(t *testing.T) {
	for _, completionErr := range []error{windows.ERROR_MORE_DATA, windows.ERROR_BROKEN_PIPE} {
		t.Run(completionErr.Error(), func(t *testing.T) {
			quarantine := &endpointLifetimeQuarantine{}
			endpoint := testEndpointWithQuarantine(710, framing.HeaderBytes, quarantine)
			endpoint.state.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
				return 711, nil
			}
			var operation *endpointOperation
			endpoint.state.readFile = func(windows.Handle, []byte, *uint32, *windows.Overlapped) error {
				for candidate := range endpoint.state.operations {
					operation = candidate
				}
				return windows.ERROR_IO_PENDING
			}
			endpoint.state.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
				return windows.WAIT_OBJECT_0, nil
			}
			endpoint.state.getOverlappedResult = func(windows.Handle, *windows.Overlapped, *uint32, bool) error {
				return completionErr
			}
			closeFailure := errors.New("event close failed")
			closeCalls := 0
			endpoint.state.closeHandle = func(windows.Handle) error {
				closeCalls++
				return closeFailure
			}
			_, err := endpoint.ReadFrame(context.Background())
			if !errors.Is(err, completionErr) || !errors.Is(err, closeFailure) ||
				!errors.Is(err, ErrIOUnresolvedFatal) {
				t.Fatalf("terminal read error = %v", err)
			}
			if err == io.EOF {
				t.Fatal("read with a cleanup failure returned the exact EOF sentinel")
			}
			if errors.Is(completionErr, windows.ERROR_MORE_DATA) && !errors.Is(err, framing.ErrFrameTooLarge) {
				t.Fatalf("ERROR_MORE_DATA lost frame-too-large classification: %v", err)
			}
			owners := endpointTestQuarantineOwners(quarantine)
			if operation == nil || operation.pinned || closeCalls != 1 || len(owners) != 2 || owners[1] != operation {
				t.Fatalf("operation=%#v close=%d owners=%v", operation, closeCalls, owners)
			}
		})
	}
}

func TestWindowsEndpointWriteClonesCallerBeforeSubmission(t *testing.T) {
	caller := testEndpointFrame([]byte("payload"))
	original := bytes.Clone(caller)
	quarantine := &endpointLifetimeQuarantine{}
	endpoint := testEndpointWithQuarantine(720, uint32(len(caller)), quarantine)
	endpoint.state.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
		return 721, nil
	}
	endpoint.state.writeFile = func(_ windows.Handle, kernel []byte, _ *uint32, _ *windows.Overlapped) error {
		if &kernel[0] == &caller[0] || !bytes.Equal(kernel, original) {
			return errors.New("WriteFile did not receive an independent caller snapshot")
		}
		caller[0] ^= 0xff
		if !bytes.Equal(kernel, original) {
			return errors.New("caller mutation changed the submitted buffer")
		}
		return windows.ERROR_IO_PENDING
	}
	endpoint.state.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
		return windows.WAIT_OBJECT_0, nil
	}
	endpoint.state.getOverlappedResult = func(_ windows.Handle, _ *windows.Overlapped, transferred *uint32, wait bool) error {
		if wait {
			return errors.New("GetOverlappedResult used a blocking wait")
		}
		*transferred = uint32(len(original))
		return nil
	}
	endpoint.state.closeHandle = func(windows.Handle) error { return nil }
	if err := endpoint.WriteFrame(context.Background(), caller); err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(caller, original) || quarantine.count() != 0 {
		t.Fatalf("caller mutation or quarantine contract failed: caller=%x quarantine=%d", caller, quarantine.count())
	}
}

func TestWindowsEndpointUnknownCompletionStaysPinnedAndCloseIsBounded(t *testing.T) {
	caller := testEndpointFrame([]byte("payload"))
	original := bytes.Clone(caller)
	quarantine := &endpointLifetimeQuarantine{}
	retainEndpointTestQuarantine(quarantine)
	endpoint := testEndpointWithQuarantine(800, uint32(len(caller)), quarantine)
	endpoint.state.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
		return 801, nil
	}
	var operation *endpointOperation
	var kernelPointer *byte
	var overlappedPointer *windows.Overlapped
	endpoint.state.writeFile = func(_ windows.Handle, kernel []byte, _ *uint32, overlapped *windows.Overlapped) error {
		for candidate := range endpoint.state.operations {
			operation = candidate
		}
		kernelPointer = &kernel[0]
		overlappedPointer = overlapped
		if &kernel[0] == &caller[0] {
			return errors.New("quarantined write references caller storage")
		}
		caller[0] ^= 0xff
		return windows.ERROR_IO_PENDING
	}
	endpoint.state.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
		return windows.WAIT_OBJECT_0, nil
	}
	endpoint.state.getOverlappedResult = func(windows.Handle, *windows.Overlapped, *uint32, bool) error {
		return windows.ERROR_IO_INCOMPLETE
	}
	closeCalls := 0
	endpoint.state.closeHandle = func(windows.Handle) error { closeCalls++; return nil }

	err := endpoint.WriteFrame(context.Background(), caller)
	if !errors.Is(err, windows.ERROR_IO_INCOMPLETE) || !errors.Is(err, ErrIOUnresolvedFatal) {
		t.Fatalf("unknown WriteFrame error = %v", err)
	}
	owners := endpointTestQuarantineOwners(quarantine)
	if operation == nil || kernelPointer != &operation.buffer[0] || overlappedPointer != &operation.overlapped ||
		len(owners) != 1 || owners[0] != operation || !operation.pinned || operation.completed || !operation.quarantined ||
		closeCalls != 0 || quarantine.count() != 1 || bytes.Equal(caller, original) ||
		!bytes.Equal(operation.buffer, original) {
		t.Fatalf(
			"operation=%#v close=%d quarantine=%d caller=%x buffer=%x",
			operation,
			closeCalls,
			quarantine.count(),
			caller,
			operation.buffer,
		)
	}
	if _, registered := endpoint.state.operations[operation]; !registered {
		t.Fatal("unknown operation was removed from the endpoint")
	}
	if endpoint.state.active.wait(time.Millisecond) {
		t.Fatal("unknown operation released its activity")
	}

	copied := *endpoint
	closeResult := make(chan error, 1)
	go func() { closeResult <- copied.Close() }()
	select {
	case closeErr := <-closeResult:
		if !errors.Is(closeErr, ErrIOUnresolvedFatal) {
			t.Fatalf("Close after unknown completion = %v", closeErr)
		}
	case <-time.After(time.Second):
		t.Fatal("Close blocked behind an unresolved operation")
	}
	if closeCalls != 0 {
		t.Fatalf("Close touched quarantined handles %d times", closeCalls)
	}
	if _, sideErr := endpoint.LocalSide(); !errors.Is(sideErr, ErrIOUnresolvedFatal) {
		t.Fatalf("operation after quarantine did not return sticky fatal: %v", sideErr)
	}
	if retryErr := endpoint.WriteFrame(context.Background(), original); !errors.Is(retryErr, ErrIOUnresolvedFatal) {
		t.Fatalf("write after quarantine did not return sticky fatal: %v", retryErr)
	}
}

func TestWindowsEndpointCanceledOperationUsesBoundedNonblockingCompletion(t *testing.T) {
	caller := testEndpointFrame([]byte("payload"))
	quarantine := &endpointLifetimeQuarantine{}
	endpoint := testEndpointWithQuarantine(900, uint32(len(caller)), quarantine)
	endpoint.state.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
		return 901, nil
	}
	var operation *endpointOperation
	endpoint.state.writeFile = func(_ windows.Handle, _ []byte, _ *uint32, _ *windows.Overlapped) error {
		for candidate := range endpoint.state.operations {
			operation = candidate
		}
		return windows.ERROR_IO_PENDING
	}
	ctx, cancel := context.WithCancel(context.Background())
	waits := 0
	cleanupWait := uint32(0)
	endpoint.state.waitForSingleObject = func(_ windows.Handle, milliseconds uint32) (uint32, error) {
		waits++
		if waits == 1 {
			cancel()
			return uint32(windows.WAIT_TIMEOUT), nil
		}
		cleanupWait = milliseconds
		return windows.WAIT_OBJECT_0, nil
	}
	cancelCalls := 0
	endpoint.state.cancelIO = func(handle windows.Handle, overlapped *windows.Overlapped) error {
		cancelCalls++
		if operation == nil || handle != 900 || overlapped != &operation.overlapped {
			return errors.New("CancelIoEx did not target the exact operation")
		}
		return nil
	}
	getCalls := 0
	endpoint.state.getOverlappedResult = func(_ windows.Handle, _ *windows.Overlapped, _ *uint32, wait bool) error {
		getCalls++
		if wait {
			return errors.New("GetOverlappedResult used a blocking wait")
		}
		return windows.ERROR_OPERATION_ABORTED
	}
	closeCalls := 0
	endpoint.state.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
	if err := endpoint.WriteFrame(ctx, caller); !errors.Is(err, context.Canceled) || errors.Is(err, ErrIOUnresolvedFatal) {
		t.Fatalf("canceled WriteFrame error = %v", err)
	}
	if cancelCalls != 1 || getCalls != 1 || cleanupWait == 0 || closeCalls != 1 ||
		operation == nil || operation.pinned || quarantine.count() != 0 ||
		!endpoint.state.active.wait(time.Millisecond) {
		t.Fatalf(
			"cancel=%d get=%d cleanupWait=%d close=%d operation=%#v quarantine=%d",
			cancelCalls,
			getCalls,
			cleanupWait,
			closeCalls,
			operation,
			quarantine.count(),
		)
	}
}

func TestWindowsEndpointCancellationTimeoutQuarantinesWithoutCallerReference(t *testing.T) {
	caller := testEndpointFrame([]byte("payload"))
	original := bytes.Clone(caller)
	quarantine := &endpointLifetimeQuarantine{}
	retainEndpointTestQuarantine(quarantine)
	endpoint := testEndpointWithQuarantine(920, uint32(len(caller)), quarantine)
	endpoint.state.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
		return 921, nil
	}
	var operation *endpointOperation
	endpoint.state.writeFile = func(_ windows.Handle, kernel []byte, _ *uint32, _ *windows.Overlapped) error {
		for candidate := range endpoint.state.operations {
			operation = candidate
		}
		if &kernel[0] == &caller[0] {
			return errors.New("pending write retained caller storage")
		}
		return windows.ERROR_IO_PENDING
	}
	ctx, cancel := context.WithCancel(context.Background())
	waits := 0
	cleanupWait := uint32(0)
	endpoint.state.waitForSingleObject = func(_ windows.Handle, milliseconds uint32) (uint32, error) {
		waits++
		if waits == 1 {
			cancel()
		} else {
			cleanupWait = milliseconds
		}
		return uint32(windows.WAIT_TIMEOUT), nil
	}
	endpoint.state.cancelIO = func(windows.Handle, *windows.Overlapped) error { return nil }
	getCalls := 0
	endpoint.state.getOverlappedResult = func(windows.Handle, *windows.Overlapped, *uint32, bool) error {
		getCalls++
		return nil
	}
	closeCalls := 0
	endpoint.state.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
	err := endpoint.WriteFrame(ctx, caller)
	if !errors.Is(err, context.Canceled) || !errors.Is(err, ErrCloseTimeout) ||
		!errors.Is(err, ErrIOUnresolvedFatal) {
		t.Fatalf("timed-out cancellation error = %v", err)
	}
	caller[0] ^= 0xff
	owners := endpointTestQuarantineOwners(quarantine)
	if operation == nil || len(owners) != 1 || owners[0] != operation || !operation.pinned || !operation.quarantined ||
		!bytes.Equal(operation.buffer, original) || cleanupWait == 0 || getCalls != 0 ||
		closeCalls != 0 || quarantine.count() != 1 || endpoint.state.active.wait(time.Millisecond) {
		t.Fatalf(
			"operation=%#v cleanupWait=%d get=%d close=%d quarantine=%d",
			operation,
			cleanupWait,
			getCalls,
			closeCalls,
			quarantine.count(),
		)
	}
}

func TestWindowsEndpointInvalidHandleNeverReusesNumericSlots(t *testing.T) {
	quarantine := &endpointLifetimeQuarantine{}
	retainEndpointTestQuarantine(quarantine)
	frame := testEndpointFrame(nil)
	endpoint := testEndpointWithQuarantine(950, uint32(len(frame)), quarantine)
	endpoint.state.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
		return 951, nil
	}
	var operation *endpointOperation
	endpoint.state.writeFile = func(windows.Handle, []byte, *uint32, *windows.Overlapped) error {
		for candidate := range endpoint.state.operations {
			operation = candidate
		}
		return windows.ERROR_INVALID_HANDLE
	}
	waitCalls := 0
	endpoint.state.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
		waitCalls++
		return windows.WAIT_OBJECT_0, nil
	}
	getCalls := 0
	endpoint.state.getOverlappedResult = func(windows.Handle, *windows.Overlapped, *uint32, bool) error {
		getCalls++
		return nil
	}
	closeCalls := 0
	endpoint.state.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
	if err := endpoint.WriteFrame(context.Background(), frame); !errors.Is(err, windows.ERROR_INVALID_HANDLE) ||
		!errors.Is(err, ErrIOUnresolvedFatal) {
		t.Fatalf("invalid-handle WriteFrame = %v", err)
	}
	owners := endpointTestQuarantineOwners(quarantine)
	if operation == nil || len(owners) != 1 || owners[0] != operation || !operation.pipeTombstoned || endpoint.state.handle != 0 ||
		waitCalls != 0 || getCalls != 0 || closeCalls != 0 || quarantine.count() != 1 {
		t.Fatalf(
			"operation=%#v handle=%d wait=%d get=%d close=%d quarantine=%d",
			operation,
			endpoint.state.handle,
			waitCalls,
			getCalls,
			closeCalls,
			quarantine.count(),
		)
	}
	if err := endpoint.Close(); !errors.Is(err, ErrIOUnresolvedFatal) {
		t.Fatalf("Close after INVALID_HANDLE = %v", err)
	}
	if _, err := endpoint.LocalSide(); !errors.Is(err, ErrIOUnresolvedFatal) {
		t.Fatalf("LocalSide after INVALID_HANDLE = %v", err)
	}
	if closeCalls != 0 {
		t.Fatalf("tombstoned numeric handle was reused %d times", closeCalls)
	}
}

func TestWindowsEndpointPendingInvalidHandleStagesStopFurtherSyscalls(t *testing.T) {
	tests := []struct {
		name               string
		configure          func(*endpointState, context.CancelFunc, *int, *int, *int)
		wantPipeTombstone  bool
		wantEventTombstone bool
	}{
		{
			name: "normal event wait",
			configure: func(state *endpointState, _ context.CancelFunc, waits *int, _ *int, _ *int) {
				state.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
					*waits++
					return 0, windows.ERROR_INVALID_HANDLE
				}
			},
			wantEventTombstone: true,
		},
		{
			name: "GetOverlappedResult",
			configure: func(state *endpointState, _ context.CancelFunc, waits *int, gets *int, _ *int) {
				state.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
					*waits++
					return windows.WAIT_OBJECT_0, nil
				}
				state.getOverlappedResult = func(windows.Handle, *windows.Overlapped, *uint32, bool) error {
					*gets++
					return windows.ERROR_INVALID_HANDLE
				}
			},
			wantPipeTombstone: true,
		},
		{
			name: "CancelIoEx",
			configure: func(state *endpointState, cancel context.CancelFunc, waits *int, _ *int, cancels *int) {
				state.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
					*waits++
					cancel()
					return uint32(windows.WAIT_TIMEOUT), nil
				}
				state.cancelIO = func(windows.Handle, *windows.Overlapped) error {
					*cancels++
					return windows.ERROR_INVALID_HANDLE
				}
			},
			wantPipeTombstone: true,
		},
		{
			name: "cleanup event wait",
			configure: func(state *endpointState, cancel context.CancelFunc, waits *int, _ *int, cancels *int) {
				state.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
					*waits++
					if *waits == 1 {
						cancel()
						return uint32(windows.WAIT_TIMEOUT), nil
					}
					return 0, windows.ERROR_INVALID_HANDLE
				}
				state.cancelIO = func(windows.Handle, *windows.Overlapped) error {
					*cancels++
					return nil
				}
			},
			wantEventTombstone: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			quarantine := &endpointLifetimeQuarantine{}
			retainEndpointTestQuarantine(quarantine)
			frame := testEndpointFrame(nil)
			endpoint := testEndpointWithQuarantine(960, uint32(len(frame)), quarantine)
			endpoint.state.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
				return 961, nil
			}
			var operation *endpointOperation
			endpoint.state.writeFile = func(windows.Handle, []byte, *uint32, *windows.Overlapped) error {
				for candidate := range endpoint.state.operations {
					operation = candidate
				}
				return windows.ERROR_IO_PENDING
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			waits := 0
			gets := 0
			cancels := 0
			test.configure(endpoint.state, cancel, &waits, &gets, &cancels)
			closeCalls := 0
			endpoint.state.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
			err := endpoint.WriteFrame(ctx, frame)
			if !errors.Is(err, windows.ERROR_INVALID_HANDLE) || !errors.Is(err, ErrIOUnresolvedFatal) {
				t.Fatalf("pending invalid-handle error = %v", err)
			}
			owners := endpointTestQuarantineOwners(quarantine)
			if operation == nil || len(owners) != 1 || owners[0] != operation ||
				operation.pipeTombstoned != test.wantPipeTombstone ||
				operation.eventTombstoned != test.wantEventTombstone || closeCalls != 0 {
				t.Fatalf(
					"operation=%#v waits=%d gets=%d cancels=%d close=%d owners=%v",
					operation,
					waits,
					gets,
					cancels,
					closeCalls,
					owners,
				)
			}
			beforeWaits, beforeGets, beforeCancels := waits, gets, cancels
			if closeErr := endpoint.Close(); !errors.Is(closeErr, ErrIOUnresolvedFatal) {
				t.Fatalf("Close after pending INVALID_HANDLE = %v", closeErr)
			}
			if waits != beforeWaits || gets != beforeGets || cancels != beforeCancels || closeCalls != 0 {
				t.Fatal("Close reused a tombstoned handle or event")
			}
		})
	}
}

func TestWindowsEndpointDisconnectInvalidHandleSkipsRawClose(t *testing.T) {
	quarantine := &endpointLifetimeQuarantine{}
	endpoint := testEndpointWithQuarantine(970, framing.HeaderBytes, quarantine)
	endpoint.state.server = true
	disconnectCalls := 0
	endpoint.state.disconnect = func(windows.Handle) error {
		disconnectCalls++
		return windows.ERROR_INVALID_HANDLE
	}
	closeCalls := 0
	endpoint.state.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
	if err := endpoint.Close(); !errors.Is(err, windows.ERROR_INVALID_HANDLE) || !errors.Is(err, ErrIOUnresolvedFatal) {
		t.Fatalf("disconnect INVALID_HANDLE error = %v", err)
	}
	if disconnectCalls != 1 || closeCalls != 0 || endpoint.state.handle != 0 || quarantine.count() != 1 {
		t.Fatalf(
			"disconnect=%d close=%d handle=%d quarantine=%d",
			disconnectCalls,
			closeCalls,
			endpoint.state.handle,
			quarantine.count(),
		)
	}
}

func TestWindowsEndpointCloseTimeoutQuarantinesStateWithoutFinalizingOperations(t *testing.T) {
	quarantine := &endpointLifetimeQuarantine{}
	retainEndpointTestQuarantine(quarantine)
	endpoint := testEndpointWithQuarantine(990, framing.HeaderBytes, quarantine)
	endpoint.state.closeGrace = time.Millisecond
	finish := endpoint.state.active.begin()
	operation := newEndpointOperation(
		endpoint.state,
		endpointOperationRead,
		990,
		make([]byte, framing.HeaderBytes),
		991,
		finish,
	)
	operation.submitted = true
	operation.completed = false
	endpoint.state.operations[operation] = struct{}{}
	closeCalls := 0
	endpoint.state.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
	started := time.Now()
	err := endpoint.Close()
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("Close timeout was unbounded: %v", elapsed)
	}
	owners := endpointTestQuarantineOwners(quarantine)
	if !errors.Is(err, ErrCloseTimeout) || !errors.Is(err, ErrIOUnresolvedFatal) ||
		len(owners) != 1 || owners[0] != endpoint.state || !operation.forcedQuarantine.Load() ||
		!operation.pinned || closeCalls != 0 || endpoint.state.active.wait(time.Millisecond) {
		t.Fatalf(
			"error=%v owners=%v operation=%#v close=%d",
			err,
			owners,
			operation,
			closeCalls,
		)
	}
}

func TestWindowsEndpointRawCloseFailureIsConsumedOnce(t *testing.T) {
	quarantine := &endpointLifetimeQuarantine{}
	endpoint := testEndpointWithQuarantine(980, framing.HeaderBytes, quarantine)
	closeFailure := errors.New("CloseHandle failed")
	closeCalls := 0
	endpoint.state.closeHandle = func(handle windows.Handle) error {
		closeCalls++
		if endpoint.state.handle != 0 || handle != 980 {
			return errors.New("raw handle was not tombstoned before close")
		}
		return closeFailure
	}
	copied := *endpoint
	firstErr := endpoint.Close()
	secondErr := copied.Close()
	if !errors.Is(firstErr, closeFailure) || !errors.Is(firstErr, ErrIOUnresolvedFatal) ||
		!errors.Is(secondErr, closeFailure) || closeCalls != 1 || endpoint.state.handle != 0 || quarantine.count() != 1 {
		t.Fatalf(
			"first=%v second=%v close=%d handle=%d quarantine=%d",
			firstErr,
			secondErr,
			closeCalls,
			endpoint.state.handle,
			quarantine.count(),
		)
	}
}

func TestWindowsEndpointFlushThenCloseContracts(t *testing.T) {
	t.Run("copied abortive waiters share one fatal finalizer", func(t *testing.T) {
		quarantine := &endpointLifetimeQuarantine{}
		endpoint := testEndpointWithQuarantine(1190, framing.HeaderBytes, quarantine)
		endpoint.state.server = true
		endpoint.state.closeMode = endpointCloseModeFlush
		endpoint.state.closeGrace = time.Millisecond
		first := *endpoint
		second := *endpoint
		results := make(chan error, 2)
		go func() { results <- first.Close() }()
		go func() { results <- second.Close() }()
		firstErr := <-results
		secondErr := <-results
		owners := endpointTestQuarantineOwners(quarantine)
		if firstErr != secondErr || !errors.Is(firstErr, ErrCloseTimeout) ||
			!errors.Is(firstErr, ErrIOUnresolvedFatal) || len(owners) != 1 ||
			owners[0] != endpoint.state {
			t.Fatalf("first=%v second=%v owners=%#v", firstErr, secondErr, owners)
		}
		if err := endpoint.FlushThenClose(context.Background()); !errors.Is(err, firstErr) ||
			!errors.Is(err, ErrFlushInterrupted) {
			t.Fatalf("repeat after abortive timeout = %v", err)
		}
	})

	t.Run("registered flush cannot start after process fatal publication", func(t *testing.T) {
		quarantine := &endpointLifetimeQuarantine{}
		owner := &endpointFlushOwner{done: make(chan endpointFlushResult, 1)}
		if err := quarantine.registerFlush(owner); err != nil {
			t.Fatal(err)
		}
		fatalCause := errors.New("concurrent fatal publication")
		fatal := quarantine.retain(
			&endpointRawHandleOwner{kind: "other failed owner", value: 1199},
			fatalCause,
		)
		if err := quarantine.beginFlush(owner); !errors.Is(err, fatal) || owner.started {
			t.Fatalf("beginFlush after fatal = %v, started=%v", err, owner.started)
		}
		owners := endpointTestQuarantineOwners(quarantine)
		if len(owners) != 2 || owners[0] != owner {
			t.Fatalf("registered owner was not retained before fatal publication: %#v", owners)
		}
	})

	t.Run("pending flush cancellation does not publish process fatal", func(t *testing.T) {
		quarantine := &endpointLifetimeQuarantine{}
		owner := &endpointFlushOwner{done: make(chan endpointFlushResult, 1)}
		if err := quarantine.registerFlush(owner); err != nil {
			t.Fatal(err)
		}
		canceled, completed, fatal := quarantine.cancelOrRetainFlush(owner, context.Canceled)
		if !canceled || completed || fatal != nil || !owner.canceled || owner.started {
			t.Fatalf("canceled=%v completed=%v fatal=%v owner=%#v", canceled, completed, fatal, owner)
		}
		if err := quarantine.beginFlush(owner); !errors.Is(err, errEndpointFlushAdmissionCanceled) {
			t.Fatalf("begin canceled flush = %v", err)
		}
		if quarantine.fatalError() != nil || quarantine.count() != 0 {
			t.Fatalf("pending cancellation published fatal=%v owners=%d", quarantine.fatalError(), quarantine.count())
		}
	})

	t.Run("claimed abortive result delays close completion publication", func(t *testing.T) {
		endpoint := testEndpointWithQuarantine(1195, framing.HeaderBytes, &endpointLifetimeQuarantine{})
		state := endpoint.state
		state.stateMu.Lock()
		state.abortWaitStarted = true
		abortDone := state.abortWaitDoneLocked()
		closeDone := state.closeDoneLocked()
		state.stateMu.Unlock()

		published := make(chan struct{})
		go func() {
			state.publishCloseCompletion(closeDone)
			close(published)
		}()
		select {
		case <-closeDone:
			t.Fatal("close completion overtook the claimed abortive result")
		case <-time.After(10 * time.Millisecond):
		}
		state.stateMu.Lock()
		state.abortWaitErr = errors.Join(ErrCloseTimeout, ErrIOUnresolvedFatal)
		close(abortDone)
		state.stateMu.Unlock()
		select {
		case <-published:
		case <-time.After(time.Second):
			t.Fatal("close completion did not publish after the abortive result")
		}
	})

	t.Run("canceled pre-admission flush stays nonfatal", func(t *testing.T) {
		quarantine := &endpointLifetimeQuarantine{}
		endpoint := testEndpointWithQuarantine(1196, framing.HeaderBytes, quarantine)
		owner := &endpointFlushOwner{
			state:  endpoint.state,
			handle: 1196,
			done:   make(chan endpointFlushResult, 1),
		}
		if err := quarantine.registerFlush(owner); err != nil {
			t.Fatal(err)
		}
		canceled, completed, fatal := quarantine.cancelOrRetainFlush(owner, ErrFlushInterrupted)
		if !canceled || completed || fatal != nil {
			t.Fatalf("canceled=%v completed=%v fatal=%v", canceled, completed, fatal)
		}
		semanticErr, fatalErr := endpoint.state.finishFlush(
			context.Background(),
			quarantine,
			owner,
			1196,
			endpointFlushResult{
				err:               errEndpointFlushAdmissionCanceled,
				admissionCanceled: true,
			},
		)
		if !errors.Is(semanticErr, ErrFlushInterrupted) || fatalErr != nil ||
			quarantine.fatalError() != nil || endpoint.state.fatal != nil {
			t.Fatalf(
				"semantic=%v fatal=%v processFatal=%v endpointFatal=%v",
				semanticErr,
				fatalErr,
				quarantine.fatalError(),
				endpoint.state.fatal,
			)
		}
	})

	t.Run("server flushes before disconnect and close", func(t *testing.T) {
		quarantine := &endpointLifetimeQuarantine{}
		endpoint := testEndpointWithQuarantine(1200, framing.HeaderBytes, quarantine)
		endpoint.state.server = true
		events := make([]string, 0, 3)
		endpoint.state.flushBuffers = func(handle windows.Handle) error {
			if handle != 1200 {
				return errors.New("flush received the wrong handle")
			}
			events = append(events, "flush")
			return nil
		}
		endpoint.state.disconnect = func(windows.Handle) error {
			events = append(events, "disconnect")
			return nil
		}
		endpoint.state.closeHandle = func(windows.Handle) error {
			events = append(events, "close")
			return nil
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		copied := *endpoint
		if err := endpoint.FlushThenClose(ctx); err != nil {
			t.Fatal(err)
		}
		if err := copied.FlushThenClose(ctx); err != nil {
			t.Fatalf("repeated FlushThenClose = %v", err)
		}
		if err := copied.FlushThenClose(context.Background()); err != nil {
			t.Fatalf("completed FlushThenClose revalidated a new context: %v", err)
		}
		canceledContext, cancelRepeat := context.WithCancel(context.Background())
		cancelRepeat()
		if err := copied.FlushThenClose(canceledContext); err != nil {
			t.Fatalf("completed FlushThenClose used a canceled repeat context: %v", err)
		}
		endpoint.state.closeGrace = time.Nanosecond
		if err := endpoint.Close(); err != nil {
			t.Fatalf("Close after graceful close = %v", err)
		}
		want := []string{"flush", "disconnect", "close"}
		if fmt.Sprint(events) != fmt.Sprint(want) || endpoint.state.handle != 0 || quarantine.count() != 0 {
			t.Fatalf("events=%v handle=%d quarantine=%d", events, endpoint.state.handle, quarantine.count())
		}
	})

	t.Run("client and missing deadline do not consume the endpoint", func(t *testing.T) {
		quarantine := &endpointLifetimeQuarantine{}
		endpoint := testEndpointWithQuarantine(1210, framing.HeaderBytes, quarantine)
		flushCalls := 0
		endpoint.state.flushBuffers = func(windows.Handle) error { flushCalls++; return nil }
		closeCalls := 0
		endpoint.state.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := endpoint.FlushThenClose(ctx); !errors.Is(err, ErrFlushServerOnly) {
			t.Fatalf("client FlushThenClose = %v", err)
		}
		endpoint.state.server = true
		endpoint.state.disconnect = func(windows.Handle) error { return nil }
		if err := endpoint.FlushThenClose(context.Background()); !errors.Is(err, ErrFlushDeadline) {
			t.Fatalf("deadline-free FlushThenClose = %v", err)
		}
		if err := endpoint.Close(); err != nil {
			t.Fatal(err)
		}
		if err := endpoint.FlushThenClose(ctx); !errors.Is(err, ErrFlushInterrupted) {
			t.Fatalf("FlushThenClose after abortive Close = %v", err)
		}
		if flushCalls != 0 || closeCalls != 1 || endpoint.state.closeMode != endpointCloseModeAbortive {
			t.Fatalf("flush=%d close=%d mode=%d", flushCalls, closeCalls, endpoint.state.closeMode)
		}
	})

	t.Run("process fatal state dominates wrong-side validation", func(t *testing.T) {
		quarantine := &endpointLifetimeQuarantine{}
		endpoint := testEndpointWithQuarantine(1215, framing.HeaderBytes, quarantine)
		fatalCause := errors.New("earlier endpoint ownership failure")
		fatal := quarantine.retain(
			&endpointRawHandleOwner{kind: "earlier failed owner", value: 1214},
			fatalCause,
		)
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		err := endpoint.FlushThenClose(ctx)
		if !errors.Is(err, fatal) || !errors.Is(err, ErrIOUnresolvedFatal) ||
			errors.Is(err, ErrFlushServerOnly) {
			t.Fatalf("FlushThenClose after process fatal = %v", err)
		}
	})

	t.Run("abortive election publishes completion for an existing local fatal", func(t *testing.T) {
		quarantine := &endpointLifetimeQuarantine{}
		endpoint := testEndpointWithQuarantine(1218, framing.HeaderBytes, quarantine)
		endpoint.state.server = true
		localCause := errors.New("local fatal before global retention")
		endpoint.state.fatal = errors.Join(ErrIOUnresolvedFatal, localCause)
		if err := endpoint.Close(); !errors.Is(err, localCause) {
			t.Fatalf("Close with existing local fatal = %v", err)
		}
		select {
		case <-endpoint.state.closeDone:
		default:
			t.Fatal("Close did not publish completion for the elected fatal result")
		}
		err := endpoint.FlushThenClose(context.Background())
		if !errors.Is(err, ErrFlushInterrupted) || !errors.Is(err, localCause) {
			t.Fatalf("repeated graceful close after local fatal = %v", err)
		}
	})

	t.Run("ordinary flush failure is visible only to graceful close", func(t *testing.T) {
		quarantine := &endpointLifetimeQuarantine{}
		endpoint := testEndpointWithQuarantine(1220, framing.HeaderBytes, quarantine)
		endpoint.state.server = true
		flushFailure := errors.New("flush failed")
		endpoint.state.flushBuffers = func(windows.Handle) error { return flushFailure }
		endpoint.state.disconnect = func(windows.Handle) error { return nil }
		closeCalls := 0
		endpoint.state.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := endpoint.FlushThenClose(ctx); !errors.Is(err, flushFailure) || errors.Is(err, ErrIOUnresolvedFatal) {
			t.Fatalf("ordinary flush failure = %v", err)
		}
		if err := endpoint.FlushThenClose(context.Background()); !errors.Is(err, flushFailure) {
			t.Fatalf("memoized flush failure = %v", err)
		}
		if err := endpoint.Close(); err != nil {
			t.Fatalf("abortive close result inherited semantic flush failure: %v", err)
		}
		if closeCalls != 1 || endpoint.state.handle != 0 || quarantine.count() != 0 {
			t.Fatalf("close=%d handle=%d quarantine=%d", closeCalls, endpoint.state.handle, quarantine.count())
		}
	})

	t.Run("concurrent graceful waiter honors its earlier deadline", func(t *testing.T) {
		quarantine := &endpointLifetimeQuarantine{}
		endpoint := testEndpointWithQuarantine(1228, framing.HeaderBytes, quarantine)
		endpoint.state.server = true
		flushStarted := make(chan struct{})
		releaseFlush := make(chan struct{})
		endpoint.state.flushBuffers = func(windows.Handle) error {
			close(flushStarted)
			<-releaseFlush
			return nil
		}
		endpoint.state.disconnect = func(windows.Handle) error { return nil }
		closeCalls := 0
		endpoint.state.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
		firstResult := make(chan error, 1)
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			firstResult <- endpoint.FlushThenClose(ctx)
		}()
		<-flushStarted
		waiterContext, cancelWaiter := context.WithTimeout(context.Background(), 10*time.Millisecond)
		defer cancelWaiter()
		if err := endpoint.FlushThenClose(waiterContext); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("concurrent waiter = %v", err)
		}
		if quarantine.fatalError() != nil || closeCalls != 0 {
			t.Fatalf("waiter deadline altered owner: fatal=%v close=%d", quarantine.fatalError(), closeCalls)
		}
		close(releaseFlush)
		if err := <-firstResult; err != nil {
			t.Fatalf("owning FlushThenClose = %v", err)
		}
		if closeCalls != 1 || quarantine.count() != 0 {
			t.Fatalf("close=%d quarantine=%d", closeCalls, quarantine.count())
		}
	})

	t.Run("terminal endpoint skips flush and is still consumed", func(t *testing.T) {
		quarantine := &endpointLifetimeQuarantine{}
		endpoint := testEndpointWithQuarantine(1225, framing.HeaderBytes, quarantine)
		endpoint.state.server = true
		terminal := errors.New("earlier protocol failure")
		endpoint.state.terminal = terminal
		flushCalls := 0
		endpoint.state.flushBuffers = func(windows.Handle) error { flushCalls++; return nil }
		endpoint.state.disconnect = func(windows.Handle) error { return nil }
		closeCalls := 0
		endpoint.state.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := endpoint.FlushThenClose(ctx); !errors.Is(err, terminal) || errors.Is(err, ErrIOUnresolvedFatal) {
			t.Fatalf("terminal FlushThenClose = %v", err)
		}
		if err := endpoint.Close(); err != nil {
			t.Fatalf("Close inherited terminal semantic error: %v", err)
		}
		if flushCalls != 0 || closeCalls != 1 || endpoint.state.handle != 0 || quarantine.count() != 0 {
			t.Fatalf("flush=%d close=%d handle=%d quarantine=%d", flushCalls, closeCalls, endpoint.state.handle, quarantine.count())
		}
	})

	t.Run("blocked flush deadline quarantines without closing", func(t *testing.T) {
		quarantine := &endpointLifetimeQuarantine{}
		retainEndpointTestQuarantine(quarantine)
		endpoint := testEndpointWithQuarantine(1230, framing.HeaderBytes, quarantine)
		endpoint.state.server = true
		flushStarted := make(chan struct{})
		releaseFlush := make(chan struct{})
		endpoint.state.flushBuffers = func(windows.Handle) error {
			close(flushStarted)
			<-releaseFlush
			return nil
		}
		closeCalls := 0
		endpoint.state.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
		deadlineContext, cancelDeadline := context.WithTimeout(context.Background(), time.Second)
		defer cancelDeadline()
		ctx, cancelCause := context.WithCancelCause(deadlineContext)
		result := make(chan error, 1)
		go func() { result <- endpoint.FlushThenClose(ctx) }()
		select {
		case <-flushStarted:
		case <-time.After(time.Second):
			t.Fatal("FlushFileBuffers did not start before the test deadline")
		}
		cancelCause(context.DeadlineExceeded)
		err := <-result
		owners := endpointTestQuarantineOwners(quarantine)
		if !errors.Is(err, context.DeadlineExceeded) || !errors.Is(err, ErrCloseTimeout) ||
			!errors.Is(err, ErrIOUnresolvedFatal) || closeCalls != 0 || len(owners) != 1 {
			t.Fatalf("error=%v close=%d owners=%#v", err, closeCalls, owners)
		}
		owner, ok := owners[0].(*endpointFlushOwner)
		if !ok || owner.state != endpoint.state || owner.handle != 1230 || endpoint.state.handle != 1230 {
			t.Fatalf("retained owner=%#v state handle=%d", owners[0], endpoint.state.handle)
		}
		repeatErr := endpoint.FlushThenClose(context.Background())
		if !errors.Is(repeatErr, context.DeadlineExceeded) || !errors.Is(repeatErr, ErrIOUnresolvedFatal) {
			t.Fatalf("repeated deadline FlushThenClose = %v", repeatErr)
		}
		if closeErr := endpoint.Close(); !errors.Is(closeErr, ErrIOUnresolvedFatal) || closeCalls != 0 {
			t.Fatalf("Close after flush timeout = %v, close calls=%d", closeErr, closeCalls)
		}
		close(releaseFlush)
		if !endpoint.state.active.wait(time.Second) {
			t.Fatal("timed-out flush goroutine did not release activity ownership")
		}
	})

	t.Run("abortive close before flush drains active ownership without quarantine", func(t *testing.T) {
		quarantine := &endpointLifetimeQuarantine{}
		endpoint := testEndpointWithQuarantine(1235, framing.HeaderBytes, quarantine)
		endpoint.state.server = true
		flushCalls := 0
		endpoint.state.flushBuffers = func(windows.Handle) error { flushCalls++; return nil }
		endpoint.state.disconnect = func(windows.Handle) error { return nil }
		closeCalls := 0
		endpoint.state.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
		finishActive := endpoint.state.active.begin()
		flushResult := make(chan error, 1)
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			flushResult <- endpoint.FlushThenClose(ctx)
		}()
		deadline := time.Now().Add(time.Second)
		for {
			endpoint.state.stateMu.Lock()
			closing := endpoint.state.closing
			endpoint.state.stateMu.Unlock()
			if closing {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("FlushThenClose did not publish closing state")
			}
			runtime.Gosched()
		}
		closeResult := make(chan error, 1)
		go func() { closeResult <- endpoint.Close() }()
		select {
		case <-endpoint.state.abortiveCloseChannel():
		case <-time.After(time.Second):
			t.Fatal("Close did not publish the abortive-close signal")
		}
		finishActive()
		if err := <-closeResult; err != nil {
			t.Fatalf("abortive Close before flush = %v", err)
		}
		if err := <-flushResult; !errors.Is(err, ErrFlushInterrupted) || errors.Is(err, ErrIOUnresolvedFatal) {
			t.Fatalf("interrupted pre-flush result = %v", err)
		}
		if flushCalls != 0 || closeCalls != 1 || quarantine.count() != 0 || endpoint.state.handle != 0 {
			t.Fatalf("flush=%d close=%d quarantine=%d handle=%d", flushCalls, closeCalls, quarantine.count(), endpoint.state.handle)
		}
	})

	t.Run("abortive close quarantines an in-flight flush", func(t *testing.T) {
		quarantine := &endpointLifetimeQuarantine{}
		retainEndpointTestQuarantine(quarantine)
		endpoint := testEndpointWithQuarantine(1240, framing.HeaderBytes, quarantine)
		endpoint.state.server = true
		flushStarted := make(chan struct{})
		releaseFlush := make(chan struct{})
		endpoint.state.flushBuffers = func(windows.Handle) error {
			close(flushStarted)
			<-releaseFlush
			return nil
		}
		closeCalls := 0
		endpoint.state.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
		flushResult := make(chan error, 1)
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			flushResult <- endpoint.FlushThenClose(ctx)
		}()
		<-flushStarted
		closeResult := make(chan error, 1)
		go func() { closeResult <- endpoint.Close() }()
		select {
		case err := <-closeResult:
			if !errors.Is(err, ErrFlushInterrupted) || !errors.Is(err, ErrIOUnresolvedFatal) {
				t.Fatalf("Close during flush = %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("Close blocked behind the graceful deadline")
		}
		if err := <-flushResult; !errors.Is(err, ErrFlushInterrupted) || !errors.Is(err, ErrIOUnresolvedFatal) {
			t.Fatalf("interrupted FlushThenClose = %v", err)
		}
		if closeCalls != 0 || quarantine.count() != 1 {
			t.Fatalf("close=%d quarantine=%d", closeCalls, quarantine.count())
		}
		close(releaseFlush)
		if !endpoint.state.active.wait(time.Second) {
			t.Fatal("interrupted flush goroutine did not release activity ownership")
		}
	})

	t.Run("invalid flush handle becomes sticky fatal", func(t *testing.T) {
		quarantine := &endpointLifetimeQuarantine{}
		endpoint := testEndpointWithQuarantine(1250, framing.HeaderBytes, quarantine)
		endpoint.state.server = true
		endpoint.state.flushBuffers = func(windows.Handle) error { return windows.ERROR_INVALID_HANDLE }
		closeCalls := 0
		endpoint.state.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		err := endpoint.FlushThenClose(ctx)
		if !errors.Is(err, windows.ERROR_INVALID_HANDLE) || !errors.Is(err, ErrIOUnresolvedFatal) ||
			closeCalls != 0 || endpoint.state.handle != 0 || quarantine.count() != 1 {
			t.Fatalf("error=%v close=%d handle=%d quarantine=%d", err, closeCalls, endpoint.state.handle, quarantine.count())
		}
	})

	t.Run("flush completion error is retained beside concurrent process fatal", func(t *testing.T) {
		quarantine := &endpointLifetimeQuarantine{}
		endpoint := testEndpointWithQuarantine(1260, framing.HeaderBytes, quarantine)
		endpoint.state.server = true
		flushStarted := make(chan struct{})
		releaseFlush := make(chan struct{})
		endpoint.state.flushBuffers = func(windows.Handle) error {
			close(flushStarted)
			<-releaseFlush
			return windows.ERROR_INVALID_HANDLE
		}
		closeCalls := 0
		endpoint.state.closeHandle = func(windows.Handle) error { closeCalls++; return nil }
		result := make(chan error, 1)
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			result <- endpoint.FlushThenClose(ctx)
		}()
		<-flushStarted
		concurrentCause := errors.New("other endpoint became fatal")
		concurrentFatal := quarantine.retain(
			&endpointRawHandleOwner{kind: "other endpoint owner", value: 1261},
			concurrentCause,
		)
		close(releaseFlush)
		err := <-result
		if !errors.Is(err, windows.ERROR_INVALID_HANDLE) || !errors.Is(err, concurrentFatal) ||
			!errors.Is(err, concurrentCause) || !errors.Is(err, ErrIOUnresolvedFatal) ||
			closeCalls != 0 || endpoint.state.handle != 0 {
			t.Fatalf("error=%v close=%d handle=%d", err, closeCalls, endpoint.state.handle)
		}
		owners := endpointTestQuarantineOwners(quarantine)
		if len(owners) != 2 {
			t.Fatalf("concurrent fatal owners=%#v", owners)
		}
	})

	t.Run("admission failure never tombstones this endpoint handle", func(t *testing.T) {
		quarantine := &endpointLifetimeQuarantine{}
		endpoint := testEndpointWithQuarantine(1270, framing.HeaderBytes, quarantine)
		owner := &endpointFlushOwner{
			state:  endpoint.state,
			handle: 1270,
			done:   make(chan endpointFlushResult, 1),
		}
		if err := quarantine.registerFlush(owner); err != nil {
			t.Fatal(err)
		}
		concurrentFatal := quarantine.retain(
			&endpointRawHandleOwner{kind: "other invalid owner", value: 1271},
			windows.ERROR_INVALID_HANDLE,
		)
		semanticErr, fatalErr := endpoint.state.finishFlush(
			context.Background(),
			quarantine,
			owner,
			1270,
			endpointFlushResult{err: concurrentFatal, nativeStarted: false},
		)
		if semanticErr != nil || !errors.Is(fatalErr, concurrentFatal) || endpoint.state.handle != 1270 {
			t.Fatalf("semantic=%v fatal=%v handle=%d", semanticErr, fatalErr, endpoint.state.handle)
		}
	})
}

func TestWindowsEndpointCopiedCloseCancelsExactPendingOperation(t *testing.T) {
	frame := testEndpointFrame(nil)
	quarantine := &endpointLifetimeQuarantine{}
	endpoint := testEndpointWithQuarantine(1000, uint32(len(frame)), quarantine)
	endpoint.state.cleanupGrace = 50 * time.Millisecond
	endpoint.state.closeGrace = 250 * time.Millisecond
	endpoint.state.createEvent = func(*windows.SecurityAttributes, uint32, uint32, *uint16) (windows.Handle, error) {
		return 1001, nil
	}
	started := make(chan struct{})
	releasePoll := make(chan struct{})
	var operation *endpointOperation
	endpoint.state.readFile = func(_ windows.Handle, _ []byte, _ *uint32, _ *windows.Overlapped) error {
		for candidate := range endpoint.state.operations {
			operation = candidate
		}
		close(started)
		return windows.ERROR_IO_PENDING
	}
	endpoint.state.waitForSingleObject = func(_ windows.Handle, milliseconds uint32) (uint32, error) {
		if milliseconds == overlappedPollMilliseconds {
			<-releasePoll
			return uint32(windows.WAIT_TIMEOUT), nil
		}
		return windows.WAIT_OBJECT_0, nil
	}
	cancelCalls := 0
	endpoint.state.cancelIO = func(handle windows.Handle, overlapped *windows.Overlapped) error {
		cancelCalls++
		if operation == nil || handle != 1000 || overlapped != &operation.overlapped {
			return errors.New("Close did not cancel the exact pending operation")
		}
		return nil
	}
	getCalls := 0
	endpoint.state.getOverlappedResult = func(_ windows.Handle, _ *windows.Overlapped, _ *uint32, wait bool) error {
		getCalls++
		if wait {
			return errors.New("Close used blocking GetOverlappedResult")
		}
		return windows.ERROR_OPERATION_ABORTED
	}
	closeCalls := make(map[windows.Handle]int)
	endpoint.state.closeHandle = func(handle windows.Handle) error {
		closeCalls[handle]++
		return nil
	}

	readResult := make(chan error, 1)
	go func() {
		_, err := endpoint.ReadFrame(context.Background())
		readResult <- err
	}()
	<-started
	copied := *endpoint
	closeResult := make(chan error, 1)
	go func() { closeResult <- copied.Close() }()
	deadline := time.Now().Add(time.Second)
	for {
		endpoint.state.stateMu.Lock()
		closing := endpoint.state.closing
		endpoint.state.stateMu.Unlock()
		if closing {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("copied Close did not publish closing state")
		}
		runtime.Gosched()
	}
	close(releasePoll)
	select {
	case err := <-closeResult:
		if err != nil {
			t.Fatalf("copied Close error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("copied Close did not return within its bound")
	}
	select {
	case err := <-readResult:
		if !errors.Is(err, ErrClosed) {
			t.Fatalf("pending read error = %v, want ErrClosed", err)
		}
	case <-time.After(time.Second):
		t.Fatal("pending read owner did not return after terminal cancellation")
	}
	if cancelCalls != 1 || getCalls != 1 || closeCalls[1001] != 1 || closeCalls[1000] != 1 ||
		operation == nil || operation.pinned || quarantine.count() != 0 ||
		!endpoint.state.active.wait(time.Millisecond) {
		t.Fatalf(
			"cancel=%d get=%d close=%v operation=%#v quarantine=%d",
			cancelCalls,
			getCalls,
			closeCalls,
			operation,
			quarantine.count(),
		)
	}
}

func TestWindowsEndpointContractsCompile(t *testing.T) {
	var endpoint *Endpoint
	var relayContract relayEndpointContract = endpoint
	var gracefulContract gracefulServerEndpointContract = endpoint
	var processIDContract ProcessIDObserver = endpoint
	if relayContract == nil || gracefulContract == nil || processIDContract == nil {
		t.Fatal("typed nil endpoint did not populate interface contracts")
	}
}
