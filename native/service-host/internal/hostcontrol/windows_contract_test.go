//go:build windows

package hostcontrol

import (
	"io"
	"testing"
)

func TestWindowsPipeContractIsByteModeFirstInstanceAndRemoteRejecting(t *testing.T) {
	wantOpenMode := pipeAccessDuplex | fileFlagFirstPipeInstance | fileFlagOverlapped | readControl
	if serverOpenMode != wantOpenMode {
		t.Fatalf("server open mode = 0x%x, want 0x%x", serverOpenMode, wantOpenMode)
	}
	if serverPipeMode != pipeRejectRemoteClients {
		t.Fatalf("server pipe mode = 0x%x, want byte-mode PIPE_REJECT_REMOTE_CLIENTS", serverPipeMode)
	}
	if maximumServerInstances != 1 {
		t.Fatalf("server instances = %d, want 1", maximumServerInstances)
	}
	var _ io.ReadWriteCloser = (*Connection)(nil)
}
