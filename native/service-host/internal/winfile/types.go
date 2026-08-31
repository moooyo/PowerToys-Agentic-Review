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
	ErrUnsafeSecurityDescriptor = errors.New("object security descriptor does not satisfy the requested security mode")
	ErrIdentityChanged          = errors.New("object identity changed during inspection")
	ErrObjectChanged            = errors.New("object changed during inspection")
	ErrTooLarge                 = errors.New("file exceeds the configured byte limit")
	ErrSizeMismatch             = errors.New("file size does not match the expected size")
	ErrDirectoryEnumeration     = errors.New("secure directory enumeration failed")
	ErrDirectoryBudget          = errors.New("directory enumeration exceeds the configured budget")
	ErrDirectoryCaseCollision   = errors.New("directory contains case-insensitive name collisions")
	ErrCaseSensitiveDirectory   = errors.New("case-sensitive directories are not supported")
	ErrNamedDataStream          = errors.New("named NTFS data streams are not permitted")
	ErrStreamEnumeration        = errors.New("secure data-stream enumeration failed")
	ErrCleanupFatal             = errors.New("secure file handle cleanup is unresolved; ServiceHost must exit")
)

const (
	MaximumDirectoryEntries             = uint32(65_536)
	MaximumDirectoryEntryNameUTF16Units = uint32(255)
	MaximumDirectoryNameUTF16Units      = uint64(16 * 1024 * 1024)
	MaximumHashPrefixBytes              = uint32(4 * 1024)
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

// SecurityMode selects the structural security-descriptor policy applied to an
// opened object. Managed is the zero value so existing callers remain strict.
type SecurityMode uint8

const (
	// SecurityModeManaged requires a protected, non-defaulted DACL, owner, and
	// group suitable for application-managed security boundaries.
	SecurityModeManaged SecurityMode = iota
	// SecurityModeAmbientAncestor permits inherited and defaulted security on
	// operating-system-managed ancestors while retaining all structural checks.
	SecurityModeAmbientAncestor
	// SecurityModeRoleDataInherited requires an unprotected, auto-inherited
	// DACL. Closed role-specific trustee and mask checks remain the caller's
	// responsibility because winfile does not accept policy inputs.
	SecurityModeRoleDataInherited
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
	Kind         ObjectKind
	Identity     FileIdentity
	Attributes   uint32
	Size         uint64
	LinkCount    uint32
	Path         PathEvidence
	Volume       VolumeEvidence
	SecurityMode SecurityMode
	Security     SecurityDescriptorEvidence
}

// OpenOptions controls volume policy and the access granted to a retained
// handle. DirectoryEnumeration must be requested when the caller intends to
// call Directory.Enumerate.
type OpenOptions struct {
	VolumeUse            VolumeUse
	DirectoryEnumeration bool
	SecurityMode         SecurityMode
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

// DirectoryEnumerationOptions bound one complete retained-handle directory
// scan. MaximumNameUTF16Units applies to one name; MaximumTotalNameUTF16Units
// applies to the sum of all returned names.
type DirectoryEnumerationOptions struct {
	MaximumEntries             uint32
	MaximumNameUTF16Units      uint32
	MaximumTotalNameUTF16Units uint64
}

// DirectoryEntry is one child observed through a retained directory handle.
// Identity combines the containing volume identity with FILE_ID_128 from the
// directory enumeration. Callers must still compare it with the child handle.
type DirectoryEntry struct {
	Name       string
	Kind       ObjectKind
	Identity   FileIdentity
	Attributes uint32
	Size       uint64
}

// DirectoryEnumeration contains a deterministic case-insensitive ordering and
// the exact aggregate UTF-16 name cost charged to the caller's budget.
type DirectoryEnumeration struct {
	Entries        []DirectoryEntry
	NameUTF16Units uint64
}

// HashOptions require an exact file size and bound the streaming work. PrefixBytes
// is capped independently so callers cannot turn hashing into an unbounded read.
type HashOptions struct {
	ExpectedSize uint64
	MaximumBytes uint64
	PrefixBytes  uint32
}

// HashResult binds a SHA-256 digest and bounded prefix to the exact byte count
// consumed from a retained file handle.
type HashResult struct {
	SHA256 [32]byte
	Size   uint64
	Prefix []byte
}

// DataStream describes one NTFS stream reported by FileStreamInfo. Secure
// objects accept only the unnamed default stream, spelled exactly ::$DATA.
type DataStream struct {
	Name           string
	Size           uint64
	AllocationSize uint64
}

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

// AccessCheckDecision is the result of evaluating a token against a descriptor.
type AccessCheckDecision struct {
	Allowed       bool
	GrantedAccess AccessMask
}

func cloneEvidence(value Evidence) Evidence {
	value.Security.SelfRelativeDescriptor = append(
		[]byte(nil),
		value.Security.SelfRelativeDescriptor...,
	)
	return value
}
