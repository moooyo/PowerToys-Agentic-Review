package peerverify

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winpipe"
)

const (
	maximumVerifiedImageBytes      = int64(1024 * 1024 * 1024)
	discardedResourceCloseAttempts = 3
)

type processOpener interface {
	OpenProcess(uint32) (PeerProcess, error)
}

// Verify observes the selected named-pipe endpoint, acquires a stable process
// object between two adjacent observations, and verifies lineage, image, and
// token evidence. The call consumes wrapper on success and failure.
//
// Matching PIDs are only a race check. They do not authenticate the peer.
func Verify(
	observer winpipe.ProcessIDObserver,
	wrapper StableWrapper,
	options Options,
) (*Session, error) {
	opener, err := newPlatformProcessOpener()
	if err != nil {
		return nil, errors.Join(err, closeDiscardedStableProcess("close rejected WinSW wrapper process", wrapper))
	}
	return verifyWithOpener(observer, wrapper, options, opener)
}

func verifyWithOpener(
	observer winpipe.ProcessIDObserver,
	wrapper StableWrapper,
	options Options,
	opener processOpener,
) (session *Session, err error) {
	var peer PeerProcess
	keep := false
	defer func() {
		if keep {
			return
		}
		err = errors.Join(
			err,
			closeDiscardedStableProcess("close rejected peer ServiceHost process", peer),
			closeDiscardedStableProcess("close rejected WinSW wrapper process", wrapper),
		)
	}()

	if isNilInterface(observer) {
		return nil, invalidOptions("named-pipe PID observer is required")
	}
	if isNilInterface(wrapper) {
		return nil, invalidOptions("stable WinSW wrapper is required")
	}
	if isNilInterface(opener) {
		return nil, invalidOptions("process opener is required")
	}
	if err := validateOptions(options); err != nil {
		return nil, err
	}

	wrapperFacts := wrapper.StableFacts()
	if wrapperFacts.ProcessID == 0 || wrapperFacts.CreationTime.IsZero() {
		return nil, fmt.Errorf("%w: supplied stable facts are incomplete", ErrWrapperUnstable)
	}

	firstPID, err := observePipeProcessID(observer, options.PipePeer)
	if err != nil {
		return nil, fmt.Errorf("observe named-pipe peer before opening process: %w", err)
	}
	if firstPID == 0 {
		return nil, fmt.Errorf("%w: first named-pipe observation returned PID zero", ErrPeerUnstable)
	}
	peer, err = opener.OpenProcess(firstPID)
	if err != nil {
		return nil, fmt.Errorf("open named-pipe peer process %d: %w", firstPID, err)
	}
	if isNilInterface(peer) {
		return nil, fmt.Errorf("%w: process opener returned no object", ErrPeerUnstable)
	}
	secondPID, err := observePipeProcessID(observer, options.PipePeer)
	if err != nil {
		return nil, fmt.Errorf("observe named-pipe peer after opening process: %w", err)
	}
	if secondPID != firstPID {
		return nil, fmt.Errorf(
			"%w: named-pipe PID changed from %d to %d around process open",
			ErrPeerUnstable,
			firstPID,
			secondPID,
		)
	}

	peerFacts, err := verifyCurrentProcess(peer, StableProcessFacts{ProcessID: firstPID}, ErrPeerUnstable, "peer ServiceHost")
	if err != nil {
		return nil, err
	}
	verifiedWrapperFacts, err := verifyCurrentProcess(wrapper, wrapperFacts, ErrWrapperUnstable, "WinSW wrapper")
	if err != nil {
		return nil, err
	}
	if !peerFacts.CreationTime.After(verifiedWrapperFacts.CreationTime) {
		return nil, fmt.Errorf(
			"%w: peer creation time %s is not strictly later than wrapper creation time %s",
			ErrParentMismatch,
			peerFacts.CreationTime.UTC().Format(time.RFC3339Nano),
			verifiedWrapperFacts.CreationTime.UTC().Format(time.RFC3339Nano),
		)
	}
	if peerFacts.StartKey.Available && verifiedWrapperFacts.StartKey.Available &&
		peerFacts.StartKey.SequenceNumber == verifiedWrapperFacts.StartKey.SequenceNumber {
		return nil, fmt.Errorf(
			"%w: peer and wrapper report the same process sequence number %d",
			ErrParentMismatch,
			peerFacts.StartKey.SequenceNumber,
		)
	}

	parentPID, err := peer.DirectParentProcessID()
	if err != nil {
		return nil, fmt.Errorf("query peer ServiceHost direct parent: %w", err)
	}
	if parentPID != wrapperFacts.ProcessID {
		return nil, fmt.Errorf(
			"%w: peer parent PID is %d, wrapper PID is %d",
			ErrParentMismatch,
			parentPID,
			wrapperFacts.ProcessID,
		)
	}

	wrapperImage, err := verifyProcessImage(
		wrapper,
		options.WrapperImage,
		options.ExpectedLeafSignerCertificateDERSHA256,
		options.AuthenticodeVerifier,
	)
	if err != nil {
		return nil, fmt.Errorf("verify WinSW wrapper image: %w", err)
	}
	peerImage, err := verifyProcessImage(
		peer,
		options.ServiceHostImage,
		options.ExpectedLeafSignerCertificateDERSHA256,
		options.AuthenticodeVerifier,
	)
	if err != nil {
		return nil, fmt.Errorf("verify peer ServiceHost image: %w", err)
	}

	tokenSnapshot, err := peer.TokenSnapshot()
	if err != nil {
		return nil, fmt.Errorf("query peer ServiceHost token with TOKEN_QUERY: %w", err)
	}
	baselineTokenEvidence, err := (ExactRestrictedServiceSIDVerifier{}).VerifyToken(tokenSnapshot, options.ExpectedServiceSID)
	if err != nil {
		return nil, fmt.Errorf("apply mandatory peer ServiceHost token policy: %w", err)
	}
	tokenEvidence, err := options.TokenVerifier.VerifyToken(tokenSnapshot, options.ExpectedServiceSID)
	if err != nil {
		return nil, fmt.Errorf("verify peer ServiceHost token: %w", err)
	}
	if err := validateTokenEvidence(tokenEvidence, options.ExpectedServiceSID); err != nil {
		return nil, err
	}
	if tokenEvidence != baselineTokenEvidence {
		return nil, fmt.Errorf("%w: token verifier evidence differs from mandatory token policy", ErrTokenMismatch)
	}

	if _, err := verifyCurrentProcess(peer, peerFacts, ErrPeerUnstable, "peer ServiceHost after evidence collection"); err != nil {
		return nil, err
	}
	finalParentPID, err := peer.DirectParentProcessID()
	if err != nil {
		return nil, fmt.Errorf("requery peer ServiceHost direct parent: %w", err)
	}
	if finalParentPID != parentPID {
		return nil, fmt.Errorf(
			"%w: peer parent PID changed from %d to %d",
			ErrPeerUnstable,
			parentPID,
			finalParentPID,
		)
	}
	if _, err := verifyCurrentProcess(wrapper, verifiedWrapperFacts, ErrWrapperUnstable, "WinSW wrapper after evidence collection"); err != nil {
		return nil, err
	}

	waitContext, cancelWaits := context.WithCancel(context.Background())
	session = &Session{
		peer:        peer,
		wrapper:     wrapper,
		waitContext: waitContext,
		cancelWaits: cancelWaits,
		evidence: VerificationEvidence{
			PipePID: PIDObservationEvidence{BeforeOpen: firstPID, AfterOpen: secondPID},
			Wrapper: ProcessEvidence{
				ProcessID:    wrapperFacts.ProcessID,
				CreationTime: wrapperFacts.CreationTime,
				StartKey:     verifiedWrapperFacts.StartKey,
				Image:        wrapperImage,
			},
			ServiceHost: ProcessEvidence{
				ProcessID:      peerFacts.ProcessID,
				CreationTime:   peerFacts.CreationTime,
				StartKey:       peerFacts.StartKey,
				DirectParentID: parentPID,
				Image:          peerImage,
			},
			PeerToken: tokenEvidence,
		},
	}
	keep = true
	return session, nil
}

func observePipeProcessID(observer winpipe.ProcessIDObserver, peer PipePeer) (uint32, error) {
	if peer == PipePeerClient {
		return observer.GetNamedPipeClientProcessID()
	}
	return observer.GetNamedPipeServerProcessID()
}

func verifyCurrentProcess(
	process StableProcess,
	expected StableProcessFacts,
	unstableError error,
	label string,
) (StableProcessFacts, error) {
	processID, err := process.HandleProcessID()
	if err != nil {
		return StableProcessFacts{}, fmt.Errorf("query %s PID from retained handle: %w", label, err)
	}
	if processID == 0 || processID != expected.ProcessID {
		return StableProcessFacts{}, fmt.Errorf(
			"%w: %s handle PID is %d, expected %d",
			unstableError,
			label,
			processID,
			expected.ProcessID,
		)
	}
	active, err := process.StillActive()
	if err != nil {
		return StableProcessFacts{}, fmt.Errorf("query %s liveness: %w", label, err)
	}
	if !active {
		return StableProcessFacts{}, fmt.Errorf("%w: %s is not active", unstableError, label)
	}
	creationTime, err := process.HandleCreationTime()
	if err != nil {
		return StableProcessFacts{}, fmt.Errorf("query %s creation time: %w", label, err)
	}
	if creationTime.IsZero() {
		return StableProcessFacts{}, fmt.Errorf("%w: %s creation time is zero", unstableError, label)
	}
	if !expected.CreationTime.IsZero() && !creationTime.Equal(expected.CreationTime) {
		return StableProcessFacts{}, fmt.Errorf(
			"%w: %s creation time changed from %s to %s",
			unstableError,
			label,
			expected.CreationTime.UTC().Format(time.RFC3339Nano),
			creationTime.UTC().Format(time.RFC3339Nano),
		)
	}
	startKey, err := process.HandleStartKey()
	if err != nil {
		return StableProcessFacts{}, fmt.Errorf("query %s process start key: %w", label, err)
	}
	if startKey.Available && startKey.SequenceNumber == 0 {
		return StableProcessFacts{}, fmt.Errorf("%w: %s process start key is zero", unstableError, label)
	}
	if expected.StartKey.Available &&
		(!startKey.Available || startKey.SequenceNumber != expected.StartKey.SequenceNumber) {
		return StableProcessFacts{}, fmt.Errorf(
			"%w: %s process start key changed from %+v to %+v",
			unstableError,
			label,
			expected.StartKey,
			startKey,
		)
	}
	return StableProcessFacts{ProcessID: processID, CreationTime: creationTime, StartKey: startKey}, nil
}

func verifyProcessImage(
	process StableProcess,
	expected ImageExpectation,
	expectedLeafSignerCertificateDERSHA256 string,
	authenticode AuthenticodeVerifier,
) (evidence ImageEvidence, err error) {
	firstPath, err := process.ImagePathDiagnostic()
	if err != nil {
		return ImageEvidence{}, fmt.Errorf("query image path from retained process: %w", err)
	}
	if !sameWindowsPath(firstPath, expected.Path) {
		return ImageEvidence{}, fmt.Errorf(
			"%w: process path %q does not map to expected path %q",
			ErrImageMismatch,
			firstPath,
			expected.Path,
		)
	}

	image, err := process.OpenImage()
	if err != nil {
		return ImageEvidence{}, fmt.Errorf("open process image as a read-only file: %w", err)
	}
	if isNilInterface(image) {
		return ImageEvidence{}, fmt.Errorf("%w: process returned no image object", ErrImageMismatch)
	}
	defer func() {
		err = errors.Join(err, closeDiscardedImageSubject(image))
	}()

	secondPath := image.ProcessPathDiagnostic()
	if !sameWindowsPath(firstPath, secondPath) || !sameWindowsPath(secondPath, expected.Path) {
		return ImageEvidence{}, fmt.Errorf(
			"%w: process image path changed from %q to %q",
			ErrImageMismatch,
			firstPath,
			secondPath,
		)
	}
	identity := image.Identity()
	if identity.VolumeSerialNumber == 0 || identity.FileID == ([16]byte{}) {
		return ImageEvidence{}, fmt.Errorf("%w: image file identity is incomplete", ErrImageMismatch)
	}
	size := image.Size()
	if size <= 0 || size > maximumVerifiedImageBytes {
		return ImageEvidence{}, fmt.Errorf("%w: image size %d is outside the supported range", ErrImageMismatch, size)
	}

	hasher := sha256.New()
	written, err := io.Copy(hasher, io.NewSectionReader(image, 0, size))
	if err != nil {
		return ImageEvidence{}, fmt.Errorf("hash reopened image candidate file: %w", err)
	}
	if written != size {
		return ImageEvidence{}, fmt.Errorf("%w: hashed %d of %d image bytes", ErrImageMismatch, written, size)
	}
	digest := hasher.Sum(nil)
	expectedDigest, decodeErr := hex.DecodeString(expected.SHA256)
	if decodeErr != nil || subtle.ConstantTimeCompare(digest, expectedDigest) != 1 {
		return ImageEvidence{}, fmt.Errorf(
			"%w: image SHA-256 is %s, expected %s",
			ErrImageMismatch,
			hex.EncodeToString(digest),
			expected.SHA256,
		)
	}

	authenticodeEvidence, err := authenticode.VerifyAuthenticode(image)
	if err != nil {
		return ImageEvidence{}, errors.Join(ErrAuthenticode, fmt.Errorf("verify reopened-file Authenticode signature: %w", err))
	}
	if !authenticodeEvidence.Trusted {
		return ImageEvidence{}, fmt.Errorf("%w: verifier did not report an approved signer", ErrAuthenticode)
	}
	if authenticodeEvidence.SignatureKind != AuthenticodeSignatureKindEmbedded ||
		authenticodeEvidence.SignatureCount != 1 ||
		authenticodeEvidence.VerifiedSignatureIndex != 0 {
		return ImageEvidence{}, fmt.Errorf(
			"%w: verifier did not report exactly one embedded primary signature",
			ErrAuthenticode,
		)
	}
	if authenticodeEvidence.RevocationPolicy != AuthenticodeRuntimeRevocationPolicy {
		return ImageEvidence{}, fmt.Errorf(
			"%w: verifier reported unexpected runtime revocation policy %q",
			ErrAuthenticode,
			authenticodeEvidence.RevocationPolicy,
		)
	}
	if authenticodeEvidence.DigestPolicy != AuthenticodeDigestPolicySHA256Only ||
		authenticodeEvidence.StrongSignaturePolicy != AuthenticodeStrongSignaturePolicyCurrent ||
		authenticodeEvidence.SignerDigestAlgorithmOID != AuthenticodeSHA256ObjectIdentifier ||
		authenticodeEvidence.FileDigestAlgorithmOID != AuthenticodeSHA256ObjectIdentifier {
		return ImageEvidence{}, fmt.Errorf(
			"%w: verifier did not report the required SHA-256 strong-sign policy",
			ErrAuthenticode,
		)
	}
	if strings.TrimSpace(authenticodeEvidence.SignerIdentity) == "" ||
		strings.ContainsRune(authenticodeEvidence.SignerIdentity, '\x00') {
		return ImageEvidence{}, fmt.Errorf("%w: verifier returned no auditable signer identity", ErrAuthenticode)
	}
	if !validSHA256(authenticodeEvidence.VerifiedLeafSignerCertificateDERSHA256) {
		return ImageEvidence{}, fmt.Errorf("%w: verifier returned a noncanonical signer certificate digest", ErrAuthenticode)
	}
	actualSignerDigest, decodeActualErr := hex.DecodeString(authenticodeEvidence.VerifiedLeafSignerCertificateDERSHA256)
	expectedSignerDigest, decodeExpectedErr := hex.DecodeString(expectedLeafSignerCertificateDERSHA256)
	if decodeActualErr != nil || decodeExpectedErr != nil ||
		subtle.ConstantTimeCompare(actualSignerDigest, expectedSignerDigest) != 1 {
		return ImageEvidence{}, fmt.Errorf(
			"%w: signer certificate DER SHA-256 is %q, expected %s",
			ErrAuthenticode,
			authenticodeEvidence.VerifiedLeafSignerCertificateDERSHA256,
			expectedLeafSignerCertificateDERSHA256,
		)
	}
	if err := image.VerifyUnchanged(); err != nil {
		return ImageEvidence{}, errors.Join(ErrImageMismatch, fmt.Errorf("image changed during verification: %w", err))
	}
	finalProcessPath, err := process.ImagePathDiagnostic()
	if err != nil {
		return ImageEvidence{}, fmt.Errorf("requery image path from retained process: %w", err)
	}
	if !sameWindowsPath(secondPath, finalProcessPath) || !sameWindowsPath(finalProcessPath, expected.Path) {
		return ImageEvidence{}, fmt.Errorf(
			"%w: retained process image path changed from %q to %q",
			ErrImageMismatch,
			secondPath,
			finalProcessPath,
		)
	}

	finalPath, finalPathErr := image.FinalPathDiagnostic()
	finalPathError := ""
	if finalPathErr != nil {
		finalPathError = finalPathErr.Error()
	}
	return ImageEvidence{
		ExpectedPath:                           expected.Path,
		ProcessPathDiagnostic:                  finalProcessPath,
		FinalPathDiagnostic:                    finalPath,
		FinalPathDiagnosticError:               finalPathError,
		Identity:                               identity,
		Size:                                   size,
		SHA256:                                 hex.EncodeToString(digest),
		ExpectedLeafSignerCertificateDERSHA256: expectedLeafSignerCertificateDERSHA256,
		Authenticode:                           authenticodeEvidence,
	}, nil
}

func validateTokenEvidence(evidence TokenEvidence, expectedServiceSID string) error {
	if evidence.ServiceSID != expectedServiceSID ||
		!isCanonicalLogonSID(evidence.LogonSID) ||
		!evidence.PrimaryToken ||
		!evidence.TokenRestricted ||
		!evidence.TokenUserMatches ||
		!evidence.ServiceSIDEnabled ||
		!evidence.ServiceSIDIsRestricting ||
		!evidence.NoAdministrativeSID ||
		!evidence.NoBuiltInServiceIdentity ||
		!evidence.RestrictedSIDSetExact ||
		!evidence.NoHighRiskPrivileges ||
		!evidence.TokenStatisticsStable {
		return fmt.Errorf("%w: token verifier returned incomplete or mismatched evidence", ErrTokenMismatch)
	}
	return nil
}

func closeStableProcess(operation string, process StableProcess) error {
	if isNilInterface(process) {
		return nil
	}
	if err := process.Close(); err != nil {
		return fmt.Errorf("%s: %w", operation, err)
	}
	return nil
}

func closeDiscardedStableProcess(operation string, process StableProcess) error {
	if isNilInterface(process) {
		return nil
	}
	return closeDiscardedResource(operation, process.Close)
}

func closeDiscardedImageSubject(image ImageSubject) error {
	if isNilInterface(image) {
		return nil
	}
	return closeDiscardedResource("close verified image candidate", image.Close)
}

func closeDiscardedResource(operation string, closeResource func() error) error {
	var failures []error
	for attempt := 1; attempt <= discardedResourceCloseAttempts; attempt++ {
		if err := closeResource(); err != nil {
			failures = append(failures, fmt.Errorf("%s attempt %d: %w", operation, attempt, err))
			continue
		}
		return errors.Join(failures...)
	}
	return errors.Join(failures...)
}
