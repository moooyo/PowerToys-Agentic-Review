//go:build windows

package hostcontrol

import (
	"bytes"
	"context"
	"errors"
	"io"
	"sync/atomic"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
	"golang.org/x/sys/windows"
)

func TestWindowsPipeContractIsByteModeFirstInstanceAndRemoteRejecting(t *testing.T) {
	wantOpenMode := pipeAccessDuplex | fileFlagFirstPipeInstance | fileFlagOverlapped | readControl
	if serverOpenMode != wantOpenMode {
		t.Fatalf("server open mode = 0x%x, want 0x%x", serverOpenMode, wantOpenMode)
	}
	if serverPipeMode != pipeRejectRemoteClients {
		t.Fatalf("server pipe mode = 0x%x, want byte-mode PIPE_REJECT_REMOTE_CLIENTS", serverPipeMode)
	}
	if maximumServerInstances != 1 {
		t.Fatalf("server instances = %d, want 1", maximumServerInstances)
	}
	var _ io.ReadWriteCloser = (*Connection)(nil)
}

func TestWindowsReadEOFNormalizationRequiresExactZeroBytePipeEOF(t *testing.T) {
	connection := &Connection{}
	cleanupFailure := errors.New("cleanup failed")
	for _, pipeErr := range []error{
		windows.ERROR_BROKEN_PIPE,
		windows.ERROR_NO_DATA,
		windows.ERROR_PIPE_NOT_CONNECTED,
	} {
		if normalized := connection.normalizeOperationError(pipeErr, true, 0); normalized != io.EOF {
			t.Fatalf("exact zero-byte pipe error normalized to %v, want literal EOF", normalized)
		}
		for _, mutation := range []struct {
			name        string
			err         error
			transferred uint32
		}{
			{name: "wrapped", err: errors.Join(pipeErr)},
			{name: "cleanup", err: errors.Join(pipeErr, cleanupFailure)},
			{name: "transferred", err: pipeErr, transferred: 1},
		} {
			t.Run(mutation.name, func(t *testing.T) {
				normalized := connection.normalizeOperationError(
					mutation.err,
					true,
					mutation.transferred,
				)
				if normalized == io.EOF {
					t.Fatal("mutated pipe failure normalized to literal EOF")
				}
				if mutation.name == "cleanup" && !errors.Is(normalized, cleanupFailure) {
					t.Fatalf("cleanup failure was lost: %v", normalized)
				}
			})
		}
	}
}

func TestWindowsConnectionZeroValueIsClosed(t *testing.T) {
	var connection Connection
	if evidence := connection.Evidence(); evidence != (VerificationEvidence{}) {
		t.Fatalf("zero Connection evidence = %+v", evidence)
	}
	if bootstrap := connection.CommittedRuntimeBootstrap(); bootstrap != (localrpc.CommittedRuntimeBootstrap{}) {
		t.Fatal("zero Connection returned committed bootstrap authority")
	}
	if _, err := connection.ReadContext(context.Background(), make([]byte, 1)); !errors.Is(err, ErrClosed) {
		t.Fatalf("zero Connection ReadContext error = %v, want ErrClosed", err)
	}
	if _, err := connection.WriteContext(context.Background(), []byte{1}); !errors.Is(err, ErrClosed) {
		t.Fatalf("zero Connection WriteContext error = %v, want ErrClosed", err)
	}
	if _, err := connection.Read(make([]byte, 1)); !errors.Is(err, ErrClosed) {
		t.Fatalf("zero Connection Read error = %v, want ErrClosed", err)
	}
	if _, err := connection.Write([]byte{1}); !errors.Is(err, ErrClosed) {
		t.Fatalf("zero Connection Write error = %v, want ErrClosed", err)
	}
	if err := connection.normalizeOperationError(windows.ERROR_OPERATION_ABORTED, true, 0); !errors.Is(err, ErrClosed) {
		t.Fatalf("zero Connection operation error = %v, want ErrClosed", err)
	}
	connection.markTerminal(errors.New("ignored terminal cause"))
	connection.setCommittedRuntimeBootstrap(localrpc.CommittedRuntimeBootstrap{})
	if err := connection.Close(); err != nil {
		t.Fatalf("zero Connection Close error = %v", err)
	}
}

func TestWindowsFailedAcceptCleanupReturnsCopySafeRetryOwner(t *testing.T) {
	const handle = windows.Handle(123)
	connection := newConnection(handle, Options{CloseTimeout: time.Second}, VerificationEvidence{})
	closeFailure := errors.New("injected CloseHandle failure")
	primary := errors.New("bootstrap failed")
	cancelCalls := 0
	disconnectCalls := 0
	closeCalls := 0
	connection.state.cancelIO = func(got windows.Handle) error {
		cancelCalls++
		if got != handle {
			t.Fatalf("cancel handle = %d, want %d", got, handle)
		}
		return nil
	}
	connection.state.disconnect = func(got windows.Handle) error {
		disconnectCalls++
		if got != handle {
			t.Fatalf("disconnect handle = %d, want %d", got, handle)
		}
		return nil
	}
	connection.state.closeHandle = func(got windows.Handle) error {
		closeCalls++
		if got != handle {
			t.Fatalf("close handle = %d, want %d", got, handle)
		}
		if closeCalls == 1 {
			return closeFailure
		}
		return nil
	}
	node := newFakeRetainedNode(testNodeIdentity())

	owner, err := rejectAcceptFailure(connection, primary, node, func() {
		connection.markTerminal(primary)
	}, connection.Close)
	if owner == nil {
		t.Fatal("failed cleanup discarded the Connection owner")
	}
	if owner != connection || owner.state != connection.state {
		t.Fatalf("failed cleanup returned owner %p with state %p, want %p/%p", owner, owner.state, connection, connection.state)
	}
	if !node.terminated || !errors.Is(err, primary) || !errors.Is(err, closeFailure) {
		t.Fatalf("failed cleanup terminated=%v error=%v", node.terminated, err)
	}
	if connection.state.handle != handle || cancelCalls != 2 || disconnectCalls != 1 || closeCalls != 1 {
		t.Fatalf(
			"failed cleanup handle=%d calls cancel/disconnect/close=%d/%d/%d",
			connection.state.handle,
			cancelCalls,
			disconnectCalls,
			closeCalls,
		)
	}

	copy := *owner
	if err := copy.Close(); err != nil {
		t.Fatalf("Close through copied owner = %v", err)
	}
	if connection.state.handle != 0 || cancelCalls != 3 || disconnectCalls != 2 || closeCalls != 2 {
		t.Fatalf(
			"retry handle=%d calls cancel/disconnect/close=%d/%d/%d",
			connection.state.handle,
			cancelCalls,
			disconnectCalls,
			closeCalls,
		)
	}
	if err := owner.Close(); err != nil {
		t.Fatalf("idempotent Close through original owner = %v", err)
	}
	if cancelCalls != 3 || disconnectCalls != 2 || closeCalls != 2 {
		t.Fatalf("idempotent Close repeated native calls: %d/%d/%d", cancelCalls, disconnectCalls, closeCalls)
	}
}

func TestWindowsCopiedCloseTimeoutsShareActivityDrain(t *testing.T) {
	const handle = windows.Handle(456)
	connection := newConnection(handle, Options{CloseTimeout: 10 * time.Millisecond}, VerificationEvidence{})
	finish := connection.state.active.begin()
	connection.state.active.mu.Lock()
	drained := connection.state.active.drained
	connection.state.active.mu.Unlock()
	connection.state.cancelIO = func(windows.Handle) error { return windows.ERROR_NOT_FOUND }
	connection.state.disconnect = func(windows.Handle) error { return nil }
	var closeCalls atomic.Int32
	connection.state.closeHandle = func(windows.Handle) error {
		closeCalls.Add(1)
		return nil
	}

	first := *connection
	second := *connection
	results := make(chan error, 2)
	go func() { results <- first.Close() }()
	go func() { results <- second.Close() }()
	for range 2 {
		if err := <-results; !errors.Is(err, ErrCloseTimeout) {
			t.Fatalf("copied Close error = %v, want ErrCloseTimeout", err)
		}
	}
	connection.state.active.mu.Lock()
	if connection.state.active.drained != drained {
		connection.state.active.mu.Unlock()
		t.Fatal("copied Close timeouts replaced the shared activity drain")
	}
	connection.state.active.mu.Unlock()
	if closeCalls.Load() != 0 || connection.state.handle != handle {
		t.Fatalf("timed Close consumed handle=%d close calls=%d", connection.state.handle, closeCalls.Load())
	}

	finish()
	if err := second.Close(); err != nil {
		t.Fatalf("Close after activity drain = %v", err)
	}
	if connection.state.handle != 0 || closeCalls.Load() != 1 {
		t.Fatalf("drained retry handle=%d close calls=%d", connection.state.handle, closeCalls.Load())
	}
	if err := first.Close(); err != nil || closeCalls.Load() != 1 {
		t.Fatalf("idempotent copied Close = %v, close calls=%d", err, closeCalls.Load())
	}
}

func TestWindowsConnectionCloseRetriesPartialFailures(t *testing.T) {
	disconnectFailure := errors.New("injected disconnect failure")
	closeFailure := errors.New("injected CloseHandle failure")
	tests := []struct {
		name               string
		disconnectResult   func(int) error
		closeResult        func(int) error
		wantFirst          error
		wantDisconnectCall int
		wantCloseCall      int
	}{
		{
			name: "already disconnected after CloseHandle failure",
			disconnectResult: func(call int) error {
				if call == 2 {
					return windows.ERROR_PIPE_NOT_CONNECTED
				}
				return nil
			},
			closeResult: func(call int) error {
				if call == 1 {
					return closeFailure
				}
				return nil
			},
			wantFirst:          closeFailure,
			wantDisconnectCall: 2,
			wantCloseCall:      2,
		},
		{
			name: "no data after CloseHandle failure",
			disconnectResult: func(call int) error {
				if call == 2 {
					return windows.ERROR_NO_DATA
				}
				return nil
			},
			closeResult: func(call int) error {
				if call == 1 {
					return closeFailure
				}
				return nil
			},
			wantFirst:          closeFailure,
			wantDisconnectCall: 2,
			wantCloseCall:      2,
		},
		{
			name: "disconnect failure",
			disconnectResult: func(call int) error {
				if call == 1 {
					return disconnectFailure
				}
				return nil
			},
			closeResult:        func(int) error { return nil },
			wantFirst:          disconnectFailure,
			wantDisconnectCall: 2,
			wantCloseCall:      1,
		},
	}
	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			handle := windows.Handle(600 + index)
			connection := newConnection(
				handle,
				Options{CloseTimeout: time.Second},
				VerificationEvidence{},
			)
			cancelCalls := 0
			disconnectCalls := 0
			closeCalls := 0
			connection.state.cancelIO = func(got windows.Handle) error {
				if got != handle {
					t.Fatalf("cancel handle = %d, want %d", got, handle)
				}
				cancelCalls++
				return windows.ERROR_NOT_FOUND
			}
			connection.state.disconnect = func(got windows.Handle) error {
				if got != handle {
					t.Fatalf("disconnect handle = %d, want %d", got, handle)
				}
				disconnectCalls++
				return test.disconnectResult(disconnectCalls)
			}
			connection.state.closeHandle = func(got windows.Handle) error {
				if got != handle {
					t.Fatalf("close handle = %d, want %d", got, handle)
				}
				closeCalls++
				return test.closeResult(closeCalls)
			}

			copy := *connection
			if err := connection.Close(); !errors.Is(err, test.wantFirst) {
				t.Fatalf("first Close error = %v, want %v", err, test.wantFirst)
			}
			if connection.state.handle != handle || copy.state != connection.state {
				t.Fatalf(
					"first Close owner state=%p/%p handle=%d, want shared/%d",
					connection.state,
					copy.state,
					connection.state.handle,
					handle,
				)
			}
			if err := copy.Close(); err != nil {
				t.Fatalf("copied retry Close = %v", err)
			}
			if connection.state.handle != 0 || cancelCalls != 2 ||
				disconnectCalls != test.wantDisconnectCall || closeCalls != test.wantCloseCall {
				t.Fatalf(
					"retry handle=%d calls cancel/disconnect/close=%d/%d/%d",
					connection.state.handle,
					cancelCalls,
					disconnectCalls,
					closeCalls,
				)
			}
			if err := connection.Close(); err != nil {
				t.Fatalf("idempotent original Close = %v", err)
			}
			if cancelCalls != 2 || disconnectCalls != test.wantDisconnectCall ||
				closeCalls != test.wantCloseCall {
				t.Fatal("idempotent Close repeated native calls")
			}
		})
	}
}

func TestWindowsPostTransferFailureStagesUseActualConnectionOwner(t *testing.T) {
	deadlineCause := errors.New("startup deadline expired")
	tests := []struct {
		name          string
		configure     func(*fakeRetainedNode, *fakeRuntimeBootstrapChannel, context.CancelCauseFunc)
		wantActivated bool
	}{
		{
			name: "bootstrap write",
			configure: func(_ *fakeRetainedNode, channel *fakeRuntimeBootstrapChannel, _ context.CancelCauseFunc) {
				channel.failWriteCall = 1
			},
		},
		{
			name: "bootstrap acknowledgement",
			configure: func(_ *fakeRetainedNode, channel *fakeRuntimeBootstrapChannel, _ context.CancelCauseFunc) {
				channel.input = bytes.NewReader(nil)
			},
		},
		{
			name: "bootstrap acknowledgement deadline",
			configure: func(_ *fakeRetainedNode, channel *fakeRuntimeBootstrapChannel, cancel context.CancelCauseFunc) {
				channel.onReadCall = func(call int) {
					if call == 2 {
						cancel(deadlineCause)
					}
				}
			},
		},
		{
			name: "pre-activation identity",
			configure: func(node *fakeRetainedNode, _ *fakeRuntimeBootstrapChannel, _ context.CancelCauseFunc) {
				node.observations[0].StartKeySequenceNumber++
			},
		},
		{
			name: "pre-activation deadline",
			configure: func(node *fakeRetainedNode, _ *fakeRuntimeBootstrapChannel, cancel context.CancelCauseFunc) {
				node.onObserve = func(observation int) {
					if observation == 2 {
						cancel(deadlineCause)
					}
				}
			},
		},
		{
			name: "activation",
			configure: func(node *fakeRetainedNode, _ *fakeRuntimeBootstrapChannel, _ context.CancelCauseFunc) {
				node.activationError = errors.New("activation failed")
			},
		},
		{
			name: "pre-commit deadline",
			configure: func(node *fakeRetainedNode, _ *fakeRuntimeBootstrapChannel, cancel context.CancelCauseFunc) {
				node.onActivate = func() { cancel(deadlineCause) }
			},
			wantActivated: true,
		},
		{
			name: "commit write",
			configure: func(_ *fakeRetainedNode, channel *fakeRuntimeBootstrapChannel, _ context.CancelCauseFunc) {
				channel.failWriteCall = 3
			},
			wantActivated: true,
		},
		{
			name: "commit completion deadline",
			configure: func(_ *fakeRetainedNode, channel *fakeRuntimeBootstrapChannel, cancel context.CancelCauseFunc) {
				channel.onWriteCall = func(call int) {
					if call == 4 {
						cancel(deadlineCause)
					}
				}
			},
			wantActivated: true,
		},
	}

	for index, test := range tests {
		for _, closeFails := range []bool{false, true} {
			closeName := "close succeeds"
			if closeFails {
				closeName = "close fails"
			}
			t.Run(test.name+"/"+closeName, func(t *testing.T) {
				bootstrap, bootstrapDocument := hostControlBootstrapForTest(t)
				events := []string{}
				channel := hostControlBootstrapChannelForTest(t, bootstrapDocument, &events)
				node := newFakeRetainedNode(testNodeIdentity())
				node.events = &events
				ctx, cancel := context.WithCancelCause(context.Background())
				t.Cleanup(func() { cancel(nil) })
				test.configure(node, channel, cancel)

				_, primary := completeRuntimeBootstrap(
					ctx,
					channel,
					node,
					VerificationEvidence{NodeIdentity: node.stable},
					bootstrap,
				)
				if primary == nil {
					t.Fatal("completeRuntimeBootstrap unexpectedly succeeded")
				}
				if node.activated != test.wantActivated {
					t.Fatalf("Node activated = %v, want %v", node.activated, test.wantActivated)
				}

				handle := windows.Handle(1_000 + index)
				connection := newConnection(
					handle,
					Options{CloseTimeout: time.Second},
					VerificationEvidence{},
				)
				closeFailure := errors.New("injected post-transfer close failure")
				cancelCalls := 0
				disconnectCalls := 0
				closeCalls := 0
				connection.state.cancelIO = func(got windows.Handle) error {
					if !node.terminated {
						t.Fatal("Connection I/O was cancelled before Node termination")
					}
					if got != handle {
						t.Fatalf("cancel handle = %d, want %d", got, handle)
					}
					cancelCalls++
					return nil
				}
				connection.state.disconnect = func(got windows.Handle) error {
					if got != handle {
						t.Fatalf("disconnect handle = %d, want %d", got, handle)
					}
					disconnectCalls++
					return nil
				}
				connection.state.closeHandle = func(got windows.Handle) error {
					if got != handle {
						t.Fatalf("close handle = %d, want %d", got, handle)
					}
					closeCalls++
					if closeFails {
						return closeFailure
					}
					return nil
				}

				owner, resultErr := rejectPostTransferAcceptFailure(connection, primary, node)
				if !node.terminated || !errors.Is(resultErr, primary) ||
					!errors.Is(connection.state.terminal, primary) {
					t.Fatalf(
						"post-transfer cleanup terminated=%v terminal=%v result=%v",
						node.terminated,
						connection.state.terminal,
						resultErr,
					)
				}
				if cancelCalls != 2 || disconnectCalls != 1 || closeCalls != 1 {
					t.Fatalf(
						"cleanup calls cancel/disconnect/close=%d/%d/%d",
						cancelCalls,
						disconnectCalls,
						closeCalls,
					)
				}
				if closeFails {
					if owner == nil || owner != connection || owner.state != connection.state ||
						connection.state.handle != handle || !errors.Is(resultErr, closeFailure) {
						var ownerState *connectionState
						if owner != nil {
							ownerState = owner.state
						}
						t.Fatalf(
							"failed close owner=%p state=%p handle=%d result=%v",
							owner,
							ownerState,
							connection.state.handle,
							resultErr,
						)
					}
				} else if owner != nil || connection.state.handle != 0 || resultErr != primary {
					t.Fatalf(
						"successful close owner=%p handle=%d result=%v",
						owner,
						connection.state.handle,
						resultErr,
					)
				}
			})
		}
	}
}
