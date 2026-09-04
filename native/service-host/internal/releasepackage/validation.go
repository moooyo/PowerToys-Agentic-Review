package releasepackage

import (
	"crypto/sha256"
	"fmt"
	"strconv"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"
)

func validateDependencyClosure(
	releaseID string,
	reviewed *reviewedClosureState,
	dependencies []releaseprofile.Dependency,
) ([]releaseprofile.Dependency, error) {
	if reviewed == nil {
		return nil, fmt.Errorf("%w: reviewed closure evidence is absent", ErrInvalid)
	}
	canonical, err := validateCanonicalDependencies(releaseID, dependencies)
	if err != nil {
		return nil, err
	}
	expected := reviewed.value.Dependencies
	if len(expected) != len(canonical) {
		return nil, fmt.Errorf("%w: dependency inventory differs from the reviewed closure", ErrMismatch)
	}
	for index := range expected {
		identity := expected[index]
		dependency := canonical[index]
		if identity.Root != dependency.Root || identity.Path != dependency.Path || identity.Role != dependency.Role {
			return nil, fmt.Errorf("%w: dependency %d differs from the reviewed closure", ErrMismatch, index)
		}
	}
	return canonical, nil
}

func validateCanonicalDependencies(
	releaseID string,
	dependencies []releaseprofile.Dependency,
) ([]releaseprofile.Dependency, error) {
	if len(dependencies) == 0 || len(dependencies) >= releasemanifest.MaximumFiles {
		return nil, fmt.Errorf("%w: dependency count is outside the supported range", ErrInvalid)
	}
	for _, dependency := range dependencies {
		if forbiddenReleaseDependency(dependency) {
			return nil, fmt.Errorf(
				"%w: dependency %s is forbidden in a reviewed role package",
				ErrInvalid,
				dependency.Path,
			)
		}
	}
	files := make([]releasemanifest.File, 0, len(dependencies)+1)
	for _, dependency := range dependencies {
		files = append(files, dependencyFile(dependency))
	}
	files = append(files, releasemanifest.File{
		Root:   releasemanifest.RootInstallation,
		Path:   releaseprofile.ServiceHostRelativePath,
		Role:   releasemanifest.RoleServiceHost,
		SHA256: strings.Repeat("0", sha256.Size*2),
		Size:   "1",
	})
	document, err := releasemanifest.MarshalCanonical(releasemanifest.Manifest{
		Compatibility:   releasemanifest.RequiredCompatibility(),
		Files:           files,
		PublisherPolicy: releasemanifest.PublisherPolicy,
		ReleaseID:       releaseID,
		SchemaVersion:   releasemanifest.SchemaVersion,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: dependency inventory is not a valid release profile: %v", ErrInvalid, err)
	}
	manifest, err := releasemanifest.Parse(document)
	if err != nil {
		return nil, fmt.Errorf("%w: reparse dependency inventory: %v", ErrInvalid, err)
	}
	canonical := make([]releaseprofile.Dependency, 0, len(dependencies))
	for _, file := range manifest.Files {
		if file.Role == releasemanifest.RoleServiceHost {
			continue
		}
		canonical = append(canonical, releaseprofile.Dependency{
			Root: file.Root, Path: file.Path, Role: file.Role, SHA256: file.SHA256, Size: file.Size,
		})
	}
	if !sameDependencies(canonical, dependencies) {
		return nil, fmt.Errorf("%w: dependency inventory is not in canonical order", ErrInvalid)
	}
	return cloneDependencies(canonical), nil
}

func forbiddenReleaseDependency(dependency releaseprofile.Dependency) bool {
	lower := strings.ToLower(dependency.Path)
	if strings.HasSuffix(lower, ".map") || strings.HasSuffix(lower, ".meta.json") {
		return true
	}
	leaf := lower
	if separator := strings.LastIndexByte(leaf, '\\'); separator >= 0 {
		leaf = leaf[separator+1:]
	}
	if leaf == "worker.mjs" {
		return true
	}
	switch dependency.Role {
	case releasemanifest.RoleControlBundle:
		return dependency.Root != releasemanifest.RootInstallation || dependency.Path != ControlBundlePath
	case releasemanifest.RoleExecutorBundle:
		return dependency.Root != releasemanifest.RootInstallation || dependency.Path != ExecutorBundlePath
	default:
		return false
	}
}

func validateContext(
	releaseID string,
	architecture TargetArchitecture,
	source SourceReceipt,
	signerPin string,
) error {
	if !validReleaseID(releaseID) || !validArchitecture(architecture) || validateSource(source) != nil ||
		!validSHA256(signerPin) {
		return fmt.Errorf("%w: release context is invalid", ErrInvalid)
	}
	return nil
}

func validateSource(value SourceReceipt) error {
	if !validGitObjectID(value.Commit) || !validGitObjectID(value.Tree) || len(value.Commit) != len(value.Tree) {
		return fmt.Errorf("%w: source receipt is invalid", ErrInvalid)
	}
	return nil
}

func validArchitecture(value TargetArchitecture) bool {
	return value == ArchitectureAMD64 || value == ArchitectureARM64
}

func validGitObjectID(value string) bool {
	return (len(value) == 40 || len(value) == 64) && validLowerHex(value)
}

func validSHA256(value string) bool {
	return len(value) == sha256.Size*2 && validLowerHex(value)
}

func validLowerHex(value string) bool {
	for _, character := range value {
		if character < '0' || character > '9' {
			if character < 'a' || character > 'f' {
				return false
			}
		}
	}
	return true
}

func validReleaseID(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for index, character := range []byte(value) {
		if character >= 'A' && character <= 'Z' || character >= 'a' && character <= 'z' ||
			character >= '0' && character <= '9' || index > 0 &&
			(character == '.' || character == '_' || character == '+' || character == '-') {
			continue
		}
		return false
	}
	return true
}

func validCanonicalPositiveSize(value string) bool {
	if value == "" || value == "0" || len(value) > 20 || value[0] == '0' {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

func validServiceHostSize(value string) bool {
	if !validCanonicalPositiveSize(value) {
		return false
	}
	size, err := strconv.ParseUint(value, 10, 64)
	return err == nil && size > 0 && size <= releaseprofile.MaximumServiceHostBytes
}

func dependencyFile(value releaseprofile.Dependency) releasemanifest.File {
	return releasemanifest.File{
		Root: value.Root, Path: value.Path, Role: value.Role, SHA256: value.SHA256, Size: value.Size,
	}
}

func sameDependencies(left, right []releaseprofile.Dependency) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func sameReceipt(left, right prepareReceiptDocument) bool {
	return left.AuthenticodeLeafSignerCertificateDERSHA256 == right.AuthenticodeLeafSignerCertificateDERSHA256 &&
		left.CompiledReleaseTemplateSHA256 == right.CompiledReleaseTemplateSHA256 &&
		left.ExecutionAuthority == right.ExecutionAuthority && left.FoundationVersion == right.FoundationVersion &&
		left.PackageProfile == right.PackageProfile &&
		left.ReleaseID == right.ReleaseID &&
		left.ReviewedClosurePolicyID == right.ReviewedClosurePolicyID &&
		left.ReviewedClosurePolicyVersion == right.ReviewedClosurePolicyVersion &&
		left.ReviewedClosureSHA256 == right.ReviewedClosureSHA256 &&
		left.SchemaVersion == right.SchemaVersion && left.Source == right.Source &&
		left.TargetArchitecture == right.TargetArchitecture && sameDependencies(left.Dependencies, right.Dependencies)
}

func cloneDependencies(values []releaseprofile.Dependency) []releaseprofile.Dependency {
	return append([]releaseprofile.Dependency(nil), values...)
}

func cloneReceipt(value prepareReceiptDocument) prepareReceiptDocument {
	value.Dependencies = cloneDependencies(value.Dependencies)
	return value
}

func cloneDescriptor(value PackageDescriptor) PackageDescriptor { return value }
