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

func (unsupportedLauncher) Launch(spec protocol.ProcessLaunchSpec, _ protocol.EffectiveLimits) (launchedProcess, error) {
	if spec.CaptureProcessIdentity {
		return nil, errProcessIdentityUnavailable
	}
	return nil, errors.New("ProcessHost process execution is supported only on Windows")
}
