package hostcontrol

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winprocess"
)

var (
	ErrUnsupportedPlatform = errors.New("HostControl named pipes require Windows")
	ErrInvalidOptions      = errors.New("invalid HostControl options")
	ErrClosed              = errors.New("HostControl endpoint is closed")
	ErrAlreadyAccepted     = errors.New("HostControl listener was already accepted")
	ErrConnectTimeout      = errors.New("HostControl client did not connect before the deadline")
	ErrIOTimeout           = errors.New("HostControl I/O exceeded its deadline")
	ErrCloseTimeout        = errors.New("HostControl close did not drain active I/O before the deadline")
	ErrPeerMismatch        = errors.New("HostControl client is not the retained Node process")
)

const (
	pipeNamePrefix       = `\\.\pipe\AgenticReview.ServiceHost.HostControl.v1.`
	pipeNonceBytes       = 32
	pipeNonceHexLength   = pipeNonceBytes * 2
	pipeBufferBytes      = 64 * 1024
	maximumPipeNameUnits = 256
	maximumTimeout       = 10 * time.Minute

	localSystemSID           = "S-1-5-18"
	builtinAdministratorsSID = "S-1-5-32-544"

	fileReadData           uint32 = 0x00000001
	fileWriteData          uint32 = 0x00000002
	fileAppendData         uint32 = 0x00000004
	fileReadEA             uint32 = 0x00000008
	fileWriteEA            uint32 = 0x00000010
	fileReadAttributes     uint32 = 0x00000080
	fileWriteAttributes    uint32 = 0x00000100
	readControl            uint32 = 0x00020000
	synchronize            uint32 = 0x00100000
	standardRightsRequired uint32 = 0x000F0000

	fileGenericRead = readControl |
		fileReadData |
		fileReadAttributes |
		fileReadEA |
		synchronize
	fileGenericWrite = readControl |
		fileWriteData |
		fileWriteAttributes |
		fileWriteEA |
		fileAppendData |
		synchronize
	nodeDuplexAccessMask = fileGenericRead | fileGenericWrite
	fileAllAccessMask    = standardRightsRequired | synchronize | 0x000001FF

	securityDescriptorDACLPresent   uint16 = 0x0004
	securityDescriptorDACLProtected uint16 = 0x1000
	accessAllowedACEType            uint8  = 0
	noACEFlags                      uint8  = 0
)

// Options configure one per-launch HostControl listener and connection.
type Options struct {
	OwnServiceSID  string
	ConnectTimeout time.Duration
	IOTimeout      time.Duration
	CloseTimeout   time.Duration
}

// VerificationEvidence contains detached observations made before the
// connected pipe handle is transferred to the returned Connection.
type VerificationEvidence struct {
	PipeName                     string
	ClientProcessIDBefore        uint32
	ClientProcessIDAfter         uint32
	NodeIdentity                 winprocess.NodeIdentity
	RootJobActiveProcessesBefore uint32
	RootJobActiveProcessesAfter  uint32
}

type accessEntry struct {
	SID     string
	Mask    uint32
	ACEType uint8
	Flags   uint8
}

type daclEvidence struct {
	Control   uint16
	Present   bool
	Protected bool
	Null      bool
	Defaulted bool
	Entries   []accessEntry
}

type clientPIDObserver interface {
	ClientProcessID() (uint32, error)
}

type retainedNode interface {
	ProcessID() uint32
	StableIdentity() winprocess.NodeIdentity
	ObserveIdentity() (winprocess.NodeIdentity, error)
	RootJobActiveProcessCount() (uint32, error)
}

type runtimeBootstrapNode interface {
	retainedNode
	ActivateAfterHostControl() error
	Terminate() error
}

type activityGroup struct {
	mu      sync.Mutex
	count   int
	drained chan struct{}
}

func (a *activityGroup) begin() func() {
	a.mu.Lock()
	if a.count == 0 {
		a.drained = make(chan struct{})
	}
	a.count++
	a.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			a.mu.Lock()
			a.count--
			if a.count < 0 {
				a.mu.Unlock()
				panic("HostControl activity count underflow")
			}
			if a.count == 0 {
				close(a.drained)
			}
			a.mu.Unlock()
		})
	}
}

func (a *activityGroup) wait(timeout time.Duration) bool {
	a.mu.Lock()
	if a.count == 0 {
		a.mu.Unlock()
		return true
	}
	drained := a.drained
	a.mu.Unlock()

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-drained:
		return true
	case <-timer.C:
		return false
	}
}

func validateOptions(options Options) error {
	if err := validateCanonicalServiceSID(options.OwnServiceSID); err != nil {
		return fmt.Errorf("%w: own service SID %v", ErrInvalidOptions, err)
	}
	for _, timeout := range []struct {
		name  string
		value time.Duration
	}{
		{name: "connect", value: options.ConnectTimeout},
		{name: "I/O", value: options.IOTimeout},
		{name: "close", value: options.CloseTimeout},
	} {
		if timeout.value <= 0 || timeout.value > maximumTimeout {
			return fmt.Errorf("%w: %s timeout is outside the supported range", ErrInvalidOptions, timeout.name)
		}
	}
	return nil
}

func validateCanonicalServiceSID(value string) error {
	parts := strings.Split(value, "-")
	if len(parts) != 9 || parts[0] != "S" || parts[1] != "1" || parts[2] != "5" || parts[3] != "80" {
		return errors.New("must be a canonical S-1-5-80 service SID")
	}
	for _, part := range parts[4:] {
		parsed, err := strconv.ParseUint(part, 10, 32)
		if err != nil || strconv.FormatUint(parsed, 10) != part {
			return errors.New("must be a canonical S-1-5-80 service SID")
		}
	}
	return nil
}

func generatePipeName(random io.Reader) (string, error) {
	if random == nil {
		return "", fmt.Errorf("%w: random source is required", ErrInvalidOptions)
	}
	nonce := make([]byte, pipeNonceBytes)
	if _, err := io.ReadFull(random, nonce); err != nil {
		return "", fmt.Errorf("generate HostControl pipe nonce: %w", err)
	}
	name := pipeNamePrefix + hex.EncodeToString(nonce)
	if len([]rune(name)) > maximumPipeNameUnits {
		return "", errors.New("generated HostControl pipe name exceeds the Windows limit")
	}
	return name, nil
}

func expectedDACL(ownServiceSID string) []accessEntry {
	return []accessEntry{
		{SID: localSystemSID, Mask: fileAllAccessMask, ACEType: accessAllowedACEType, Flags: noACEFlags},
		{SID: builtinAdministratorsSID, Mask: fileAllAccessMask, ACEType: accessAllowedACEType, Flags: noACEFlags},
		{SID: ownServiceSID, Mask: nodeDuplexAccessMask, ACEType: accessAllowedACEType, Flags: noACEFlags},
	}
}

func securityDescriptorString(ownServiceSID string) string {
	return fmt.Sprintf(
		"D:P(A;;0x%08x;;;SY)(A;;0x%08x;;;BA)(A;;0x%08x;;;%s)",
		fileAllAccessMask,
		fileAllAccessMask,
		nodeDuplexAccessMask,
		ownServiceSID,
	)
}

func validateDACL(evidence daclEvidence, ownServiceSID string) error {
	requiredControl := securityDescriptorDACLPresent | securityDescriptorDACLProtected
	if evidence.Control&requiredControl != requiredControl || !evidence.Present || !evidence.Protected {
		return errors.New("HostControl pipe does not contain a protected DACL")
	}
	if evidence.Null {
		return errors.New("HostControl pipe contains a null DACL")
	}
	if evidence.Defaulted {
		return errors.New("HostControl pipe DACL is defaulted")
	}
	wantEntries := expectedDACL(ownServiceSID)
	if len(evidence.Entries) != len(wantEntries) {
		return fmt.Errorf("HostControl pipe DACL contains %d ACEs, want %d", len(evidence.Entries), len(wantEntries))
	}
	want := make(map[string]accessEntry, len(wantEntries))
	for _, entry := range wantEntries {
		want[entry.SID] = entry
	}
	seen := make(map[string]struct{}, len(evidence.Entries))
	for _, entry := range evidence.Entries {
		expected, exists := want[entry.SID]
		if !exists {
			return fmt.Errorf("HostControl pipe DACL contains unexpected SID %s", entry.SID)
		}
		if _, duplicate := seen[entry.SID]; duplicate {
			return fmt.Errorf("HostControl pipe DACL contains duplicate SID %s", entry.SID)
		}
		seen[entry.SID] = struct{}{}
		if entry != expected {
			return fmt.Errorf("HostControl pipe DACL ACE for %s is %+v, want %+v", entry.SID, entry, expected)
		}
	}
	return nil
}

func verifyConnectedNode(
	pipeName string,
	observer clientPIDObserver,
	node retainedNode,
) (VerificationEvidence, error) {
	if observer == nil || isNilInterface(node) {
		return VerificationEvidence{}, fmt.Errorf("%w: PID observer and retained Node are required", ErrPeerMismatch)
	}
	baseline := node.StableIdentity()
	if baseline.ProcessID == 0 || baseline.CreationTime.IsZero() || node.ProcessID() != baseline.ProcessID {
		return VerificationEvidence{}, fmt.Errorf("%w: retained Node baseline identity is incomplete", ErrPeerMismatch)
	}
	if baseline.StartKeyAvailable && baseline.StartKeySequenceNumber == 0 {
		return VerificationEvidence{}, fmt.Errorf("%w: retained Node baseline start key is zero", ErrPeerMismatch)
	}

	countBefore, err := node.RootJobActiveProcessCount()
	if err != nil {
		return VerificationEvidence{}, fmt.Errorf("observe root Job before HostControl binding: %w", err)
	}
	if countBefore != 1 {
		return VerificationEvidence{}, fmt.Errorf("%w: root Job contains %d active processes before binding, want 1", ErrPeerMismatch, countBefore)
	}
	identityBefore, err := node.ObserveIdentity()
	if err != nil {
		return VerificationEvidence{}, fmt.Errorf("observe retained Node before pipe PID: %w", err)
	}
	if !sameIdentity(identityBefore, baseline) {
		return VerificationEvidence{}, fmt.Errorf("%w: retained Node identity changed before pipe PID observation", ErrPeerMismatch)
	}
	firstPID, err := observer.ClientProcessID()
	if err != nil {
		return VerificationEvidence{}, fmt.Errorf("observe HostControl client PID before retained Node recheck: %w", err)
	}
	identityMiddle, err := node.ObserveIdentity()
	if err != nil {
		return VerificationEvidence{}, fmt.Errorf("reobserve retained Node between pipe PID reads: %w", err)
	}
	if !sameIdentity(identityMiddle, baseline) {
		return VerificationEvidence{}, fmt.Errorf("%w: retained Node identity changed between pipe PID observations", ErrPeerMismatch)
	}
	secondPID, err := observer.ClientProcessID()
	if err != nil {
		return VerificationEvidence{}, fmt.Errorf("observe HostControl client PID after retained Node recheck: %w", err)
	}
	identityAfter, err := node.ObserveIdentity()
	if err != nil {
		return VerificationEvidence{}, fmt.Errorf("observe retained Node after pipe PID: %w", err)
	}
	if !sameIdentity(identityAfter, baseline) {
		return VerificationEvidence{}, fmt.Errorf("%w: retained Node identity changed after pipe PID observation", ErrPeerMismatch)
	}
	if firstPID == 0 || firstPID != secondPID || firstPID != baseline.ProcessID {
		return VerificationEvidence{}, fmt.Errorf(
			"%w: pipe client PID observations are %d and %d, retained Node PID is %d",
			ErrPeerMismatch,
			firstPID,
			secondPID,
			baseline.ProcessID,
		)
	}
	countAfter, err := node.RootJobActiveProcessCount()
	if err != nil {
		return VerificationEvidence{}, fmt.Errorf("observe root Job after HostControl binding: %w", err)
	}
	if countAfter != 1 {
		return VerificationEvidence{}, fmt.Errorf("%w: root Job contains %d active processes after binding, want 1", ErrPeerMismatch, countAfter)
	}
	return VerificationEvidence{
		PipeName:                     pipeName,
		ClientProcessIDBefore:        firstPID,
		ClientProcessIDAfter:         secondPID,
		NodeIdentity:                 baseline,
		RootJobActiveProcessesBefore: countBefore,
		RootJobActiveProcessesAfter:  countAfter,
	}, nil
}

func completeRuntimeBootstrap(
	ctx context.Context,
	channel localrpc.RuntimeBootstrapChannel,
	node runtimeBootstrapNode,
	evidence VerificationEvidence,
	bootstrap localrpc.RuntimeBootstrapV1,
) (localrpc.CommittedRuntimeBootstrap, error) {
	pendingCommit, err := localrpc.BeginRuntimeBootstrapExchange(ctx, channel, bootstrap)
	if err != nil {
		return localrpc.CommittedRuntimeBootstrap{}, fmt.Errorf("exchange RuntimeBootstrapV1: %w", err)
	}
	if cause := context.Cause(ctx); cause != nil {
		return localrpc.CommittedRuntimeBootstrap{}, cause
	}
	if err := verifyNodeBeforeActivation(node, evidence); err != nil {
		return localrpc.CommittedRuntimeBootstrap{}, err
	}
	if cause := context.Cause(ctx); cause != nil {
		return localrpc.CommittedRuntimeBootstrap{}, cause
	}
	if err := node.ActivateAfterHostControl(); err != nil {
		return localrpc.CommittedRuntimeBootstrap{}, fmt.Errorf("activate Node after RuntimeBootstrapV1 acknowledgement: %w", err)
	}
	committed, err := pendingCommit.Commit(ctx)
	if err != nil {
		return localrpc.CommittedRuntimeBootstrap{}, fmt.Errorf("commit RuntimeBootstrapV1 after Node activation: %w", err)
	}
	return committed, nil
}

func verifyNodeBeforeActivation(node retainedNode, evidence VerificationEvidence) error {
	if isNilInterface(node) || !sameIdentity(node.StableIdentity(), evidence.NodeIdentity) ||
		node.ProcessID() != evidence.NodeIdentity.ProcessID {
		return fmt.Errorf("%w: retained Node activation identity is invalid", ErrPeerMismatch)
	}
	identityBefore, err := node.ObserveIdentity()
	if err != nil {
		return fmt.Errorf("reobserve retained Node before activation: %w", err)
	}
	if !sameIdentity(identityBefore, evidence.NodeIdentity) {
		return fmt.Errorf("%w: retained Node identity changed during bootstrap", ErrPeerMismatch)
	}
	activeProcesses, err := node.RootJobActiveProcessCount()
	if err != nil {
		return fmt.Errorf("reobserve root Job before activation: %w", err)
	}
	if activeProcesses != 1 {
		return fmt.Errorf("%w: root Job contains %d active processes before activation, want 1", ErrPeerMismatch, activeProcesses)
	}
	identityAfter, err := node.ObserveIdentity()
	if err != nil {
		return fmt.Errorf("reobserve retained Node after root Job check: %w", err)
	}
	if !sameIdentity(identityAfter, evidence.NodeIdentity) {
		return fmt.Errorf("%w: retained Node identity changed around root Job activation check", ErrPeerMismatch)
	}
	return nil
}

func rejectAcceptFailure(
	connection *Connection,
	primary error,
	node interface{ Terminate() error },
	markTerminal func(),
	closeEndpoint func() error,
) (*Connection, error) {
	terminateErr, closeErr := terminateBeforeClose(node, markTerminal, closeEndpoint)
	resultErr := primary
	if cleanupErr := errors.Join(terminateErr, closeErr); cleanupErr != nil {
		resultErr = errors.Join(primary, cleanupErr)
	}
	if connection != nil && closeErr != nil {
		return connection, resultErr
	}
	return nil, resultErr
}

func terminateBeforeClose(
	node interface{ Terminate() error },
	markTerminal func(),
	closeEndpoint func() error,
) (error, error) {
	terminateErr := node.Terminate()
	markTerminal()
	closeErr := closeEndpoint()
	return terminateErr, closeErr
}

func sameIdentity(left, right winprocess.NodeIdentity) bool {
	return left.ProcessID == right.ProcessID &&
		left.CreationTime.Equal(right.CreationTime) &&
		left.StartKeyAvailable == right.StartKeyAvailable &&
		left.StartKeySequenceNumber == right.StartKeySequenceNumber
}

func isNilInterface(value any) bool {
	if value == nil {
		return true
	}
	reflection := reflect.ValueOf(value)
	switch reflection.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return reflection.IsNil()
	default:
		return false
	}
}
