//go:build windows

package winfile

import (
	"errors"
	"runtime"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestAccessCheckWindowsConstantsAndLayout(t *testing.T) {
	if genericReadMask != AccessMask(windows.GENERIC_READ) ||
		genericWriteMask != AccessMask(windows.GENERIC_WRITE) ||
		genericExecuteMask != AccessMask(windows.GENERIC_EXECUTE) ||
		genericAllMask != AccessMask(windows.GENERIC_ALL) ||
		maximumAllowedMask != AccessMask(windows.MAXIMUM_ALLOWED) {
		t.Fatal("access-mask constants do not match Windows")
	}
	if unsafe.Sizeof(nativeGenericMapping{}) != 16 {
		t.Fatalf("GENERIC_MAPPING size = %d, want 16", unsafe.Sizeof(nativeGenericMapping{}))
	}
}

func TestStableAccessTokenOwnsIndependentDuplicate(t *testing.T) {
	var source windows.Token
	if err := windows.OpenProcessToken(
		windows.CurrentProcess(),
		windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE,
		&source,
	); err != nil {
		t.Fatalf("OpenProcessToken returned an error: %v", err)
	}
	stable, err := NewStableAccessToken(source)
	if closeErr := source.Close(); err != nil || closeErr != nil {
		t.Fatalf("NewStableAccessToken or source Close failed: %v, %v", err, closeErr)
	}
	defer stable.Close()

	duplicate, err := stable.Duplicate()
	if err != nil {
		t.Fatalf("Duplicate returned an error: %v", err)
	}
	defer duplicate.Close()
	if err := stable.Close(); err != nil {
		t.Fatalf("Close returned an error: %v", err)
	}
	if _, err := stable.Duplicate(); !errors.Is(err, ErrAccessTokenClosed) {
		t.Fatalf("closed token Duplicate returned %v", err)
	}

	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;;GR;;;WD)")
	if err != nil {
		t.Fatalf("SecurityDescriptorFromString returned an error: %v", err)
	}
	descriptorBytes := append(
		[]byte(nil),
		unsafe.Slice((*byte)(unsafe.Pointer(descriptor)), int(descriptor.Length()))...,
	)
	runtime.KeepAlive(descriptor)
	security := SecurityDescriptorEvidence{
		DACLPresent:            true,
		DACLProtected:          true,
		SelfRelativeDescriptor: descriptorBytes,
	}
	mapping := GenericMapping{
		Read:    AccessMask(windows.FILE_GENERIC_READ),
		Write:   AccessMask(windows.FILE_GENERIC_WRITE),
		Execute: AccessMask(windows.FILE_GENERIC_EXECUTE),
		All:     0x001f01ff,
	}
	decision, err := duplicate.CheckAccess(security, AccessMask(windows.GENERIC_READ), mapping)
	if err != nil || !decision.Allowed {
		t.Fatalf("read AccessCheck returned %#v, %v", decision, err)
	}
	decision, err = duplicate.CheckAccess(security, AccessMask(windows.FILE_WRITE_DATA), mapping)
	if err != nil || decision.Allowed {
		t.Fatalf("write AccessCheck returned %#v, %v", decision, err)
	}
}
