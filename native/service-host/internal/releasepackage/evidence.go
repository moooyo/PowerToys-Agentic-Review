package releasepackage

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"sync"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peimage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/servicehostreceipt"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

const (
	approvedDigestDocumentBytes = uint64(sha256.Size * 2)
	releaseFileCloseAttempts    = 3
	maximumSignerIdentityBytes  = 4 << 10
	maximumTimestampSigners     = uint32(64)
)

type retainedReleaseFile interface {
	Evidence() winfile.Evidence
	AncestorEvidence() []winfile.Evidence
	ReadAll(uint64) ([]byte, error)
	HashSHA256(winfile.HashOptions) (winfile.HashResult, error)
	VerifyAuthenticode(authenticode.Verifier) (authenticode.Evidence, error)
	VerifyUnchanged() error
	ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error)
	Close() error
}

type evidenceDependencies struct {
	openFile                 func(string, winfile.OpenOptions) (retainedReleaseFile, error)
	checkIndependentApproval func(retainedReleaseFile) error
	newAuthenticodeVerifier  func() (authenticode.Verifier, error)
}

type verifiedServiceHostState struct {
	metadata              serviceHostMetadata
	preparedReceiptSHA256 [sha256.Size]byte
	buildReceiptSHA256    [sha256.Size]byte
	fileIdentity          winfile.FileIdentity
	digest                [sha256.Size]byte
	size                  uint64
	authenticode          authenticode.Evidence
}

type serviceHostBuildState struct {
	document []byte
	sha256   [sha256.Size]byte
	receipt  servicehostreceipt.Receipt
}

type cleanupResource interface {
	Close() error
}

type releaseEvidenceOperation struct {
	coordinator *releaseCleanupState
	epoch       uint64
}

type releaseCleanupState struct {
	mu             sync.Mutex
	epoch          uint64
	fatal          bool
	resources      []cleanupResource
	platformStatus func() error
	platformCommit func(func()) error
}

var releaseCleanupCoordinator = &releaseCleanupState{
	platformStatus: winfile.ProcessCleanupStatus,
	platformCommit: winfile.CommitIfCleanupHealthy,
}

func beginReleaseEvidenceOperation() (releaseEvidenceOperation, error) {
	return releaseCleanupCoordinator.begin()
}

func (coordinator *releaseCleanupState) begin() (releaseEvidenceOperation, error) {
	if coordinator == nil {
		return releaseEvidenceOperation{}, ErrReleaseCleanupFatal
	}
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	if coordinator.fatal || coordinator.platformStatus == nil ||
		coordinator.platformStatus() != nil {
		return releaseEvidenceOperation{}, ErrReleaseCleanupFatal
	}
	return releaseEvidenceOperation{coordinator: coordinator, epoch: coordinator.epoch}, nil
}

func (operation releaseEvidenceOperation) commit() error {
	return operation.commitWith(func() error { return nil })
}

func (operation releaseEvidenceOperation) commitWith(commit func() error) error {
	if operation.coordinator == nil {
		return ErrReleaseCleanupFatal
	}
	operation.coordinator.mu.Lock()
	defer operation.coordinator.mu.Unlock()
	if operation.coordinator.fatal || operation.epoch != operation.coordinator.epoch {
		return ErrReleaseCleanupFatal
	}
	if operation.coordinator.platformCommit == nil {
		return ErrReleaseCleanupFatal
	}
	if commit == nil {
		return ErrReleaseCleanupFatal
	}
	committed := false
	var commitErr error
	if err := operation.coordinator.platformCommit(func() {
		committed = true
		commitErr = commit()
	}); err != nil || !committed {
		return ErrReleaseCleanupFatal
	}
	return commitErr
}

func publishReleaseCleanupFatal(resource cleanupResource) {
	releaseCleanupCoordinator.publish(resource)
}

func (coordinator *releaseCleanupState) publish(resource cleanupResource) {
	if resource == nil {
		return
	}
	coordinator.mu.Lock()
	if !coordinator.fatal {
		coordinator.epoch++
		coordinator.fatal = true
	}
	coordinator.resources = append(coordinator.resources, resource)
	coordinator.mu.Unlock()
}

func loadReviewedClosure(
	approvalDigestPath string,
	closureDocumentPath string,
	dependencies evidenceDependencies,
) (result ReviewedClosureEvidence, resultErr error) {
	if approvalDigestPath == "" || closureDocumentPath == "" ||
		dependencies.openFile == nil || dependencies.checkIndependentApproval == nil {
		return ReviewedClosureEvidence{}, reviewedClosureVerificationError("inputs are invalid")
	}

	approval, err := dependencies.openFile(approvalDigestPath, releaseInputOpenOptions())
	if err != nil {
		return ReviewedClosureEvidence{}, reviewedClosureVerificationError("approval file could not be opened")
	}
	opened := []retainedReleaseFile{approval}
	defer func() {
		if closeRetainedReleaseFiles(opened) != nil {
			result = ReviewedClosureEvidence{}
			resultErr = reviewedClosureVerificationError("retained input cleanup failed")
		}
	}()

	closure, err := dependencies.openFile(closureDocumentPath, releaseInputOpenOptions())
	if err != nil {
		return ReviewedClosureEvidence{}, reviewedClosureVerificationError("closure file could not be opened")
	}
	opened = append(opened, closure)
	approvalEvidence := approval.Evidence()
	closureEvidence := closure.Evidence()
	if !validRetainedFileEvidence(approvalEvidence, approvedDigestDocumentBytes, approvedDigestDocumentBytes) ||
		!validRetainedFileEvidence(closureEvidence, 1, MaximumCanonicalDocumentBytes) ||
		approvalEvidence.Identity == closureEvidence.Identity {
		return ReviewedClosureEvidence{}, reviewedClosureVerificationError("retained input identity is invalid")
	}
	if err := dependencies.checkIndependentApproval(approval); err != nil {
		return ReviewedClosureEvidence{}, reviewedClosureVerificationError("approval authority was rejected")
	}
	if err := verifyRetainedSecurity(approval, approvalEvidence.Security); err != nil {
		return ReviewedClosureEvidence{}, reviewedClosureVerificationError("approval security changed before reading")
	}

	approvedDigest, err := approval.ReadAll(approvedDigestDocumentBytes)
	if err != nil || uint64(len(approvedDigest)) != approvedDigestDocumentBytes ||
		!validSHA256(string(approvedDigest)) {
		return ReviewedClosureEvidence{}, reviewedClosureVerificationError("approval digest is invalid")
	}
	document, err := closure.ReadAll(MaximumCanonicalDocumentBytes)
	if err != nil || len(document) == 0 {
		return ReviewedClosureEvidence{}, reviewedClosureVerificationError("closure document could not be read")
	}
	if err := approval.VerifyUnchanged(); err != nil {
		return ReviewedClosureEvidence{}, reviewedClosureVerificationError("approval file changed during verification")
	}
	if err := closure.VerifyUnchanged(); err != nil {
		return ReviewedClosureEvidence{}, reviewedClosureVerificationError("closure file changed during verification")
	}
	if err := verifyRetainedSecurity(approval, approvalEvidence.Security); err != nil {
		return ReviewedClosureEvidence{}, reviewedClosureVerificationError("approval security changed during verification")
	}

	reviewed, err := parseReviewedClosure(document, string(approvedDigest))
	if err != nil {
		return ReviewedClosureEvidence{}, reviewedClosureVerificationError("closure document did not match its approval")
	}
	return reviewed, nil
}

func loadServiceHostBuildReceipt(
	approvalDigestPath string,
	receiptDocumentPath string,
	dependencies evidenceDependencies,
) (result ServiceHostBuildEvidence, resultErr error) {
	if approvalDigestPath == "" || receiptDocumentPath == "" ||
		dependencies.openFile == nil || dependencies.checkIndependentApproval == nil {
		return ServiceHostBuildEvidence{}, serviceHostBuildVerificationError("inputs are invalid")
	}
	approval, err := dependencies.openFile(approvalDigestPath, releaseInputOpenOptions())
	if err != nil {
		return ServiceHostBuildEvidence{}, serviceHostBuildVerificationError("approval file could not be opened")
	}
	opened := []retainedReleaseFile{approval}
	defer func() {
		if closeRetainedReleaseFiles(opened) != nil {
			result = ServiceHostBuildEvidence{}
			resultErr = serviceHostBuildVerificationError("retained input cleanup failed")
		}
	}()
	receiptFile, err := dependencies.openFile(receiptDocumentPath, releaseInputOpenOptions())
	if err != nil {
		return ServiceHostBuildEvidence{}, serviceHostBuildVerificationError("receipt file could not be opened")
	}
	opened = append(opened, receiptFile)
	approvalEvidence := approval.Evidence()
	receiptEvidence := receiptFile.Evidence()
	if !validRetainedFileEvidence(approvalEvidence, approvedDigestDocumentBytes, approvedDigestDocumentBytes) ||
		!validRetainedFileEvidence(receiptEvidence, 1, servicehostreceipt.MaximumDocumentBytes) ||
		approvalEvidence.Identity == receiptEvidence.Identity {
		return ServiceHostBuildEvidence{}, serviceHostBuildVerificationError("retained input identity is invalid")
	}
	if err := dependencies.checkIndependentApproval(approval); err != nil {
		return ServiceHostBuildEvidence{}, serviceHostBuildVerificationError("approval authority was rejected")
	}
	if err := verifyRetainedSecurity(approval, approvalEvidence.Security); err != nil {
		return ServiceHostBuildEvidence{}, serviceHostBuildVerificationError("approval security changed before reading")
	}
	approvedDigest, err := approval.ReadAll(approvedDigestDocumentBytes)
	if err != nil || uint64(len(approvedDigest)) != approvedDigestDocumentBytes ||
		!validSHA256(string(approvedDigest)) {
		return ServiceHostBuildEvidence{}, serviceHostBuildVerificationError("approval digest is invalid")
	}
	document, err := receiptFile.ReadAll(servicehostreceipt.MaximumDocumentBytes)
	if err != nil || len(document) == 0 {
		return ServiceHostBuildEvidence{}, serviceHostBuildVerificationError("receipt document could not be read")
	}
	if err := approval.VerifyUnchanged(); err != nil {
		return ServiceHostBuildEvidence{}, serviceHostBuildVerificationError("approval file changed during verification")
	}
	if err := receiptFile.VerifyUnchanged(); err != nil {
		return ServiceHostBuildEvidence{}, serviceHostBuildVerificationError("receipt file changed during verification")
	}
	if err := verifyRetainedSecurity(approval, approvalEvidence.Security); err != nil {
		return ServiceHostBuildEvidence{}, serviceHostBuildVerificationError("approval security changed during verification")
	}
	digest := sha256.Sum256(document)
	if subtle.ConstantTimeCompare(
		[]byte(hex.EncodeToString(digest[:])),
		approvedDigest,
	) != 1 {
		return ServiceHostBuildEvidence{}, serviceHostBuildVerificationError("receipt document did not match its approval")
	}
	receipt, err := servicehostreceipt.Parse(document)
	if err != nil {
		return ServiceHostBuildEvidence{}, serviceHostBuildVerificationError("receipt document is invalid")
	}
	return ServiceHostBuildEvidence{state: &serviceHostBuildState{
		document: append([]byte(nil), document...),
		sha256:   digest,
		receipt:  receipt,
	}}, nil
}

func validateServiceHostBuild(evidence ServiceHostBuildEvidence) (*serviceHostBuildState, error) {
	if evidence.state == nil || len(evidence.state.document) == 0 ||
		evidence.state.sha256 == ([sha256.Size]byte{}) {
		return nil, serviceHostBuildVerificationError("evidence is absent")
	}
	receipt, err := servicehostreceipt.Parse(evidence.state.document)
	digest := sha256.Sum256(evidence.state.document)
	if err != nil || digest != evidence.state.sha256 || receipt != evidence.state.receipt {
		return nil, serviceHostBuildVerificationError("evidence is inconsistent")
	}
	return &serviceHostBuildState{
		document: append([]byte(nil), evidence.state.document...),
		sha256:   digest,
		receipt:  receipt,
	}, nil
}

func verifyServiceHost(
	prepared PreparedRelease,
	build ServiceHostBuildEvidence,
	serviceHostPath string,
	dependencies evidenceDependencies,
) (result VerifiedServiceHostEvidence, resultErr error) {
	if serviceHostPath == "" || dependencies.openFile == nil ||
		dependencies.newAuthenticodeVerifier == nil {
		return VerifiedServiceHostEvidence{}, serviceHostVerificationError("inputs are invalid")
	}
	preparedState, err := validatePrepared(prepared)
	if err != nil {
		return VerifiedServiceHostEvidence{}, serviceHostVerificationError("prepared release is invalid")
	}
	buildState, err := validateServiceHostBuild(build)
	if err != nil || !buildReceiptMatchesPrepared(buildState, preparedState) {
		return VerifiedServiceHostEvidence{}, serviceHostVerificationError("build receipt differs from prepared release")
	}
	verifier, err := dependencies.newAuthenticodeVerifier()
	if err != nil || nilAuthenticodeVerifier(verifier) {
		return VerifiedServiceHostEvidence{}, serviceHostVerificationError("Authenticode verifier is unavailable")
	}
	file, err := dependencies.openFile(serviceHostPath, releaseInputOpenOptions())
	if err != nil {
		return VerifiedServiceHostEvidence{}, serviceHostVerificationError("artifact could not be opened")
	}
	defer func() {
		if closeRetainedReleaseFiles([]retainedReleaseFile{file}) != nil {
			result = VerifiedServiceHostEvidence{}
			resultErr = serviceHostVerificationError("retained artifact cleanup failed")
		}
	}()

	evidence := file.Evidence()
	if !validRetainedFileEvidence(evidence, 1, releaseprofile.MaximumServiceHostBytes) {
		return VerifiedServiceHostEvidence{}, serviceHostVerificationError("artifact identity is invalid")
	}
	document, err := file.ReadAll(releaseprofile.MaximumServiceHostBytes)
	if err != nil || uint64(len(document)) != evidence.Size {
		return VerifiedServiceHostEvidence{}, serviceHostVerificationError("artifact could not be read")
	}
	invariant, signed, err := peimage.SigningInvariantSHA256(
		bytes.NewReader(document),
		int64(len(document)),
		buildState.receipt.TargetArchitecture,
	)
	if err != nil || !signed ||
		hex.EncodeToString(invariant[:]) != buildState.receipt.SigningInvariantSHA256 {
		return VerifiedServiceHostEvidence{}, serviceHostVerificationError("artifact PE identity is invalid")
	}
	digest := sha256.Sum256(document)
	if err := file.VerifyUnchanged(); err != nil {
		return VerifiedServiceHostEvidence{}, serviceHostVerificationError("artifact changed before signature verification")
	}
	signature, err := file.VerifyAuthenticode(verifier)
	if err != nil || !validAuthenticodeEvidence(
		signature,
		preparedState.receipt.AuthenticodeLeafSignerCertificateDERSHA256,
	) {
		return VerifiedServiceHostEvidence{}, serviceHostVerificationError("artifact signature was rejected")
	}
	after, err := file.HashSHA256(winfile.HashOptions{
		ExpectedSize: evidence.Size,
		MaximumBytes: releaseprofile.MaximumServiceHostBytes,
	})
	if err != nil || after.Size != evidence.Size ||
		subtle.ConstantTimeCompare(after.SHA256[:], digest[:]) != 1 {
		return VerifiedServiceHostEvidence{}, serviceHostVerificationError("artifact changed after signature verification")
	}
	if err := file.VerifyUnchanged(); err != nil {
		return VerifiedServiceHostEvidence{}, serviceHostVerificationError("artifact identity changed during verification")
	}

	metadata := serviceHostMetadata{
		ReleaseID:          buildState.receipt.ReleaseID,
		TargetArchitecture: TargetArchitecture(buildState.receipt.TargetArchitecture),
		Source: SourceReceipt{
			Commit: buildState.receipt.Source.Commit,
			Tree:   buildState.receipt.Source.Tree,
		},
		CompiledReleaseTemplateSHA256:                buildState.receipt.CompiledReleaseTemplateSHA256,
		VerifiedAuthenticodeLeafCertificateDERSHA256: signature.VerifiedLeafSignerCertificateDERSHA256,
		SHA256: hex.EncodeToString(digest[:]),
		Size:   strconv.FormatUint(evidence.Size, 10),
	}
	return VerifiedServiceHostEvidence{state: &verifiedServiceHostState{
		metadata:              metadata,
		preparedReceiptSHA256: preparedState.receiptSHA256,
		buildReceiptSHA256:    buildState.sha256,
		fileIdentity:          evidence.Identity,
		digest:                digest,
		size:                  evidence.Size,
		authenticode:          signature,
	}}, nil
}

func buildReceiptMatchesPrepared(build *serviceHostBuildState, prepared *preparedState) bool {
	if build == nil || prepared == nil {
		return false
	}
	receipt := build.receipt
	return receipt.ReleaseID == prepared.receipt.ReleaseID &&
		receipt.TargetArchitecture == string(prepared.receipt.TargetArchitecture) &&
		receipt.Source.Commit == prepared.receipt.Source.Commit &&
		receipt.Source.Tree == prepared.receipt.Source.Tree &&
		receipt.CompiledReleaseTemplateSHA256 == prepared.receipt.CompiledReleaseTemplateSHA256
}

func releaseInputOpenOptions() winfile.OpenOptions {
	return winfile.OpenOptions{
		VolumeUse:    winfile.VolumeUseReadOnly,
		SecurityMode: winfile.SecurityModeManaged,
	}
}

func validRetainedFileEvidence(evidence winfile.Evidence, minimumBytes, maximumBytes uint64) bool {
	return evidence.Kind == winfile.ObjectKindFile &&
		evidence.Identity != (winfile.FileIdentity{}) &&
		evidence.LinkCount == 1 && evidence.Size >= minimumBytes && evidence.Size <= maximumBytes &&
		evidence.Path.RequestedPath != "" && evidence.Path.TerminalComponentReparseFree &&
		evidence.Path.Ancestors == winfile.AncestorValidationNotPerformed &&
		evidence.Volume.PersistentACLs && evidence.Volume.PathIdentityCrossCheck &&
		evidence.Volume.RequiredUse == winfile.VolumeUseReadOnly &&
		evidence.SecurityMode == winfile.SecurityModeManaged &&
		evidence.Security.DACLPresent && !evidence.Security.DACLNull &&
		evidence.Security.DACLProtected && !evidence.Security.OwnerDefaulted &&
		!evidence.Security.GroupDefaulted && !evidence.Security.DACLDefaulted &&
		len(evidence.Security.SelfRelativeDescriptor) != 0
}

func verifyRetainedSecurity(file retainedReleaseFile, expected winfile.SecurityDescriptorEvidence) error {
	current, err := file.ReinspectSecurity()
	if err != nil || !reflect.DeepEqual(current, expected) {
		return ErrReviewedClosureVerification
	}
	return nil
}

func validAuthenticodeEvidence(evidence authenticode.Evidence, expectedSigner string) bool {
	return evidence.Trusted && evidence.SignatureKind == authenticode.SignatureKindEmbedded &&
		evidence.SignatureCount == 1 && evidence.VerifiedSignatureIndex == 0 &&
		evidence.TimestampCounterSignerCount <= maximumTimestampSigners &&
		evidence.RevocationPolicy == authenticode.RevocationPolicyRuntimeCacheOnlyNoCheck &&
		evidence.DigestPolicy == authenticode.DigestPolicySHA256Only &&
		evidence.StrongSignaturePolicy == authenticode.StrongSignaturePolicyWindowsOSCurrent &&
		evidence.SignerDigestAlgorithmOID == authenticode.SHA256ObjectIdentifier &&
		evidence.FileDigestAlgorithmOID == authenticode.SHA256ObjectIdentifier &&
		strings.TrimSpace(evidence.SignerIdentity) != "" &&
		len(evidence.SignerIdentity) <= maximumSignerIdentityBytes &&
		!strings.ContainsRune(evidence.SignerIdentity, '\x00') && validSHA256(expectedSigner) &&
		subtle.ConstantTimeCompare(
			[]byte(evidence.VerifiedLeafSignerCertificateDERSHA256),
			[]byte(expectedSigner),
		) == 1
}

func nilAuthenticodeVerifier(verifier authenticode.Verifier) bool {
	if verifier == nil {
		return true
	}
	value := reflect.ValueOf(verifier)
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return value.IsNil()
	default:
		return false
	}
}

func closeRetainedReleaseFiles(files []retainedReleaseFile) error {
	var failed bool
	for index := len(files) - 1; index >= 0; index-- {
		if err := closeReleaseCleanupResource(files[index]); err != nil {
			failed = true
		}
	}
	if failed {
		return fmt.Errorf("release file cleanup failed")
	}
	return nil
}

func closeReleaseCleanupResource(resource cleanupResource) error {
	if resource == nil {
		return fmt.Errorf("release cleanup resource is absent")
	}
	var failed bool
	for attempt := 0; attempt < releaseFileCloseAttempts; attempt++ {
		if err := resource.Close(); err != nil {
			failed = true
			continue
		}
		if failed {
			return fmt.Errorf("release cleanup required a retry")
		}
		return nil
	}
	publishReleaseCleanupFatal(resource)
	return fmt.Errorf("release cleanup did not converge")
}

func reviewedClosureVerificationError(stage string) error {
	return fmt.Errorf("%w: %s", ErrReviewedClosureVerification, stage)
}

func serviceHostBuildVerificationError(stage string) error {
	return fmt.Errorf("%w: %s", ErrServiceHostBuildVerification, stage)
}

func serviceHostVerificationError(stage string) error {
	return fmt.Errorf("%w: %s", ErrServiceHostVerification, stage)
}
