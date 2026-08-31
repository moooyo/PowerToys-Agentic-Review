package winacl

import (
	"fmt"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

// Audit reparses evidence from its self-relative descriptor and applies one
// closed filesystem policy profile. It never treats detached metadata alone as
// authorization evidence.
func Audit(
	evidence winfile.SecurityDescriptorEvidence,
	kind winfile.ObjectKind,
	profile PolicyProfile,
) error {
	if err := validateProfile(profile, kind); err != nil {
		return err
	}
	parsed, err := parseSecurityDescriptor(evidence)
	if err != nil {
		return err
	}
	if profile.kind == ProfileAmbientAncestor {
		return auditAmbient(parsed)
	}
	if profile.kind == ProfileManagedRoleDataBoundaryDirectory {
		return auditRoleDataBoundary(parsed, profile)
	}
	if profile.kind == ProfileInheritedRoleDataDirectory || profile.kind == ProfileInheritedRoleDataFile {
		return auditInheritedRoleData(parsed, profile)
	}
	return auditManaged(parsed, profile)
}

type expectedACE struct {
	flags uint8
	mask  winfile.AccessMask
	sid   string
}

type expectedACEKey struct {
	flags uint8
	sid   string
}

func auditRoleDataBoundary(descriptor parsedDescriptor, profile PolicyProfile) error {
	if descriptor.ownerSID != localSystemSID && descriptor.ownerSID != builtinAdministratorsSID {
		return rejected("role data boundary has unexpected owner %s", descriptor.ownerSID)
	}
	if descriptor.groupSID != localSystemSID && descriptor.groupSID != builtinAdministratorsSID {
		return rejected("role data boundary has unexpected group %s", descriptor.groupSID)
	}
	if descriptor.ownerDefaulted || descriptor.groupDefaulted || descriptor.daclDefaulted {
		return rejected("role data boundary has defaulted owner, group, or DACL metadata")
	}
	if !descriptor.daclProtected || descriptor.control&securityDACLAutoInherited != 0 {
		return rejected("role data boundary DACL is not protected and explicit")
	}
	return auditExactACEs(descriptor, []expectedACE{
		{flags: aceObjectInherit | aceContainerInherit, mask: fileAllAccess, sid: localSystemSID},
		{flags: aceObjectInherit | aceContainerInherit, mask: fileAllAccess, sid: builtinAdministratorsSID},
		{mask: managedBoundaryDirectoryModify, sid: profile.controlSID},
		{flags: aceObjectInherit | aceInheritOnly, mask: managedFileModify, sid: profile.controlSID},
		{flags: aceContainerInherit | aceInheritOnly, mask: managedDirectoryModify, sid: profile.controlSID},
		{flags: aceObjectInherit | aceContainerInherit | aceInheritOnly, mask: readControl, sid: ownerRightsSID},
	})
}

func auditInheritedRoleData(descriptor parsedDescriptor, profile PolicyProfile) error {
	if descriptor.ownerSID != profile.controlSID {
		return rejected("inherited role data object has unexpected owner %s", descriptor.ownerSID)
	}
	// Defaulted metadata bits vary across ordinary CreateFile call paths. They
	// do not grant access; the exact owner, auto-inheritance state, and raw ACE
	// tuples below form the authorization contract.
	if descriptor.daclProtected || descriptor.control&securityDACLAutoInherited == 0 {
		return rejected("role data object DACL is not unprotected and auto-inherited")
	}
	if profile.kind == ProfileInheritedRoleDataFile {
		return auditExactACEs(descriptor, []expectedACE{
			{flags: aceInherited, mask: fileAllAccess, sid: localSystemSID},
			{flags: aceInherited, mask: fileAllAccess, sid: builtinAdministratorsSID},
			{flags: aceInherited, mask: managedFileModify, sid: profile.controlSID},
			{flags: aceInherited, mask: readControl, sid: ownerRightsSID},
		})
	}
	return auditExactACEs(descriptor, []expectedACE{
		{flags: aceObjectInherit | aceContainerInherit | aceInherited, mask: fileAllAccess, sid: localSystemSID},
		{flags: aceObjectInherit | aceContainerInherit | aceInherited, mask: fileAllAccess, sid: builtinAdministratorsSID},
		{flags: aceObjectInherit | aceInheritOnly | aceInherited, mask: managedFileModify, sid: profile.controlSID},
		{flags: aceContainerInherit | aceInherited, mask: managedDirectoryModify, sid: profile.controlSID},
		{flags: aceObjectInherit | aceContainerInherit | aceInherited, mask: readControl, sid: ownerRightsSID},
	})
}

func auditExactACEs(descriptor parsedDescriptor, expected []expectedACE) error {
	if descriptor.aclRevision != 2 {
		return rejected("role data ACL revision is %d, want 2", descriptor.aclRevision)
	}
	if len(descriptor.aces) != len(expected) {
		return rejected("role data DACL has %d ACEs, want %d", len(descriptor.aces), len(expected))
	}
	wanted := make(map[expectedACEKey]winfile.AccessMask, len(expected))
	for _, entry := range expected {
		key := expectedACEKey{flags: entry.flags, sid: entry.sid}
		if _, duplicate := wanted[key]; duplicate {
			return fmt.Errorf("%w: role data profile repeats an expected ACE", ErrInvalidProfile)
		}
		wanted[key] = entry.mask
	}
	for index, ace := range descriptor.aces {
		if ace.aceType != accessAllowedACEType {
			return rejected("role data ACE %d is not access-allowed", index)
		}
		key := expectedACEKey{flags: ace.flags, sid: ace.sid}
		mask, exists := wanted[key]
		if !exists {
			return rejected("role data ACE %d has unexpected trustee or flags", index)
		}
		if ace.rawMask != mask {
			return rejected("role data ACE %d has raw mask 0x%x, want 0x%x", index, ace.rawMask, mask)
		}
		delete(wanted, key)
	}
	if len(wanted) != 0 {
		return rejected("role data DACL is missing an expected ACE")
	}
	return nil
}

func auditAmbient(descriptor parsedDescriptor) error {
	if !isAmbientTrustedOwner(descriptor.ownerSID) {
		return rejected("ambient ancestor has untrusted owner %s", descriptor.ownerSID)
	}
	if descriptor.ownerDefaulted || descriptor.groupDefaulted || descriptor.daclDefaulted {
		return rejected("ambient ancestor has defaulted owner, group, or DACL metadata")
	}
	for index, ace := range descriptor.aces {
		if ace.sid == creatorOwnerSID {
			if ace.flags&aceInheritOnly == 0 ||
				ace.flags&(aceObjectInherit|aceContainerInherit) == 0 ||
				ace.appliesToSelf {
				return rejected("ambient CREATOR OWNER ACE %d is not inherit-only", index)
			}
			continue
		}
		if ace.flags&aceInheritOnly != 0 {
			return rejected("ambient inherit-only ACE %d is not for CREATOR OWNER", index)
		}
		if ace.aceType == accessDeniedACEType {
			continue
		}
		if !ace.appliesToSelf || isAmbientMutationTrustee(ace.sid) {
			continue
		}
		if dangerous := ace.mask & ambientForbiddenAccess; dangerous != 0 {
			return rejected(
				"ambient allow ACE %d grants dangerous access 0x%x to %s",
				index,
				dangerous,
				ace.sid,
			)
		}
	}
	return nil
}

func auditManaged(descriptor parsedDescriptor, profile PolicyProfile) error {
	if descriptor.ownerSID != localSystemSID && descriptor.ownerSID != builtinAdministratorsSID {
		return rejected("managed object has unexpected owner %s", descriptor.ownerSID)
	}
	if descriptor.groupSID != localSystemSID && descriptor.groupSID != builtinAdministratorsSID {
		return rejected("managed object has unexpected group %s", descriptor.groupSID)
	}
	if descriptor.ownerDefaulted || descriptor.groupDefaulted || descriptor.daclDefaulted {
		return rejected("managed object has defaulted owner, group, or DACL metadata")
	}
	if !descriptor.daclProtected {
		return rejected("managed object DACL is not protected")
	}
	if descriptor.aclRevision != 2 {
		return rejected("managed object ACL revision is %d, want 2", descriptor.aclRevision)
	}

	expected := managedEntries(profile)
	if len(descriptor.aces) != len(expected) {
		return rejected("managed DACL has %d ACEs, want %d", len(descriptor.aces), len(expected))
	}
	seen := make(map[string]struct{}, len(descriptor.aces))
	for index, ace := range descriptor.aces {
		if ace.aceType != accessAllowedACEType {
			return rejected("managed ACE %d is not access-allowed", index)
		}
		if ace.flags != 0 || ace.appliesToChildFile || ace.appliesToChildDir || !ace.appliesToSelf {
			return rejected("managed ACE %d has inheritance flags 0x%x", index, ace.flags)
		}
		wanted, exists := expected[ace.sid]
		if !exists {
			return rejected("managed ACE %d has unexpected trustee %s", index, ace.sid)
		}
		if _, duplicate := seen[ace.sid]; duplicate {
			return rejected("managed DACL repeats trustee %s", ace.sid)
		}
		seen[ace.sid] = struct{}{}
		if ace.mask != wanted {
			return rejected(
				"managed ACE %d grants 0x%x to %s, want 0x%x",
				index,
				ace.mask,
				ace.sid,
				wanted,
			)
		}
	}
	return nil
}

func managedEntries(profile PolicyProfile) map[string]winfile.AccessMask {
	entries := map[string]winfile.AccessMask{
		localSystemSID:           fileAllAccess,
		builtinAdministratorsSID: fileAllAccess,
	}
	if access := managedServiceAccess(profile.kind, profile.controlAccess); access != 0 {
		entries[profile.controlSID] = access
	}
	if access := managedServiceAccess(profile.kind, profile.executorAccess); access != 0 {
		entries[profile.executorSID] = access
	}
	return entries
}

func managedServiceAccess(kind ProfileKind, access AccessClass) winfile.AccessMask {
	if kind == ProfileManagedInstallationDirectory || kind == ProfileManagedTrustedDirectory ||
		kind == ProfileManagedProductAnchorDirectory {
		return managedDirectoryRead
	}
	switch access {
	case AccessNone:
		return 0
	case AccessRead:
		return fileGenericRead
	case AccessReadExecute:
		return fileGenericRead | fileGenericExecute
	default:
		return 0
	}
}

func isAmbientTrustedOwner(sid string) bool {
	return sid == localSystemSID || sid == builtinAdministratorsSID || sid == trustedInstallerSID
}

func isAmbientMutationTrustee(sid string) bool {
	return sid == localSystemSID || sid == builtinAdministratorsSID || sid == trustedInstallerSID
}

func rejected(format string, arguments ...any) error {
	return fmt.Errorf("%w: %s", ErrPolicyRejected, fmt.Sprintf(format, arguments...))
}
