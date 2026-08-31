// Package winacl audits detached Windows filesystem security descriptors
// against closed production policy profiles.
package winacl

import (
	"errors"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

var (
	ErrInvalidEvidence = errors.New("invalid Windows filesystem security descriptor evidence")
	ErrInvalidProfile  = errors.New("invalid Windows filesystem ACL policy profile")
	ErrPolicyRejected  = errors.New("Windows filesystem ACL policy rejected the object")
)

// ProfileKind is a closed filesystem ACL policy class.
type ProfileKind uint8

const (
	ProfileAmbientAncestor ProfileKind = iota + 1
	ProfileManagedInstallationDirectory
	ProfileManagedInstallationFile
	ProfileManagedTrustedDirectory
	ProfileManagedTrustedFile
	ProfileManagedProductAnchorDirectory
	ProfileManagedRoleDataBoundaryDirectory
	ProfileInheritedRoleDataDirectory
	ProfileInheritedRoleDataFile
)

// AccessClass is the exact access granted to one service SID on a managed file.
type AccessClass uint8

const (
	AccessNone AccessClass = iota
	AccessRead
	AccessReadExecute
	AccessModify
)

const (
	localSystemSID           = "S-1-5-18"
	builtinAdministratorsSID = "S-1-5-32-544"
	creatorOwnerSID          = "S-1-3-0"
	ownerRightsSID           = "S-1-3-4"
	trustedInstallerSID      = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
)

const (
	fileReadData        winfile.AccessMask = 0x00000001
	fileWriteData       winfile.AccessMask = 0x00000002
	fileAppendData      winfile.AccessMask = 0x00000004
	fileReadEA          winfile.AccessMask = 0x00000008
	fileWriteEA         winfile.AccessMask = 0x00000010
	fileExecute         winfile.AccessMask = 0x00000020
	fileDeleteChild     winfile.AccessMask = 0x00000040
	fileReadAttributes  winfile.AccessMask = 0x00000080
	fileWriteAttributes winfile.AccessMask = 0x00000100

	deleteAccess   winfile.AccessMask = 0x00010000
	readControl    winfile.AccessMask = 0x00020000
	writeDACL      winfile.AccessMask = 0x00040000
	writeOwner     winfile.AccessMask = 0x00080000
	synchronize    winfile.AccessMask = 0x00100000
	maximumAllowed winfile.AccessMask = 0x02000000
	genericAll     winfile.AccessMask = 0x10000000
	genericExecute winfile.AccessMask = 0x20000000
	genericWrite   winfile.AccessMask = 0x40000000
	genericRead    winfile.AccessMask = 0x80000000
)

const (
	standardRightsRequired winfile.AccessMask = 0x000f0000
	fileSpecificRights     winfile.AccessMask = 0x000001ff
	genericRights                             = genericAll | genericExecute | genericWrite | genericRead

	fileGenericRead  = readControl | synchronize | fileReadData | fileReadEA | fileReadAttributes
	fileGenericWrite = readControl | synchronize | fileWriteData | fileAppendData |
		fileWriteEA | fileWriteAttributes
	fileGenericExecute = readControl | synchronize | fileExecute | fileReadAttributes
	fileAllAccess      = standardRightsRequired | synchronize | fileSpecificRights

	managedDirectoryRead           = fileGenericRead | fileGenericExecute
	managedDirectoryModify         = managedDirectoryRead | fileGenericWrite | deleteAccess | fileDeleteChild
	managedBoundaryDirectoryModify = managedDirectoryModify &^ (deleteAccess | fileDeleteChild)
	managedFileModify              = fileGenericRead | fileGenericWrite | deleteAccess
	fileMutationAccess             = fileWriteData | fileAppendData | fileWriteEA | fileWriteAttributes |
		deleteAccess | writeDACL | writeOwner
	directoryMutationAccess = fileMutationAccess | fileDeleteChild
	// Windows grants ordinary users WD, AD, WEA, and WA on a typical ProgramData
	// directory. Those self rights may create siblings or change ambient
	// metadata, but they cannot replace the already-existing product anchor.
	// The managed anchor remains independently handle-opened, identity-checked,
	// reparse-free, reinspected, and protected by its exact managed DACL.
	ambientForbiddenAccess = fileDeleteChild | deleteAccess | writeDACL | writeOwner
)

// PolicyProfile is an immutable, constructor-validated ACL policy value.
// Its fields are private so callers cannot manufacture an allow-all profile.
type PolicyProfile struct {
	kind           ProfileKind
	controlSID     string
	executorSID    string
	controlAccess  AccessClass
	executorAccess AccessClass
}
