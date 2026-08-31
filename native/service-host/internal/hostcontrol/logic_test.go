package hostcontrol

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winprocess"
)

type fakePIDObserver struct {
	values []uint32
	err    error
	index  int
}

func (o *fakePIDObserver) ClientProcessID() (uint32, error) {
	if o.err != nil {
		return 0, o.err
	}
	if o.index >= len(o.values) {
		return 0, errors.New("unexpected client PID observation")
	}
	value := o.values[o.index]
	o.index++
	return value, nil
}

type fakeRetainedNode struct {
	processID        uint32
	stable           winprocess.NodeIdentity
	observations     []winprocess.NodeIdentity
	observeError     error
	counts           []uint32
	countError       error
	activationError  error
	terminationError error
	activated        bool
	terminated       bool
	events           *[]string
	observeIndex     int
	countIndex       int
	onObserve        func(int)
	onActivate       func()
}

func (n *fakeRetainedNode) ProcessID() uint32 {
	return n.processID
}

func (n *fakeRetainedNode) StableIdentity() winprocess.NodeIdentity {
	return n.stable
}

func (n *fakeRetainedNode) ObserveIdentity() (winprocess.NodeIdentity, error) {
	if n.observeError != nil {
		return winprocess.NodeIdentity{}, n.observeError
	}
	if n.observeIndex >= len(n.observations) {
		return winprocess.NodeIdentity{}, errors.New("unexpected Node identity observation")
	}
	value := n.observations[n.observeIndex]
	n.observeIndex++
	if n.onObserve != nil {
		n.onObserve(n.observeIndex)
	}
	return value, nil
}

func (n *fakeRetainedNode) RootJobActiveProcessCount() (uint32, error) {
	if n.countError != nil {
		return 0, n.countError
	}
	if n.countIndex >= len(n.counts) {
		return 0, errors.New("unexpected root Job observation")
	}
	value := n.counts[n.countIndex]
	n.countIndex++
	return value, nil
}

func (n *fakeRetainedNode) ActivateAfterHostControl() error {
	if n.events != nil {
		*n.events = append(*n.events, "activate")
	}
	if n.activationError != nil {
		return n.activationError
	}
	if n.activated {
		return errors.New("HostControl activated twice")
	}
	n.activated = true
	if n.onActivate != nil {
		n.onActivate()
	}
	return nil
}

func (n *fakeRetainedNode) Terminate() error {
	if n.events != nil {
		*n.events = append(*n.events, "terminate")
	}
	n.terminated = true
	return n.terminationError
}

func TestVerifyConnectedNodeBindsExactPIDAndSingleProcessRootJob(t *testing.T) {
	identity := testNodeIdentity()
	node := newFakeRetainedNode(identity)
	observer := &fakePIDObserver{values: []uint32{identity.ProcessID, identity.ProcessID}}
	evidence, err := verifyConnectedNode("test-pipe", observer, node)
	if err != nil {
		t.Fatal(err)
	}
	if evidence.ClientProcessIDBefore != identity.ProcessID ||
		evidence.ClientProcessIDAfter != identity.ProcessID ||
		evidence.RootJobActiveProcessesBefore != 1 ||
		evidence.RootJobActiveProcessesAfter != 1 ||
		!sameIdentity(evidence.NodeIdentity, identity) {
		t.Fatalf("unexpected verification evidence: %+v", evidence)
	}
	if node.activated {
		t.Fatal("peer verification activated the root Job before RuntimeBootstrapV1")
	}
}

func TestVerifyConnectedNodeRejectsPIDReuseIdentityDriftAndEarlyChildren(t *testing.T) {
	identity := testNodeIdentity()
	tests := []struct {
		name     string
		observer *fakePIDObserver
		node     *fakeRetainedNode
	}{
		{name: "wrong client", observer: &fakePIDObserver{values: []uint32{99, 99}}, node: newFakeRetainedNode(identity)},
		{name: "PID changed", observer: &fakePIDObserver{values: []uint32{identity.ProcessID, 99}}, node: newFakeRetainedNode(identity)},
		{name: "child before binding", observer: &fakePIDObserver{values: []uint32{identity.ProcessID, identity.ProcessID}}, node: func() *fakeRetainedNode {
			node := newFakeRetainedNode(identity)
			node.counts[0] = 2
			return node
		}()},
		{name: "child during binding", observer: &fakePIDObserver{values: []uint32{identity.ProcessID, identity.ProcessID}}, node: func() *fakeRetainedNode {
			node := newFakeRetainedNode(identity)
			node.counts[1] = 2
			return node
		}()},
		{name: "identity drift", observer: &fakePIDObserver{values: []uint32{identity.ProcessID, identity.ProcessID}}, node: func() *fakeRetainedNode {
			node := newFakeRetainedNode(identity)
			node.observations[1].StartKeySequenceNumber++
			return node
		}()},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := verifyConnectedNode("test-pipe", test.observer, test.node); !errors.Is(err, ErrPeerMismatch) {
				t.Fatalf("verification error = %v, want ErrPeerMismatch", err)
			}
		})
	}
}

func TestVerifyConnectedNodePropagatesRetainedHandleFailures(t *testing.T) {
	identity := testNodeIdentity()
	node := newFakeRetainedNode(identity)
	node.observeError = errors.New("retained process handle failed")
	if _, err := verifyConnectedNode("test-pipe", &fakePIDObserver{}, node); err == nil || errors.Is(err, ErrPeerMismatch) {
		t.Fatalf("identity failure = %v, want retained handle error", err)
	}

	node = newFakeRetainedNode(identity)
	node.countError = errors.New("retained Job handle failed")
	if _, err := verifyConnectedNode("test-pipe", &fakePIDObserver{}, node); err == nil || errors.Is(err, ErrPeerMismatch) {
		t.Fatalf("Job failure = %v, want retained handle error", err)
	}

}

func testNodeIdentity() winprocess.NodeIdentity {
	return winprocess.NodeIdentity{
		ProcessID:              42,
		CreationTime:           time.Unix(1_700_000_000, 123).UTC(),
		StartKeyAvailable:      true,
		StartKeySequenceNumber: 9001,
	}
}

type fakeRuntimeBootstrapChannel struct {
	input         *bytes.Reader
	output        bytes.Buffer
	events        *[]string
	readStarted   bool
	readCalls     int
	writeCalls    int
	failWriteCall int
	onReadCall    func(int)
	onWriteCall   func(int)
}

func (channel *fakeRuntimeBootstrapChannel) ReadContext(
	ctx context.Context,
	buffer []byte,
) (int, error) {
	if cause := context.Cause(ctx); cause != nil {
		return 0, cause
	}
	if !channel.readStarted {
		channel.readStarted = true
		*channel.events = append(*channel.events, "read-ack")
	}
	channel.readCalls++
	read, err := channel.input.Read(buffer)
	if channel.onReadCall != nil {
		channel.onReadCall(channel.readCalls)
	}
	return read, err
}

func (channel *fakeRuntimeBootstrapChannel) WriteContext(
	ctx context.Context,
	buffer []byte,
) (int, error) {
	if cause := context.Cause(ctx); cause != nil {
		return 0, cause
	}
	channel.writeCalls++
	if channel.writeCalls == 1 {
		*channel.events = append(*channel.events, "write-bootstrap")
	}
	if channel.writeCalls == 3 {
		*channel.events = append(*channel.events, "write-commit")
	}
	if channel.failWriteCall == channel.writeCalls {
		return 0, errors.New("write failed")
	}
	written, err := channel.output.Write(buffer)
	if channel.onWriteCall != nil {
		channel.onWriteCall(channel.writeCalls)
	}
	return written, err
}

func TestCompleteRuntimeBootstrapActivatesBetweenAckAndCommit(t *testing.T) {
	bootstrap, bootstrapDocument := hostControlBootstrapForTest(t)
	events := []string{}
	channel := hostControlBootstrapChannelForTest(t, bootstrapDocument, &events)
	node := newFakeRetainedNode(testNodeIdentity())
	node.events = &events
	evidence := VerificationEvidence{NodeIdentity: node.stable}

	committed, err := completeRuntimeBootstrap(
		context.Background(),
		channel,
		node,
		evidence,
		bootstrap,
	)
	if err != nil {
		t.Fatal(err)
	}
	if reflect.ValueOf(committed).IsZero() {
		t.Fatal("completed bootstrap did not return committed session authority")
	}
	wantEvents := []string{"write-bootstrap", "read-ack", "activate", "write-commit"}
	if strings.Join(events, ",") != strings.Join(wantEvents, ",") {
		t.Fatalf("events = %v, want %v", events, wantEvents)
	}
	if !node.activated || node.terminated {
		t.Fatalf("Node state activated=%v terminated=%v", node.activated, node.terminated)
	}
	written := bytes.NewReader(channel.output.Bytes())
	if _, err := localrpc.ReadFrame(written, localrpc.RuntimeBootstrapMaximumBytes); err != nil {
		t.Fatal(err)
	}
	commitDocument, err := localrpc.ReadFrame(written, localrpc.RuntimeBootstrapMaximumBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := localrpc.ValidateRuntimeBootstrapCommit(
		commitDocument,
		bootstrapDocument,
		localrpc.RoleControl,
	); err != nil {
		t.Fatal(err)
	}
}

func TestCompleteRuntimeBootstrapRejectsDriftAndCommitFailure(t *testing.T) {
	tests := []struct {
		name      string
		configure func(*fakeRetainedNode, *fakeRuntimeBootstrapChannel)
	}{
		{name: "identity drift", configure: func(node *fakeRetainedNode, _ *fakeRuntimeBootstrapChannel) {
			node.observations[0].StartKeySequenceNumber++
		}},
		{name: "new child", configure: func(node *fakeRetainedNode, _ *fakeRuntimeBootstrapChannel) {
			node.counts[0] = 2
		}},
		{name: "activation failure", configure: func(node *fakeRetainedNode, _ *fakeRuntimeBootstrapChannel) {
			node.activationError = errors.New("activation failed")
		}},
		{name: "commit failure", configure: func(_ *fakeRetainedNode, channel *fakeRuntimeBootstrapChannel) {
			channel.failWriteCall = 3
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			bootstrap, bootstrapDocument := hostControlBootstrapForTest(t)
			events := []string{}
			channel := hostControlBootstrapChannelForTest(t, bootstrapDocument, &events)
			node := newFakeRetainedNode(testNodeIdentity())
			node.events = &events
			test.configure(node, channel)
			_, err := completeRuntimeBootstrap(
				context.Background(),
				channel,
				node,
				VerificationEvidence{NodeIdentity: node.stable},
				bootstrap,
			)
			if err == nil {
				t.Fatal("completeRuntimeBootstrap unexpectedly succeeded")
			}
			if test.name == "commit failure" && !node.activated {
				t.Fatal("commit failure occurred before activation")
			}
			if test.name != "commit failure" && node.activated {
				t.Fatal("Node activated after a pre-activation failure")
			}
		})
	}
}

func TestCompleteRuntimeBootstrapRechecksDeadlineImmediatelyBeforeActivation(t *testing.T) {
	bootstrap, bootstrapDocument := hostControlBootstrapForTest(t)
	events := []string{}
	channel := hostControlBootstrapChannelForTest(t, bootstrapDocument, &events)
	node := newFakeRetainedNode(testNodeIdentity())
	node.events = &events
	ctx, cancel := context.WithCancelCause(context.Background())
	deadlineCause := errors.New("startup deadline expired")
	node.onObserve = func(observation int) {
		if observation == 2 {
			cancel(deadlineCause)
		}
	}

	_, err := completeRuntimeBootstrap(
		ctx,
		channel,
		node,
		VerificationEvidence{NodeIdentity: node.stable},
		bootstrap,
	)
	if !errors.Is(err, deadlineCause) {
		t.Fatalf("completeRuntimeBootstrap error = %v, want deadline cause", err)
	}
	if node.activated {
		t.Fatal("Node activated after the startup deadline expired")
	}
}

func TestCompleteRuntimeBootstrapFailureStages(t *testing.T) {
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
				node.onActivate = func() {
					cancel(deadlineCause)
				}
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
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
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
		})
	}
}

func TestPreTransferFailureNeverReturnsConnectionOwner(t *testing.T) {
	events := []string{}
	node := newFakeRetainedNode(testNodeIdentity())
	node.events = &events
	node.terminationError = errors.New("termination failed")
	primary := errors.New("accept failed before transfer")
	closeError := errors.New("listener close failed")
	connection, err := rejectAcceptFailure(nil, primary, node, func() {
		events = append(events, "mark-terminal")
	}, func() error {
		events = append(events, "close")
		return closeError
	})
	if connection != nil {
		t.Fatalf("pre-transfer failure returned connection %p", connection)
	}
	if strings.Join(events, ",") != "terminate,mark-terminal,close" {
		t.Fatalf("cleanup events = %v", events)
	}
	if !errors.Is(err, primary) || !errors.Is(err, node.terminationError) || !errors.Is(err, closeError) {
		t.Fatalf("cleanup error = %v", err)
	}
}

func hostControlBootstrapForTest(t *testing.T) (localrpc.RuntimeBootstrapV1, []byte) {
	t.Helper()
	bootstrap, err := localrpc.NewFoundationRuntimeBootstrap(localrpc.FoundationRuntimeBootstrapOptions{
		Role:                           localrpc.RoleControl,
		WorkerNodeID:                   "powertoys-node:01",
		ReleaseID:                      "2026.08.31-test+1",
		ReleaseTemplateSHA256:          strings.Repeat("1", 64),
		InstallationManifestSHA256:     strings.Repeat("2", 64),
		PreflightSHA256:                strings.Repeat("3", 64),
		NodeBundleSHA256:               strings.Repeat("4", 64),
		MaximumQueuedBytesPerDirection: 4 * 1024 * 1024,
		TotalShutdownTimeoutMS:         120_000,
		ForceTerminationReserveMS:      15_000,
	})
	if err != nil {
		t.Fatal(err)
	}
	document, err := localrpc.EncodeRuntimeBootstrap(bootstrap)
	if err != nil {
		t.Fatal(err)
	}
	return bootstrap, document
}

func hostControlBootstrapChannelForTest(
	t *testing.T,
	bootstrapDocument []byte,
	events *[]string,
) *fakeRuntimeBootstrapChannel {
	t.Helper()
	ackDocument, err := localrpc.EncodeRuntimeBootstrapAck(bootstrapDocument, localrpc.RoleControl)
	if err != nil {
		t.Fatal(err)
	}
	var input bytes.Buffer
	if err := localrpc.WriteFrame(&input, ackDocument, localrpc.RuntimeBootstrapMaximumBytes); err != nil {
		t.Fatal(err)
	}
	return &fakeRuntimeBootstrapChannel{input: bytes.NewReader(input.Bytes()), events: events}
}

func newFakeRetainedNode(identity winprocess.NodeIdentity) *fakeRetainedNode {
	return &fakeRetainedNode{
		processID:    identity.ProcessID,
		stable:       identity,
		observations: []winprocess.NodeIdentity{identity, identity, identity},
		counts:       []uint32{1, 1},
	}
}
