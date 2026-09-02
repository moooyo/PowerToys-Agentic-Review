package outeradmission

import (
	"crypto/sha256"
	"errors"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
)

var (
	ErrUnavailable   = errors.New("signed outer package admission is unavailable")
	ErrInvalid       = errors.New("signed outer package admission input is invalid")
	ErrMismatch      = errors.New("signed outer package bootstrap binding mismatched")
	ErrInvalidPlan   = errors.New("signed outer package plan is invalid")
	ErrSerialization = errors.New("signed outer package plan cannot be serialized")
)

type signatureAuthority interface {
	Validate() error
	SignerKeyID() string
	Verify([]byte, []byte) error
}

type documentSnapshot struct {
	index       []byte
	envelope    []byte
	control     []byte
	executor    []byte
	indexSHA    [sha256.Size]byte
	envelopeSHA [sha256.Size]byte
	controlSHA  [sha256.Size]byte
	executorSHA [sha256.Size]byte
}

type planIssuer struct{ marker byte }

var successfulPlanIssuer = &planIssuer{marker: 1}

type planState struct {
	issuer      *planIssuer
	authority   signatureAuthority
	documents   documentSnapshot
	index       outerpackage.Index
	control     config.Config
	executor    config.Config
	signerKeyID string
	digest      [sha256.Size]byte
}

// SignedPackagePlan is an opaque, immutable logical binding. It is not filesystem, installation,
// service-control, Claim, or execution evidence.
type SignedPackagePlan struct {
	state *planState
}
