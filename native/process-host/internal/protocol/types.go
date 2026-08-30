package protocol

const (
	Version        = "1.0"
	MaxSafeInteger = uint64(9_007_199_254_740_991)
)

type TerminationReason string

const (
	TerminationCancelled      TerminationReason = "cancelled"
	TerminationLeaseLost      TerminationReason = "lease_lost"
	TerminationStale          TerminationReason = "stale"
	TerminationTimeout        TerminationReason = "timeout"
	TerminationWorkerShutdown TerminationReason = "worker_shutdown"
)

func (r TerminationReason) Valid() bool {
	switch r {
	case TerminationCancelled, TerminationLeaseLost, TerminationStale, TerminationTimeout, TerminationWorkerShutdown:
		return true
	default:
		return false
	}
}

type ProcessResourceLimits struct {
	HardTimeoutMS       uint64 `json:"hardTimeoutMs"`
	MaximumProcessCount uint64 `json:"maximumProcessCount"`
	MaximumMemoryBytes  uint64 `json:"maximumMemoryBytes"`
	MaximumOutputBytes  uint64 `json:"maximumOutputBytes"`
}

type ProcessLaunchSpec struct {
	Executable       string                `json:"executable"`
	Arguments        []string              `json:"arguments"`
	WorkingDirectory string                `json:"workingDirectory"`
	EnvironmentMode  string                `json:"environmentMode"`
	Environment      map[string]string     `json:"environment"`
	StandardInput    *string               `json:"standardInput,omitempty"`
	Limits           ProcessResourceLimits `json:"limits"`
}

type HostRequest interface {
	RequestID() string
	RequestType() string
}

type StartRequest struct {
	ProtocolVersion string            `json:"protocolVersion"`
	Type            string            `json:"type"`
	ID              string            `json:"requestId"`
	Spec            ProcessLaunchSpec `json:"spec"`
}

func (r StartRequest) RequestID() string   { return r.ID }
func (r StartRequest) RequestType() string { return r.Type }

type TerminateRequest struct {
	ProtocolVersion string            `json:"protocolVersion"`
	Type            string            `json:"type"`
	ID              string            `json:"requestId"`
	Reason          TerminationReason `json:"reason"`
}

func (r TerminateRequest) RequestID() string   { return r.ID }
func (r TerminateRequest) RequestType() string { return r.Type }

type ShutdownRequest struct {
	ProtocolVersion string `json:"protocolVersion"`
	Type            string `json:"type"`
	ID              string `json:"requestId"`
}

func (r ShutdownRequest) RequestID() string   { return r.ID }
func (r ShutdownRequest) RequestType() string { return r.Type }

type ReadyCapabilities struct {
	ConcurrentRequests        bool `json:"concurrentRequests"`
	MaximumFrameBytes         int  `json:"maximumFrameBytes"`
	MaximumConcurrentRequests int  `json:"maximumConcurrentRequests"`
}

type ReadyEvent struct {
	ProtocolVersion string            `json:"protocolVersion"`
	Type            string            `json:"type"`
	ProcessHostPID  uint32            `json:"processHostPid"`
	Capabilities    ReadyCapabilities `json:"capabilities"`
}

type StartedEvent struct {
	ProtocolVersion string `json:"protocolVersion"`
	Type            string `json:"type"`
	RequestID       string `json:"requestId"`
	ProcessID       uint32 `json:"processId"`
}

type OutputEvent struct {
	ProtocolVersion string `json:"protocolVersion"`
	Type            string `json:"type"`
	RequestID       string `json:"requestId"`
	Sequence        uint64 `json:"sequence"`
	DataBase64      string `json:"dataBase64"`
}

type OutputTruncatedEvent struct {
	ProtocolVersion string `json:"protocolVersion"`
	Type            string `json:"type"`
	RequestID       string `json:"requestId"`
	Sequence        uint64 `json:"sequence"`
	Stream          string `json:"stream"`
	DiscardedBytes  uint64 `json:"discardedBytes"`
}

type TerminatedEvent struct {
	ProtocolVersion string            `json:"protocolVersion"`
	Type            string            `json:"type"`
	RequestID       string            `json:"requestId"`
	Reason          TerminationReason `json:"reason"`
}

type ExitedEvent struct {
	ProtocolVersion string  `json:"protocolVersion"`
	Type            string  `json:"type"`
	RequestID       string  `json:"requestId"`
	ExitCode        *int64  `json:"exitCode"`
	Signal          *string `json:"signal"`
	OutputTruncated bool    `json:"outputTruncated"`
}

type ErrorEvent struct {
	ProtocolVersion string  `json:"protocolVersion"`
	Type            string  `json:"type"`
	RequestID       *string `json:"requestId"`
	Code            string  `json:"code"`
	Message         string  `json:"message"`
}

type ShutdownCompleteEvent struct {
	ProtocolVersion string `json:"protocolVersion"`
	Type            string `json:"type"`
	RequestID       string `json:"requestId"`
}
