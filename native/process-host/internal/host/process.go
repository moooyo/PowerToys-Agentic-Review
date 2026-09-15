package host

import (
	"errors"
	"io"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/protocol"
)

type launchedProcess interface {
	ProcessID() uint32
	StandardInput() io.WriteCloser
	StandardOutput() io.ReadCloser
	StandardError() io.ReadCloser
	// Wait returns only after the root has exited and the managed process tree is empty.
	Wait() (*int64, error)
	Terminate() error
	Close() error
}

type processLauncher interface {
	Launch(spec protocol.ProcessLaunchSpec, limits protocol.EffectiveLimits) (launchedProcess, error)
}

var (
	errProcessIdentityUnavailable = errors.New("process creation identity is unavailable")
	errProcessIdentityQueryFailed = errors.New("process creation identity query failed")
)

// processIdentityProvider exposes identity captured from the original launch handle.
// Implementations must not query a process by PID to reconstruct this value.
type processIdentityProvider interface {
	ProcessCreationTimeFileTime() uint64
}

// processResourceUsageProvider returns a cached, best-effort snapshot after Wait.
// Missing observations must not change process exit or cleanup behavior.
type processResourceUsageProvider interface {
	ResourceUsage() *protocol.ProcessResourceUsage
}
