package installverify

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
)

const maximumWindowsPathUnits = 32_767

type windowsPath struct {
	drive      string
	components []string
}

func parseWindowsPath(value string, file bool) (windowsPath, error) {
	if value == "" || !utf8.ValidString(value) || strings.ContainsRune(value, utf8.RuneError) ||
		strings.ContainsRune(value, '\x00') || len(utf16.Encode([]rune(value))) > maximumWindowsPathUnits {
		return windowsPath{}, errors.New("path is not bounded canonical Unicode")
	}
	if len(value) < 3 || value[0] < 'A' || value[0] > 'Z' || value[1] != ':' || value[2] != '\\' {
		return windowsPath{}, errors.New("path is not an absolute local drive path")
	}
	if len(value) == 3 && !file {
		return windowsPath{drive: value}, nil
	}
	if strings.Contains(value, "/") || strings.Contains(value[2:], ":") || strings.HasSuffix(value, `\`) {
		return windowsPath{}, errors.New("path contains a noncanonical separator, stream, or suffix")
	}
	components := strings.Split(value[3:], `\`)
	if len(components) == 0 {
		return windowsPath{}, errors.New("path must not identify a volume root")
	}
	for _, component := range components {
		if err := validatePathComponent(component); err != nil {
			return windowsPath{}, err
		}
	}
	if file && strings.HasSuffix(value, ".") {
		return windowsPath{}, errors.New("file path has a trailing dot")
	}
	return windowsPath{drive: value[:3], components: components}, nil
}

func validatePathComponent(component string) error {
	if component == "" || component == "." || component == ".." ||
		strings.ContainsRune(component, '~') || strings.HasSuffix(component, ".") || strings.HasSuffix(component, " ") {
		return errors.New("path contains an empty, relative, or ambiguous component")
	}
	for _, character := range component {
		if character < 0x20 || character == 0x7f || strings.ContainsRune(`<>:"|?*`, character) {
			return errors.New("path contains an invalid Windows character")
		}
	}
	base := strings.ToUpper(strings.SplitN(component, ".", 2)[0])
	baseRunes := []rune(base)
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
		base == "CONIN$" || base == "CONOUT$" || base == "CLOCK$" ||
		len(baseRunes) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) &&
			isReservedDeviceDigit(baseRunes[3]) {
		return errors.New("path contains a reserved Windows device name")
	}
	return nil
}

func isReservedDeviceDigit(value rune) bool {
	return value >= '1' && value <= '9' || value == '\u00b9' || value == '\u00b2' || value == '\u00b3'
}

func windowsPathEqual(left, right string) bool { return strings.EqualFold(left, right) }

func parentAndLeaf(path string) (string, string, error) {
	parsed, err := parseWindowsPath(path, true)
	if err != nil {
		return "", "", err
	}
	if len(parsed.components) < 2 {
		return "", "", errors.New("bootstrap file must have a non-root parent")
	}
	parent := parsed.drive + strings.Join(parsed.components[:len(parsed.components)-1], `\`)
	return parent, parsed.components[len(parsed.components)-1], nil
}

func relativePath(root, child string) (string, error) {
	rootPath, err := parseWindowsPath(root, false)
	if err != nil {
		return "", err
	}
	childPath, err := parseWindowsPath(child, true)
	if err != nil {
		return "", err
	}
	if !strings.EqualFold(rootPath.drive, childPath.drive) || len(childPath.components) <= len(rootPath.components) {
		return "", errors.New("child path is not below root")
	}
	for index := range rootPath.components {
		if !strings.EqualFold(rootPath.components[index], childPath.components[index]) {
			return "", errors.New("child path is not below root")
		}
	}
	return strings.Join(childPath.components[len(rootPath.components):], `\`), nil
}

func managedAnchorDepth(root windowsPath, anchor string) (int, error) {
	anchorPath, err := parseWindowsPath(anchor, false)
	if err != nil || len(anchorPath.components) == 0 || len(anchorPath.components) > len(root.components) ||
		!strings.EqualFold(root.drive, anchorPath.drive) {
		return 0, errors.New("managed anchor is not a non-root ancestor of the verified root")
	}
	for index := range anchorPath.components {
		if !strings.EqualFold(root.components[index], anchorPath.components[index]) {
			return 0, errors.New("managed anchor is not an ancestor of the verified root")
		}
	}
	return len(anchorPath.components), nil
}

func joinPath(root, relative string) string {
	if strings.HasSuffix(root, `\`) {
		return root + relative
	}
	return root + `\` + relative
}

func parseManifestSize(value string) (uint64, error) {
	if value == "" || len(value) > 20 || len(value) > 1 && value[0] == '0' {
		return 0, errors.New("size is not canonical decimal")
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return 0, errors.New("size is not canonical decimal")
		}
	}
	return strconv.ParseUint(value, 10, 64)
}

type filePurpose uint8

const (
	purposeManifest filePurpose = iota + 1
	purposeControlBootstrap
	purposeExecutorBootstrap
	purposeManifestEntry
)

type expectedFile struct {
	purpose  filePurpose
	manifest *releasemanifest.File
}

type expectedNode struct {
	component string
	children  map[string]*expectedNode
	file      *expectedFile
}

func newExpectedRoot() *expectedNode {
	return &expectedNode{children: make(map[string]*expectedNode)}
}

func (root *expectedNode) addFile(path string, file expectedFile, maximumDepth uint32) error {
	if path == "" || strings.HasPrefix(path, `\`) || strings.Contains(path, "/") || strings.Contains(path, ":") {
		return errors.New("expected file path is not relative and canonical")
	}
	components := strings.Split(path, `\`)
	if uint32(len(components)) > maximumDepth {
		return fmt.Errorf("expected file path depth %d exceeds %d", len(components), maximumDepth)
	}
	node := root
	for index, component := range components {
		if err := validatePathComponent(component); err != nil {
			return err
		}
		if node.file != nil {
			return errors.New("expected file is also an ancestor directory")
		}
		key := strings.ToLower(component)
		child := node.children[key]
		if child == nil {
			child = &expectedNode{component: component, children: make(map[string]*expectedNode)}
			node.children[key] = child
		} else if !strings.EqualFold(child.component, component) {
			return errors.New("expected paths contain a case-insensitive collision")
		}
		node = child
		if index == len(components)-1 {
			if node.file != nil || len(node.children) != 0 {
				return errors.New("expected path is duplicated or both a file and directory")
			}
			copy := file
			node.file = &copy
		}
	}
	return nil
}
