package stagedpackage

import (
	"errors"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const maximumWindowsPathUnits = 32_767

type windowsPath struct {
	drive      string
	components []string
}

func parseStagedRootPath(value string) (windowsPath, error) {
	if value == "" || !utf8.ValidString(value) || strings.ContainsRune(value, utf8.RuneError) ||
		strings.ContainsRune(value, '\x00') || len(utf16.Encode([]rune(value))) > maximumWindowsPathUnits {
		return windowsPath{}, ErrInvalidInput
	}
	if len(value) < 4 || value[0] < 'A' || value[0] > 'Z' || value[1] != ':' || value[2] != '\\' ||
		strings.Contains(value, "/") || strings.Contains(value[2:], ":") || strings.HasSuffix(value, `\`) {
		return windowsPath{}, ErrInvalidInput
	}
	components := strings.Split(value[3:], `\`)
	if len(components) == 0 || uint32(len(components)) > maximumPathDepth {
		return windowsPath{}, ErrInvalidInput
	}
	for _, component := range components {
		if strings.ContainsRune(component, '~') || validateWindowsComponent(component) != nil {
			return windowsPath{}, ErrInvalidInput
		}
	}
	return windowsPath{drive: value[:3], components: components}, nil
}

func validateRelativePath(value string) error {
	if value == "" || strings.HasPrefix(value, `\`) || strings.Contains(value, "/") ||
		strings.Contains(value, ":") || strings.ContainsRune(value, '\x00') {
		return ErrTree
	}
	components := strings.Split(value, `\`)
	if len(components) == 0 || uint32(len(components)) > maximumPathDepth {
		return ErrTree
	}
	for _, component := range components {
		if err := validateWindowsComponent(component); err != nil {
			return ErrTree
		}
	}
	return nil
}

func validateWindowsComponent(component string) error {
	if component == "" || component == "." || component == ".." ||
		strings.HasSuffix(component, ".") || strings.HasSuffix(component, " ") {
		return errors.New("invalid Windows path component")
	}
	for _, character := range component {
		if character < 0x20 || character == 0x7f || strings.ContainsRune(`<>:"|?*`, character) {
			return errors.New("invalid Windows path character")
		}
	}
	base := strings.ToUpper(strings.SplitN(component, ".", 2)[0])
	runes := []rune(base)
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
		base == "CONIN$" || base == "CONOUT$" || base == "CLOCK$" ||
		len(runes) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) &&
			reservedDeviceDigit(runes[3]) {
		return errors.New("reserved Windows path component")
	}
	return nil
}

func reservedDeviceDigit(value rune) bool {
	return value >= '1' && value <= '9' || value == '\u00b9' || value == '\u00b2' || value == '\u00b3'
}

func parseCanonicalSize(value string) (uint64, error) {
	if value == "" || value == "0" || len(value) > 20 || value[0] == '0' {
		return 0, ErrTree
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return 0, ErrTree
		}
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil || parsed == 0 || parsed > outerMaximumFileBytes {
		return 0, ErrTree
	}
	return parsed, nil
}

func joinPath(parent, child string) string {
	if len(parent) == 3 && parent[1:] == `:\` {
		return parent + child
	}
	return parent + `\` + child
}
