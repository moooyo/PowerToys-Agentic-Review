package config

import (
	"bytes"
	"crypto/sha1"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	// SchemaVersion is the current per-Worker Bearer Token bootstrap schema.
	SchemaVersion                            = 4
	WorkerAuthenticationProfileBearerTokenV1 = "agentic-review-worker-auth-v1"
	WorkerAuthenticationProfilePath          = `C:\ProgramData\AgenticReview\Control\worker-auth-v1.json`
	MaximumDocumentBytes                     = 64 * 1024
	MaximumFrameBytes                        = 1_048_576
	ControlServiceName                       = "AgenticReview.Worker.Control"
	ExecutorServiceName                      = "AgenticReview.Worker.Executor"
	ControlServiceSID                        = "S-1-5-80-2091717111-3815740202-2957909909-902494971-3397275836"
	ExecutorServiceSID                       = "S-1-5-80-2741783613-3141871344-3258369507-3627446740-1359970993"
	ControlExecutorPipeName                  = `\\.\pipe\AgenticReview.Worker.ControlExecutor.v1`
	ControlBootstrapPath                     = `C:\ProgramData\AgenticReview\TrustedConfig\control.json`
	ExecutorBootstrapPath                    = `C:\ProgramData\AgenticReview\TrustedConfig\executor.json`
	minimumRootJobMemory                     = uint64(256 * 1024 * 1024)
	maximumRootJobMemory                     = uint64(1 * 1024 * 1024 * 1024 * 1024)
	maximumEnvironmentValues                 = 128
	maximumEnvironmentUnits                  = 32_767
)

type Role string

const (
	RoleControl  Role = "control"
	RoleExecutor Role = "executor"
)

type ServiceIdentity struct {
	Name string `json:"name"`
	SID  string `json:"sid"`
}

type Installation struct {
	Root                                           string `json:"root"`
	TrustedConfigurationRoot                       string `json:"trustedConfigurationRoot"`
	ReleaseID                                      string `json:"releaseId"`
	ManifestPath                                   string `json:"manifestPath"`
	ManifestSHA256                                 string `json:"manifestSha256"`
	ApprovedAuthenticodeSignerCertificateDERSHA256 string `json:"approvedAuthenticodeSignerCertificateDerSha256"`
}

type Node struct {
	ExecutablePath   string            `json:"executablePath"`
	ExecutableSHA256 string            `json:"executableSha256"`
	BundlePath       string            `json:"bundlePath"`
	BundleSHA256     string            `json:"bundleSha256"`
	DataRoot         string            `json:"dataRoot"`
	WorkingDirectory string            `json:"workingDirectory"`
	Environment      map[string]string `json:"environment"`
}

type ControlConfiguration struct {
	ServerOrigin                string `json:"serverOrigin"`
	ServerName                  string `json:"serverName"`
	RootCertificatePath         string `json:"rootCertificatePath"`
	RootCertificateSHA256       string `json:"rootCertificateSha256"`
	WorkerAuthenticationProfile string `json:"workerAuthenticationProfile"`
}

type ExecutorConfiguration struct {
	CodexPolicyPath   string `json:"codexPolicyPath"`
	CodexPolicySHA256 string `json:"codexPolicySha256"`
	ProcessHostPath   string `json:"processHostPath"`
	ProcessHostSHA256 string `json:"processHostSha256"`
}

type Limits struct {
	RootJobMaximumProcesses             uint32 `json:"rootJobMaximumProcesses"`
	RootJobMaximumMemoryBytes           string `json:"rootJobMaximumMemoryBytes"`
	MaximumFrameBytes                   uint32 `json:"maximumFrameBytes"`
	MaximumQueuedBytesPerDirection      uint32 `json:"maximumQueuedBytesPerDirection"`
	ConnectTimeoutMilliseconds          uint32 `json:"connectTimeoutMilliseconds"`
	ShutdownTimeoutMilliseconds         uint32 `json:"shutdownTimeoutMilliseconds"`
	ForceTerminationReserveMilliseconds uint32 `json:"forceTerminationReserveMilliseconds"`
}

type Config struct {
	SchemaVersion int                    `json:"schemaVersion"`
	Role          Role                   `json:"role"`
	WorkerNodeID  string                 `json:"workerNodeId"`
	OwnService    ServiceIdentity        `json:"ownService"`
	PeerService   ServiceIdentity        `json:"peerService"`
	PipeName      string                 `json:"pipeName"`
	Installation  Installation           `json:"installation"`
	Node          Node                   `json:"node"`
	Control       *ControlConfiguration  `json:"control"`
	Executor      *ExecutorConfiguration `json:"executor"`
	Limits        Limits                 `json:"limits"`
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
	role, err := RoleFromTrustedBootstrapPath(path)
	if err != nil {
		return Config{}, configError(ErrorRead, "configuration path does not select a trusted fixed role configuration", err)
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
	value, err := Parse(document)
	if err != nil {
		return Config{}, err
	}
	if value.Role != role {
		return Config{}, configError(ErrorValidation, "configuration role does not match its fixed trusted path", nil)
	}
	return value, nil
}

func RoleFromTrustedBootstrapPath(path string) (Role, error) {
	switch {
	case strings.EqualFold(path, ControlBootstrapPath):
		return RoleControl, nil
	case strings.EqualFold(path, ExecutorBootstrapPath):
		return RoleExecutor, nil
	default:
		return "", errors.New("path does not match a fixed trusted bootstrap location")
	}
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
		return invalid("schemaVersion must be 4")
	}
	if c.Role != RoleControl && c.Role != RoleExecutor {
		return invalid("role must be control or executor")
	}
	if !validEntityID(c.WorkerNodeID) {
		return invalid("workerNodeId must be a canonical entity identifier")
	}

	expectedOwnName := ControlServiceName
	expectedPeerName := ExecutorServiceName
	expectedOwnSID := ControlServiceSID
	expectedPeerSID := ExecutorServiceSID
	if c.Role == RoleExecutor {
		expectedOwnName, expectedPeerName = expectedPeerName, expectedOwnName
		expectedOwnSID, expectedPeerSID = expectedPeerSID, expectedOwnSID
	}
	if c.OwnService.Name != expectedOwnName || c.PeerService.Name != expectedPeerName {
		return invalid("service names do not match the selected role")
	}
	if c.OwnService.SID != expectedOwnSID || c.PeerService.SID != expectedPeerSID {
		return invalid("service SIDs do not match the fixed service names")
	}
	if c.OwnService.SID == c.PeerService.SID {
		return invalid("ownService.sid and peerService.sid must differ")
	}
	if c.PipeName != ControlExecutorPipeName {
		return invalid("pipeName must be the version 1 Control-Executor endpoint")
	}

	if err := validateWindowsPath(c.Installation.Root, false); err != nil {
		return invalid("installation.root: " + err.Error())
	}
	if err := validateWindowsPath(c.Installation.TrustedConfigurationRoot, false); err != nil {
		return invalid("installation.trustedConfigurationRoot: " + err.Error())
	}
	if pathsOverlap(c.Installation.Root, c.Installation.TrustedConfigurationRoot) {
		return invalid("installation.root and installation.trustedConfigurationRoot must not overlap")
	}
	if !validIdentifier(c.Installation.ReleaseID, 128) {
		return invalid("installation.releaseId must be a canonical release identifier")
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
	if !validSHA256(c.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256) {
		return invalid("installation.approvedAuthenticodeSignerCertificateDerSha256 must be a lowercase SHA-256 digest")
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
	if err := validateWindowsPath(c.Node.DataRoot, false); err != nil {
		return invalid("node.dataRoot: " + err.Error())
	}
	if pathsOverlap(c.Installation.Root, c.Node.DataRoot) {
		return invalid("node.dataRoot and installation.root must not overlap")
	}
	if pathsOverlap(c.Installation.TrustedConfigurationRoot, c.Node.DataRoot) {
		return invalid("node.dataRoot and installation.trustedConfigurationRoot must not overlap")
	}
	if err := validateWindowsPath(c.Node.WorkingDirectory, false); err != nil {
		return invalid("node.workingDirectory: " + err.Error())
	}
	if !isStrictDescendant(c.Node.DataRoot, c.Node.WorkingDirectory) {
		return invalid("node.workingDirectory must be below node.dataRoot")
	}
	if err := validateEnvironment(
		c.Role,
		c.Node.Environment,
		c.Installation.Root,
		c.Node.DataRoot,
	); err != nil {
		return invalid("node.environment: " + err.Error())
	}
	if err := c.validateRoleConfiguration(); err != nil {
		return err
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
	if c.Limits.ForceTerminationReserveMilliseconds == 0 ||
		c.Limits.ForceTerminationReserveMilliseconds >= c.Limits.ShutdownTimeoutMilliseconds {
		return invalid("limits.forceTerminationReserveMilliseconds must be positive and less than shutdownTimeoutMilliseconds")
	}
	return nil
}

func (c Config) validateRoleConfiguration() error {
	if c.Role == RoleControl {
		if c.Control == nil || c.Executor != nil {
			return invalid("control must be an object and executor must be null for the control role")
		}
		return c.validateControlConfiguration(*c.Control)
	}
	if c.Control != nil || c.Executor == nil {
		return invalid("control must be null and executor must be an object for the executor role")
	}
	return c.validateExecutorConfiguration(*c.Executor)
}

func (c Config) validateControlConfiguration(control ControlConfiguration) error {
	if err := validateHTTPSOrigin(control.ServerOrigin, control.ServerName); err != nil {
		return invalid("control.serverOrigin: " + err.Error())
	}
	if err := validateTrustedFile(
		c.Installation.TrustedConfigurationRoot,
		"installation.trustedConfigurationRoot",
		control.RootCertificatePath,
		control.RootCertificateSHA256,
		"control.rootCertificatePath",
		"control.rootCertificateSha256",
	); err != nil {
		return err
	}
	if control.WorkerAuthenticationProfile != WorkerAuthenticationProfileBearerTokenV1 {
		return invalid("control.workerAuthenticationProfile must select agentic-review-worker-auth-v1")
	}
	if !isDirectChild(c.Node.DataRoot, WorkerAuthenticationProfilePath) {
		return invalid("schemaVersion 4 requires the fixed Worker authentication profile below node.dataRoot")
	}
	return assertDistinctFilePaths(
		c.Installation.ManifestPath,
		c.Node.ExecutablePath,
		c.Node.BundlePath,
		control.RootCertificatePath,
	)
}

func (c Config) validateExecutorConfiguration(executor ExecutorConfiguration) error {
	for _, file := range []struct {
		pathName   string
		digestName string
		path       string
		digest     string
	}{
		{
			pathName:   "executor.codexPolicyPath",
			digestName: "executor.codexPolicySha256",
			path:       executor.CodexPolicyPath,
			digest:     executor.CodexPolicySHA256,
		},
	} {
		if err := validateTrustedFile(
			c.Installation.TrustedConfigurationRoot,
			"installation.trustedConfigurationRoot",
			file.path,
			file.digest,
			file.pathName,
			file.digestName,
		); err != nil {
			return err
		}
	}
	if err := validateTrustedFile(
		c.Installation.Root,
		"installation.root",
		executor.ProcessHostPath,
		executor.ProcessHostSHA256,
		"executor.processHostPath",
		"executor.processHostSha256",
	); err != nil {
		return err
	}
	if !strings.EqualFold(extension(executor.ProcessHostPath), ".exe") {
		return invalid("executor.processHostPath must identify an .exe file")
	}
	return assertDistinctFilePaths(
		c.Installation.ManifestPath,
		c.Node.ExecutablePath,
		c.Node.BundlePath,
		executor.CodexPolicyPath,
		executor.ProcessHostPath,
	)
}

func validateTrustedFile(
	root string,
	rootName string,
	path string,
	digest string,
	pathName string,
	digestName string,
) error {
	if err := validateWindowsPath(path, true); err != nil {
		return invalid(pathName + ": " + err.Error())
	}
	if !isStrictDescendant(root, path) {
		return invalid(pathName + " must be below " + rootName)
	}
	if !validSHA256(digest) {
		return invalid(digestName + " must be a lowercase SHA-256 digest")
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

func validateEnvironment(
	role Role,
	environment map[string]string,
	installationRoot string,
	dataRoot string,
) error {
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
		if err := validateEnvironmentBoundary(folded, value, installationRoot, dataRoot); err != nil {
			return fmt.Errorf("variable %s: %w", name, err)
		}
	}
	for _, required := range []string{
		"APPDATA", "LOCALAPPDATA", "NODE_ENV", "PATH", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE",
	} {
		if _, exists := seen[required]; !exists {
			return fmt.Errorf("required variable %s is missing", required)
		}
	}
	if role == RoleExecutor {
		for _, required := range []string{
			"CODEX_HOME", "GCM_INTERACTIVE", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM",
			"GIT_TERMINAL_PROMPT", "HOME",
		} {
			if _, exists := seen[required]; !exists {
				return fmt.Errorf("required Executor variable %s is missing", required)
			}
		}
		if !isDirectChild(environment["HOME"], environment["GIT_CONFIG_GLOBAL"]) {
			return errors.New("GIT_CONFIG_GLOBAL must be a direct HOME child file")
		}
	}
	if windir, exists := environment["WINDIR"]; exists && !strings.EqualFold(windir, environment["SYSTEMROOT"]) {
		return errors.New("WINDIR must identify the same directory as SYSTEMROOT")
	}
	return nil
}

func validateEnvironmentBoundary(
	name string,
	value string,
	installationRoot string,
	dataRoot string,
) error {
	switch name {
	case "PATH":
		for _, directory := range strings.Split(value, ";") {
			if !isStrictDescendant(installationRoot, directory) {
				return errors.New("must contain only directories below installation.root")
			}
		}
	case "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME", "CODEX_HOME", "GIT_CONFIG_GLOBAL":
		if !isStrictDescendant(dataRoot, value) {
			return errors.New("must be below node.dataRoot")
		}
	case "SYSTEMROOT", "WINDIR":
		if pathsOverlap(installationRoot, value) || pathsOverlap(dataRoot, value) {
			return errors.New("must be outside installation.root and node.dataRoot")
		}
	case "PROGRAMDATA":
		if !isStrictDescendant(value, dataRoot) {
			return errors.New("must be a strict ancestor of node.dataRoot")
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

func validIdentifier(value string, maximumBytes int) bool {
	if len(value) == 0 || len(value) > maximumBytes {
		return false
	}
	for index, character := range []byte(value) {
		if character >= 'A' && character <= 'Z' ||
			character >= 'a' && character <= 'z' ||
			character >= '0' && character <= '9' ||
			index > 0 && (character == '.' || character == '_' || character == '+' || character == '-') {
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
	for index := 1; index < len(value); index++ {
		character := value[index]
		if asciiAlphaNumeric(character) || character == '.' || character == '_' ||
			character == ':' || character == '-' {
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

// deriveServiceSID implements the Windows SERVICE SID derivation for the fixed ASCII service
// names. SHA-1 is required by the Windows identifier algorithm and is not used as a trust digest.
func deriveServiceSID(serviceName string) string {
	units := utf16.Encode([]rune(strings.ToUpper(serviceName)))
	encoded := make([]byte, len(units)*2)
	for index, unit := range units {
		binary.LittleEndian.PutUint16(encoded[index*2:], unit)
	}
	digest := sha1.Sum(encoded)
	return fmt.Sprintf(
		"S-1-5-80-%d-%d-%d-%d-%d",
		binary.LittleEndian.Uint32(digest[0:4]),
		binary.LittleEndian.Uint32(digest[4:8]),
		binary.LittleEndian.Uint32(digest[8:12]),
		binary.LittleEndian.Uint32(digest[12:16]),
		binary.LittleEndian.Uint32(digest[16:20]),
	)
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

func validateHTTPSOrigin(origin string, serverName string) error {
	if !validText(origin, 2_048) || containsControl(origin) {
		return errors.New("must be bounded canonical text")
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme != "https" || parsed.Opaque != "" || parsed.User != nil ||
		parsed.Host == "" || parsed.Path != "" || parsed.RawPath != "" || parsed.RawQuery != "" ||
		parsed.ForceQuery || parsed.Fragment != "" {
		return errors.New("must be an HTTPS origin without credentials, path, query, or fragment")
	}
	hostname := parsed.Hostname()
	if !validCanonicalHost(hostname) {
		return errors.New("contains a noncanonical host name")
	}
	port := parsed.Port()
	if port != "" {
		portNumber, parseErr := strconv.ParseUint(port, 10, 16)
		if parseErr != nil || portNumber == 0 || strconv.FormatUint(portNumber, 10) != port || port == "443" {
			return errors.New("contains a noncanonical port")
		}
	}
	canonicalHost := hostname
	if strings.ContainsRune(hostname, ':') {
		canonicalHost = "[" + hostname + "]"
	}
	canonicalOrigin := "https://" + canonicalHost
	if port != "" {
		canonicalOrigin += ":" + port
	}
	if origin != canonicalOrigin || parsed.String() != origin {
		return errors.New("must use the canonical HTTPS origin representation")
	}
	if serverName != hostname || !validCanonicalHost(serverName) {
		return errors.New("serverName must exactly match the canonical origin host")
	}
	return nil
}

func validCanonicalHost(value string) bool {
	if len(value) == 0 || len(value) > 253 || value != strings.ToLower(value) {
		return false
	}
	if address := net.ParseIP(value); address != nil {
		return address.String() == value
	}
	if strings.IndexFunc(value, func(character rune) bool {
		return character != '.' && (character < '0' || character > '9')
	}) == -1 {
		return false
	}
	if strings.HasSuffix(value, ".") {
		return false
	}
	for _, label := range strings.Split(value, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, character := range []byte(label) {
			if character >= 'a' && character <= 'z' ||
				character >= '0' && character <= '9' || character == '-' {
				continue
			}
			return false
		}
	}
	return true
}

func assertDistinctFilePaths(paths ...string) error {
	seen := make(map[string]struct{}, len(paths))
	for _, path := range paths {
		folded := strings.ToLower(path)
		if _, exists := seen[folded]; exists {
			return invalid("trusted file paths must be pairwise distinct")
		}
		seen[folded] = struct{}{}
	}
	return nil
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

func isDirectChild(parent string, child string) bool {
	prefix := parent + `\`
	if len(child) <= len(prefix) || !strings.EqualFold(child[:len(prefix)], prefix) {
		return false
	}
	return !strings.Contains(child[len(prefix):], `\`)
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
