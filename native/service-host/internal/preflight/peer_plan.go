package preflight

import (
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peerverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winpipe"
)

// PeerVerificationPlan is the immutable role-local input for peerverify. It
// contains no endpoint or native object and leaves no image selection to the
// platform layer.
type PeerVerificationPlan struct {
	role               config.Role
	ownService         config.ServiceIdentity
	peerService        config.ServiceIdentity
	pipeName           string
	installationRoot   string
	wrapper            PinnedRuntimeFile
	serviceHost        PinnedRuntimeFile
	approvedSignerPin  string
	preflightDigest    [32]byte
	releaseDigest      [32]byte
	currentImageDigest [32]byte
	valid              bool
}

func (plan PeerVerificationPlan) Role() config.Role                  { return plan.role }
func (plan PeerVerificationPlan) OwnService() config.ServiceIdentity { return plan.ownService }
func (plan PeerVerificationPlan) PeerService() config.ServiceIdentity {
	return plan.peerService
}
func (plan PeerVerificationPlan) PipeName() string               { return plan.pipeName }
func (plan PeerVerificationPlan) Wrapper() PinnedRuntimeFile     { return plan.wrapper }
func (plan PeerVerificationPlan) ServiceHost() PinnedRuntimeFile { return plan.serviceHost }
func (plan PeerVerificationPlan) ApprovedSignerCertificateDERSHA256() string {
	return plan.approvedSignerPin
}
func (plan PeerVerificationPlan) PreflightDigest() [32]byte       { return plan.preflightDigest }
func (plan PeerVerificationPlan) ReleaseTemplateDigest() [32]byte { return plan.releaseDigest }
func (plan PeerVerificationPlan) CurrentImageDigest() [32]byte    { return plan.currentImageDigest }

// PeerVerificationPlan selects the exact peer wrapper and sole ServiceHost
// from release-, current-image-, and installation-bound preflight evidence.
func (e Evidence) PeerVerificationPlan() (PeerVerificationPlan, error) {
	if err := e.Validate(); err != nil {
		return PeerVerificationPlan{}, err
	}
	configuration := e.Configuration()
	wrapper, serviceHost, err := selectPeerVerificationFiles(configuration, e.files, e.release)
	if err != nil {
		return PeerVerificationPlan{}, err
	}
	plan := PeerVerificationPlan{
		role:               e.role,
		ownService:         configuration.OwnService,
		peerService:        configuration.PeerService,
		pipeName:           configuration.PipeName,
		installationRoot:   configuration.Installation.Root,
		wrapper:            PinnedRuntimeFile{path: wrapper.AbsolutePath, sha256: wrapper.SHA256},
		serviceHost:        PinnedRuntimeFile{path: serviceHost.AbsolutePath, sha256: serviceHost.SHA256},
		approvedSignerPin:  e.release.signerPin,
		preflightDigest:    e.digest,
		releaseDigest:      e.release.templateDigest,
		currentImageDigest: e.currentImage.sourceDigest,
		valid:              true,
	}
	if err := plan.Validate(); err != nil {
		return PeerVerificationPlan{}, err
	}
	return plan, nil
}

// Validate rejects zero, mutated, or semantically inconsistent plans.
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
	if _, err := parseCanonicalWindowsPath(plan.installationRoot, false); err != nil {
		return invalidPeerVerificationPlan("installation root is invalid", err)
	}
	wrapperRelative, err := ManifestRelativePath(plan.installationRoot, plan.wrapper.path)
	if err != nil || !strings.EqualFold(wrapperRelative, plan.peerService.Name+".exe") {
		return invalidPeerVerificationPlan("peer wrapper path is not the fixed peer service wrapper", err)
	}
	serviceHostRelative, err := ManifestRelativePath(plan.installationRoot, plan.serviceHost.path)
	if err != nil || serviceHostRelative != releaseprofile.ServiceHostRelativePath {
		return invalidPeerVerificationPlan("ServiceHost path is invalid", err)
	}
	if windowsPathEqual(plan.wrapper.path, plan.serviceHost.path) ||
		!validSHA256(plan.wrapper.sha256) || !validSHA256(plan.serviceHost.sha256) ||
		!validSHA256(plan.approvedSignerPin) || plan.preflightDigest == ([32]byte{}) ||
		plan.releaseDigest == ([32]byte{}) || plan.currentImageDigest == ([32]byte{}) {
		return invalidPeerVerificationPlan("peer image or signer pins are invalid", nil)
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
	role         config.Role
	endpoint     *winpipe.Endpoint
	wrapper      peerverify.ImageExpectation
	serviceHost  peerverify.ImageExpectation
	signerDERSHA string
}

type peerWindowsVerifier func(peerVerificationRequest) (*peerverify.Session, error)
type peerSessionCloser func(*peerverify.Session) error
type peerVerifierCommitGate func() (func(), error)

const rejectedPeerSessionCloseAttempts = 3

type peerSessionLifetimeQuarantine struct {
	mu     sync.RWMutex
	owners []*peerverify.Session
	fatal  error
}

var rejectedPeerSessions = &peerSessionLifetimeQuarantine{}

//go:noinline
func claimProductionPeerWindowsVerifier() (peerverify.PreflightWindowsVerifier, error) {
	return peerverify.ClaimPreflightWindowsVerifier()
}

var (
	productionPeerWindowsVerifier, productionPeerWindowsVerifierErr = claimProductionPeerWindowsVerifier()
)

// VerifyWindows atomically validates the concrete endpoint attestation and
// invokes peerverify without exposing mutable verification options.
func (plan PeerVerificationPlan) VerifyWindows(
	endpoint *winpipe.Endpoint,
) (*peerverify.Session, error) {
	return verifyPeerWindowsWithNativeCommit(
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
			return productionPeerWindowsVerifier.Verify(
				request.role,
				request.endpoint,
				request.wrapper,
				request.serviceHost,
				request.signerDERSHA,
			)
		},
		func() (func(), error) {
			if productionPeerWindowsVerifierErr != nil {
				return func() {}, productionPeerWindowsVerifierErr
			}
			return productionPeerWindowsVerifier.BeginCommit()
		},
	)
}

func verifyPeerWindows(
	plan PeerVerificationPlan,
	endpoint *winpipe.Endpoint,
	attest peerEndpointAttestor,
	verify peerWindowsVerifier,
) (*peerverify.Session, error) {
	return verifyPeerWindowsWithNativeCommit(plan, endpoint, attest, verify, nil)
}

func verifyPeerWindowsWithNativeCommit(
	plan PeerVerificationPlan,
	endpoint *winpipe.Endpoint,
	attest peerEndpointAttestor,
	verify peerWindowsVerifier,
	beginNativeCommit peerVerifierCommitGate,
) (*peerverify.Session, error) {
	return verifyPeerWindowsWithLifecycleAndCommit(
		plan,
		endpoint,
		attest,
		verify,
		func(session *peerverify.Session) error { return session.Close() },
		rejectedPeerSessions,
		beginNativeCommit,
	)
}

func verifyPeerWindowsWithLifecycle(
	plan PeerVerificationPlan,
	endpoint *winpipe.Endpoint,
	attest peerEndpointAttestor,
	verify peerWindowsVerifier,
	closeSession peerSessionCloser,
	quarantine *peerSessionLifetimeQuarantine,
) (*peerverify.Session, error) {
	return verifyPeerWindowsWithLifecycleAndCommit(
		plan,
		endpoint,
		attest,
		verify,
		closeSession,
		quarantine,
		nil,
	)
}

func verifyPeerWindowsWithLifecycleAndCommit(
	plan PeerVerificationPlan,
	endpoint *winpipe.Endpoint,
	attest peerEndpointAttestor,
	verify peerWindowsVerifier,
	closeSession peerSessionCloser,
	quarantine *peerSessionLifetimeQuarantine,
	beginNativeCommit peerVerifierCommitGate,
) (*peerverify.Session, error) {
	quarantine = peerSessionQuarantineOrDefault(quarantine)
	if fatal := quarantine.fatalError(); fatal != nil {
		return nil, fatal
	}
	if err := plan.Validate(); err != nil {
		return nil, err
	}
	if endpoint == nil {
		return nil, invalidPeerVerificationPlan("named-pipe endpoint is required", nil)
	}
	if attest == nil || verify == nil {
		return nil, invalidPeerVerificationPlan("peer verification implementation is unavailable", nil)
	}
	before, err := attest()
	if err != nil {
		return nil, preflightError(ErrorPeerVerification, "attest named-pipe endpoint", err)
	}
	if err := validatePeerEndpointAttestation(plan, before); err != nil {
		return nil, err
	}
	session, err := verify(peerVerificationRequest{
		role:     plan.role,
		endpoint: endpoint,
		wrapper: peerverify.ImageExpectation{
			Path: plan.wrapper.path, SHA256: plan.wrapper.sha256,
		},
		serviceHost: peerverify.ImageExpectation{
			Path: plan.serviceHost.path, SHA256: plan.serviceHost.sha256,
		},
		signerDERSHA: plan.approvedSignerPin,
	})
	if err != nil {
		cleanupErr := closeRejectedPeerSession(session, closeSession, quarantine)
		if errors.Is(err, peerverify.ErrNativeHandleOwnershipFatal) {
			cleanupErr = errors.Join(cleanupErr, quarantine.markFatal(err))
		}
		return nil, errors.Join(
			err,
			cleanupErr,
		)
	}
	if session == nil {
		return nil, invalidPeerVerificationPlan("peer verifier returned no session", nil)
	}
	after, err := attest()
	if err != nil {
		return nil, errors.Join(
			preflightError(ErrorPeerVerification, "reattest named-pipe endpoint after peer verification", err),
			closeRejectedPeerSession(session, closeSession, quarantine),
		)
	}
	if err := validatePeerEndpointAttestation(plan, after); err != nil {
		return nil, errors.Join(err, closeRejectedPeerSession(session, closeSession, quarantine))
	}
	if after != before {
		return nil, errors.Join(
			invalidPeerVerificationPlan("named-pipe endpoint attestation changed during peer verification", nil),
			closeRejectedPeerSession(session, closeSession, quarantine),
		)
	}
	releaseNativeCommit := func() {}
	if beginNativeCommit != nil {
		var nativeFatal error
		releaseNativeCommit, nativeFatal = beginNativeCommit()
		if nativeFatal != nil {
			cleanupErr := closeRejectedPeerSession(session, closeSession, quarantine)
			if errors.Is(nativeFatal, peerverify.ErrNativeHandleOwnershipFatal) {
				cleanupErr = errors.Join(cleanupErr, quarantine.markFatal(nativeFatal))
			}
			return nil, errors.Join(nativeFatal, cleanupErr)
		}
		if releaseNativeCommit == nil {
			return nil, errors.Join(
				invalidPeerVerificationPlan("native peer verifier commit lease is unavailable", nil),
				closeRejectedPeerSession(session, closeSession, quarantine),
			)
		}
	}
	releaseCommit, fatal := quarantine.beginUse()
	if fatal != nil {
		releaseNativeCommit()
		return nil, errors.Join(fatal, closeRejectedPeerSession(session, closeSession, quarantine))
	}
	defer releaseNativeCommit()
	defer releaseCommit()
	return session, nil
}

func closeRejectedPeerSession(
	session *peerverify.Session,
	closeSession peerSessionCloser,
	quarantine *peerSessionLifetimeQuarantine,
) error {
	if session == nil {
		return nil
	}
	quarantine = peerSessionQuarantineOrDefault(quarantine)
	var failures []error
	if closeSession == nil {
		failures = append(failures, errors.New("peer session close operation is unavailable"))
	} else {
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
	}
	cause := errors.Join(failures...)
	return errors.Join(cause, quarantine.retain(session, cause))
}

func peerSessionQuarantineOrDefault(
	quarantine *peerSessionLifetimeQuarantine,
) *peerSessionLifetimeQuarantine {
	if quarantine != nil {
		return quarantine
	}
	return rejectedPeerSessions
}

func (quarantine *peerSessionLifetimeQuarantine) retain(
	session *peerverify.Session,
	cause error,
) error {
	if quarantine == nil || session == nil {
		return errors.Join(ErrPeerCleanupFatal, cause, errors.New("peer session quarantine is unavailable"))
	}
	result := errors.Join(ErrPeerCleanupFatal, cause)
	quarantine.mu.Lock()
	quarantine.owners = append(quarantine.owners, session)
	quarantine.fatal = errors.Join(quarantine.fatal, result)
	quarantine.mu.Unlock()
	return result
}

func (quarantine *peerSessionLifetimeQuarantine) markFatal(cause error) error {
	if quarantine == nil {
		return errors.Join(ErrPeerCleanupFatal, cause, errors.New("peer session quarantine is unavailable"))
	}
	result := errors.Join(ErrPeerCleanupFatal, cause)
	quarantine.mu.Lock()
	quarantine.fatal = errors.Join(quarantine.fatal, result)
	quarantine.mu.Unlock()
	return result
}

func (quarantine *peerSessionLifetimeQuarantine) fatalError() error {
	if quarantine == nil {
		return ErrPeerCleanupFatal
	}
	quarantine.mu.RLock()
	defer quarantine.mu.RUnlock()
	return quarantine.fatal
}

func (quarantine *peerSessionLifetimeQuarantine) beginUse() (func(), error) {
	if quarantine == nil {
		return func() {}, ErrPeerCleanupFatal
	}
	quarantine.mu.RLock()
	if quarantine.fatal != nil {
		fatal := quarantine.fatal
		quarantine.mu.RUnlock()
		return func() {}, fatal
	}
	return quarantine.mu.RUnlock, nil
}

func (quarantine *peerSessionLifetimeQuarantine) count() int {
	if quarantine == nil {
		return 0
	}
	quarantine.mu.RLock()
	defer quarantine.mu.RUnlock()
	return len(quarantine.owners)
}

func validatePeerEndpointAttestation(
	plan PeerVerificationPlan,
	facts peerEndpointAttestationFacts,
) error {
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

func selectPeerVerificationFiles(
	configuration config.Config,
	files []VerifiedFile,
	release releaseBindingSnapshot,
) (VerifiedFile, VerifiedFile, error) {
	peerWrapperPath := configuration.PeerService.Name + ".exe"
	ownWrapperPath := configuration.OwnService.Name + ".exe"
	var peerWrapper VerifiedFile
	var serviceHost VerifiedFile
	peerWrapperCount := 0
	ownWrapperCount := 0
	wrapperCount := 0
	serviceHostCount := 0
	for _, file := range files {
		switch file.Role {
		case releasemanifest.RoleServiceWrapper:
			wrapperCount++
			if file.Root == releasemanifest.RootInstallation && strings.EqualFold(file.Path, peerWrapperPath) {
				peerWrapper = cloneFile(file)
				peerWrapperCount++
			}
			if file.Root == releasemanifest.RootInstallation && strings.EqualFold(file.Path, ownWrapperPath) {
				ownWrapperCount++
			}
		case releasemanifest.RoleServiceHost:
			serviceHostCount++
			if file.Root == releasemanifest.RootInstallation {
				serviceHost = cloneFile(file)
			}
		}
	}
	if wrapperCount != 2 || peerWrapperCount != 1 || ownWrapperCount != 1 {
		return VerifiedFile{}, VerifiedFile{}, invalidPeerVerificationPlan(
			"installation evidence does not contain exactly the fixed own and peer wrappers",
			nil,
		)
	}
	expectedServiceHostSize, sizeErr := parseReleaseFileSize(release.serviceHost.Size)
	if sizeErr != nil || serviceHostCount != 1 || serviceHost.Root != releasemanifest.RootInstallation ||
		serviceHost.Path != release.serviceHost.Path || serviceHost.Role != release.serviceHost.Role ||
		serviceHost.SHA256 != release.serviceHost.SHA256 ||
		serviceHost.Size != expectedServiceHostSize {
		return VerifiedFile{}, VerifiedFile{}, invalidPeerVerificationPlan(
			"installation evidence does not contain exactly one ServiceHost",
			sizeErr,
		)
	}
	return peerWrapper, serviceHost, nil
}

func invalidPeerVerificationPlan(message string, cause error) error {
	return preflightError(ErrorPeerVerification, message, errors.Join(ErrInvalidEvidence, cause))
}

type atomicPeerVerifier interface {
	VerifyWindows(*winpipe.Endpoint) (*peerverify.Session, error)
}

var _ atomicPeerVerifier = PeerVerificationPlan{}
