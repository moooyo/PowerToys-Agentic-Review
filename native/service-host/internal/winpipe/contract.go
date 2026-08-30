package winpipe

import (
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

// ServerOptions describe the single Control-owned server instance. PeerServiceSID
// must be the already-resolved SID of the Executor service, not an account name.
type ServerOptions struct {
	PipeName          string
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

func validateServerOptions(options ServerOptions) (string, error) {
	if err := validatePipeName(options.PipeName); err != nil {
		return "", err
	}
	if err := validateMaximumFrameBytes(options.MaximumFrameBytes); err != nil {
		return "", err
	}
	if err := validateServiceSID(options.PeerServiceSID); err != nil {
		return "", err
	}
	return securityDescriptorString(options.PeerServiceSID), nil
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
		return invalidOptions("peer SID must be a canonical service SID")
	}
	for _, part := range parts[4:] {
		parsed, err := strconv.ParseUint(part, 10, 32)
		if err != nil || strconv.FormatUint(parsed, 10) != part {
			return invalidOptions("peer SID must be a canonical service SID")
		}
	}
	return nil
}

func securityDescriptorString(peerServiceSID string) string {
	return fmt.Sprintf(
		"D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x%08x;;;%s)",
		peerAccessRights,
		peerServiceSID,
	)
}

func invalidOptions(message string) error {
	return fmt.Errorf("%w: %s", ErrInvalidOptions, message)
}
