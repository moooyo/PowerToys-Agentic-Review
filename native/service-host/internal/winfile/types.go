package winfile

import "errors"

var (
	ErrUnsupportedPlatform      = errors.New("secure Windows file inspection is unsupported on this platform")
	ErrInvalidPath              = errors.New("path is not a canonical local Windows path")
	ErrInvalidOptions           = errors.New("invalid secure file inspection options")
	ErrClosed                   = errors.New("secure file handle is closed")
	ErrNotDiskObject            = errors.New("handle does not identify a disk object")
	ErrReparsePoint             = errors.New("reparse points are not permitted")
	ErrWrongObjectType          = errors.New("object type does not match the requested type")
	ErrHardLinkedFile           = errors.New("file must have exactly one hard link")
	ErrDeletePending            = errors.New("object is pending deletion")
	ErrUnsupportedVolume        = errors.New("object is not on a supported NTFS volume")
	ErrReadOnlyVolume           = errors.New("object is on a read-only volume")
	ErrVolumeIdentityMismatch   = errors.New("path and handle resolve to different volume identities")
	ErrUnsafeSecurityDescriptor = errors.New("object security descriptor is incomplete or unprotected")
	ErrIdentityChanged          = errors.New("object identity changed during inspection")
	ErrObjectChanged            = errors.New("object changed during inspection")
	ErrTooLarge                 = errors.New("file exceeds the configured byte limit")
)

// ObjectKind is the expected kind of an opened filesystem object.
type ObjectKind uint8

const (
	ObjectKindUnknown ObjectKind = iota
	ObjectKindFile
	ObjectKindDirectory
)

func (kind ObjectKind) String() string {
	switch kind {
	case ObjectKindFile:
		return "file"
	case ObjectKindDirectory:
		return "directory"
	default:
		return "unknown"
	}
}

// VolumeUse describes whether the caller's eventual use requires a writable
// volume. Both values still open the object itself with read-only access.
type VolumeUse uint8

const (
	VolumeUseUnknown VolumeUse = iota
	VolumeUseReadOnly
	VolumeUseWritable
)

// AncestorValidation records the scope of reparse-point validation represented
// by PathEvidence.
type AncestorValidation uint8

const (
	AncestorValidationUnknown AncestorValidation = iota
	// AncestorValidationNotPerformed means only the terminal component was
	// opened without following a reparse point. Every ancestor still requires
	// a separate handle-bound check before the full path can be called reparse-free.
	AncestorValidationNotPerformed
)

// FileIdentity is the FILE_ID_INFO identity captured from an open handle.
type FileIdentity struct {
	VolumeSerialNumber uint64
	FileID             [16]byte
}

// PathEvidence distinguishes security-relevant terminal-component validation
// from the final path string, which is collected for diagnostics only.
type PathEvidence struct {
	RequestedPath                string
	TerminalComponentReparseFree bool
	Ancestors                    AncestorValidation
	FinalPathDiagnostic          string
	FinalPathDiagnosticError     string
}

// VolumeEvidence is collected from the object handle and cross-checked against
// the volume found from the requested path.
type VolumeEvidence struct {
	FileSystem             string
	FileSystemFlags        uint32
	HandleSerialNumber     uint32
	PathSerialNumber       uint32
	VolumePath             string
	DriveType              uint32
	PersistentACLs         bool
	ReadOnly               bool
	RequiredUse            VolumeUse
	PathIdentityCrossCheck bool
}

// SecurityDescriptorEvidence is a self-relative descriptor obtained from the
// same handle as the other evidence. Protected only describes inheritance; it
// does not prove that any particular principal is denied write access.
type SecurityDescriptorEvidence struct {
	OwnerSID               string
	GroupSID               string
	OwnerDefaulted         bool
	GroupDefaulted         bool
	DACLPresent            bool
	DACLNull               bool
	DACLDefaulted          bool
	DACLProtected          bool
	Control                uint16
	Revision               uint32
	SelfRelativeDescriptor []byte
}

// Evidence contains facts collected from one open object handle. It does not
// claim that ancestor components are reparse-free or that DACL entries deny a
// particular token access.
type Evidence struct {
	Kind       ObjectKind
	Identity   FileIdentity
	Attributes uint32
	Size       uint64
	LinkCount  uint32
	Path       PathEvidence
	Volume     VolumeEvidence
	Security   SecurityDescriptorEvidence
}

// OpenOptions controls volume policy for handle-bound inspection.
type OpenOptions struct {
	VolumeUse VolumeUse
}

// ReadOptions controls a complete bounded stable read.
type ReadOptions struct {
	MaximumBytes uint64
	VolumeUse    VolumeUse
}

// ReadResult binds bytes to the evidence captured from the same handle.
type ReadResult struct {
	Data     []byte
	Evidence Evidence
}

// AccessToken is an opaque Windows token handle for a future AccessCheck
// implementation. A checker must require an impersonation token with TOKEN_QUERY.
type AccessToken uintptr

// AccessMask is a Windows access mask.
type AccessMask uint32

// GenericMapping supplies the object-specific mapping required before calling
// AccessCheck with a desired mask that contains generic rights.
type GenericMapping struct {
	Read    AccessMask
	Write   AccessMask
	Execute AccessMask
	All     AccessMask
}

// AccessCheckRequest contains all typed inputs needed for a Windows AccessCheck.
type AccessCheckRequest struct {
	SecurityDescriptor SecurityDescriptorEvidence
	Token              AccessToken
	DesiredAccess      AccessMask
	GenericMapping     GenericMapping
}

// AccessCheckDecision is the result of evaluating a token against a descriptor.
type AccessCheckDecision struct {
	Allowed       bool
	GrantedAccess AccessMask
}

// AccessChecker deliberately separates semantic authorization from structural
// descriptor evidence. Implementations must use Windows AccessCheck rather than
// infer access from ACE text or the DACL-protected flag.
type AccessChecker interface {
	CheckAccess(AccessCheckRequest) (AccessCheckDecision, error)
}

func cloneEvidence(value Evidence) Evidence {
	value.Security.SelfRelativeDescriptor = append(
		[]byte(nil),
		value.Security.SelfRelativeDescriptor...,
	)
	return value
}
