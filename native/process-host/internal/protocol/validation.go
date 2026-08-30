package protocol

import (
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	maximumRequestIDBytes     = 128
	maximumBoundedTextUnits   = 32_767
	maximumArgumentCount      = 1_024
	maximumEnvironmentCount   = 128
	maximumStandardInputBytes = 512 * 1024
	minimumHardTimeoutMS      = 10_000
	maximumHardTimeoutMS      = 2 * 60 * 60 * 1_000
	minimumProcessCount       = 1
	maximumProcessCount       = 256
	minimumMemoryBytes        = 128 * 1024 * 1024
	maximumMemoryBytes        = 64 * 1024 * 1024 * 1024
	minimumOutputBytes        = 4 * 1024
	maximumOutputBytes        = 128 * 1024 * 1024
)

type UnsupportedVersionError struct {
	Version string
}

func (e *UnsupportedVersionError) Error() string {
	return fmt.Sprintf("unsupported protocol version %q", e.Version)
}

type EffectiveLimits struct {
	HardTimeout         time.Duration
	MaximumProcessCount uint32
	MaximumMemoryBytes  uint64
	MaximumOutputBytes  uint64
}

func ValidateStartRequest(request StartRequest) error {
	if err := validateEnvelope(request.ProtocolVersion, request.Type, "start", request.ID); err != nil {
		return err
	}
	if err := validateBoundedText("spec.executable", request.Spec.Executable, true, maximumBoundedTextUnits); err != nil {
		return err
	}
	if err := ValidateWindowsLocalAbsolutePath(request.Spec.Executable, true); err != nil {
		return fmt.Errorf("spec.executable: %w", err)
	}
	if request.Spec.Arguments == nil {
		return errors.New("spec.arguments is required")
	}
	if len(request.Spec.Arguments) > maximumArgumentCount {
		return fmt.Errorf("spec.arguments must not contain more than %d items", maximumArgumentCount)
	}
	for index, argument := range request.Spec.Arguments {
		if err := validateBoundedText(fmt.Sprintf("spec.arguments[%d]", index), argument, false, maximumBoundedTextUnits); err != nil {
			return err
		}
	}
	if err := validateBoundedText("spec.workingDirectory", request.Spec.WorkingDirectory, true, maximumBoundedTextUnits); err != nil {
		return err
	}
	if err := ValidateWindowsLocalAbsolutePath(request.Spec.WorkingDirectory, false); err != nil {
		return fmt.Errorf("spec.workingDirectory: %w", err)
	}
	if request.Spec.EnvironmentMode != "replace" {
		return errors.New("spec.environmentMode must be \"replace\"")
	}
	if err := ValidateEnvironment(request.Spec.Environment); err != nil {
		return err
	}
	if request.Spec.StandardInput != nil {
		if err := validateStandardInput(*request.Spec.StandardInput); err != nil {
			return err
		}
	}
	_, err := ResolveLimits(request.Spec.Limits)
	return err
}

func validateStandardInput(value string) error {
	if !utf8.ValidString(value) || strings.ContainsRune(value, '\x00') {
		return errors.New("spec.standardInput must be valid UTF-8 without NUL characters")
	}
	if len(value) > maximumStandardInputBytes {
		return fmt.Errorf("spec.standardInput must not exceed %d UTF-8 bytes", maximumStandardInputBytes)
	}
	return nil
}

func ValidateTerminateRequest(request TerminateRequest) error {
	if err := validateEnvelope(request.ProtocolVersion, request.Type, "terminate", request.ID); err != nil {
		return err
	}
	if !request.Reason.Valid() {
		return fmt.Errorf("invalid termination reason %q", request.Reason)
	}
	return nil
}

func ValidateShutdownRequest(request ShutdownRequest) error {
	return validateEnvelope(request.ProtocolVersion, request.Type, "shutdown", request.ID)
}

func validateEnvelope(version, requestType, expectedType, requestID string) error {
	if version != Version {
		return &UnsupportedVersionError{Version: version}
	}
	if requestType != expectedType {
		return fmt.Errorf("request type must be %q", expectedType)
	}
	return ValidateRequestID(requestID)
}

func ResolveLimits(limits ProcessResourceLimits) (EffectiveLimits, error) {
	values := []struct {
		name    string
		value   uint64
		minimum uint64
		maximum uint64
	}{
		{name: "hardTimeoutMs", value: limits.HardTimeoutMS, minimum: minimumHardTimeoutMS, maximum: maximumHardTimeoutMS},
		{name: "maximumProcessCount", value: limits.MaximumProcessCount, minimum: minimumProcessCount, maximum: maximumProcessCount},
		{name: "maximumMemoryBytes", value: limits.MaximumMemoryBytes, minimum: minimumMemoryBytes, maximum: maximumMemoryBytes},
		{name: "maximumOutputBytes", value: limits.MaximumOutputBytes, minimum: minimumOutputBytes, maximum: maximumOutputBytes},
	}
	for _, value := range values {
		if value.value < value.minimum || value.value > value.maximum {
			return EffectiveLimits{}, fmt.Errorf("limits.%s must be between %d and %d", value.name, value.minimum, value.maximum)
		}
	}

	return EffectiveLimits{
		HardTimeout:         time.Duration(limits.HardTimeoutMS) * time.Millisecond,
		MaximumProcessCount: uint32(limits.MaximumProcessCount),
		MaximumMemoryBytes:  limits.MaximumMemoryBytes,
		MaximumOutputBytes:  limits.MaximumOutputBytes,
	}, nil
}

func ValidateWindowsLocalAbsolutePath(path string, requireExecutable bool) error {
	if path == "" {
		return errors.New("path must not be empty")
	}
	if !utf8.ValidString(path) || strings.ContainsRune(path, '\x00') {
		return errors.New("path must be valid UTF-8 without NUL characters")
	}
	if len(path) < 3 || !isASCIILetter(path[0]) || path[1] != ':' || !isPathSeparator(path[2]) {
		return errors.New("path must be an absolute drive-qualified Windows path")
	}
	if strings.Contains(path[2:], ":") {
		return errors.New("path must not contain an alternate data stream")
	}

	normalized := strings.ReplaceAll(path[3:], "/", "\\")
	for _, component := range strings.Split(normalized, "\\") {
		if component == "" {
			continue
		}
		if component == "." || component == ".." {
			return errors.New("path must not contain relative components")
		}
		if strings.HasSuffix(component, ".") || strings.HasSuffix(component, " ") {
			return errors.New("path components must not end in a dot or space")
		}
		for _, character := range component {
			if character < 32 || strings.ContainsRune(`<>"|?*`, character) {
				return errors.New("path contains a character that is invalid on Windows")
			}
		}
		if isReservedWindowsDeviceName(component) {
			return errors.New("path contains a reserved Windows device name")
		}
	}

	if requireExecutable && !strings.HasSuffix(strings.ToLower(path), ".exe") {
		return errors.New("executable path must end in .exe")
	}
	return nil
}

func isReservedWindowsDeviceName(component string) bool {
	baseName := component
	if dot := strings.IndexByte(baseName, '.'); dot >= 0 {
		baseName = baseName[:dot]
	}
	baseName = strings.ToUpper(baseName)
	switch baseName {
	case "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$":
		return true
	}
	if len(baseName) == 4 && baseName[3] >= '1' && baseName[3] <= '9' {
		return strings.HasPrefix(baseName, "COM") || strings.HasPrefix(baseName, "LPT")
	}
	return false
}

func ValidateRequestID(requestID string) error {
	if len(requestID) == 0 || len(requestID) > maximumRequestIDBytes {
		return fmt.Errorf("requestId must contain between 1 and %d ASCII characters", maximumRequestIDBytes)
	}
	for index := 0; index < len(requestID); index++ {
		character := requestID[index]
		if index == 0 {
			if !isASCIIAlphaNumeric(character) {
				return errors.New("requestId must start with an ASCII letter or digit")
			}
			continue
		}
		if !isASCIIAlphaNumeric(character) && character != '.' && character != '_' && character != ':' && character != '-' {
			return errors.New("requestId contains an unsupported character")
		}
	}
	return nil
}

func ValidateEnvironment(environment map[string]string) error {
	if environment == nil {
		return errors.New("spec.environment is required")
	}
	if len(environment) > maximumEnvironmentCount {
		return fmt.Errorf("spec.environment must not contain more than %d properties", maximumEnvironmentCount)
	}

	caseInsensitiveNames := make(map[string]string, len(environment))
	for name, value := range environment {
		if !validEnvironmentName(name) {
			return fmt.Errorf("environment variable name %q is invalid", name)
		}
		if err := validateBoundedText("environment variable "+name, value, false, maximumBoundedTextUnits); err != nil {
			return err
		}
		folded := strings.ToUpper(name)
		if previous, exists := caseInsensitiveNames[folded]; exists {
			return fmt.Errorf("environment variable names %q and %q collide case-insensitively", previous, name)
		}
		caseInsensitiveNames[folded] = name
	}
	return nil
}

func validateBoundedText(name, value string, requireNonEmpty bool, maximumUTF16Units int) error {
	if !utf8.ValidString(value) || strings.ContainsRune(value, '\x00') {
		return fmt.Errorf("%s must be valid text without NUL characters", name)
	}
	units := len(utf16.Encode([]rune(value)))
	if requireNonEmpty && units == 0 {
		return fmt.Errorf("%s must not be empty", name)
	}
	if units > maximumUTF16Units {
		return fmt.Errorf("%s must not exceed %d UTF-16 code units", name, maximumUTF16Units)
	}
	return nil
}

func validEnvironmentName(name string) bool {
	if len(name) == 0 || len(name) > 128 {
		return false
	}
	if !isASCIILetter(name[0]) && name[0] != '_' {
		return false
	}
	for index := 1; index < len(name); index++ {
		if !isASCIIAlphaNumeric(name[index]) && name[index] != '_' {
			return false
		}
	}
	return true
}

func isASCIILetter(value byte) bool {
	return value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z'
}

func isASCIIAlphaNumeric(value byte) bool {
	return isASCIILetter(value) || value >= '0' && value <= '9'
}

func isPathSeparator(value byte) bool {
	return value == '\\' || value == '/'
}
