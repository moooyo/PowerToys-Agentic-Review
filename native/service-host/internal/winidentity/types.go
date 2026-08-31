package winidentity

import "errors"

var (
	// ErrUnsupportedPlatform reports that the Windows identity boundary cannot
	// be inspected on the current platform.
	ErrUnsupportedPlatform = errors.New("Windows service identity inspection is unsupported on this platform")
	// ErrInvalidOptions reports a malformed or internally inconsistent request.
	ErrInvalidOptions = errors.New("invalid Windows service identity preflight options")
	// ErrServiceSIDMismatch reports that SCM service identity evidence does not
	// match the expected service name and SID.
	ErrServiceSIDMismatch = errors.New("resolved service SID does not match the expected identity")
	// ErrServiceNotRestricted reports a service whose configured SID type is not
	// exactly SERVICE_SID_TYPE_RESTRICTED.
	ErrServiceNotRestricted = errors.New("service SID type is not restricted")
	// ErrServiceType reports a service that is not exactly a standalone Win32
	// own-process service.
	ErrServiceType = errors.New("service is not a Win32 own-process service")
	// ErrServiceAccountMismatch reports a service not configured to use its
	// distinct NT SERVICE virtual account.
	ErrServiceAccountMismatch = errors.New("service does not use its expected virtual account")
	// ErrAdministrativeToken reports Administrators membership, including a
	// deny-only membership left by UAC filtering.
	ErrAdministrativeToken = errors.New("process token belongs to an administrator")
	// ErrBuiltInServiceIdentity reports LocalSystem, LocalService, or
	// NetworkService in the token user or regular group sets.
	ErrBuiltInServiceIdentity = errors.New("process token uses a forbidden built-in service identity")
	// ErrOwnServiceSID reports that the expected service SID is not an enabled
	// token group and a restricting SID at the same time.
	ErrOwnServiceSID = errors.New("own service SID is not enabled and restricted")
	// ErrTokenUserMismatch reports that the process token was not created for
	// the own service's virtual account.
	ErrTokenUserMismatch = errors.New("process token user does not match the own service SID")
	// ErrPeerServiceSID reports any occurrence of the peer service SID in the
	// current token.
	ErrPeerServiceSID = errors.New("peer service SID is present in the process token")
	// ErrUnexpectedServiceSID reports another individual service SID in the
	// current process token.
	ErrUnexpectedServiceSID = errors.New("process token contains an unexpected service SID")
	// ErrForbiddenPrivilege reports a privilege that can cross the intended
	// service identity boundary or modify trusted machine state. Such privileges
	// must be absent, not merely disabled.
	ErrForbiddenPrivilege = errors.New("process token contains a high-risk privilege")
	// ErrUnsafeToken reports a malformed, non-primary, or otherwise unexpected
	// token shape.
	ErrUnsafeToken = errors.New("process token does not satisfy the identity contract")
	// ErrUnstableEvidence reports security facts that changed while handles were
	// retained for one inspection.
	ErrUnstableEvidence = errors.New("Windows identity evidence changed during inspection")
)

// ServiceIdentity binds an SCM service name to the service SID recorded by
// trusted installation metadata.
type ServiceIdentity struct {
	Name string
	SID  string
}

// Options identifies the two distinct virtual-account services participating
// in the local Control-Executor boundary. This package deliberately does not
// support alternate or shared service logon accounts.
type Options struct {
	OwnService  ServiceIdentity
	PeerService ServiceIdentity
}

// ServiceSIDType is the Win32 SERVICE_SID_TYPE value returned by SCM.
type ServiceSIDType uint32

const (
	ServiceSIDTypeNone         ServiceSIDType = 0
	ServiceSIDTypeUnrestricted ServiceSIDType = 1
	ServiceSIDTypeRestricted   ServiceSIDType = 3
)

// LUID is a detached Windows locally unique identifier.
type LUID struct {
	LowPart  uint32
	HighPart int32
}

// ServiceEvidence records facts obtained while holding one SCM service handle.
type ServiceEvidence struct {
	Name         string
	SID          string
	SIDType      ServiceSIDType
	ServiceType  uint32
	StartAccount string
	Domain       string
	AccountType  uint32
}

// SIDEntry is a detached SID_AND_ATTRIBUTES entry.
type SIDEntry struct {
	SID        string
	Attributes uint32
}

// Enabled reports whether this SID participates in allow access checks.
func (entry SIDEntry) Enabled() bool {
	return entry.Attributes&groupEnabled != 0 && entry.Attributes&groupUseForDenyOnly == 0
}

// DenyOnly reports whether this SID can participate only in deny access checks.
func (entry SIDEntry) DenyOnly() bool {
	return entry.Attributes&groupUseForDenyOnly != 0
}

// PrivilegeEvidence is a detached LUID_AND_ATTRIBUTES entry with its canonical
// Windows privilege name.
type PrivilegeEvidence struct {
	Name       string
	LUID       LUID
	Attributes uint32
}

// Enabled reports whether the privilege is currently enabled.
func (entry PrivilegeEvidence) Enabled() bool {
	return entry.Attributes&privilegeEnabled != 0
}

// TokenEvidence contains facts read from one retained real TOKEN_QUERY handle.
// No SID pointers or native token buffers escape the inspection.
type TokenEvidence struct {
	TokenID            LUID
	AuthenticationID   LUID
	ModifiedID         LUID
	Type               uint32
	ImpersonationLevel uint32
	HasRestrictions    bool
	User               SIDEntry
	Groups             []SIDEntry
	// RestrictedSIDs contains TokenRestrictedSids entries. Windows requires
	// restricting SID attributes to be zero and always enables them for the
	// second access check, so SIDEntry.Enabled must not be used on this slice.
	RestrictedSIDs []SIDEntry
	Privileges     []PrivilegeEvidence
}

// Evidence contains service configuration and process-token facts collected
// during one successful native snapshot. Slices own their backing storage.
type Evidence struct {
	ProcessID   uint32
	OwnService  ServiceEvidence
	PeerService ServiceEvidence
	Token       TokenEvidence
}

func cloneEvidence(value Evidence) Evidence {
	value.Token.Groups = append([]SIDEntry(nil), value.Token.Groups...)
	value.Token.RestrictedSIDs = append([]SIDEntry(nil), value.Token.RestrictedSIDs...)
	value.Token.Privileges = append([]PrivilegeEvidence(nil), value.Token.Privileges...)
	return value
}
