//go:build !windows

package host

import (
	"errors"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/protocol"
)

func newRecoveryLauncher(_ string) (processLauncher, *protocol.NamedJobRecoveryCapability, error) {
	return nil, nil, errors.New("named Job recovery is supported only on Windows")
}
