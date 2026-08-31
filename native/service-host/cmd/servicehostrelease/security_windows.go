//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	windowsSystemSID         = "S-1-5-18"
	windowsAdministratorsSID = "S-1-5-32-544"
	windowsFileAllAccess     = uint32(0x001f01ff)
	windowsFileReadExecute   = uint32(0x001200a9)
	windowsObjectInherit     = uint32(0x1)
	windowsContainerInherit  = uint32(0x2)
	windowsAllowedACE        = uint8(0)
)

type windowsDirectoryPolicy struct {
	ownerSIDs  map[string]struct{}
	accessMask uint32
}

func secureTemporaryDirectory(path string) error {
	userSID, err := currentWindowsUserSID()
	if err != nil {
		return err
	}
	acl, retainedSIDs, err := buildWindowsDirectoryACL(userSID, windowsFileAllAccess)
	if err != nil {
		return err
	}
	securityInformation := windows.SECURITY_INFORMATION(
		windows.OWNER_SECURITY_INFORMATION |
			windows.DACL_SECURITY_INFORMATION |
			windows.PROTECTED_DACL_SECURITY_INFORMATION,
	)
	if err := windows.SetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		securityInformation,
		userSID,
		nil,
		acl,
		nil,
	); err != nil {
		return fmt.Errorf("protect Windows build directory: %w", err)
	}
	runtime.KeepAlive(retainedSIDs)
	return auditWindowsDirectory(path, windowsDirectoryPolicy{
		ownerSIDs:  map[string]struct{}{userSID.String(): {}},
		accessMask: windowsFileAllAccess,
	})
}

func validatePublishDirectory(path string) error {
	userSID, err := currentWindowsUserSID()
	if err != nil {
		return err
	}
	return auditWindowsDirectory(path, windowsDirectoryPolicy{
		ownerSIDs: map[string]struct{}{
			userSID.String(): {}, windowsSystemSID: {}, windowsAdministratorsSID: {},
		},
		accessMask: windowsFileAllAccess,
	})
}

func validateReadOnlyModuleCache(path string) error {
	return auditWindowsDirectory(path, windowsDirectoryPolicy{
		ownerSIDs: map[string]struct{}{
			windowsSystemSID: {}, windowsAdministratorsSID: {},
		},
		accessMask: windowsFileReadExecute,
	})
}

func validateAnchoredDirectoryInfo(info os.FileInfo, label string) error {
	if info == nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s is not a physical directory", label)
	}
	return nil
}

func validateSnapshotNodeInfo(info os.FileInfo, label string) error {
	if info == nil {
		return fmt.Errorf("source snapshot path %q has no file metadata", label)
	}
	return nil
}

func currentWindowsUserSID() (*windows.SID, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, fmt.Errorf("query current release-builder SID: %w", err)
	}
	if user == nil || user.User.Sid == nil || !user.User.Sid.IsValid() || user.User.Sid.String() == "" {
		return nil, errors.New("Windows returned an invalid release-builder SID")
	}
	if user.User.Sid.String() == windowsSystemSID || user.User.Sid.String() == windowsAdministratorsSID {
		return nil, errors.New("release builder must use a dedicated non-SYSTEM user identity")
	}
	return user.User.Sid, nil
}

func buildWindowsDirectoryACL(userSID *windows.SID, userMask uint32) (*windows.ACL, []*windows.SID, error) {
	systemSID, err := windows.StringToSid(windowsSystemSID)
	if err != nil {
		return nil, nil, err
	}
	administratorsSID, err := windows.StringToSid(windowsAdministratorsSID)
	if err != nil {
		return nil, nil, err
	}
	sids := []*windows.SID{systemSID, administratorsSID, userSID}
	masks := []uint32{windowsFileAllAccess, windowsFileAllAccess, userMask}
	entries := make([]windows.EXPLICIT_ACCESS, len(sids))
	for index, sid := range sids {
		entries[index] = windows.EXPLICIT_ACCESS{
			AccessPermissions: windows.ACCESS_MASK(masks[index]),
			AccessMode:        windows.SET_ACCESS,
			Inheritance:       windowsObjectInherit | windowsContainerInherit,
			Trustee: windows.TRUSTEE{
				TrusteeForm:  windows.TRUSTEE_IS_SID,
				TrusteeType:  windows.TRUSTEE_IS_UNKNOWN,
				TrusteeValue: windows.TrusteeValueFromSID(sid),
			},
		}
	}
	acl, err := windows.ACLFromEntries(entries, nil)
	runtime.KeepAlive(sids)
	if err != nil {
		return nil, nil, err
	}
	return acl, sids, nil
}

func auditWindowsDirectory(path string, policy windowsDirectoryPolicy) error {
	descriptor, err := windows.GetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION,
	)
	if err != nil {
		return fmt.Errorf("read Windows directory security: %w", err)
	}
	if descriptor == nil || !descriptor.IsValid() {
		return errors.New("Windows directory security descriptor is incomplete")
	}
	owner, _, err := descriptor.Owner()
	if err != nil {
		return fmt.Errorf("read Windows directory owner: %w", err)
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		return fmt.Errorf("read Windows directory DACL: %w", err)
	}
	if owner == nil || dacl == nil {
		return errors.New("Windows directory security descriptor is incomplete")
	}
	if _, exists := policy.ownerSIDs[owner.String()]; !exists {
		return fmt.Errorf("Windows directory owner %s is not approved", owner.String())
	}
	control, _, err := descriptor.Control()
	if err != nil {
		return fmt.Errorf("read Windows directory descriptor control: %w", err)
	}
	if control&windows.SE_DACL_PRESENT == 0 || control&windows.SE_DACL_PROTECTED == 0 || dacl.AceCount != 3 {
		return errors.New("Windows directory does not have the exact protected DACL")
	}
	expected := map[string]uint32{
		windowsSystemSID:         windowsFileAllAccess,
		windowsAdministratorsSID: windowsFileAllAccess,
	}
	userSID, err := currentWindowsUserSID()
	if err != nil {
		return err
	}
	expected[userSID.String()] = policy.accessMask
	seen := make(map[string]struct{}, len(expected))
	for index := uint32(0); index < uint32(dacl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, index, &ace); err != nil {
			return fmt.Errorf("read Windows directory ACE %d: %w", index, err)
		}
		if ace == nil {
			return fmt.Errorf("Windows directory ACE %d is null", index)
		}
		if ace.Header.AceType != windowsAllowedACE ||
			uint32(ace.Header.AceFlags) != windowsObjectInherit|windowsContainerInherit {
			return fmt.Errorf("Windows directory ACE %d has invalid type or flags", index)
		}
		sidOffset := int(unsafe.Offsetof(ace.SidStart))
		if int(ace.Header.AceSize) < sidOffset+8 {
			return fmt.Errorf("Windows directory ACE %d is too small for a SID", index)
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !sid.IsValid() {
			return fmt.Errorf("Windows directory ACE %d has an invalid SID", index)
		}
		if int(ace.Header.AceSize) != sidOffset+sid.Len() {
			return fmt.Errorf("Windows directory ACE %d has a noncanonical size", index)
		}
		value := sid.String()
		mask, exists := expected[value]
		if !exists || uint32(ace.Mask) != mask {
			return fmt.Errorf("Windows directory ACE for %s is not approved", value)
		}
		if _, duplicate := seen[value]; duplicate {
			return fmt.Errorf("Windows directory DACL repeats %s", value)
		}
		seen[value] = struct{}{}
	}
	runtime.KeepAlive(descriptor)
	if len(seen) != len(expected) {
		return errors.New("Windows directory DACL omits an approved principal")
	}
	return nil
}
