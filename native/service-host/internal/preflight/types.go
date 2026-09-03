package preflight

import (
	"errors"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/cng"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/dataroot"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peerverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/servicebootstrap"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winidentity"
)

const (
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
	ErrorReleaseAuthority   ErrorCode = "PREFLIGHT_RELEASE_AUTHORITY_INVALID"
	ErrorCurrentImage       ErrorCode = "PREFLIGHT_CURRENT_IMAGE_MISMATCH"
	ErrorCompatibility      ErrorCode = "PREFLIGHT_COMPATIBILITY_MISMATCH"
	ErrorCredentialIdentity ErrorCode = "PREFLIGHT_CREDENTIAL_IDENTITY_MISMATCH"
	ErrorDataRoot           ErrorCode = "PREFLIGHT_DATA_ROOT_MISMATCH"
	ErrorRuntimeContent     ErrorCode = "PREFLIGHT_RUNTIME_CONTENT_MISMATCH"
	ErrorEvidence           ErrorCode = "PREFLIGHT_EVIDENCE_INVALID"
	ErrorPeerVerification   ErrorCode = "PREFLIGHT_PEER_VERIFICATION_PLAN_INVALID"
	ErrorServiceBootstrap   ErrorCode = "PREFLIGHT_SERVICE_BOOTSTRAP_MISMATCH"
)

var (
	ErrInvalidEvidence = errors.New("preflight evidence is invalid")
	// ErrPeerCleanupFatal requires immediate ServiceHost process termination;
	// the rejected peer session remains retained until process exit.
	ErrPeerCleanupFatal = errors.New("rejected peer session cleanup failed; the current ServiceHost process must exit")
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
	Root      releasemanifest.FileRoot
	Path      string
	Ancestors []secureconfig.ObjectEvidence
	Object    secureconfig.ObjectEvidence
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

// Input accepts opaque service-bootstrap, current-image, and installation
// evidence, retained data-root verifier evidence, and the concrete local
// authority signer. Control requires LocalAuthoritySigner, and Executor must
// leave it nil.
type Input struct {
	Role                 config.Role
	ActualBootstrapPath  string
	Bootstrap            servicebootstrap.Evidence
	CurrentImage         servicebootstrap.CurrentImageEvidence
	Installation         installverify.Evidence
	DataRoot             dataroot.Evidence
	LocalAuthoritySigner *cng.Signer
}

// BootstrapBinding is the detached cross-package proof captured from opaque
// servicebootstrap evidence. Its private fields cannot be populated by a
// production caller, and it contains no native handles.
type BootstrapBinding struct {
	role             config.Role
	ownServiceName   string
	ownServiceSID    string
	peerServiceName  string
	peerServiceSID   string
	serviceHostFacts peerverify.StableProcessFacts
	sourceDigest     [32]byte
	bound            bool
}

func (binding BootstrapBinding) Role() config.Role       { return binding.role }
func (binding BootstrapBinding) OwnServiceName() string  { return binding.ownServiceName }
func (binding BootstrapBinding) OwnServiceSID() string   { return binding.ownServiceSID }
func (binding BootstrapBinding) PeerServiceName() string { return binding.peerServiceName }
func (binding BootstrapBinding) PeerServiceSID() string  { return binding.peerServiceSID }
func (binding BootstrapBinding) ServiceHostProcessID() uint32 {
	return binding.serviceHostFacts.ProcessID
}
func (binding BootstrapBinding) ServiceHostProcessFacts() peerverify.StableProcessFacts {
	return binding.serviceHostFacts
}
func (binding BootstrapBinding) SourceDigest() [32]byte { return binding.sourceDigest }

// CurrentImageBinding is the detached cross-package binding captured from the
// opaque current-image evidence. Final-path diagnostics are intentionally not
// retained because they are not authorization facts.
type CurrentImageBinding struct {
	sourceDigest    [32]byte
	bootstrapDigest [32]byte
	processFacts    peerverify.StableProcessFacts
	processPath     string
	identity        peerverify.FileIdentity
	size            uint64
	sha256          [32]byte
	bound           bool
}

func (binding CurrentImageBinding) SourceDigest() [32]byte { return binding.sourceDigest }
func (binding CurrentImageBinding) BootstrapDigest() [32]byte {
	return binding.bootstrapDigest
}
func (binding CurrentImageBinding) ProcessFacts() peerverify.StableProcessFacts {
	return binding.processFacts
}
func (binding CurrentImageBinding) ProcessPath() string               { return binding.processPath }
func (binding CurrentImageBinding) Identity() peerverify.FileIdentity { return binding.identity }
func (binding CurrentImageBinding) Size() uint64                      { return binding.size }
func (binding CurrentImageBinding) SHA256() [32]byte                  { return binding.sha256 }

type releaseBindingSnapshot struct {
	templateDigest        [32]byte
	manifestSHA256        string
	templateSchemaVersion uint32
	profileID             string
	releaseID             string
	compatibility         releasemanifest.Compatibility
	signerPin             string
	dependencies          []releasemanifest.File
	serviceHost           releasemanifest.File
	bound                 bool
}

// ControlCredentialEvidence contains only the attestation returned atomically
// by the concrete validated local-authority signer. Its fields cannot be
// populated by callers, and the value exposes only copy-returning accessors.
type ControlCredentialEvidence struct {
	localAuthority        cng.Attestation
	localFacts            localCredentialFacts
	authenticationProfile string
	bound                 bool
	attested              bool
}

func (e ControlCredentialEvidence) LocalAuthorityAttestation() cng.Attestation {
	return e.localAuthority
}

func (e ControlCredentialEvidence) WorkerAuthenticationProfile() string {
	return e.authenticationProfile
}

// DataRootBinding retains only detached role, installation-root identity, and
// digest facts. It deliberately contains no dataroot Evidence or native handle.
type DataRootBinding struct {
	role              config.Role
	currentPath       string
	peerPath          string
	peerObservation   dataroot.PeerRootObservation
	installationRoots []dataRootInstallationBinding
	digest            [32]byte
	bound             bool
}

type dataRootInstallationBinding struct {
	root          releasemanifest.FileRoot
	path          string
	ancestorPaths []string
	ancestors     []winfile.FileIdentity
	target        winfile.FileIdentity
}

func (binding DataRootBinding) Role() config.Role   { return binding.role }
func (binding DataRootBinding) CurrentPath() string { return binding.currentPath }
func (binding DataRootBinding) PeerPath() string    { return binding.peerPath }
func (binding DataRootBinding) PeerObservation() dataroot.PeerRootObservation {
	return binding.peerObservation
}
func (binding DataRootBinding) Digest() [32]byte { return binding.digest }

// VerifiedRuntimeContent is a copy-only runtime trust input captured by the
// installation verifier from the same retained handle as its file binding.
type VerifiedRuntimeContent struct {
	root         releasemanifest.FileRoot
	path         string
	absolutePath string
	role         releasemanifest.FileRole
	sha256       string
	size         uint64
	object       secureconfig.ObjectEvidence
	data         []byte
}

func (content VerifiedRuntimeContent) Root() releasemanifest.FileRoot { return content.root }
func (content VerifiedRuntimeContent) Path() string                   { return content.path }
func (content VerifiedRuntimeContent) AbsolutePath() string           { return content.absolutePath }
func (content VerifiedRuntimeContent) Role() releasemanifest.FileRole { return content.role }
func (content VerifiedRuntimeContent) SHA256() string                 { return content.sha256 }
func (content VerifiedRuntimeContent) Size() uint64                   { return content.size }
func (content VerifiedRuntimeContent) Object() secureconfig.ObjectEvidence {
	return cloneObject(content.object)
}
func (content VerifiedRuntimeContent) Bytes() []byte { return append([]byte(nil), content.data...) }

type installationSnapshot struct {
	role                config.Role
	actualBootstrapPath string
	controlBootstrap    secureconfig.Result
	executorBootstrap   secureconfig.Result
	controlConfig       config.Config
	executorConfig      config.Config
	manifestRead        secureconfig.Result
	manifest            releasemanifest.Manifest
	identity            winidentity.Evidence
	roots               []VerifiedRoot
	files               []VerifiedFile
	contents            []VerifiedRuntimeContent
	release             releaseBindingSnapshot
}

type snapshotInput struct {
	role                config.Role
	actualBootstrapPath string
	installation        *installationSnapshot
	credentials         *ControlCredentialEvidence
	dataRoot            DataRootBinding
	bootstrap           BootstrapBinding
	currentImage        CurrentImageBinding
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
	identity            winidentity.Evidence
	roots               []VerifiedRoot
	files               []VerifiedFile
	release             releaseBindingSnapshot
	bindings            []FileBindingEvidence
	controlCredentials  *ControlCredentialEvidence
	dataRoot            DataRootBinding
	contents            []VerifiedRuntimeContent
	digest              [32]byte
	bootstrap           BootstrapBinding
	currentImage        CurrentImageBinding
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

func (e Evidence) Identity() winidentity.Evidence { return cloneIdentityEvidence(e.identity) }

func (e Evidence) Roots() []VerifiedRoot { return cloneRoots(e.roots) }

func (e Evidence) Files() []VerifiedFile { return cloneFiles(e.files) }

func (e Evidence) FileBindings() []FileBindingEvidence { return cloneBindings(e.bindings) }

func (e Evidence) ReleaseTemplateDigest() [32]byte { return e.release.templateDigest }

func (e Evidence) ApprovedSignerCertificateDERSHA256() string { return e.release.signerPin }

func (e Evidence) ControlCredentials() (ControlCredentialEvidence, bool) {
	if e.controlCredentials == nil || !e.controlCredentials.bound {
		return ControlCredentialEvidence{}, false
	}
	return *e.controlCredentials, true
}

func (e Evidence) DataRootBinding() (DataRootBinding, bool) {
	if !e.dataRoot.bound {
		return DataRootBinding{}, false
	}
	return cloneDataRootBinding(e.dataRoot), true
}

func (e Evidence) RuntimeContents() []VerifiedRuntimeContent {
	return cloneRuntimeContents(e.contents)
}

func (e Evidence) BootstrapBinding() (BootstrapBinding, bool) {
	if !e.bootstrap.bound {
		return BootstrapBinding{}, false
	}
	return e.bootstrap, true
}

func (e Evidence) CurrentImageBinding() (CurrentImageBinding, bool) {
	if !e.currentImage.bound {
		return CurrentImageBinding{}, false
	}
	return e.currentImage, true
}

// PinnedRuntimeFile contains one immutable path and digest selected for launch.
type PinnedRuntimeFile struct {
	path   string
	sha256 string
}

func (file PinnedRuntimeFile) Path() string   { return file.path }
func (file PinnedRuntimeFile) SHA256() string { return file.sha256 }

// RuntimeBootstrapAuthority is the copy-safe, opaque set of verified facts
// used both to issue and to bind one fixed foundation bootstrap.
type RuntimeBootstrapAuthority struct {
	options localrpc.FoundationRuntimeBootstrapOptions
	valid   bool
}

type runtimeBootstrapTrust struct {
	localAuthorityKeyID  string
	executorPolicySHA256 string
}

// RuntimePlan is the copy-only, role-local output consumed after data-root
// final reinspection and closure. It contains no credential or native handle.
type RuntimePlan struct {
	role                  config.Role
	configuration         config.Config
	releaseTemplateDigest [32]byte
	preflightDigest       [32]byte
	dataRootDigest        [32]byte
	node                  PinnedRuntimeFile
	bundle                PinnedRuntimeFile
	processHost           *PinnedRuntimeFile
	runtimeContents       []VerifiedRuntimeContent
	bootstrapTrust        runtimeBootstrapTrust
	bootstrapAuthority    RuntimeBootstrapAuthority
	valid                 bool
}

func (plan RuntimePlan) Role() config.Role            { return plan.role }
func (plan RuntimePlan) Configuration() config.Config { return cloneConfig(plan.configuration) }
func (plan RuntimePlan) ReleaseTemplateDigest() [32]byte {
	return plan.releaseTemplateDigest
}
func (plan RuntimePlan) PreflightDigest() [32]byte { return plan.preflightDigest }
func (plan RuntimePlan) DataRootDigest() [32]byte  { return plan.dataRootDigest }
func (plan RuntimePlan) Node() PinnedRuntimeFile   { return plan.node }
func (plan RuntimePlan) Bundle() PinnedRuntimeFile { return plan.bundle }
func (plan RuntimePlan) ProcessHost() (PinnedRuntimeFile, bool) {
	if plan.processHost == nil {
		return PinnedRuntimeFile{}, false
	}
	return *plan.processHost, true
}
func (plan RuntimePlan) RuntimeContents() []VerifiedRuntimeContent {
	return cloneRuntimeContents(plan.runtimeContents)
}
func (plan RuntimePlan) RuntimeBootstrapAuthority() RuntimeBootstrapAuthority {
	return cloneRuntimeBootstrapAuthority(plan.bootstrapAuthority)
}

func preflightError(code ErrorCode, message string, cause error) error {
	return &Error{Code: code, Message: message, Cause: cause}
}
