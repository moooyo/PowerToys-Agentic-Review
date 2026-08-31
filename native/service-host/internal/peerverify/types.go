package peerverify

import (
	"context"
	"errors"
	"io"
	"sync"
	"time"
)

var (
	ErrUnsupportedPlatform = errors.New("ServiceHost peer verification requires Windows")
	ErrInvalidOptions      = errors.New("invalid ServiceHost peer verification options")
	ErrPeerUnstable        = errors.New("named-pipe peer process is not stable")
	ErrWrapperUnstable     = errors.New("verified WinSW wrapper process is not stable")
	ErrParentMismatch      = errors.New("ServiceHost is not a direct child of the verified WinSW wrapper")
	ErrImageMismatch       = errors.New("reopened executable candidate does not match its pinned file identity")
	ErrAuthenticode        = errors.New("reopened executable candidate failed Authenticode verification")
	ErrTokenMismatch       = errors.New("peer process token does not have the expected restricted service SID")
	ErrClosed              = errors.New("verified peer session is closed")
)

// PipePeer selects which endpoint process ID is observed. Control verifies a
// client; Executor verifies a server.
type PipePeer uint8

const (
	PipePeerUnknown PipePeer = iota
	PipePeerClient
	PipePeerServer
)

// ImageExpectation is a manifest-pinned executable path and SHA-256 digest.
// SHA256 must be a lowercase, 64-character hexadecimal digest. The containing
// installation tree must have already passed the prerequisite immutability and
// protected-ancestor checks; this package only reopens this one path.
type ImageExpectation struct {
	Path   string
	SHA256 string
}

// StableProcessFacts are facts already bound to a retained process object.
type StableProcessFacts struct {
	ProcessID    uint32
	CreationTime time.Time
	StartKey     ProcessStartKey
}

// ProcessStartKey is the kernel process sequence number when the running
// Windows version exposes ProcessSequenceNumber. CreationTime plus the retained
// handle remains the mandatory fallback when Available is false.
type ProcessStartKey struct {
	Available      bool
	SequenceNumber uint64
}

// FileIdentity is the FILE_ID_INFO identity of an open image file.
type FileIdentity struct {
	VolumeSerialNumber uint64
	FileID             [16]byte
}

// ImageSubject is a read-only file reopened from the retained process's path.
// It is bound to its own file handle, not to the process's mapped image section.
// Implementations must reject reparse points, directories, delete-pending
// files, and files with more than one hard link. The verifier owns the object
// and closes it after hashing and Authenticode inspection; callbacks must not
// retain it.
//
// ProcessPathDiagnostic and FinalPathDiagnostic are diagnostic strings. They
// select the applicable manifest pin but are not themselves identity proof.
type ImageSubject interface {
	io.ReaderAt
	Size() int64
	Identity() FileIdentity
	ProcessPathDiagnostic() string
	FinalPathDiagnostic() (string, error)
	VerifyUnchanged() error
	// Close must retain every original native handle when it returns an error
	// so a later Close call can retry. Successful repeated calls return nil.
	Close() error
}

// StableProcess is a retained process object. Its query methods must remain
// bound to the same native process handle until Close. OpenImage must derive
// the image path from that handle and return a separately retained read-only
// file object. Wait must promptly honor context cancellation.
type StableProcess interface {
	HandleProcessID() (uint32, error)
	StillActive() (bool, error)
	HandleCreationTime() (time.Time, error)
	HandleStartKey() (ProcessStartKey, error)
	ImagePathDiagnostic() (string, error)
	OpenImage() (ImageSubject, error)
	Wait(context.Context) error
	// Close must retain every original native handle when it returns an error
	// so a later Close call can retry. Successful repeated calls return nil.
	Close() error
}

// PeerProcess adds the lineage and token observations required for the pipe
// endpoint. TokenSnapshot must open the primary token with exactly TOKEN_QUERY,
// capture the snapshot, and close the token before returning. Wrapper adapters
// do not need these capabilities.
type PeerProcess interface {
	StableProcess
	DirectParentProcessID() (uint32, error)
	TokenSnapshot() (TokenSnapshot, error)
}

// StableWrapper is an already-verified WinSW wrapper and its retained process
// object. Verify takes ownership of it on every call, including rejected calls.
// StableFacts must be the facts established when the wrapper handle was opened
// around stable SCM observations. Its inherited Close contract also requires
// retaining the wrapper's original handle after every failed close attempt.
type StableWrapper interface {
	StableProcess
	StableFacts() StableProcessFacts
}

// AuthenticodeEvidence is returned by a policy-aware verifier. Trusted may be
// true only when the selected Authenticode signature and its trust policy both
// pass. VerifiedLeafSignerCertificateDERSHA256 must be the SHA-256 of the exact
// DER leaf certificate referenced by that same signature's SignerInfo. It must
// never identify a chain CA, timestamp countersigner, unrelated PKCS#7
// certificate, or a signer from another signature on a multi-signed file.
type AuthenticodeEvidence struct {
	Trusted                                bool
	SignerIdentity                         string
	VerifiedLeafSignerCertificateDERSHA256 string
}

// AuthenticodeVerifier validates the PE signature from the supplied reopened
// file handle. It must not reopen ProcessPathDiagnostic or otherwise replace
// the supplied subject with another path-based check. This package does not
// provide a production implementation. A multi-signature verifier must bind
// trust and the reported leaf certificate atomically to the same signature.
type AuthenticodeVerifier interface {
	VerifyAuthenticode(ImageSubject) (AuthenticodeEvidence, error)
}

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

// PrerequisiteEvidence represents checks intentionally owned by other reviewed
// platform adapters. Boolean values are not self-authenticating; production
// composition must set them only from retained, independently validated
// installation, SCM, and DACL evidence.
type PrerequisiteEvidence struct {
	ImmutableInstallationTreeVerified bool
	StableSCMWrapperLaunchVerified    bool
	ProcessAndTokenDACLsVerified      bool
}

// Options contain every caller-controlled peer-verification expectation.
type Options struct {
	PipePeer                               PipePeer
	ExpectedServiceSID                     string
	WrapperImage                           ImageExpectation
	ServiceHostImage                       ImageExpectation
	ExpectedLeafSignerCertificateDERSHA256 string
	Prerequisites                          PrerequisiteEvidence
	AuthenticodeVerifier                   AuthenticodeVerifier
	TokenVerifier                          TokenVerifier
}

// PIDObservationEvidence records the two source reads surrounding process
// handle acquisition. Equality is necessary for stability but is not identity
// proof or authentication.
type PIDObservationEvidence struct {
	BeforeOpen uint32
	AfterOpen  uint32
}

// ImageEvidence binds a digest and Authenticode result to one retained file
// identity. Path fields remain diagnostic.
type ImageEvidence struct {
	ExpectedPath                           string
	ProcessPathDiagnostic                  string
	FinalPathDiagnostic                    string
	FinalPathDiagnosticError               string
	Identity                               FileIdentity
	Size                                   int64
	SHA256                                 string
	ExpectedLeafSignerCertificateDERSHA256 string
	Authenticode                           AuthenticodeEvidence
}

// ProcessEvidence contains stable process and image facts. DirectParentID is
// populated for the peer ServiceHost and zero for the wrapper.
type ProcessEvidence struct {
	ProcessID      uint32
	CreationTime   time.Time
	StartKey       ProcessStartKey
	DirectParentID uint32
	Image          ImageEvidence
}

// VerificationEvidence is audit evidence, not a cryptographic authentication
// assertion. The retained process objects are the lifetime anchors.
type VerificationEvidence struct {
	Prerequisites PrerequisiteEvidence
	PipePID       PIDObservationEvidence
	Wrapper       ProcessEvidence
	ServiceHost   ProcessEvidence
	PeerToken     TokenEvidence
}

// Session owns the stable peer ServiceHost and WinSW wrapper objects. They stay
// open until Close so PID reuse cannot retarget later checks in the session.
type Session struct {
	mu            sync.Mutex
	activeWaits   sync.WaitGroup
	peer          PeerProcess
	wrapper       StableWrapper
	evidence      VerificationEvidence
	waitContext   context.Context
	cancelWaits   context.CancelFunc
	closed        bool
	closing       bool
	closeComplete chan struct{}
}

// Evidence returns the detached facts captured during verification.
func (s *Session) Evidence() VerificationEvidence {
	if s == nil {
		return VerificationEvidence{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.evidence
}

// WaitPeer waits for the retained ServiceHost process or cancellation. Close
// cancels an active wait before joining it.
func (s *Session) WaitPeer(ctx context.Context) error {
	return s.wait(ctx, false)
}

// WaitWrapper waits for the retained WinSW wrapper process or cancellation.
// Close cancels an active wait before joining it.
func (s *Session) WaitWrapper(ctx context.Context) error {
	return s.wait(ctx, true)
}

func (s *Session) wait(ctx context.Context, wrapper bool) error {
	if s == nil || ctx == nil {
		if ctx == nil {
			return errors.New("process wait context is required")
		}
		return ErrClosed
	}
	s.mu.Lock()
	if s.closed || s.waitContext == nil {
		s.mu.Unlock()
		return ErrClosed
	}
	var process StableProcess = s.peer
	if wrapper {
		process = s.wrapper
	}
	if isNilInterface(process) {
		s.mu.Unlock()
		return ErrClosed
	}
	lifetime := s.waitContext
	s.activeWaits.Add(1)
	s.mu.Unlock()
	defer s.activeWaits.Done()

	waitContext, cancel := context.WithCancel(ctx)
	stopLifetimeCancellation := context.AfterFunc(lifetime, cancel)
	defer func() {
		stopLifetimeCancellation()
		cancel()
	}()
	return process.Wait(waitContext)
}

// Close cancels and joins active waits before releasing retained process
// objects. No new wait can begin after closing starts. If an underlying close
// fails, that object remains owned by the Session and a later Close retries it.
func (s *Session) Close() error {
	if s == nil {
		return nil
	}
	for {
		s.mu.Lock()
		if s.closing {
			complete := s.closeComplete
			s.mu.Unlock()
			<-complete
			continue
		}
		if isNilInterface(s.peer) && isNilInterface(s.wrapper) {
			s.closed = true
			s.mu.Unlock()
			return nil
		}
		s.closed = true
		s.closing = true
		s.closeComplete = make(chan struct{})
		complete := s.closeComplete
		cancelWaits := s.cancelWaits
		peer := s.peer
		wrapper := s.wrapper
		s.mu.Unlock()

		if cancelWaits != nil {
			cancelWaits()
		}
		s.activeWaits.Wait()
		peerErr := closeStableProcess("close verified peer ServiceHost process", peer)
		wrapperErr := closeStableProcess("close verified WinSW wrapper process", wrapper)
		closeErr := errors.Join(peerErr, wrapperErr)

		s.mu.Lock()
		if peerErr == nil {
			s.peer = nil
		}
		if wrapperErr == nil {
			s.wrapper = nil
		}
		s.closing = false
		close(complete)
		s.mu.Unlock()
		return closeErr
	}
}
