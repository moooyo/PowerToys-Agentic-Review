package launchguard

import (
	"errors"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const maximumWindowsPathUnits = 32_767

type windowsPath struct {
	drive      string
	components []string
}

func parseWindowsPath(value string, allowRoot bool) (windowsPath, error) {
	if value == "" || !utf8.ValidString(value) || strings.ContainsRune(value, utf8.RuneError) ||
		strings.ContainsRune(value, '\x00') || len(utf16.Encode([]rune(value))) > maximumWindowsPathUnits {
		return windowsPath{}, errors.New("path is not bounded canonical Unicode")
	}
	if len(value) < 3 || value[0] < 'A' || value[0] > 'Z' || value[1] != ':' || value[2] != '\\' {
		return windowsPath{}, errors.New("path is not an uppercase local-drive path")
	}
	if strings.Contains(value, "/") || strings.Contains(value[2:], ":") ||
		len(value) > 3 && strings.HasSuffix(value, `\`) {
		return windowsPath{}, errors.New("path contains a noncanonical separator, stream, or suffix")
	}
	if len(value) == 3 {
		if !allowRoot {
			return windowsPath{}, errors.New("volume root is not permitted")
		}
		return windowsPath{drive: value}, nil
	}
	components := strings.Split(value[3:], `\`)
	for _, component := range components {
		if err := validatePathComponent(component); err != nil {
			return windowsPath{}, err
		}
	}
	return windowsPath{drive: value[:3], components: components}, nil
}

func validatePathComponent(value string) error {
	if value == "" || value == "." || value == ".." || strings.ContainsRune(value, '~') ||
		strings.HasSuffix(value, ".") || strings.HasSuffix(value, " ") {
		return errors.New("path contains an empty, relative, or ambiguous component")
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f || strings.ContainsRune(`<>:"|?*`, character) {
			return errors.New("path contains an invalid Windows character")
		}
	}
	base := strings.ToUpper(strings.SplitN(value, ".", 2)[0])
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
		base == "CONIN$" || base == "CONOUT$" || base == "CLOCK$" {
		return errors.New("path contains a reserved Windows device name")
	}
	runes := []rune(base)
	if len(runes) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) &&
		(runes[3] >= '1' && runes[3] <= '9' || runes[3] == '\u00b9' || runes[3] == '\u00b2' || runes[3] == '\u00b3') {
		return errors.New("path contains a reserved Windows device name")
	}
	return nil
}

func relativeTargetComponents(rootValue, targetValue string) (windowsPath, []string, error) {
	root, err := parseWindowsPath(rootValue, false)
	if err != nil {
		return windowsPath{}, nil, err
	}
	target, err := parseWindowsPath(targetValue, false)
	if err != nil {
		return windowsPath{}, nil, err
	}
	if !strings.EqualFold(root.drive, target.drive) || len(target.components) <= len(root.components) {
		return windowsPath{}, nil, errors.New("target is not below the installation root")
	}
	for index := range root.components {
		if !strings.EqualFold(root.components[index], target.components[index]) {
			return windowsPath{}, nil, errors.New("target is not below the installation root")
		}
	}
	return root, append([]string(nil), target.components[len(root.components):]...), nil
}

func appendPath(parent, component string) string {
	if len(parent) == 3 {
		return parent + component
	}
	return parent + `\` + component
}
