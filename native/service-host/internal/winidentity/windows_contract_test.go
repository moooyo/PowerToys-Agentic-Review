//go:build windows

package winidentity

import (
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestWindowsConstantsMatchReviewedIdentityContract(t *testing.T) {
	if serviceManagerConnectAccess != windows.SC_MANAGER_CONNECT {
		t.Fatal("SCM access is not exactly SC_MANAGER_CONNECT")
	}
	if serviceQueryConfigAccess != windows.SERVICE_QUERY_CONFIG {
		t.Fatal("service access is not exactly SERVICE_QUERY_CONFIG")
	}
	if serviceSIDInfoLevel != windows.SERVICE_CONFIG_SERVICE_SID_INFO {
		t.Fatal("service SID query does not use SERVICE_CONFIG_SERVICE_SID_INFO")
	}
	if uint32(ServiceSIDTypeRestricted) != windows.SERVICE_SID_TYPE_RESTRICTED {
		t.Fatal("restricted service SID type does not match Windows")
	}
	if tokenQueryAccess != windows.TOKEN_QUERY {
		t.Fatal("process token access is not exactly TOKEN_QUERY")
	}
	if tokenPrimaryType != windows.TokenPrimary {
		t.Fatal("primary token type does not match Windows")
	}
	if serviceSIDAccountType != windows.SidTypeWellKnownGroup {
		t.Fatal("service SID account type does not match SidTypeWellKnownGroup")
	}
	if serviceWin32OwnProcessType != windows.SERVICE_WIN32_OWN_PROCESS {
		t.Fatal("service type does not match SERVICE_WIN32_OWN_PROCESS")
	}
	if groupMandatory != windows.SE_GROUP_MANDATORY ||
		groupEnabledByDefault != windows.SE_GROUP_ENABLED_BY_DEFAULT ||
		groupEnabled != windows.SE_GROUP_ENABLED ||
		groupUseForDenyOnly != windows.SE_GROUP_USE_FOR_DENY_ONLY ||
		groupLogonID != windows.SE_GROUP_LOGON_ID ||
		groupValidAttributes != windows.SE_GROUP_VALID_ATTRIBUTES {
		t.Fatal("token group attributes do not match Windows")
	}
	if privilegeEnabled != windows.SE_PRIVILEGE_ENABLED ||
		privilegeValidAttributes != windows.SE_PRIVILEGE_VALID_ATTRIBUTES {
		t.Fatal("token privilege attributes do not match Windows")
	}
}

func TestWindowsIdentityBuffersAndABIStayBounded(t *testing.T) {
	if unsafe.Sizeof(serviceSIDInfo{}) != serviceSIDInfoSize {
		t.Fatalf("SERVICE_SID_INFO size is %d", unsafe.Sizeof(serviceSIDInfo{}))
	}
	if unsafe.Sizeof(tokenStatistics{}) != tokenStatisticsSize {
		t.Fatalf("TOKEN_STATISTICS size is %d", unsafe.Sizeof(tokenStatistics{}))
	}
	if unsafe.Offsetof(tokenStatistics{}.ModifiedID) != 48 {
		t.Fatalf("TOKEN_STATISTICS ModifiedId offset is %d", unsafe.Offsetof(tokenStatistics{}.ModifiedID))
	}
	if maximumSIDBytes != 68 || maximumAccountDomainUnits > 1024 || maximumPrivilegeNameUnits > 1024 {
		t.Fatal("fixed identity lookup buffers are no longer narrowly bounded")
	}
	if maximumServiceConfigBytes > 64*1024 || maximumServiceAccountUnits > 512 {
		t.Fatal("service configuration buffers are no longer narrowly bounded")
	}
	if maximumTokenInformationBytes > 1024*1024 ||
		maximumTokenSIDEntries > 4096 || maximumTokenPrivilegeEntries > 4096 ||
		maximumTokenInformationAttempts > 3 {
		t.Fatal("variable token queries are no longer narrowly bounded")
	}
}

func TestHighRiskPrivilegePolicyIncludesRequiredBoundaryPrivileges(t *testing.T) {
	required := []string{
		"SeAssignPrimaryTokenPrivilege",
		"SeBackupPrivilege",
		"SeCreateTokenPrivilege",
		"SeDebugPrivilege",
		"SeImpersonatePrivilege",
		"SeLoadDriverPrivilege",
		"SeRestorePrivilege",
		"SeTakeOwnershipPrivilege",
		"SeTcbPrivilege",
	}
	for _, name := range required {
		if _, present := forbiddenPrivilegeNames[name]; !present {
			t.Fatalf("high-risk privilege policy omits %s", name)
		}
	}
}
