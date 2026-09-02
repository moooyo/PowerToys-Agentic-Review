//go:build windows

package releasepackage

import (
	"runtime"
	"testing"
	"unsafe"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
	"golang.org/x/sys/windows"
)

const approvalReaderTestSID = "S-1-5-21-1-2-3-1001"

func TestReleaseEntryRejectsAnyThreadImpersonationToken(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := requireNoReleaseThreadToken(); err != nil {
		t.Fatalf("test thread unexpectedly began impersonating: %v", err)
	}
	if err := windows.ImpersonateSelf(windows.SecurityImpersonation); err != nil {
		t.Fatalf("ImpersonateSelf returned an error: %v", err)
	}
	defer func() {
		if err := windows.RevertToSelf(); err != nil {
			t.Fatalf("RevertToSelf returned an error: %v", err)
		}
	}()
	if err := requireNoReleaseThreadToken(); err == nil {
		t.Fatal("release entry accepted an impersonation token")
	}
}

func TestApprovalACLRequiresExactThreePrincipalPolicy(t *testing.T) {
	file := approvalSecurityFixture(t,
		"O:SYG:SYD:P"+
			"(A;;0x001f01ff;;;SY)"+
			"(A;;0x001f01ff;;;BA)"+
			"(A;;0x00120089;;;"+approvalReaderTestSID+")",
	)
	if err := auditApprovalACL(file, approvalReaderTestSID, false); err != nil {
		t.Fatal(err)
	}
	directory := approvalSecurityFixture(t,
		"O:BAG:SYD:P"+
			"(A;OICI;0x001f01ff;;;SY)"+
			"(A;OICI;0x001f01ff;;;BA)"+
			"(A;OICI;0x001200a9;;;"+approvalReaderTestSID+")",
	)
	if err := auditApprovalACL(directory, approvalReaderTestSID, true); err != nil {
		t.Fatal(err)
	}

	for _, sddl := range []string{
		"O:SYG:SYD:P(A;;0x001f01ff;;;SY)(A;;0x001f01ff;;;BA)(A;;0x00120116;;;" + approvalReaderTestSID + ")",
		"O:SYG:SYD:P(A;;0x001f01ff;;;SY)(A;;0x001f01ff;;;BA)(A;;0x00120089;;;" + approvalReaderTestSID + ")(A;;FR;;;WD)",
		"O:SYG:SYD:P(A;;0x001f01ff;;;SY)(A;;0x001f01ff;;;BA)(A;CI;0x00120089;;;" + approvalReaderTestSID + ")",
		"O:" + approvalReaderTestSID + "G:SYD:P(A;;0x001f01ff;;;SY)(A;;0x001f01ff;;;BA)(A;;0x00120089;;;" + approvalReaderTestSID + ")",
	} {
		if err := auditApprovalACL(approvalSecurityFixture(t, sddl), approvalReaderTestSID, false); err == nil {
			t.Fatalf("unsafe approval DACL was accepted: %s", sddl)
		}
	}
}

func approvalSecurityFixture(t *testing.T, sddl string) winfile.SecurityDescriptorEvidence {
	t.Helper()
	descriptor, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		t.Fatal(err)
	}
	control, revision, err := descriptor.Control()
	if err != nil {
		t.Fatal(err)
	}
	owner, ownerDefaulted, err := descriptor.Owner()
	if err != nil {
		t.Fatal(err)
	}
	group, groupDefaulted, err := descriptor.Group()
	if err != nil {
		t.Fatal(err)
	}
	_, daclDefaulted, err := descriptor.DACL()
	if err != nil {
		t.Fatal(err)
	}
	length := descriptor.Length()
	data := append([]byte(nil), unsafe.Slice((*byte)(unsafe.Pointer(descriptor)), int(length))...)
	return winfile.SecurityDescriptorEvidence{
		OwnerSID:               owner.String(),
		GroupSID:               group.String(),
		OwnerDefaulted:         ownerDefaulted,
		GroupDefaulted:         groupDefaulted,
		DACLPresent:            control&windows.SE_DACL_PRESENT != 0,
		DACLDefaulted:          daclDefaulted,
		DACLProtected:          control&windows.SE_DACL_PROTECTED != 0,
		Control:                uint16(control),
		Revision:               revision,
		SelfRelativeDescriptor: data,
	}
}
