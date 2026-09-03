package stagedpackage

import (
	"crypto/sha256"
	"errors"
	"sync"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasepackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
)

var (
	ErrUnsupportedPlatform = errors.New("staged package verification requires Windows")
	ErrInvalidInput        = errors.New("staged package verifier input is invalid")
	ErrTrust               = errors.New("staged package compiled trust verification failed")
	ErrTree                = errors.New("staged package tree is not closed")
	ErrFile                = errors.New("staged package file verification failed")
	ErrDocuments           = errors.New("staged package documents are inconsistent")
	ErrAuthenticode        = errors.New("staged package Authenticode verification failed")
	ErrInvalidEvidence     = errors.New("staged package evidence is invalid")
	ErrClosed              = errors.New("staged package evidence is closed")
	ErrCleanup             = errors.New("staged package cleanup failed")
	ErrCleanupFatal        = errors.New("staged package handle cleanup is unresolved; process must exit")
	ErrSerialization       = errors.New("staged package evidence cannot be serialized")
	ErrInstallerProfile    = errors.New("staged package does not select the current installer profile")
)

const (
	maximumDirectories         = uint32(65_536)
	maximumEntriesPerDirectory = uint32(65_536)
	maximumTotalEntries        = uint32(65_536)
	maximumNameUTF16Units      = uint32(255)
	maximumTotalNameUTF16Units = uint64(16 * 1024 * 1024)
	maximumPathDepth           = uint32(256)
	closeAttempts              = 3
)

// RootSnapshot is detached audit data for one retained logical package root.
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

// FileSnapshot is detached audit data for one exact staged file.
type FileSnapshot struct {
	root         outerpackage.Root
	path         string
	role         outerpackage.Role
	sha256       string
	size         uint64
	indexed      bool
	object       secureconfig.ObjectEvidence
	authenticode *authenticode.Evidence
}

func (snapshot FileSnapshot) Root() outerpackage.Root { return snapshot.root }
func (snapshot FileSnapshot) Path() string            { return snapshot.path }
func (snapshot FileSnapshot) Role() outerpackage.Role { return snapshot.role }
func (snapshot FileSnapshot) SHA256() string          { return snapshot.sha256 }
func (snapshot FileSnapshot) Size() uint64            { return snapshot.size }
func (snapshot FileSnapshot) IndexedPayload() bool    { return snapshot.indexed }
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

type evidenceState struct {
	mu                  sync.Mutex
	issuer              *evidenceIssuer
	closed              bool
	rootPath            string
	owner               *handleOwner
	index               outerpackage.Index
	control             config.Config
	executor            config.Config
	signerKeyID         string
	envelope            []byte
	documents           releasepackage.FinalizedDocumentFacts
	roots               []RootSnapshot
	files               []FileSnapshot
	digest              [sha256.Size]byte
	destinationBorrowed bool
	destinationConsumed bool
	destinationOwner    *destinationOwnership
}

// StagedPackageEvidence is opaque read-only proof that one retained staged tree matched a signed
// logical plan at verification time. It is not installation, service-control, Claim, or execution
// evidence. Callers must Close it to release all retained handles.
type StagedPackageEvidence struct {
	state *evidenceState
}

// InstallerPackage is the non-forgeable profile gate required by the current installer consumer.
// It retains no authority beyond the originating StagedPackageEvidence.
type InstallerPackage struct {
	state  *evidenceState
	digest [sha256.Size]byte
}

type destinationBindingIssuer struct{ marker byte }

var successfulDestinationBindingIssuer = &destinationBindingIssuer{marker: 1}

type destinationBorrowState struct {
	mu     sync.Mutex
	active bool
}

type destinationOwnership struct{ marker byte }

// DestinationBinding is an opaque, detached view of the admitted documents required to reverify a
// post-swap installer destination. It is minted only through a live InstallerPackage and is not
// accepted by any public installation entry point.
type DestinationBinding struct {
	issuer           *destinationBindingIssuer
	borrow           *destinationBorrowState
	sourceDigest     [sha256.Size]byte
	indexDocument    []byte
	envelopeDocument []byte
	controlDocument  []byte
	executorDocument []byte
	signerKeyID      string
	digest           [sha256.Size]byte
}

// DestinationLease is the exclusive source-handle capability transferred to a successful
// destination verifier. Existing staged-evidence aliases cannot close its handles.
type DestinationLease struct {
	state  *evidenceState
	digest [sha256.Size]byte
	owner  *destinationOwnership
}
