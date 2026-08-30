package winprocess

import (
	"context"
	"errors"
	"io"
	"time"
)

// Role identifies the only two ServiceHost payload roles.
type Role string

const (
	RoleControl  Role = "control"
	RoleExecutor Role = "executor"
)

// NodeLaunchSpec contains the reviewed inputs to the fixed Node launcher.
// It intentionally has no arguments field: callers cannot add Node flags or
// select another payload command line.
type NodeLaunchSpec struct {
	ExecutablePath   string
	BundlePath       string
	WorkingDirectory string
	Role             Role
	// OwnServiceSID and PeerServiceSID must be independently verified,
	// canonical S-1-5-80 service SIDs for distinct service identities.
	OwnServiceSID      string
	PeerServiceSID     string
	Environment        map[string]string
	MaximumProcesses   uint32
	MaximumMemoryBytes uint64
	ShutdownTimeout    time.Duration
}

// NodeProcess owns the Node process handle, the service-root Job Object, and
// the parent ends of the three standard-I/O pipes.
type NodeProcess interface {
	ProcessID() uint32
	StandardInput() io.WriteCloser
	StandardOutput() io.ReadCloser
	StandardError() io.ReadCloser
	// Wait returns successfully only after Node has exited and the root Job
	// reports no active processes. If Job drain fails, Wait returns the error
	// while retaining the Job handle for a later Terminate retry or fatal Close.
	Wait() (uint32, error)
	// Terminate terminates the whole root Job and waits for zero active
	// processes, bounded by NodeLaunchSpec.ShutdownTimeout.
	Terminate() error
	Close() error
}

// WrapperWatcher retains a stable process handle to the WinSW wrapper.
type WrapperWatcher interface {
	ProcessID() uint32
	CreationTime() time.Time
	// Wait returns nil only when the retained wrapper process handle signals.
	Wait(context.Context) error
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
