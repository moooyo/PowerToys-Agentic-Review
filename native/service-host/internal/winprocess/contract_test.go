package winprocess

import (
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

const (
	testOwnServiceSID  = "S-1-5-80-1-2-3-4-5"
	testPeerServiceSID = "S-1-5-80-6-7-8-9-10"
)

func TestFixedNodeArgumentsCannotBeExtendedByCallers(t *testing.T) {
	want := []string{
		"--enable-source-maps",
		`C:\Program Files\AgenticReview\Worker\app\control.mjs`,
		"--service-role=control",
		"--servicehost-arwx-stdio",
		"--servicehost-host-control-pipe=\\\\.\\pipe\\AgenticReview.ServiceHost.HostControl.v1." + strings.Repeat("a", 64),
	}
	if got := fixedNodeArguments(RoleControl, want[1], validLaunchSpec().HostControlPipeName); !reflect.DeepEqual(got, want) {
		t.Fatalf("fixedNodeArguments() = %#v, want %#v", got, want)
	}
}

func TestCreationContractRequiresHandleAndJobListsWithoutBreakaway(t *testing.T) {
	if preHostControlProcessLimit != 1 {
		t.Fatalf("pre-HostControl root Job process limit = %d, want 1", preHostControlProcessLimit)
	}
	wantAttributes := []processCreationAttribute{attributeHandleList, attributeJobList}
	if got := requiredProcessCreationAttributes(); !reflect.DeepEqual(got, wantAttributes) {
		t.Fatalf("requiredProcessCreationAttributes() = %v, want %v", got, wantAttributes)
	}
	if requiredProcessCreationFlags&createBreakawayFromJob != 0 {
		t.Fatalf("creation flags 0x%x enable CREATE_BREAKAWAY_FROM_JOB", requiredProcessCreationFlags)
	}
	if err := validateRootJobLimitFlags(rootJobRequiredLimitFlags); err != nil {
		t.Fatalf("reviewed root Job flags were rejected: %v", err)
	}
	for _, forbidden := range []uint32{jobLimitBreakawayOK, jobLimitSilentBreakaway} {
		if err := validateRootJobLimitFlags(rootJobRequiredLimitFlags | forbidden); err == nil {
			t.Fatalf("root Job flags accepted forbidden breakaway flag 0x%x", forbidden)
		}
	}
}

func TestHostControlActivationRejectsAnyPreviousChildProcess(t *testing.T) {
	if err := validateSingleNodeJobAccounting(1, 1); err != nil {
		t.Fatalf("single Node accounting rejected: %v", err)
	}
	for _, accounting := range []struct {
		total  uint32
		active uint32
	}{
		{total: 2, active: 1}, // A short-lived child already exited.
		{total: 2, active: 2},
		{total: 1, active: 0},
	} {
		if err := validateSingleNodeJobAccounting(accounting.total, accounting.active); err == nil {
			t.Fatalf("accounting total=%d active=%d unexpectedly accepted", accounting.total, accounting.active)
		}
	}
}

func TestEnvironmentBlockIsAReplacementBlockWithCanonicalOrdering(t *testing.T) {
	block, err := buildEnvironmentBlock(map[string]string{
		"SYSTEMROOT": `C:\Windows`,
		"NODE_ENV":   "production",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := append(utf16.Encode([]rune("NODE_ENV=production\x00SYSTEMROOT=C:\\Windows\x00")), 0)
	if !reflect.DeepEqual(block, want) {
		t.Fatalf("environment block = %v, want %v", block, want)
	}
	empty, err := buildEnvironmentBlock(map[string]string{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(empty, []uint16{0, 0}) {
		t.Fatalf("empty environment block = %v, want two NULs", empty)
	}
}

func TestEnvironmentBlockRejectsNoncanonicalOrUnboundedValues(t *testing.T) {
	tests := []map[string]string{
		{"Path": `C:\Windows`},
		{"A=B": "value"},
		{"A": "value\x00suffix"},
		{"A": strings.Repeat("x", maximumEnvironmentUnits)},
	}
	for _, environment := range tests {
		if _, err := buildEnvironmentBlock(environment); err == nil {
			t.Fatalf("buildEnvironmentBlock(%q) unexpectedly succeeded", environment)
		}
	}
}

func TestNodeDACLPoliciesGrantOnlyReviewedRights(t *testing.T) {
	processPolicy, tokenPolicy, err := nodeDACLPolicies(testOwnServiceSID, testPeerServiceSID)
	if err != nil {
		t.Fatal(err)
	}
	wantBase := []daclEntry{
		{SID: localSystemSID, Mask: genericAllAccessMask, ACEType: accessAllowedACEType, Flags: noACEFlags},
		{SID: builtinAdministratorsSID, Mask: genericAllAccessMask, ACEType: accessAllowedACEType, Flags: noACEFlags},
		{SID: testOwnServiceSID, Mask: genericAllAccessMask, ACEType: accessAllowedACEType, Flags: noACEFlags},
	}
	wantProcess := append(append([]daclEntry(nil), wantBase...), daclEntry{
		SID: testPeerServiceSID, Mask: processQueryLimitedMask, ACEType: accessAllowedACEType, Flags: noACEFlags,
	})
	wantToken := append(append([]daclEntry(nil), wantBase...), daclEntry{
		SID: testPeerServiceSID, Mask: tokenQueryMask, ACEType: accessAllowedACEType, Flags: noACEFlags,
	})
	if !reflect.DeepEqual(processPolicy.entries, wantProcess) {
		t.Fatalf("process DACL policy = %#v, want %#v", processPolicy.entries, wantProcess)
	}
	if !reflect.DeepEqual(tokenPolicy.entries, wantToken) {
		t.Fatalf("token DACL policy = %#v, want %#v", tokenPolicy.entries, wantToken)
	}
}

func TestServiceSIDsMustBeDistinctCanonicalServiceSIDs(t *testing.T) {
	invalid := []string{
		"",
		"S-1-5-18",
		"S-1-5-80-1-2-3-4",
		"S-1-5-80-01-2-3-4-5",
		"S-1-5-80-4294967296-2-3-4-5",
		"s-1-5-80-1-2-3-4-5",
	}
	for _, sid := range invalid {
		if err := validateCanonicalServiceSID(sid); err == nil {
			t.Fatalf("validateCanonicalServiceSID(%q) unexpectedly succeeded", sid)
		}
	}
	if _, _, err := nodeDACLPolicies(testOwnServiceSID, testOwnServiceSID); err == nil {
		t.Fatal("nodeDACLPolicies accepted identical own and peer SIDs")
	}
}

func TestProtectedDACLValidationRequiresExactAllowOnlyPolicy(t *testing.T) {
	processPolicy, _, err := nodeDACLPolicies(testOwnServiceSID, testPeerServiceSID)
	if err != nil {
		t.Fatal(err)
	}
	valid := daclEvidence{
		control: securityDescriptorDACLPresent | securityDescriptorDACLProtected,
		entries: append([]daclEntry(nil), processPolicy.entries...),
	}
	if err := validateProtectedDACL(valid, processPolicy); err != nil {
		t.Fatalf("exact protected DACL was rejected: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*daclEvidence)
	}{
		{name: "unprotected", mutate: func(value *daclEvidence) { value.control &^= securityDescriptorDACLProtected }},
		{name: "missing", mutate: func(value *daclEvidence) { value.control &^= securityDescriptorDACLPresent }},
		{name: "null", mutate: func(value *daclEvidence) { value.nullDACL = true }},
		{name: "defaulted", mutate: func(value *daclEvidence) { value.defaulted = true }},
		{name: "extra ACE", mutate: func(value *daclEvidence) {
			value.entries = append(value.entries, daclEntry{SID: "S-1-1-0", Mask: genericAllAccessMask})
		}},
		{name: "wrong mask", mutate: func(value *daclEvidence) { value.entries[3].Mask = genericAllAccessMask }},
		{name: "deny ACE", mutate: func(value *daclEvidence) { value.entries[3].ACEType = 1 }},
		{name: "inherited ACE", mutate: func(value *daclEvidence) { value.entries[3].Flags = 0x10 }},
		{name: "duplicate SID", mutate: func(value *daclEvidence) { value.entries[3].SID = value.entries[2].SID }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			evidence := valid
			evidence.entries = append([]daclEntry(nil), valid.entries...)
			test.mutate(&evidence)
			if err := validateProtectedDACL(evidence, processPolicy); err == nil {
				t.Fatal("validateProtectedDACL unexpectedly succeeded")
			}
		})
	}
}

func TestLaunchSpecRejectsCallerControlledContractViolations(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*NodeLaunchSpec)
	}{
		{name: "unknown role", mutate: func(spec *NodeLaunchSpec) { spec.Role = "other" }},
		{name: "invalid own SID", mutate: func(spec *NodeLaunchSpec) { spec.OwnServiceSID = "S-1-5-18" }},
		{name: "invalid peer SID", mutate: func(spec *NodeLaunchSpec) { spec.PeerServiceSID = "S-1-5-32-544" }},
		{name: "same service SID", mutate: func(spec *NodeLaunchSpec) { spec.PeerServiceSID = spec.OwnServiceSID }},
		{name: "missing executable", mutate: func(spec *NodeLaunchSpec) { spec.ExecutablePath = "" }},
		{name: "missing bundle", mutate: func(spec *NodeLaunchSpec) { spec.BundlePath = "" }},
		{name: "missing directory", mutate: func(spec *NodeLaunchSpec) { spec.WorkingDirectory = "" }},
		{name: "missing HostControl pipe", mutate: func(spec *NodeLaunchSpec) { spec.HostControlPipeName = "" }},
		{name: "noncanonical HostControl pipe", mutate: func(spec *NodeLaunchSpec) {
			spec.HostControlPipeName = `\\.\pipe\AgenticReview.ServiceHost.HostControl.v1.not-random`
		}},
		{name: "nil environment", mutate: func(spec *NodeLaunchSpec) { spec.Environment = nil }},
		{name: "zero processes", mutate: func(spec *NodeLaunchSpec) { spec.MaximumProcesses = 0 }},
		{name: "too many processes", mutate: func(spec *NodeLaunchSpec) { spec.MaximumProcesses = maximumRootJobProcesses + 1 }},
		{name: "zero memory", mutate: func(spec *NodeLaunchSpec) { spec.MaximumMemoryBytes = 0 }},
		{name: "invalid UTF-8 path", mutate: func(spec *NodeLaunchSpec) { spec.BundlePath = string([]byte{0xff}) }},
		{name: "zero timeout", mutate: func(spec *NodeLaunchSpec) { spec.ShutdownTimeout = 0 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			spec := validLaunchSpec()
			test.mutate(&spec)
			if err := validateLaunchSpec(spec); err == nil {
				t.Fatal("validateLaunchSpec() unexpectedly succeeded")
			}
		})
	}
}

func validLaunchSpec() NodeLaunchSpec {
	return NodeLaunchSpec{
		ExecutablePath:      `C:\Program Files\AgenticReview\Worker\runtime\node.exe`,
		BundlePath:          `C:\Program Files\AgenticReview\Worker\app\control.mjs`,
		WorkingDirectory:    `C:\ProgramData\AgenticReview\Control`,
		HostControlPipeName: `\\.\pipe\AgenticReview.ServiceHost.HostControl.v1.` + strings.Repeat("a", 64),
		Role:                RoleControl,
		OwnServiceSID:       testOwnServiceSID,
		PeerServiceSID:      testPeerServiceSID,
		Environment:         map[string]string{"NODE_ENV": "production"},
		MaximumProcesses:    128,
		MaximumMemoryBytes:  16 * 1024 * 1024 * 1024,
		ShutdownTimeout:     2 * time.Minute,
	}
}
