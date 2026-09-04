package stagedpackage

import (
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasepackage"
)

func (v *verifier) inspectDocuments() (releasepackage.FinalizedDocumentFacts, error) {
	if v == nil || len(v.documents.descriptor) == 0 || len(v.documents.prepare) == 0 ||
		len(v.documents.closure) == 0 || len(v.documents.template) == 0 ||
		len(v.documents.buildReceipt) == 0 || len(v.documents.manifest) == 0 {
		return releasepackage.FinalizedDocumentFacts{}, ErrDocuments
	}
	facts, err := releasepackage.InspectFinalizedDocuments(releasepackage.FinalizedDocuments{
		ReviewedClosure:         v.documents.closure,
		PrepareReceipt:          v.documents.prepare,
		CompiledTemplate:        v.documents.template,
		ServiceHostBuildReceipt: v.documents.buildReceipt,
		RuntimeManifest:         v.documents.manifest,
		PackageDescriptor:       v.documents.descriptor,
	})
	if err != nil || validateDocumentBindings(v.plan.index, v.plan.control, v.plan.executor, facts) != nil {
		return releasepackage.FinalizedDocumentFacts{}, ErrDocuments
	}
	return cloneDocumentFacts(facts), nil
}

func validateDocumentBindings(
	index outerpackage.Index,
	control config.Config,
	executor config.Config,
	facts releasepackage.FinalizedDocumentFacts,
) error {
	descriptor := facts.Descriptor
	if descriptor.ReleaseID != index.ReleaseID ||
		string(descriptor.TargetArchitecture) != string(index.TargetArchitecture) ||
		descriptor.Source.Commit != index.Source.Commit || descriptor.Source.Tree != index.Source.Tree ||
		descriptor.AuthenticodeLeafSignerCertificateDERSHA256 !=
			control.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256 ||
		descriptor.AuthenticodeLeafSignerCertificateDERSHA256 !=
			executor.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256 ||
		facts.Manifest.ReleaseID != index.ReleaseID ||
		facts.ServiceHostBuild.ReleaseID != index.ReleaseID ||
		facts.ServiceHostBuild.TargetArchitecture != string(index.TargetArchitecture) ||
		facts.ServiceHostBuild.Source.Commit != index.Source.Commit ||
		facts.ServiceHostBuild.Source.Tree != index.Source.Tree ||
		facts.ServiceHostBuild.CompiledReleaseTemplateSHA256 != descriptor.CompiledReleaseTemplateSHA256 {
		return ErrDocuments
	}

	runtimePayloads := make(map[string]outerpackage.Payload)
	for _, payload := range index.Payloads {
		if isSpecialPayloadRole(payload.Role) {
			continue
		}
		key := packageFileKey(payload.Root, payload.Path)
		if _, duplicate := runtimePayloads[key]; duplicate {
			return ErrDocuments
		}
		runtimePayloads[key] = payload
	}
	if len(runtimePayloads) != len(facts.Manifest.Files) {
		return ErrDocuments
	}
	for _, file := range facts.Manifest.Files {
		payload, ok := runtimePayloads[packageFileKey(outerpackage.Root(file.Root), file.Path)]
		if !ok || payload.Root != outerpackage.Root(file.Root) || payload.Path != file.Path ||
			string(payload.Role) != string(file.Role) || payload.SHA256 != file.SHA256 ||
			payload.Size != file.Size {
			return ErrDocuments
		}
		delete(runtimePayloads, packageFileKey(payload.Root, payload.Path))
	}
	if len(runtimePayloads) != 0 {
		return ErrDocuments
	}
	serviceHost, found := facts.Manifest.LookupFile(
		releasemanifest.RootInstallation,
		descriptor.ServiceHost.Path,
	)
	if !found || serviceHost != descriptor.ServiceHost {
		return ErrDocuments
	}
	payload, found := indexedPayload(
		index,
		outerpackage.RootInstallation,
		descriptor.ServiceHost.Path,
	)
	if !found || payload.Role != outerpackage.RoleServiceHost ||
		payload.SHA256 != descriptor.ServiceHost.SHA256 || payload.Size != descriptor.ServiceHost.Size {
		return ErrDocuments
	}
	return nil
}

func indexedPayload(index outerpackage.Index, root outerpackage.Root, path string) (outerpackage.Payload, bool) {
	for _, payload := range index.Payloads {
		if payload.Root == root && payload.Path == path {
			return payload, true
		}
	}
	return outerpackage.Payload{}, false
}

func cloneDocumentFacts(value releasepackage.FinalizedDocumentFacts) releasepackage.FinalizedDocumentFacts {
	value.Manifest.Files = append([]releasemanifest.File(nil), value.Manifest.Files...)
	return value
}
