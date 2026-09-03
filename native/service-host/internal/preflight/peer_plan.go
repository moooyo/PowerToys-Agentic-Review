package preflight

import (
	"errors"
	"fmt"
	"sync"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peerverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winpipe"
)

// PeerVerificationPlan contains only the fixed service and pipe identity plus
// provenance digests for the preflight evidence that created it.
type PeerVerificationPlan struct {
	role            config.Role
	ownService      config.ServiceIdentity
	peerService     config.ServiceIdentity
	pipeName        string
	preflightDigest [32]byte
	releaseDigest   [32]byte
	valid           bool
}

func (plan PeerVerificationPlan) Role() config.Role                  { return plan.role }
func (plan PeerVerificationPlan) OwnService() config.ServiceIdentity { return plan.ownService }
func (plan PeerVerificationPlan) PeerService() config.ServiceIdentity {
	return plan.peerService
}
func (plan PeerVerificationPlan) PipeName() string                { return plan.pipeName }
func (plan PeerVerificationPlan) PreflightDigest() [32]byte       { return plan.preflightDigest }
func (plan PeerVerificationPlan) ReleaseTemplateDigest() [32]byte { return plan.releaseDigest }

// PeerVerificationPlan derives the fixed opposing service identity from
// validated preflight evidence. Runtime image files are not peer identity.
func (e Evidence) PeerVerificationPlan() (PeerVerificationPlan, error) {
	if err := e.Validate(); err != nil {
		return PeerVerificationPlan{}, err
	}
	configuration := e.Configuration()
	plan := PeerVerificationPlan{
		role:            e.role,
		ownService:      configuration.OwnService,
		peerService:     configuration.PeerService,
		pipeName:        configuration.PipeName,
		preflightDigest: e.digest,
		releaseDigest:   e.release.templateDigest,
		valid:           true,
	}
	if err := plan.Validate(); err != nil {
		return PeerVerificationPlan{}, err
	}
	return plan, nil
}

// Validate rejects zero, mutated, or inconsistent plans.
func (plan PeerVerificationPlan) Validate() error {
	if !plan.valid {
		return invalidPeerVerificationPlan("peer verification plan is empty", nil)
	}
	expectedOwn := config.ServiceIdentity{Name: config.ControlServiceName, SID: config.ControlServiceSID}
	expectedPeer := config.ServiceIdentity{Name: config.ExecutorServiceName, SID: config.ExecutorServiceSID}
	if plan.role == config.RoleExecutor {
		expectedOwn, expectedPeer = expectedPeer, expectedOwn
	} else if plan.role != config.RoleControl {
		return invalidPeerVerificationPlan("peer verification role is unsupported", nil)
	}
	if plan.ownService != expectedOwn || plan.peerService != expectedPeer ||
		plan.pipeName != config.ControlExecutorPipeName {
		return invalidPeerVerificationPlan("peer service or pipe identity is inconsistent", nil)
	}
	if plan.preflightDigest == ([32]byte{}) || plan.releaseDigest == ([32]byte{}) {
		return invalidPeerVerificationPlan("peer verification provenance is unavailable", nil)
	}
	return nil
}

type peerEndpointAttestationFacts struct {
	source            winpipe.EndpointAttestation
	valid             bool
	pipeName          string
	maximumFrameBytes uint32
	localSide         winpipe.EndpointSide
	connected         bool
	ownServiceSID     string
	peerServiceSID    string
	serverDACL        bool
}

type peerEndpointAttestor func() (peerEndpointAttestationFacts, error)

type peerVerificationRequest struct {
	role     config.Role
	endpoint *winpipe.Endpoint
}

type peerWindowsVerifier func(peerVerificationRequest) (*peerverify.Session, error)
type peerSessionCloser func(*peerverify.Session) error

const rejectedPeerSessionCloseAttempts = 3

var rejectedPeerSessions struct {
	sync.Mutex
	owners []*peerverify.Session
}

//go:noinline
func claimProductionPeerWindowsVerifier() (peerverify.PreflightWindowsVerifier, error) {
	return peerverify.ClaimPreflightWindowsVerifier()
}

var (
	productionPeerWindowsVerifier, productionPeerWindowsVerifierErr = claimProductionPeerWindowsVerifier()
)

// VerifyWindows validates the connected endpoint before and after retaining
// the peer service process.
func (plan PeerVerificationPlan) VerifyWindows(endpoint *winpipe.Endpoint) (*peerverify.Session, error) {
	return verifyPeerWindows(
		plan,
		endpoint,
		func() (peerEndpointAttestationFacts, error) {
			attestation, err := endpoint.Attestation()
			if err != nil {
				return peerEndpointAttestationFacts{}, err
			}
			return peerEndpointAttestationFacts{
				source:            attestation,
				valid:             attestation.Valid(),
				pipeName:          attestation.PipeName(),
				maximumFrameBytes: attestation.MaximumFrameBytes(),
				localSide:         attestation.LocalSide(),
				connected:         attestation.Connected(),
				ownServiceSID:     attestation.ValidatedOwnServiceSID(),
				peerServiceSID:    attestation.ValidatedPeerServiceSID(),
				serverDACL:        attestation.ServerDACLValidated(),
			}, nil
		},
		func(request peerVerificationRequest) (*peerverify.Session, error) {
			if productionPeerWindowsVerifierErr != nil {
				return nil, preflightError(
					ErrorPeerVerification,
					"claim native peer verifier authority",
					productionPeerWindowsVerifierErr,
				)
			}
			return productionPeerWindowsVerifier.Verify(request.role, request.endpoint)
		},
		func(session *peerverify.Session) error { return session.Close() },
	)
}

func verifyPeerWindows(
	plan PeerVerificationPlan,
	endpoint *winpipe.Endpoint,
	attest peerEndpointAttestor,
	verify peerWindowsVerifier,
	closeSession peerSessionCloser,
) (*peerverify.Session, error) {
	if err := plan.Validate(); err != nil {
		return nil, err
	}
	if endpoint == nil {
		return nil, invalidPeerVerificationPlan("named-pipe endpoint is required", nil)
	}
	if attest == nil || verify == nil || closeSession == nil {
		return nil, invalidPeerVerificationPlan("peer verification implementation is unavailable", nil)
	}
	before, err := attest()
	if err != nil {
		return nil, preflightError(ErrorPeerVerification, "attest named-pipe endpoint", err)
	}
	if err := validatePeerEndpointAttestation(plan, before); err != nil {
		return nil, err
	}
	session, err := verify(peerVerificationRequest{role: plan.role, endpoint: endpoint})
	if err != nil {
		return nil, errors.Join(err, closeRejectedPeerSession(session, closeSession))
	}
	if session == nil {
		return nil, invalidPeerVerificationPlan("peer verifier returned no session", nil)
	}
	after, err := attest()
	if err != nil {
		return nil, errors.Join(
			preflightError(ErrorPeerVerification, "reattest named-pipe endpoint after peer verification", err),
			closeRejectedPeerSession(session, closeSession),
		)
	}
	if err := validatePeerEndpointAttestation(plan, after); err != nil {
		return nil, errors.Join(err, closeRejectedPeerSession(session, closeSession))
	}
	if after != before {
		return nil, errors.Join(
			invalidPeerVerificationPlan("named-pipe endpoint attestation changed during peer verification", nil),
			closeRejectedPeerSession(session, closeSession),
		)
	}
	return session, nil
}

func closeRejectedPeerSession(session *peerverify.Session, closeSession peerSessionCloser) error {
	if session == nil {
		return nil
	}
	var failures []error
	for attempt := 1; attempt <= rejectedPeerSessionCloseAttempts; attempt++ {
		if err := closeSession(session); err != nil {
			failures = append(failures, fmt.Errorf("close rejected peer session attempt %d: %w", attempt, err))
			if errors.Is(err, peerverify.ErrNativeHandleOwnershipFatal) {
				break
			}
			continue
		}
		return errors.Join(failures...)
	}
	rejectedPeerSessions.Lock()
	rejectedPeerSessions.owners = append(rejectedPeerSessions.owners, session)
	rejectedPeerSessions.Unlock()
	return errors.Join(ErrPeerCleanupFatal, errors.Join(failures...))
}

func validatePeerEndpointAttestation(plan PeerVerificationPlan, facts peerEndpointAttestationFacts) error {
	if !facts.valid || !facts.connected || facts.pipeName != plan.pipeName ||
		facts.maximumFrameBytes != config.MaximumFrameBytes {
		return invalidPeerVerificationPlan("named-pipe endpoint attestation differs from the plan", nil)
	}
	if plan.role == config.RoleControl {
		if facts.localSide != winpipe.EndpointSideServer || !facts.serverDACL ||
			facts.ownServiceSID != plan.ownService.SID ||
			facts.peerServiceSID != plan.peerService.SID {
			return invalidPeerVerificationPlan("Control endpoint security attestation is inconsistent", nil)
		}
		return nil
	}
	if facts.localSide != winpipe.EndpointSideClient || facts.serverDACL ||
		facts.ownServiceSID != "" || facts.peerServiceSID != "" {
		return invalidPeerVerificationPlan("Executor endpoint security attestation is inconsistent", nil)
	}
	return nil
}

func invalidPeerVerificationPlan(message string, cause error) error {
	return preflightError(ErrorPeerVerification, message, errors.Join(ErrInvalidEvidence, cause))
}

type atomicPeerVerifier interface {
	VerifyWindows(*winpipe.Endpoint) (*peerverify.Session, error)
}

var _ atomicPeerVerifier = PeerVerificationPlan{}
