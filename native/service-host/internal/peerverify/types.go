package peerverify

import (
	"context"
	"errors"
	"io"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winpipe"
)

var (
	ErrUnsupportedPlatform          = errors.New("ServiceHost peer verification requires Windows")
	ErrInvalidOptions               = errors.New("invalid ServiceHost peer verification options")
	ErrPreflightVerifierUnavailable = errors.New("preflight Windows peer verifier authority is unavailable")
	ErrNativeHandleOwnershipFatal   = errors.New("peer verifier native handle ownership is unresolved; the current ServiceHost process must exit")
	ErrPeerUnstable                 = errors.New("peer service process is not stable")
	ErrTokenMismatch                = errors.New("peer process token does not have the expected restricted service SID")
	ErrClosed                       = errors.New("verified peer session is closed")
	// ErrImageMismatch is a temporary compile bridge for servicebootstrap.
	ErrImageMismatch = errors.New("reopened executable candidate does not match its pinned file identity")
)

// PipePeer selects which endpoint process ID is observed. Control verifies a
// client; Executor verifies a server.
type PipePeer uint8

const (
	PipePeerUnknown PipePeer = iota
	PipePeerClient
	PipePeerServer
)

// SIDAttributes is a detached SID_AND_ATTRIBUTES observation.
type SIDAttributes struct {
	SID        string
	Attributes uint32
}

// LUID is a detached Windows locally unique identifier.
type LUID struct {
	LowPart  uint32
	HighPart int32
}

// TokenStatistics contains the identity and mutation counters sampled from
// TOKEN_STATISTICS around all variable token queries.
type TokenStatistics struct {
	TokenID            LUID
	AuthenticationID   LUID
	ModifiedID         LUID
	Type               uint32
	ImpersonationLevel uint32
	GroupCount         uint32
	PrivilegeCount     uint32
}

// PrivilegeEvidence is one detached LUID_AND_ATTRIBUTES entry.
type PrivilegeEvidence struct {
	Name       string
	LUID       LUID
	Attributes uint32
}

// TokenSnapshot is detached evidence read through a TOKEN_QUERY-only handle.
// It deliberately contains no native handle.
type TokenSnapshot struct {
	StatisticsBefore TokenStatistics
	StatisticsAfter  TokenStatistics
	HasRestrictions  bool
	User             SIDAttributes
	Groups           []SIDAttributes
	RestrictedSIDs   []SIDAttributes
	Privileges       []PrivilegeEvidence
}

// TokenEvidence is the minimum semantic proof accepted by the peer verifier.
type TokenEvidence struct {
	Statistics               TokenStatistics
	ServiceSID               string
	LogonSID                 string
	PrimaryToken             bool
	TokenRestricted          bool
	TokenUserMatches         bool
	ServiceSIDEnabled        bool
	ServiceSIDIsRestricting  bool
	NoAdministrativeSID      bool
	NoBuiltInServiceIdentity bool
	RestrictedSIDSetExact    bool
	NoHighRiskPrivileges     bool
	TokenStatisticsStable    bool
}

// TokenVerifier converts a TOKEN_QUERY-only snapshot into service-identity
// evidence. The peer verifier independently checks every evidence field.
type TokenVerifier interface {
	VerifyToken(TokenSnapshot, string) (TokenEvidence, error)
}

// PeerProcess is the retained opposing Windows service process. The primary
// token must be opened with TOKEN_QUERY only. Wait must honor cancellation.
type PeerProcess interface {
	HandleProcessID() (uint32, error)
	StillActive() (bool, error)
	TokenSnapshot() (TokenSnapshot, error)
	Wait(context.Context) error
	Close() error
}

// The following compatibility types exist only so the separate unpublished
// servicebootstrap cleanup can merge independently. The current peer verifier
// neither accepts nor uses them, and integration removes them with that code.
type ProcessStartKey struct {
	Available      bool
	SequenceNumber uint64
}

type StableProcessFacts struct {
	ProcessID    uint32
	CreationTime time.Time
	StartKey     ProcessStartKey
}

type FileIdentity struct {
	VolumeSerialNumber uint64
	FileID             [16]byte
}

type ImageSubject interface {
	io.ReaderAt
	Size() int64
	Identity() FileIdentity
	ProcessPathDiagnostic() string
	FinalPathDiagnostic() (string, error)
	VerifyUnchanged() error
	Close() error
}

// StableWrapper is a temporary compile bridge for the old servicebootstrap
// package. It is not part of the peer verification path.
type StableWrapper interface {
	HandleProcessID() (uint32, error)
	StillActive() (bool, error)
	HandleCreationTime() (time.Time, error)
	HandleStartKey() (ProcessStartKey, error)
	ImagePathDiagnostic() (string, error)
	OpenImage() (ImageSubject, error)
	Wait(context.Context) error
	Close() error
	StableFacts() StableProcessFacts
}

type productionOptions struct {
	Role         config.Role
	PipeEndpoint *winpipe.Endpoint
}

// PreflightWindowsVerifier is the opaque process-wide authority for native
// Windows peer verification. Its zero value fails closed.
type PreflightWindowsVerifier struct {
	verify func(productionOptions) (*Session, error)
}

var preflightWindowsVerifierClaim struct {
	sync.Mutex
	claimed bool
}

const (
	preflightPlanPackagePath = "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/preflight"
	preflightPlanClaimFunc   = preflightPlanPackagePath + ".claimProductionPeerWindowsVerifier"
	preflightPlanSourcePath  = "/internal/preflight/peer_plan.go"
)

// ClaimPreflightWindowsVerifier transfers the sole process-wide verification
// authority to preflight's fixed plan bridge.
//
//go:noinline
func ClaimPreflightWindowsVerifier() (PreflightWindowsVerifier, error) {
	programCounter, source, _, ok := runtime.Caller(1)
	caller := runtime.FuncForPC(programCounter)
	if !ok || caller == nil || caller.Name() != preflightPlanClaimFunc ||
		!strings.HasSuffix(strings.ReplaceAll(source, `\`, "/"), preflightPlanSourcePath) {
		return PreflightWindowsVerifier{}, errors.Join(
			ErrPreflightVerifierUnavailable,
			errors.New("caller is not preflight's reviewed package initializer"),
		)
	}
	return claimPreflightWindowsVerifier()
}

func claimPreflightWindowsVerifier() (PreflightWindowsVerifier, error) {
	preflightWindowsVerifierClaim.Lock()
	defer preflightWindowsVerifierClaim.Unlock()
	if preflightWindowsVerifierClaim.claimed {
		return PreflightWindowsVerifier{}, errors.Join(
			ErrPreflightVerifierUnavailable,
			errors.New("preflight Windows peer verifier authority was already claimed"),
		)
	}
	preflightWindowsVerifierClaim.claimed = true
	return PreflightWindowsVerifier{verify: verifyPreflightWindows}, nil
}

// Verify enters the fixed native verifier with the role and connected pipe.
func (verifier PreflightWindowsVerifier) Verify(
	role config.Role,
	endpoint *winpipe.Endpoint,
) (*Session, error) {
	if verifier.verify == nil {
		return nil, ErrPreflightVerifierUnavailable
	}
	if fatal := rejectedNativeOwners.fatalError(); fatal != nil {
		return nil, fatal
	}
	return verifier.verify(productionOptions{Role: role, PipeEndpoint: endpoint})
}

type verificationOptions struct {
	PipePeer           PipePeer
	LocalProcessID     uint32
	ExpectedServiceSID string
	TokenVerifier      TokenVerifier
}

// PIDObservationEvidence records the two observations surrounding retained
// process acquisition.
type PIDObservationEvidence struct {
	BeforeOpen uint32
	AfterOpen  uint32
}

// VerificationEvidence records the identity facts established for the
// retained service process.
type VerificationEvidence struct {
	SCMPID        PIDObservationEvidence
	PipePID       PIDObservationEvidence
	PeerProcessID uint32
	PeerToken     TokenEvidence
}

// Session owns the retained opposing service process for the pipe lifetime.
// Session values may be copied; every copy shares one private lifetime state.
type Session struct {
	state *sessionState
}

type sessionState struct {
	mu            sync.Mutex
	activeWaits   sync.WaitGroup
	peer          PeerProcess
	evidence      VerificationEvidence
	waitContext   context.Context
	cancelWaits   context.CancelFunc
	closed        bool
	closing       bool
	closeComplete chan struct{}
}

// Evidence returns detached verification facts.
func (s *Session) Evidence() VerificationEvidence {
	if s == nil || s.state == nil {
		return VerificationEvidence{}
	}
	s.state.mu.Lock()
	defer s.state.mu.Unlock()
	return s.state.evidence
}

// WaitPeer waits for the retained peer process or cancellation.
func (s *Session) WaitPeer(ctx context.Context) error {
	if ctx == nil {
		return errors.New("process wait context is required")
	}
	if s == nil || s.state == nil {
		return ErrClosed
	}
	state := s.state
	state.mu.Lock()
	if state.closed || state.waitContext == nil || isNilInterface(state.peer) {
		state.mu.Unlock()
		return ErrClosed
	}
	peer := state.peer
	lifetime := state.waitContext
	state.activeWaits.Add(1)
	state.mu.Unlock()
	defer state.activeWaits.Done()

	waitContext, cancel := context.WithCancel(ctx)
	stopLifetimeCancellation := context.AfterFunc(lifetime, cancel)
	defer func() {
		stopLifetimeCancellation()
		cancel()
	}()
	return peer.Wait(waitContext)
}

// Close cancels active waits, joins them, and releases the retained process.
// A failed native close keeps ownership so a later call can retry it.
func (s *Session) Close() error {
	if s == nil {
		return nil
	}
	if s.state == nil {
		return ErrClosed
	}
	state := s.state
	for {
		state.mu.Lock()
		if state.closing {
			complete := state.closeComplete
			state.mu.Unlock()
			<-complete
			continue
		}
		if isNilInterface(state.peer) {
			state.closed = true
			state.mu.Unlock()
			return nil
		}
		state.closed = true
		state.closing = true
		state.closeComplete = make(chan struct{})
		complete := state.closeComplete
		cancelWaits := state.cancelWaits
		peer := state.peer
		state.mu.Unlock()

		if cancelWaits != nil {
			cancelWaits()
		}
		state.activeWaits.Wait()
		closeErr := closePeerProcess(peer)

		state.mu.Lock()
		if closeErr == nil {
			state.peer = nil
		}
		state.closing = false
		close(complete)
		state.mu.Unlock()
		return closeErr
	}
}
