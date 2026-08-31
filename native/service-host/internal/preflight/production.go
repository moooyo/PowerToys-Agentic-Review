package preflight

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"reflect"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/cng"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/dataroot"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/wincert"
)

// Compose validates opaque installation evidence, binds any role-specific live
// credentials, and then delegates to the side-effect-free snapshot composer.
func Compose(input Input) (Evidence, error) {
	if err := input.Installation.Validate(); err != nil {
		return Evidence{}, preflightError(ErrorInstallation, "installation evidence is invalid", err)
	}
	installation := captureInstallationSnapshot(input.Installation)
	if input.Role != installation.role ||
		!windowsPathEqual(input.ActualBootstrapPath, installation.actualBootstrapPath) {
		return Evidence{}, preflightError(ErrorInput, "preflight selectors do not match installation evidence", nil)
	}
	dataRoot, err := captureDataRootBinding(input.DataRoot, installation)
	if err != nil {
		return Evidence{}, err
	}
	contents, err := captureRuntimeContents(input.Installation, installation)
	if err != nil {
		return Evidence{}, err
	}
	installation.contents = cloneRuntimeContents(contents)
	credentials, err := bindRoleCredentials(
		input.Role,
		installation.controlConfig,
		input.LocalAuthoritySigner,
		input.MTLSCredential,
	)
	if err != nil {
		return Evidence{}, err
	}
	return composeSnapshots(snapshotInput{
		role:                input.Role,
		actualBootstrapPath: input.ActualBootstrapPath,
		installation:        installation,
		releaseProfile:      cloneProfile(input.ReleaseProfile),
		credentials:         credentials,
		dataRoot:            dataRoot,
	})
}

func captureInstallationSnapshot(evidence installverify.Evidence) *installationSnapshot {
	roots := evidence.Roots()
	rootSnapshots := make([]VerifiedRoot, len(roots))
	for index, root := range roots {
		rootSnapshots[index] = VerifiedRoot{
			Root: root.Root(), Path: root.Path(), Ancestors: root.Ancestors(), Object: root.Object(),
		}
	}
	files := evidence.Files()
	fileSnapshots := make([]VerifiedFile, len(files))
	for index, file := range files {
		fileSnapshots[index] = VerifiedFile{
			Root: file.Root(), Path: file.Path(), AbsolutePath: file.AbsolutePath(),
			Role: file.Role(), SHA256: file.SHA256(), Size: file.Size(), Object: file.Object(),
		}
	}
	return &installationSnapshot{
		role:                evidence.Role(),
		actualBootstrapPath: evidence.ActualBootstrapPath(),
		controlBootstrap:    evidence.ControlBootstrap(),
		executorBootstrap:   evidence.ExecutorBootstrap(),
		controlConfig:       evidence.ControlConfiguration(),
		executorConfig:      evidence.ExecutorConfiguration(),
		manifestRead:        evidence.ManifestRead(),
		manifest:            evidence.Manifest(),
		identity:            evidence.Identity(),
		roots:               rootSnapshots,
		files:               fileSnapshots,
		approvedSignerPin:   evidence.ApprovedSignerCertificateDERSHA256(),
	}
}

func captureDataRootBinding(
	evidence dataroot.Evidence,
	installation *installationSnapshot,
) (DataRootBinding, error) {
	if err := evidence.Validate(); err != nil {
		return DataRootBinding{}, preflightError(ErrorDataRoot, "data-root evidence is zero, closed, or invalid", err)
	}
	digest, err := evidence.Digest()
	if err != nil || digest == ([32]byte{}) {
		return DataRootBinding{}, preflightError(ErrorDataRoot, "data-root evidence digest is unavailable", err)
	}
	return validateDataRootFacts(dataRootFacts{
		role: evidence.Role(), current: evidence.CurrentConfiguration(), peer: evidence.PeerConfiguration(),
		currentPath: evidence.DataRoot().Path(), peerPath: evidence.PeerDataRootPath(),
		peerObservation:   evidence.PeerRootObservation(),
		installationRoots: captureDataRootInstallationBindings(evidence.InstallationRoots()),
		digest:            digest,
	}, installation)
}

type dataRootFacts struct {
	role              config.Role
	current           config.Config
	peer              config.Config
	currentPath       string
	peerPath          string
	peerObservation   dataroot.PeerRootObservation
	installationRoots []dataRootInstallationBinding
	digest            [32]byte
}

func validateDataRootFacts(facts dataRootFacts, installation *installationSnapshot) (DataRootBinding, error) {
	role := facts.role
	current := facts.current
	peer := facts.peer
	expectedCurrent := installation.controlConfig
	expectedPeer := installation.executorConfig
	if role == config.RoleExecutor {
		expectedCurrent, expectedPeer = expectedPeer, expectedCurrent
	}
	if facts.digest == ([32]byte{}) || role != installation.role || !reflect.DeepEqual(current, expectedCurrent) ||
		!reflect.DeepEqual(peer, expectedPeer) {
		return DataRootBinding{}, preflightError(ErrorDataRoot, "data-root role or configurations differ from installation evidence", nil)
	}
	if facts.peerObservation != dataroot.PeerLiveRootNotObservedByDesign ||
		facts.currentPath != current.Node.DataRoot || facts.peerPath != peer.Node.DataRoot {
		return DataRootBinding{}, preflightError(ErrorDataRoot, "data-root observation semantics or paths are invalid", nil)
	}
	if err := validateDataRootInstallationBindings(facts.installationRoots, installation.roots); err != nil {
		return DataRootBinding{}, err
	}
	return cloneDataRootBinding(DataRootBinding{
		role: role, currentPath: current.Node.DataRoot, peerPath: peer.Node.DataRoot,
		peerObservation:   dataroot.PeerLiveRootNotObservedByDesign,
		installationRoots: facts.installationRoots,
		digest:            facts.digest, bound: true,
	}), nil
}

func captureDataRootInstallationBindings(
	values []dataroot.InstallationRootBinding,
) []dataRootInstallationBinding {
	result := make([]dataRootInstallationBinding, len(values))
	for index, value := range values {
		result[index] = dataRootInstallationBinding{
			root: value.Root(), path: value.Path(), ancestorPaths: value.AncestorPaths(),
			ancestors: value.Ancestors(), target: value.Target(),
		}
	}
	return result
}

func validateDataRootInstallationBindings(
	observed []dataRootInstallationBinding,
	expected []VerifiedRoot,
) error {
	if len(observed) != len(expected) || len(expected) != 2 {
		return preflightError(ErrorDataRoot, "data-root installation-root binding count is invalid", nil)
	}
	for index, root := range expected {
		binding := observed[index]
		if binding.root != root.Root || binding.path != root.Path ||
			binding.target != root.Object.Evidence.Identity ||
			len(binding.ancestorPaths) != len(root.Ancestors) ||
			len(binding.ancestors) != len(root.Ancestors) {
			return preflightError(ErrorDataRoot, "data-root installation-root target differs from installation evidence", nil)
		}
		for ancestorIndex, ancestor := range root.Ancestors {
			if binding.ancestorPaths[ancestorIndex] != ancestor.Path ||
				binding.ancestors[ancestorIndex] != ancestor.Evidence.Identity {
				return preflightError(ErrorDataRoot, "data-root installation-root ancestor chain differs from installation evidence", nil)
			}
		}
	}
	return nil
}

type runtimeContentTarget struct {
	path   string
	role   releasemanifest.FileRole
	sha256 string
}

func captureRuntimeContents(
	evidence installverify.Evidence,
	installation *installationSnapshot,
) ([]VerifiedRuntimeContent, error) {
	targets, err := runtimeContentTargetsFor(
		installation.role,
		installation.controlConfig,
		installation.executorConfig,
	)
	if err != nil {
		return nil, err
	}
	result := make([]VerifiedRuntimeContent, 0, len(targets))
	trustedRoot := installation.controlConfig.Installation.TrustedConfigurationRoot
	for _, target := range targets {
		relative, err := ManifestRelativePath(trustedRoot, target.path)
		if err != nil {
			return nil, preflightError(ErrorRuntimeContent, "runtime content path is outside the trusted root", err)
		}
		content, err := evidence.VerifiedContent(releasemanifest.RootTrustedConfiguration, relative)
		if err != nil || content.Validate() != nil {
			return nil, preflightError(ErrorRuntimeContent, "required opaque runtime content is unavailable", err)
		}
		result = append(result, VerifiedRuntimeContent{
			root: content.Root(), path: content.Path(), absolutePath: content.AbsolutePath(),
			role: content.Role(), sha256: content.SHA256(), size: content.Size(),
			object: content.Object(), data: content.Bytes(),
		})
	}
	return result, nil
}

// BindControlCredentials obtains atomic attestations from the concrete live
// objects and binds every configured certificate and key input.
func BindControlCredentials(
	configuration config.Config,
	localAuthority *cng.Signer,
	mtls *wincert.Credential,
) (ControlCredentialEvidence, error) {
	if err := configuration.Validate(); err != nil ||
		configuration.Role != config.RoleControl || configuration.Control == nil {
		return ControlCredentialEvidence{}, preflightError(
			ErrorCredentialIdentity,
			"Control credential binding requires a valid Control configuration",
			err,
		)
	}
	if localAuthority == nil || mtls == nil {
		return ControlCredentialEvidence{}, preflightError(
			ErrorCredentialIdentity,
			"Control credential binding requires both live credential objects",
			nil,
		)
	}
	localAttestation, err := localAuthority.Attestation()
	if err != nil {
		return ControlCredentialEvidence{}, preflightError(ErrorCredentialIdentity, "read local-authority attestation", err)
	}
	mtlsAttestation, err := mtls.Attestation()
	if err != nil {
		return ControlCredentialEvidence{}, preflightError(ErrorCredentialIdentity, "read mTLS attestation", err)
	}
	localFacts := localCredentialFactsFrom(localAttestation)
	mtlsFacts := mtlsCredentialFactsFrom(mtlsAttestation)
	if err := validateControlCredentialFacts(configuration, localFacts, mtlsFacts); err != nil {
		return ControlCredentialEvidence{}, err
	}
	return ControlCredentialEvidence{
		localAuthority: localAttestation,
		mtls:           mtlsAttestation,
		localFacts:     localFacts,
		mtlsFacts:      mtlsFacts,
		bound:          true,
		attested:       true,
	}, nil
}

func bindRoleCredentials(
	role config.Role,
	controlConfig config.Config,
	localAuthority *cng.Signer,
	mtls *wincert.Credential,
) (*ControlCredentialEvidence, error) {
	if role == config.RoleExecutor {
		if localAuthority != nil || mtls != nil {
			return nil, preflightError(
				ErrorCredentialIdentity,
				"Executor preflight must not receive Control credential objects",
				nil,
			)
		}
		return nil, nil
	}
	evidence, err := BindControlCredentials(controlConfig, localAuthority, mtls)
	if err != nil {
		return nil, err
	}
	return &evidence, nil
}

type localCredentialFacts struct {
	keyName                    string
	keySecurityDescriptor      [sha256.Size]byte
	identity                   cng.KeyIdentity
	publicKeySPKI              [sha256.Size]byte
	validatedControlServiceSID string
	validatedExecutorSID       string
	algorithm                  string
	keyLengthBits              uint32
	exportPolicy               uint32
	keyUsage                   uint32
}

type mtlsCredentialFacts struct {
	storeScope                 string
	storeName                  string
	certificateDER             [sha256.Size]byte
	keySecurityDescriptor      [sha256.Size]byte
	identity                   cng.KeyIdentity
	publicKeySPKI              [sha256.Size]byte
	validatedControlServiceSID string
	validatedExecutorSID       string
	containerName              string
	keyName                    string
	algorithm                  string
	keyLengthBits              uint32
	exportPolicy               uint32
	keyUsage                   uint32
}

func localCredentialFactsFrom(attestation cng.Attestation) localCredentialFacts {
	return localCredentialFacts{
		keyName:                    attestation.KeyName(),
		keySecurityDescriptor:      attestation.KeySecurityDescriptorSHA256(),
		identity:                   attestation.KeyIdentity(),
		publicKeySPKI:              attestation.PublicKeySPKISHA256(),
		validatedControlServiceSID: attestation.ValidatedControlServiceSID(),
		validatedExecutorSID:       attestation.ValidatedExecutorServiceSID(),
		algorithm:                  attestation.Algorithm(),
		keyLengthBits:              attestation.KeyLengthBits(),
		exportPolicy:               attestation.ExportPolicy(),
		keyUsage:                   attestation.KeyUsage(),
	}
}

func mtlsCredentialFactsFrom(attestation wincert.Attestation) mtlsCredentialFacts {
	return mtlsCredentialFacts{
		storeScope:                 attestation.StoreScope(),
		storeName:                  attestation.StoreName(),
		certificateDER:             attestation.CertificateDERSHA256(),
		keySecurityDescriptor:      attestation.KeySecurityDescriptorSHA256(),
		identity:                   attestation.KeyIdentity(),
		publicKeySPKI:              attestation.PublicKeySPKISHA256(),
		validatedControlServiceSID: attestation.ValidatedControlServiceSID(),
		validatedExecutorSID:       attestation.ValidatedExecutorServiceSID(),
		containerName:              attestation.ContainerName(),
		keyName:                    attestation.KeyName(),
		algorithm:                  attestation.Algorithm(),
		keyLengthBits:              attestation.KeyLengthBits(),
		exportPolicy:               attestation.ExportPolicy(),
		keyUsage:                   attestation.KeyUsage(),
	}
}

func validateControlCredentialFacts(
	configuration config.Config,
	local localCredentialFacts,
	mtls mtlsCredentialFacts,
) error {
	control := configuration.Control
	if control == nil {
		return preflightError(ErrorCredentialIdentity, "Control credential configuration is absent", nil)
	}
	if local.keyName != control.LocalAuthorityCNGKeyName ||
		!digestMatchesHex(local.keySecurityDescriptor, control.LocalAuthorityKeySecurityDescriptorSHA256) ||
		!digestMatchesHex(local.publicKeySPKI, control.LocalAuthorityPublicKeySHA256) {
		return preflightError(ErrorCredentialIdentity, "local-authority attestation differs from configuration", nil)
	}
	if mtls.storeScope != wincert.LocalMachineStoreScope ||
		mtls.storeName != control.ClientCertificateStore ||
		!digestMatchesHex(mtls.certificateDER, control.ClientCertificateDERSHA256) ||
		!digestMatchesHex(mtls.keySecurityDescriptor, control.ClientPrivateKeySecurityDescriptorSHA256) {
		return preflightError(ErrorCredentialIdentity, "mTLS attestation differs from configuration", nil)
	}
	for _, observed := range []struct {
		control  string
		executor string
	}{
		{local.validatedControlServiceSID, local.validatedExecutorSID},
		{mtls.validatedControlServiceSID, mtls.validatedExecutorSID},
	} {
		if observed.control != configuration.OwnService.SID ||
			observed.executor != configuration.PeerService.SID {
			return preflightError(ErrorCredentialIdentity, "credential attestation used different service SID inputs", nil)
		}
	}
	if !validCredentialIdentity(local.identity) || !validCredentialIdentity(mtls.identity) {
		return preflightError(ErrorCredentialIdentity, "credential attestation contains an invalid key identity", nil)
	}
	if local.algorithm != "ECDSA_P256" || local.keyLengthBits != 256 || local.exportPolicy != 0 || local.keyUsage != 2 ||
		mtls.containerName == "" || mtls.keyName != mtls.containerName || mtls.algorithm != "ECDSA_P256" ||
		mtls.keyLengthBits != 256 || mtls.exportPolicy != 0 || mtls.keyUsage != 2 {
		return preflightError(ErrorCredentialIdentity, "credential attestation key properties are invalid", nil)
	}
	if local.identity == mtls.identity {
		return preflightError(ErrorCredentialIdentity, "mTLS and local-authority keys reuse one CNG identity", nil)
	}
	if local.publicKeySPKI == ([sha256.Size]byte{}) || mtls.publicKeySPKI == ([sha256.Size]byte{}) ||
		subtle.ConstantTimeCompare(local.publicKeySPKI[:], mtls.publicKeySPKI[:]) == 1 {
		return preflightError(ErrorCredentialIdentity, "mTLS and local-authority keys reuse one public key", nil)
	}
	return nil
}

func validCredentialIdentity(identity cng.KeyIdentity) bool {
	return identity.ProviderName == ApprovedCNGProvider && identity.UniqueName != "" && identity.MachineKey
}

func digestMatchesHex(actual [sha256.Size]byte, expected string) bool {
	decoded, err := hex.DecodeString(expected)
	return err == nil && len(decoded) == sha256.Size && subtle.ConstantTimeCompare(actual[:], decoded) == 1
}
