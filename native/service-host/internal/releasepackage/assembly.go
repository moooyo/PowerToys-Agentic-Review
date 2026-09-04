package releasepackage

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/servicehostreceipt"
)

// SnapshotForAssembly validates and copies every finalized document at one cleanup-gated commit
// point. A cleanup failure published before that point prevents the snapshot from being returned.
func (finalized FinalizedRelease) SnapshotForAssembly() (AssemblySnapshot, error) {
	operation, err := beginReleaseEvidenceOperation()
	if err != nil {
		return AssemblySnapshot{}, err
	}
	var snapshot AssemblySnapshot
	err = operation.commitWith(func() error {
		state, err := validatedFinalizedState(finalized.state)
		if err != nil {
			return err
		}
		snapshot = AssemblySnapshot{state: state}
		return nil
	})
	if err != nil {
		return AssemblySnapshot{}, err
	}
	return snapshot, nil
}

// InspectFinalizedDocuments validates the canonical document set and all of its internal digest,
// source, architecture, closure, template, build-receipt, manifest, and descriptor bindings. It
// returns ordinary data only and does not recreate any opaque production evidence.
func InspectFinalizedDocuments(documents FinalizedDocuments) (FinalizedDocumentFacts, error) {
	descriptor, err := parsePackageDescriptor(documents.PackageDescriptor)
	if err != nil {
		return FinalizedDocumentFacts{}, fmt.Errorf("%w: finalized package descriptor is invalid", ErrInvalid)
	}
	state := &finalizedState{
		reviewedClosureDocument:         append([]byte(nil), documents.ReviewedClosure...),
		reviewedClosureSHA256:           sha256.Sum256(documents.ReviewedClosure),
		prepareReceiptDocument:          append([]byte(nil), documents.PrepareReceipt...),
		prepareReceiptSHA256:            sha256.Sum256(documents.PrepareReceipt),
		compiledTemplateDocument:        append([]byte(nil), documents.CompiledTemplate...),
		compiledTemplateSHA256:          sha256.Sum256(documents.CompiledTemplate),
		serviceHostBuildReceiptDocument: append([]byte(nil), documents.ServiceHostBuildReceipt...),
		serviceHostBuildReceiptSHA256:   sha256.Sum256(documents.ServiceHostBuildReceipt),
		manifestDocument:                append([]byte(nil), documents.RuntimeManifest...),
		manifestSHA256:                  sha256.Sum256(documents.RuntimeManifest),
		descriptorDocument:              append([]byte(nil), documents.PackageDescriptor...),
		descriptorSHA256:                sha256.Sum256(documents.PackageDescriptor),
		descriptor:                      descriptor,
	}
	validated, err := validatedFinalizedState(state)
	if err != nil {
		return FinalizedDocumentFacts{}, err
	}
	manifest, err := releasemanifest.Parse(validated.manifestDocument)
	if err != nil {
		return FinalizedDocumentFacts{}, fmt.Errorf("%w: finalized runtime manifest is invalid", ErrInvalid)
	}
	build, err := servicehostreceipt.Parse(validated.serviceHostBuildReceiptDocument)
	if err != nil {
		return FinalizedDocumentFacts{}, fmt.Errorf("%w: finalized ServiceHost build receipt is invalid", ErrInvalid)
	}
	manifest.Files = append([]releasemanifest.File(nil), manifest.Files...)
	return FinalizedDocumentFacts{
		Descriptor:       cloneDescriptor(validated.descriptor),
		Manifest:         manifest,
		ServiceHostBuild: build,
	}, nil
}

func validatedFinalizedState(state *finalizedState) (*finalizedState, error) {
	if state == nil {
		return nil, fmt.Errorf("%w: finalized release is absent", ErrInvalid)
	}
	cloned := cloneFinalizedState(state)
	for _, document := range []struct {
		value  []byte
		digest [sha256.Size]byte
	}{
		{cloned.reviewedClosureDocument, cloned.reviewedClosureSHA256},
		{cloned.prepareReceiptDocument, cloned.prepareReceiptSHA256},
		{cloned.compiledTemplateDocument, cloned.compiledTemplateSHA256},
		{cloned.serviceHostBuildReceiptDocument, cloned.serviceHostBuildReceiptSHA256},
		{cloned.manifestDocument, cloned.manifestSHA256},
		{cloned.descriptorDocument, cloned.descriptorSHA256},
	} {
		if len(document.value) == 0 || document.digest == ([sha256.Size]byte{}) ||
			sha256.Sum256(document.value) != document.digest {
			return nil, fmt.Errorf("%w: finalized document digest is inconsistent", ErrInvalid)
		}
	}

	reviewed, err := parseReviewedClosure(
		cloned.reviewedClosureDocument,
		hex.EncodeToString(cloned.reviewedClosureSHA256[:]),
	)
	if err != nil {
		return nil, fmt.Errorf("%w: finalized reviewed closure is invalid", ErrInvalid)
	}
	prepared, err := ParsePrepareReceipt(cloned.prepareReceiptDocument, reviewed)
	if err != nil || prepared.state == nil ||
		prepared.state.receiptSHA256 != cloned.prepareReceiptSHA256 ||
		prepared.state.templateSHA256 != cloned.compiledTemplateSHA256 ||
		!bytes.Equal(prepared.state.templateDocument, cloned.compiledTemplateDocument) {
		return nil, fmt.Errorf("%w: finalized prepare documents are inconsistent", ErrInvalid)
	}
	buildReceipt, err := servicehostreceipt.Parse(cloned.serviceHostBuildReceiptDocument)
	buildState := &serviceHostBuildState{
		document: cloned.serviceHostBuildReceiptDocument,
		sha256:   cloned.serviceHostBuildReceiptSHA256,
		receipt:  buildReceipt,
	}
	if err != nil || !buildReceiptMatchesPrepared(buildState, prepared.state) {
		return nil, fmt.Errorf("%w: finalized ServiceHost build receipt is inconsistent", ErrInvalid)
	}
	manifest, err := releasemanifest.Parse(cloned.manifestDocument)
	if err != nil {
		return nil, fmt.Errorf("%w: finalized runtime manifest is invalid", ErrInvalid)
	}
	descriptor, err := parsePackageDescriptor(cloned.descriptorDocument)
	if err != nil || descriptor != cloned.descriptor {
		return nil, fmt.Errorf("%w: finalized package descriptor is inconsistent", ErrInvalid)
	}

	expectedDescriptor := PackageDescriptor{
		AuthenticodeLeafSignerCertificateDERSHA256: prepared.state.receipt.AuthenticodeLeafSignerCertificateDERSHA256,
		CompiledReleaseTemplateSHA256:              hex.EncodeToString(cloned.compiledTemplateSHA256[:]),
		ExecutionAuthority:                         false,
		FoundationVersion:                          FoundationVersion,
		PackageProfile:                             PackageProfile,
		PrepareReceiptSHA256:                       hex.EncodeToString(cloned.prepareReceiptSHA256[:]),
		ReleaseID:                                  prepared.state.receipt.ReleaseID,
		ReviewedClosurePolicyID:                    prepared.state.receipt.ReviewedClosurePolicyID,
		ReviewedClosurePolicyVersion:               prepared.state.receipt.ReviewedClosurePolicyVersion,
		ReviewedClosureSHA256:                      hex.EncodeToString(cloned.reviewedClosureSHA256[:]),
		RuntimeManifestSHA256:                      hex.EncodeToString(cloned.manifestSHA256[:]),
		SchemaVersion:                              PackageDescriptorSchemaVersion,
		ServiceHost:                                descriptor.ServiceHost,
		ServiceHostBuildReceiptSHA256:              hex.EncodeToString(cloned.serviceHostBuildReceiptSHA256[:]),
		Source:                                     prepared.state.receipt.Source,
		TargetArchitecture:                         prepared.state.receipt.TargetArchitecture,
	}
	if descriptor != expectedDescriptor {
		return nil, fmt.Errorf("%w: finalized package descriptor bindings are inconsistent", ErrInvalid)
	}
	expectedFiles := make([]releasemanifest.File, 0, len(prepared.state.receipt.Dependencies)+1)
	for _, dependency := range prepared.state.receipt.Dependencies {
		expectedFiles = append(expectedFiles, dependencyFile(dependency))
	}
	expectedFiles = append(expectedFiles, descriptor.ServiceHost)
	expectedManifest, err := releasemanifest.MarshalCanonical(releasemanifest.Manifest{
		Compatibility:   releasemanifest.RequiredCompatibility(),
		Files:           expectedFiles,
		PublisherPolicy: releasemanifest.PublisherPolicy,
		ReleaseID:       prepared.state.receipt.ReleaseID,
		SchemaVersion:   releasemanifest.SchemaVersion,
	})
	if err != nil || manifest.ReleaseID != descriptor.ReleaseID ||
		!bytes.Equal(expectedManifest, cloned.manifestDocument) {
		return nil, fmt.Errorf("%w: finalized runtime closure is inconsistent", ErrInvalid)
	}
	cloned.descriptor = cloneDescriptor(descriptor)
	return cloned, nil
}

func cloneFinalizedState(state *finalizedState) *finalizedState {
	if state == nil {
		return nil
	}
	return &finalizedState{
		reviewedClosureDocument:         append([]byte(nil), state.reviewedClosureDocument...),
		reviewedClosureSHA256:           state.reviewedClosureSHA256,
		prepareReceiptDocument:          append([]byte(nil), state.prepareReceiptDocument...),
		prepareReceiptSHA256:            state.prepareReceiptSHA256,
		compiledTemplateDocument:        append([]byte(nil), state.compiledTemplateDocument...),
		compiledTemplateSHA256:          state.compiledTemplateSHA256,
		serviceHostBuildReceiptDocument: append([]byte(nil), state.serviceHostBuildReceiptDocument...),
		serviceHostBuildReceiptSHA256:   state.serviceHostBuildReceiptSHA256,
		manifestDocument:                append([]byte(nil), state.manifestDocument...),
		manifestSHA256:                  state.manifestSHA256,
		descriptorDocument:              append([]byte(nil), state.descriptorDocument...),
		descriptorSHA256:                state.descriptorSHA256,
		descriptor:                      cloneDescriptor(state.descriptor),
	}
}

func (snapshot AssemblySnapshot) ReviewedClosureDocument() []byte {
	if snapshot.state == nil {
		return nil
	}
	return append([]byte(nil), snapshot.state.reviewedClosureDocument...)
}

func (snapshot AssemblySnapshot) ReviewedClosureSHA256() [sha256.Size]byte {
	if snapshot.state == nil {
		return [sha256.Size]byte{}
	}
	return snapshot.state.reviewedClosureSHA256
}

func (snapshot AssemblySnapshot) PrepareReceiptDocument() []byte {
	if snapshot.state == nil {
		return nil
	}
	return append([]byte(nil), snapshot.state.prepareReceiptDocument...)
}

func (snapshot AssemblySnapshot) PrepareReceiptSHA256() [sha256.Size]byte {
	if snapshot.state == nil {
		return [sha256.Size]byte{}
	}
	return snapshot.state.prepareReceiptSHA256
}

func (snapshot AssemblySnapshot) CompiledTemplateDocument() []byte {
	if snapshot.state == nil {
		return nil
	}
	return append([]byte(nil), snapshot.state.compiledTemplateDocument...)
}

func (snapshot AssemblySnapshot) CompiledTemplateSHA256() [sha256.Size]byte {
	if snapshot.state == nil {
		return [sha256.Size]byte{}
	}
	return snapshot.state.compiledTemplateSHA256
}

func (snapshot AssemblySnapshot) ServiceHostBuildReceiptDocument() []byte {
	if snapshot.state == nil {
		return nil
	}
	return append([]byte(nil), snapshot.state.serviceHostBuildReceiptDocument...)
}

func (snapshot AssemblySnapshot) ServiceHostBuildReceiptSHA256() [sha256.Size]byte {
	if snapshot.state == nil {
		return [sha256.Size]byte{}
	}
	return snapshot.state.serviceHostBuildReceiptSHA256
}

func (snapshot AssemblySnapshot) ManifestDocument() []byte {
	if snapshot.state == nil {
		return nil
	}
	return append([]byte(nil), snapshot.state.manifestDocument...)
}

func (snapshot AssemblySnapshot) ManifestSHA256() [sha256.Size]byte {
	if snapshot.state == nil {
		return [sha256.Size]byte{}
	}
	return snapshot.state.manifestSHA256
}

func (snapshot AssemblySnapshot) DescriptorDocument() []byte {
	if snapshot.state == nil {
		return nil
	}
	return append([]byte(nil), snapshot.state.descriptorDocument...)
}

func (snapshot AssemblySnapshot) DescriptorSHA256() [sha256.Size]byte {
	if snapshot.state == nil {
		return [sha256.Size]byte{}
	}
	return snapshot.state.descriptorSHA256
}

func (snapshot AssemblySnapshot) Descriptor() PackageDescriptor {
	if snapshot.state == nil {
		return PackageDescriptor{}
	}
	return cloneDescriptor(snapshot.state.descriptor)
}
