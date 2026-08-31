//go:build windows

package secureconfig

import (
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
	"golang.org/x/sys/windows"
)

func TestWindowsConstantsMatchReviewedFilesystemContract(t *testing.T) {
	if fileAttributeReparsePoint != windows.FILE_ATTRIBUTE_REPARSE_POINT {
		t.Fatal("reparse-point attribute does not match Windows")
	}
	if driveTypeFixed != windows.DRIVE_FIXED {
		t.Fatal("fixed-drive type does not match Windows")
	}
	if filePersistentACLs != windows.FILE_PERSISTENT_ACLS {
		t.Fatal("persistent-ACL flag does not match Windows")
	}
	if securityDACLPresent != uint16(windows.SE_DACL_PRESENT) ||
		securityDACLProtected != uint16(windows.SE_DACL_PROTECTED) ||
		securityDescriptorRelative != uint16(windows.SE_SELF_RELATIVE) {
		t.Fatal("security descriptor control constants do not match Windows")
	}
	if genericReadAccess != winfile.AccessMask(windows.GENERIC_READ) ||
		genericWriteAccess != winfile.AccessMask(windows.GENERIC_WRITE) ||
		genericExecuteAccess != winfile.AccessMask(windows.GENERIC_EXECUTE) ||
		genericAllAccess != winfile.AccessMask(windows.GENERIC_ALL) {
		t.Fatal("generic access constants do not match Windows")
	}
	if maximumAllowedAccess != winfile.AccessMask(windows.MAXIMUM_ALLOWED) {
		t.Fatal("maximum-allowed constant does not match Windows")
	}
}

func TestWindowsBackendSatisfiesRetainedHandleContracts(t *testing.T) {
	var _ fileBackend = windowsBackend{}
	var _ directoryHandle = (*winfile.Directory)(nil)
	var _ fileHandle = (*winfile.File)(nil)
	var _ SecurityPolicy = (*ExpectedSecurityPolicy)(nil)
}
