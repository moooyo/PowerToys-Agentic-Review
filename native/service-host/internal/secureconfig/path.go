package secureconfig

import (
	"fmt"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const maximumWindowsPathUnits = 32_767

type pathPlan struct {
	ancestors []string
	file      string
}

func planCanonicalFilePath(path string) (pathPlan, error) {
	if !utf8.ValidString(path) || strings.ContainsRune(path, utf8.RuneError) || strings.ContainsRune(path, '\x00') {
		return pathPlan{}, fmt.Errorf("%w: path is not well-formed Unicode", ErrInvalidPath)
	}
	if len(utf16.Encode([]rune(path))) > maximumWindowsPathUnits {
		return pathPlan{}, fmt.Errorf("%w: path exceeds the Windows UTF-16 limit", ErrInvalidPath)
	}
	if len(path) < 3 || path[0] < 'A' || path[0] > 'Z' || path[1] != ':' || path[2] != '\\' {
		return pathPlan{}, fmt.Errorf("%w: expected an uppercase local drive path", ErrInvalidPath)
	}
	if strings.Contains(path, "/") || strings.Contains(path[2:], ":") {
		return pathPlan{}, fmt.Errorf("%w: alternate separators and data streams are not permitted", ErrInvalidPath)
	}
	if len(path) == 3 {
		return pathPlan{}, fmt.Errorf("%w: the volume root is not a file", ErrInvalidPath)
	}
	if strings.HasSuffix(path, `\`) {
		return pathPlan{}, fmt.Errorf("%w: trailing separators are not canonical", ErrInvalidPath)
	}

	components := strings.Split(path[3:], `\`)
	for _, component := range components {
		if err := validatePathComponent(component); err != nil {
			return pathPlan{}, err
		}
	}

	ancestors := make([]string, 0, len(components))
	current := path[:3]
	ancestors = append(ancestors, current)
	for _, component := range components[:len(components)-1] {
		if len(current) == 3 {
			current += component
		} else {
			current += `\` + component
		}
		ancestors = append(ancestors, current)
	}
	return pathPlan{ancestors: ancestors, file: path}, nil
}

func validatePathComponent(component string) error {
	if component == "" || component == "." || component == ".." {
		return fmt.Errorf("%w: empty and relative components are not permitted", ErrInvalidPath)
	}
	if strings.HasSuffix(component, ".") || strings.HasSuffix(component, " ") {
		return fmt.Errorf("%w: trailing dots and spaces are not canonical", ErrInvalidPath)
	}
	for _, character := range component {
		if character < 32 || strings.ContainsRune(`<>:"|?*`, character) {
			return fmt.Errorf("%w: component contains an invalid character", ErrInvalidPath)
		}
	}
	base := strings.ToUpper(strings.SplitN(component, ".", 2)[0])
	baseRunes := []rune(base)
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
		base == "CONIN$" || base == "CONOUT$" || base == "CLOCK$" ||
		(len(baseRunes) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) &&
			isReservedDeviceDigit(baseRunes[3])) {
		return fmt.Errorf("%w: component is a reserved Windows device name", ErrInvalidPath)
	}
	return nil
}

func isReservedDeviceDigit(value rune) bool {
	return value >= '1' && value <= '9' || value == '\u00b9' || value == '\u00b2' || value == '\u00b3'
}

func maximumReadableBytes() uint64 {
	maximumInt := uint64(^uint(0) >> 1)
	maximumInt64 := uint64(^uint64(0) >> 1)
	if maximumInt < maximumInt64 {
		return maximumInt - 1
	}
	return maximumInt64 - 1
}
