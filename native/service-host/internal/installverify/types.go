package installverify

import (
	"errors"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
)

var (
	ErrUnsupportedPlatform         = errors.New("installation verification requires Windows")
	ErrInvalidOptions              = errors.New("invalid installation verifier options")
	ErrProductionPolicyUnavailable = errors.New("production installation security policy is unavailable")
	ErrBootstrap                   = errors.New("bootstrap configuration verification failed")
	ErrConfiguration               = errors.New("bootstrap configurations are inconsistent")
	ErrManifest                    = errors.New("release manifest verification failed")
	ErrClosedTree                  = errors.New("installed trees do not exactly match the release manifest")
	ErrFileIdentity                = errors.New("installed objects reuse a filesystem identity")
	ErrFileContent                 = errors.New("installed file content does not match the release manifest")
	ErrAuthenticode                = errors.New("installed executable failed Authenticode verification")
	ErrCleanup                     = errors.New("installation verifier cleanup failed")
)

// Limits bound retained handles, directory enumeration, path depth, and
// streaming work. Values below the production defaults are accepted, but no
// caller can raise a value above the compiled hard maximum.
type Limits struct {
	MaximumDirectories         uint32
	MaximumEntriesPerDirectory uint32
	MaximumTotalEntries        uint32
	MaximumNameUTF16Units      uint32
	MaximumTotalNameUTF16Units uint64
	MaximumPathDepth           uint32
	MaximumFileBytes           uint64
	MaximumTotalFileBytes      uint64
}

// ProductionLimits returns the reviewed upper bounds. A zero Limits value is
// normalized to this exact value by Verify.
func ProductionLimits() Limits {
	return Limits{
		MaximumDirectories:         16_384,
		MaximumEntriesPerDirectory: 65_536,
		MaximumTotalEntries:        65_536,
		MaximumNameUTF16Units:      255,
		MaximumTotalNameUTF16Units: 16 * 1024 * 1024,
		MaximumPathDepth:           256,
		MaximumFileBytes:           releasemanifest.MaximumFileBytes,
		MaximumTotalFileBytes:      releasemanifest.MaximumTotalBytes,
	}
}

// Options contain only non-authorizing selectors and non-amplifiable limits.
// Production security policies and the Authenticode verifier are constructed
// inside the Windows implementation and cannot be supplied by callers.
type Options struct {
	Role                config.Role
	ActualBootstrapPath string
	Limits              Limits
}

// RootSnapshot is detached audit data. Ancestors are ordered from the volume
// root to the managed root's immediate parent and retain their ambient/managed
// security modes and file identities. Fields are private so a caller cannot
// construct a value that resembles verifier output.
type RootSnapshot struct {
	root      releasemanifest.FileRoot
	path      string
	ancestors []secureconfig.ObjectEvidence
	object    secureconfig.ObjectEvidence
}

func (snapshot RootSnapshot) Root() releasemanifest.FileRoot { return snapshot.root }
func (snapshot RootSnapshot) Path() string                   { return snapshot.path }
func (snapshot RootSnapshot) Object() secureconfig.ObjectEvidence {
	return cloneObjectEvidence(snapshot.object)
}
func (snapshot RootSnapshot) Ancestors() []secureconfig.ObjectEvidence {
	return cloneObjectEvidenceSlice(snapshot.ancestors)
}

// FileSnapshot is detached audit data for one manifest entry. Authenticode is
// present only for file roles that require a PE signature.
type FileSnapshot struct {
	root         releasemanifest.FileRoot
	path         string
	absolutePath string
	role         releasemanifest.FileRole
	sha256       string
	size         uint64
	object       secureconfig.ObjectEvidence
	authenticode *authenticode.Evidence
}

func (snapshot FileSnapshot) Root() releasemanifest.FileRoot { return snapshot.root }
func (snapshot FileSnapshot) Path() string                   { return snapshot.path }
func (snapshot FileSnapshot) AbsolutePath() string           { return snapshot.absolutePath }
func (snapshot FileSnapshot) Role() releasemanifest.FileRole { return snapshot.role }
func (snapshot FileSnapshot) SHA256() string                 { return snapshot.sha256 }
func (snapshot FileSnapshot) Size() uint64                   { return snapshot.size }
func (snapshot FileSnapshot) Object() secureconfig.ObjectEvidence {
	return cloneObjectEvidence(snapshot.object)
}
func (snapshot FileSnapshot) Authenticode() (authenticode.Evidence, bool) {
	if snapshot.authenticode == nil {
		return authenticode.Evidence{}, false
	}
	return *snapshot.authenticode, true
}

type evidenceState struct {
	role                config.Role
	actualBootstrapPath string
	controlBootstrap    secureconfig.Result
	executorBootstrap   secureconfig.Result
	controlConfig       config.Config
	executorConfig      config.Config
	manifestRead        secureconfig.Result
	manifest            releasemanifest.Manifest
	roots               []RootSnapshot
	files               []FileSnapshot
	approvedSignerPin   string
}

// Evidence is an opaque successful verification result. Its zero value is not
// evidence and no exported constructor accepts detached snapshots.
type Evidence struct {
	state *evidenceState
}

// Validate rejects the zero value and any internally incomplete state. It
// does not accept or reconstruct detached snapshots.
func (e Evidence) Validate() error {
	if e.state == nil || e.state.role != config.RoleControl && e.state.role != config.RoleExecutor ||
		e.state.actualBootstrapPath == "" || len(e.state.controlBootstrap.Data) == 0 ||
		len(e.state.executorBootstrap.Data) == 0 || len(e.state.manifestRead.Data) == 0 ||
		len(e.state.roots) != 2 || len(e.state.files) != len(e.state.manifest.Files) ||
		e.state.approvedSignerPin == "" {
		return errors.New("installation verification evidence is empty or incomplete")
	}
	return nil
}

func (e Evidence) Role() config.Role {
	if e.state == nil {
		return ""
	}
	return e.state.role
}

func (e Evidence) ActualBootstrapPath() string {
	if e.state == nil {
		return ""
	}
	return e.state.actualBootstrapPath
}

func (e Evidence) ControlBootstrap() secureconfig.Result {
	if e.state == nil {
		return secureconfig.Result{}
	}
	return cloneSecureResult(e.state.controlBootstrap)
}

func (e Evidence) ExecutorBootstrap() secureconfig.Result {
	if e.state == nil {
		return secureconfig.Result{}
	}
	return cloneSecureResult(e.state.executorBootstrap)
}

func (e Evidence) ControlConfiguration() config.Config {
	if e.state == nil {
		return config.Config{}
	}
	return cloneConfig(e.state.controlConfig)
}

func (e Evidence) ExecutorConfiguration() config.Config {
	if e.state == nil {
		return config.Config{}
	}
	return cloneConfig(e.state.executorConfig)
}

func (e Evidence) ManifestRead() secureconfig.Result {
	if e.state == nil {
		return secureconfig.Result{}
	}
	return cloneSecureResult(e.state.manifestRead)
}

func (e Evidence) Manifest() releasemanifest.Manifest {
	if e.state == nil {
		return releasemanifest.Manifest{}
	}
	return cloneManifest(e.state.manifest)
}

func (e Evidence) Roots() []RootSnapshot {
	if e.state == nil {
		return nil
	}
	return cloneRoots(e.state.roots)
}

func (e Evidence) Files() []FileSnapshot {
	if e.state == nil {
		return nil
	}
	return cloneFiles(e.state.files)
}

func (e Evidence) ApprovedSignerCertificateDERSHA256() string {
	if e.state == nil {
		return ""
	}
	return e.state.approvedSignerPin
}

type ErrorCode string

const (
	ErrorInput         ErrorCode = "INSTALL_VERIFY_INPUT_INVALID"
	ErrorBootstrap     ErrorCode = "INSTALL_VERIFY_BOOTSTRAP_FAILED"
	ErrorConfiguration ErrorCode = "INSTALL_VERIFY_CONFIGURATION_MISMATCH"
	ErrorManifest      ErrorCode = "INSTALL_VERIFY_MANIFEST_FAILED"
	ErrorTree          ErrorCode = "INSTALL_VERIFY_TREE_MISMATCH"
	ErrorFile          ErrorCode = "INSTALL_VERIFY_FILE_FAILED"
	ErrorSignature     ErrorCode = "INSTALL_VERIFY_AUTHENTICODE_FAILED"
	ErrorCleanup       ErrorCode = "INSTALL_VERIFY_CLEANUP_FAILED"
)

type Error struct {
	Code    ErrorCode
	Message string
	Cause   error
}

func (e *Error) Error() string { return e.Message }
func (e *Error) Unwrap() error { return e.Cause }
