package releasepackage

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

// Finalize revalidates all phase inputs, adds externally verified signed ServiceHost metadata,
// and emits the canonical schema-v2 runtime manifest and zero-authority outer descriptor.
func Finalize(prepared PreparedRelease, request FinalizeRequest) (FinalizedRelease, error) {
	operation, err := beginReleaseEvidenceOperation()
	if err != nil {
		return FinalizedRelease{}, err
	}
	state, err := validatePrepared(prepared)
	if err != nil {
		return FinalizedRelease{}, err
	}
	if err := validateContext(
		request.ReleaseID,
		request.TargetArchitecture,
		request.Source,
		request.AuthenticodeLeafSignerCertificateDERSHA256,
	); err != nil {
		return FinalizedRelease{}, err
	}
	if request.ReleaseID != state.receipt.ReleaseID ||
		request.TargetArchitecture != state.receipt.TargetArchitecture ||
		request.Source != state.receipt.Source ||
		request.AuthenticodeLeafSignerCertificateDERSHA256 != state.receipt.AuthenticodeLeafSignerCertificateDERSHA256 {
		return FinalizedRelease{}, fmt.Errorf("%w: finalization context differs from prepare receipt", ErrMismatch)
	}
	current, err := validateCanonicalDependencies(request.ReleaseID, request.Dependencies)
	if err != nil {
		return FinalizedRelease{}, err
	}
	if !sameDependencies(current, state.receipt.Dependencies) {
		return FinalizedRelease{}, fmt.Errorf("%w: dependency inventory changed after prepare", ErrMismatch)
	}
	serviceHostBuild, err := validateServiceHostBuild(request.ServiceHostBuild)
	if err != nil || !buildReceiptMatchesPrepared(serviceHostBuild, state) {
		return FinalizedRelease{}, fmt.Errorf("%w: ServiceHost build receipt differs from prepare receipt", ErrMismatch)
	}
	serviceHostMetadata, err := validateVerifiedServiceHost(
		request.ServiceHost,
		serviceHostBuild,
		state.receipt,
		state.receiptSHA256,
	)
	if err != nil {
		return FinalizedRelease{}, err
	}

	serviceHost := releasemanifest.File{
		Root:   releasemanifest.RootInstallation,
		Path:   releaseprofile.ServiceHostRelativePath,
		Role:   releasemanifest.RoleServiceHost,
		SHA256: serviceHostMetadata.SHA256,
		Size:   serviceHostMetadata.Size,
	}
	files := make([]releasemanifest.File, 0, len(current)+1)
	for _, dependency := range current {
		files = append(files, dependencyFile(dependency))
	}
	files = append(files, serviceHost)
	manifestDocument, err := releasemanifest.MarshalCanonical(releasemanifest.Manifest{
		Compatibility:   releasemanifest.RequiredCompatibility(),
		Files:           files,
		PublisherPolicy: releasemanifest.PublisherPolicy,
		ReleaseID:       request.ReleaseID,
		SchemaVersion:   releasemanifest.SchemaVersion,
	})
	if err != nil {
		return FinalizedRelease{}, fmt.Errorf("%w: build runtime manifest: %v", ErrInvalid, err)
	}
	manifestDigest := sha256.Sum256(manifestDocument)
	descriptor := PackageDescriptor{
		AuthenticodeLeafSignerCertificateDERSHA256: state.receipt.AuthenticodeLeafSignerCertificateDERSHA256,
		CompiledReleaseTemplateSHA256:              state.receipt.CompiledReleaseTemplateSHA256,
		ExecutionAuthority:                         false,
		FoundationVersion:                          FoundationVersion,
		PackageProfile:                             PackageProfile,
		PrepareReceiptSHA256:                       hex.EncodeToString(state.receiptSHA256[:]),
		ReleaseID:                                  state.receipt.ReleaseID,
		ReviewedClosurePolicyID:                    state.receipt.ReviewedClosurePolicyID,
		ReviewedClosurePolicyVersion:               state.receipt.ReviewedClosurePolicyVersion,
		ReviewedClosureSHA256:                      state.receipt.ReviewedClosureSHA256,
		RuntimeManifestSHA256:                      hex.EncodeToString(manifestDigest[:]),
		SchemaVersion:                              PackageDescriptorSchemaVersion,
		ServiceHost:                                serviceHost,
		ServiceHostBuildReceiptSHA256:              hex.EncodeToString(serviceHostBuild.sha256[:]),
		Source:                                     state.receipt.Source,
		TargetArchitecture:                         state.receipt.TargetArchitecture,
	}
	descriptorDocument, err := marshalCanonical(descriptor)
	if err != nil {
		return FinalizedRelease{}, err
	}
	if _, err := parsePackageDescriptor(descriptorDocument); err != nil {
		return FinalizedRelease{}, err
	}
	descriptorDigest := sha256.Sum256(descriptorDocument)
	result := FinalizedRelease{state: &finalizedState{
		reviewedClosureDocument:         append([]byte(nil), state.closure.state.document...),
		reviewedClosureSHA256:           state.closure.state.sha256,
		prepareReceiptDocument:          append([]byte(nil), state.receiptDocument...),
		prepareReceiptSHA256:            state.receiptSHA256,
		compiledTemplateDocument:        append([]byte(nil), state.templateDocument...),
		compiledTemplateSHA256:          state.templateSHA256,
		serviceHostBuildReceiptDocument: append([]byte(nil), serviceHostBuild.document...),
		serviceHostBuildReceiptSHA256:   serviceHostBuild.sha256,
		manifestDocument:                append([]byte(nil), manifestDocument...),
		manifestSHA256:                  manifestDigest,
		descriptorDocument:              append([]byte(nil), descriptorDocument...),
		descriptorSHA256:                descriptorDigest,
		descriptor:                      cloneDescriptor(descriptor),
	}}
	if err := operation.commit(); err != nil {
		return FinalizedRelease{}, err
	}
	return result, nil
}

// parsePackageDescriptor validates descriptor syntax emitted inside this package. It deliberately
// remains unexported because it does not verify package bytes, the manifest, or Authenticode.
func parsePackageDescriptor(document []byte) (PackageDescriptor, error) {
	var descriptor PackageDescriptor
	if err := parseCanonical(document, &descriptor); err != nil {
		return PackageDescriptor{}, err
	}
	if descriptor.SchemaVersion != PackageDescriptorSchemaVersion ||
		descriptor.PackageProfile != PackageProfile || descriptor.FoundationVersion != FoundationVersion ||
		descriptor.ExecutionAuthority || !validReleaseID(descriptor.ReleaseID) ||
		!validArchitecture(descriptor.TargetArchitecture) || validateSource(descriptor.Source) != nil ||
		!validSHA256(descriptor.AuthenticodeLeafSignerCertificateDERSHA256) ||
		!validSHA256(descriptor.CompiledReleaseTemplateSHA256) ||
		!validSHA256(descriptor.PrepareReceiptSHA256) || !validSHA256(descriptor.RuntimeManifestSHA256) ||
		descriptor.ReviewedClosurePolicyID != ReviewedClosurePolicyID ||
		descriptor.ReviewedClosurePolicyVersion != ReviewedClosurePolicyVersion ||
		!validSHA256(descriptor.ReviewedClosureSHA256) ||
		!validSHA256(descriptor.ServiceHostBuildReceiptSHA256) ||
		descriptor.ServiceHost.Root != releasemanifest.RootInstallation ||
		descriptor.ServiceHost.Path != releaseprofile.ServiceHostRelativePath ||
		descriptor.ServiceHost.Role != releasemanifest.RoleServiceHost ||
		!validSHA256(descriptor.ServiceHost.SHA256) || !validServiceHostSize(descriptor.ServiceHost.Size) {
		return PackageDescriptor{}, fmt.Errorf("%w: package descriptor fields are invalid", ErrInvalid)
	}
	return cloneDescriptor(descriptor), nil
}

func validateVerifiedServiceHost(
	evidence VerifiedServiceHostEvidence,
	build *serviceHostBuildState,
	receipt prepareReceiptDocument,
	receiptSHA256 [sha256.Size]byte,
) (serviceHostMetadata, error) {
	if evidence.state == nil {
		return serviceHostMetadata{}, fmt.Errorf("%w: verified ServiceHost evidence is absent", ErrInvalid)
	}
	value := evidence.state.metadata
	if value.ReleaseID != receipt.ReleaseID || value.TargetArchitecture != receipt.TargetArchitecture ||
		value.Source != receipt.Source || value.CompiledReleaseTemplateSHA256 != receipt.CompiledReleaseTemplateSHA256 ||
		value.VerifiedAuthenticodeLeafCertificateDERSHA256 != receipt.AuthenticodeLeafSignerCertificateDERSHA256 {
		return serviceHostMetadata{}, fmt.Errorf(
			"%w: verified ServiceHost metadata differs from prepare receipt",
			ErrMismatch,
		)
	}
	if build == nil || evidence.state.preparedReceiptSHA256 != receiptSHA256 ||
		evidence.state.buildReceiptSHA256 != build.sha256 ||
		evidence.state.fileIdentity == (winfile.FileIdentity{}) || evidence.state.size == 0 ||
		evidence.state.metadata.SHA256 != hex.EncodeToString(evidence.state.digest[:]) ||
		evidence.state.metadata.Size != strconv.FormatUint(evidence.state.size, 10) ||
		!validAuthenticodeEvidence(evidence.state.authenticode, receipt.AuthenticodeLeafSignerCertificateDERSHA256) ||
		evidence.state.metadata.VerifiedAuthenticodeLeafCertificateDERSHA256 !=
			evidence.state.authenticode.VerifiedLeafSignerCertificateDERSHA256 {
		return serviceHostMetadata{}, fmt.Errorf("%w: verified ServiceHost evidence is inconsistent", ErrInvalid)
	}
	if !validSHA256(value.SHA256) || !validServiceHostSize(value.Size) {
		return serviceHostMetadata{}, fmt.Errorf(
			"%w: verified ServiceHost digest or size is invalid",
			ErrInvalid,
		)
	}
	return value, nil
}

func (finalized FinalizedRelease) ManifestDocument() []byte {
	if finalized.state == nil {
		return nil
	}
	return append([]byte(nil), finalized.state.manifestDocument...)
}

func (finalized FinalizedRelease) ManifestSHA256() [sha256.Size]byte {
	if finalized.state == nil {
		return [sha256.Size]byte{}
	}
	return finalized.state.manifestSHA256
}

func (finalized FinalizedRelease) DescriptorDocument() []byte {
	if finalized.state == nil {
		return nil
	}
	return append([]byte(nil), finalized.state.descriptorDocument...)
}

func (finalized FinalizedRelease) DescriptorSHA256() [sha256.Size]byte {
	if finalized.state == nil {
		return [sha256.Size]byte{}
	}
	return finalized.state.descriptorSHA256
}

func (finalized FinalizedRelease) Descriptor() PackageDescriptor {
	if finalized.state == nil {
		return PackageDescriptor{}
	}
	return cloneDescriptor(finalized.state.descriptor)
}
