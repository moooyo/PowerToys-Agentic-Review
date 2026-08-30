package winpipe

import (
	"errors"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/framing"
)

const testServiceSID = "S-1-5-80-123-456-789-101112-131415"

func TestServerCreationContractUsesOneProtectedMessageInstance(t *testing.T) {
	if serverOpenMode != pipeAccessDuplex|fileFlagFirstPipeInstance|fileFlagOverlapped {
		t.Fatalf("server open mode is %#x", serverOpenMode)
	}
	if serverPipeMode != pipeTypeMessage|pipeReadModeMessage|pipeWait|pipeRejectRemoteClients {
		t.Fatalf("server pipe mode is %#x", serverPipeMode)
	}
	if maximumServerInstances != 1 {
		t.Fatalf("server permits %d instances", maximumServerInstances)
	}
	if clientOpenFlags != fileFlagOverlapped|securitySQOSPresent|securityIdentification {
		t.Fatalf("client open flags are %#x", clientOpenFlags)
	}

	sddl, err := validateServerOptions(ServerOptions{
		PipeName:          `\\.\pipe\AgenticReview.Worker.ControlExecutor.v1`,
		PeerServiceSID:    testServiceSID,
		MaximumFrameBytes: framing.MaximumFrameBytes,
	})
	if err != nil {
		t.Fatalf("validateServerOptions returned an error: %v", err)
	}
	expected := "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x00100183;;;" + testServiceSID + ")"
	if sddl != expected {
		t.Fatalf("security descriptor is %q", sddl)
	}
	if strings.Count(sddl, "(A;;") != 3 {
		t.Fatalf("security descriptor has unexpected ACEs: %q", sddl)
	}
}

func TestPeerAndClientRightsAreSpecificAndExcludePipeCreation(t *testing.T) {
	expected := fileReadData | fileWriteData | fileReadAttributes | fileWriteAttributes | synchronize
	if peerAccessRights != expected {
		t.Fatalf("peer rights %#x do not match %#x", peerAccessRights, expected)
	}
	if clientDesiredAccess != expected {
		t.Fatalf("client rights %#x do not match %#x", clientDesiredAccess, expected)
	}
	if peerAccessRights&genericWrite != 0 {
		t.Fatal("peer rights contain GENERIC_WRITE")
	}
	if peerAccessRights&fileAppendData != 0 || peerAccessRights&fileCreatePipeInstance != 0 {
		t.Fatal("peer rights contain FILE_APPEND_DATA/FILE_CREATE_PIPE_INSTANCE")
	}
}

func TestOptionsRejectNonLocalNamesInvalidLimitsAndNonServiceSIDs(t *testing.T) {
	tests := []struct {
		name    string
		options ServerOptions
	}{
		{
			name: "remote pipe",
			options: ServerOptions{
				PipeName:          `\\server\pipe\AgenticReview`,
				PeerServiceSID:    testServiceSID,
				MaximumFrameBytes: framing.MaximumFrameBytes,
			},
		},
		{
			name: "nested pipe leaf",
			options: ServerOptions{
				PipeName:          `\\.\pipe\AgenticReview\Nested`,
				PeerServiceSID:    testServiceSID,
				MaximumFrameBytes: framing.MaximumFrameBytes,
			},
		},
		{
			name: "oversized frame",
			options: ServerOptions{
				PipeName:          `\\.\pipe\AgenticReview`,
				PeerServiceSID:    testServiceSID,
				MaximumFrameBytes: framing.MaximumFrameBytes + 1,
			},
		},
		{
			name: "well-known SID",
			options: ServerOptions{
				PipeName:          `\\.\pipe\AgenticReview`,
				PeerServiceSID:    "S-1-5-18",
				MaximumFrameBytes: framing.MaximumFrameBytes,
			},
		},
		{
			name: "noncanonical service SID",
			options: ServerOptions{
				PipeName:          `\\.\pipe\AgenticReview`,
				PeerServiceSID:    "S-1-5-80-01-2-3-4-5",
				MaximumFrameBytes: framing.MaximumFrameBytes,
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := validateServerOptions(test.options); !errors.Is(err, ErrInvalidOptions) {
				t.Fatalf("expected invalid options, got %v", err)
			}
		})
	}
}

func TestClientOptionsUseTheSameBoundedLocalContract(t *testing.T) {
	err := validateClientOptions(ClientOptions{
		PipeName:          `\\.\pipe\AgenticReview.Worker.ControlExecutor.v1`,
		MaximumFrameBytes: framing.MaximumFrameBytes,
	})
	if err != nil {
		t.Fatalf("validateClientOptions returned an error: %v", err)
	}
	if err := validateClientOptions(ClientOptions{}); !errors.Is(err, ErrInvalidOptions) {
		t.Fatalf("expected invalid options, got %v", err)
	}
}
