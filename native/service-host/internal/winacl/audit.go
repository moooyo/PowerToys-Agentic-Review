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
	return auditManaged(parsed, profile)
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
	if kind == ProfileManagedInstallationDirectory || kind == ProfileManagedTrustedDirectory {
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
