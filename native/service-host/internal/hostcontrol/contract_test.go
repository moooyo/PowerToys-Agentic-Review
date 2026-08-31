package hostcontrol

import (
	"bytes"
	"errors"
	"strings"
	"testing"
	"time"
)

const testOwnServiceSID = "S-1-5-80-1-2-3-4-5"

func TestGeneratePipeNameUsesExactly256RandomBits(t *testing.T) {
	random := bytes.Repeat([]byte{0xab}, pipeNonceBytes)
	name, err := generatePipeName(bytes.NewReader(random))
	if err != nil {
		t.Fatal(err)
	}
	want := pipeNamePrefix + strings.Repeat("ab", pipeNonceBytes)
	if name != want {
		t.Fatalf("pipe name = %q, want %q", name, want)
	}
	if _, err := generatePipeName(bytes.NewReader(random[:pipeNonceBytes-1])); err == nil {
		t.Fatal("generatePipeName accepted fewer than 256 random bits")
	}
	if _, err := generatePipeName(nil); !errors.Is(err, ErrInvalidOptions) {
		t.Fatalf("nil random source error = %v, want ErrInvalidOptions", err)
	}
}

func TestHostControlDACLIsExactAndDocumentsPureNodeTradeoff(t *testing.T) {
	entries := expectedDACL(testOwnServiceSID)
	if len(entries) != 3 {
		t.Fatalf("DACL contains %d entries, want 3", len(entries))
	}
	if entries[0].SID != localSystemSID || entries[0].Mask != fileAllAccessMask ||
		entries[1].SID != builtinAdministratorsSID || entries[1].Mask != fileAllAccessMask ||
		entries[2].SID != testOwnServiceSID || entries[2].Mask != nodeDuplexAccessMask {
		t.Fatalf("unexpected HostControl DACL entries: %#v", entries)
	}
	if nodeDuplexAccessMask != fileGenericRead|fileGenericWrite {
		t.Fatalf("Node duplex mask = 0x%x, want FILE_GENERIC_READ | FILE_GENERIC_WRITE", nodeDuplexAccessMask)
	}
	// Pure Node net.connect opens a duplex Windows pipe with GENERIC_READ |
	// GENERIC_WRITE. FILE_GENERIC_WRITE unavoidably maps FILE_APPEND_DATA to
	// the FILE_CREATE_PIPE_INSTANCE bit; the per-launch single-instance design
	// prevents that right from becoming an alternate accepted server.
	if nodeDuplexAccessMask&fileAppendData == 0 {
		t.Fatal("pure Node compatible duplex mask unexpectedly omits FILE_APPEND_DATA")
	}
	if got := securityDescriptorString(testOwnServiceSID); !strings.Contains(got, "D:P") ||
		!strings.Contains(got, testOwnServiceSID) {
		t.Fatalf("security descriptor = %q, want protected exact service SID DACL", got)
	}
}

func TestValidateDACLRejectsAnyUnexpectedAccess(t *testing.T) {
	valid := daclEvidence{
		Control:   securityDescriptorDACLPresent | securityDescriptorDACLProtected,
		Present:   true,
		Protected: true,
		Entries:   expectedDACL(testOwnServiceSID),
	}
	if err := validateDACL(valid, testOwnServiceSID); err != nil {
		t.Fatalf("exact protected DACL rejected: %v", err)
	}
	tests := []struct {
		name   string
		mutate func(*daclEvidence)
	}{
		{name: "unprotected", mutate: func(value *daclEvidence) { value.Protected = false }},
		{name: "missing", mutate: func(value *daclEvidence) { value.Present = false }},
		{name: "null", mutate: func(value *daclEvidence) { value.Null = true }},
		{name: "defaulted", mutate: func(value *daclEvidence) { value.Defaulted = true }},
		{name: "extra", mutate: func(value *daclEvidence) {
			value.Entries = append(value.Entries, accessEntry{SID: "S-1-1-0", Mask: fileAllAccessMask})
		}},
		{name: "duplicate", mutate: func(value *daclEvidence) { value.Entries[2].SID = localSystemSID }},
		{name: "write dac", mutate: func(value *daclEvidence) { value.Entries[2].Mask = fileAllAccessMask }},
		{name: "deny", mutate: func(value *daclEvidence) { value.Entries[2].ACEType = 1 }},
		{name: "inherited", mutate: func(value *daclEvidence) { value.Entries[2].Flags = 0x10 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			evidence := valid
			evidence.Entries = append([]accessEntry(nil), valid.Entries...)
			test.mutate(&evidence)
			if err := validateDACL(evidence, testOwnServiceSID); err == nil {
				t.Fatal("validateDACL unexpectedly succeeded")
			}
		})
	}
}

func TestOptionsRequireCanonicalServiceSIDAndBoundedTimeouts(t *testing.T) {
	valid := Options{
		OwnServiceSID:  testOwnServiceSID,
		ConnectTimeout: 30 * time.Second,
		IOTimeout:      time.Minute,
		CloseTimeout:   2 * time.Minute,
	}
	if err := validateOptions(valid); err != nil {
		t.Fatalf("valid options rejected: %v", err)
	}
	tests := []Options{
		{OwnServiceSID: "S-1-5-18", ConnectTimeout: valid.ConnectTimeout, IOTimeout: valid.IOTimeout, CloseTimeout: valid.CloseTimeout},
		{OwnServiceSID: valid.OwnServiceSID, IOTimeout: valid.IOTimeout, CloseTimeout: valid.CloseTimeout},
		{OwnServiceSID: valid.OwnServiceSID, ConnectTimeout: valid.ConnectTimeout, CloseTimeout: valid.CloseTimeout},
		{OwnServiceSID: valid.OwnServiceSID, ConnectTimeout: valid.ConnectTimeout, IOTimeout: valid.IOTimeout},
		{OwnServiceSID: valid.OwnServiceSID, ConnectTimeout: maximumTimeout + time.Nanosecond, IOTimeout: valid.IOTimeout, CloseTimeout: valid.CloseTimeout},
	}
	for _, options := range tests {
		if err := validateOptions(options); !errors.Is(err, ErrInvalidOptions) {
			t.Fatalf("invalid options error = %v, want ErrInvalidOptions", err)
		}
	}
}
