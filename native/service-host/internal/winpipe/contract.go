package winpipe

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/framing"
)

var (
	ErrUnsupportedPlatform = errors.New("Windows named pipes are unavailable on this platform")
	ErrInvalidOptions      = errors.New("invalid Windows named-pipe options")
	ErrClosed              = errors.New("Windows named-pipe endpoint is closed")
	// ErrIOUnresolvedFatal means Windows did not prove terminal completion or
	// raw-handle consumption. The current ServiceHost process must exit and must
	// not reuse the endpoint or create a replacement connection.
	ErrIOUnresolvedFatal = errors.New("Windows named-pipe I/O ownership is unresolved; the current ServiceHost process must exit")
	ErrCloseTimeout      = errors.New("Windows named-pipe endpoint did not stop before the close deadline")
	ErrFlushServerOnly   = errors.New("graceful named-pipe flush-close requires the server endpoint")
	ErrFlushDeadline     = errors.New("graceful named-pipe flush-close requires an absolute deadline")
	ErrFlushInterrupted  = errors.New("graceful named-pipe flush-close was interrupted by abortive close")
)

const (
	fileReadData           uint32 = 0x00000001
	fileWriteData          uint32 = 0x00000002
	fileAppendData         uint32 = 0x00000004
	fileReadAttributes     uint32 = 0x00000080
	fileWriteAttributes    uint32 = 0x00000100
	synchronize            uint32 = 0x00100000
	genericWrite           uint32 = 0x40000000
	fileCreatePipeInstance        = fileAppendData

	pipeAccessDuplex          uint32 = 0x00000003
	fileFlagFirstPipeInstance uint32 = 0x00080000
	fileFlagOverlapped        uint32 = 0x40000000
	securityIdentification    uint32 = 0x00010000
	securitySQOSPresent       uint32 = 0x00100000
	pipeWait                  uint32 = 0x00000000
	pipeReadModeMessage       uint32 = 0x00000002
	pipeTypeMessage           uint32 = 0x00000004
	pipeRejectRemoteClients   uint32 = 0x00000008
	maximumServerInstances    uint32 = 1
	namedPipeNameMaximumBytes        = 256
	localPipePrefix                  = `\\.\pipe\`
)

const (
	peerAccessRights = fileReadData |
		fileWriteData |
		fileReadAttributes |
		fileWriteAttributes |
		synchronize
	clientDesiredAccess = peerAccessRights
	serverOpenMode      = pipeAccessDuplex |
		fileFlagFirstPipeInstance |
		fileFlagOverlapped
	clientOpenFlags = fileFlagOverlapped |
		securitySQOSPresent |
		securityIdentification
	serverPipeMode = pipeTypeMessage |
		pipeReadModeMessage |
		pipeWait |
		pipeRejectRemoteClients
)

// ServerOptions describe the single Control-owned server instance. Both SIDs
// must be independently verified, canonical service SIDs for distinct services.
type ServerOptions struct {
	PipeName          string
	OwnServiceSID     string
	PeerServiceSID    string
	MaximumFrameBytes uint32
}

// ClientOptions describe the Executor connection to the Control-owned instance.
type ClientOptions struct {
	PipeName          string
	MaximumFrameBytes uint32
}

// ProcessIDObserver exposes point-in-time kernel observations for a separate
// peer verifier. Callers must take two observations around process-handle
// acquisition. A PID, including two matching observations, is not authentication.
type ProcessIDObserver interface {
	GetNamedPipeClientProcessID() (uint32, error)
	GetNamedPipeServerProcessID() (uint32, error)
}

// EndpointSide identifies which end of a connected pipe is owned by the local
// Endpoint object. The value is derived from private endpoint construction
// state and cannot be selected by peer-verification callers.
type EndpointSide uint8

const (
	EndpointSideUnknown EndpointSide = iota
	EndpointSideServer
	EndpointSideClient
)

// EndpointAttestation is an immutable value snapshot issued from a connected,
// live Endpoint. Its fields are intentionally private so callers cannot forge
// transport identity evidence. A copied value contains no handle or mutable
// endpoint state.
type EndpointAttestation struct {
	pipeName               string
	maximumFrameBytes      uint32
	localSide              EndpointSide
	connected              bool
	ownServiceSID          string
	peerServiceSID         string
	serverSecurityVerified bool
	bindingDigest          [sha256.Size]byte
}

// Valid reports whether this value was issued as a complete endpoint
// attestation. It does not claim that the peer remains live after the snapshot.
func (attestation EndpointAttestation) Valid() bool {
	if attestation.bindingDigest == ([sha256.Size]byte{}) ||
		attestation.bindingDigest != digestEndpointAttestation(attestation) ||
		validatePipeName(attestation.pipeName) != nil ||
		validateMaximumFrameBytes(attestation.maximumFrameBytes) != nil ||
		!attestation.connected {
		return false
	}
	switch attestation.localSide {
	case EndpointSideServer:
		return attestation.serverSecurityVerified &&
			validateServiceSID(attestation.ownServiceSID) == nil &&
			validateServiceSID(attestation.peerServiceSID) == nil &&
			attestation.ownServiceSID != attestation.peerServiceSID
	case EndpointSideClient:
		return !attestation.serverSecurityVerified &&
			attestation.ownServiceSID == "" && attestation.peerServiceSID == ""
	default:
		return false
	}
}

func sealEndpointAttestation(attestation EndpointAttestation) EndpointAttestation {
	attestation.bindingDigest = digestEndpointAttestation(attestation)
	return attestation
}

func digestEndpointAttestation(attestation EndpointAttestation) [sha256.Size]byte {
	digest := sha256.New()
	digest.Write([]byte("AgenticReview.WinPipe.EndpointAttestation.v1"))
	var scalar [4]byte
	writeText := func(value string) {
		binary.LittleEndian.PutUint32(scalar[:], uint32(len(value)))
		digest.Write(scalar[:])
		digest.Write([]byte(value))
	}
	writeBool := func(value bool) {
		if value {
			digest.Write([]byte{1})
			return
		}
		digest.Write([]byte{0})
	}
	writeText(attestation.pipeName)
	binary.LittleEndian.PutUint32(scalar[:], attestation.maximumFrameBytes)
	digest.Write(scalar[:])
	digest.Write([]byte{byte(attestation.localSide)})
	writeBool(attestation.connected)
	writeText(attestation.ownServiceSID)
	writeText(attestation.peerServiceSID)
	writeBool(attestation.serverSecurityVerified)
	return [sha256.Size]byte(digest.Sum(nil))
}

// PipeName returns the exact validated pipe selector used to create or open
// the endpoint, not a later name lookup from the kernel object.
func (attestation EndpointAttestation) PipeName() string {
	if !attestation.Valid() {
		return ""
	}
	return attestation.pipeName
}

// MaximumFrameBytes returns the validated framing bound used by the endpoint.
func (attestation EndpointAttestation) MaximumFrameBytes() uint32 {
	if !attestation.Valid() {
		return 0
	}
	return attestation.maximumFrameBytes
}

// LocalSide returns the endpoint side represented by this snapshot.
func (attestation EndpointAttestation) LocalSide() EndpointSide {
	if !attestation.Valid() {
		return EndpointSideUnknown
	}
	return attestation.localSide
}

// Connected reports that connection establishment had completed and the
// endpoint was live at the snapshot's linearization point.
func (attestation EndpointAttestation) Connected() bool {
	return attestation.Valid() && attestation.connected
}

// ValidatedOwnServiceSID returns the server security descriptor owner and
// group SID proven by kernel readback. Client attestations return an empty
// string.
func (attestation EndpointAttestation) ValidatedOwnServiceSID() string {
	if !attestation.Valid() || attestation.localSide != EndpointSideServer {
		return ""
	}
	return attestation.ownServiceSID
}

// ValidatedPeerServiceSID returns the service SID proven by the server pipe's
// creation-time DACL readback. Client attestations return an empty string.
func (attestation EndpointAttestation) ValidatedPeerServiceSID() string {
	if !attestation.Valid() || attestation.localSide != EndpointSideServer {
		return ""
	}
	return attestation.peerServiceSID
}

// ServerDACLValidated reports whether the server pipe's actual owner, group,
// and DACL were read back and matched the package's exact protected policy.
func (attestation EndpointAttestation) ServerDACLValidated() bool {
	return attestation.Valid() &&
		attestation.localSide == EndpointSideServer &&
		attestation.serverSecurityVerified
}

func validateServerOptions(options ServerOptions) (string, error) {
	if err := validatePipeName(options.PipeName); err != nil {
		return "", err
	}
	if err := validateMaximumFrameBytes(options.MaximumFrameBytes); err != nil {
		return "", err
	}
	if err := validateServiceSID(options.OwnServiceSID); err != nil {
		return "", err
	}
	if err := validateServiceSID(options.PeerServiceSID); err != nil {
		return "", err
	}
	if options.OwnServiceSID == options.PeerServiceSID {
		return "", invalidOptions("own and peer service SIDs must be distinct")
	}
	return securityDescriptorString(options.OwnServiceSID, options.PeerServiceSID), nil
}

func validateClientOptions(options ClientOptions) error {
	if err := validatePipeName(options.PipeName); err != nil {
		return err
	}
	return validateMaximumFrameBytes(options.MaximumFrameBytes)
}

func validatePipeName(name string) error {
	if !strings.HasPrefix(name, localPipePrefix) {
		return invalidOptions("pipe name must use the local \\.\\pipe\\ namespace")
	}
	if len(name) > namedPipeNameMaximumBytes {
		return invalidOptions("pipe name exceeds the Windows byte limit")
	}
	leaf := strings.TrimPrefix(name, localPipePrefix)
	if leaf == "" {
		return invalidOptions("pipe name requires a leaf name")
	}
	for _, character := range leaf {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			character == '.' || character == '-' || character == '_' {
			continue
		}
		return invalidOptions("pipe leaf contains a disallowed character")
	}
	return nil
}

func validateMaximumFrameBytes(value uint32) error {
	if value < framing.HeaderBytes || value > framing.MaximumFrameBytes {
		return invalidOptions(fmt.Sprintf(
			"maximum frame bytes must be from %d through %d",
			framing.HeaderBytes,
			framing.MaximumFrameBytes,
		))
	}
	return nil
}

func validateServiceSID(value string) error {
	parts := strings.Split(value, "-")
	if len(parts) != 9 || parts[0] != "S" || parts[1] != "1" ||
		parts[2] != "5" || parts[3] != "80" {
		return invalidOptions("SID must be a canonical service SID")
	}
	for _, part := range parts[4:] {
		parsed, err := strconv.ParseUint(part, 10, 32)
		if err != nil || strconv.FormatUint(parsed, 10) != part {
			return invalidOptions("SID must be a canonical service SID")
		}
	}
	return nil
}

func securityDescriptorString(ownServiceSID, peerServiceSID string) string {
	return fmt.Sprintf(
		"O:%sG:%sD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x%08x;;;%s)",
		ownServiceSID,
		ownServiceSID,
		peerAccessRights,
		peerServiceSID,
	)
}

func invalidOptions(message string) error {
	return fmt.Errorf("%w: %s", ErrInvalidOptions, message)
}
