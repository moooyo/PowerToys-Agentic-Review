package installverify

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
)

type releaseAuthorityFacts struct {
	templateDigest [sha256.Size]byte
	schemaVersion  uint32
	profileID      string
	releaseID      string
	compatibility  releasemanifest.Compatibility
	signerPin      string
	dependencies   []releaseprofile.Dependency
	serviceHost    releaseprofile.SelfRequirement
}

type releaseAuthoritySource interface {
	Validate() error
	Digest() ([sha256.Size]byte, error)
	SchemaVersion() uint32
	ProfileID() string
	ReleaseID() string
	Compatibility() releasemanifest.Compatibility
	AuthenticodeLeafSignerCertificateDERSHA256() string
	Dependencies() []releaseprofile.Dependency
	ServiceHost() releaseprofile.SelfRequirement
}

// ReleaseBinding is an opaque immutable binding between the compiled release
// template and the exact canonical runtime manifest accepted by the verifier.
type ReleaseBinding struct {
	templateDigest [sha256.Size]byte
	manifestSHA256 string
	schemaVersion  uint32
	profileID      string
	releaseID      string
	compatibility  releasemanifest.Compatibility
	signerPin      string
	dependencies   []releaseprofile.Dependency
	serviceHost    releasemanifest.File
	bound          bool
}

func captureReleaseAuthority(authority releaseprofile.Evidence) (releaseAuthorityFacts, error) {
	return captureReleaseAuthoritySource(authority)
}

func captureReleaseAuthoritySource(authority releaseAuthoritySource) (releaseAuthorityFacts, error) {
	if authority == nil {
		return releaseAuthorityFacts{}, releaseAuthorityError("compiled release authority is absent", nil)
	}
	if err := authority.Validate(); err != nil {
		return releaseAuthorityFacts{}, releaseAuthorityError("validate compiled release authority before capture", err)
	}
	beforeDigest, err := authority.Digest()
	if err != nil || beforeDigest == ([sha256.Size]byte{}) {
		return releaseAuthorityFacts{}, releaseAuthorityError("read compiled release authority digest before capture", err)
	}
	before := releaseAuthorityFactsFrom(authority, beforeDigest)

	if err := authority.Validate(); err != nil {
		return releaseAuthorityFacts{}, releaseAuthorityError("validate compiled release authority after capture", err)
	}
	afterDigest, err := authority.Digest()
	if err != nil || afterDigest == ([sha256.Size]byte{}) {
		return releaseAuthorityFacts{}, releaseAuthorityError("read compiled release authority digest after capture", err)
	}
	after := releaseAuthorityFactsFrom(authority, afterDigest)
	if beforeDigest != afterDigest || !sameReleaseAuthorityFacts(before, after) {
		return releaseAuthorityFacts{}, releaseAuthorityError("compiled release authority changed during capture", nil)
	}
	if err := validateReleaseAuthorityFacts(after); err != nil {
		return releaseAuthorityFacts{}, releaseAuthorityError("captured compiled release authority is invalid", err)
	}
	return cloneReleaseAuthorityFacts(after), nil
}

func releaseAuthorityFactsFrom(
	authority releaseAuthoritySource,
	digest [sha256.Size]byte,
) releaseAuthorityFacts {
	return releaseAuthorityFacts{
		templateDigest: digest,
		schemaVersion:  authority.SchemaVersion(),
		profileID:      authority.ProfileID(),
		releaseID:      authority.ReleaseID(),
		compatibility:  authority.Compatibility(),
		signerPin:      authority.AuthenticodeLeafSignerCertificateDERSHA256(),
		dependencies:   authority.Dependencies(),
		serviceHost:    authority.ServiceHost(),
	}
}

func validateReleaseAuthorityFacts(facts releaseAuthorityFacts) error {
	if facts.templateDigest == ([sha256.Size]byte{}) || facts.schemaVersion != releaseprofile.SchemaVersion ||
		facts.profileID != releaseprofile.ProductionProfileID || !validReleaseSHA256(facts.signerPin) {
		return errors.New("compiled release authority identity is incomplete")
	}
	expectedSelf := releaseprofile.SelfRequirement{
		Root: releasemanifest.RootInstallation,
		Path: releaseprofile.ServiceHostRelativePath,
		Role: releasemanifest.RoleServiceHost,
	}
	if facts.serviceHost != expectedSelf || len(facts.dependencies) == 0 ||
		len(facts.dependencies) >= releasemanifest.MaximumFiles {
		return errors.New("compiled release authority has an invalid ServiceHost descriptor or dependency count")
	}

	files := make([]releasemanifest.File, 0, len(facts.dependencies)+1)
	for _, dependency := range facts.dependencies {
		if dependency.Role == releasemanifest.RoleServiceHost ||
			dependency.Root == expectedSelf.Root && strings.EqualFold(dependency.Path, expectedSelf.Path) {
			return errors.New("compiled release dependency aliases the ServiceHost entry")
		}
		files = append(files, releasemanifest.File{
			Root: dependency.Root, Path: dependency.Path, Role: dependency.Role,
			SHA256: dependency.SHA256, Size: dependency.Size,
		})
	}
	validationDigest := sha256.Sum256([]byte("AgenticReview installverify release authority validation"))
	files = append(files, releasemanifest.File{
		Root: expectedSelf.Root, Path: expectedSelf.Path, Role: expectedSelf.Role,
		SHA256: fmt.Sprintf("%x", validationDigest),
		Size:   strconv.FormatUint(releaseprofile.MaximumServiceHostBytes, 10),
	})
	manifest := releasemanifest.Manifest{
		SchemaVersion:   releasemanifest.SchemaVersion,
		PublisherPolicy: releasemanifest.PublisherPolicy,
		ReleaseID:       facts.releaseID,
		Compatibility:   facts.compatibility,
		Files:           files,
	}
	canonical, err := releasemanifest.MarshalCanonical(manifest)
	if err != nil {
		return fmt.Errorf("compiled release dependencies do not form a canonical manifest: %w", err)
	}
	normalized, err := releasemanifest.Parse(canonical)
	if err != nil {
		return fmt.Errorf("reparse compiled release dependencies: %w", err)
	}
	dependencyIndex := 0
	for _, file := range normalized.Files {
		if file.Role == releasemanifest.RoleServiceHost {
			continue
		}
		if dependencyIndex >= len(facts.dependencies) ||
			!sameReleaseDependencyAndFile(facts.dependencies[dependencyIndex], file) {
			return errors.New("compiled release dependencies are not in canonical manifest order")
		}
		dependencyIndex++
	}
	if dependencyIndex != len(facts.dependencies) {
		return errors.New("compiled release dependency count changed during normalization")
	}
	return nil
}

func bindReleaseManifest(
	facts releaseAuthorityFacts,
	manifest releasemanifest.Manifest,
	manifestSHA256 string,
) (ReleaseBinding, error) {
	if err := validateReleaseAuthorityFacts(facts); err != nil {
		return ReleaseBinding{}, releaseAuthorityError("compiled release authority is invalid", err)
	}
	canonical, err := releasemanifest.MarshalCanonical(manifest)
	if err != nil {
		return ReleaseBinding{}, releaseAuthorityError("runtime manifest is invalid", err)
	}
	normalized, err := releasemanifest.Parse(canonical)
	if err != nil || !sameReleaseManifest(manifest, normalized) {
		return ReleaseBinding{}, releaseAuthorityError("runtime manifest is not in canonical order", err)
	}
	computedManifestDigest := sha256.Sum256(canonical)
	if !validReleaseSHA256(manifestSHA256) || fmt.Sprintf("%x", computedManifestDigest) != manifestSHA256 ||
		manifest.ReleaseID != facts.releaseID ||
		manifest.Compatibility != facts.compatibility {
		return ReleaseBinding{}, releaseAuthorityError("runtime manifest release identity differs from compiled authority", nil)
	}

	dependencyIndex := 0
	serviceHostCount := 0
	var serviceHost releasemanifest.File
	for _, file := range manifest.Files {
		if file.Role == releasemanifest.RoleServiceHost {
			serviceHostCount++
			if file.Root != facts.serviceHost.Root || file.Path != facts.serviceHost.Path ||
				file.Role != facts.serviceHost.Role {
				return ReleaseBinding{}, releaseAuthorityError("runtime manifest ServiceHost descriptor differs from compiled authority", nil)
			}
			size, err := parseManifestSize(file.Size)
			if err != nil || size == 0 || size > releaseprofile.MaximumServiceHostBytes {
				return ReleaseBinding{}, releaseAuthorityError("runtime manifest ServiceHost size is outside the compiled bound", err)
			}
			serviceHost = file
			continue
		}
		if dependencyIndex >= len(facts.dependencies) ||
			!sameReleaseDependencyAndFile(facts.dependencies[dependencyIndex], file) {
			return ReleaseBinding{}, releaseAuthorityError("runtime manifest dependency differs from compiled authority", nil)
		}
		dependencyIndex++
	}
	if dependencyIndex != len(facts.dependencies) || serviceHostCount != 1 {
		return ReleaseBinding{}, releaseAuthorityError("runtime manifest does not exactly cover compiled dependencies and one ServiceHost", nil)
	}

	binding := ReleaseBinding{
		templateDigest: facts.templateDigest,
		manifestSHA256: manifestSHA256,
		schemaVersion:  facts.schemaVersion,
		profileID:      facts.profileID,
		releaseID:      facts.releaseID,
		compatibility:  facts.compatibility,
		signerPin:      facts.signerPin,
		dependencies:   append([]releaseprofile.Dependency(nil), facts.dependencies...),
		serviceHost:    serviceHost,
		bound:          true,
	}
	if err := binding.Validate(); err != nil {
		return ReleaseBinding{}, releaseAuthorityError("constructed release binding is invalid", err)
	}
	return binding, nil
}

func validateConfigurationAuthority(
	control config.Config,
	executor config.Config,
	facts releaseAuthorityFacts,
) error {
	if err := validateReleaseAuthorityFacts(facts); err != nil {
		return releaseAuthorityError("compiled release authority is invalid", err)
	}
	for _, configuration := range []config.Config{control, executor} {
		if configuration.Installation.ReleaseID != facts.releaseID ||
			configuration.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256 != facts.signerPin {
			return releaseAuthorityError("bootstrap release identity differs from compiled authority", nil)
		}
	}
	return nil
}

func validateReleaseEvidenceState(state *evidenceState) error {
	if state == nil || state.releaseBinding.Validate() != nil {
		return ErrReleaseAuthority
	}
	binding := state.releaseBinding
	control, err := validateSealedBootstrap(state.controlBootstrap, state.controlConfig)
	if err != nil {
		return releaseAuthorityError("sealed Control bootstrap differs from its configuration", err)
	}
	executor, err := validateSealedBootstrap(state.executorBootstrap, state.executorConfig)
	if err != nil {
		return releaseAuthorityError("sealed Executor bootstrap differs from its configuration", err)
	}
	if err := validateConfigurationPair(control, executor); err != nil {
		return releaseAuthorityError("sealed bootstrap configuration pair is inconsistent", err)
	}
	facts := releaseAuthorityFacts{
		templateDigest: binding.templateDigest,
		schemaVersion:  binding.schemaVersion,
		profileID:      binding.profileID,
		releaseID:      binding.releaseID,
		compatibility:  binding.compatibility,
		signerPin:      binding.signerPin,
		dependencies:   append([]releaseprofile.Dependency(nil), binding.dependencies...),
		serviceHost: releaseprofile.SelfRequirement{
			Root: binding.serviceHost.Root, Path: binding.serviceHost.Path, Role: binding.serviceHost.Role,
		},
	}
	if err := validateConfigurationAuthority(control, executor, facts); err != nil {
		return err
	}
	for _, configuration := range []config.Config{control, executor} {
		if configuration.Installation.ManifestSHA256 != binding.manifestSHA256 ||
			!windowsPathEqual(configuration.Installation.ManifestPath, state.manifestRead.File.Path) {
			return releaseAuthorityError("bootstrap manifest selector differs from the sealed release binding", nil)
		}
	}
	documentDigest := sha256.Sum256(state.manifestRead.Data)
	if state.manifestRead.ContentSHA256 != [sha256.Size]byte(documentDigest) ||
		fmt.Sprintf("%x", documentDigest) != binding.manifestSHA256 {
		return releaseAuthorityError("release manifest read differs from its sealed binding", nil)
	}
	parsed, err := releasemanifest.Parse(state.manifestRead.Data)
	if err != nil {
		return releaseAuthorityError("sealed release manifest bytes are invalid", err)
	}
	canonical, err := releasemanifest.MarshalCanonical(state.manifest)
	if err != nil || !bytes.Equal(canonical, state.manifestRead.Data) {
		return releaseAuthorityError("sealed release manifest snapshot differs from its bytes", err)
	}
	rebound, err := bindReleaseManifest(facts, parsed, binding.manifestSHA256)
	if err != nil || !sameReleaseBinding(binding, rebound) {
		return releaseAuthorityError("sealed release binding cannot be reproduced", err)
	}
	if len(state.files) != len(parsed.Files) {
		return releaseAuthorityError("verified file count differs from the release binding", nil)
	}
	for index, file := range parsed.Files {
		snapshot := state.files[index]
		size, sizeErr := parseManifestSize(file.Size)
		if sizeErr != nil || snapshot.root != file.Root || snapshot.path != file.Path ||
			snapshot.role != file.Role || snapshot.sha256 != file.SHA256 || snapshot.size != size {
			return releaseAuthorityError("verified file metadata differs from the release binding", sizeErr)
		}
		if requiresAuthenticode(file.Role) {
			if snapshot.authenticode == nil ||
				validateAuthenticodeEvidence(*snapshot.authenticode, binding.signerPin) != nil {
				return releaseAuthorityError("verified PE signer differs from the release binding", nil)
			}
		} else if snapshot.authenticode != nil {
			return releaseAuthorityError("non-PE release file contains Authenticode authority evidence", nil)
		}
	}
	return nil
}

func validateSealedBootstrap(read secureconfig.Result, expected config.Config) (config.Config, error) {
	if len(read.Data) == 0 || uint64(len(read.Data)) != read.File.Evidence.Size {
		return config.Config{}, errors.New("bootstrap bytes or file size are invalid")
	}
	digest := sha256.Sum256(read.Data)
	if [sha256.Size]byte(read.ContentSHA256) != digest {
		return config.Config{}, errors.New("bootstrap content digest differs from its bytes")
	}
	parsed, err := config.Parse(read.Data)
	if err != nil || !reflect.DeepEqual(parsed, expected) {
		return config.Config{}, errors.Join(errors.New("bootstrap parsed configuration differs from its snapshot"), err)
	}
	expectedLeaf := releasemanifest.ControlBootstrapConfigurationPath
	if parsed.Role == config.RoleExecutor {
		expectedLeaf = releasemanifest.ExecutorBootstrapConfigurationPath
	}
	expectedPath := joinPath(parsed.Installation.TrustedConfigurationRoot, expectedLeaf)
	if !windowsPathEqual(read.File.Path, expectedPath) {
		return config.Config{}, errors.New("bootstrap file path differs from its fixed role path")
	}
	return parsed, nil
}

// Validate rejects a zero, incomplete, or internally inconsistent binding.
func (binding ReleaseBinding) Validate() error {
	if !binding.bound || !validReleaseSHA256(binding.manifestSHA256) {
		return ErrReleaseAuthority
	}
	facts := releaseAuthorityFacts{
		templateDigest: binding.templateDigest,
		schemaVersion:  binding.schemaVersion,
		profileID:      binding.profileID,
		releaseID:      binding.releaseID,
		compatibility:  binding.compatibility,
		signerPin:      binding.signerPin,
		dependencies:   append([]releaseprofile.Dependency(nil), binding.dependencies...),
		serviceHost: releaseprofile.SelfRequirement{
			Root: binding.serviceHost.Root, Path: binding.serviceHost.Path, Role: binding.serviceHost.Role,
		},
	}
	if err := validateReleaseAuthorityFacts(facts); err != nil {
		return errors.Join(ErrReleaseAuthority, err)
	}
	size, err := parseManifestSize(binding.serviceHost.Size)
	if err != nil || size == 0 || size > releaseprofile.MaximumServiceHostBytes ||
		!validReleaseSHA256(binding.serviceHost.SHA256) {
		return errors.Join(ErrReleaseAuthority, err)
	}
	return nil
}

func (binding ReleaseBinding) TemplateDigest() [sha256.Size]byte { return binding.templateDigest }
func (binding ReleaseBinding) ManifestSHA256() string            { return binding.manifestSHA256 }
func (binding ReleaseBinding) TemplateSchemaVersion() uint32     { return binding.schemaVersion }
func (binding ReleaseBinding) ProfileID() string                 { return binding.profileID }
func (binding ReleaseBinding) ReleaseID() string                 { return binding.releaseID }
func (binding ReleaseBinding) Compatibility() releasemanifest.Compatibility {
	return binding.compatibility
}
func (binding ReleaseBinding) ApprovedSignerCertificateDERSHA256() string {
	return binding.signerPin
}
func (binding ReleaseBinding) Dependencies() []releaseprofile.Dependency {
	return append([]releaseprofile.Dependency(nil), binding.dependencies...)
}
func (binding ReleaseBinding) ServiceHost() releasemanifest.File { return binding.serviceHost }

func sameReleaseDependencyAndFile(dependency releaseprofile.Dependency, file releasemanifest.File) bool {
	return dependency.Root == file.Root && dependency.Path == file.Path && dependency.Role == file.Role &&
		dependency.SHA256 == file.SHA256 && dependency.Size == file.Size
}

func validReleaseSHA256(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			if character < 'a' || character > 'f' {
				return false
			}
		}
	}
	return true
}

func sameReleaseManifest(left, right releasemanifest.Manifest) bool {
	if left.SchemaVersion != right.SchemaVersion || left.PublisherPolicy != right.PublisherPolicy ||
		left.ReleaseID != right.ReleaseID || left.Compatibility != right.Compatibility ||
		len(left.Files) != len(right.Files) {
		return false
	}
	for index := range left.Files {
		if left.Files[index] != right.Files[index] {
			return false
		}
	}
	return true
}

func sameReleaseAuthorityFacts(left, right releaseAuthorityFacts) bool {
	if left.templateDigest != right.templateDigest || left.schemaVersion != right.schemaVersion ||
		left.profileID != right.profileID || left.releaseID != right.releaseID ||
		left.compatibility != right.compatibility || left.signerPin != right.signerPin ||
		left.serviceHost != right.serviceHost || len(left.dependencies) != len(right.dependencies) {
		return false
	}
	for index := range left.dependencies {
		if left.dependencies[index] != right.dependencies[index] {
			return false
		}
	}
	return true
}

func cloneReleaseAuthorityFacts(value releaseAuthorityFacts) releaseAuthorityFacts {
	value.dependencies = append([]releaseprofile.Dependency(nil), value.dependencies...)
	return value
}

func cloneReleaseBinding(value ReleaseBinding) ReleaseBinding {
	value.dependencies = append([]releaseprofile.Dependency(nil), value.dependencies...)
	return value
}

func sameReleaseBinding(left, right ReleaseBinding) bool {
	if left.templateDigest != right.templateDigest || left.manifestSHA256 != right.manifestSHA256 ||
		left.schemaVersion != right.schemaVersion || left.profileID != right.profileID ||
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

func releaseAuthorityError(message string, cause error) error {
	return verificationError(ErrorReleaseAuthority, message, errors.Join(ErrReleaseAuthority, cause))
}
