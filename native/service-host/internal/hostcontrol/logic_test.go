package hostcontrol

import (
	"errors"
	"testing"
	"time"

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
	processID       uint32
	stable          winprocess.NodeIdentity
	observations    []winprocess.NodeIdentity
	observeError    error
	counts          []uint32
	countError      error
	activationError error
	activated       bool
	observeIndex    int
	countIndex      int
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
	if n.activationError != nil {
		return n.activationError
	}
	if n.activated {
		return errors.New("HostControl activated twice")
	}
	n.activated = true
	return nil
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
	if !node.activated {
		t.Fatal("successful verification did not activate the final root Job process limit")
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

	node = newFakeRetainedNode(identity)
	node.activationError = errors.New("root Job limit transition failed")
	observer := &fakePIDObserver{values: []uint32{identity.ProcessID, identity.ProcessID}}
	if _, err := verifyConnectedNode("test-pipe", observer, node); err == nil || errors.Is(err, ErrPeerMismatch) {
		t.Fatalf("activation failure = %v, want retained Job transition error", err)
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

func newFakeRetainedNode(identity winprocess.NodeIdentity) *fakeRetainedNode {
	return &fakeRetainedNode{
		processID:    identity.ProcessID,
		stable:       identity,
		observations: []winprocess.NodeIdentity{identity, identity, identity},
		counts:       []uint32{1, 1},
	}
}
