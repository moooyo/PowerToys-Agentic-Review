package peerverify

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winpipe"
)

const discardedResourceCloseAttempts = 3

type nativeOwnershipLifetimeQuarantine struct {
	mu     sync.RWMutex
	owners []any
	fatal  error
}

var rejectedNativeOwners = &nativeOwnershipLifetimeQuarantine{}

type processOpener interface {
	OpenProcess(uint32) (PeerProcess, error)
}

func verifyRetainedPeer(
	observer winpipe.ProcessIDObserver,
	service serviceStatusSource,
	options verificationOptions,
	opener processOpener,
) (session *Session, err error) {
	if err := validateVerificationOptions(options); err != nil {
		return nil, err
	}
	if isNilInterface(observer) || isNilInterface(service) || isNilInterface(opener) {
		return nil, invalidOptions("SCM, pipe, and process observers are required")
	}

	var peer PeerProcess
	keep := false
	defer func() {
		if keep {
			return
		}
		err = errors.Join(err, closeDiscardedPeerProcess(peer))
	}()

	scmBefore, err := service.Status()
	if err != nil {
		return nil, fmt.Errorf("observe peer service before opening process: %w", err)
	}
	if err := validatePeerServiceObservation(scmBefore); err != nil {
		return nil, err
	}
	pipeBefore, err := observePipeProcessID(observer, options.PipePeer)
	if err != nil {
		return nil, fmt.Errorf("observe named-pipe peer before opening process: %w", err)
	}
	if err := validatePeerPIDs(options.LocalProcessID, scmBefore.processID, pipeBefore); err != nil {
		return nil, err
	}

	peer, err = opener.OpenProcess(scmBefore.processID)
	if err != nil {
		return nil, fmt.Errorf("open peer service process %d: %w", scmBefore.processID, err)
	}
	if isNilInterface(peer) {
		return nil, fmt.Errorf("%w: process opener returned no retained object", ErrPeerUnstable)
	}

	scmAfter, err := service.Status()
	if err != nil {
		return nil, fmt.Errorf("observe peer service after opening process: %w", err)
	}
	if err := validatePeerServiceObservation(scmAfter); err != nil {
		return nil, err
	}
	pipeAfter, err := observePipeProcessID(observer, options.PipePeer)
	if err != nil {
		return nil, fmt.Errorf("observe named-pipe peer after opening process: %w", err)
	}
	if scmAfter.processID != scmBefore.processID || pipeAfter != pipeBefore || scmAfter.processID != pipeAfter {
		return nil, fmt.Errorf(
			"%w: SCM PID %d/%d and pipe PID %d/%d do not identify one stable process",
			ErrPeerUnstable,
			scmBefore.processID,
			scmAfter.processID,
			pipeBefore,
			pipeAfter,
		)
	}

	handlePID, err := peer.HandleProcessID()
	if err != nil {
		return nil, fmt.Errorf("query retained peer process ID: %w", err)
	}
	if handlePID != scmBefore.processID {
		return nil, fmt.Errorf(
			"%w: retained process PID %d differs from SCM and pipe PID %d",
			ErrPeerUnstable,
			handlePID,
			scmBefore.processID,
		)
	}
	active, err := peer.StillActive()
	if err != nil {
		return nil, fmt.Errorf("query retained peer process state: %w", err)
	}
	if !active {
		return nil, fmt.Errorf("%w: retained peer process has exited", ErrPeerUnstable)
	}

	snapshot, err := peer.TokenSnapshot()
	if err != nil {
		return nil, fmt.Errorf("query retained peer primary token: %w", err)
	}
	tokenEvidence, err := options.TokenVerifier.VerifyToken(snapshot, options.ExpectedServiceSID)
	if err != nil {
		return nil, errors.Join(ErrTokenMismatch, err)
	}
	if err := validateTokenEvidence(tokenEvidence, options.ExpectedServiceSID); err != nil {
		return nil, err
	}
	active, err = peer.StillActive()
	if err != nil {
		return nil, fmt.Errorf("reinspect retained peer process state: %w", err)
	}
	if !active {
		return nil, fmt.Errorf("%w: retained peer process exited during token verification", ErrPeerUnstable)
	}

	waitContext, cancelWaits := context.WithCancel(context.Background())
	session = &Session{state: &sessionState{
		peer: peer,
		evidence: VerificationEvidence{
			SCMPID:        PIDObservationEvidence{BeforeOpen: scmBefore.processID, AfterOpen: scmAfter.processID},
			PipePID:       PIDObservationEvidence{BeforeOpen: pipeBefore, AfterOpen: pipeAfter},
			PeerProcessID: handlePID,
			PeerToken:     tokenEvidence,
		},
		waitContext: waitContext,
		cancelWaits: cancelWaits,
	}}
	keep = true
	return session, nil
}

func validatePeerPIDs(local, service, pipe uint32) error {
	if service == 0 || pipe == 0 {
		return fmt.Errorf("%w: SCM and pipe PIDs must be nonzero", ErrPeerUnstable)
	}
	if service != pipe {
		return fmt.Errorf("%w: SCM PID %d differs from pipe PID %d", ErrPeerUnstable, service, pipe)
	}
	if service == local {
		return fmt.Errorf("%w: peer PID %d is the local ServiceHost process", ErrPeerUnstable, service)
	}
	return nil
}

func observePipeProcessID(observer winpipe.ProcessIDObserver, peer PipePeer) (uint32, error) {
	if peer == PipePeerClient {
		return observer.GetNamedPipeClientProcessID()
	}
	return observer.GetNamedPipeServerProcessID()
}

func validateTokenEvidence(evidence TokenEvidence, expectedServiceSID string) error {
	if evidence.ServiceSID != expectedServiceSID || !evidence.PrimaryToken ||
		!evidence.TokenRestricted || !evidence.TokenUserMatches ||
		!evidence.ServiceSIDEnabled || !evidence.ServiceSIDIsRestricting ||
		!evidence.NoAdministrativeSID || !evidence.NoBuiltInServiceIdentity ||
		!evidence.RestrictedSIDSetExact || !evidence.NoHighRiskPrivileges ||
		!evidence.TokenStatisticsStable {
		return ErrTokenMismatch
	}
	return nil
}

func closePeerProcess(process PeerProcess) error {
	if isNilInterface(process) {
		return nil
	}
	if err := process.Close(); err != nil {
		return fmt.Errorf("close verified peer service process: %w", err)
	}
	return nil
}

func closeDiscardedPeerProcess(process PeerProcess) error {
	if isNilInterface(process) {
		return nil
	}
	return closeDiscardedResource("close rejected peer service process", process, process.Close)
}

func closeDiscardedResource(operation string, owner any, closeResource func() error) error {
	var failures []error
	for attempt := 1; attempt <= discardedResourceCloseAttempts; attempt++ {
		if err := closeResource(); err != nil {
			failures = append(failures, fmt.Errorf("%s attempt %d: %w", operation, attempt, err))
			if isNativeHandleOwnershipFatal(err) {
				return rejectedNativeOwners.retain(owner, errors.Join(failures...))
			}
			continue
		}
		return errors.Join(failures...)
	}
	return rejectedNativeOwners.retain(owner, errors.Join(failures...))
}

func (quarantine *nativeOwnershipLifetimeQuarantine) retain(owner any, cause error) error {
	result := errors.Join(ErrNativeHandleOwnershipFatal, cause)
	if quarantine == nil || owner == nil {
		return errors.Join(result, errors.New("peer verifier native owner quarantine is unavailable"))
	}
	quarantine.mu.Lock()
	quarantine.owners = append(quarantine.owners, owner)
	quarantine.fatal = errors.Join(quarantine.fatal, result)
	quarantine.mu.Unlock()
	return result
}

func (quarantine *nativeOwnershipLifetimeQuarantine) fatalError() error {
	if quarantine == nil {
		return ErrNativeHandleOwnershipFatal
	}
	quarantine.mu.RLock()
	defer quarantine.mu.RUnlock()
	return quarantine.fatal
}
