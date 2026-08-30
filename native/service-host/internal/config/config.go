package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	SchemaVersion            = 1
	MaximumDocumentBytes     = 64 * 1024
	MaximumFrameBytes        = 1_048_576
	ControlServiceName       = "AgenticReview.Worker.Control"
	ExecutorServiceName      = "AgenticReview.Worker.Executor"
	ControlExecutorPipeName  = `\\.\pipe\AgenticReview.Worker.ControlExecutor.v1`
	minimumRootJobMemory     = uint64(256 * 1024 * 1024)
	maximumRootJobMemory     = uint64(1 * 1024 * 1024 * 1024 * 1024)
	maximumEnvironmentValues = 128
	maximumEnvironmentUnits  = 32_767
)

type Role string

const (
	RoleControl  Role = "control"
	RoleExecutor Role = "executor"
)

type ServiceIdentity struct {
	Name string `json:"name"`
}

type Installation struct {
	Root           string `json:"root"`
	ManifestPath   string `json:"manifestPath"`
	ManifestSHA256 string `json:"manifestSha256"`
}

type Node struct {
	ExecutablePath   string            `json:"executablePath"`
	ExecutableSHA256 string            `json:"executableSha256"`
	BundlePath       string            `json:"bundlePath"`
	BundleSHA256     string            `json:"bundleSha256"`
	WorkingDirectory string            `json:"workingDirectory"`
	Environment      map[string]string `json:"environment"`
}

type Limits struct {
	RootJobMaximumProcesses        uint32 `json:"rootJobMaximumProcesses"`
	RootJobMaximumMemoryBytes      string `json:"rootJobMaximumMemoryBytes"`
	MaximumFrameBytes              uint32 `json:"maximumFrameBytes"`
	MaximumQueuedBytesPerDirection uint32 `json:"maximumQueuedBytesPerDirection"`
	ConnectTimeoutMilliseconds     uint32 `json:"connectTimeoutMilliseconds"`
	ShutdownTimeoutMilliseconds    uint32 `json:"shutdownTimeoutMilliseconds"`
}

type Config struct {
	SchemaVersion int             `json:"schemaVersion"`
	Role          Role            `json:"role"`
	OwnService    ServiceIdentity `json:"ownService"`
	PeerService   ServiceIdentity `json:"peerService"`
	PipeName      string          `json:"pipeName"`
	Installation  Installation    `json:"installation"`
	Node          Node            `json:"node"`
	Limits        Limits          `json:"limits"`
}

type ErrorCode string

const (
	ErrorRead       ErrorCode = "CONFIG_READ_FAILED"
	ErrorFormat     ErrorCode = "CONFIG_FORMAT_INVALID"
	ErrorCanonical  ErrorCode = "CONFIG_NOT_CANONICAL"
	ErrorValidation ErrorCode = "CONFIG_VALUE_INVALID"
)

type ConfigError struct {
	Code    ErrorCode
	Message string
	Cause   error
}

func (e *ConfigError) Error() string {
	return e.Message
}

func (e *ConfigError) Unwrap() error {
	return e.Cause
}

func Load(path string) (Config, error) {
	if path == "" {
		return Config{}, configError(ErrorRead, "configuration path is required", nil)
	}
	if runtime.GOOS == "windows" {
		if err := validateWindowsPath(path, true); err != nil {
			return Config{}, configError(ErrorRead, "configuration path is not a canonical local Windows path", nil)
		}
		return Config{}, configError(
			ErrorRead,
			"secure Windows configuration handle validation is not implemented",
			nil,
		)
	}
	info, err := os.Lstat(path)
	if err != nil {
		return Config{}, configError(ErrorRead, "inspect configuration file", err)
	}
	if !info.Mode().IsRegular() {
		return Config{}, configError(ErrorRead, "configuration path must identify a regular file", nil)
	}
	if info.Size() <= 0 || info.Size() > MaximumDocumentBytes {
		return Config{}, configError(ErrorRead, "configuration file size is outside the allowed range", nil)
	}

	file, err := os.Open(path)
	if err != nil {
		return Config{}, configError(ErrorRead, "open configuration file", err)
	}
	defer file.Close()

	document, err := io.ReadAll(io.LimitReader(file, MaximumDocumentBytes+1))
	if err != nil {
		return Config{}, configError(ErrorRead, "read configuration file", err)
	}
	if len(document) > MaximumDocumentBytes {
		return Config{}, configError(ErrorRead, "configuration file exceeds the byte limit", nil)
	}
	return Parse(document)
}

func Parse(document []byte) (Config, error) {
	if len(document) == 0 || len(document) > MaximumDocumentBytes {
		return Config{}, configError(ErrorFormat, "configuration must be non-empty and within the byte limit", nil)
	}
	if bytes.HasPrefix(document, []byte{0xef, 0xbb, 0xbf}) || !utf8.Valid(document) {
		return Config{}, configError(ErrorFormat, "configuration must be valid UTF-8 without a byte-order mark", nil)
	}

	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.DisallowUnknownFields()
	var value Config
	if err := decoder.Decode(&value); err != nil {
		return Config{}, configError(ErrorFormat, "configuration is not strict JSON", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("multiple JSON values")
		}
		return Config{}, configError(ErrorFormat, "configuration contains trailing content", err)
	}
	if err := value.Validate(); err != nil {
		return Config{}, err
	}

	canonical, err := json.Marshal(value)
	if err != nil {
		return Config{}, configError(ErrorFormat, "serialize configuration", err)
	}
	if !bytes.Equal(document, canonical) {
		return Config{}, configError(
			ErrorCanonical,
			"configuration must use the canonical JSON representation",
			nil,
		)
	}
	return value, nil
}

func MarshalCanonical(value Config) ([]byte, error) {
	if err := value.Validate(); err != nil {
		return nil, err
	}
	document, err := json.Marshal(value)
	if err != nil {
		return nil, configError(ErrorFormat, "serialize configuration", err)
	}
	if len(document) > MaximumDocumentBytes {
		return nil, configError(ErrorValidation, "configuration exceeds the byte limit", nil)
	}
	return document, nil
}

func (c Config) Validate() error {
	if c.SchemaVersion != SchemaVersion {
		return invalid("schemaVersion must be 1")
	}
	if c.Role != RoleControl && c.Role != RoleExecutor {
		return invalid("role must be control or executor")
	}

	expectedOwnName := ControlServiceName
	expectedPeerName := ExecutorServiceName
	if c.Role == RoleExecutor {
		expectedOwnName, expectedPeerName = expectedPeerName, expectedOwnName
	}
	if c.OwnService.Name != expectedOwnName || c.PeerService.Name != expectedPeerName {
		return invalid("service names do not match the selected role")
	}
	if c.PipeName != ControlExecutorPipeName {
		return invalid("pipeName must be the version 1 Control-Executor endpoint")
	}

	if err := validateWindowsPath(c.Installation.Root, false); err != nil {
		return invalid("installation.root: " + err.Error())
	}
	if err := validateWindowsPath(c.Installation.ManifestPath, true); err != nil {
		return invalid("installation.manifestPath: " + err.Error())
	}
	if !isStrictDescendant(c.Installation.Root, c.Installation.ManifestPath) {
		return invalid("installation.manifestPath must be below installation.root")
	}
	if !validSHA256(c.Installation.ManifestSHA256) {
		return invalid("installation.manifestSha256 must be a lowercase SHA-256 digest")
	}

	if err := validateWindowsPath(c.Node.ExecutablePath, true); err != nil {
		return invalid("node.executablePath: " + err.Error())
	}
	if !strings.EqualFold(extension(c.Node.ExecutablePath), ".exe") {
		return invalid("node.executablePath must identify an .exe file")
	}
	if !isStrictDescendant(c.Installation.Root, c.Node.ExecutablePath) {
		return invalid("node.executablePath must be below installation.root")
	}
	if !validSHA256(c.Node.ExecutableSHA256) {
		return invalid("node.executableSha256 must be a lowercase SHA-256 digest")
	}
	if err := validateWindowsPath(c.Node.BundlePath, true); err != nil {
		return invalid("node.bundlePath: " + err.Error())
	}
	if !strings.EqualFold(extension(c.Node.BundlePath), ".mjs") {
		return invalid("node.bundlePath must identify an .mjs file")
	}
	if !isStrictDescendant(c.Installation.Root, c.Node.BundlePath) {
		return invalid("node.bundlePath must be below installation.root")
	}
	if !validSHA256(c.Node.BundleSHA256) {
		return invalid("node.bundleSha256 must be a lowercase SHA-256 digest")
	}
	if strings.EqualFold(c.Node.ExecutablePath, c.Node.BundlePath) {
		return invalid("node executable and bundle paths must differ")
	}
	if err := validateWindowsPath(c.Node.WorkingDirectory, false); err != nil {
		return invalid("node.workingDirectory: " + err.Error())
	}
	if pathsOverlap(c.Installation.Root, c.Node.WorkingDirectory) {
		return invalid("node.workingDirectory and installation.root must not overlap")
	}
	if err := validateEnvironment(c.Role, c.Node.Environment); err != nil {
		return invalid("node.environment: " + err.Error())
	}

	if c.Limits.RootJobMaximumProcesses < 1 || c.Limits.RootJobMaximumProcesses > 4_096 {
		return invalid("limits.rootJobMaximumProcesses must be from 1 through 4096")
	}
	memoryBytes, err := parseCanonicalUint(c.Limits.RootJobMaximumMemoryBytes)
	if err != nil || memoryBytes < minimumRootJobMemory || memoryBytes > maximumRootJobMemory {
		return invalid("limits.rootJobMaximumMemoryBytes is outside the allowed range")
	}
	if c.Limits.MaximumFrameBytes != MaximumFrameBytes {
		return invalid("limits.maximumFrameBytes must be 1048576")
	}
	if c.Limits.MaximumQueuedBytesPerDirection < c.Limits.MaximumFrameBytes ||
		c.Limits.MaximumQueuedBytesPerDirection > 64*1024*1024 {
		return invalid("limits.maximumQueuedBytesPerDirection is outside the allowed range")
	}
	if c.Limits.ConnectTimeoutMilliseconds < 1_000 || c.Limits.ConnectTimeoutMilliseconds > 300_000 {
		return invalid("limits.connectTimeoutMilliseconds is outside the allowed range")
	}
	if c.Limits.ShutdownTimeoutMilliseconds < 1_000 || c.Limits.ShutdownTimeoutMilliseconds > 300_000 {
		return invalid("limits.shutdownTimeoutMilliseconds is outside the allowed range")
	}
	return nil
}

func validateWindowsPath(value string, file bool) error {
	if !validText(value, 32_767) || len(value) < 3 {
		return errors.New("must be a bounded, well-formed path")
	}
	if value[0] < 'A' || value[0] > 'Z' || value[1] != ':' || value[2] != '\\' {
		return errors.New("must be an absolute local Windows drive path with an uppercase drive letter")
	}
	if strings.Contains(value, "/") || strings.Contains(value[2:], ":") {
		return errors.New("must not contain alternate separators or data streams")
	}
	if len(value) == 3 {
		return errors.New("must not be a filesystem root")
	}
	if strings.HasSuffix(value, `\`) {
		return errors.New("must not have a trailing separator")
	}
	for _, component := range strings.Split(value[3:], `\`) {
		if err := validatePathComponent(component); err != nil {
			return err
		}
	}
	if file && strings.HasSuffix(value, ".") {
		return errors.New("file path is invalid")
	}
	return nil
}

func validatePathComponent(component string) error {
	if component == "" || component == "." || component == ".." {
		return errors.New("contains an empty or relative component")
	}
	if strings.HasSuffix(component, ".") || strings.HasSuffix(component, " ") {
		return errors.New("contains a component with a trailing dot or space")
	}
	for _, character := range component {
		if character < 32 || strings.ContainsRune(`<>:"|?*`, character) {
			return errors.New("contains an invalid Windows path character")
		}
	}
	base := strings.ToUpper(strings.SplitN(component, ".", 2)[0])
	baseRunes := []rune(base)
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
		base == "CONIN$" || base == "CONOUT$" || base == "CLOCK$" ||
		(len(baseRunes) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) &&
			isReservedDeviceDigit(baseRunes[3])) {
		return errors.New("contains a reserved Windows device name")
	}
	return nil
}

func isReservedDeviceDigit(value rune) bool {
	return value >= '1' && value <= '9' || value == '\u00b9' || value == '\u00b2' || value == '\u00b3'
}

func validateEnvironment(role Role, environment map[string]string) error {
	if environment == nil {
		return errors.New("must be an object")
	}
	if len(environment) > maximumEnvironmentValues {
		return errors.New("contains too many values")
	}
	allowed := allowedEnvironmentNames(role)
	seen := make(map[string]struct{}, len(environment))
	units := 1
	for name, value := range environment {
		if !validEnvironmentName(name) {
			return fmt.Errorf("variable name %q is invalid", name)
		}
		folded := strings.ToUpper(name)
		if name != folded {
			return errors.New("variable names must use canonical uppercase spelling")
		}
		if _, exists := seen[folded]; exists {
			return errors.New("variable names must be case-insensitively unique")
		}
		seen[folded] = struct{}{}
		if _, permitted := allowed[folded]; !permitted {
			return fmt.Errorf("variable %s is not permitted for the %s role", name, role)
		}
		if !validOptionalText(value, 32_767) || containsControl(value) {
			return fmt.Errorf("variable %s has an invalid value", name)
		}
		units += len(utf16.Encode([]rune(name))) + 1 + len(utf16.Encode([]rune(value))) + 1
		if units > maximumEnvironmentUnits {
			return errors.New("replacement environment exceeds the Windows environment block limit")
		}
		if err := validateEnvironmentValue(folded, value); err != nil {
			return fmt.Errorf("variable %s: %w", name, err)
		}
	}
	for _, required := range []string{"NODE_ENV", "PATH", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE"} {
		if _, exists := seen[required]; !exists {
			return fmt.Errorf("required variable %s is missing", required)
		}
	}
	return nil
}

func allowedEnvironmentNames(role Role) map[string]struct{} {
	allowed := map[string]struct{}{
		"APPDATA": {}, "LOCALAPPDATA": {}, "NODE_ENV": {}, "PATH": {}, "PROGRAMDATA": {},
		"SYSTEMROOT": {}, "TEMP": {}, "TMP": {}, "USERPROFILE": {}, "WINDIR": {},
	}
	if role == RoleExecutor {
		for _, name := range []string{
			"CODEX_HOME", "GCM_INTERACTIVE", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM",
			"GIT_TERMINAL_PROMPT", "HOME",
		} {
			allowed[name] = struct{}{}
		}
	}
	return allowed
}

func validateEnvironmentValue(name string, value string) error {
	switch name {
	case "NODE_ENV":
		if value != "production" {
			return errors.New("must be production")
		}
	case "PATH":
		parts := strings.Split(value, ";")
		if len(parts) == 0 || len(parts) > 32 {
			return errors.New("must contain from 1 through 32 trusted directories")
		}
		seen := make(map[string]struct{}, len(parts))
		for _, part := range parts {
			if err := validateWindowsPath(part, false); err != nil {
				return errors.New("contains a noncanonical directory")
			}
			folded := strings.ToLower(part)
			if _, exists := seen[folded]; exists {
				return errors.New("contains a duplicate directory")
			}
			seen[folded] = struct{}{}
		}
	case "GIT_CONFIG_NOSYSTEM":
		if value != "1" {
			return errors.New("must be 1")
		}
	case "GIT_TERMINAL_PROMPT":
		if value != "0" {
			return errors.New("must be 0")
		}
	case "GCM_INTERACTIVE":
		if value != "never" {
			return errors.New("must be never")
		}
	case "GIT_CONFIG_GLOBAL":
		if err := validateWindowsPath(value, true); err != nil {
			return errors.New("must be a canonical local file path")
		}
	default:
		if err := validateWindowsPath(value, false); err != nil {
			return errors.New("must be a canonical local directory path")
		}
	}
	return nil
}

func validEnvironmentName(value string) bool {
	if len(value) == 0 || len(value) > 128 || !validText(value, 128) {
		return false
	}
	for index, character := range value {
		if (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || character == '_' {
			continue
		}
		if index > 0 && character >= '0' && character <= '9' {
			continue
		}
		return false
	}
	return true
}

func validText(value string, maximumUnits int) bool {
	return value != "" && utf8.ValidString(value) && !strings.ContainsRune(value, utf8.RuneError) &&
		!strings.ContainsRune(value, '\x00') && len(utf16.Encode([]rune(value))) <= maximumUnits
}

func validOptionalText(value string, maximumUnits int) bool {
	return utf8.ValidString(value) && !strings.ContainsRune(value, utf8.RuneError) &&
		!strings.ContainsRune(value, '\x00') && len(utf16.Encode([]rune(value))) <= maximumUnits
}

func containsControl(value string) bool {
	for _, character := range value {
		if character < 32 || character == 127 {
			return true
		}
	}
	return false
}

func validSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func parseCanonicalUint(value string) (uint64, error) {
	if value == "" || (len(value) > 1 && value[0] == '0') {
		return 0, errors.New("not a canonical unsigned integer")
	}
	return strconv.ParseUint(value, 10, 64)
}

func extension(value string) string {
	name := value[strings.LastIndex(value, `\`)+1:]
	index := strings.LastIndex(name, ".")
	if index < 0 {
		return ""
	}
	return name[index:]
}

func isStrictDescendant(parent string, child string) bool {
	return strings.HasPrefix(strings.ToLower(child), strings.ToLower(parent)+`\`)
}

func pathsOverlap(left string, right string) bool {
	return strings.EqualFold(left, right) || isStrictDescendant(left, right) || isStrictDescendant(right, left)
}

func invalid(message string) error {
	return configError(ErrorValidation, message, nil)
}

func configError(code ErrorCode, message string, cause error) error {
	return &ConfigError{Code: code, Message: message, Cause: cause}
}
