//go:build windows

package secureconfig

import (
	"errors"
	"runtime"
	"testing"
	"unsafe"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
	"golang.org/x/sys/windows"
)

func TestExpectedSecurityPolicyOwnsTokenDuplicates(t *testing.T) {
	var source windows.Token
	if err := windows.OpenProcessToken(
		windows.CurrentProcess(),
		windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE,
		&source,
	); err != nil {
		t.Fatalf("OpenProcessToken returned an error: %v", err)
	}
	stable, err := winfile.NewStableAccessToken(source)
	if closeErr := source.Close(); err != nil || closeErr != nil {
		t.Fatalf("NewStableAccessToken or source Close failed: %v, %v", err, closeErr)
	}

	descriptor, err := windows.SecurityDescriptorFromString("O:SYG:SYD:P(A;;GR;;;WD)")
	if err != nil {
		t.Fatalf("SecurityDescriptorFromString returned an error: %v", err)
	}
	descriptorBytes := append(
		[]byte(nil),
		unsafe.Slice((*byte)(unsafe.Pointer(descriptor)), int(descriptor.Length()))...,
	)
	runtime.KeepAlive(descriptor)
	security := winfile.SecurityDescriptorEvidence{
		OwnerSID:               "S-1-5-18",
		GroupSID:               "S-1-5-18",
		DACLPresent:            true,
		DACLProtected:          true,
		Control:                uint16(windows.SE_DACL_PRESENT | windows.SE_DACL_PROTECTED | windows.SE_SELF_RELATIVE),
		Revision:               1,
		SelfRelativeDescriptor: descriptorBytes,
	}
	object := ObjectEvidence{
		Path:                     `C:\trusted`,
		Evidence:                 winfile.Evidence{Security: security},
		SecurityDescriptorSHA256: DigestSecurityDescriptor(descriptorBytes),
	}
	mapping := winfile.GenericMapping{
		Read:    winfile.AccessMask(windows.FILE_GENERIC_READ),
		Write:   winfile.AccessMask(windows.FILE_GENERIC_WRITE),
		Execute: winfile.AccessMask(windows.FILE_GENERIC_EXECUTE),
		All:     0x001f01ff,
	}
	expectation := SecurityExpectation{
		OwnerSIDs: []string{"S-1-5-18"},
		AccessChecks: []AccessExpectation{
			{
				Name:            "read",
				Token:           stable,
				DesiredAccess:   winfile.AccessMask(windows.GENERIC_READ),
				GenericMapping:  mapping,
				ExpectedAllowed: true,
			},
			{
				Name:            "write and delete",
				Token:           stable,
				DesiredAccess:   winfile.AccessMask(windows.FILE_WRITE_DATA | windows.DELETE),
				GenericMapping:  mapping,
				ExpectedAllowed: false,
			},
		},
	}
	policy, err := NewExpectedSecurityPolicy(expectation, expectation)
	if err != nil {
		stable.Close()
		t.Fatalf("NewExpectedSecurityPolicy returned an error: %v", err)
	}
	if err := stable.Close(); err != nil {
		policy.Close()
		t.Fatalf("source StableAccessToken Close returned an error: %v", err)
	}
	if err := policy.CheckAncestor(AncestorSecurityRequest{Object: object}); err != nil {
		policy.Close()
		t.Fatalf("policy-owned token duplicate was not usable: %v", err)
	}
	if err := policy.Close(); err != nil {
		t.Fatalf("policy Close returned an error: %v", err)
	}
	if err := policy.CheckAncestor(AncestorSecurityRequest{Object: object}); !errors.Is(err, ErrInvalidPolicy) {
		t.Fatalf("closed policy returned %v", err)
	}
}

func TestSplitDenialObservesGenericWriteACE(t *testing.T) {
	var source windows.Token
	if err := windows.OpenProcessToken(
		windows.CurrentProcess(),
		windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE,
		&source,
	); err != nil {
		t.Fatalf("OpenProcessToken returned an error: %v", err)
	}
	stable, err := winfile.NewStableAccessToken(source)
	if closeErr := source.Close(); err != nil || closeErr != nil {
		t.Fatalf("NewStableAccessToken or source Close failed: %v, %v", err, closeErr)
	}
	defer stable.Close()

	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;;GW;;;WD)")
	if err != nil {
		t.Fatalf("SecurityDescriptorFromString returned an error: %v", err)
	}
	descriptorBytes := append(
		[]byte(nil),
		unsafe.Slice((*byte)(unsafe.Pointer(descriptor)), int(descriptor.Length()))...,
	)
	runtime.KeepAlive(descriptor)
	security := winfile.SecurityDescriptorEvidence{
		DACLPresent:            true,
		DACLProtected:          true,
		SelfRelativeDescriptor: descriptorBytes,
	}
	mapping := winfile.GenericMapping{
		Read:    winfile.AccessMask(windows.FILE_GENERIC_READ),
		Write:   winfile.AccessMask(windows.FILE_GENERIC_WRITE),
		Execute: winfile.AccessMask(windows.FILE_GENERIC_EXECUTE),
		All:     0x001f01ff,
	}
	err = checkExpectedAccess(`C:\trusted`, security, expectedAccessCheck{
		name:            "deny generic write",
		token:           stable,
		desiredAccess:   genericWriteAccess,
		genericMapping:  mapping,
		expectedAllowed: false,
	})
	if !errors.Is(err, ErrPolicyRejected) {
		t.Fatalf("generic-write ACE was treated as denied: %v", err)
	}
}
