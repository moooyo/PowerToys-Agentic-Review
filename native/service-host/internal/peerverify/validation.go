package peerverify

import (
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const maximumWindowsPathUnits = 32_767

func validateOptions(options Options) error {
	if options.PipePeer != PipePeerClient && options.PipePeer != PipePeerServer {
		return invalidOptions("pipe peer must select the client or server endpoint")
	}
	if err := validateServiceSID(options.ExpectedServiceSID); err != nil {
		return invalidOptions("expected peer service SID must be canonical")
	}
	if err := validateImageExpectation("WinSW wrapper", options.WrapperImage); err != nil {
		return err
	}
	if err := validateImageExpectation("ServiceHost", options.ServiceHostImage); err != nil {
		return err
	}
	if sameWindowsPath(options.WrapperImage.Path, options.ServiceHostImage.Path) {
		return invalidOptions("WinSW wrapper and ServiceHost paths must be different")
	}
	if !validSHA256(options.ExpectedLeafSignerCertificateDERSHA256) {
		return invalidOptions("expected Authenticode leaf signer certificate DER SHA-256 must be 64 lowercase hexadecimal characters")
	}
	if isNilInterface(options.AuthenticodeVerifier) {
		return invalidOptions("Authenticode verifier is required")
	}
	if isNilInterface(options.TokenVerifier) {
		return invalidOptions("token verifier is required")
	}
	return nil
}

func validateImageExpectation(label string, expected ImageExpectation) error {
	if err := validateWindowsFilePath(expected.Path); err != nil {
		return invalidOptions(fmt.Sprintf("%s path: %v", label, err))
	}
	if !validSHA256(expected.SHA256) {
		return invalidOptions(fmt.Sprintf("%s SHA-256 must be 64 lowercase hexadecimal characters", label))
	}
	return nil
}

func validateWindowsFilePath(path string) error {
	if !utf8.ValidString(path) || strings.ContainsRune(path, utf8.RuneError) || strings.ContainsRune(path, '\x00') {
		return fmt.Errorf("path is not well-formed Unicode")
	}
	if len(utf16.Encode([]rune(path))) > maximumWindowsPathUnits {
		return fmt.Errorf("path exceeds the Windows UTF-16 limit")
	}
	if len(path) < 4 || path[0] < 'A' || path[0] > 'Z' || path[1] != ':' || path[2] != '\\' {
		return fmt.Errorf("expected an absolute drive file path with an uppercase drive letter")
	}
	if strings.Contains(path, "/") || strings.Contains(path[2:], ":") || strings.HasSuffix(path, `\`) {
		return fmt.Errorf("path is not canonical")
	}
	for _, component := range strings.Split(path[3:], `\`) {
		if component == "" || component == "." || component == ".." ||
			strings.HasSuffix(component, ".") || strings.HasSuffix(component, " ") {
			return fmt.Errorf("path contains a noncanonical component")
		}
		for _, character := range component {
			if character < 32 || character == 127 || strings.ContainsRune(`<>:"|?*`, character) {
				return fmt.Errorf("path contains an invalid character")
			}
		}
		base := strings.ToUpper(strings.SplitN(component, ".", 2)[0])
		baseRunes := []rune(base)
		if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
			base == "CONIN$" || base == "CONOUT$" || base == "CLOCK$" ||
			(len(baseRunes) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) &&
				isReservedDeviceDigit(baseRunes[3])) {
			return fmt.Errorf("path contains a reserved Windows device name")
		}
	}
	return nil
}

func isReservedDeviceDigit(value rune) bool {
	return value >= '1' && value <= '9' || value == '\u00b9' || value == '\u00b2' || value == '\u00b3'
}

func validateServiceSID(value string) error {
	parts := strings.Split(value, "-")
	if len(parts) != 9 || parts[0] != "S" || parts[1] != "1" || parts[2] != "5" || parts[3] != "80" {
		return ErrTokenMismatch
	}
	for _, part := range parts[4:] {
		parsed, err := strconv.ParseUint(part, 10, 32)
		if err != nil || strconv.FormatUint(parsed, 10) != part {
			return ErrTokenMismatch
		}
	}
	return nil
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

func sameWindowsPath(left string, right string) bool {
	return strings.EqualFold(normalizeDiagnosticPath(left), normalizeDiagnosticPath(right))
}

func normalizeDiagnosticPath(path string) string {
	if strings.HasPrefix(path, `\\?\`) {
		return path[4:]
	}
	if strings.HasPrefix(path, `\??\`) {
		return path[4:]
	}
	return path
}

func invalidOptions(message string) error {
	return fmt.Errorf("%w: %s", ErrInvalidOptions, message)
}

func isNilInterface(value any) bool {
	if value == nil {
		return true
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return reflected.IsNil()
	default:
		return false
	}
}
