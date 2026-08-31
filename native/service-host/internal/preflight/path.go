package preflight

import (
	"fmt"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
)

const maximumWindowsPathUnits = 32_767

type canonicalWindowsPath struct {
	drive      byte
	components []string
}

// ManifestRelativePath converts a canonical absolute path to the printable
// ASCII, root-relative Windows path accepted by releasemanifest. It uses
// component-aware, case-insensitive Windows comparisons and never consults the
// host operating system's path implementation.
func ManifestRelativePath(root string, absolutePath string) (string, error) {
	rootPath, err := parseCanonicalWindowsPath(root, false)
	if err != nil {
		return "", fmt.Errorf("invalid verified root: %w", err)
	}
	absolute, err := parseCanonicalWindowsPath(absolutePath, false)
	if err != nil {
		return "", fmt.Errorf("invalid absolute file path: %w", err)
	}
	if rootPath.drive != absolute.drive || len(absolute.components) <= len(rootPath.components) {
		return "", errorsPath("path is not a strict descendant of the verified root")
	}
	for index := range rootPath.components {
		if !strings.EqualFold(rootPath.components[index], absolute.components[index]) {
			return "", errorsPath("path is not a strict descendant of the verified root")
		}
	}
	relative := strings.Join(absolute.components[len(rootPath.components):], `\`)
	if err := validateManifestRelativePath(relative); err != nil {
		return "", err
	}
	return relative, nil
}

func parseCanonicalWindowsPath(value string, allowVolumeRoot bool) (canonicalWindowsPath, error) {
	if !utf8.ValidString(value) || strings.ContainsRune(value, utf8.RuneError) || strings.ContainsRune(value, '\x00') {
		return canonicalWindowsPath{}, errorsPath("path is not well-formed Unicode")
	}
	if len(utf16.Encode([]rune(value))) > maximumWindowsPathUnits {
		return canonicalWindowsPath{}, errorsPath("path exceeds the Windows UTF-16 limit")
	}
	if len(value) < 3 || value[0] < 'A' || value[0] > 'Z' || value[1] != ':' || value[2] != '\\' {
		return canonicalWindowsPath{}, errorsPath("path must use an uppercase local drive prefix")
	}
	if strings.Contains(value, "/") || strings.Contains(value[2:], ":") {
		return canonicalWindowsPath{}, errorsPath("alternate separators and data streams are not permitted")
	}
	if len(value) == 3 {
		if allowVolumeRoot {
			return canonicalWindowsPath{drive: value[0]}, nil
		}
		return canonicalWindowsPath{}, errorsPath("a filesystem root is not permitted")
	}
	if strings.HasSuffix(value, `\`) {
		return canonicalWindowsPath{}, errorsPath("trailing separators are not canonical")
	}
	components := strings.Split(value[3:], `\`)
	for _, component := range components {
		if err := validateWindowsComponent(component); err != nil {
			return canonicalWindowsPath{}, err
		}
	}
	return canonicalWindowsPath{drive: value[0], components: components}, nil
}

func validateWindowsComponent(component string) error {
	if component == "" || component == "." || component == ".." {
		return errorsPath("empty and relative components are not permitted")
	}
	if strings.HasSuffix(component, ".") || strings.HasSuffix(component, " ") {
		return errorsPath("trailing dots and spaces are not canonical")
	}
	if strings.ContainsRune(component, '~') {
		return errorsPath("DOS short-name markers are not permitted")
	}
	for _, character := range component {
		if character < 0x20 || strings.ContainsRune(`<>:"|?*`, character) {
			return errorsPath("path component contains an invalid Windows character")
		}
	}
	if reservedWindowsDeviceName(component) {
		return errorsPath("path component is a reserved Windows device name")
	}
	return nil
}

func validateManifestRelativePath(value string) error {
	if value == "" || len(value) > releasemanifest.MaximumPathBytes {
		return errorsPath("manifest-relative path is empty or too long")
	}
	for _, character := range value {
		if character < 0x20 || character > 0x7e {
			return errorsPath("manifest-relative path must use printable ASCII")
		}
	}
	if strings.Contains(value, "/") || strings.Contains(value, ":") || strings.HasPrefix(value, `\`) {
		return errorsPath("manifest-relative path has an unsafe prefix or separator")
	}
	for _, component := range strings.Split(value, `\`) {
		if err := validateWindowsComponent(component); err != nil {
			return err
		}
	}
	return nil
}

func reservedWindowsDeviceName(component string) bool {
	base := strings.ToUpper(strings.SplitN(component, ".", 2)[0])
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
		base == "CONIN$" || base == "CONOUT$" || base == "CLOCK$" {
		return true
	}
	runes := []rune(base)
	return len(runes) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) &&
		(runes[3] >= '1' && runes[3] <= '9' || runes[3] == '\u00b9' || runes[3] == '\u00b2' || runes[3] == '\u00b3')
}

func windowsPathEqual(left string, right string) bool {
	leftPath, leftErr := parseCanonicalWindowsPath(left, true)
	rightPath, rightErr := parseCanonicalWindowsPath(right, true)
	if leftErr != nil || rightErr != nil || leftPath.drive != rightPath.drive ||
		len(leftPath.components) != len(rightPath.components) {
		return false
	}
	for index := range leftPath.components {
		if !strings.EqualFold(leftPath.components[index], rightPath.components[index]) {
			return false
		}
	}
	return true
}

func windowsPathsOverlap(left string, right string) bool {
	leftPath, leftErr := parseCanonicalWindowsPath(left, true)
	rightPath, rightErr := parseCanonicalWindowsPath(right, true)
	if leftErr != nil || rightErr != nil || leftPath.drive != rightPath.drive {
		return false
	}
	common := len(leftPath.components)
	if len(rightPath.components) < common {
		common = len(rightPath.components)
	}
	for index := 0; index < common; index++ {
		if !strings.EqualFold(leftPath.components[index], rightPath.components[index]) {
			return false
		}
	}
	return true
}

func joinManifestPath(root string, relative string) (string, error) {
	if _, err := parseCanonicalWindowsPath(root, false); err != nil {
		return "", err
	}
	if err := validateManifestRelativePath(relative); err != nil {
		return "", err
	}
	joined := root + `\` + relative
	if _, err := parseCanonicalWindowsPath(joined, false); err != nil {
		return "", err
	}
	return joined, nil
}

type pathError struct{ message string }

func (e *pathError) Error() string { return e.message }

func errorsPath(message string) error { return &pathError{message: message} }
