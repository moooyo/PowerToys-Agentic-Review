package preflight

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"hash"
	"reflect"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/cng"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peerverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winidentity"
)

// Validate rejects zero, incomplete, internally inconsistent, or mutated
// evidence. No diagnostic-only strings participate in the digest.
func (e Evidence) Validate() error {
	if e.role != config.RoleControl && e.role != config.RoleExecutor ||
		e.actualBootstrapPath == "" || e.digest == ([32]byte{}) ||
		len(e.roots) != 2 || len(e.files) == 0 || len(e.bindings) != 8+len(e.manifest.Manifest.Files) {
		return invalidEvidenceError("preflight evidence is empty or incomplete", nil)
	}
	controlConfiguration, err := parseConfigurationRead("Control", e.control.Read)
	if err != nil || !reflect.DeepEqual(controlConfiguration, e.control.Configuration) {
		return invalidEvidenceError("Control secure read differs from its configuration", err)
	}
	executorConfiguration, err := parseConfigurationRead("Executor", e.executor.Read)
	if err != nil || !reflect.DeepEqual(executorConfiguration, e.executor.Configuration) {
		return invalidEvidenceError("Executor secure read differs from its configuration", err)
	}
	if err := validateConfigurationPair(e.control.Configuration, e.executor.Configuration); err != nil {
		return invalidEvidenceError("configuration pair is inconsistent", err)
	}
	if err := validateConfigurationSecurityPaths(e.control.Configuration); err != nil {
		return invalidEvidenceError("Control configuration contains an unsafe security path", err)
	}
	if err := validateConfigurationSecurityPaths(e.executor.Configuration); err != nil {
		return invalidEvidenceError("Executor configuration contains an unsafe security path", err)
	}
	roots, rootIndex, err := validateRoots(e.roots, e.control.Configuration, e.executor.Configuration)
	if err != nil {
		return invalidEvidenceError("verified installation roots are invalid", err)
	}
	controlBinding, err := bindBootstrap(
		e.control.Configuration,
		e.control.Read,
		releasemanifest.BootstrapControl,
		rootIndex[releasemanifest.RootTrustedConfiguration],
	)
	if err != nil || controlBinding.Binding != e.control.Binding {
		return invalidEvidenceError("Control bootstrap binding is inconsistent", err)
	}
	executorBinding, err := bindBootstrap(
		e.executor.Configuration,
		e.executor.Read,
		releasemanifest.BootstrapExecutor,
		rootIndex[releasemanifest.RootTrustedConfiguration],
	)
	if err != nil || executorBinding.Binding != e.executor.Binding {
		return invalidEvidenceError("Executor bootstrap binding is inconsistent", err)
	}
	selectedBootstrapPath := e.control.Read.File.Path
	if e.role == config.RoleExecutor {
		selectedBootstrapPath = e.executor.Read.File.Path
	}
	if !windowsPathEqual(e.actualBootstrapPath, selectedBootstrapPath) {
		return invalidEvidenceError("actual bootstrap path differs from the selected secure read", nil)
	}
	manifestBinding, err := validateManifestRead(
		e.manifest.Read,
		e.control.Configuration,
		e.executor.Configuration,
		rootIndex[releasemanifest.RootInstallation],
	)
	if err != nil || manifestBinding.SHA256 != e.manifest.SHA256 ||
		!reflect.DeepEqual(manifestBinding.Manifest, e.manifest.Manifest) {
		return invalidEvidenceError("manifest secure read or binding is inconsistent", err)
	}
	files, fileIndex, err := validateVerifiedFiles(e.files, e.manifest.Manifest, rootIndex)
	if err != nil {
		return invalidEvidenceError("verified installation files are invalid", err)
	}
	if err := validateUniqueFileIdentities(
		roots,
		e.control.Read,
		e.executor.Read,
		e.manifest.Read,
		files,
	); err != nil {
		return invalidEvidenceError("filesystem identities are inconsistent", err)
	}
	expectedBindings, err := bindConfiguredFiles(
		e.control.Configuration,
		e.executor.Configuration,
		e.manifest,
		rootIndex,
		fileIndex,
	)
	if err != nil {
		return invalidEvidenceError("configured file bindings are invalid", err)
	}
	releaseBindings, serviceHost, err := bindReleaseBinding(e.release, e.manifest, fileIndex)
	if err != nil {
		return invalidEvidenceError("compiled release bindings are invalid", err)
	}
	expectedBindings = append(expectedBindings, releaseBindings...)
	if !sameFileBindings(expectedBindings, e.bindings) {
		return invalidEvidenceError("stored file bindings differ from recomposed bindings", nil)
	}
	if !validSHA256(e.release.signerPin) ||
		subtle.ConstantTimeCompare(
			[]byte(e.release.signerPin),
			[]byte(e.control.Configuration.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256),
		) != 1 ||
		subtle.ConstantTimeCompare(
			[]byte(e.release.signerPin),
			[]byte(e.executor.Configuration.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256),
		) != 1 ||
		e.manifest.SHA256 != e.control.Configuration.Installation.ManifestSHA256 ||
		e.manifest.SHA256 != e.executor.Configuration.Installation.ManifestSHA256 ||
		e.manifest.Manifest.ReleaseID != e.control.Configuration.Installation.ReleaseID ||
		e.manifest.Manifest.Compatibility != CompiledCompatibility() {
		return invalidEvidenceError("release or signer binding is inconsistent", nil)
	}
	current := e.control.Configuration
	peer := e.executor.Configuration
	if e.role == config.RoleExecutor {
		current, peer = peer, current
	}
	if e.identity.ProcessID == 0 || e.identity.OwnService.Name != current.OwnService.Name ||
		e.identity.OwnService.SID != current.OwnService.SID ||
		e.identity.PeerService.Name != peer.OwnService.Name || e.identity.PeerService.SID != peer.OwnService.SID {
		return invalidEvidenceError("service identity evidence differs from the selected configuration", nil)
	}
	if err := validateBootstrapBinding(
		e.bootstrap,
		e.role,
		e.control.Configuration,
		e.executor.Configuration,
		e.identity,
	); err != nil {
		return invalidEvidenceError("service bootstrap binding is invalid", err)
	}
	if err := validateCurrentImageBinding(e.currentImage, e.bootstrap, e.identity.ProcessID, serviceHost); err != nil {
		return invalidEvidenceError("current ServiceHost image binding is invalid", err)
	}
	if err := validateDataRootBinding(e.dataRoot, e.role, e.control.Configuration, e.executor.Configuration, roots); err != nil {
		return invalidEvidenceError("data-root binding is invalid", err)
	}
	if _, err := validateRuntimeContents(
		e.role,
		e.control.Configuration,
		e.executor.Configuration,
		e.contents,
		e.bindings,
	); err != nil {
		return invalidEvidenceError("runtime content binding is invalid", err)
	}
	if e.role == config.RoleControl {
		if e.controlCredentials == nil || !e.controlCredentials.bound || !e.controlCredentials.attested {
			return invalidEvidenceError("Control credential evidence is absent", nil)
		}
		if localCredentialFactsFrom(e.controlCredentials.localAuthority) != e.controlCredentials.localFacts ||
			mtlsCredentialFactsFrom(e.controlCredentials.mtls) != e.controlCredentials.mtlsFacts {
			return invalidEvidenceError("stored credential attestations differ from their bound facts", nil)
		}
		if err := validateControlCredentialFacts(
			e.control.Configuration,
			e.controlCredentials.localFacts,
			e.controlCredentials.mtlsFacts,
		); err != nil {
			return invalidEvidenceError("Control credential attestation is inconsistent", err)
		}
	} else if e.controlCredentials != nil || len(e.contents) != 2 {
		return invalidEvidenceError("Executor evidence contains forbidden Control material or wrong content", nil)
	}
	computed, err := digestEvidence(e)
	if err != nil || computed != e.digest {
		return invalidEvidenceError("preflight evidence digest is inconsistent", err)
	}
	return nil
}

func sameFileBindings(left []FileBindingEvidence, right []FileBindingEvidence) bool {
	if len(left) != len(right) {
		return false
	}
	for index, expected := range left {
		observed := right[index]
		if expected.Purpose != observed.Purpose || expected.Manifest != observed.Manifest ||
			expected.VerifiedFile.Root != observed.VerifiedFile.Root ||
			expected.VerifiedFile.Path != observed.VerifiedFile.Path ||
			expected.VerifiedFile.AbsolutePath != observed.VerifiedFile.AbsolutePath ||
			expected.VerifiedFile.Role != observed.VerifiedFile.Role ||
			expected.VerifiedFile.SHA256 != observed.VerifiedFile.SHA256 ||
			expected.VerifiedFile.Size != observed.VerifiedFile.Size ||
			!sameObjectEvidence(expected.VerifiedFile.Object, observed.VerifiedFile.Object) {
			return false
		}
	}
	return true
}

// Digest returns the deterministic digest of this immutable evidence.
func (e Evidence) Digest() ([32]byte, error) {
	if err := e.Validate(); err != nil {
		return [32]byte{}, err
	}
	return e.digest, nil
}

func (e Evidence) runtimePlan() (RuntimePlan, error) {
	if err := e.Validate(); err != nil {
		return RuntimePlan{}, err
	}
	configuration := e.Configuration()
	plan := RuntimePlan{
		role: e.role, configuration: configuration, preflightDigest: e.digest,
		dataRootDigest:  e.dataRoot.digest,
		node:            PinnedRuntimeFile{path: configuration.Node.ExecutablePath, sha256: configuration.Node.ExecutableSHA256},
		bundle:          PinnedRuntimeFile{path: configuration.Node.BundlePath, sha256: configuration.Node.BundleSHA256},
		runtimeContents: cloneRuntimeContents(e.contents), valid: true,
	}
	if e.role == config.RoleExecutor {
		processHost := PinnedRuntimeFile{
			path:   configuration.Executor.ProcessHostPath,
			sha256: configuration.Executor.ProcessHostSHA256,
		}
		plan.processHost = &processHost
	}
	if err := plan.Validate(); err != nil {
		return RuntimePlan{}, err
	}
	return plan, nil
}

// Validate rejects a zero or internally inconsistent role-local plan.
func (plan RuntimePlan) Validate() error {
	if !plan.valid || plan.preflightDigest == ([32]byte{}) || plan.dataRootDigest == ([32]byte{}) ||
		plan.role != config.RoleControl && plan.role != config.RoleExecutor {
		return invalidEvidenceError("runtime plan is empty or incomplete", nil)
	}
	if err := plan.configuration.Validate(); err != nil || plan.configuration.Role != plan.role {
		return invalidEvidenceError("runtime plan configuration is invalid", err)
	}
	if plan.node.path != plan.configuration.Node.ExecutablePath ||
		plan.node.sha256 != plan.configuration.Node.ExecutableSHA256 ||
		plan.bundle.path != plan.configuration.Node.BundlePath ||
		plan.bundle.sha256 != plan.configuration.Node.BundleSHA256 {
		return invalidEvidenceError("runtime plan Node pins are inconsistent", nil)
	}
	if plan.role == config.RoleControl {
		if plan.processHost != nil || len(plan.runtimeContents) != 1 ||
			plan.runtimeContents[0].role != releasemanifest.RoleCABundle {
			return invalidEvidenceError("Control runtime plan contains peer material", nil)
		}
	} else if plan.processHost == nil || plan.configuration.Executor == nil ||
		plan.processHost.path != plan.configuration.Executor.ProcessHostPath ||
		plan.processHost.sha256 != plan.configuration.Executor.ProcessHostSHA256 ||
		len(plan.runtimeContents) != 2 {
		return invalidEvidenceError("Executor runtime plan is incomplete", nil)
	}
	return nil
}

func digestEvidence(e Evidence) ([32]byte, error) {
	controlDocument, err := config.MarshalCanonical(e.control.Configuration)
	if err != nil {
		return [32]byte{}, err
	}
	executorDocument, err := config.MarshalCanonical(e.executor.Configuration)
	if err != nil {
		return [32]byte{}, err
	}
	manifestDocument, err := releasemanifest.MarshalCanonical(e.manifest.Manifest)
	if err != nil {
		return [32]byte{}, err
	}
	encoder := preflightDigestEncoder{hash: sha256.New()}
	encoder.text("agentic-review/service-host-preflight-evidence/v3")
	encoder.text(string(e.role))
	encoder.text(e.actualBootstrapPath)
	encodeConfigurationEvidence(&encoder, e.control, controlDocument)
	encodeConfigurationEvidence(&encoder, e.executor, executorDocument)
	encoder.bytes(manifestDocument)
	encoder.text(e.manifest.SHA256)
	encodeSecureRead(&encoder, e.manifest.Read)
	encodeReleaseBinding(&encoder, e.release)
	encoder.u64(uint64(len(e.roots)))
	for _, root := range e.roots {
		encoder.text(string(root.Root))
		encoder.text(root.Path)
		encodeObjectIdentity(&encoder, root.Object)
		encoder.u64(uint64(len(root.Ancestors)))
		for _, ancestor := range root.Ancestors {
			encodeObjectIdentity(&encoder, ancestor)
		}
	}
	encoder.u64(uint64(len(e.files)))
	for _, file := range e.files {
		encodeVerifiedFile(&encoder, file)
	}
	encoder.u64(uint64(len(e.bindings)))
	for _, binding := range e.bindings {
		encoder.text(binding.Purpose)
		encoder.text(binding.Manifest.ReleaseID)
		encoder.text(binding.Manifest.ManifestSHA256)
		encoder.u32(binding.Manifest.SchemaVersion)
		encodeCompatibility(&encoder, binding.Manifest.Compatibility)
		encodeManifestFile(&encoder, binding.Manifest.File)
		encodeVerifiedFile(&encoder, binding.VerifiedFile)
	}
	encodeIdentityEvidence(&encoder, e.identity)
	encodeBootstrapBinding(&encoder, e.bootstrap)
	encodeCurrentImageBinding(&encoder, e.currentImage)
	encoder.text(string(e.dataRoot.role))
	encoder.text(e.dataRoot.currentPath)
	encoder.text(e.dataRoot.peerPath)
	encoder.text(string(e.dataRoot.peerObservation))
	encoder.u64(uint64(len(e.dataRoot.installationRoots)))
	for _, root := range e.dataRoot.installationRoots {
		encoder.text(string(root.root))
		encoder.text(root.path)
		encodeFileIdentity(&encoder, root.target)
		encoder.u64(uint64(len(root.ancestorPaths)))
		for _, path := range root.ancestorPaths {
			encoder.text(path)
		}
		encoder.u64(uint64(len(root.ancestors)))
		for _, ancestor := range root.ancestors {
			encodeFileIdentity(&encoder, ancestor)
		}
	}
	encoder.bytes(e.dataRoot.digest[:])
	if e.controlCredentials == nil {
		encoder.boolean(false)
	} else {
		encoder.boolean(true)
		encodeControlCredentials(&encoder, *e.controlCredentials)
	}
	encoder.u64(uint64(len(e.contents)))
	for _, content := range e.contents {
		encoder.text(string(content.root))
		encoder.text(content.path)
		encoder.text(content.absolutePath)
		encoder.text(string(content.role))
		encoder.text(content.sha256)
		encoder.u64(content.size)
		encodeObjectIdentity(&encoder, content.object)
		encoder.bytes(content.data)
	}
	var result [32]byte
	copy(result[:], encoder.hash.Sum(nil))
	return result, nil
}

func encodeBootstrapBinding(encoder *preflightDigestEncoder, binding BootstrapBinding) {
	encoder.text(string(binding.role))
	encoder.text(binding.ownServiceName)
	encoder.text(binding.ownServiceSID)
	encoder.text(binding.peerServiceName)
	encoder.text(binding.peerServiceSID)
	encodeStableProcessFacts(encoder, binding.serviceHostFacts)
	encoder.bytes(binding.sourceDigest[:])
}

func encodeReleaseBinding(encoder *preflightDigestEncoder, binding releaseBindingSnapshot) {
	encoder.bytes(binding.templateDigest[:])
	encoder.text(binding.manifestSHA256)
	encoder.u32(binding.templateSchemaVersion)
	encoder.text(binding.profileID)
	encoder.text(binding.releaseID)
	encodeCompatibility(encoder, binding.compatibility)
	encoder.text(binding.signerPin)
	encoder.u64(uint64(len(binding.dependencies)))
	for _, dependency := range binding.dependencies {
		encodeManifestFile(encoder, dependency)
	}
	encodeManifestFile(encoder, binding.serviceHost)
}

func encodeCurrentImageBinding(encoder *preflightDigestEncoder, binding CurrentImageBinding) {
	encoder.bytes(binding.sourceDigest[:])
	encoder.bytes(binding.bootstrapDigest[:])
	encodeStableProcessFacts(encoder, binding.processFacts)
	encoder.text(binding.processPath)
	encoder.u64(binding.identity.VolumeSerialNumber)
	encoder.bytes(binding.identity.FileID[:])
	encoder.u64(binding.size)
	encoder.bytes(binding.sha256[:])
}

func encodeStableProcessFacts(encoder *preflightDigestEncoder, facts peerverify.StableProcessFacts) {
	encoder.u32(facts.ProcessID)
	encoder.i64(facts.CreationTime.Unix())
	encoder.u32(uint32(facts.CreationTime.Nanosecond()))
	encoder.boolean(facts.StartKey.Available)
	encoder.u64(facts.StartKey.SequenceNumber)
}

func encodeIdentityEvidence(encoder *preflightDigestEncoder, evidence winidentity.Evidence) {
	encoder.u32(evidence.ProcessID)
	encodeServiceEvidence(encoder, evidence.OwnService)
	encodeServiceEvidence(encoder, evidence.PeerService)
	token := evidence.Token
	encodeLUID(encoder, token.TokenID)
	encodeLUID(encoder, token.AuthenticationID)
	encodeLUID(encoder, token.ModifiedID)
	encoder.u32(token.Type)
	encoder.u32(token.ImpersonationLevel)
	encoder.boolean(token.HasRestrictions)
	encodeSIDEntry(encoder, token.User)
	encoder.u64(uint64(len(token.Groups)))
	for _, entry := range token.Groups {
		encodeSIDEntry(encoder, entry)
	}
	encoder.u64(uint64(len(token.RestrictedSIDs)))
	for _, entry := range token.RestrictedSIDs {
		encodeSIDEntry(encoder, entry)
	}
	encoder.u64(uint64(len(token.Privileges)))
	for _, privilege := range token.Privileges {
		encoder.text(privilege.Name)
		encodeLUID(encoder, privilege.LUID)
		encoder.u32(privilege.Attributes)
	}
}

func encodeServiceEvidence(encoder *preflightDigestEncoder, evidence winidentity.ServiceEvidence) {
	encoder.text(evidence.Name)
	encoder.text(evidence.SID)
	encoder.u32(uint32(evidence.SIDType))
	encoder.u32(evidence.ServiceType)
	encoder.text(evidence.StartAccount)
	encoder.text(evidence.Domain)
	encoder.u32(evidence.AccountType)
}

func encodeLUID(encoder *preflightDigestEncoder, value winidentity.LUID) {
	encoder.u32(value.LowPart)
	encoder.u32(uint32(value.HighPart))
}

func encodeSIDEntry(encoder *preflightDigestEncoder, entry winidentity.SIDEntry) {
	encoder.text(entry.SID)
	encoder.u32(entry.Attributes)
}

func encodeCompatibility(encoder *preflightDigestEncoder, value releasemanifest.Compatibility) {
	encoder.text(value.WorkerAPIProtocolVersion)
	encoder.u32(value.LocalProtocolMajor)
	encoder.u32(value.LocalProtocolMinimumMinor)
	encoder.u32(value.LocalProtocolMaximumMinor)
	encoder.u32(value.ServiceHostRPCVersion)
	encoder.u32(value.ProcessHostProtocolVersion)
}

func encodeConfigurationEvidence(
	encoder *preflightDigestEncoder,
	evidence ConfigurationEvidence,
	document []byte,
) {
	encoder.bytes(document)
	encoder.text(string(evidence.Binding.Kind))
	encoder.text(string(evidence.Binding.Root))
	encoder.text(evidence.Binding.Path)
	encoder.text(evidence.Binding.SHA256)
	encoder.text(evidence.Binding.Size)
	encodeSecureRead(encoder, evidence.Read)
}

func encodeSecureRead(encoder *preflightDigestEncoder, read secureconfig.Result) {
	encoder.bytes(read.ContentSHA256[:])
	encoder.bytes(read.Data)
	encoder.u64(read.File.Evidence.Size)
	encodeObjectIdentity(encoder, read.File)
	encoder.u64(uint64(len(read.Ancestors)))
	for _, ancestor := range read.Ancestors {
		encodeObjectIdentity(encoder, ancestor)
	}
}

func encodeControlCredentials(encoder *preflightDigestEncoder, evidence ControlCredentialEvidence) {
	local := evidence.localFacts
	encoder.text(local.keyName)
	encoder.digest(local.keySecurityDescriptor)
	encodeKeyIdentity(encoder, local.identity)
	encoder.digest(local.publicKeySPKI)
	encoder.text(local.validatedControlServiceSID)
	encoder.text(local.validatedExecutorSID)
	encoder.text(local.algorithm)
	encoder.u32(local.keyLengthBits)
	encoder.u32(local.exportPolicy)
	encoder.u32(local.keyUsage)
	mtls := evidence.mtlsFacts
	encoder.text(mtls.storeScope)
	encoder.text(mtls.storeName)
	encoder.digest(mtls.certificateDER)
	encoder.text(mtls.containerName)
	encoder.text(mtls.keyName)
	encoder.digest(mtls.keySecurityDescriptor)
	encodeKeyIdentity(encoder, mtls.identity)
	encoder.digest(mtls.publicKeySPKI)
	encoder.text(mtls.validatedControlServiceSID)
	encoder.text(mtls.validatedExecutorSID)
	encoder.text(mtls.algorithm)
	encoder.u32(mtls.keyLengthBits)
	encoder.u32(mtls.exportPolicy)
	encoder.u32(mtls.keyUsage)
}

func encodeManifestFile(encoder *preflightDigestEncoder, file releasemanifest.File) {
	encoder.text(string(file.Root))
	encoder.text(file.Path)
	encoder.text(string(file.Role))
	encoder.text(file.SHA256)
	encoder.text(file.Size)
}

func encodeVerifiedFile(encoder *preflightDigestEncoder, file VerifiedFile) {
	encoder.text(string(file.Root))
	encoder.text(file.Path)
	encoder.text(file.AbsolutePath)
	encoder.text(string(file.Role))
	encoder.text(file.SHA256)
	encoder.u64(file.Size)
	encodeObjectIdentity(encoder, file.Object)
}

func encodeObjectIdentity(encoder *preflightDigestEncoder, object secureconfig.ObjectEvidence) {
	encoder.text(object.Path)
	encoder.u64(object.Evidence.Identity.VolumeSerialNumber)
	encoder.bytes(object.Evidence.Identity.FileID[:])
	encoder.bytes(object.EvidenceSHA256[:])
	encoder.bytes(object.SecurityDescriptorSHA256[:])
}

func encodeKeyIdentity(encoder *preflightDigestEncoder, identity cng.KeyIdentity) {
	encoder.text(identity.ProviderName)
	encoder.text(identity.UniqueName)
	encoder.boolean(identity.MachineKey)
}

func encodeFileIdentity(encoder *preflightDigestEncoder, identity winfile.FileIdentity) {
	encoder.u64(identity.VolumeSerialNumber)
	encoder.bytes(identity.FileID[:])
}

type preflightDigestEncoder struct{ hash hash.Hash }

func (encoder *preflightDigestEncoder) u32(value uint32) {
	var buffer [4]byte
	binary.LittleEndian.PutUint32(buffer[:], value)
	_, _ = encoder.hash.Write(buffer[:])
}

func (encoder *preflightDigestEncoder) u64(value uint64) {
	var buffer [8]byte
	binary.LittleEndian.PutUint64(buffer[:], value)
	_, _ = encoder.hash.Write(buffer[:])
}

func (encoder *preflightDigestEncoder) i64(value int64) { encoder.u64(uint64(value)) }

func (encoder *preflightDigestEncoder) bytes(value []byte) {
	encoder.u64(uint64(len(value)))
	_, _ = encoder.hash.Write(value)
}

func (encoder *preflightDigestEncoder) digest(value [32]byte) { encoder.bytes(value[:]) }

func (encoder *preflightDigestEncoder) text(value string) { encoder.bytes([]byte(value)) }

func (encoder *preflightDigestEncoder) boolean(value bool) {
	if value {
		encoder.u32(1)
		return
	}
	encoder.u32(0)
}

func invalidEvidenceError(message string, cause error) error {
	return preflightError(ErrorEvidence, message, errors.Join(ErrInvalidEvidence, cause))
}
