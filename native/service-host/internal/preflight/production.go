package preflight

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/cng"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installverify"
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
	})
}

func captureInstallationSnapshot(evidence installverify.Evidence) *installationSnapshot {
	roots := evidence.Roots()
	rootSnapshots := make([]VerifiedRoot, len(roots))
	for index, root := range roots {
		rootSnapshots[index] = VerifiedRoot{
			Root: root.Root(), Path: root.Path(), Object: root.Object(),
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
		roots:               rootSnapshots,
		files:               fileSnapshots,
		approvedSignerPin:   evidence.ApprovedSignerCertificateDERSHA256(),
	}
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
	if err := validateControlCredentialFacts(
		configuration,
		localCredentialFactsFrom(localAttestation),
		mtlsCredentialFactsFrom(mtlsAttestation),
	); err != nil {
		return ControlCredentialEvidence{}, err
	}
	return ControlCredentialEvidence{
		localAuthority: localAttestation,
		mtls:           mtlsAttestation,
		bound:          true,
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
}

func localCredentialFactsFrom(attestation cng.Attestation) localCredentialFacts {
	return localCredentialFacts{
		keyName:                    attestation.KeyName(),
		keySecurityDescriptor:      attestation.KeySecurityDescriptorSHA256(),
		identity:                   attestation.KeyIdentity(),
		publicKeySPKI:              attestation.PublicKeySPKISHA256(),
		validatedControlServiceSID: attestation.ValidatedControlServiceSID(),
		validatedExecutorSID:       attestation.ValidatedExecutorServiceSID(),
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
