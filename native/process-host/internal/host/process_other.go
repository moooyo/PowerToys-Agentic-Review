//go:build !windows

package host

import (
	"errors"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/protocol"
)

type unsupportedLauncher struct{}

func newProcessLauncher() processLauncher {
	return unsupportedLauncher{}
}

func (unsupportedLauncher) Launch(protocol.ProcessLaunchSpec, protocol.EffectiveLimits) (launchedProcess, error) {
	return nil, errors.New("ProcessHost process execution is supported only on Windows")
}
