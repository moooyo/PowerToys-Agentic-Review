package winprocess

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	// These values are stable Win32 ABI constants. Keeping the security
	// contract in a platform-neutral file lets ordinary tests inspect it.
	createSuspended                 uint32 = 0x00000004
	createUnicodeEnvironment        uint32 = 0x00000400
	extendedStartupInfoPresent      uint32 = 0x00080000
	createBreakawayFromJob          uint32 = 0x01000000
	createNoWindow                  uint32 = 0x08000000
	jobLimitActiveProcess           uint32 = 0x00000008
	jobLimitProcessMemory           uint32 = 0x00000100
	jobLimitJobMemory               uint32 = 0x00000200
	jobLimitBreakawayOK             uint32 = 0x00000800
	jobLimitSilentBreakaway         uint32 = 0x00001000
	jobLimitKillOnJobClose          uint32 = 0x00002000
	genericAllAccessMask            uint32 = 0x10000000
	processQueryLimitedMask         uint32 = 0x00001000
	tokenQueryMask                  uint32 = 0x00000008
	securityDescriptorDACLPresent   uint16 = 0x0004
	securityDescriptorDACLProtected uint16 = 0x1000
	accessAllowedACEType            uint8  = 0
	noACEFlags                      uint8  = 0
	maximumEnvironmentUnits                = 32_767
	maximumRootJobProcesses                = 4_096
	preHostControlProcessLimit      uint32 = 1
	hostControlPipePrefix                  = `\\.\pipe\AgenticReview.ServiceHost.HostControl.v1.`
	hostControlPipeNonceHexLength          = 64
	localSystemSID                         = "S-1-5-18"
	builtinAdministratorsSID               = "S-1-5-32-544"
)

const (
	rootJobRequiredLimitFlags = jobLimitActiveProcess |
		jobLimitProcessMemory |
		jobLimitJobMemory |
		jobLimitKillOnJobClose
	rootJobForbiddenLimitFlags   = jobLimitBreakawayOK | jobLimitSilentBreakaway
	requiredProcessCreationFlags = createSuspended |
		createUnicodeEnvironment |
		createNoWindow |
		extendedStartupInfoPresent
)

type processCreationAttribute uint8

const (
	attributeHandleList processCreationAttribute = iota + 1
	attributeJobList
)

func requiredProcessCreationAttributes() []processCreationAttribute {
	return []processCreationAttribute{attributeHandleList, attributeJobList}
}

func fixedNodeArguments(role Role, bundlePath, hostControlPipeName string) []string {
	return []string{
		"--enable-source-maps",
		"--disallow-code-generation-from-strings",
		"--no-addons",
		bundlePath,
		"--service-role=" + string(role),
		"--servicehost-arwx-stdio",
		"--servicehost-host-control-pipe=" + hostControlPipeName,
	}
}

type daclEntry struct {
	SID     string
	Mask    uint32
	ACEType uint8
	Flags   uint8
}

type daclPolicy struct {
	entries []daclEntry
}

type daclEvidence struct {
	control   uint16
	nullDACL  bool
	defaulted bool
	entries   []daclEntry
}

func nodeDACLPolicies(ownServiceSID string, peerServiceSID string) (daclPolicy, daclPolicy, error) {
	if err := validateCanonicalServiceSID(ownServiceSID); err != nil {
		return daclPolicy{}, daclPolicy{}, fmt.Errorf("own service SID: %w", err)
	}
	if err := validateCanonicalServiceSID(peerServiceSID); err != nil {
		return daclPolicy{}, daclPolicy{}, fmt.Errorf("peer service SID: %w", err)
	}
	if ownServiceSID == peerServiceSID {
		return daclPolicy{}, daclPolicy{}, errors.New("own and peer service SIDs must be different")
	}
	base := []daclEntry{
		{SID: localSystemSID, Mask: genericAllAccessMask, ACEType: accessAllowedACEType, Flags: noACEFlags},
		{SID: builtinAdministratorsSID, Mask: genericAllAccessMask, ACEType: accessAllowedACEType, Flags: noACEFlags},
		{SID: ownServiceSID, Mask: genericAllAccessMask, ACEType: accessAllowedACEType, Flags: noACEFlags},
	}
	processEntries := append(append([]daclEntry(nil), base...), daclEntry{
		SID: peerServiceSID, Mask: processQueryLimitedMask, ACEType: accessAllowedACEType, Flags: noACEFlags,
	})
	tokenEntries := append(append([]daclEntry(nil), base...), daclEntry{
		SID: peerServiceSID, Mask: tokenQueryMask, ACEType: accessAllowedACEType, Flags: noACEFlags,
	})
	return daclPolicy{entries: processEntries}, daclPolicy{entries: tokenEntries}, nil
}

func validateCanonicalServiceSID(value string) error {
	parts := strings.Split(value, "-")
	if len(parts) != 9 || parts[0] != "S" || parts[1] != "1" || parts[2] != "5" || parts[3] != "80" {
		return errors.New("must be a canonical S-1-5-80 service SID")
	}
	for _, part := range parts[4:] {
		parsed, err := strconv.ParseUint(part, 10, 32)
		if err != nil || strconv.FormatUint(parsed, 10) != part {
			return errors.New("must be a canonical S-1-5-80 service SID")
		}
	}
	return nil
}

func validateProtectedDACL(evidence daclEvidence, policy daclPolicy) error {
	requiredControl := securityDescriptorDACLPresent | securityDescriptorDACLProtected
	if evidence.control&requiredControl != requiredControl {
		return errors.New("security descriptor does not contain a protected DACL")
	}
	if evidence.nullDACL {
		return errors.New("security descriptor contains a null DACL")
	}
	if evidence.defaulted {
		return errors.New("security descriptor DACL is marked defaulted")
	}
	if len(evidence.entries) != len(policy.entries) {
		return fmt.Errorf("DACL contains %d ACEs, want %d", len(evidence.entries), len(policy.entries))
	}
	expected := make(map[string]daclEntry, len(policy.entries))
	for _, entry := range policy.entries {
		expected[entry.SID] = entry
	}
	seen := make(map[string]struct{}, len(evidence.entries))
	for _, entry := range evidence.entries {
		want, exists := expected[entry.SID]
		if !exists {
			return fmt.Errorf("DACL contains an unexpected SID %s", entry.SID)
		}
		if _, duplicate := seen[entry.SID]; duplicate {
			return fmt.Errorf("DACL contains duplicate SID %s", entry.SID)
		}
		seen[entry.SID] = struct{}{}
		if entry.ACEType != accessAllowedACEType || entry.ACEType != want.ACEType {
			return fmt.Errorf("DACL ACE for %s is not access-allowed", entry.SID)
		}
		if entry.Mask != want.Mask {
			return fmt.Errorf("DACL ACE mask for %s is 0x%x, want 0x%x", entry.SID, entry.Mask, want.Mask)
		}
		if entry.Flags != noACEFlags || entry.Flags != want.Flags {
			return fmt.Errorf("DACL ACE flags for %s are 0x%x, want zero", entry.SID, entry.Flags)
		}
	}
	return nil
}

func validateLaunchSpec(spec NodeLaunchSpec) error {
	paths := []struct {
		name  string
		value string
	}{
		{name: "Node executable path", value: spec.ExecutablePath},
		{name: "Node bundle path", value: spec.BundlePath},
		{name: "working directory", value: spec.WorkingDirectory},
		{name: "HostControl pipe name", value: spec.HostControlPipeName},
	}
	for _, path := range paths {
		if !validText(path.value) {
			return fmt.Errorf("%s must be non-empty valid UTF-8 without NUL", path.name)
		}
	}
	if spec.Role != RoleControl && spec.Role != RoleExecutor {
		return errors.New("Node role must be control or executor")
	}
	if !validHostControlPipeName(spec.HostControlPipeName) {
		return errors.New("HostControl pipe name must contain the fixed prefix and a lowercase 256-bit hexadecimal leaf")
	}
	if _, _, err := nodeDACLPolicies(spec.OwnServiceSID, spec.PeerServiceSID); err != nil {
		return err
	}
	if spec.Environment == nil {
		return errors.New("replacement environment is required")
	}
	if _, exists := spec.Environment["NODE_OPTIONS"]; exists {
		return errors.New("replacement environment must not contain NODE_OPTIONS")
	}
	if spec.MaximumProcesses == 0 || spec.MaximumProcesses > maximumRootJobProcesses {
		return fmt.Errorf("root Job process limit must be from 1 through %d", maximumRootJobProcesses)
	}
	if spec.MaximumMemoryBytes == 0 {
		return errors.New("root Job memory limit must be positive")
	}
	if spec.ShutdownTimeout <= 0 {
		return errors.New("root Job shutdown timeout must be positive")
	}
	if err := validateRootJobLimitFlags(rootJobRequiredLimitFlags); err != nil {
		return err
	}
	if requiredProcessCreationFlags&createBreakawayFromJob != 0 {
		return errors.New("process creation flags must reject CREATE_BREAKAWAY_FROM_JOB")
	}
	_, err := buildEnvironmentBlock(spec.Environment)
	return err
}

func validHostControlPipeName(value string) bool {
	if !strings.HasPrefix(value, hostControlPipePrefix) {
		return false
	}
	nonce := strings.TrimPrefix(value, hostControlPipePrefix)
	if len(nonce) != hostControlPipeNonceHexLength {
		return false
	}
	for _, character := range nonce {
		if character >= '0' && character <= '9' || character >= 'a' && character <= 'f' {
			continue
		}
		return false
	}
	return true
}

func validateSingleNodeJobAccounting(totalProcesses, activeProcesses uint32) error {
	if totalProcesses != 1 || activeProcesses != 1 {
		return fmt.Errorf(
			"root Job process accounting is total=%d active=%d, want 1 and 1",
			totalProcesses,
			activeProcesses,
		)
	}
	return nil
}

func validateRootJobLimitFlags(flags uint32) error {
	if flags&rootJobForbiddenLimitFlags != 0 {
		return errors.New("root Job must reject JOB_OBJECT_LIMIT_BREAKAWAY_OK and JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK")
	}
	if flags&rootJobRequiredLimitFlags != rootJobRequiredLimitFlags {
		return errors.New("root Job is missing a required lifetime or resource limit")
	}
	return nil
}

func buildEnvironmentBlock(environment map[string]string) ([]uint16, error) {
	if environment == nil {
		return nil, errors.New("replacement environment is required")
	}
	names := make([]string, 0, len(environment))
	for name, value := range environment {
		if !validEnvironmentName(name) {
			return nil, fmt.Errorf("replacement environment variable %q has a noncanonical name", name)
		}
		if !utf8.ValidString(value) || strings.ContainsRune(value, '\x00') || strings.ContainsRune(value, utf8.RuneError) {
			return nil, fmt.Errorf("replacement environment variable %s is not valid canonical text", name)
		}
		names = append(names, name)
	}
	sort.Strings(names)

	block := make([]uint16, 0, 1024)
	for _, name := range names {
		entry := utf16.Encode([]rune(name + "=" + environment[name]))
		block = append(block, entry...)
		block = append(block, 0)
		if len(block)+1 > maximumEnvironmentUnits {
			return nil, errors.New("replacement environment exceeds the Windows environment block limit")
		}
	}
	if len(block) == 0 {
		return []uint16{0, 0}, nil
	}
	return append(block, 0), nil
}

func validEnvironmentName(name string) bool {
	if name == "" {
		return false
	}
	for index, character := range name {
		if character == '_' || character >= 'A' && character <= 'Z' ||
			index > 0 && character >= '0' && character <= '9' {
			continue
		}
		return false
	}
	return true
}

func validText(value string) bool {
	return value != "" && utf8.ValidString(value) &&
		!strings.ContainsRune(value, '\x00') && !strings.ContainsRune(value, utf8.RuneError)
}
