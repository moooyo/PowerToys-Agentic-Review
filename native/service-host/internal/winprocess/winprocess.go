package winprocess

import (
	"context"
	"errors"
	"time"
)

// Role identifies the only two ServiceHost payload roles.
type Role string

const (
	RoleControl  Role = "control"
	RoleExecutor Role = "executor"
)

// NodeLaunchSpec contains the reviewed inputs to the fixed Node launcher.
// It intentionally has no arguments field: callers cannot remove, reorder, or
// extend the fixed Node hardening flags or select another payload command line.
// NODE_OPTIONS is rejected even though the configuration layer also excludes
// it from the reviewed replacement environment.
type NodeLaunchSpec struct {
	ExecutablePath   string
	BundlePath       string
	WorkingDirectory string
	// HostControlPipeName is a per-launch rendezvous name created by
	// hostcontrol before Node starts. The name is not an authentication secret.
	HostControlPipeName string
	Role                Role
	// OwnServiceSID and PeerServiceSID must be independently verified,
	// canonical S-1-5-80 service SIDs for distinct service identities.
	OwnServiceSID      string
	PeerServiceSID     string
	Environment        map[string]string
	MaximumProcesses   uint32
	MaximumMemoryBytes uint64
	ShutdownTimeout    time.Duration
}

// NodeIdentity is immutable process identity captured from the retained
// CreateProcess handle before the suspended Node primary thread is resumed.
type NodeIdentity struct {
	ProcessID              uint32
	CreationTime           time.Time
	StartKeyAvailable      bool
	StartKeySequenceNumber uint64
}

// NodeProcess owns the Node process handle, the service-root Job Object, and,
// until TakeStandardIO succeeds, the parent ends of the standard-I/O pipes.
type NodeProcess interface {
	ProcessID() uint32
	StableIdentity() NodeIdentity
	// ObserveIdentity re-reads identity and liveness through the original
	// retained process handle. It fails after Node exits or identity changes.
	ObserveIdentity() (NodeIdentity, error)
	// RootJobActiveProcessCount observes the original service-root Job handle.
	RootJobActiveProcessCount() (uint32, error)
	// ActivateAfterHostControl raises the root Job process limit from the
	// launch-time value of one to the reviewed final limit. It succeeds only
	// once, after proving Node has not created any child process.
	ActivateAfterHostControl() error
	// TakeStandardIO atomically transfers the three parent pipe ends to one
	// explicit owner. It succeeds exactly once and never after shutdown starts.
	// The caller must close the returned owner; NodeProcess never closes streams
	// after transferring them.
	TakeStandardIO() (*NodeStandardIO, error)
	// Wait returns successfully only after Node has exited and the root Job
	// reports no active processes. If Job drain fails, Wait returns the error
	// while retaining the Job handle for a later Terminate or Close retry.
	Wait() (uint32, error)
	// WaitContext observes Node exit without making cancellation terminate the
	// process. Cancellation consumes only this call's duplicate wait handle, so
	// callers may wait again or explicitly terminate the root Job.
	WaitContext(context.Context) (uint32, error)
	// Terminate terminates the whole root Job and waits for zero active
	// processes, bounded by NodeLaunchSpec.ShutdownTimeout. It also seals and
	// closes standard I/O that has not been transferred.
	Terminate() error
	// Close seals all remaining ownership and abortively releases standard I/O.
	// A raw-handle close is attempted once; failure poisons the host and requires
	// process exit rather than retrying a potentially reused numeric handle.
	Close() error
}

// WrapperWatcher retains a stable process handle to the WinSW wrapper.
type WrapperWatcher interface {
	ProcessID() uint32
	CreationTime() time.Time
	// Wait returns nil only when the retained wrapper process handle signals.
	Wait(context.Context) error
	// Close consumes the retained raw handle once. Any close failure is fatal
	// for the host process and must never be retried against the numeric value.
	Close() error
}

// RootTerminator is implemented by NodeProcess and kept small for supervision
// tests and future service-stop integration.
type RootTerminator interface {
	Terminate() error
}

var (
	ErrUnsupportedPlatform = errors.New("ServiceHost process supervision requires Windows")
	ErrJobDrainTimeout     = errors.New("service-root Job did not become empty before the shutdown deadline")
	ErrWrapperUnstable     = errors.New("WinSW wrapper identity is not stable")
)

// WatchWrapper waits for the verified wrapper handle or cancellation and then
// always terminates the root Job. A monitoring failure is fail-closed too.
func WatchWrapper(ctx context.Context, watcher WrapperWatcher, root RootTerminator) error {
	if ctx == nil {
		return errors.New("wrapper watch context is required")
	}
	if watcher == nil {
		return errors.New("wrapper watcher is required")
	}
	if root == nil {
		return errors.New("root Job terminator is required")
	}
	waitErr := watcher.Wait(ctx)
	terminateErr := root.Terminate()
	return errors.Join(waitErr, terminateErr)
}
