//go:build windows

package hostcontrol

import (
	"errors"
	"io"
	"testing"

	"golang.org/x/sys/windows"
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

func TestWindowsReadEOFNormalizationRequiresExactZeroBytePipeEOF(t *testing.T) {
	connection := &Connection{}
	cleanupFailure := errors.New("cleanup failed")
	for _, pipeErr := range []error{
		windows.ERROR_BROKEN_PIPE,
		windows.ERROR_NO_DATA,
		windows.ERROR_PIPE_NOT_CONNECTED,
	} {
		if normalized := connection.normalizeOperationError(pipeErr, true, 0); normalized != io.EOF {
			t.Fatalf("exact zero-byte pipe error normalized to %v, want literal EOF", normalized)
		}
		for _, mutation := range []struct {
			name        string
			err         error
			transferred uint32
		}{
			{name: "wrapped", err: errors.Join(pipeErr)},
			{name: "cleanup", err: errors.Join(pipeErr, cleanupFailure)},
			{name: "transferred", err: pipeErr, transferred: 1},
		} {
			t.Run(mutation.name, func(t *testing.T) {
				normalized := connection.normalizeOperationError(
					mutation.err,
					true,
					mutation.transferred,
				)
				if normalized == io.EOF {
					t.Fatal("mutated pipe failure normalized to literal EOF")
				}
				if mutation.name == "cleanup" && !errors.Is(normalized, cleanupFailure) {
					t.Fatalf("cleanup failure was lost: %v", normalized)
				}
			})
		}
	}
}
