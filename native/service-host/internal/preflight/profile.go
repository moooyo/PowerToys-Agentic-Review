package preflight

import (
	"fmt"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
)

func bindReleaseProfile(
	profile ReleaseProfile,
	manifest ManifestEvidence,
	files map[string]VerifiedFile,
) ([]FileBindingEvidence, error) {
	if profile.ID != ProductionProfileID {
		return nil, preflightError(ErrorReleaseProfile, "release profile must be static-review-v1", nil)
	}
	if len(profile.Dependencies) != len(manifest.Manifest.Files) {
		return nil, preflightError(
			ErrorReleaseProfile,
			"release profile dependency count does not match the complete manifest",
			nil,
		)
	}

	dependencies := make(map[string]releasemanifest.FileBindingRequirement, len(profile.Dependencies))
	for _, requirement := range profile.Dependencies {
		if err := validateManifestRelativePath(requirement.Path); err != nil {
			return nil, preflightError(ErrorReleaseProfile, "release profile dependency path is invalid", err)
		}
		if !validSHA256(requirement.SHA256) {
			return nil, preflightError(ErrorReleaseProfile, "release profile dependency digest is invalid", nil)
		}
		key := manifestFileKey(requirement.Root, requirement.Path)
		if _, duplicate := dependencies[key]; duplicate {
			return nil, preflightError(ErrorReleaseProfile, "release profile contains a duplicate dependency", nil)
		}
		dependencies[key] = requirement
	}

	result := make([]FileBindingEvidence, 0, len(manifest.Manifest.Files))
	for index, file := range manifest.Manifest.Files {
		key := manifestFileKey(file.Root, file.Path)
		requirement, exists := dependencies[key]
		if !exists {
			return nil, preflightError(ErrorReleaseProfile, "release profile omits a manifest file", nil)
		}
		if requirement.Root != file.Root || requirement.Path != file.Path ||
			requirement.Role != file.Role || requirement.SHA256 != file.SHA256 {
			return nil, preflightError(
				ErrorReleaseProfile,
				"release profile dependency differs from its exact manifest entry",
				nil,
			)
		}
		purpose := fmt.Sprintf("profile/%04d/%s", index, file.Role)
		binding, err := requireBinding(purpose, requirement, manifest, files)
		if err != nil {
			return nil, preflightError(ErrorReleaseProfile, purpose+" binding failed", err)
		}
		result = append(result, binding)
	}
	return result, nil
}

func canonicalReleaseProfile(id string, manifest releasemanifest.Manifest) ReleaseProfile {
	dependencies := make([]releasemanifest.FileBindingRequirement, len(manifest.Files))
	for index, file := range manifest.Files {
		dependencies[index] = releasemanifest.FileBindingRequirement{
			Root: file.Root, Path: file.Path, Role: file.Role, SHA256: file.SHA256,
		}
	}
	return ReleaseProfile{ID: id, Dependencies: dependencies}
}
