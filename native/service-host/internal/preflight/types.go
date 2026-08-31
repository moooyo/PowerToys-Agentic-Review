package preflight

import (
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/cng"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/wincert"
)

const (
	ProductionProfileID = "static-review-v1"
	ApprovedCNGProvider = "Microsoft Software Key Storage Provider"
)

type ErrorCode string

const (
	ErrorInput              ErrorCode = "PREFLIGHT_INPUT_INVALID"
	ErrorConfiguration      ErrorCode = "PREFLIGHT_CONFIGURATION_INVALID"
	ErrorConfigurationPair  ErrorCode = "PREFLIGHT_CONFIGURATION_PAIR_MISMATCH"
	ErrorBootstrapBinding   ErrorCode = "PREFLIGHT_BOOTSTRAP_BINDING_MISMATCH"
	ErrorInstallation       ErrorCode = "PREFLIGHT_INSTALLATION_EVIDENCE_INVALID"
	ErrorManifest           ErrorCode = "PREFLIGHT_MANIFEST_INVALID"
	ErrorManifestBinding    ErrorCode = "PREFLIGHT_MANIFEST_BINDING_MISMATCH"
	ErrorReleaseProfile     ErrorCode = "PREFLIGHT_RELEASE_PROFILE_INVALID"
	ErrorCompatibility      ErrorCode = "PREFLIGHT_COMPATIBILITY_MISMATCH"
	ErrorCredentialIdentity ErrorCode = "PREFLIGHT_CREDENTIAL_IDENTITY_MISMATCH"
)

type Error struct {
	Code    ErrorCode
	Message string
	Cause   error
}

func (e *Error) Error() string { return e.Message }
func (e *Error) Unwrap() error { return e.Cause }

// VerifiedRoot is a detached root snapshot supplied by an installation
// verifier. Object must describe the root directory itself.
type VerifiedRoot struct {
	Root   releasemanifest.FileRoot
	Path   string
	Object secureconfig.ObjectEvidence
}

// VerifiedFile is a detached stable-file result supplied by an installation
// verifier. SHA256 is the digest computed from the retained file handle.
type VerifiedFile struct {
	Root         releasemanifest.FileRoot
	Path         string
	AbsolutePath string
	Role         releasemanifest.FileRole
	SHA256       string
	Size         uint64
	Object       secureconfig.ObjectEvidence
}

// ReleaseProfile is an independently trusted bill of materials for one
// production workflow. Dependencies must cover every manifest file exactly;
// deriving this value from the manifest would remove its independent value.
type ReleaseProfile struct {
	ID           string
	Dependencies []releasemanifest.FileBindingRequirement
}

// Input accepts only the opaque installation verifier result and concrete live
// credential objects. Executor must leave both credential pointers nil.
type Input struct {
	Role                 config.Role
	ActualBootstrapPath  string
	Installation         installverify.Evidence
	ReleaseProfile       ReleaseProfile
	LocalAuthoritySigner *cng.Signer
	MTLSCredential       *wincert.Credential
}

// ControlCredentialEvidence contains only attestations returned atomically by
// the concrete validated credential objects. Its fields cannot be populated by
// callers, and the values themselves expose only copy-returning accessors.
type ControlCredentialEvidence struct {
	localAuthority cng.Attestation
	mtls           wincert.Attestation
	bound          bool
}

func (e ControlCredentialEvidence) LocalAuthorityAttestation() cng.Attestation {
	return e.localAuthority
}

func (e ControlCredentialEvidence) MTLSAttestation() wincert.Attestation { return e.mtls }

type installationSnapshot struct {
	role                config.Role
	actualBootstrapPath string
	controlBootstrap    secureconfig.Result
	executorBootstrap   secureconfig.Result
	controlConfig       config.Config
	executorConfig      config.Config
	manifestRead        secureconfig.Result
	manifest            releasemanifest.Manifest
	roots               []VerifiedRoot
	files               []VerifiedFile
	approvedSignerPin   string
}

type snapshotInput struct {
	role                config.Role
	actualBootstrapPath string
	installation        *installationSnapshot
	releaseProfile      ReleaseProfile
	credentials         *ControlCredentialEvidence
}

// ConfigurationEvidence binds parsed canonical configuration to the exact
// secure read and fixed bootstrap-file metadata.
type ConfigurationEvidence struct {
	Configuration config.Config
	Read          secureconfig.Result
	Binding       releasemanifest.BootstrapConfigurationEvidence
}

// ManifestEvidence binds the parsed canonical manifest to its exact read.
type ManifestEvidence struct {
	Manifest releasemanifest.Manifest
	Read     secureconfig.Result
	SHA256   string
}

// FileBindingEvidence records why a concrete file is needed and proves that
// both the canonical manifest and opaque installation evidence bind it.
type FileBindingEvidence struct {
	Purpose      string
	Manifest     releasemanifest.FileBindingEvidence
	VerifiedFile VerifiedFile
}

// Evidence has no exported mutable fields. Accessors return detached copies,
// so callers cannot mutate the successful preflight snapshot.
type Evidence struct {
	role                config.Role
	actualBootstrapPath string
	control             ConfigurationEvidence
	executor            ConfigurationEvidence
	manifest            ManifestEvidence
	roots               []VerifiedRoot
	files               []VerifiedFile
	profile             ReleaseProfile
	bindings            []FileBindingEvidence
	approvedSignerPin   string
	controlCredentials  *ControlCredentialEvidence
}

func (e Evidence) Role() config.Role { return e.role }

func (e Evidence) ActualBootstrapPath() string { return e.actualBootstrapPath }

func (e Evidence) Configuration() config.Config {
	if e.role == config.RoleExecutor {
		return cloneConfig(e.executor.Configuration)
	}
	return cloneConfig(e.control.Configuration)
}

func (e Evidence) ControlConfiguration() ConfigurationEvidence {
	return cloneConfigurationEvidence(e.control)
}

func (e Evidence) ExecutorConfiguration() ConfigurationEvidence {
	return cloneConfigurationEvidence(e.executor)
}

func (e Evidence) Manifest() ManifestEvidence { return cloneManifestEvidence(e.manifest) }

func (e Evidence) Roots() []VerifiedRoot { return cloneRoots(e.roots) }

func (e Evidence) Files() []VerifiedFile { return cloneFiles(e.files) }

func (e Evidence) ReleaseProfile() ReleaseProfile { return cloneProfile(e.profile) }

func (e Evidence) FileBindings() []FileBindingEvidence { return cloneBindings(e.bindings) }

func (e Evidence) ApprovedSignerCertificateDERSHA256() string { return e.approvedSignerPin }

func (e Evidence) ControlCredentials() (ControlCredentialEvidence, bool) {
	if e.controlCredentials == nil || !e.controlCredentials.bound {
		return ControlCredentialEvidence{}, false
	}
	return *e.controlCredentials, true
}

func preflightError(code ErrorCode, message string, cause error) error {
	return &Error{Code: code, Message: message, Cause: cause}
}
