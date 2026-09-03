// Package releasemanifest defines the canonical, complete split-worker release manifest.
package releasemanifest

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	SchemaVersion                      = 2
	PublisherPolicy                    = "authenticode-required-at-install"
	MaximumDocumentBytes               = 4 * 1024 * 1024
	MaximumFiles                       = 8_192
	MaximumFileBytes                   = uint64(8 * 1024 * 1024 * 1024)
	MaximumTotalBytes                  = uint64(32 * 1024 * 1024 * 1024)
	MaximumPathBytes                   = 4_096
	MaximumBootstrapConfigurationBytes = uint64(64 * 1024)
)

type FileRole string

type FileRoot string

const (
	RootInstallation         FileRoot = "installation"
	RootTrustedConfiguration FileRoot = "trusted-configuration"
)

type BootstrapConfigurationKind string

const (
	BootstrapControl  BootstrapConfigurationKind = "control"
	BootstrapExecutor BootstrapConfigurationKind = "executor"

	ControlBootstrapConfigurationPath  = "control-service-host.json"
	ExecutorBootstrapConfigurationPath = "executor-service-host.json"
)

const (
	RoleServiceHost    FileRole = "service-host"
	RoleNodeRuntime    FileRole = "node-runtime"
	RoleControlBundle  FileRole = "control-bundle"
	RoleExecutorBundle FileRole = "executor-bundle"
	RoleProcessHost    FileRole = "process-host"
	RoleCodexCLI       FileRole = "codex-cli"
	RoleGitCLI         FileRole = "git-cli"
	RoleGitHelper      FileRole = "git-helper"
	RoleCodexRuntime   FileRole = "codex-runtime"
	RoleNativeLibrary  FileRole = "native-library"
	RoleCABundle       FileRole = "ca-bundle"
	RoleTrustedConfig  FileRole = "trusted-config"
	RolePolicy         FileRole = "policy"
	RoleSchema         FileRole = "schema"
	RolePrompt         FileRole = "prompt"
	RoleRecipe         FileRole = "recipe"
	RoleRuntimeData    FileRole = "runtime-data"
	RoleLicense        FileRole = "license"
)

type Compatibility struct {
	WorkerAPIProtocolVersion   string `json:"workerApiProtocolVersion"`
	LocalProtocolMajor         uint32 `json:"localProtocolMajor"`
	LocalProtocolMinimumMinor  uint32 `json:"localProtocolMinimumMinor"`
	LocalProtocolMaximumMinor  uint32 `json:"localProtocolMaximumMinor"`
	ServiceHostRPCVersion      uint32 `json:"serviceHostRpcVersion"`
	ProcessHostProtocolVersion uint32 `json:"processHostProtocolVersion"`
}

type File struct {
	Root   FileRoot `json:"root"`
	Path   string   `json:"path"`
	Role   FileRole `json:"role"`
	SHA256 string   `json:"sha256"`
	Size   string   `json:"size"`
}

// FileBindingRequirement describes one config path and digest that must be pinned by the manifest.
type FileBindingRequirement struct {
	Root   FileRoot
	Path   string
	Role   FileRole
	SHA256 string
}

// FileBindingEvidence records the canonical manifest digest and exact entry that matched a config.
// The platform layer must compare ManifestSHA256 with the independently pinned manifest digest.
type FileBindingEvidence struct {
	ReleaseID      string
	ManifestSHA256 string
	SchemaVersion  uint32
	Compatibility  Compatibility
	File           File
}

// BootstrapConfigurationEvidence records a separately hashed ServiceHost bootstrap configuration.
// Bootstrap configurations pin the manifest, so the manifest must not pin them in return.
type BootstrapConfigurationEvidence struct {
	Kind   BootstrapConfigurationKind
	Root   FileRoot
	Path   string
	SHA256 string
	Size   string
}

type Manifest struct {
	Compatibility   Compatibility `json:"compatibility"`
	Files           []File        `json:"files"`
	PublisherPolicy string        `json:"publisherPolicy"`
	ReleaseID       string        `json:"releaseId"`
	SchemaVersion   uint32        `json:"schemaVersion"`
}

type ErrorCode string

const (
	ErrorFormat    ErrorCode = "MANIFEST_FORMAT_INVALID"
	ErrorCanonical ErrorCode = "MANIFEST_NOT_CANONICAL"
	ErrorLimit     ErrorCode = "MANIFEST_LIMIT_EXCEEDED"
	ErrorBinding   ErrorCode = "MANIFEST_BINDING_MISMATCH"
)

type ManifestError struct {
	Code    ErrorCode
	Message string
	Cause   error
}

func (e *ManifestError) Error() string { return e.Message }
func (e *ManifestError) Unwrap() error { return e.Cause }

var allowedRoles = map[FileRole]struct{}{
	RoleServiceHost: {}, RoleNodeRuntime: {},
	RoleControlBundle: {}, RoleExecutorBundle: {}, RoleProcessHost: {},
	RoleCodexCLI: {}, RoleGitCLI: {}, RoleGitHelper: {}, RoleCodexRuntime: {},
	RoleNativeLibrary: {}, RoleCABundle: {},
	RoleTrustedConfig: {}, RolePolicy: {}, RoleSchema: {}, RolePrompt: {},
	RoleRecipe: {}, RoleRuntimeData: {}, RoleLicense: {},
}

// requiredRoleCounts is the format-level minimum, not a deployable release profile. Before
// execution is enabled, a concrete profile and typed config binding must require every Git/Codex
// dependency and the role-specific CA, public-key, policy, schema, prompt, and recipe inputs used
// by that release.
var requiredRoleCounts = map[FileRole]int{
	RoleServiceHost:    1,
	RoleNodeRuntime:    1,
	RoleControlBundle:  1,
	RoleExecutorBundle: 1,
	RoleProcessHost:    1,
	RoleCodexCLI:       1,
	RoleGitCLI:         1,
}

var executableRoles = map[FileRole]struct{}{
	RoleServiceHost: {}, RoleNodeRuntime: {},
	RoleProcessHost: {}, RoleCodexCLI: {}, RoleGitCLI: {}, RoleGitHelper: {},
	RoleCodexRuntime: {},
}

var installationOnlyRoles = map[FileRole]struct{}{
	RoleServiceHost: {}, RoleNodeRuntime: {},
	RoleControlBundle: {}, RoleExecutorBundle: {}, RoleProcessHost: {},
	RoleCodexCLI: {}, RoleGitCLI: {}, RoleGitHelper: {}, RoleCodexRuntime: {},
	RoleNativeLibrary: {}, RoleRuntimeData: {}, RoleLicense: {},
}

var trustedConfigurationOnlyRoles = map[FileRole]struct{}{
	RoleTrustedConfig: {}, RolePolicy: {}, RoleSchema: {},
	RolePrompt: {}, RoleRecipe: {},
}

var dangerousNonDataExtensions = map[string]struct{}{
	".exe": {}, ".dll": {}, ".node": {}, ".com": {}, ".scr": {}, ".cpl": {},
	".sys": {}, ".drv": {}, ".ocx": {}, ".msi": {}, ".msp": {}, ".mst": {},
	".cmd": {}, ".bat": {}, ".ps1": {}, ".psm1": {}, ".psd1": {}, ".js": {},
	".jse": {}, ".mjs": {}, ".cjs": {}, ".vbs": {}, ".vbe": {}, ".wsf": {},
	".wsh": {}, ".hta": {}, ".lnk": {}, ".url": {}, ".reg": {}, ".inf": {},
	".scf": {}, ".application": {}, ".appref-ms": {}, ".gadget": {}, ".chm": {},
}

func RequiredCompatibility() Compatibility {
	return Compatibility{
		WorkerAPIProtocolVersion:   "1.0",
		LocalProtocolMajor:         1,
		LocalProtocolMinimumMinor:  0,
		LocalProtocolMaximumMinor:  0,
		ServiceHostRPCVersion:      1,
		ProcessHostProtocolVersion: 1,
	}
}

// LookupFile finds an entry by its root and case-insensitive relative Windows path.
// Callers should use a Manifest returned by Parse or MarshalCanonical.
func (m Manifest) LookupFile(root FileRoot, path string) (File, bool) {
	if !validFileRoot(root) || validateRelativePath(path) != nil {
		return File{}, false
	}
	key := fileIdentityKey(root, path)
	for _, file := range m.Files {
		if fileIdentityKey(file.Root, file.Path) == key {
			return file, true
		}
	}
	return File{}, false
}

// RequireFileBinding proves that one config-selected file is pinned by this manifest.
// Absolute config paths must first be resolved against a verified root and converted to a
// root-relative path by the platform layer.
func (m Manifest) RequireFileBinding(requirement FileBindingRequirement) (FileBindingEvidence, error) {
	normalized, err := normalize(m)
	if err != nil {
		return FileBindingEvidence{}, err
	}
	if !validFileRoot(requirement.Root) || validateRelativePath(requirement.Path) != nil {
		return FileBindingEvidence{}, manifestError(ErrorBinding, "config file binding has an invalid root or path", nil)
	}
	if _, exists := allowedRoles[requirement.Role]; !exists || !validSHA256(requirement.SHA256) {
		return FileBindingEvidence{}, manifestError(ErrorBinding, "config file binding has an invalid role or digest", nil)
	}
	if err := validateRoleRootAndPath(File{
		Root: requirement.Root,
		Path: requirement.Path,
		Role: requirement.Role,
	}); err != nil {
		return FileBindingEvidence{}, manifestError(ErrorBinding, "config file binding violates the manifest role policy", err)
	}
	file, exists := normalized.LookupFile(requirement.Root, requirement.Path)
	if !exists || file.Role != requirement.Role || file.SHA256 != requirement.SHA256 {
		return FileBindingEvidence{}, manifestError(ErrorBinding, "config file binding does not match the release manifest", nil)
	}
	canonical, err := marshalNormalized(normalized)
	if err != nil {
		return FileBindingEvidence{}, err
	}
	manifestDigest := sha256.Sum256(canonical)
	return FileBindingEvidence{
		ReleaseID:      normalized.ReleaseID,
		ManifestSHA256: fmt.Sprintf("%x", manifestDigest),
		SchemaVersion:  normalized.SchemaVersion,
		Compatibility:  normalized.Compatibility,
		File:           file,
	}, nil
}

// NewBootstrapConfigurationEvidence validates metadata for a config file that pins the manifest.
// These two files are exact trusted-root occupants and are deliberately outside the manifest.
func NewBootstrapConfigurationEvidence(
	root FileRoot,
	path string,
	sha256 string,
	size string,
) (BootstrapConfigurationEvidence, error) {
	kind, exists := bootstrapConfigurationKind(root, path)
	if !exists {
		return BootstrapConfigurationEvidence{}, manifestError(
			ErrorBinding,
			"bootstrap configuration must use its fixed trusted-root path",
			nil,
		)
	}
	if !validSHA256(sha256) {
		return BootstrapConfigurationEvidence{}, manifestError(ErrorBinding, "bootstrap configuration digest is invalid", nil)
	}
	exactSize, err := parseSize(size)
	if err != nil {
		return BootstrapConfigurationEvidence{}, manifestError(ErrorBinding, "bootstrap configuration size is invalid", err)
	}
	if exactSize == 0 || exactSize > MaximumBootstrapConfigurationBytes {
		return BootstrapConfigurationEvidence{}, manifestError(ErrorBinding, "bootstrap configuration must be non-empty and within the file limit", nil)
	}
	canonicalPath := ControlBootstrapConfigurationPath
	if kind == BootstrapExecutor {
		canonicalPath = ExecutorBootstrapConfigurationPath
	}
	return BootstrapConfigurationEvidence{
		Kind:   kind,
		Root:   RootTrustedConfiguration,
		Path:   canonicalPath,
		SHA256: sha256,
		Size:   size,
	}, nil
}

// ValidateFileContentPrefix enforces file-type evidence while a verifier hashes a file.
// prefix must be exactly the first min(file size, 5) bytes of the file.
func ValidateFileContentPrefix(file File, prefix []byte) error {
	if err := validateRoleRootAndPath(file); err != nil {
		return err
	}
	size, err := parseSize(file.Size)
	if err != nil {
		return err
	}
	if size == 0 {
		return manifestError(ErrorFormat, "release manifest files must not be empty", nil)
	}
	requiredPrefixBytes := uint64(5)
	if size < requiredPrefixBytes {
		requiredPrefixBytes = size
	}
	if uint64(len(prefix)) != requiredPrefixBytes {
		return manifestError(ErrorFormat, "verified file content prefix has an invalid length", nil)
	}
	if isPortableExecutableRole(file.Role) {
		if len(prefix) < 2 || prefix[0] != 'M' || prefix[1] != 'Z' {
			return manifestError(ErrorFormat, "release manifest PE role does not identify PE content", nil)
		}
		return nil
	}
	if file.Role == RoleControlBundle || file.Role == RoleExecutorBundle {
		if len(prefix) >= 2 && prefix[0] == 'M' && prefix[1] == 'Z' {
			return manifestError(ErrorFormat, "release manifest bundle role identifies PE content", nil)
		}
		return nil
	}
	if hasExecutableOrScriptPrefix(prefix) {
		return manifestError(ErrorFormat, "release manifest non-PE role identifies executable or shebang content", nil)
	}
	return nil
}

func hasExecutableOrScriptPrefix(prefix []byte) bool {
	if len(prefix) >= 2 && (prefix[0] == 'M' && prefix[1] == 'Z' || prefix[0] == '#' && prefix[1] == '!') {
		return true
	}
	return len(prefix) >= 5 && prefix[0] == 0xef && prefix[1] == 0xbb && prefix[2] == 0xbf &&
		prefix[3] == '#' && prefix[4] == '!'
}

// Parse accepts only the exact canonical UTF-8 representation of schema version 2.
func Parse(document []byte) (Manifest, error) {
	if len(document) == 0 {
		return Manifest{}, manifestError(ErrorFormat, "release manifest must not be empty", nil)
	}
	if len(document) > MaximumDocumentBytes {
		return Manifest{}, manifestError(ErrorLimit, "release manifest exceeds its byte limit", nil)
	}
	if bytes.HasPrefix(document, []byte{0xef, 0xbb, 0xbf}) || !utf8.Valid(document) {
		return Manifest{}, manifestError(ErrorFormat, "release manifest must be UTF-8 without a byte-order mark", nil)
	}

	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.DisallowUnknownFields()
	var value Manifest
	if err := decoder.Decode(&value); err != nil {
		return Manifest{}, manifestError(ErrorFormat, "release manifest is not strict JSON", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("multiple JSON values")
		}
		return Manifest{}, manifestError(ErrorFormat, "release manifest contains trailing content", err)
	}
	normalized, err := normalize(value)
	if err != nil {
		return Manifest{}, err
	}
	canonical, err := marshalNormalized(normalized)
	if err != nil {
		return Manifest{}, err
	}
	if !bytes.Equal(document, canonical) {
		return Manifest{}, manifestError(ErrorCanonical, "release manifest does not use its canonical representation", nil)
	}
	return normalized, nil
}

// MarshalCanonical validates, copies, sorts, and serializes a release manifest.
func MarshalCanonical(value Manifest) ([]byte, error) {
	normalized, err := normalize(value)
	if err != nil {
		return nil, err
	}
	return marshalNormalized(normalized)
}

func normalize(value Manifest) (Manifest, error) {
	if value.SchemaVersion != SchemaVersion {
		return Manifest{}, manifestError(ErrorFormat, "release manifest schemaVersion must be 2", nil)
	}
	if value.PublisherPolicy != PublisherPolicy {
		return Manifest{}, manifestError(ErrorFormat, "release manifest publisherPolicy is unsupported", nil)
	}
	if !validReleaseID(value.ReleaseID) {
		return Manifest{}, manifestError(ErrorFormat, "release manifest releaseId is invalid", nil)
	}
	if value.Compatibility != RequiredCompatibility() {
		return Manifest{}, manifestError(ErrorFormat, "release manifest compatibility is unsupported", nil)
	}
	if len(value.Files) == 0 {
		return Manifest{}, manifestError(ErrorFormat, "release manifest files must not be empty", nil)
	}
	if len(value.Files) > MaximumFiles {
		return Manifest{}, manifestError(ErrorLimit, "release manifest contains too many files", nil)
	}

	files := append([]File(nil), value.Files...)
	seenFiles := make(map[string]struct{}, len(files))
	roleCounts := make(map[FileRole]int)
	var totalBytes uint64
	for index := range files {
		file := &files[index]
		if !validFileRoot(file.Root) {
			return Manifest{}, manifestError(ErrorFormat, "release manifest contains an unsupported file root", nil)
		}
		if err := validateRelativePath(file.Path); err != nil {
			return Manifest{}, err
		}
		fileKey := fileIdentityKey(file.Root, file.Path)
		if _, exists := seenFiles[fileKey]; exists {
			return Manifest{}, manifestError(ErrorFormat, "release manifest file root and path pairs must be case-insensitively unique", nil)
		}
		seenFiles[fileKey] = struct{}{}
		if _, exists := allowedRoles[file.Role]; !exists {
			return Manifest{}, manifestError(ErrorFormat, "release manifest contains an unsupported file role", nil)
		}
		if err := validateRoleRootAndPath(*file); err != nil {
			return Manifest{}, err
		}
		if isBootstrapConfiguration(file.Root, file.Path) {
			return Manifest{}, manifestError(
				ErrorFormat,
				"release manifest must not list a ServiceHost bootstrap configuration",
				nil,
			)
		}
		if !validSHA256(file.SHA256) {
			return Manifest{}, manifestError(ErrorFormat, "release manifest contains an invalid SHA-256 digest", nil)
		}
		size, err := parseSize(file.Size)
		if err != nil {
			return Manifest{}, err
		}
		if size > MaximumFileBytes {
			return Manifest{}, manifestError(ErrorLimit, "release manifest file size exceeds the limit", nil)
		}
		if size == 0 {
			return Manifest{}, manifestError(ErrorFormat, "release manifest files must not be empty", nil)
		}
		if totalBytes > MaximumTotalBytes-size {
			return Manifest{}, manifestError(ErrorLimit, "release manifest total file size exceeds the limit", nil)
		}
		totalBytes += size
		roleCounts[file.Role]++
	}
	for role, expected := range requiredRoleCounts {
		if roleCounts[role] != expected {
			return Manifest{}, manifestError(
				ErrorFormat,
				fmt.Sprintf("release manifest must contain exactly %d %s file(s)", expected, role),
				nil,
			)
		}
	}
	sort.Slice(files, func(left, right int) bool {
		leftRoot := fileRootOrder(files[left].Root)
		rightRoot := fileRootOrder(files[right].Root)
		if leftRoot != rightRoot {
			return leftRoot < rightRoot
		}
		return asciiCaseFold(files[left].Path) < asciiCaseFold(files[right].Path)
	})
	value.Files = files
	return value, nil
}

func marshalNormalized(value Manifest) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, manifestError(ErrorFormat, "serialize release manifest", err)
	}
	document := buffer.Bytes()
	if len(document) == 0 || document[len(document)-1] != '\n' {
		return nil, manifestError(ErrorFormat, "serialize release manifest without a final newline", nil)
	}
	document = append([]byte(nil), document[:len(document)-1]...)
	if len(document) > MaximumDocumentBytes {
		return nil, manifestError(ErrorLimit, "release manifest exceeds its byte limit", nil)
	}
	return document, nil
}

func validateRelativePath(path string) error {
	if path == "" || len(path) > MaximumPathBytes || !utf8.ValidString(path) || strings.ContainsRune(path, '\x00') ||
		strings.Contains(path, "/") || strings.Contains(path, ":") || strings.HasPrefix(path, `\`) {
		return manifestError(ErrorFormat, "release manifest contains an unsafe relative path", nil)
	}
	for _, character := range path {
		if character < 0x20 || character > 0x7e {
			return manifestError(ErrorFormat, "release manifest paths must use printable ASCII", nil)
		}
	}
	for _, component := range strings.Split(path, `\`) {
		if component == "" || component == "." || component == ".." || strings.HasSuffix(component, ".") || strings.HasSuffix(component, " ") ||
			strings.ContainsAny(component, `<>"|?*`) || reservedDeviceName(component) {
			return manifestError(ErrorFormat, "release manifest path contains an unsafe component", nil)
		}
	}
	return nil
}

func validateRoleRootAndPath(file File) error {
	if _, installationOnly := installationOnlyRoles[file.Role]; installationOnly {
		if file.Root != RootInstallation {
			return manifestError(ErrorFormat, fmt.Sprintf("release manifest role %s must use the installation root", file.Role), nil)
		}
	} else if _, trustedOnly := trustedConfigurationOnlyRoles[file.Role]; trustedOnly {
		if file.Root != RootTrustedConfiguration {
			return manifestError(ErrorFormat, fmt.Sprintf("release manifest role %s must use the trusted-configuration root", file.Role), nil)
		}
	} else if file.Role == RoleCABundle {
		if !validFileRoot(file.Root) {
			return manifestError(ErrorFormat, "release manifest CA bundle has an unsupported root", nil)
		}
	} else {
		return manifestError(ErrorFormat, "release manifest contains an unsupported file role", nil)
	}

	extension := windowsExtension(file.Path)
	allowed := false
	switch file.Role {
	case RoleServiceHost, RoleNodeRuntime, RoleProcessHost,
		RoleCodexCLI, RoleGitCLI, RoleGitHelper:
		allowed = extension == ".exe"
	case RoleCodexRuntime:
		allowed = extensionIs(extension, ".exe", ".dll", ".node")
	case RoleNativeLibrary:
		allowed = extensionIs(extension, ".dll", ".node")
	case RoleControlBundle, RoleExecutorBundle:
		allowed = extension == ".mjs"
	case RoleCABundle:
		allowed = extensionIs(extension, ".pem", ".crt", ".cer")
	case RoleTrustedConfig:
		allowed = extension == ".spki"
	case RolePolicy:
		allowed = extensionIs(extension, ".toml", ".json", ".yaml", ".yml")
	case RoleSchema:
		allowed = extension == ".json"
	case RolePrompt:
		allowed = extensionIs(extension, ".md", ".txt")
	case RoleRecipe:
		allowed = extensionIs(extension, ".json", ".yaml", ".yml", ".toml")
	case RoleRuntimeData:
		allowed = extensionIs(extension, ".dat", ".bin", ".pak", ".json", ".txt")
	case RoleLicense:
		allowed = extensionIs(extension, "", ".txt", ".md", ".html", ".rtf")
	}
	if !allowed {
		return manifestError(ErrorFormat, fmt.Sprintf("release manifest role %s has an unsupported file extension", file.Role), nil)
	}

	_, portableExecutable := executableRoles[file.Role]
	if file.Role == RoleNativeLibrary {
		portableExecutable = true
	}
	if !portableExecutable && file.Role != RoleControlBundle && file.Role != RoleExecutorBundle {
		if _, dangerous := dangerousNonDataExtensions[extension]; dangerous {
			return manifestError(ErrorFormat, fmt.Sprintf("release manifest role %s must not identify executable or script content", file.Role), nil)
		}
	}
	return nil
}

func extensionIs(actual string, expected ...string) bool {
	for _, candidate := range expected {
		if actual == candidate {
			return true
		}
	}
	return false
}

func windowsExtension(path string) string {
	component := path
	if separator := strings.LastIndexByte(path, '\\'); separator >= 0 {
		component = path[separator+1:]
	}
	dot := strings.LastIndexByte(component, '.')
	if dot <= 0 {
		return ""
	}
	return asciiCaseFold(component[dot:])
}

func isPortableExecutableRole(role FileRole) bool {
	if role == RoleNativeLibrary {
		return true
	}
	_, executable := executableRoles[role]
	return executable
}

func validFileRoot(root FileRoot) bool {
	return root == RootInstallation || root == RootTrustedConfiguration
}

func fileRootOrder(root FileRoot) int {
	if root == RootInstallation {
		return 0
	}
	if root == RootTrustedConfiguration {
		return 1
	}
	return 2
}

func fileIdentityKey(root FileRoot, path string) string {
	return string(root) + "\x00" + asciiCaseFold(path)
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

func bootstrapConfigurationKind(root FileRoot, path string) (BootstrapConfigurationKind, bool) {
	if root != RootTrustedConfiguration {
		return "", false
	}
	switch asciiCaseFold(path) {
	case ControlBootstrapConfigurationPath:
		return BootstrapControl, true
	case ExecutorBootstrapConfigurationPath:
		return BootstrapExecutor, true
	default:
		return "", false
	}
}

func isBootstrapConfiguration(root FileRoot, path string) bool {
	_, exists := bootstrapConfigurationKind(root, path)
	return exists
}

func parseSize(value string) (uint64, error) {
	if value == "" || len(value) > 20 || len(value) > 1 && value[0] == '0' {
		return 0, manifestError(ErrorFormat, "release manifest file size is not canonical decimal", nil)
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return 0, manifestError(ErrorFormat, "release manifest file size is not canonical decimal", nil)
		}
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		return 0, manifestError(ErrorFormat, "release manifest file size is outside the supported range", err)
	}
	return parsed, nil
}

func validReleaseID(value string) bool {
	if len(value) == 0 || len(value) > 128 || !isASCIIAlphaNumeric(value[0]) {
		return false
	}
	for index := 1; index < len(value); index++ {
		character := value[index]
		if isASCIIAlphaNumeric(character) || strings.ContainsRune("._+-", rune(character)) {
			continue
		}
		return false
	}
	return true
}

func validSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			if character < 'a' || character > 'f' {
				return false
			}
		}
	}
	return true
}

func reservedDeviceName(component string) bool {
	base := strings.ToUpper(strings.SplitN(component, ".", 2)[0])
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
		base == "CONIN$" || base == "CONOUT$" || base == "CLOCK$" {
		return true
	}
	return len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) &&
		base[3] >= '1' && base[3] <= '9'
}

func isASCIIAlphaNumeric(value byte) bool {
	return value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z' || value >= '0' && value <= '9'
}

func manifestError(code ErrorCode, message string, cause error) error {
	return &ManifestError{Code: code, Message: message, Cause: cause}
}
