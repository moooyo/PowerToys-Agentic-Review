package winpipe

import (
	"errors"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/framing"
)

const (
	testOwnServiceSID = "S-1-5-80-1-2-3-4-5"
	testServiceSID    = "S-1-5-80-123-456-789-101112-131415"
)

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
		OwnServiceSID:     testOwnServiceSID,
		PeerServiceSID:    testServiceSID,
		MaximumFrameBytes: framing.MaximumFrameBytes,
	})
	if err != nil {
		t.Fatalf("validateServerOptions returned an error: %v", err)
	}
	expected := "O:" + testOwnServiceSID + "G:" + testOwnServiceSID +
		"D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x00100183;;;" + testServiceSID + ")"
	if sddl != expected {
		t.Fatalf("security descriptor is %q", sddl)
	}
	if strings.Count(sddl, "(A;;") != 3 {
		t.Fatalf("security descriptor has unexpected ACEs: %q", sddl)
	}
}

func TestEndpointAttestationIsCompleteAndRoleAware(t *testing.T) {
	pipeName := `\\.\pipe\AgenticReview.Worker.ControlExecutor.v1`
	server := sealEndpointAttestation(EndpointAttestation{
		pipeName:               pipeName,
		maximumFrameBytes:      framing.MaximumFrameBytes,
		localSide:              EndpointSideServer,
		connected:              true,
		ownServiceSID:          testOwnServiceSID,
		peerServiceSID:         testServiceSID,
		serverSecurityVerified: true,
	})
	if !server.Valid() || server.PipeName() != pipeName ||
		server.MaximumFrameBytes() != framing.MaximumFrameBytes ||
		server.LocalSide() != EndpointSideServer || !server.Connected() ||
		server.ValidatedOwnServiceSID() != testOwnServiceSID ||
		server.ValidatedPeerServiceSID() != testServiceSID ||
		!server.ServerDACLValidated() {
		t.Fatalf("server attestation is incomplete: %#v", server)
	}

	client := sealEndpointAttestation(EndpointAttestation{
		pipeName:          pipeName,
		maximumFrameBytes: framing.MaximumFrameBytes,
		localSide:         EndpointSideClient,
		connected:         true,
	})
	if !client.Valid() || client.LocalSide() != EndpointSideClient ||
		client.ValidatedOwnServiceSID() != "" ||
		client.ValidatedPeerServiceSID() != "" || client.ServerDACLValidated() {
		t.Fatalf("client attestation is incomplete: %#v", client)
	}

	invalid := []EndpointAttestation{
		{},
		{pipeName: pipeName, maximumFrameBytes: framing.MaximumFrameBytes, localSide: EndpointSideClient, connected: true},
		sealEndpointAttestation(EndpointAttestation{pipeName: pipeName, maximumFrameBytes: framing.MaximumFrameBytes, localSide: EndpointSideClient, connected: false}),
		sealEndpointAttestation(EndpointAttestation{pipeName: pipeName, maximumFrameBytes: framing.MaximumFrameBytes, localSide: EndpointSideServer, connected: true, peerServiceSID: testServiceSID, serverSecurityVerified: true}),
		sealEndpointAttestation(EndpointAttestation{pipeName: pipeName, maximumFrameBytes: framing.MaximumFrameBytes, localSide: EndpointSideServer, connected: true, ownServiceSID: testOwnServiceSID, serverSecurityVerified: true}),
		sealEndpointAttestation(EndpointAttestation{pipeName: pipeName, maximumFrameBytes: framing.MaximumFrameBytes, localSide: EndpointSideServer, connected: true, ownServiceSID: testServiceSID, peerServiceSID: testServiceSID, serverSecurityVerified: true}),
		sealEndpointAttestation(EndpointAttestation{pipeName: pipeName, maximumFrameBytes: framing.MaximumFrameBytes, localSide: EndpointSideClient, connected: true, ownServiceSID: testOwnServiceSID, peerServiceSID: testServiceSID, serverSecurityVerified: true}),
	}
	for index, attestation := range invalid {
		if attestation.Valid() || attestation.PipeName() != "" ||
			attestation.MaximumFrameBytes() != 0 ||
			attestation.LocalSide() != EndpointSideUnknown || attestation.Connected() ||
			attestation.ValidatedOwnServiceSID() != "" ||
			attestation.ValidatedPeerServiceSID() != "" || attestation.ServerDACLValidated() {
			t.Fatalf("invalid attestation %d exposed evidence: %#v", index, attestation)
		}
	}
}

func TestEndpointAttestationRejectsEveryIdentityMutation(t *testing.T) {
	valid := sealEndpointAttestation(EndpointAttestation{
		pipeName:               `\\.\pipe\AgenticReview.Worker.ControlExecutor.v1`,
		maximumFrameBytes:      framing.MaximumFrameBytes,
		localSide:              EndpointSideServer,
		connected:              true,
		ownServiceSID:          testOwnServiceSID,
		peerServiceSID:         testServiceSID,
		serverSecurityVerified: true,
	})
	tests := []struct {
		name   string
		mutate func(*EndpointAttestation)
	}{
		{name: "pipe name", mutate: func(value *EndpointAttestation) { value.pipeName = `\\.\pipe\wrong` }},
		{name: "frame bound", mutate: func(value *EndpointAttestation) { value.maximumFrameBytes = framing.MaximumFrameBytes + 1 }},
		{name: "side", mutate: func(value *EndpointAttestation) { value.localSide = EndpointSideUnknown }},
		{name: "connection", mutate: func(value *EndpointAttestation) { value.connected = false }},
		{name: "missing owner", mutate: func(value *EndpointAttestation) { value.ownServiceSID = "" }},
		{name: "invalid owner", mutate: func(value *EndpointAttestation) { value.ownServiceSID = "S-1-5-18" }},
		{name: "missing peer", mutate: func(value *EndpointAttestation) { value.peerServiceSID = "" }},
		{name: "invalid peer", mutate: func(value *EndpointAttestation) { value.peerServiceSID = "S-1-5-19" }},
		{name: "same service SIDs", mutate: func(value *EndpointAttestation) { value.peerServiceSID = value.ownServiceSID }},
		{name: "security proof", mutate: func(value *EndpointAttestation) { value.serverSecurityVerified = false }},
		{name: "binding digest", mutate: func(value *EndpointAttestation) { value.bindingDigest[0] ^= 0xff }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := valid
			test.mutate(&candidate)
			if candidate.Valid() || candidate.PipeName() != "" ||
				candidate.MaximumFrameBytes() != 0 ||
				candidate.LocalSide() != EndpointSideUnknown || candidate.Connected() ||
				candidate.ValidatedOwnServiceSID() != "" ||
				candidate.ValidatedPeerServiceSID() != "" || candidate.ServerDACLValidated() {
				t.Fatalf("mutated attestation exposed evidence: %#v", candidate)
			}
		})
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
				OwnServiceSID:     testOwnServiceSID,
				PeerServiceSID:    testServiceSID,
				MaximumFrameBytes: framing.MaximumFrameBytes,
			},
		},
		{
			name: "nested pipe leaf",
			options: ServerOptions{
				PipeName:          `\\.\pipe\AgenticReview\Nested`,
				OwnServiceSID:     testOwnServiceSID,
				PeerServiceSID:    testServiceSID,
				MaximumFrameBytes: framing.MaximumFrameBytes,
			},
		},
		{
			name: "oversized frame",
			options: ServerOptions{
				PipeName:          `\\.\pipe\AgenticReview`,
				OwnServiceSID:     testOwnServiceSID,
				PeerServiceSID:    testServiceSID,
				MaximumFrameBytes: framing.MaximumFrameBytes + 1,
			},
		},
		{
			name: "well-known peer SID",
			options: ServerOptions{
				PipeName:          `\\.\pipe\AgenticReview`,
				OwnServiceSID:     testOwnServiceSID,
				PeerServiceSID:    "S-1-5-18",
				MaximumFrameBytes: framing.MaximumFrameBytes,
			},
		},
		{
			name: "noncanonical peer service SID",
			options: ServerOptions{
				PipeName:          `\\.\pipe\AgenticReview`,
				OwnServiceSID:     testOwnServiceSID,
				PeerServiceSID:    "S-1-5-80-01-2-3-4-5",
				MaximumFrameBytes: framing.MaximumFrameBytes,
			},
		},
		{
			name: "well-known own SID",
			options: ServerOptions{
				PipeName:          `\\.\pipe\AgenticReview`,
				OwnServiceSID:     "S-1-5-18",
				PeerServiceSID:    testServiceSID,
				MaximumFrameBytes: framing.MaximumFrameBytes,
			},
		},
		{
			name: "noncanonical own service SID",
			options: ServerOptions{
				PipeName:          `\\.\pipe\AgenticReview`,
				OwnServiceSID:     "S-1-5-80-01-2-3-4-5",
				PeerServiceSID:    testServiceSID,
				MaximumFrameBytes: framing.MaximumFrameBytes,
			},
		},
		{
			name: "same service SIDs",
			options: ServerOptions{
				PipeName:          `\\.\pipe\AgenticReview`,
				OwnServiceSID:     testServiceSID,
				PeerServiceSID:    testServiceSID,
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
