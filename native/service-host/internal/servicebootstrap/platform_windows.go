//go:build windows

package servicebootstrap

import (
	"errors"
	"fmt"
	"runtime"
	"unsafe"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winidentity"
	"golang.org/x/sys/windows"
)

const currentTokenOpenAccess = uint32(windows.TOKEN_QUERY | windows.READ_CONTROL | windows.WRITE_DAC)

// Prepare verifies the fixed service identity and protects the current process
// and primary-token DACLs for the selected role.
func Prepare(role config.Role) error {
	return productionPrepareGate.run(role, dependencies{
		platform:          windowsPlatform{},
		identityPreflight: winidentity.Preflight,
	})
}

type windowsPlatform struct{}

func (windowsPlatform) currentProcess() (daclTarget, uint32, error) {
	handle := windows.CurrentProcess()
	if handle == 0 {
		return nil, 0, errors.New("GetCurrentProcess returned a null pseudo-handle")
	}
	processID := windows.GetCurrentProcessId()
	if processID == 0 {
		return nil, 0, errors.New("GetCurrentProcessId returned zero")
	}
	return windowsKernelObject{handle: handle}, processID, nil
}

func (windowsPlatform) openCurrentPrimaryToken() (primaryToken, error) {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), currentTokenOpenAccess, &token); err != nil {
		return nil, err
	}
	if token == 0 {
		return nil, errors.New("OpenProcessToken returned a null handle")
	}
	result := &windowsPrimaryToken{handle: windows.Handle(token)}
	var tokenType uint32
	var returnedLength uint32
	if err := windows.GetTokenInformation(
		token,
		windows.TokenType,
		(*byte)(unsafe.Pointer(&tokenType)),
		uint32(unsafe.Sizeof(tokenType)),
		&returnedLength,
	); err != nil {
		return nil, errors.Join(fmt.Errorf("query current ServiceHost token type: %w", err), result.Close())
	}
	if returnedLength != uint32(unsafe.Sizeof(tokenType)) || tokenType != windows.TokenPrimary {
		return nil, errors.Join(
			fmt.Errorf("current ServiceHost token type is %d with length %d, want primary", tokenType, returnedLength),
			result.Close(),
		)
	}
	return result, nil
}

type windowsKernelObject struct {
	handle windows.Handle
}

func (object windowsKernelObject) applyAndReadBackDACL(policy daclPolicy) (daclEvidence, error) {
	return setAndReadBackWindowsDACL(object.handle, policy)
}

type windowsPrimaryToken struct {
	handle windows.Handle
}

func (token *windowsPrimaryToken) applyAndReadBackDACL(policy daclPolicy) (daclEvidence, error) {
	if token == nil || token.handle == 0 {
		return daclEvidence{}, errors.New("primary token is closed")
	}
	return setAndReadBackWindowsDACL(token.handle, policy)
}

func (token *windowsPrimaryToken) Close() error {
	if token == nil || token.handle == 0 {
		return nil
	}
	if err := windows.CloseHandle(token.handle); err != nil {
		return fmt.Errorf("close current ServiceHost primary token: %w", err)
	}
	token.handle = 0
	return nil
}

func setAndReadBackWindowsDACL(handle windows.Handle, policy daclPolicy) (daclEvidence, error) {
	acl, err := buildWindowsACL(policy)
	if err != nil {
		return daclEvidence{}, err
	}
	securityInformation := windows.SECURITY_INFORMATION(
		windows.DACL_SECURITY_INFORMATION | windows.PROTECTED_DACL_SECURITY_INFORMATION,
	)
	if err := windows.SetSecurityInfo(handle, windows.SE_KERNEL_OBJECT, securityInformation, nil, nil, acl, nil); err != nil {
		return daclEvidence{}, fmt.Errorf("SetSecurityInfo protected DACL: %w", err)
	}
	runtime.KeepAlive(acl)
	return readWindowsDACL(handle)
}

func buildWindowsACL(policy daclPolicy) (*windows.ACL, error) {
	explicitEntries := make([]windows.EXPLICIT_ACCESS, len(policy.entries))
	sids := make([]*windows.SID, len(policy.entries))
	for index, entry := range policy.entries {
		sid, err := windows.StringToSid(entry.sid)
		if err != nil || sid == nil || !sid.IsValid() || sid.String() != entry.sid {
			return nil, fmt.Errorf("Windows rejected canonical SID %s", entry.sid)
		}
		sids[index] = sid
		explicitEntries[index] = windows.EXPLICIT_ACCESS{
			AccessPermissions: windows.ACCESS_MASK(entry.mask),
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
	return acl, err
}

func readWindowsDACL(handle windows.Handle) (daclEvidence, error) {
	descriptor, err := windows.GetSecurityInfo(handle, windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return daclEvidence{}, fmt.Errorf("GetSecurityInfo DACL: %w", err)
	}
	if descriptor == nil || !descriptor.IsValid() {
		return daclEvidence{}, errors.New("GetSecurityInfo returned a missing or invalid descriptor")
	}
	control, _, err := descriptor.Control()
	if err != nil {
		return daclEvidence{}, fmt.Errorf("read security descriptor control: %w", err)
	}
	evidence := daclEvidence{
		control:   uint16(control),
		present:   control&windows.SE_DACL_PRESENT != 0,
		protected: control&windows.SE_DACL_PROTECTED != 0,
	}
	dacl, defaulted, err := descriptor.DACL()
	if errors.Is(err, windows.ERROR_OBJECT_NOT_FOUND) {
		return evidence, nil
	}
	if err != nil {
		return daclEvidence{}, fmt.Errorf("read security descriptor DACL: %w", err)
	}
	evidence.null = dacl == nil
	evidence.defaulted = defaulted
	if dacl != nil {
		evidence.accessRules = make([]accessEntry, 0, int(dacl.AceCount))
		for index := uint32(0); index < uint32(dacl.AceCount); index++ {
			entry, err := readWindowsAllowedACE(dacl, index)
			if err != nil {
				return daclEvidence{}, err
			}
			evidence.accessRules = append(evidence.accessRules, entry)
		}
	}
	runtime.KeepAlive(descriptor)
	return evidence, nil
}

func readWindowsAllowedACE(acl *windows.ACL, index uint32) (accessEntry, error) {
	var ace *windows.ACCESS_ALLOWED_ACE
	if err := windows.GetAce(acl, index, &ace); err != nil {
		return accessEntry{}, fmt.Errorf("read DACL ACE %d: %w", index, err)
	}
	if ace == nil {
		return accessEntry{}, fmt.Errorf("DACL ACE %d is null", index)
	}
	if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
		return accessEntry{}, fmt.Errorf("DACL ACE %d is not an access-allowed ACE", index)
	}
	sidOffset := int(unsafe.Offsetof(ace.SidStart))
	if int(ace.Header.AceSize) < sidOffset+8 {
		return accessEntry{}, fmt.Errorf("DACL ACE %d is too small for a SID", index)
	}
	sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
	if !sid.IsValid() || sid.String() == "" || int(ace.Header.AceSize) != sidOffset+sid.Len() {
		return accessEntry{}, fmt.Errorf("DACL ACE %d contains a noncanonical SID", index)
	}
	return accessEntry{
		sid: sid.String(), mask: uint32(ace.Mask), aceType: ace.Header.AceType, flags: ace.Header.AceFlags,
	}, nil
}
