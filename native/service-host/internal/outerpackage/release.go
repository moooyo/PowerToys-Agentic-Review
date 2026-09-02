package outerpackage

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasepackage"
)

type finalizedDocuments struct {
	reviewedClosure        []byte
	reviewedClosureSHA256  [sha256.Size]byte
	prepareReceipt         []byte
	prepareReceiptSHA256   [sha256.Size]byte
	compiledTemplate       []byte
	compiledTemplateSHA256 [sha256.Size]byte
	serviceHostBuild       []byte
	serviceHostBuildSHA256 [sha256.Size]byte
	manifest               []byte
	manifestSHA256         [sha256.Size]byte
	descriptor             []byte
	descriptorSHA256       [sha256.Size]byte
}

type finalizedReleaseSource interface {
	ReviewedClosureDocument() []byte
	ReviewedClosureSHA256() [sha256.Size]byte
	PrepareReceiptDocument() []byte
	PrepareReceiptSHA256() [sha256.Size]byte
	CompiledTemplateDocument() []byte
	CompiledTemplateSHA256() [sha256.Size]byte
	ServiceHostBuildReceiptDocument() []byte
	ServiceHostBuildReceiptSHA256() [sha256.Size]byte
	ManifestDocument() []byte
	ManifestSHA256() [sha256.Size]byte
	DescriptorDocument() []byte
	DescriptorSHA256() [sha256.Size]byte
	Descriptor() releasepackage.PackageDescriptor
}

// BuildIndex constructs canonical package-index.json bytes from one finalized release and the
// node-specific installation identities that are not part of the runtime manifest.
func BuildIndex(finalized releasepackage.FinalizedRelease, options BuildOptions) ([]byte, error) {
	snapshot, err := finalized.SnapshotForAssembly()
	if err != nil {
		return nil, err
	}
	return buildIndex(snapshot, options)
}

func buildIndex(finalized finalizedReleaseSource, options BuildOptions) ([]byte, error) {
	documents, descriptor, manifest, err := captureFinalizedRelease(finalized)
	if err != nil {
		return nil, err
	}
	architecture := TargetArchitecture(descriptor.TargetArchitecture)
	payloads := []Payload{
		documentPayload(RootMetadata, PackageDescriptorPath, RolePackageDescriptor, documents.descriptor, documents.descriptorSHA256),
		documentPayload(RootMetadata, PrepareReceiptPath, RolePrepareReceipt, documents.prepareReceipt, documents.prepareReceiptSHA256),
		documentPayload(RootMetadata, ReviewedClosurePath, RoleReviewedClosure, documents.reviewedClosure, documents.reviewedClosureSHA256),
		documentPayload(RootMetadata, CompiledReleaseTemplatePath, RoleCompiledReleaseTemplate, documents.compiledTemplate, documents.compiledTemplateSHA256),
		documentPayload(RootMetadata, ServiceHostBuildReceiptPath, RoleServiceHostBuildReceipt, documents.serviceHostBuild, documents.serviceHostBuildSHA256),
		documentPayload(RootInstallation, RuntimeManifestPath, RoleRuntimeManifest, documents.manifest, documents.manifestSHA256),
		bootstrapPayload(ControlBootstrapPath, RoleControlBootstrap, options.ControlBootstrap),
		bootstrapPayload(ExecutorBootstrapPath, RoleExecutorBootstrap, options.ExecutorBootstrap),
	}
	for _, file := range manifest.Files {
		role, ok := outerRoleFromManifest(file.Role)
		if !ok {
			return nil, fmt.Errorf("%w: finalized manifest contains an unsupported payload role", ErrInvalid)
		}
		payload := Payload{
			Path: file.Path, Role: role, Root: Root(file.Root), SHA256: file.SHA256, Size: file.Size,
		}
		if _, isPE := portableExecutableRoles[role]; isPE {
			value := architecture
			payload.TargetArchitecture = &value
		}
		payloads = append(payloads, payload)
	}
	return MarshalIndexCanonical(Index{
		InstallationID:                       options.InstallationID,
		LocalAuthorityCNG:                    options.LocalAuthorityCNG,
		MTLSClientCredential:                 options.MTLSClientCredential,
		NodeSpecificLocalAuthorityPublicSPKI: NodeSpecificSPKI(descriptor.NodeSpecificSPKI),
		PackageID:                            options.PackageID,
		Payloads:                             payloads,
		ProfileID:                            IndexProfileID,
		ReleaseID:                            descriptor.ReleaseID,
		SchemaVersion:                        IndexSchemaVersion,
		Source: SourceIdentity{
			Commit: descriptor.Source.Commit,
			Tree:   descriptor.Source.Tree,
		},
		TargetArchitecture: architecture,
		TargetRoots:        options.TargetRoots,
		WorkerNodeID:       options.WorkerNodeID,
	})
}

// ValidateAgainstRelease proves only that canonical index bytes reproduce the exact finalized
// release closure. It treats the index's node identities, roots, and bootstrap facts as data and
// does not establish independent node authority or produce installation evidence.
func ValidateAgainstRelease(document []byte, finalized releasepackage.FinalizedRelease) error {
	snapshot, err := finalized.SnapshotForAssembly()
	if err != nil {
		return err
	}
	return validateAgainstRelease(document, snapshot)
}

func validateAgainstRelease(document []byte, finalized finalizedReleaseSource) error {
	index, err := ParseIndex(document)
	if err != nil {
		return err
	}
	control, ok := payloadByRole(index.Payloads, RoleControlBootstrap)
	if !ok {
		return ErrMismatch
	}
	executor, ok := payloadByRole(index.Payloads, RoleExecutorBootstrap)
	if !ok {
		return ErrMismatch
	}
	expected, err := buildIndex(finalized, BuildOptions{
		PackageID:            index.PackageID,
		InstallationID:       index.InstallationID,
		WorkerNodeID:         index.WorkerNodeID,
		LocalAuthorityCNG:    index.LocalAuthorityCNG,
		MTLSClientCredential: index.MTLSClientCredential,
		TargetRoots:          index.TargetRoots,
		ControlBootstrap:     BootstrapPayload{SHA256: control.SHA256, Size: control.Size},
		ExecutorBootstrap:    BootstrapPayload{SHA256: executor.SHA256, Size: executor.Size},
	})
	if err != nil || !bytes.Equal(expected, document) {
		return ErrMismatch
	}
	return nil
}

func captureFinalizedRelease(
	finalized finalizedReleaseSource,
) (finalizedDocuments, releasepackage.PackageDescriptor, releasemanifest.Manifest, error) {
	if finalized == nil {
		return finalizedDocuments{}, releasepackage.PackageDescriptor{}, releasemanifest.Manifest{},
			fmt.Errorf("%w: finalized release is absent", ErrInvalid)
	}
	documents := finalizedDocuments{
		reviewedClosure:        finalized.ReviewedClosureDocument(),
		reviewedClosureSHA256:  finalized.ReviewedClosureSHA256(),
		prepareReceipt:         finalized.PrepareReceiptDocument(),
		prepareReceiptSHA256:   finalized.PrepareReceiptSHA256(),
		compiledTemplate:       finalized.CompiledTemplateDocument(),
		compiledTemplateSHA256: finalized.CompiledTemplateSHA256(),
		serviceHostBuild:       finalized.ServiceHostBuildReceiptDocument(),
		serviceHostBuildSHA256: finalized.ServiceHostBuildReceiptSHA256(),
		manifest:               finalized.ManifestDocument(),
		manifestSHA256:         finalized.ManifestSHA256(),
		descriptor:             finalized.DescriptorDocument(),
		descriptorSHA256:       finalized.DescriptorSHA256(),
	}
	for _, document := range []struct {
		value  []byte
		digest [sha256.Size]byte
	}{
		{documents.reviewedClosure, documents.reviewedClosureSHA256},
		{documents.prepareReceipt, documents.prepareReceiptSHA256},
		{documents.compiledTemplate, documents.compiledTemplateSHA256},
		{documents.serviceHostBuild, documents.serviceHostBuildSHA256},
		{documents.manifest, documents.manifestSHA256},
		{documents.descriptor, documents.descriptorSHA256},
	} {
		if len(document.value) == 0 || document.digest == ([sha256.Size]byte{}) ||
			sha256.Sum256(document.value) != document.digest {
			return finalizedDocuments{}, releasepackage.PackageDescriptor{}, releasemanifest.Manifest{},
				fmt.Errorf("%w: finalized release document snapshot is invalid", ErrInvalid)
		}
	}
	descriptor := finalized.Descriptor()
	canonicalDescriptor, canonicalErr := marshalCanonical(descriptor, releasemanifest.MaximumDocumentBytes)
	manifest, err := releasemanifest.Parse(documents.manifest)
	if err != nil || canonicalErr != nil || !bytes.Equal(canonicalDescriptor, documents.descriptor) ||
		descriptor.SchemaVersion != releasepackage.PackageDescriptorSchemaVersion ||
		descriptor.PackageProfile != releasepackage.PackageProfile ||
		descriptor.FoundationVersion != releasepackage.FoundationVersion || descriptor.ExecutionAuthority ||
		descriptor.ReleaseID != manifest.ReleaseID ||
		descriptor.RuntimeManifestSHA256 != hexDigest(documents.manifestSHA256) ||
		descriptor.PrepareReceiptSHA256 != hexDigest(documents.prepareReceiptSHA256) ||
		descriptor.ReviewedClosureSHA256 != hexDigest(documents.reviewedClosureSHA256) ||
		descriptor.CompiledReleaseTemplateSHA256 != hexDigest(documents.compiledTemplateSHA256) ||
		descriptor.ServiceHostBuildReceiptSHA256 != hexDigest(documents.serviceHostBuildSHA256) {
		return finalizedDocuments{}, releasepackage.PackageDescriptor{}, releasemanifest.Manifest{},
			fmt.Errorf("%w: finalized release document bindings are invalid", ErrInvalid)
	}
	serviceHost, found := manifest.LookupFile(
		releasemanifest.RootInstallation,
		descriptor.ServiceHost.Path,
	)
	if !found || serviceHost != descriptor.ServiceHost {
		return finalizedDocuments{}, releasepackage.PackageDescriptor{}, releasemanifest.Manifest{},
			fmt.Errorf("%w: finalized ServiceHost binding is invalid", ErrInvalid)
	}
	spki, found := manifest.LookupFile(
		releasemanifest.RootTrustedConfiguration,
		descriptor.NodeSpecificSPKI.Path,
	)
	if !found || spki.Role != releasemanifest.RoleTrustedConfig ||
		spki.SHA256 != descriptor.NodeSpecificSPKI.SHA256 {
		return finalizedDocuments{}, releasepackage.PackageDescriptor{}, releasemanifest.Manifest{},
			fmt.Errorf("%w: finalized node-specific SPKI binding is invalid", ErrInvalid)
	}
	return documents, descriptor, manifest, nil
}

func documentPayload(
	root Root,
	path string,
	role Role,
	document []byte,
	digest [sha256.Size]byte,
) Payload {
	return Payload{
		Path: path, Role: role, Root: root, SHA256: hexDigest(digest),
		Size: strconv.FormatUint(uint64(len(document)), 10),
	}
}

func bootstrapPayload(path string, role Role, value BootstrapPayload) Payload {
	return Payload{
		Path: path, Role: role, Root: RootTrustedConfiguration,
		SHA256: value.SHA256, Size: value.Size,
	}
}

func payloadByRole(payloads []Payload, role Role) (Payload, bool) {
	for _, payload := range payloads {
		if payload.Role == role {
			return payload, true
		}
	}
	return Payload{}, false
}

func outerRoleFromManifest(role releasemanifest.FileRole) (Role, bool) {
	for outer, manifest := range runtimeRoleMapping {
		if manifest == role {
			return outer, true
		}
	}
	return "", false
}

func hexDigest(value [sha256.Size]byte) string { return hex.EncodeToString(value[:]) }
