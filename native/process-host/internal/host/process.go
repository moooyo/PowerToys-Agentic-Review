package host

import (
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
