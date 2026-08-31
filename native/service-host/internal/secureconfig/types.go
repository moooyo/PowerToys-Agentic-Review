package secureconfig

import (
	"encoding/hex"
	"errors"
	"sync"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

var (
	ErrUnsupportedPlatform = errors.New("secure configuration reading is unsupported on this platform")
	ErrInvalidPath         = errors.New("configuration path is not a canonical absolute Windows file path")
	ErrInvalidOptions      = errors.New("invalid secure configuration reader options")
	ErrInvalidPolicy       = errors.New("invalid secure configuration security policy")
	ErrPolicyRejected      = errors.New("configuration security policy rejected an object")
	ErrInvalidEvidence     = errors.New("secure file evidence is incomplete or inconsistent")
	ErrVolumeChanged       = errors.New("configuration path components do not identify one stable volume")
	ErrDuplicateIdentity   = errors.New("configuration path components reuse an object identity")
	ErrSecurityChanged     = errors.New("configuration object security descriptor changed during inspection")
)

// Digest is a SHA-256 digest.
type Digest [32]byte

// String returns the lowercase hexadecimal digest.
func (digest Digest) String() string {
	return hex.EncodeToString(digest[:])
}

// ObjectEvidence binds a canonical component path to detached handle evidence.
// EvidenceSHA256 excludes path-derived diagnostic strings, including VolumePath
// and winfile's final-path diagnostics, because they are not security inputs.
type ObjectEvidence struct {
	Path                     string
	Evidence                 winfile.Evidence
	EvidenceSHA256           Digest
	SecurityDescriptorSHA256 Digest
}

// Result contains bytes read from the retained file handle and evidence for
// the file and every ancestor. Ancestors are ordered from the volume root to
// the file's immediate parent.
type Result struct {
	Data          []byte
	ContentSHA256 Digest
	File          ObjectEvidence
	Ancestors     []ObjectEvidence
}

// Options controls one secure configuration read. ManagedAnchorPath must be a
// canonical non-volume-root directory that is a strict ancestor of the target
// file. Ancestors before it use ambient structural security; it and every
// descendant use managed structural security. Policy remains caller-owned and
// is not closed by Read.
type Options struct {
	MaximumBytes      uint64
	ManagedAnchorPath string
	Policy            SecurityPolicy
}

// AncestorSecurityRequest describes one separately opened ancestor handle.
type AncestorSecurityRequest struct {
	Index        int
	Count        int
	IsVolumeRoot bool
	Object       ObjectEvidence
}

// FileSecurityRequest describes the separately opened configuration file.
type FileSecurityRequest struct {
	Object ObjectEvidence
}

// SecurityPolicy validates the expected owner and DACL semantics of every
// opened object. Implementations must make a positive decision for each call;
// structural protected-DACL evidence alone does not establish authorization.
// A policy that requires durable immutability must evaluate file write, delete,
// WRITE_DAC, and WRITE_OWNER rights and the corresponding create, rename, and
// delete-child rights on ancestor directories for every untrusted token.
type SecurityPolicy interface {
	CheckAncestor(AncestorSecurityRequest) error
	CheckFile(FileSecurityRequest) error
}

// AccessExpectation states one required AccessCheck outcome. Token is borrowed
// only while NewExpectedSecurityPolicy duplicates it; the policy never retains
// the caller's token instance.
type AccessExpectation struct {
	Name            string
	Token           *winfile.StableAccessToken
	DesiredAccess   winfile.AccessMask
	GenericMapping  winfile.GenericMapping
	ExpectedAllowed bool
}

// SecurityExpectation describes accepted owner and DACL semantics. OwnerSIDs
// must be non-empty. The DACL must be bound either by DescriptorSHA256 or by at
// least one AccessCheck expectation. Empty GroupSIDs means any structurally
// valid group is accepted. Defaulted owner, group, and DACL fields are rejected
// unless their corresponding Allow field is true.
type SecurityExpectation struct {
	OwnerSIDs           []string
	GroupSIDs           []string
	DescriptorSHA256    *Digest
	AccessChecks        []AccessExpectation
	AllowOwnerDefaulted bool
	AllowGroupDefaulted bool
	AllowDACLDefaulted  bool
}

// ExpectedSecurityPolicy applies separate immutable expectations to ancestor
// directories and the configuration file. It owns token duplicates and must
// be closed when no longer needed.
type ExpectedSecurityPolicy struct {
	state *expectedSecurityPolicyState
}

type expectedSecurityPolicyState struct {
	mu       sync.RWMutex
	closed   bool
	ancestor securityExpectation
	file     securityExpectation
}
