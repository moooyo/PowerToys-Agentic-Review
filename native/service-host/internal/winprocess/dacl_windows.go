//go:build windows

package winprocess

import (
	"errors"
	"fmt"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

type preparedNodeDACLs struct {
	processACL    *windows.ACL
	processPolicy daclPolicy
	tokenACL      *windows.ACL
	tokenPolicy   daclPolicy
}

func prepareNodeDACLs(spec NodeLaunchSpec) (preparedNodeDACLs, error) {
	processPolicy, tokenPolicy, err := nodeDACLPolicies(spec.OwnServiceSID, spec.PeerServiceSID)
	if err != nil {
		return preparedNodeDACLs{}, err
	}
	processACL, err := buildACL(processPolicy)
	if err != nil {
		return preparedNodeDACLs{}, fmt.Errorf("build Node process DACL: %w", err)
	}
	tokenACL, err := buildACL(tokenPolicy)
	if err != nil {
		return preparedNodeDACLs{}, fmt.Errorf("build Node primary-token DACL: %w", err)
	}
	return preparedNodeDACLs{
		processACL:    processACL,
		processPolicy: processPolicy,
		tokenACL:      tokenACL,
		tokenPolicy:   tokenPolicy,
	}, nil
}

func buildACL(policy daclPolicy) (*windows.ACL, error) {
	explicitEntries := make([]windows.EXPLICIT_ACCESS, len(policy.entries))
	sids := make([]*windows.SID, len(policy.entries))
	for index, policyEntry := range policy.entries {
		sid, err := windows.StringToSid(policyEntry.SID)
		if err != nil || sid == nil || !sid.IsValid() || sid.String() != policyEntry.SID {
			return nil, fmt.Errorf("Windows rejected canonical SID %s", policyEntry.SID)
		}
		sids[index] = sid
		explicitEntries[index] = windows.EXPLICIT_ACCESS{
			AccessPermissions: windows.ACCESS_MASK(policyEntry.Mask),
			AccessMode:        windows.SET_ACCESS,
			Inheritance:       windows.NO_INHERITANCE,
			Trustee: windows.TRUSTEE{
				TrusteeForm:  windows.TRUSTEE_IS_SID,
				TrusteeType:  windows.TRUSTEE_IS_UNKNOWN,
				TrusteeValue: windows.TrusteeValueFromSID(sid),
			},
		}
	}
	acl, err := windows.ACLFromEntries(explicitEntries, nil)
	runtime.KeepAlive(sids)
	if err != nil {
		return nil, err
	}
	return acl, nil
}

func applyAndVerifyNodeDACLs(process windows.Handle, prepared preparedNodeDACLs) (err error) {
	if err := setAndVerifyKernelObjectDACL(
		process,
		prepared.processACL,
		prepared.processPolicy,
		"Node process object",
	); err != nil {
		return err
	}

	var token windows.Token
	desiredAccess := uint32(windows.READ_CONTROL | windows.WRITE_DAC | windows.TOKEN_QUERY)
	if err := windows.OpenProcessToken(process, desiredAccess, &token); err != nil {
		return fmt.Errorf("open Node primary token for DACL protection: %w", err)
	}
	defer func() {
		if closeErr := token.Close(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close Node primary token handle: %w", closeErr))
		}
	}()

	var tokenType uint32
	var returnedLength uint32
	if err := windows.GetTokenInformation(
		token,
		windows.TokenType,
		(*byte)(unsafe.Pointer(&tokenType)),
		uint32(unsafe.Sizeof(tokenType)),
		&returnedLength,
	); err != nil {
		return fmt.Errorf("verify Node token type: %w", err)
	}
	if returnedLength != uint32(unsafe.Sizeof(tokenType)) || tokenType != windows.TokenPrimary {
		return fmt.Errorf("Node token type is %d with length %d, want primary token", tokenType, returnedLength)
	}
	if err := setAndVerifyKernelObjectDACL(
		windows.Handle(token),
		prepared.tokenACL,
		prepared.tokenPolicy,
		"Node primary token",
	); err != nil {
		return err
	}
	runtime.KeepAlive(prepared)
	return nil
}

func setAndVerifyKernelObjectDACL(
	handle windows.Handle,
	acl *windows.ACL,
	policy daclPolicy,
	objectName string,
) error {
	securityInformation := windows.SECURITY_INFORMATION(
		windows.DACL_SECURITY_INFORMATION | windows.PROTECTED_DACL_SECURITY_INFORMATION,
	)
	if err := windows.SetSecurityInfo(
		handle,
		windows.SE_KERNEL_OBJECT,
		securityInformation,
		nil,
		nil,
		acl,
		nil,
	); err != nil {
		return fmt.Errorf("set protected %s DACL: %w", objectName, err)
	}
	runtime.KeepAlive(acl)
	if err := verifyKernelObjectDACL(handle, policy); err != nil {
		return fmt.Errorf("verify protected %s DACL: %w", objectName, err)
	}
	return nil
}

func verifyKernelObjectDACL(handle windows.Handle, policy daclPolicy) error {
	descriptor, err := windows.GetSecurityInfo(
		handle,
		windows.SE_KERNEL_OBJECT,
		windows.DACL_SECURITY_INFORMATION,
	)
	if err != nil {
		return fmt.Errorf("GetSecurityInfo: %w", err)
	}
	if descriptor == nil || !descriptor.IsValid() {
		return errors.New("GetSecurityInfo returned a missing or invalid security descriptor")
	}
	control, _, err := descriptor.Control()
	if err != nil {
		return fmt.Errorf("read security descriptor control: %w", err)
	}
	evidence := daclEvidence{control: uint16(control)}
	dacl, defaulted, err := descriptor.DACL()
	if errors.Is(err, windows.ERROR_OBJECT_NOT_FOUND) {
		return validateProtectedDACL(evidence, policy)
	}
	if err != nil {
		return fmt.Errorf("read security descriptor DACL: %w", err)
	}
	evidence.nullDACL = dacl == nil
	evidence.defaulted = defaulted
	if dacl != nil {
		evidence.entries = make([]daclEntry, 0, int(dacl.AceCount))
		for index := uint32(0); index < uint32(dacl.AceCount); index++ {
			entry, err := readAllowedACE(dacl, index)
			if err != nil {
				return err
			}
			evidence.entries = append(evidence.entries, entry)
		}
	}
	runtime.KeepAlive(descriptor)
	return validateProtectedDACL(evidence, policy)
}

func readAllowedACE(acl *windows.ACL, index uint32) (daclEntry, error) {
	var ace *windows.ACCESS_ALLOWED_ACE
	if err := windows.GetAce(acl, index, &ace); err != nil {
		return daclEntry{}, fmt.Errorf("read DACL ACE %d: %w", index, err)
	}
	if ace == nil {
		return daclEntry{}, fmt.Errorf("DACL ACE %d is null", index)
	}
	sidOffset := int(unsafe.Offsetof(ace.SidStart))
	if int(ace.Header.AceSize) < sidOffset+8 {
		return daclEntry{}, fmt.Errorf("DACL ACE %d is too small for a SID", index)
	}
	sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
	if !sid.IsValid() || sid.String() == "" {
		return daclEntry{}, fmt.Errorf("DACL ACE %d contains an invalid SID", index)
	}
	if int(ace.Header.AceSize) != sidOffset+sid.Len() {
		return daclEntry{}, fmt.Errorf("DACL ACE %d has a noncanonical size", index)
	}
	return daclEntry{
		SID:     sid.String(),
		Mask:    uint32(ace.Mask),
		ACEType: ace.Header.AceType,
		Flags:   ace.Header.AceFlags,
	}, nil
}
