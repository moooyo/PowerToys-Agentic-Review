// Package installerdestination reverifies the immutable split Worker package after an installer
// has materialized and swapped its three fixed destination roots.
package installerdestination

import (
	"crypto/sha256"
	"errors"
	"sync"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
)

var (
	ErrUnsupportedPlatform = errors.New("installer destination verification requires Windows")
	ErrInvalidSource       = errors.New("installer destination source gate is invalid")
	ErrTree                = errors.New("installer destination tree is not closed")
	ErrFile                = errors.New("installer destination file verification failed")
	ErrAuthenticode        = errors.New("installer destination Authenticode verification failed")
	ErrInvalidEvidence     = errors.New("installer destination evidence is invalid")
	ErrClosed              = errors.New("installer destination evidence is closed")
	ErrCleanup             = errors.New("installer destination cleanup failed")
	ErrCleanupFatal        = errors.New("installer destination cleanup is unresolved; process must exit")
	ErrSerialization       = errors.New("installer destination evidence cannot be serialized")
)

const (
	maximumDirectories         = uint32(65_536)
	maximumEntriesPerDirectory = uint32(65_536)
	maximumTotalEntries        = uint32(65_536)
	maximumNameUTF16Units      = uint32(255)
	maximumTotalNameUTF16Units = uint64(16 * 1024 * 1024)
	closeAttempts              = 3
)

// RootSnapshot is detached audit data for one verified destination root.
type RootSnapshot struct {
	root   outerpackage.Root
	path   string
	object secureconfig.ObjectEvidence
}

func (snapshot RootSnapshot) Root() outerpackage.Root { return snapshot.root }
func (snapshot RootSnapshot) Path() string            { return snapshot.path }
func (snapshot RootSnapshot) Object() secureconfig.ObjectEvidence {
	return cloneObjectEvidence(snapshot.object)
}

// FileSnapshot is detached audit data for one verified destination file.
type FileSnapshot struct {
	root         outerpackage.Root
	path         string
	role         outerpackage.Role
	sha256       string
	size         uint64
	object       secureconfig.ObjectEvidence
	authenticode *authenticode.Evidence
}

func (snapshot FileSnapshot) Root() outerpackage.Root { return snapshot.root }
func (snapshot FileSnapshot) Path() string            { return snapshot.path }
func (snapshot FileSnapshot) Role() outerpackage.Role { return snapshot.role }
func (snapshot FileSnapshot) SHA256() string          { return snapshot.sha256 }
func (snapshot FileSnapshot) Size() uint64            { return snapshot.size }
func (snapshot FileSnapshot) Object() secureconfig.ObjectEvidence {
	return cloneObjectEvidence(snapshot.object)
}
func (snapshot FileSnapshot) Authenticode() (authenticode.Evidence, bool) {
	if snapshot.authenticode == nil {
		return authenticode.Evidence{}, false
	}
	return *snapshot.authenticode, true
}

type evidenceIssuer struct{ marker byte }

var successfulEvidenceIssuer = &evidenceIssuer{marker: 1}

type sourcePlan struct {
	indexDocument    []byte
	envelopeDocument []byte
	controlDocument  []byte
	executorDocument []byte
	index            outerpackage.Index
	control          config.Config
	executor         config.Config
	signerKeyID      string
}

type sourceLease struct {
	withBinding func(func(sourcePlan) error) error
	validate    func() error
	close       func() error
	commit      func(cleanupOperation, func()) error
}

type evidenceState struct {
	mu          sync.Mutex
	issuer      *evidenceIssuer
	closed      bool
	closeResult error
	source      sourceLease
	plan        sourcePlan
	owner       *handleOwner
	roots       []RootSnapshot
	files       []FileSnapshot
	digest      [sha256.Size]byte
}

// Evidence is opaque, process-local proof that all three post-swap destinations were reopened and
// matched the live staged v2 gate. It owns both destination and staged handles until Close.
type Evidence struct {
	state *evidenceState
}
