//go:build windows

package servicebootstrap

import (
	"testing"

	"golang.org/x/sys/windows"
)

func TestWindowsAccessConstantsMatchPolicyContract(t *testing.T) {
	if genericAllAccessMask != uint32(windows.GENERIC_ALL) ||
		processQueryLimitedAccessMask != uint32(windows.PROCESS_QUERY_LIMITED_INFORMATION) ||
		synchronizeAccessMask != uint32(windows.SYNCHRONIZE) ||
		tokenQueryAccessMask != uint32(windows.TOKEN_QUERY) ||
		securityDescriptorDACLPresent != uint16(windows.SE_DACL_PRESENT) ||
		securityDescriptorDACLProtected != uint16(windows.SE_DACL_PROTECTED) ||
		accessAllowedACEType != uint8(windows.ACCESS_ALLOWED_ACE_TYPE) {
		t.Fatal("ServiceHost bootstrap constants differ from the Windows SDK contract")
	}
}
