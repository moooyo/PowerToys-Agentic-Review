package launchguard

import (
	"context"
	"errors"
	"sync"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/preflight"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winprocess"
)

var (
	ErrUnsupportedPlatform = errors.New("installation launch guard requires Windows")
	ErrInvalidAuthority    = errors.New("installation launch authority is invalid")
	ErrChanged             = errors.New("guarded installation object changed")
	ErrConsumed            = errors.New("installation launch guard was already consumed")
	ErrCleanupFatal        = errors.New("installation launch guard cleanup is unresolved; ServiceHost must exit")
	ErrHostControlClaim    = errors.New("guarded Node HostControl launch binding is unavailable")
)

type targetKind uint8

const (
	targetNode targetKind = iota + 1
	targetBundle
	targetProcessHost
)

type launchTarget struct {
	kind targetKind
	file preflight.VerifiedFile
}

type authoritySnapshot struct {
	role             config.Role
	configuration    config.Config
	preflightDigest  [32]byte
	releaseDigest    [32]byte
	bootstrapOptions localrpc.FoundationRuntimeBootstrapOptions
	root             preflight.VerifiedRoot
	targets          []launchTarget
	signerPin        string
}

type directoryHandle interface {
	Evidence() winfile.Evidence
	OpenDirectoryComponent(string, winfile.OpenOptions) (directoryHandle, error)
	OpenFileComponent(string, winfile.OpenOptions) (fileHandle, error)
	Enumerate(winfile.DirectoryEnumerationOptions) (winfile.DirectoryEnumeration, error)
	VerifyUnchanged() error
	ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error)
	ReinspectDataStreams() ([]winfile.DataStream, error)
	ReinspectCaseSensitivity() (bool, error)
	Close() error
}

type fileHandle interface {
	Evidence() winfile.Evidence
	HashSHA256(winfile.HashOptions) (winfile.HashResult, error)
	VerifyAuthenticode(authenticode.Verifier) (authenticode.Evidence, error)
	VerifyUnchanged() error
	ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error)
	ReinspectDataStreams() ([]winfile.DataStream, error)
	Close() error
}

type dependencies struct {
	openTraversalRoot       func(string, winfile.OpenOptions) (directoryHandle, error)
	newAuthenticodeVerifier func() (authenticode.Verifier, error)
	launchNode              func(winprocess.NodeLaunchSpec) (winprocess.NodeProcess, error)
	platformCleanupStatus   func() error
	commitPlatformHealthy   func(func()) error
	quarantine              *lifetimeQuarantine
}

type retainedDirectory struct {
	path        string
	handle      directoryHandle
	object      secureconfig.ObjectEvidence
	enumeration *winfile.DirectoryEnumeration
	enumOptions winfile.DirectoryEnumerationOptions
}

type retainedFile struct {
	kind   targetKind
	handle fileHandle
	file   preflight.VerifiedFile
}

type guardState struct {
	mu          sync.Mutex
	authority   authoritySnapshot
	directories []retainedDirectory
	files       []retainedFile
	deps        dependencies
	launchTried bool
	consumed    bool
	closed      bool
	terminal    error
}

// Guard is an opaque, one-shot owner of launch-critical installation handles.
// Copies share one private lifecycle state.
type Guard struct {
	state *guardState
}

// GuardedNodeProcess is an opaque, copy-safe Node owner bound to the exact
// factory-issued bootstrap selected before launch. Its private state can be
// claimed for HostControl exactly once.
type GuardedNodeProcess struct {
	state *guardedNodeProcessState
}

// HostControlNodeProcess is the claimed Node view that combines activation and
// bootstrap commit under the original launch cleanup permit.
type HostControlNodeProcess interface {
	winprocess.NodeProcess
	ActivateAndCommitRuntimeBootstrap(
		context.Context,
		*localrpc.PendingRuntimeBootstrapCommit,
	) (localrpc.CommittedRuntimeBootstrap, error)
}

type guardedNodeProcessState struct {
	inner               winprocess.NodeProcess
	guard               *guardState
	permit              *guardLaunchPermit
	bootstrap           localrpc.LaunchRuntimeBootstrap
	mu                  sync.Mutex
	bootstrapBound      bool
	hostControlClaimed  bool
	activationAttempted bool
	shutdownStarted     bool
	released            bool
	nodeClosed          bool
	terminal            error
}

func (guard *Guard) Role() config.Role {
	if guard == nil || guard.state == nil {
		return ""
	}
	guard.state.mu.Lock()
	defer guard.state.mu.Unlock()
	if guard.state.closed || guard.state.terminal != nil {
		return ""
	}
	return guard.state.authority.role
}

func (guard *Guard) PreflightDigest() [32]byte {
	if guard == nil || guard.state == nil {
		return [32]byte{}
	}
	guard.state.mu.Lock()
	defer guard.state.mu.Unlock()
	if guard.state.closed || guard.state.terminal != nil {
		return [32]byte{}
	}
	return guard.state.authority.preflightDigest
}

func cloneAuthority(value authoritySnapshot) authoritySnapshot {
	value.configuration = cloneConfig(value.configuration)
	value.root = cloneRoot(value.root)
	value.targets = append([]launchTarget(nil), value.targets...)
	for index := range value.targets {
		value.targets[index].file = cloneFile(value.targets[index].file)
	}
	return value
}

func cloneConfig(value config.Config) config.Config {
	if value.Node.Environment != nil {
		copy := make(map[string]string, len(value.Node.Environment))
		for name, item := range value.Node.Environment {
			copy[name] = item
		}
		value.Node.Environment = copy
	}
	if value.Control != nil {
		copy := *value.Control
		value.Control = &copy
	}
	if value.Executor != nil {
		copy := *value.Executor
		value.Executor = &copy
	}
	return value
}

func cloneRoot(value preflight.VerifiedRoot) preflight.VerifiedRoot {
	value.Ancestors = append([]secureconfig.ObjectEvidence(nil), value.Ancestors...)
	for index := range value.Ancestors {
		value.Ancestors[index] = cloneObject(value.Ancestors[index])
	}
	value.Object = cloneObject(value.Object)
	return value
}

func cloneFile(value preflight.VerifiedFile) preflight.VerifiedFile {
	value.Object = cloneObject(value.Object)
	return value
}

func cloneObject(value secureconfig.ObjectEvidence) secureconfig.ObjectEvidence {
	value.Evidence.Security.SelfRelativeDescriptor = append(
		[]byte(nil),
		value.Evidence.Security.SelfRelativeDescriptor...,
	)
	return value
}

func expectedRole(kind targetKind, role config.Role) releasemanifest.FileRole {
	switch kind {
	case targetNode:
		return releasemanifest.RoleNodeRuntime
	case targetBundle:
		if role == config.RoleControl {
			return releasemanifest.RoleControlBundle
		}
		return releasemanifest.RoleExecutorBundle
	case targetProcessHost:
		return releasemanifest.RoleProcessHost
	default:
		return ""
	}
}
