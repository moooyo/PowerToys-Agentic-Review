package preflight

import (
	"fmt"
	"strconv"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"
)

func captureReleaseBinding(source installverify.Evidence) (releaseBindingSnapshot, error) {
	if err := source.Validate(); err != nil {
		return releaseBindingSnapshot{}, preflightError(ErrorReleaseAuthority, "installation release authority is invalid before capture", err)
	}
	beforeSource, ok := source.ReleaseBinding()
	if !ok || beforeSource.Validate() != nil {
		return releaseBindingSnapshot{}, preflightError(ErrorReleaseAuthority, "installation release authority is unavailable before capture", nil)
	}
	before := releaseBindingSnapshotFrom(beforeSource)

	if err := source.Validate(); err != nil {
		return releaseBindingSnapshot{}, preflightError(ErrorReleaseAuthority, "installation release authority is invalid after capture", err)
	}
	afterSource, ok := source.ReleaseBinding()
	if !ok || afterSource.Validate() != nil {
		return releaseBindingSnapshot{}, preflightError(ErrorReleaseAuthority, "installation release authority is unavailable after capture", nil)
	}
	after := releaseBindingSnapshotFrom(afterSource)
	if !sameReleaseBindingSnapshot(before, after) {
		return releaseBindingSnapshot{}, preflightError(ErrorReleaseAuthority, "installation release authority changed during capture", nil)
	}
	return cloneReleaseBinding(after), nil
}

func releaseBindingSnapshotFrom(source installverify.ReleaseBinding) releaseBindingSnapshot {
	dependencies := source.Dependencies()
	files := make([]releasemanifest.File, len(dependencies))
	for index, dependency := range dependencies {
		files[index] = releasemanifest.File{
			Root: dependency.Root, Path: dependency.Path, Role: dependency.Role,
			SHA256: dependency.SHA256, Size: dependency.Size,
		}
	}
	return releaseBindingSnapshot{
		templateDigest:        source.TemplateDigest(),
		manifestSHA256:        source.ManifestSHA256(),
		templateSchemaVersion: source.TemplateSchemaVersion(),
		profileID:             source.ProfileID(),
		releaseID:             source.ReleaseID(),
		compatibility:         source.Compatibility(),
		signerPin:             source.ApprovedSignerCertificateDERSHA256(),
		dependencies:          files,
		serviceHost:           source.ServiceHost(),
		bound:                 true,
	}
}

func bindReleaseBinding(
	release releaseBindingSnapshot,
	manifest ManifestEvidence,
	files map[string]VerifiedFile,
) ([]FileBindingEvidence, VerifiedFile, error) {
	if !release.bound || release.templateDigest == ([32]byte{}) ||
		release.templateSchemaVersion != releaseprofile.SchemaVersion ||
		release.profileID != releaseprofile.ProductionProfileID ||
		release.manifestSHA256 != manifest.SHA256 || release.releaseID != manifest.Manifest.ReleaseID ||
		release.compatibility != manifest.Manifest.Compatibility || !validSHA256(release.signerPin) {
		return nil, VerifiedFile{}, preflightError(ErrorReleaseAuthority, "release authority identity differs from the verified manifest", nil)
	}
	expectedSelf := releasemanifest.File{
		Root:   releasemanifest.RootInstallation,
		Path:   releaseprofile.ServiceHostRelativePath,
		Role:   releasemanifest.RoleServiceHost,
		SHA256: release.serviceHost.SHA256,
		Size:   release.serviceHost.Size,
	}
	selfSize, err := parseReleaseFileSize(release.serviceHost.Size)
	if release.serviceHost != expectedSelf || err != nil || selfSize == 0 ||
		selfSize > releaseprofile.MaximumServiceHostBytes || !validSHA256(release.serviceHost.SHA256) {
		return nil, VerifiedFile{}, preflightError(ErrorReleaseAuthority, "release authority ServiceHost entry is invalid", err)
	}
	if len(release.dependencies)+1 != len(manifest.Manifest.Files) {
		return nil, VerifiedFile{}, preflightError(ErrorReleaseAuthority, "release authority does not exactly cover the verified manifest", nil)
	}

	result := make([]FileBindingEvidence, 0, len(manifest.Manifest.Files))
	dependencyIndex := 0
	serviceHostCount := 0
	var serviceHost VerifiedFile
	for manifestIndex, file := range manifest.Manifest.Files {
		if file.Role == releasemanifest.RoleServiceHost {
			serviceHostCount++
			if file != release.serviceHost {
				return nil, VerifiedFile{}, preflightError(ErrorReleaseAuthority, "verified manifest ServiceHost differs from compiled release authority", nil)
			}
		} else {
			if dependencyIndex >= len(release.dependencies) || release.dependencies[dependencyIndex] != file {
				return nil, VerifiedFile{}, preflightError(ErrorReleaseAuthority, "verified manifest dependency differs from compiled release authority", nil)
			}
			if file.Role == releasemanifest.RoleServiceHost ||
				file.Root == expectedSelf.Root && file.Path == expectedSelf.Path {
				return nil, VerifiedFile{}, preflightError(ErrorReleaseAuthority, "release dependency aliases the ServiceHost entry", nil)
			}
			dependencyIndex++
		}
		purpose := fmt.Sprintf("release/%04d/%s", manifestIndex, file.Role)
		binding, bindingErr := requireBinding(
			purpose,
			releasemanifest.FileBindingRequirement{
				Root: file.Root, Path: file.Path, Role: file.Role, SHA256: file.SHA256,
			},
			manifest,
			files,
		)
		if bindingErr != nil {
			return nil, VerifiedFile{}, preflightError(ErrorReleaseAuthority, purpose+" binding failed", bindingErr)
		}
		result = append(result, binding)
		if file.Role == releasemanifest.RoleServiceHost {
			serviceHost = cloneFile(binding.VerifiedFile)
		}
	}
	if dependencyIndex != len(release.dependencies) || serviceHostCount != 1 || serviceHost.Role != releasemanifest.RoleServiceHost {
		return nil, VerifiedFile{}, preflightError(ErrorReleaseAuthority, "release authority must bind exactly one ServiceHost and every dependency", nil)
	}
	return result, serviceHost, nil
}

func parseReleaseFileSize(value string) (uint64, error) {
	if value == "" || len(value) > 20 || len(value) > 1 && value[0] == '0' {
		return 0, fmt.Errorf("release file size is not canonical decimal")
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return 0, fmt.Errorf("release file size is not canonical decimal")
		}
	}
	return strconv.ParseUint(value, 10, 64)
}

func sameReleaseBindingSnapshot(left, right releaseBindingSnapshot) bool {
	if left.templateDigest != right.templateDigest || left.manifestSHA256 != right.manifestSHA256 ||
		left.templateSchemaVersion != right.templateSchemaVersion || left.profileID != right.profileID ||
		left.releaseID != right.releaseID || left.compatibility != right.compatibility ||
		left.signerPin != right.signerPin || left.serviceHost != right.serviceHost ||
		left.bound != right.bound || len(left.dependencies) != len(right.dependencies) {
		return false
	}
	for index := range left.dependencies {
		if left.dependencies[index] != right.dependencies[index] {
			return false
		}
	}
	return true
}
