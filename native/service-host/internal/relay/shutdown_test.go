package relay

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/framing"
)

func TestRunRoleAwareControlCompletesOrderedShutdown(t *testing.T) {
	node := newRoleTestEndpoint()
	pipe := newRoleTestEndpoint()
	events := &roleEventLog{}
	node.events = events
	pipe.events = events
	drain := roleTestFrame(shutdownMessageDrain, 2, nil)
	drained := roleTestFrame(shutdownMessageDrained, 2, nil)
	authorizer := newRoleTestAuthorizer(drain, time.Now().Add(time.Second))

	node.reads <- roleTestRead{value: roleTestFrame(1, 1, []byte("local"))}
	node.reads <- roleTestRead{value: drain}
	node.reads <- roleTestRead{err: io.EOF}
	pipe.reads <- roleTestRead{value: roleTestFrame(8, 1, []byte("peer"))}

	result := runRoleTest(RoleControl, node, pipe, authorizer, roleTestOptions())
	if got := receiveRoleFrame(t, pipe.writes); string(got[framing.HeaderBytes:]) != "local" {
		t.Fatalf("first pipe payload = %q", got[framing.HeaderBytes:])
	}
	if got := receiveRoleFrame(t, pipe.writes); !bytes.Equal(got, drain) {
		t.Fatal("Control Drain was not the final local frame")
	}
	pipe.reads <- roleTestRead{value: drained}
	if got := receiveRoleFrame(t, node.writes); string(got[framing.HeaderBytes:]) != "peer" {
		t.Fatalf("first Node payload = %q", got[framing.HeaderBytes:])
	}
	if got := receiveRoleFrame(t, node.writes); !bytes.Equal(got, drained) {
		t.Fatal("Executor Drained was not delivered to Node")
	}
	if err := receiveRoleError(t, result); err != nil {
		t.Fatalf("RunRoleAware(Control) error = %v", err)
	}
	if authorizer.callCount() != 1 || node.closeWriteCount() != 1 || pipe.flushCount() != 1 {
		t.Fatalf(
			"calls: authorize=%d closeWrite=%d flush=%d",
			authorizer.callCount(),
			node.closeWriteCount(),
			pipe.flushCount(),
		)
	}
	if !events.before("node-close-write", "pipe-flush") {
		t.Fatalf("graceful close order = %v", events.snapshot())
	}
}

func TestRunRoleAwarePairedRelaysCompleteControlInitiatedShutdown(t *testing.T) {
	controlNode := newRoleTestEndpoint()
	executorNode := newRoleTestEndpoint()
	controlPipe, executorPipe := newPairedRolePipeEndpoints()
	drain := roleTestFrame(shutdownMessageDrain, 1, nil)
	drained := roleTestFrame(shutdownMessageDrained, 1, nil)
	controlAuthorizer := newRoleTestAuthorizer(drain, time.Now().Add(time.Second))
	executorAuthorizer := newRoleTestAuthorizer(drained, time.Now().Add(time.Second))
	controlAuthorizer.mutateInput = true
	executorAuthorizer.mutateInput = true

	controlResult := runRoleTest(RoleControl, controlNode, controlPipe, controlAuthorizer, roleTestOptions())
	executorResult := runRoleTest(RoleExecutor, executorNode, executorPipe, executorAuthorizer, roleTestOptions())
	controlNode.reads <- roleTestRead{value: drain}

	if got := receiveRoleFrame(t, executorNode.writes); !bytes.Equal(got, drain) {
		t.Fatal("paired Executor did not receive Control Drain")
	}
	waitRoleTestSignal(t, executorNode.closeWriteStarted)
	executorNode.reads <- roleTestRead{value: drained}
	executorNode.reads <- roleTestRead{err: io.EOF}

	if got := receiveRoleFrame(t, controlNode.writes); !bytes.Equal(got, drained) {
		t.Fatal("paired Control did not receive Executor Drained")
	}
	waitRoleTestSignal(t, controlNode.closeWriteStarted)
	controlNode.reads <- roleTestRead{err: io.EOF}

	if err := receiveRoleError(t, controlResult); err != nil {
		t.Fatalf("paired Control relay error = %v", err)
	}
	if err := receiveRoleError(t, executorResult); err != nil {
		t.Fatalf("paired Executor relay error = %v", err)
	}
	if controlAuthorizer.callCount() != 1 || executorAuthorizer.callCount() != 1 {
		t.Fatalf(
			"paired authorization calls: control=%d executor=%d",
			controlAuthorizer.callCount(),
			executorAuthorizer.callCount(),
		)
	}
	if controlNode.closeWriteCount() != 1 || executorNode.closeWriteCount() != 1 {
		t.Fatalf(
			"paired Node EOF calls: control=%d executor=%d",
			controlNode.closeWriteCount(),
			executorNode.closeWriteCount(),
		)
	}
	if controlPipe.flushCount() != 1 || executorPipe.flushCount() != 0 {
		t.Fatalf(
			"paired flush calls: control=%d executor=%d",
			controlPipe.flushCount(),
			executorPipe.flushCount(),
		)
	}
}

func TestRunRoleAwarePairedRelaysFailClosedOnArmAndNodeEOFFailures(t *testing.T) {
	tests := []struct {
		name               string
		authorizationError error
		nodeEOFError       error
		want               error
	}{
		{
			name:               "Executor Arm authorization",
			authorizationError: ErrUnauthorizedEOF,
			want:               ErrUnauthorizedEOF,
		},
		{
			name:         "Executor Node EOF",
			nodeEOFError: io.ErrUnexpectedEOF,
			want:         io.ErrUnexpectedEOF,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			controlNode := newRoleTestEndpoint()
			executorNode := newRoleTestEndpoint()
			controlPipe, executorPipe := newPairedRolePipeEndpoints()
			drain := roleTestFrame(shutdownMessageDrain, 1, nil)
			drained := roleTestFrame(shutdownMessageDrained, 1, nil)
			controlAuthorizer := newRoleTestAuthorizer(drain, time.Now().Add(time.Second))
			executorAuthorizer := newRoleTestAuthorizer(drained, time.Now().Add(time.Second))
			executorAuthorizer.err = test.authorizationError

			controlResult := runRoleTest(
				RoleControl, controlNode, controlPipe, controlAuthorizer, roleTestOptions(),
			)
			executorResult := runRoleTest(
				RoleExecutor, executorNode, executorPipe, executorAuthorizer, roleTestOptions(),
			)
			controlNode.reads <- roleTestRead{value: drain}
			if got := receiveRoleFrame(t, executorNode.writes); !bytes.Equal(got, drain) {
				t.Fatal("paired Executor did not receive Control Drain")
			}
			if test.nodeEOFError != nil {
				executorNode.reads <- roleTestRead{err: test.nodeEOFError}
			} else {
				executorNode.reads <- roleTestRead{value: drained}
				executorNode.reads <- roleTestRead{err: io.EOF}
			}

			executorErr := receiveRoleError(t, executorResult)
			if !errors.Is(executorErr, test.want) {
				t.Fatalf("paired Executor relay error = %v, want %v", executorErr, test.want)
			}
			controlErr := receiveRoleError(t, controlResult)
			if !errors.Is(controlErr, errPairedRolePipePeerClosed) {
				t.Fatalf(
					"paired Control relay error = %v, want peer-closed provenance",
					controlErr,
				)
			}
			assertNoRoleQueueOwnershipError(t, executorErr)
			assertNoRoleQueueOwnershipError(t, controlErr)
			waitRoleTestSignal(t, controlNode.closed)
			waitRoleTestSignal(t, executorNode.closed)
			waitRoleTestSignal(t, controlPipe.closed)
			waitRoleTestSignal(t, executorPipe.closed)
			select {
			case frame := <-controlNode.writes:
				t.Fatalf("failed paired shutdown delivered Drained to Control: %x", frame)
			default:
			}
		})
	}
}

func TestRunRoleAwarePairedRelaysRejectControlAuthorizationAfterDrained(t *testing.T) {
	authorizationFailure := errors.New("Control authorization rejected")
	tests := []struct {
		name      string
		configure func(*roleTestAuthorizer)
		want      error
	}{
		{
			name: "authorization rejection",
			configure: func(authorizer *roleTestAuthorizer) {
				authorizer.err = authorizationFailure
			},
			want: authorizationFailure,
		},
		{
			name: "authorization deadline",
			configure: func(authorizer *roleTestAuthorizer) {
				authorizer.deadline = time.Now().Add(-time.Millisecond)
			},
			want: ErrShutdownTimeout,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			controlNode := newRoleTestEndpoint()
			executorNode := newRoleTestEndpoint()
			controlPipe, executorPipe := newPairedRolePipeEndpoints()
			drain := roleTestFrame(shutdownMessageDrain, 1, nil)
			drained := roleTestFrame(shutdownMessageDrained, 1, nil)
			controlAuthorizer := newRoleTestAuthorizer(drain, time.Now().Add(time.Second))
			executorAuthorizer := newRoleTestAuthorizer(drained, time.Now().Add(time.Second))
			test.configure(controlAuthorizer)

			controlResult := runRoleTest(
				RoleControl, controlNode, controlPipe, controlAuthorizer, roleTestOptions(),
			)
			executorResult := runRoleTest(
				RoleExecutor, executorNode, executorPipe, executorAuthorizer, roleTestOptions(),
			)
			controlNode.reads <- roleTestRead{value: drain}
			if got := receiveRoleFrame(t, executorNode.writes); !bytes.Equal(got, drain) {
				t.Fatal("paired Executor did not receive Control Drain")
			}
			waitRoleTestSignal(t, executorNode.closeWriteStarted)
			executorNode.reads <- roleTestRead{value: drained}
			executorNode.reads <- roleTestRead{err: io.EOF}
			if got := receiveRoleFrame(t, controlNode.writes); !bytes.Equal(got, drained) {
				t.Fatal("paired Control did not receive Executor Drained")
			}
			waitRoleTestSignal(t, controlNode.closeWriteStarted)
			controlNode.reads <- roleTestRead{err: io.EOF}

			controlErr := receiveRoleError(t, controlResult)
			if !errors.Is(controlErr, test.want) {
				t.Fatalf("paired Control relay error = %v, want %v", controlErr, test.want)
			}
			executorErr := receiveRoleError(t, executorResult)
			if !errors.Is(executorErr, errPairedRolePipePeerClosed) {
				t.Fatalf(
					"paired Executor relay error = %v, want peer-closed provenance",
					executorErr,
				)
			}
			if controlPipe.flushCount() != 0 || executorPipe.flushCount() != 0 {
				t.Fatalf(
					"failed paired authorization flushed pipes: control=%d executor=%d",
					controlPipe.flushCount(),
					executorPipe.flushCount(),
				)
			}
			waitRoleTestSignal(t, controlPipe.closed)
			waitRoleTestSignal(t, executorPipe.closed)
			waitRoleTestSignal(t, controlNode.closed)
			waitRoleTestSignal(t, executorNode.closed)
			assertNoRoleQueueOwnershipError(t, controlErr)
			assertNoRoleQueueOwnershipError(t, executorErr)
		})
	}
}

func TestRunRoleAwareExecutorWaitsForServerEOFAndNeverFlushes(t *testing.T) {
	node := newRoleTestEndpoint()
	pipe := newRoleTestEndpoint()
	drained := roleTestFrame(shutdownMessageDrained, 2, nil)
	authorizer := newRoleTestAuthorizer(drained, time.Now().Add(time.Second))
	pipe.reads <- roleTestRead{value: roleTestFrame(1, 1, []byte("peer"))}
	pipe.reads <- roleTestRead{value: roleTestFrame(shutdownMessageDrain, 2, nil)}

	result := runRoleTest(RoleExecutor, node, pipe, authorizer, roleTestOptions())
	if got := receiveRoleFrame(t, node.writes); string(got[framing.HeaderBytes:]) != "peer" {
		t.Fatalf("first Node payload = %q", got[framing.HeaderBytes:])
	}
	if header, err := framing.ValidateFrame(receiveRoleFrame(t, node.writes), framing.MaximumFrameBytes); err != nil || header.MessageType != shutdownMessageDrain {
		t.Fatalf("Node Drain = (%+v, %v)", header, err)
	}
	waitRoleTestSignal(t, node.closeWriteStarted)

	node.reads <- roleTestRead{value: roleTestFrame(8, 1, []byte("local"))}
	node.reads <- roleTestRead{value: drained}
	node.reads <- roleTestRead{err: io.EOF}
	if got := receiveRoleFrame(t, pipe.writes); string(got[framing.HeaderBytes:]) != "local" {
		t.Fatalf("first pipe payload = %q", got[framing.HeaderBytes:])
	}
	if got := receiveRoleFrame(t, pipe.writes); !bytes.Equal(got, drained) {
		t.Fatal("Executor Drained was not delivered to the pipe")
	}
	select {
	case err := <-result:
		t.Fatalf("Executor completed before server EOF: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	pipe.reads <- roleTestRead{err: io.EOF}
	if err := receiveRoleError(t, result); err != nil {
		t.Fatalf("RunRoleAware(Executor) error = %v", err)
	}
	if pipe.flushCount() != 0 {
		t.Fatalf("Executor called FlushThenClose %d times", pipe.flushCount())
	}
	if authorizer.callCount() != 1 || node.closeWriteCount() != 1 {
		t.Fatalf(
			"calls: authorize=%d closeWrite=%d",
			authorizer.callCount(),
			node.closeWriteCount(),
		)
	}
}

func TestRunRoleAwareExecutorHoldsDrainedThroughCloseWriteAndAuthorization(t *testing.T) {
	node := newRoleTestEndpoint()
	pipe := newRoleTestEndpoint()
	releaseAuthorization := make(chan struct{})
	drained := roleTestFrame(shutdownMessageDrained, 1, nil)
	authorizer := newRoleTestAuthorizer(drained, time.Now().Add(time.Second))
	authorizer.block = releaseAuthorization
	pipe.reads <- roleTestRead{value: roleTestFrame(shutdownMessageDrain, 1, nil)}
	result := runRoleTest(RoleExecutor, node, pipe, authorizer, roleTestOptions())

	_ = receiveRoleFrame(t, node.writes)
	waitRoleTestSignal(t, node.closeWriteStarted)
	node.reads <- roleTestRead{value: drained}
	select {
	case <-authorizer.started:
		t.Fatal("Executor authorized Drained before literal Node EOF")
	case <-time.After(20 * time.Millisecond):
	}
	select {
	case frame := <-pipe.writes:
		t.Fatalf("Executor relayed Drained before literal Node EOF: %x", frame)
	case <-time.After(20 * time.Millisecond):
	}

	node.reads <- roleTestRead{err: io.EOF}
	waitRoleTestSignal(t, authorizer.started)
	select {
	case frame := <-pipe.writes:
		t.Fatalf("Executor relayed Drained before authorization completed: %x", frame)
	case <-time.After(20 * time.Millisecond):
	}
	close(releaseAuthorization)
	if got := receiveRoleFrame(t, pipe.writes); !bytes.Equal(got, drained) {
		t.Fatal("Executor did not relay Drained after authorization")
	}
	select {
	case frame := <-pipe.writes:
		t.Fatalf("Executor relayed Drained more than once: %x", frame)
	case <-time.After(20 * time.Millisecond):
	}
	pipe.reads <- roleTestRead{err: io.EOF}
	if err := receiveRoleError(t, result); err != nil {
		t.Fatalf("RunRoleAware error = %v", err)
	}
}

func TestRunRoleAwareControlForwardsDrainBeforeLiteralAuthorizedEOF(t *testing.T) {
	node := newRoleTestEndpoint()
	pipe := newRoleTestEndpoint()
	drain := roleTestFrame(shutdownMessageDrain, 1, nil)
	drained := roleTestFrame(shutdownMessageDrained, 1, nil)
	releaseAuthorization := make(chan struct{})
	authorizer := newRoleTestAuthorizer(drain, time.Now().Add(time.Second))
	authorizer.block = releaseAuthorization
	node.reads <- roleTestRead{value: drain}

	result := runRoleTest(RoleControl, node, pipe, authorizer, roleTestOptions())
	if got := receiveRoleFrame(t, pipe.writes); !bytes.Equal(got, drain) {
		t.Fatal("Control Drain was not forwarded before Node EOF")
	}
	select {
	case <-authorizer.started:
		t.Fatal("Control authorized EOF before Node emitted EOF")
	case <-time.After(20 * time.Millisecond):
	}
	pipe.reads <- roleTestRead{value: drained}
	if got := receiveRoleFrame(t, node.writes); !bytes.Equal(got, drained) {
		t.Fatal("Executor Drained was not delivered before Control EOF")
	}
	node.reads <- roleTestRead{err: io.EOF}
	waitRoleTestSignal(t, authorizer.started)
	select {
	case err := <-result:
		t.Fatalf("Control completed before EOF authorization: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(releaseAuthorization)
	if err := receiveRoleError(t, result); err != nil {
		t.Fatalf("RunRoleAware error = %v", err)
	}
}

func TestRunRoleAwareControlWaitsForDrainDeliveryBeforeAcceptingDrained(t *testing.T) {
	node := newRoleTestEndpoint()
	pipe := newRoleTestEndpoint()
	releaseWrite := make(chan struct{})
	pipe.writeBlock = releaseWrite
	drain := roleTestFrame(shutdownMessageDrain, 1, nil)
	drained := roleTestFrame(shutdownMessageDrained, 1, nil)
	authorizer := newRoleTestAuthorizer(drain, time.Now().Add(time.Second))
	node.reads <- roleTestRead{value: drain}

	result := runRoleTest(RoleControl, node, pipe, authorizer, roleTestOptions())
	waitRoleTestSignal(t, pipe.writeStarted)
	pipe.reads <- roleTestRead{value: drained}
	select {
	case frame := <-node.writes:
		t.Fatalf("Control accepted Drained before Drain delivery: %x", frame)
	case <-time.After(20 * time.Millisecond):
	}
	close(releaseWrite)
	if got := receiveRoleFrame(t, pipe.writes); !bytes.Equal(got, drain) {
		t.Fatal("Control did not deliver its exact Drain")
	}
	if got := receiveRoleFrame(t, node.writes); !bytes.Equal(got, drained) {
		t.Fatal("Control did not accept Drained after Drain delivery")
	}
	node.reads <- roleTestRead{err: io.EOF}
	if err := receiveRoleError(t, result); err != nil {
		t.Fatalf("RunRoleAware error = %v", err)
	}
}

func TestRunRoleAwareRejectsLocalEOFAndFinalFrameViolations(t *testing.T) {
	authorizationFailure := errors.New("authorization rejected")
	tests := []struct {
		name          string
		reads         []roleTestRead
		authorizer    func(*roleTestAuthorizer)
		want          error
		wantForwarded bool
	}{
		{
			name:  "EOF before final",
			reads: []roleTestRead{{err: io.EOF}},
			want:  ErrUnauthorizedEOF,
		},
		{
			name: "wrong role final",
			reads: []roleTestRead{
				{value: roleTestFrame(shutdownMessageDrained, 1, nil)},
			},
			want: ErrInvalidFinalFrame,
		},
		{
			name: "frame after final",
			reads: []roleTestRead{
				{value: roleTestFrame(shutdownMessageDrain, 1, nil)},
				{value: roleTestFrame(1, 2, nil)},
			},
			want:          ErrShutdownProtocol,
			wantForwarded: true,
		},
		{
			name: "wrapped EOF",
			reads: []roleTestRead{
				{value: roleTestFrame(shutdownMessageDrain, 1, nil)},
				{err: fmt.Errorf("wrapped: %w", io.EOF)},
			},
			want:          io.EOF,
			wantForwarded: true,
		},
		{
			name: "bytes with EOF",
			reads: []roleTestRead{
				{value: roleTestFrame(shutdownMessageDrain, 1, nil)},
				{value: []byte{1}, err: io.EOF},
			},
			want:          io.EOF,
			wantForwarded: true,
		},
		{
			name: "sequence gap",
			reads: []roleTestRead{
				{value: roleTestFrame(1, 2, nil)},
			},
			want: ErrShutdownProtocol,
		},
		{
			name: "authorization failure",
			reads: []roleTestRead{
				{value: roleTestFrame(shutdownMessageDrain, 1, nil)},
				{err: io.EOF},
			},
			authorizer: func(authorizer *roleTestAuthorizer) {
				authorizer.err = authorizationFailure
			},
			want:          authorizationFailure,
			wantForwarded: true,
		},
		{
			name: "expired authorization result",
			reads: []roleTestRead{
				{value: roleTestFrame(shutdownMessageDrain, 1, nil)},
				{err: io.EOF},
			},
			authorizer: func(authorizer *roleTestAuthorizer) {
				authorizer.deadline = time.Now().Add(-time.Millisecond)
			},
			want:          ErrShutdownTimeout,
			wantForwarded: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			node := newRoleTestEndpoint()
			pipe := newRoleTestEndpoint()
			for _, read := range test.reads {
				node.reads <- read
			}
			final := roleTestFrame(shutdownMessageDrain, 1, nil)
			authorizer := newRoleTestAuthorizer(final, time.Now().Add(time.Second))
			if test.authorizer != nil {
				test.authorizer(authorizer)
			}
			err := receiveRoleError(
				t,
				runRoleTest(RoleControl, node, pipe, authorizer, roleTestOptions()),
			)
			if !errors.Is(err, test.want) {
				t.Fatalf("RunRoleAware error = %v, want %v", err, test.want)
			}
			if test.wantForwarded {
				if frame := receiveRoleFrame(t, pipe.writes); !bytes.Equal(frame, final) {
					t.Fatalf("Control forwarded frame = %x, want Drain", frame)
				}
			} else {
				select {
				case frame := <-pipe.writes:
					t.Fatalf("invalid local frame was relayed: %x", frame)
				default:
				}
			}
			if test.name != "authorization failure" && test.name != "expired authorization result" &&
				authorizer.callCount() != 0 {
				t.Fatalf("authorization calls = %d", authorizer.callCount())
			}
		})
	}
}

func TestRunRoleAwareRejectsPipeEOFAndRoleOrderViolations(t *testing.T) {
	t.Run("Control rejects Drained before Drain", func(t *testing.T) {
		node := newRoleTestEndpoint()
		pipe := newRoleTestEndpoint()
		pipe.reads <- roleTestRead{value: roleTestFrame(shutdownMessageDrained, 1, nil)}
		err := receiveRoleError(t, runRoleTest(
			RoleControl,
			node,
			pipe,
			newRoleTestAuthorizer(nil, time.Now().Add(time.Second)),
			roleTestOptions(),
		))
		if !errors.Is(err, ErrShutdownProtocol) {
			t.Fatalf("RunRoleAware error = %v", err)
		}
	})

	t.Run("Control rejects client EOF", func(t *testing.T) {
		node := newRoleTestEndpoint()
		pipe := newRoleTestEndpoint()
		drain := roleTestFrame(shutdownMessageDrain, 1, nil)
		node.reads <- roleTestRead{value: drain}
		node.reads <- roleTestRead{err: io.EOF}
		pipe.reads <- roleTestRead{err: io.EOF}
		err := receiveRoleError(t, runRoleTest(
			RoleControl,
			node,
			pipe,
			newRoleTestAuthorizer(drain, time.Now().Add(time.Second)),
			roleTestOptions(),
		))
		if !errors.Is(err, ErrUnexpectedPipeEOF) {
			t.Fatalf("RunRoleAware error = %v", err)
		}
	})

	t.Run("Executor rejects Drained before Drain", func(t *testing.T) {
		node := newRoleTestEndpoint()
		pipe := newRoleTestEndpoint()
		node.reads <- roleTestRead{value: roleTestFrame(shutdownMessageDrained, 1, nil)}
		err := receiveRoleError(t, runRoleTest(
			RoleExecutor,
			node,
			pipe,
			newRoleTestAuthorizer(nil, time.Now().Add(time.Second)),
			roleTestOptions(),
		))
		if !errors.Is(err, ErrShutdownProtocol) {
			t.Fatalf("RunRoleAware error = %v", err)
		}
	})

	t.Run("Executor rejects server EOF before Drained", func(t *testing.T) {
		node := newRoleTestEndpoint()
		pipe := newRoleTestEndpoint()
		pipe.reads <- roleTestRead{value: roleTestFrame(shutdownMessageDrain, 1, nil)}
		pipe.reads <- roleTestRead{err: io.EOF}
		err := receiveRoleError(t, runRoleTest(
			RoleExecutor,
			node,
			pipe,
			newRoleTestAuthorizer(nil, time.Now().Add(time.Second)),
			roleTestOptions(),
		))
		if !errors.Is(err, ErrUnexpectedPipeEOF) {
			t.Fatalf("RunRoleAware error = %v", err)
		}
		if pipe.flushCount() != 0 {
			t.Fatal("Executor flushed its client pipe after early EOF")
		}
	})
}

func TestRunRoleAwareEnforcesHardAndAuthorizationDeadlines(t *testing.T) {
	t.Run("hard cap interrupts pending authorization", func(t *testing.T) {
		node := newRoleTestEndpoint()
		pipe := newRoleTestEndpoint()
		drain := roleTestFrame(shutdownMessageDrain, 1, nil)
		blocked := make(chan struct{})
		authorizer := newRoleTestAuthorizer(drain, time.Now().Add(time.Second))
		authorizer.block = blocked
		node.reads <- roleTestRead{value: drain}
		node.reads <- roleTestRead{err: io.EOF}
		options := roleTestOptions()
		options.ShutdownTimeout = 30 * time.Millisecond

		err := receiveRoleError(t, runRoleTest(RoleControl, node, pipe, authorizer, options))
		if !errors.Is(err, ErrShutdownTimeout) {
			t.Fatalf("RunRoleAware error = %v, want shutdown timeout", err)
		}
		if frame := receiveRoleFrame(t, pipe.writes); !bytes.Equal(frame, drain) {
			t.Fatalf("Control forwarded frame = %x, want Drain", frame)
		}
	})

	t.Run("authorization deadline tightens hard cap", func(t *testing.T) {
		node := newRoleTestEndpoint()
		pipe := newRoleTestEndpoint()
		drain := roleTestFrame(shutdownMessageDrain, 1, nil)
		authorizer := newRoleTestAuthorizer(drain, time.Now().Add(40*time.Millisecond))
		node.reads <- roleTestRead{value: drain}
		node.reads <- roleTestRead{err: io.EOF}

		started := time.Now()
		err := receiveRoleError(
			t,
			runRoleTest(RoleControl, node, pipe, authorizer, roleTestOptions()),
		)
		if !errors.Is(err, ErrShutdownTimeout) {
			t.Fatalf("RunRoleAware error = %v, want shutdown timeout", err)
		}
		if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
			t.Fatalf("authorization deadline did not tighten shutdown: %v", elapsed)
		}
	})
}

func TestRunRoleAwareControlFlushesOnlyAfterNodeWriteClose(t *testing.T) {
	node := newRoleTestEndpoint()
	pipe := newRoleTestEndpoint()
	releaseCloseWrite := make(chan struct{})
	node.closeWriteBlock = releaseCloseWrite
	drain := roleTestFrame(shutdownMessageDrain, 1, nil)
	drained := roleTestFrame(shutdownMessageDrained, 1, nil)
	node.reads <- roleTestRead{value: drain}
	node.reads <- roleTestRead{err: io.EOF}
	authorizer := newRoleTestAuthorizer(drain, time.Now().Add(time.Second))
	result := runRoleTest(RoleControl, node, pipe, authorizer, roleTestOptions())
	_ = receiveRoleFrame(t, pipe.writes)
	pipe.reads <- roleTestRead{value: drained}
	_ = receiveRoleFrame(t, node.writes)
	waitRoleTestSignal(t, node.closeWriteStarted)
	select {
	case <-pipe.flushStarted:
		t.Fatal("Control flushed the server pipe before Node CloseWrite completed")
	case <-time.After(20 * time.Millisecond):
	}
	close(releaseCloseWrite)
	if err := receiveRoleError(t, result); err != nil {
		t.Fatalf("RunRoleAware error = %v", err)
	}
}

func TestRunRoleAwarePropagatesGracefulCloseFailures(t *testing.T) {
	t.Run("Node CloseWrite", func(t *testing.T) {
		closeFailure := errors.New("Node CloseWrite failed")
		node := newRoleTestEndpoint()
		pipe := newRoleTestEndpoint()
		node.closeWriteError = closeFailure
		drain := roleTestFrame(shutdownMessageDrain, 1, nil)
		node.reads <- roleTestRead{value: drain}
		node.reads <- roleTestRead{err: io.EOF}
		result := runRoleTest(
			RoleControl,
			node,
			pipe,
			newRoleTestAuthorizer(drain, time.Now().Add(time.Second)),
			roleTestOptions(),
		)
		_ = receiveRoleFrame(t, pipe.writes)
		pipe.reads <- roleTestRead{value: roleTestFrame(shutdownMessageDrained, 1, nil)}
		_ = receiveRoleFrame(t, node.writes)
		err := receiveRoleError(t, result)
		if !errors.Is(err, closeFailure) {
			t.Fatalf("RunRoleAware error = %v", err)
		}
		if pipe.flushCount() != 0 {
			t.Fatal("Control flushed after Node CloseWrite failed")
		}
	})

	t.Run("server FlushThenClose", func(t *testing.T) {
		flushFailure := errors.New("server flush failed")
		node := newRoleTestEndpoint()
		pipe := newRoleTestEndpoint()
		pipe.flushError = flushFailure
		drain := roleTestFrame(shutdownMessageDrain, 1, nil)
		node.reads <- roleTestRead{value: drain}
		node.reads <- roleTestRead{err: io.EOF}
		result := runRoleTest(
			RoleControl,
			node,
			pipe,
			newRoleTestAuthorizer(drain, time.Now().Add(time.Second)),
			roleTestOptions(),
		)
		_ = receiveRoleFrame(t, pipe.writes)
		pipe.reads <- roleTestRead{value: roleTestFrame(shutdownMessageDrained, 1, nil)}
		_ = receiveRoleFrame(t, node.writes)
		err := receiveRoleError(t, result)
		if !errors.Is(err, flushFailure) || pipe.flushCount() != 1 {
			t.Fatalf("RunRoleAware error = %v, flush calls = %d", err, pipe.flushCount())
		}
	})
}

func TestRunRoleAwareRejectsPostFinalPeerFrame(t *testing.T) {
	node := newRoleTestEndpoint()
	pipe := newRoleTestEndpoint()
	pipe.reads <- roleTestRead{value: roleTestFrame(shutdownMessageDrain, 1, nil)}
	pipe.reads <- roleTestRead{value: roleTestFrame(1, 2, nil)}
	err := receiveRoleError(t, runRoleTest(
		RoleExecutor,
		node,
		pipe,
		newRoleTestAuthorizer(nil, time.Now().Add(time.Second)),
		roleTestOptions(),
	))
	if !errors.Is(err, ErrShutdownProtocol) {
		t.Fatalf("RunRoleAware error = %v", err)
	}
	if pipe.flushCount() != 0 {
		t.Fatal("Executor flushed after a post-final peer frame")
	}
}

func TestRunRoleAwareBoundsAbortiveCleanup(t *testing.T) {
	node := newRoleTestEndpoint()
	pipe := newRoleTestEndpoint()
	releaseClose := make(chan struct{})
	node.closeBlock = releaseClose
	node.reads <- roleTestRead{err: io.EOF}
	options := roleTestOptions()
	options.ShutdownTimeout = 30 * time.Millisecond

	err := receiveRoleError(t, runRoleTest(
		RoleControl,
		node,
		pipe,
		newRoleTestAuthorizer(nil, time.Now().Add(time.Second)),
		options,
	))
	if !errors.Is(err, ErrUnauthorizedEOF) || !errors.Is(err, ErrShutdownTimeout) {
		t.Fatalf("RunRoleAware error = %v", err)
	}
	close(releaseClose)
	waitRoleTestSignal(t, node.closed)
}

func TestRunRoleAwareSuccessCloseCannotExtendHardCap(t *testing.T) {
	node := newRoleTestEndpoint()
	pipe := newRoleTestEndpoint()
	releaseClose := make(chan struct{})
	node.closeBlock = releaseClose
	drain := roleTestFrame(shutdownMessageDrain, 1, nil)
	node.reads <- roleTestRead{value: drain}
	node.reads <- roleTestRead{err: io.EOF}
	options := roleTestOptions()
	options.ShutdownTimeout = 60 * time.Millisecond
	authorizer := newRoleTestAuthorizer(drain, time.Now().Add(time.Second))
	started := time.Now()
	result := runRoleTest(RoleControl, node, pipe, authorizer, options)
	_ = receiveRoleFrame(t, pipe.writes)
	pipe.reads <- roleTestRead{value: roleTestFrame(shutdownMessageDrained, 1, nil)}
	_ = receiveRoleFrame(t, node.writes)
	err := receiveRoleError(t, result)
	if !errors.Is(err, ErrShutdownTimeout) {
		t.Fatalf("RunRoleAware error = %v", err)
	}
	if elapsed := time.Since(started); elapsed > 300*time.Millisecond {
		t.Fatalf("successful protocol cleanup extended the hard cap: %v", elapsed)
	}
	close(releaseClose)
	waitRoleTestSignal(t, node.closed)
}

func TestRoleFinalOutcomeObservesCancellationAfterBudgetFinish(t *testing.T) {
	budget := newShutdownBudget()
	if err := budget.Begin(time.Second); err != nil {
		t.Fatal(err)
	}
	if err := budget.Finish(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancelCause(context.Background())
	cause := errors.New("service stop at finalization")
	cancel(cause)
	var failureMu sync.Mutex
	var failure error
	if err := roleFinalOutcome(ctx, &failureMu, &failure, nil); !errors.Is(err, cause) {
		t.Fatalf("final outcome = %v, want cancellation", err)
	}
}

func TestRunRoleAwareAbortIncludesConcurrentParentCause(t *testing.T) {
	node := newRoleTestEndpoint()
	pipe := newRoleTestEndpoint()
	releaseClose := make(chan struct{})
	node.closeBlock = releaseClose
	node.reads <- roleTestRead{value: roleTestFrame(1, 2, nil)}
	ctx, cancel := context.WithCancelCause(context.Background())
	result := make(chan error, 1)
	go func() {
		result <- RunRoleAware(
			ctx,
			RoleControl,
			node,
			pipe,
			newRoleTestAuthorizer(nil, time.Now().Add(time.Second)),
			roleTestOptions(),
		)
	}()
	waitRoleTestSignal(t, pipe.closed)
	parentCause := errors.New("concurrent service stop")
	cancel(parentCause)
	close(releaseClose)
	err := receiveRoleError(t, result)
	if !errors.Is(err, ErrShutdownProtocol) || !errors.Is(err, parentCause) {
		t.Fatalf("RunRoleAware error = %v", err)
	}
}

func TestShutdownBudgetAbortFreezesDeadline(t *testing.T) {
	budget := newShutdownBudget()
	if err := budget.Begin(time.Second); err != nil {
		t.Fatal(err)
	}
	budget.Abort()
	if err := budget.Tighten(time.Now().Add(time.Millisecond)); !errors.Is(err, ErrShutdownDeadline) {
		t.Fatalf("Tighten after Abort = %v", err)
	}
	wait, err := budget.Remaining(time.Second)
	if err != nil || wait < 500*time.Millisecond {
		t.Fatalf("frozen cleanup wait = (%v, %v)", wait, err)
	}
}

func TestRunRoleAwareRejectsInvalidOptions(t *testing.T) {
	node := newRoleTestEndpoint()
	pipe := newRoleTestEndpoint()
	authorizer := newRoleTestAuthorizer(nil, time.Now().Add(time.Second))
	if err := RunRoleAware(context.Background(), Role("other"), node, pipe, authorizer, roleTestOptions()); !errors.Is(err, ErrInvalidRole) {
		t.Fatalf("invalid role error = %v", err)
	}
	options := roleTestOptions()
	options.MaximumQueuedBytesPerDirection = framing.MaximumFrameBytes - 1
	if err := RunRoleAware(context.Background(), RoleControl, node, pipe, authorizer, options); !errors.Is(err, ErrInvalidQueue) {
		t.Fatalf("small queue error = %v", err)
	}
	var nilAuthorizer *roleTestAuthorizer
	if err := RunRoleAware(context.Background(), RoleControl, node, pipe, nilAuthorizer, roleTestOptions()); err == nil {
		t.Fatal("typed nil authorizer was accepted")
	}
	plainPipe := &plainRoleTestEndpoint{inner: newRoleTestEndpoint()}
	if err := RunRoleAware(context.Background(), RoleControl, node, plainPipe, authorizer, roleTestOptions()); err == nil {
		t.Fatal("Control accepted a pipe without FlushThenClose")
	}
}

type roleTestRead struct {
	value []byte
	err   error
}

var errPairedRolePipePeerClosed = errors.New("paired role pipe peer closed")

type roleTestEndpoint struct {
	reads             chan roleTestRead
	writes            chan []byte
	closed            chan struct{}
	closeWriteStarted chan struct{}
	flushStarted      chan struct{}
	writeStarted      chan struct{}
	closeOnce         sync.Once
	closeWriteOnce    sync.Once
	flushOnce         sync.Once
	writeStartOnce    sync.Once

	mu              sync.Mutex
	closeCalls      int
	closeWriteCalls int
	flushCalls      int
	closeError      error
	closeWriteError error
	flushError      error
	writeError      error
	writeBlock      <-chan struct{}
	closeBlock      <-chan struct{}
	closeWriteBlock <-chan struct{}
	flushBlock      <-chan struct{}
	events          *roleEventLog
}

type plainRoleTestEndpoint struct {
	inner *roleTestEndpoint
}

type pairedRolePipeEndpoint struct {
	incoming   chan roleTestRead
	closed     chan struct{}
	peerClosed chan struct{}
	peer       *pairedRolePipeEndpoint

	mu         sync.Mutex
	closeOnce  sync.Once
	flushOnce  sync.Once
	flushCalls int
}

func (endpoint *plainRoleTestEndpoint) ReadFrame(ctx context.Context) ([]byte, error) {
	return endpoint.inner.ReadFrame(ctx)
}

func (endpoint *plainRoleTestEndpoint) WriteFrame(ctx context.Context, value []byte) error {
	return endpoint.inner.WriteFrame(ctx, value)
}

func (endpoint *plainRoleTestEndpoint) Close() error {
	return endpoint.inner.Close()
}

func newPairedRolePipeEndpoints() (*pairedRolePipeEndpoint, *pairedRolePipeEndpoint) {
	control := &pairedRolePipeEndpoint{
		incoming:   make(chan roleTestRead, 16),
		closed:     make(chan struct{}),
		peerClosed: make(chan struct{}),
	}
	executor := &pairedRolePipeEndpoint{
		incoming:   make(chan roleTestRead, 16),
		closed:     make(chan struct{}),
		peerClosed: make(chan struct{}),
	}
	control.peer = executor
	executor.peer = control
	return control, executor
}

func (endpoint *pairedRolePipeEndpoint) ReadFrame(ctx context.Context) ([]byte, error) {
	read := func(result roleTestRead) ([]byte, error) {
		return append([]byte(nil), result.value...), result.err
	}
	select {
	case result := <-endpoint.incoming:
		return read(result)
	default:
	}
	select {
	case result := <-endpoint.incoming:
		return read(result)
	case <-ctx.Done():
		return nil, context.Cause(ctx)
	case <-endpoint.closed:
		return nil, io.ErrClosedPipe
	case <-endpoint.peerClosed:
		select {
		case result := <-endpoint.incoming:
			return read(result)
		default:
			return nil, errPairedRolePipePeerClosed
		}
	}
}

func (endpoint *pairedRolePipeEndpoint) WriteFrame(ctx context.Context, value []byte) error {
	if endpoint.peer == nil {
		return io.ErrClosedPipe
	}
	select {
	case endpoint.peer.incoming <- roleTestRead{value: append([]byte(nil), value...)}:
		return nil
	case <-ctx.Done():
		return context.Cause(ctx)
	case <-endpoint.closed:
		return io.ErrClosedPipe
	case <-endpoint.peer.closed:
		return io.ErrClosedPipe
	}
}

func (endpoint *pairedRolePipeEndpoint) FlushThenClose(ctx context.Context) error {
	if endpoint.peer == nil {
		return io.ErrClosedPipe
	}
	var flushErr error
	called := false
	endpoint.flushOnce.Do(func() {
		called = true
		endpoint.mu.Lock()
		endpoint.flushCalls++
		endpoint.mu.Unlock()
		select {
		case endpoint.peer.incoming <- roleTestRead{err: io.EOF}:
		case <-ctx.Done():
			flushErr = context.Cause(ctx)
		case <-endpoint.closed:
			flushErr = io.ErrClosedPipe
		case <-endpoint.peer.closed:
			flushErr = io.ErrClosedPipe
		}
	})
	if !called && flushErr == nil {
		return errors.New("paired pipe was flushed more than once")
	}
	return flushErr
}

func (endpoint *pairedRolePipeEndpoint) Close() error {
	endpoint.closeOnce.Do(func() {
		close(endpoint.closed)
		if endpoint.peer != nil {
			close(endpoint.peer.peerClosed)
		}
	})
	return nil
}

func (endpoint *pairedRolePipeEndpoint) flushCount() int {
	endpoint.mu.Lock()
	defer endpoint.mu.Unlock()
	return endpoint.flushCalls
}

func newRoleTestEndpoint() *roleTestEndpoint {
	return &roleTestEndpoint{
		reads:             make(chan roleTestRead, 16),
		writes:            make(chan []byte, 16),
		closed:            make(chan struct{}),
		closeWriteStarted: make(chan struct{}),
		flushStarted:      make(chan struct{}),
		writeStarted:      make(chan struct{}),
	}
}

func (endpoint *roleTestEndpoint) ReadFrame(ctx context.Context) ([]byte, error) {
	select {
	case result := <-endpoint.reads:
		return append([]byte(nil), result.value...), result.err
	case <-ctx.Done():
		return nil, context.Cause(ctx)
	case <-endpoint.closed:
		return nil, io.ErrClosedPipe
	}
}

func (endpoint *roleTestEndpoint) WriteFrame(ctx context.Context, value []byte) error {
	endpoint.writeStartOnce.Do(func() { close(endpoint.writeStarted) })
	endpoint.mu.Lock()
	writeError := endpoint.writeError
	writeBlock := endpoint.writeBlock
	endpoint.mu.Unlock()
	if writeError != nil {
		return writeError
	}
	if writeBlock != nil {
		select {
		case <-writeBlock:
		case <-ctx.Done():
			return context.Cause(ctx)
		case <-endpoint.closed:
			return io.ErrClosedPipe
		}
	}
	select {
	case endpoint.writes <- append([]byte(nil), value...):
		return nil
	case <-ctx.Done():
		return context.Cause(ctx)
	case <-endpoint.closed:
		return io.ErrClosedPipe
	}
}

func (endpoint *roleTestEndpoint) CloseWrite(ctx context.Context) error {
	endpoint.mu.Lock()
	endpoint.closeWriteCalls++
	block := endpoint.closeWriteBlock
	err := endpoint.closeWriteError
	events := endpoint.events
	endpoint.mu.Unlock()
	endpoint.closeWriteOnce.Do(func() { close(endpoint.closeWriteStarted) })
	if events != nil {
		events.add("node-close-write")
	}
	if block != nil {
		select {
		case <-block:
		case <-ctx.Done():
			return context.Cause(ctx)
		}
	}
	return err
}

func (endpoint *roleTestEndpoint) FlushThenClose(ctx context.Context) error {
	endpoint.mu.Lock()
	endpoint.flushCalls++
	block := endpoint.flushBlock
	err := endpoint.flushError
	events := endpoint.events
	endpoint.mu.Unlock()
	endpoint.flushOnce.Do(func() { close(endpoint.flushStarted) })
	if events != nil {
		events.add("pipe-flush")
	}
	if block != nil {
		select {
		case <-block:
		case <-ctx.Done():
			return context.Cause(ctx)
		}
	}
	return err
}

func (endpoint *roleTestEndpoint) Close() error {
	endpoint.mu.Lock()
	endpoint.closeCalls++
	block := endpoint.closeBlock
	err := endpoint.closeError
	endpoint.mu.Unlock()
	if block != nil {
		<-block
	}
	endpoint.closeOnce.Do(func() { close(endpoint.closed) })
	return err
}

func (endpoint *roleTestEndpoint) closeWriteCount() int {
	endpoint.mu.Lock()
	defer endpoint.mu.Unlock()
	return endpoint.closeWriteCalls
}

func (endpoint *roleTestEndpoint) flushCount() int {
	endpoint.mu.Lock()
	defer endpoint.mu.Unlock()
	return endpoint.flushCalls
}

type roleTestAuthorizer struct {
	mu          sync.Mutex
	expected    []byte
	deadline    time.Time
	err         error
	block       <-chan struct{}
	mutateInput bool
	started     chan struct{}
	once        sync.Once
	calls       int
}

func newRoleTestAuthorizer(expected []byte, deadline time.Time) *roleTestAuthorizer {
	return &roleTestAuthorizer{
		expected: append([]byte(nil), expected...),
		deadline: deadline,
		started:  make(chan struct{}),
	}
}

func (authorizer *roleTestAuthorizer) AuthorizeArwxEOF(
	ctx context.Context,
	finalFrame []byte,
) (time.Time, error) {
	authorizer.mu.Lock()
	authorizer.calls++
	expected := append([]byte(nil), authorizer.expected...)
	deadline := authorizer.deadline
	err := authorizer.err
	block := authorizer.block
	mutateInput := authorizer.mutateInput
	authorizer.mu.Unlock()
	authorizer.once.Do(func() { close(authorizer.started) })
	if block != nil {
		select {
		case <-block:
		case <-ctx.Done():
			return time.Time{}, context.Cause(ctx)
		}
	}
	if !bytes.Equal(finalFrame, expected) {
		return time.Time{}, errors.New("unexpected final frame")
	}
	if mutateInput && len(finalFrame) != 0 {
		finalFrame[0] ^= 0xff
	}
	if err != nil {
		return time.Time{}, err
	}
	return deadline, nil
}

func (authorizer *roleTestAuthorizer) callCount() int {
	authorizer.mu.Lock()
	defer authorizer.mu.Unlock()
	return authorizer.calls
}

type roleEventLog struct {
	mu     sync.Mutex
	values []string
}

func (events *roleEventLog) add(value string) {
	events.mu.Lock()
	events.values = append(events.values, value)
	events.mu.Unlock()
}

func (events *roleEventLog) snapshot() []string {
	events.mu.Lock()
	defer events.mu.Unlock()
	return append([]string(nil), events.values...)
}

func (events *roleEventLog) before(first, second string) bool {
	values := events.snapshot()
	firstIndex := -1
	secondIndex := -1
	for index, value := range values {
		if value == first && firstIndex < 0 {
			firstIndex = index
		}
		if value == second && secondIndex < 0 {
			secondIndex = index
		}
	}
	return firstIndex >= 0 && secondIndex > firstIndex
}

func roleTestFrame(messageType uint16, sequence uint64, payload []byte) []byte {
	value := make([]byte, framing.HeaderBytes+len(payload))
	copy(value[0:4], framing.Magic)
	binary.LittleEndian.PutUint16(value[4:6], framing.HeaderBytes)
	binary.LittleEndian.PutUint16(value[6:8], framing.MajorVersion)
	binary.LittleEndian.PutUint16(value[8:10], framing.MinorVersion)
	binary.LittleEndian.PutUint16(value[10:12], messageType)
	binary.LittleEndian.PutUint32(value[16:20], uint32(len(payload)))
	binary.LittleEndian.PutUint64(value[20:28], sequence)
	copy(value[framing.HeaderBytes:], payload)
	return value
}

func roleTestOptions() Options {
	return Options{
		MaximumQueuedBytesPerDirection: framing.MaximumFrameBytes,
		ShutdownTimeout:                time.Second,
	}
}

func runRoleTest(
	role Role,
	node NodeEndpoint,
	pipe Endpoint,
	authorizer ArwxEOFAuthorizer,
	options Options,
) <-chan error {
	result := make(chan error, 1)
	go func() {
		result <- RunRoleAware(context.Background(), role, node, pipe, authorizer, options)
	}()
	return result
}

func receiveRoleFrame(t *testing.T, frames <-chan []byte) []byte {
	t.Helper()
	select {
	case frame := <-frames:
		return frame
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for role-aware relay frame")
		return nil
	}
}

func receiveRoleError(t *testing.T, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for role-aware relay result")
		return nil
	}
}

func waitRoleTestSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for role-aware relay signal")
	}
}

func assertNoRoleQueueOwnershipError(t *testing.T, err error) {
	t.Helper()
	if err != nil && strings.Contains(err.Error(), "queue ownership remained") {
		t.Fatalf("role-aware relay retained queue ownership: %v", err)
	}
}

var (
	_ NodeEndpoint        = (*roleTestEndpoint)(nil)
	_ ControlPipeEndpoint = (*roleTestEndpoint)(nil)
	_ ControlPipeEndpoint = (*pairedRolePipeEndpoint)(nil)
	_ ArwxEOFAuthorizer   = (*roleTestAuthorizer)(nil)
	_ Endpoint            = (*plainRoleTestEndpoint)(nil)
)
