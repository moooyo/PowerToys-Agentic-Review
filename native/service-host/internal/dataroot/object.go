package dataroot

import (
	"crypto/sha256"
	"fmt"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

const (
	fileAttributeDirectory     uint32 = 0x00000010
	fileAttributeReparsePoint  uint32 = 0x00000400
	filePersistentACLs         uint32 = 0x00000008
	fileReadOnlyVolume         uint32 = 0x00080000
	driveTypeFixed             uint32 = 3
	securityDACLPresent        uint16 = 0x0004
	securityDACLAutoInherited  uint16 = 0x0400
	securityDACLProtected      uint16 = 0x1000
	securityDescriptorRelative uint16 = 0x8000
)

func newObjectSnapshot(
	path string,
	expectedMode winfile.SecurityMode,
	evidence winfile.Evidence,
) (ObjectSnapshot, error) {
	if err := validateObjectSnapshot(path, expectedMode, evidence); err != nil {
		return ObjectSnapshot{}, err
	}
	detached := cloneWinfileEvidence(evidence)
	return ObjectSnapshot{
		path:                     path,
		evidence:                 detached,
		evidenceSHA256:           digestObjectSnapshot(path, detached),
		securityDescriptorSHA256: sha256.Sum256(detached.Security.SelfRelativeDescriptor),
	}, nil
}

func validateDetachedObjectSnapshot(snapshot ObjectSnapshot) error {
	if snapshot.path == "" || snapshot.evidenceSHA256 == ([32]byte{}) ||
		snapshot.securityDescriptorSHA256 == ([32]byte{}) {
		return ErrFilesystem
	}
	if err := validateObjectSnapshot(snapshot.path, snapshot.evidence.SecurityMode, snapshot.evidence); err != nil {
		return err
	}
	if digestObjectSnapshot(snapshot.path, snapshot.evidence) != snapshot.evidenceSHA256 ||
		sha256.Sum256(snapshot.evidence.Security.SelfRelativeDescriptor) != snapshot.securityDescriptorSHA256 {
		return fmt.Errorf("%w: detached object digest mismatch for %s", ErrFilesystem, snapshot.path)
	}
	return nil
}

func validateObjectSnapshot(path string, expectedMode winfile.SecurityMode, evidence winfile.Evidence) error {
	if evidence.Kind != winfile.ObjectKindFile && evidence.Kind != winfile.ObjectKindDirectory {
		return fmt.Errorf("%w: %s reports an unknown object kind", ErrFilesystem, path)
	}
	if expectedMode != winfile.SecurityModeManaged &&
		expectedMode != winfile.SecurityModeAmbientAncestor &&
		expectedMode != winfile.SecurityModeRoleDataInherited {
		return fmt.Errorf("%w: %s requires an unknown security mode", ErrFilesystem, path)
	}
	if expectedMode == winfile.SecurityModeAmbientAncestor && evidence.Kind != winfile.ObjectKindDirectory {
		return fmt.Errorf("%w: ambient security mode requires a directory", ErrFilesystem)
	}
	if evidence.SecurityMode != expectedMode {
		return fmt.Errorf("%w: %s reports security mode %d, expected %d", ErrFilesystem, path, evidence.SecurityMode, expectedMode)
	}
	if evidence.Path.RequestedPath != path || !evidence.Path.TerminalComponentReparseFree ||
		evidence.Path.Ancestors != winfile.AncestorValidationNotPerformed {
		return fmt.Errorf("%w: %s lacks terminal handle-relative path evidence", ErrFilesystem, path)
	}
	if evidence.Path.FinalPathDiagnosticError != "" || evidence.Path.FinalPathDiagnostic != `\\?\`+path {
		return fmt.Errorf("%w: final handle path %q does not exactly match %q", ErrFilesystem, evidence.Path.FinalPathDiagnostic, path)
	}
	if evidence.Attributes&fileAttributeReparsePoint != 0 {
		return fmt.Errorf("%w: %w: %s", ErrFilesystem, winfile.ErrReparsePoint, path)
	}
	isDirectory := evidence.Attributes&fileAttributeDirectory != 0
	if isDirectory != (evidence.Kind == winfile.ObjectKindDirectory) {
		return fmt.Errorf("%w: %s kind disagrees with its directory attribute", ErrFilesystem, path)
	}
	if evidence.Identity.FileID == ([16]byte{}) {
		return fmt.Errorf("%w: %s has an empty filesystem identity", ErrFilesystem, path)
	}
	if evidence.Kind == winfile.ObjectKindFile && evidence.LinkCount != 1 {
		return fmt.Errorf("%w: %w: %s reports %d links", ErrFilesystem, winfile.ErrHardLinkedFile, path, evidence.LinkCount)
	}
	volume := evidence.Volume
	if !strings.EqualFold(volume.FileSystem, "NTFS") || volume.FileSystemFlags&filePersistentACLs == 0 ||
		volume.FileSystemFlags&fileReadOnlyVolume != 0 || !volume.PersistentACLs ||
		volume.DriveType != driveTypeFixed || volume.ReadOnly ||
		volume.RequiredUse != winfile.VolumeUseWritable {
		return fmt.Errorf("%w: %w: %s is not on writable fixed NTFS with persistent ACLs", ErrFilesystem, winfile.ErrUnsupportedVolume, path)
	}
	if !volume.PathIdentityCrossCheck || volume.HandleSerialNumber != volume.PathSerialNumber ||
		len(path) < 3 || volume.VolumePath != path[:3] {
		return fmt.Errorf("%w: %w: %s lacks a successful path-to-handle volume check", ErrFilesystem, winfile.ErrVolumeIdentityMismatch, path)
	}
	security := evidence.Security
	requiredControl := securityDACLPresent | securityDescriptorRelative
	if security.OwnerSID == "" || security.GroupSID == "" || !security.DACLPresent || security.DACLNull ||
		security.Control&requiredControl != requiredControl || len(security.SelfRelativeDescriptor) == 0 {
		return fmt.Errorf("%w: %w: %s has incomplete security descriptor evidence", ErrFilesystem, winfile.ErrUnsafeSecurityDescriptor, path)
	}
	protectedByControl := security.Control&securityDACLProtected != 0
	if security.DACLProtected != protectedByControl {
		return fmt.Errorf("%w: %w: %s has inconsistent DACL protection evidence", ErrFilesystem, winfile.ErrUnsafeSecurityDescriptor, path)
	}
	if expectedMode == winfile.SecurityModeManaged && (!security.DACLProtected ||
		security.OwnerDefaulted || security.GroupDefaulted || security.DACLDefaulted) {
		return fmt.Errorf("%w: %w: %s managed security is not protected and non-defaulted", ErrFilesystem, winfile.ErrUnsafeSecurityDescriptor, path)
	}
	if expectedMode == winfile.SecurityModeRoleDataInherited && (security.DACLProtected ||
		security.Control&securityDACLAutoInherited == 0) {
		return fmt.Errorf("%w: %w: %s role data security is not inherited", ErrFilesystem, winfile.ErrUnsafeSecurityDescriptor, path)
	}
	return nil
}
