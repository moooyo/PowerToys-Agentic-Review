package dataroot

import (
	"errors"
	"sync"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

var (
	ErrUnsupportedPlatform  = errors.New("data-root verification requires Windows")
	ErrInvalidInput         = errors.New("invalid data-root verifier input")
	ErrInstallationEvidence = errors.New("installation evidence is invalid or inconsistent")
	ErrConfiguration        = errors.New("data-root configurations are inconsistent")
	ErrPathPlan             = errors.New("data-root runtime path plan is invalid")
	ErrFilesystem           = errors.New("data-root filesystem verification failed")
	ErrACL                  = errors.New("data-root ACL verification failed")
	ErrIdentityAlias        = errors.New("data-root path identities overlap or alias")
	ErrChanged              = errors.New("data-root evidence changed after verification")
	ErrClosed               = errors.New("data-root evidence is closed or invalid")
	ErrCleanup              = errors.New("data-root verifier cleanup failed")
)

type ErrorCode string

const (
	ErrorInput         ErrorCode = "DATA_ROOT_INPUT_INVALID"
	ErrorInstallation  ErrorCode = "DATA_ROOT_INSTALLATION_EVIDENCE_INVALID"
	ErrorConfiguration ErrorCode = "DATA_ROOT_CONFIGURATION_MISMATCH"
	ErrorPath          ErrorCode = "DATA_ROOT_PATH_INVALID"
	ErrorFilesystem    ErrorCode = "DATA_ROOT_FILESYSTEM_INVALID"
	ErrorACL           ErrorCode = "DATA_ROOT_ACL_INVALID"
	ErrorIdentity      ErrorCode = "DATA_ROOT_IDENTITY_ALIAS"
	ErrorChanged       ErrorCode = "DATA_ROOT_CHANGED"
	ErrorCleanup       ErrorCode = "DATA_ROOT_CLEANUP_FAILED"
)

type Error struct {
	Code    ErrorCode
	Message string
	Cause   error
}

func (e *Error) Error() string { return e.Message }
func (e *Error) Unwrap() error { return e.Cause }

type PathPurpose string

const (
	PurposeWorkingDirectory PathPurpose = "working_directory"
	PurposeTemp             PathPurpose = "temp"
	PurposeTmp              PathPurpose = "tmp"
	PurposeUserProfile      PathPurpose = "user_profile"
	PurposeAppData          PathPurpose = "app_data"
	PurposeLocalAppData     PathPurpose = "local_app_data"
	PurposeHome             PathPurpose = "home"
	PurposeCodexHome        PathPurpose = "codex_home"
	PurposeGitConfigGlobal  PathPurpose = "git_config_global"
	PurposeWorkerAuth       PathPurpose = "worker_authentication_profile"
)

type PathClass string

const (
	PathClassStructureDirectory PathClass = "closed_structure_directory"
	PathClassRuntimeContent     PathClass = "runtime_content_directory"
	PathClassFixedFile          PathClass = "fixed_runtime_file"
)

type PeerRootObservation string

const PeerLiveRootNotObservedByDesign PeerRootObservation = "not_observed_by_role_isolation"

// RootSnapshot is detached evidence for the current role-owned data root.
type RootSnapshot struct {
	path      string
	ancestors []ObjectSnapshot
	object    ObjectSnapshot
}

func (snapshot RootSnapshot) Path() string { return snapshot.path }
func (snapshot RootSnapshot) Ancestors() []ObjectSnapshot {
	return cloneObjectSnapshotSlice(snapshot.ancestors)
}
func (snapshot RootSnapshot) Object() ObjectSnapshot {
	return cloneObjectSnapshot(snapshot.object)
}

// ObjectSnapshot binds one detached winfile snapshot to dataroot-specific
// evidence digests. Its fields are private to prevent snapshot fabrication.
type ObjectSnapshot struct {
	path                     string
	evidence                 winfile.Evidence
	evidenceSHA256           [32]byte
	securityDescriptorSHA256 [32]byte
}

func (snapshot ObjectSnapshot) Path() string { return snapshot.path }
func (snapshot ObjectSnapshot) Evidence() winfile.Evidence {
	return cloneWinfileEvidence(snapshot.evidence)
}
func (snapshot ObjectSnapshot) EvidenceSHA256() [32]byte { return snapshot.evidenceSHA256 }
func (snapshot ObjectSnapshot) SecurityDescriptorSHA256() [32]byte {
	return snapshot.securityDescriptorSHA256
}

// RuntimePathSnapshot binds one configured purpose to an object opened below
// the retained current-role data root.
type RuntimePathSnapshot struct {
	purpose  PathPurpose
	class    PathClass
	path     string
	relative string
	kind     winfile.ObjectKind
	object   ObjectSnapshot
}

func (snapshot RuntimePathSnapshot) Purpose() PathPurpose { return snapshot.purpose }
func (snapshot RuntimePathSnapshot) Class() PathClass     { return snapshot.class }
func (snapshot RuntimePathSnapshot) Path() string         { return snapshot.path }
func (snapshot RuntimePathSnapshot) RelativePath() string { return snapshot.relative }
func (snapshot RuntimePathSnapshot) Kind() winfile.ObjectKind {
	return snapshot.kind
}
func (snapshot RuntimePathSnapshot) Object() ObjectSnapshot {
	return cloneObjectSnapshot(snapshot.object)
}

// InstallationRootBinding records the concrete installation-verifier root
// identity used when proving physical separation from the current data root.
type InstallationRootBinding struct {
	root          releasemanifest.FileRoot
	path          string
	ancestorPaths []string
	ancestors     []winfile.FileIdentity
	target        winfile.FileIdentity
}

func (binding InstallationRootBinding) Root() releasemanifest.FileRoot { return binding.root }
func (binding InstallationRootBinding) Path() string                   { return binding.path }
func (binding InstallationRootBinding) Ancestors() []winfile.FileIdentity {
	return append([]winfile.FileIdentity(nil), binding.ancestors...)
}
func (binding InstallationRootBinding) AncestorPaths() []string {
	return append([]string(nil), binding.ancestorPaths...)
}
func (binding InstallationRootBinding) Target() winfile.FileIdentity { return binding.target }

type evidenceState struct {
	mu              sync.Mutex
	valid           bool
	role            config.Role
	current         config.Config
	peer            config.Config
	root            RootSnapshot
	paths           []RuntimePathSnapshot
	objects         []ObjectSnapshot
	installation    []InstallationRootBinding
	peerPath        string
	peerObservation PeerRootObservation
	digest          [32]byte
	resources       retainedResources
}

// Evidence is a concrete retained-handle pre-launch proof. Its zero value is
// invalid. Copies share the same private state and lifetime. The caller must
// complete final reinspection and Close before starting Node.
type Evidence struct {
	state *evidenceState
}

func (e Evidence) Validate() error {
	if e.state == nil {
		return ErrClosed
	}
	e.state.mu.Lock()
	defer e.state.mu.Unlock()
	return e.state.validateLocked()
}

func (e Evidence) Role() config.Role {
	if e.state == nil {
		return ""
	}
	e.state.mu.Lock()
	defer e.state.mu.Unlock()
	if !e.state.valid {
		return ""
	}
	return e.state.role
}

func (e Evidence) CurrentConfiguration() config.Config {
	if e.state == nil {
		return config.Config{}
	}
	e.state.mu.Lock()
	defer e.state.mu.Unlock()
	if !e.state.valid {
		return config.Config{}
	}
	return cloneConfig(e.state.current)
}

func (e Evidence) PeerConfiguration() config.Config {
	if e.state == nil {
		return config.Config{}
	}
	e.state.mu.Lock()
	defer e.state.mu.Unlock()
	if !e.state.valid {
		return config.Config{}
	}
	return cloneConfig(e.state.peer)
}

func (e Evidence) DataRoot() RootSnapshot {
	if e.state == nil {
		return RootSnapshot{}
	}
	e.state.mu.Lock()
	defer e.state.mu.Unlock()
	if !e.state.valid {
		return RootSnapshot{}
	}
	return cloneRootSnapshot(e.state.root)
}

func (e Evidence) RuntimePaths() []RuntimePathSnapshot {
	if e.state == nil {
		return nil
	}
	e.state.mu.Lock()
	defer e.state.mu.Unlock()
	if !e.state.valid {
		return nil
	}
	return cloneRuntimePaths(e.state.paths)
}

// RetainedObjects returns detached copies of every current-role object kept
// live for final reinspection, including dynamic runtime content.
func (e Evidence) RetainedObjects() []ObjectSnapshot {
	if e.state == nil {
		return nil
	}
	e.state.mu.Lock()
	defer e.state.mu.Unlock()
	if !e.state.valid {
		return nil
	}
	return cloneObjectSnapshotSlice(e.state.objects)
}

func (e Evidence) InstallationRoots() []InstallationRootBinding {
	if e.state == nil {
		return nil
	}
	e.state.mu.Lock()
	defer e.state.mu.Unlock()
	if !e.state.valid {
		return nil
	}
	return cloneInstallationBindings(e.state.installation)
}

func (e Evidence) PeerDataRootPath() string {
	if e.state == nil {
		return ""
	}
	e.state.mu.Lock()
	defer e.state.mu.Unlock()
	if !e.state.valid {
		return ""
	}
	return e.state.peerPath
}

func (e Evidence) PeerRootObservation() PeerRootObservation {
	if e.state == nil {
		return ""
	}
	e.state.mu.Lock()
	defer e.state.mu.Unlock()
	if !e.state.valid {
		return ""
	}
	return e.state.peerObservation
}

func (e Evidence) Digest() ([32]byte, error) {
	if e.state == nil {
		return [32]byte{}, ErrClosed
	}
	e.state.mu.Lock()
	defer e.state.mu.Unlock()
	if err := e.state.validateLocked(); err != nil {
		return [32]byte{}, err
	}
	return e.state.digest, nil
}

func (state *evidenceState) validateLocked() error {
	if !state.valid || state.role != config.RoleControl && state.role != config.RoleExecutor ||
		state.root.path == "" || len(state.root.ancestors) == 0 || state.root.object.path != state.root.path ||
		len(state.paths) == 0 || len(state.objects) != len(state.resources.values) ||
		len(state.installation) != 2 || state.peerPath == "" ||
		state.peerObservation != PeerLiveRootNotObservedByDesign || state.digest == ([32]byte{}) ||
		len(state.resources.values) == 0 {
		return ErrClosed
	}
	for _, root := range state.installation {
		if root.path == "" || len(root.ancestorPaths) == 0 ||
			len(root.ancestorPaths) != len(root.ancestors) || root.target.FileID == ([16]byte{}) {
			return ErrClosed
		}
	}
	for index, object := range state.objects {
		if err := validateDetachedObjectSnapshot(object); err != nil {
			return ErrClosed
		}
		resource := state.resources.values[index].object
		if object.path != resource.path || object.evidence.Identity != resource.evidence.Identity ||
			object.evidenceSHA256 != resource.evidenceSHA256 ||
			object.securityDescriptorSHA256 != resource.securityDescriptorSHA256 {
			return ErrClosed
		}
	}
	digest, err := digestEvidenceState(state)
	if err != nil || digest != state.digest {
		return ErrClosed
	}
	return nil
}

func (state *evidenceState) invalidateLocked() {
	state.valid = false
	state.role = ""
	state.current = config.Config{}
	state.peer = config.Config{}
	state.root = RootSnapshot{}
	state.paths = nil
	state.objects = nil
	state.installation = nil
	state.peerPath = ""
	state.peerObservation = ""
	state.digest = [32]byte{}
}

func verificationError(code ErrorCode, message string, cause error) error {
	return &Error{Code: code, Message: message, Cause: cause}
}
