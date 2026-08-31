package preflight

import (
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peerverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/servicebootstrap"
)

func captureCurrentImageBinding(
	source servicebootstrap.CurrentImageEvidence,
	bootstrap servicebootstrap.Evidence,
	expectedBootstrapDigest [32]byte,
) (CurrentImageBinding, error) {
	if err := source.Validate(); err != nil {
		return CurrentImageBinding{}, preflightError(ErrorCurrentImage, "current ServiceHost image evidence is invalid before capture", err)
	}
	beforeDigest, err := source.Digest()
	if err != nil || beforeDigest == ([32]byte{}) {
		return CurrentImageBinding{}, preflightError(ErrorCurrentImage, "current ServiceHost image digest is unavailable before capture", err)
	}
	before := currentImageBindingFrom(source, beforeDigest)

	if err := source.Validate(); err != nil {
		return CurrentImageBinding{}, preflightError(ErrorCurrentImage, "current ServiceHost image evidence is invalid after capture", err)
	}
	afterDigest, err := source.Digest()
	if err != nil || afterDigest == ([32]byte{}) {
		return CurrentImageBinding{}, preflightError(ErrorCurrentImage, "current ServiceHost image digest is unavailable after capture", err)
	}
	after := currentImageBindingFrom(source, afterDigest)
	if !sameCurrentImageBinding(before, after) {
		return CurrentImageBinding{}, preflightError(ErrorCurrentImage, "current ServiceHost image evidence changed during capture", nil)
	}
	if after.bootstrapDigest != expectedBootstrapDigest {
		return CurrentImageBinding{}, preflightError(ErrorCurrentImage, "current ServiceHost image was measured from different bootstrap evidence", nil)
	}
	if err := bootstrap.Validate(); err != nil {
		return CurrentImageBinding{}, preflightError(ErrorCurrentImage, "service bootstrap evidence is invalid during current-image capture", err)
	}
	bootstrapDigest, err := bootstrap.Digest()
	if err != nil || bootstrapDigest != expectedBootstrapDigest {
		return CurrentImageBinding{}, preflightError(ErrorCurrentImage, "service bootstrap evidence changed during current-image capture", err)
	}
	if !sameStableProcessFacts(after.processFacts, bootstrap.StableServiceHostFacts()) {
		return CurrentImageBinding{}, preflightError(ErrorCurrentImage, "current ServiceHost image process differs from bootstrap evidence", nil)
	}
	return after, nil
}

func currentImageBindingFrom(
	source servicebootstrap.CurrentImageEvidence,
	digest [32]byte,
) CurrentImageBinding {
	return CurrentImageBinding{
		sourceDigest: digest, bootstrapDigest: source.BootstrapDigest(),
		processFacts: source.ProcessFacts(), processPath: source.ProcessPath(),
		identity: source.Identity(), size: source.Size(), sha256: source.SHA256(), bound: true,
	}
}

func validateCurrentImageBinding(
	binding CurrentImageBinding,
	bootstrap BootstrapBinding,
	installationProcessID uint32,
	serviceHost VerifiedFile,
) error {
	if !binding.bound || binding.sourceDigest == ([32]byte{}) ||
		binding.bootstrapDigest == ([32]byte{}) || binding.sha256 == ([32]byte{}) {
		return preflightError(ErrorCurrentImage, "current ServiceHost image binding is empty", nil)
	}
	if !validStableProcessFacts(binding.processFacts) ||
		binding.bootstrapDigest != bootstrap.sourceDigest ||
		!sameStableProcessFacts(binding.processFacts, bootstrap.serviceHostFacts) ||
		binding.processFacts.ProcessID != installationProcessID {
		return preflightError(ErrorCurrentImage, "current ServiceHost process facts differ from bootstrap or installation evidence", nil)
	}
	if _, err := parseCanonicalWindowsPath(binding.processPath, false); err != nil {
		return preflightError(ErrorCurrentImage, "current ServiceHost image path is not canonical", err)
	}
	if serviceHost.Root != releasemanifest.RootInstallation ||
		serviceHost.Role != releasemanifest.RoleServiceHost ||
		!windowsPathEqual(binding.processPath, serviceHost.AbsolutePath) {
		return preflightError(ErrorCurrentImage, "current ServiceHost image path differs from the verified release self entry", nil)
	}
	wantIdentity := serviceHost.Object.Evidence.Identity
	if binding.identity.VolumeSerialNumber != wantIdentity.VolumeSerialNumber ||
		binding.identity.FileID != wantIdentity.FileID || binding.size != serviceHost.Size ||
		!digestMatchesHex(binding.sha256, serviceHost.SHA256) {
		return preflightError(ErrorCurrentImage, "current ServiceHost image identity or content differs from the verified release self entry", nil)
	}
	return nil
}

func validStableProcessFacts(value peerverify.StableProcessFacts) bool {
	return value.ProcessID != 0 && !value.CreationTime.IsZero() &&
		(value.StartKey.Available && value.StartKey.SequenceNumber != 0 ||
			!value.StartKey.Available && value.StartKey.SequenceNumber == 0)
}

func sameStableProcessFacts(left, right peerverify.StableProcessFacts) bool {
	return left.ProcessID == right.ProcessID && left.CreationTime.Equal(right.CreationTime) &&
		left.StartKey == right.StartKey
}

func sameCurrentImageBinding(left, right CurrentImageBinding) bool {
	return left.sourceDigest == right.sourceDigest && left.bootstrapDigest == right.bootstrapDigest &&
		sameStableProcessFacts(left.processFacts, right.processFacts) && left.processPath == right.processPath &&
		left.identity == right.identity && left.size == right.size && left.sha256 == right.sha256 &&
		left.bound == right.bound
}
