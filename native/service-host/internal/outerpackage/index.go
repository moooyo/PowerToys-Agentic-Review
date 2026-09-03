package outerpackage

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installerprofile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
)

var workerTokenShapePattern = regexp.MustCompile(`arw1_[A-Za-z0-9_-]{43}`)

type specialPayloadRule struct {
	root         Root
	path         string
	maximumBytes uint64
}

var specialPayloadRules = map[Role]specialPayloadRule{
	RolePackageDescriptor:       {RootMetadata, PackageDescriptorPath, releasemanifest.MaximumDocumentBytes},
	RolePrepareReceipt:          {RootMetadata, PrepareReceiptPath, releasemanifest.MaximumDocumentBytes},
	RoleReviewedClosure:         {RootMetadata, ReviewedClosurePath, releasemanifest.MaximumDocumentBytes},
	RoleCompiledReleaseTemplate: {RootMetadata, CompiledReleaseTemplatePath, releasemanifest.MaximumDocumentBytes},
	RoleServiceHostBuildReceipt: {RootMetadata, ServiceHostBuildReceiptPath, releasemanifest.MaximumDocumentBytes},
	RoleRuntimeManifest:         {RootInstallation, RuntimeManifestPath, releasemanifest.MaximumDocumentBytes},
	RoleControlBootstrap:        {RootTrustedConfiguration, ControlBootstrapPath, releasemanifest.MaximumBootstrapConfigurationBytes},
	RoleExecutorBootstrap:       {RootTrustedConfiguration, ExecutorBootstrapPath, releasemanifest.MaximumBootstrapConfigurationBytes},
}

var runtimeRoleMapping = map[Role]releasemanifest.FileRole{
	RoleServiceHost:    releasemanifest.RoleServiceHost,
	RoleNodeRuntime:    releasemanifest.RoleNodeRuntime,
	RoleControlBundle:  releasemanifest.RoleControlBundle,
	RoleExecutorBundle: releasemanifest.RoleExecutorBundle,
	RoleProcessHost:    releasemanifest.RoleProcessHost,
	RoleCodexCLI:       releasemanifest.RoleCodexCLI,
	RoleGitCLI:         releasemanifest.RoleGitCLI,
	RoleGitHelper:      releasemanifest.RoleGitHelper,
	RoleCodexRuntime:   releasemanifest.RoleCodexRuntime,
	RoleNativeLibrary:  releasemanifest.RoleNativeLibrary,
	RoleCABundle:       releasemanifest.RoleCABundle,
	RoleTrustedConfig:  releasemanifest.RoleTrustedConfig,
	RolePolicy:         releasemanifest.RolePolicy,
	RoleSchema:         releasemanifest.RoleSchema,
	RolePrompt:         releasemanifest.RolePrompt,
	RoleRecipe:         releasemanifest.RoleRecipe,
	RoleRuntimeData:    releasemanifest.RoleRuntimeData,
	RoleLicense:        releasemanifest.RoleLicense,
}

var portableExecutableRoles = map[Role]struct{}{
	RoleServiceHost: {}, RoleNodeRuntime: {}, RoleProcessHost: {},
	RoleCodexCLI: {}, RoleGitCLI: {}, RoleGitHelper: {}, RoleCodexRuntime: {}, RoleNativeLibrary: {},
}

// MarshalIndexCanonical validates, sorts, and serializes a package index.
func MarshalIndexCanonical(value Index) ([]byte, error) {
	normalized, err := normalizeIndex(value)
	if err != nil {
		return nil, err
	}
	return marshalCanonical(normalized, MaximumIndexBytes)
}

// ParseIndex accepts only the exact canonical package-index.json representation.
func ParseIndex(document []byte) (Index, error) {
	var parsed Index
	var normalized Index
	err := parseStrictCanonical(document, MaximumIndexBytes, &parsed, func() ([]byte, error) {
		value, err := normalizeIndex(parsed)
		if err != nil {
			return nil, err
		}
		normalized = value
		return marshalCanonical(value, MaximumIndexBytes)
	})
	if err != nil {
		return Index{}, err
	}
	return cloneIndex(normalized), nil
}

func normalizeIndex(value Index) (Index, error) {
	if validateIndexProfile(value) != nil || !validPackageComponentID(value.PackageID) ||
		!validPackageComponentID(value.InstallationID) ||
		!validEntityID(value.WorkerNodeID) || !validReleaseID(value.ReleaseID) ||
		!validArchitecture(value.TargetArchitecture) || validateSource(value.Source) != nil ||
		validateNodeSPKI(value.NodeSpecificLocalAuthorityPublicSPKI) != nil ||
		validateCNGIdentity(value.LocalAuthorityCNG) != nil ||
		validateTargetRoots(value.TargetRoots) != nil {
		return Index{}, fmt.Errorf("%w: package index identity fields are invalid", ErrInvalid)
	}
	if indexContainsTokenShape(value) {
		return Index{}, fmt.Errorf("%w: Token-profile package index contains Worker credential material", ErrInvalid)
	}
	if len(value.Payloads) == 0 || len(value.Payloads) > MaximumPayloads {
		return Index{}, fmt.Errorf("%w: payload count is outside the supported range", ErrInvalid)
	}
	payloads := clonePayloads(value.Payloads)
	seen := make(map[string]struct{}, len(payloads))
	specialCounts := make(map[Role]int, len(specialPayloadRules))
	runtimeFiles := make([]releasemanifest.File, 0, len(payloads))
	nodeSPKIMatches := 0
	var totalBytes uint64
	for index := range payloads {
		payload := &payloads[index]
		if !validRoot(payload.Root) || validateRelativePath(payload.Path) != nil ||
			!validSHA256(payload.SHA256) {
			return Index{}, fmt.Errorf("%w: payload identity is invalid", ErrInvalid)
		}
		key := string(payload.Root) + "\x00" + asciiCaseFold(payload.Path)
		if _, duplicate := seen[key]; duplicate {
			return Index{}, fmt.Errorf("%w: payload root and path are not case-fold unique", ErrInvalid)
		}
		seen[key] = struct{}{}
		if forbiddenPayloadPath(payload.Path) || forbiddenWorkerAuthenticationPayloadPath(payload.Path) {
			return Index{}, fmt.Errorf("%w: payload path is forbidden", ErrInvalid)
		}
		size, err := parseSize(payload.Size)
		if err != nil || size == 0 || size > MaximumPayloadBytes || totalBytes > MaximumTotalBytes-size {
			return Index{}, fmt.Errorf("%w: payload size is invalid", ErrInvalid)
		}
		totalBytes += size
		_, isPE := portableExecutableRoles[payload.Role]
		if isPE {
			if payload.TargetArchitecture == nil || *payload.TargetArchitecture != value.TargetArchitecture {
				return Index{}, fmt.Errorf("%w: PE payload target architecture is absent or mismatched", ErrInvalid)
			}
		} else if payload.TargetArchitecture != nil {
			return Index{}, fmt.Errorf("%w: non-PE payload carries a target architecture", ErrInvalid)
		}

		if rule, special := specialPayloadRules[payload.Role]; special {
			if payload.Root != rule.root || payload.Path != rule.path || size > rule.maximumBytes {
				return Index{}, fmt.Errorf("%w: fixed package payload is invalid", ErrInvalid)
			}
			specialCounts[payload.Role]++
			continue
		}
		manifestRole, runtimePayload := runtimeRoleMapping[payload.Role]
		if !runtimePayload || payload.Root == RootMetadata {
			return Index{}, fmt.Errorf("%w: payload role is unsupported", ErrInvalid)
		}
		runtimeFiles = append(runtimeFiles, releasemanifest.File{
			Root: releasemanifest.FileRoot(payload.Root), Path: payload.Path,
			Role: manifestRole, SHA256: payload.SHA256, Size: payload.Size,
		})
		if payload.Root == RootTrustedConfiguration && payload.Path == value.NodeSpecificLocalAuthorityPublicSPKI.Path &&
			payload.Role == RoleTrustedConfig && payload.SHA256 == value.NodeSpecificLocalAuthorityPublicSPKI.SHA256 {
			nodeSPKIMatches++
		}
	}
	for role := range specialPayloadRules {
		if specialCounts[role] != 1 {
			return Index{}, fmt.Errorf("%w: fixed package payload closure is incomplete", ErrInvalid)
		}
	}
	if nodeSPKIMatches != 1 {
		return Index{}, fmt.Errorf("%w: node-specific SPKI payload binding is absent", ErrInvalid)
	}
	if _, err := releasemanifest.MarshalCanonical(releasemanifest.Manifest{
		Compatibility:   releasemanifest.RequiredCompatibility(),
		Files:           runtimeFiles,
		PublisherPolicy: releasemanifest.PublisherPolicy,
		ReleaseID:       value.ReleaseID,
		SchemaVersion:   releasemanifest.SchemaVersion,
	}); err != nil {
		return Index{}, fmt.Errorf("%w: runtime payload closure is invalid", ErrInvalid)
	}
	sort.Slice(payloads, func(left, right int) bool {
		leftOrder := rootOrder(payloads[left].Root)
		rightOrder := rootOrder(payloads[right].Root)
		if leftOrder != rightOrder {
			return leftOrder < rightOrder
		}
		return asciiCaseFold(payloads[left].Path) < asciiCaseFold(payloads[right].Path)
	})
	value.Payloads = payloads
	return cloneIndex(value), nil
}

func indexContainsTokenShape(value Index) bool {
	values := []string{
		value.InstallationID,
		value.LocalAuthorityCNG.KeyName,
		value.NodeSpecificLocalAuthorityPublicSPKI.Path,
		value.PackageID,
		value.ReleaseID,
		value.TargetRoots.Installation,
		value.TargetRoots.Metadata,
		value.TargetRoots.TrustedConfiguration,
		value.WorkerNodeID,
	}
	for _, payload := range value.Payloads {
		values = append(values, payload.Path)
	}
	for _, candidate := range values {
		if workerTokenShapePattern.MatchString(candidate) {
			return true
		}
	}
	return false
}

func validateIndexProfile(value Index) error {
	if value.SchemaVersion != IndexSchemaVersion || value.ProfileID != IndexProfileID ||
		installerprofile.ValidatePackageRoots(
			installerprofile.ProfileID,
			value.PackageID,
			value.TargetRoots.Metadata,
			value.TargetRoots.Installation,
			value.TargetRoots.TrustedConfiguration,
		) != nil {
		return ErrInvalid
	}
	return nil
}

func validRoot(value Root) bool {
	return value == RootMetadata || value == RootInstallation || value == RootTrustedConfiguration
}

func rootOrder(value Root) int {
	switch value {
	case RootMetadata:
		return 0
	case RootInstallation:
		return 1
	case RootTrustedConfiguration:
		return 2
	default:
		return 3
	}
}

func validArchitecture(value TargetArchitecture) bool {
	return value == ArchitectureAMD64 || value == ArchitectureARM64
}

func validateSource(value SourceIdentity) error {
	if !validGitObjectID(value.Commit) || !validGitObjectID(value.Tree) || len(value.Commit) != len(value.Tree) {
		return ErrInvalid
	}
	return nil
}

func validateNodeSPKI(value NodeSpecificSPKI) error {
	if validateRelativePath(value.Path) != nil || !strings.HasSuffix(asciiCaseFold(value.Path), ".spki") ||
		!validSHA256(value.SHA256) {
		return ErrInvalid
	}
	return nil
}

func validateCNGIdentity(value LocalAuthorityCNGIdentity) error {
	if !validBoundedASCIIText(value.KeyName, 256) || strings.TrimSpace(value.KeyName) != value.KeyName ||
		!validSHA256(value.SecurityDescriptorSHA256) {
		return ErrInvalid
	}
	return nil
}

func validateTargetRoots(value TargetRoots) error {
	roots := []string{value.Metadata, value.Installation, value.TrustedConfiguration}
	for _, root := range roots {
		if validateAbsoluteRoot(root) != nil {
			return ErrInvalid
		}
	}
	for left := 0; left < len(roots); left++ {
		for right := left + 1; right < len(roots); right++ {
			if absoluteRootsOverlap(roots[left], roots[right]) {
				return ErrInvalid
			}
		}
	}
	return nil
}

func validateAbsoluteRoot(value string) error {
	if len(value) < 4 || value[0] < 'A' || value[0] > 'Z' || value[1] != ':' || value[2] != '\\' ||
		strings.HasSuffix(value, `\`) || strings.Contains(value, "/") || strings.Contains(value[2:], ":") {
		return ErrInvalid
	}
	for _, character := range value {
		if character < 0x20 || character > 0x7e {
			return ErrInvalid
		}
	}
	for _, component := range strings.Split(value[3:], `\`) {
		if invalidPathComponent(component) {
			return ErrInvalid
		}
	}
	return nil
}

func absoluteRootsOverlap(left, right string) bool {
	left = asciiCaseFold(left)
	right = asciiCaseFold(right)
	if left == right {
		return true
	}
	return strings.HasPrefix(left, right+`\`) || strings.HasPrefix(right, left+`\`)
}

func validateRelativePath(value string) error {
	if value == "" || len(value) > MaximumPathBytes || strings.HasPrefix(value, `\`) ||
		strings.Contains(value, "/") || strings.Contains(value, ":") || strings.ContainsRune(value, '\x00') {
		return ErrInvalid
	}
	for _, character := range value {
		if character < 0x20 || character > 0x7e {
			return ErrInvalid
		}
	}
	for _, component := range strings.Split(value, `\`) {
		if invalidPathComponent(component) {
			return ErrInvalid
		}
	}
	return nil
}

func invalidPathComponent(component string) bool {
	if component == "" || component == "." || component == ".." || strings.HasSuffix(component, ".") ||
		strings.HasSuffix(component, " ") || strings.ContainsAny(component, `<>"|?*`) {
		return true
	}
	base := strings.ToUpper(strings.SplitN(component, ".", 2)[0])
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
		base == "CONIN$" || base == "CONOUT$" || base == "CLOCK$" {
		return true
	}
	return len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) &&
		base[3] >= '1' && base[3] <= '9'
}

func forbiddenPayloadPath(value string) bool {
	lower := asciiCaseFold(value)
	leaf := lower
	if separator := strings.LastIndexByte(leaf, '\\'); separator >= 0 {
		leaf = leaf[separator+1:]
	}
	if leaf == "worker.mjs" || leaf == asciiCaseFold(PackageIndexPath) ||
		leaf == asciiCaseFold(SignatureEnvelopePath) || strings.HasSuffix(leaf, ".map") ||
		strings.HasSuffix(leaf, ".meta.json") {
		return true
	}
	for _, extension := range []string{
		".bat", ".cmd", ".hta", ".js", ".jse", ".msi", ".msp", ".mst", ".ps1", ".psd1",
		".psm1", ".py", ".rb", ".sh", ".vbe", ".vbs", ".wsf", ".wsh",
	} {
		if strings.HasSuffix(leaf, extension) {
			return true
		}
	}
	stem := leaf
	if dot := strings.LastIndexByte(stem, '.'); dot > 0 {
		stem = stem[:dot]
	}
	if stem == "install" || stem == "installer" || stem == "setup" ||
		stem == "uninstall" || stem == "uninstaller" || strings.HasPrefix(stem, "install-") ||
		strings.HasPrefix(stem, "setup-") || strings.HasPrefix(stem, "uninstall-") ||
		strings.HasSuffix(stem, "-installer") || strings.HasSuffix(stem, "-setup") {
		return true
	}
	for _, component := range strings.Split(lower, `\`) {
		if component == "hooks" || component == "scripts" || component == "install" ||
			component == "installer" || component == "installers" || component == "setup" ||
			component == "uninstall" || component == "uninstaller" {
			return true
		}
	}
	return false
}

func forbiddenWorkerAuthenticationPayloadPath(value string) bool {
	leaf := asciiCaseFold(value)
	if separator := strings.LastIndexByte(leaf, '\\'); separator >= 0 {
		leaf = leaf[separator+1:]
	}
	return leaf == installerprofile.WorkerAuthenticationFileName
}

func parseSize(value string) (uint64, error) {
	if value == "" || value == "0" || len(value) > 20 || value[0] == '0' {
		return 0, ErrInvalid
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return 0, ErrInvalid
		}
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		return 0, ErrInvalid
	}
	return parsed, nil
}

func validSHA256(value string) bool {
	return len(value) == 64 && validLowerHex(value)
}

func validGitObjectID(value string) bool {
	return (len(value) == 40 || len(value) == 64) && validLowerHex(value)
}

func validLowerHex(value string) bool {
	for _, character := range value {
		if character < '0' || character > '9' {
			if character < 'a' || character > 'f' {
				return false
			}
		}
	}
	return true
}

func validReleaseID(value string) bool {
	if len(value) == 0 || len(value) > 128 || !asciiAlphaNumeric(value[0]) {
		return false
	}
	for _, character := range []byte(value[1:]) {
		if asciiAlphaNumeric(character) || strings.ContainsRune("._+-", rune(character)) {
			continue
		}
		return false
	}
	return true
}

func validEntityID(value string) bool {
	if len(value) == 0 || len(value) > 128 || !asciiAlphaNumeric(value[0]) {
		return false
	}
	for _, character := range []byte(value[1:]) {
		if asciiAlphaNumeric(character) || strings.ContainsRune("._:-", rune(character)) {
			continue
		}
		return false
	}
	return true
}

func validPackageComponentID(value string) bool {
	if len(value) == 0 || len(value) > 128 ||
		!(value[0] >= 'a' && value[0] <= 'z' || value[0] >= '0' && value[0] <= '9') ||
		invalidPathComponent(value) {
		return false
	}
	for _, character := range []byte(value[1:]) {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' ||
			strings.ContainsRune("._+-", rune(character)) {
			continue
		}
		return false
	}
	return true
}

func asciiAlphaNumeric(value byte) bool {
	return value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z' ||
		value >= '0' && value <= '9'
}

func validBoundedASCIIText(value string, maximum int) bool {
	if value == "" || len(value) > maximum {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character > 0x7e {
			return false
		}
	}
	return true
}

func asciiCaseFold(value string) string {
	result := []byte(value)
	for index, character := range result {
		if character >= 'A' && character <= 'Z' {
			result[index] = character + ('a' - 'A')
		}
	}
	return string(result)
}

func clonePayloads(values []Payload) []Payload {
	result := make([]Payload, len(values))
	for index, value := range values {
		result[index] = value
		if value.TargetArchitecture != nil {
			architecture := *value.TargetArchitecture
			result[index].TargetArchitecture = &architecture
		}
	}
	return result
}

func cloneIndex(value Index) Index {
	value.Payloads = clonePayloads(value.Payloads)
	return value
}
