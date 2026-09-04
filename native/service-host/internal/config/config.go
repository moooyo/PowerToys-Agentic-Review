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

	InstallationRoot         = `C:\Program Files\AgenticReview\Worker`
	TrustedConfigurationRoot = `C:\ProgramData\AgenticReview\TrustedConfig`
	ControlDataRoot          = `C:\ProgramData\AgenticReview\Control`
	ExecutorDataRoot         = `C:\ProgramData\AgenticReview\Executor`

	NodeExecutablePath      = InstallationRoot + `\runtime\node.exe`
	ControlBundlePath       = InstallationRoot + `\app\control.mjs`
	ExecutorBundlePath      = InstallationRoot + `\app\executor.mjs`
	ExecutorProcessHostPath = InstallationRoot + `\bin\AgenticReview.ProcessHost.exe`
	ExecutorCodexPolicyPath = TrustedConfigurationRoot + `\codex-requirements.toml`
)

type Role string

const (
	RoleControl  Role = "control"
	RoleExecutor Role = "executor"
)

type ServiceIdentity struct {
	Name string
	SID  string
}

type Installation struct {
	Root                     string
	TrustedConfigurationRoot string
}

type Node struct {
	ExecutablePath   string
	BundlePath       string
	DataRoot         string
	WorkingDirectory string
	Environment      map[string]string
}

type ExecutorConfiguration struct {
	CodexPolicyPath string
	ProcessHostPath string
}

type Limits struct {
	RootJobMaximumProcesses             uint32
	RootJobMaximumMemoryBytes           string
	MaximumFrameBytes                   uint32
	MaximumQueuedBytesPerDirection      uint32
	ConnectTimeoutMilliseconds          uint32
	ShutdownTimeoutMilliseconds         uint32
	ForceTerminationReserveMilliseconds uint32
}

type RuntimeConfig struct {
	OwnService   ServiceIdentity
	PeerService  ServiceIdentity
	PipeName     string
	Installation Installation
	Node         Node
	Executor     *ExecutorConfiguration
	Limits       Limits
}

type Config struct {
	SchemaVersion int    `json:"schemaVersion"`
	Role          Role   `json:"role"`
	WorkerNodeID  string `json:"workerNodeId"`
	ServerOrigin  string `json:"serverOrigin,omitempty"`
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

	if c.Role == RoleControl {
		if err := validateHTTPSOrigin(c.ServerOrigin); err != nil {
			return invalid("serverOrigin: " + err.Error())
		}
		return nil
	}
	if c.ServerOrigin != "" {
		return invalid("serverOrigin must be empty for the executor role")
	}
	return nil
}

func Runtime(value Config) (RuntimeConfig, error) {
	if err := value.Validate(); err != nil {
		return RuntimeConfig{}, err
	}
	resolved, err := resolveRoleRuntime(value.Role)
	if err != nil {
		return RuntimeConfig{}, err
	}
	result := RuntimeConfig{
		OwnService:  resolved.own,
		PeerService: resolved.peer,
		PipeName:    ControlExecutorPipeName,
		Installation: Installation{
			Root:                     InstallationRoot,
			TrustedConfigurationRoot: TrustedConfigurationRoot,
		},
		Node: Node{
			ExecutablePath:   NodeExecutablePath,
			BundlePath:       resolved.bundlePath,
			DataRoot:         resolved.dataRoot,
			WorkingDirectory: resolved.dataRoot + `\Work`,
			Environment:      resolved.environment(),
		},
		Executor: resolved.executorConfiguration(),
		Limits:   fixedLimits(),
	}
	return result, nil
}

func (c Config) RuntimeConfig() (RuntimeConfig, error) {
	return Runtime(c)
}

func (c Config) Runtime() (RuntimeConfig, error) {
	return Runtime(c)
}

type roleRuntime struct {
	own        ServiceIdentity
	peer       ServiceIdentity
	bundlePath string
	dataRoot   string
	isExecutor bool
}

func resolveRoleRuntime(role Role) (roleRuntime, error) {
	switch role {
	case RoleControl:
		return roleRuntime{
			own:        ServiceIdentity{Name: ControlServiceName, SID: ControlServiceSID},
			peer:       ServiceIdentity{Name: ExecutorServiceName, SID: ExecutorServiceSID},
			bundlePath: ControlBundlePath,
			dataRoot:   ControlDataRoot,
		}, nil
	case RoleExecutor:
		return roleRuntime{
			own:        ServiceIdentity{Name: ExecutorServiceName, SID: ExecutorServiceSID},
			peer:       ServiceIdentity{Name: ControlServiceName, SID: ControlServiceSID},
			bundlePath: ExecutorBundlePath,
			dataRoot:   ExecutorDataRoot,
			isExecutor: true,
		}, nil
	default:
		return roleRuntime{}, invalid("role must be control or executor")
	}
}

func (r roleRuntime) environment() map[string]string {
	if r.isExecutor {
		return executorEnvironment()
	}
	return controlEnvironment()
}

func (r roleRuntime) executorConfiguration() *ExecutorConfiguration {
	if !r.isExecutor {
		return nil
	}
	return &ExecutorConfiguration{
		CodexPolicyPath: ExecutorCodexPolicyPath,
		ProcessHostPath: ExecutorProcessHostPath,
	}
}

func fixedLimits() Limits {
	return Limits{
		RootJobMaximumProcesses:             128,
		RootJobMaximumMemoryBytes:           "17179869184",
		MaximumFrameBytes:                   MaximumFrameBytes,
		MaximumQueuedBytesPerDirection:      4 * 1024 * 1024,
		ConnectTimeoutMilliseconds:          30_000,
		ShutdownTimeoutMilliseconds:         120_000,
		ForceTerminationReserveMilliseconds: 15_000,
	}
}

func controlEnvironment() map[string]string {
	return map[string]string{
		"APPDATA":      ControlDataRoot + `\Profile\AppData`,
		"LOCALAPPDATA": ControlDataRoot + `\Profile\LocalAppData`,
		"NODE_ENV":     "production",
		"PATH":         InstallationRoot + `\runtime`,
		"SYSTEMROOT":   `C:\Windows`,
		"TEMP":         ControlDataRoot + `\Temp`,
		"TMP":          ControlDataRoot + `\Temp`,
		"USERPROFILE":  ControlDataRoot + `\Profile`,
	}
}

func executorEnvironment() map[string]string {
	return map[string]string{
		"APPDATA":             ExecutorDataRoot + `\Profile\AppData`,
		"CODEX_HOME":          ExecutorDataRoot + `\Codex`,
		"GCM_INTERACTIVE":     "never",
		"GIT_CONFIG_GLOBAL":   ExecutorDataRoot + `\Profile\.gitconfig`,
		"GIT_CONFIG_NOSYSTEM": "1",
		"GIT_TERMINAL_PROMPT": "0",
		"HOME":                ExecutorDataRoot + `\Profile`,
		"LOCALAPPDATA":        ExecutorDataRoot + `\Profile\LocalAppData`,
		"NODE_ENV":            "production",
		"PATH":                InstallationRoot + `\runtime`,
		"SYSTEMROOT":          `C:\Windows`,
		"TEMP":                ExecutorDataRoot + `\Temp`,
		"TMP":                 ExecutorDataRoot + `\Temp`,
		"USERPROFILE":         ExecutorDataRoot + `\Profile`,
	}
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

func containsControl(value string) bool {
	for _, character := range value {
		if character < 32 || character == 127 {
			return true
		}
	}
	return false
}

func validText(value string, maximumUnits int) bool {
	return value != "" && utf8.ValidString(value) && !strings.ContainsRune(value, utf8.RuneError) &&
		!strings.ContainsRune(value, '\x00') && len(utf16.Encode([]rune(value))) <= maximumUnits
}

func validateHTTPSOrigin(origin string) error {
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

// deriveServiceSID implements the Windows SERVICE SID derivation for fixed ASCII
// service names. SHA-1 is required by the Windows identifier algorithm.
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

func invalid(message string) error {
	return configError(ErrorValidation, message, nil)
}

func configError(code ErrorCode, message string, cause error) error {
	return &ConfigError{Code: code, Message: message, Cause: cause}
}
