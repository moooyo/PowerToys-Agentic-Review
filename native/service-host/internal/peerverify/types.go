package peerverify

import (
	"context"
	"errors"
	"sync"
)

var (
	ErrUnsupportedPlatform        = errors.New("ServiceHost peer verification requires Windows")
	ErrInvalidOptions             = errors.New("invalid ServiceHost peer verification options")
	ErrNativeHandleOwnershipFatal = errors.New("peer verifier native handle ownership is unresolved; the current ServiceHost process must exit")
	ErrPeerUnstable               = errors.New("peer service process is not stable")
	ErrTokenMismatch              = errors.New("peer process token does not have the expected restricted service SID")
	ErrClosed                     = errors.New("verified peer session is closed")
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
