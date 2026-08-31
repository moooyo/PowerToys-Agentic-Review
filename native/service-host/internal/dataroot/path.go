package dataroot

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

const (
	maximumWindowsPathUnits = 32_767
	maximumPathDepth        = 256
)

type windowsPath struct {
	drive      string
	components []string
}

type plannedPath struct {
	purpose    PathPurpose
	class      PathClass
	path       string
	relative   string
	components []string
	kind       winfile.ObjectKind
}

type runtimePathPlan struct {
	root          windowsPath
	rootPath      string
	managedAnchor string
	directories   []plannedPath
	files         []plannedPath
	closed        []closedDirectoryPlan
}

type closedDirectoryPlan struct {
	path     string
	children []closedChildPlan
}

type closedChildPlan struct {
	name string
	path string
	kind winfile.ObjectKind
}

func buildRuntimePathPlan(current config.Config) (runtimePathPlan, error) {
	root, err := parseWindowsPath(current.Node.DataRoot, false)
	if err != nil || len(root.components) < 2 {
		return runtimePathPlan{}, fmt.Errorf("%w: data root has no product-managed parent: %v", ErrPathPlan, err)
	}
	anchor := root.drive + strings.Join(root.components[:len(root.components)-1], `\`)
	environment := current.Node.Environment
	required := []string{"TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"}
	for _, name := range required {
		if environment[name] == "" {
			return runtimePathPlan{}, fmt.Errorf("%w: required environment path %s is missing", ErrPathPlan, name)
		}
	}
	if environment["TEMP"] != environment["TMP"] {
		return runtimePathPlan{}, fmt.Errorf("%w: TEMP and TMP must use one exact directory", ErrPathPlan)
	}

	directories := []plannedPath{
		newPlannedDirectory(PurposeWorkingDirectory, current.Node.WorkingDirectory),
		newPlannedDirectory(PurposeTemp, environment["TEMP"]),
		newPlannedDirectory(PurposeTmp, environment["TMP"]),
		newPlannedStructureDirectory(PurposeUserProfile, environment["USERPROFILE"]),
		newPlannedDirectory(PurposeAppData, environment["APPDATA"]),
		newPlannedDirectory(PurposeLocalAppData, environment["LOCALAPPDATA"]),
	}
	files := []plannedPath{}

	if current.Role == config.RoleExecutor {
		for _, name := range []string{"HOME", "CODEX_HOME", "GIT_CONFIG_GLOBAL"} {
			if environment[name] == "" {
				return runtimePathPlan{}, fmt.Errorf("%w: Executor environment path %s is missing", ErrPathPlan, name)
			}
		}
		if environment["GIT_CONFIG_NOSYSTEM"] != "1" || environment["GIT_TERMINAL_PROMPT"] != "0" ||
			environment["GCM_INTERACTIVE"] != "never" {
			return runtimePathPlan{}, fmt.Errorf("%w: Executor Git isolation variables are incomplete", ErrPathPlan)
		}
		if environment["HOME"] != environment["USERPROFILE"] {
			return runtimePathPlan{}, fmt.Errorf("%w: HOME and USERPROFILE must use one exact directory", ErrPathPlan)
		}
		directories = append(directories,
			newPlannedStructureDirectory(PurposeHome, environment["HOME"]),
			newPlannedDirectory(PurposeCodexHome, environment["CODEX_HOME"]),
		)
		files = append(files, plannedPath{
			purpose: PurposeGitConfigGlobal,
			class:   PathClassFixedFile,
			path:    environment["GIT_CONFIG_GLOBAL"],
			kind:    winfile.ObjectKindFile,
		})
	}

	for index := range directories {
		if err := bindPlannedPath(current.Node.DataRoot, &directories[index]); err != nil {
			return runtimePathPlan{}, err
		}
	}
	for index := range files {
		if err := bindPlannedPath(current.Node.DataRoot, &files[index]); err != nil {
			return runtimePathPlan{}, err
		}
	}

	byPurpose := make(map[PathPurpose]plannedPath, len(directories)+len(files))
	for _, item := range append(append([]plannedPath(nil), directories...), files...) {
		byPurpose[item.purpose] = item
	}
	for _, purpose := range []PathPurpose{PurposeWorkingDirectory, PurposeTemp, PurposeUserProfile} {
		if !isDirectChildPath(current.Node.DataRoot, byPurpose[purpose].path) {
			return runtimePathPlan{}, fmt.Errorf("%w: %s must be a direct data-root child", ErrPathPlan, purpose)
		}
	}
	for _, purpose := range []PathPurpose{PurposeAppData, PurposeLocalAppData} {
		if !isDirectChildPath(environment["USERPROFILE"], byPurpose[purpose].path) {
			return runtimePathPlan{}, fmt.Errorf("%w: %s must be a direct USERPROFILE child", ErrPathPlan, purpose)
		}
	}
	if pathsOverlapFold(byPurpose[PurposeAppData].path, byPurpose[PurposeLocalAppData].path) {
		return runtimePathPlan{}, fmt.Errorf("%w: APPDATA and LOCALAPPDATA must be disjoint", ErrPathPlan)
	}

	primary := []plannedPath{
		byPurpose[PurposeWorkingDirectory],
		byPurpose[PurposeTemp],
		byPurpose[PurposeUserProfile],
	}
	if current.Role == config.RoleExecutor {
		if !isDirectChildPath(current.Node.DataRoot, byPurpose[PurposeCodexHome].path) {
			return runtimePathPlan{}, fmt.Errorf("%w: CODEX_HOME must be a direct data-root child", ErrPathPlan)
		}
		if !isDirectChildPath(environment["HOME"], byPurpose[PurposeGitConfigGlobal].path) {
			return runtimePathPlan{}, fmt.Errorf("%w: GIT_CONFIG_GLOBAL must be a direct HOME child", ErrPathPlan)
		}
		primary = append(primary, byPurpose[PurposeCodexHome])
	}
	for left := 0; left < len(primary); left++ {
		for right := left + 1; right < len(primary); right++ {
			if pathsOverlapFold(primary[left].path, primary[right].path) {
				return runtimePathPlan{}, fmt.Errorf(
					"%w: %s and %s runtime content roots overlap",
					ErrPathPlan,
					primary[left].purpose,
					primary[right].purpose,
				)
			}
		}
	}

	sort.SliceStable(directories, func(left, right int) bool {
		if len(directories[left].components) == len(directories[right].components) {
			if directories[left].path == directories[right].path {
				return directories[left].purpose < directories[right].purpose
			}
			return directories[left].path < directories[right].path
		}
		return len(directories[left].components) < len(directories[right].components)
	})
	rootChildren := []plannedPath{
		byPurpose[PurposeWorkingDirectory],
		byPurpose[PurposeTemp],
		byPurpose[PurposeUserProfile],
	}
	profileChildren := []plannedPath{
		byPurpose[PurposeAppData],
		byPurpose[PurposeLocalAppData],
	}
	if current.Role == config.RoleExecutor {
		rootChildren = append(rootChildren, byPurpose[PurposeCodexHome])
		profileChildren = append(profileChildren, byPurpose[PurposeGitConfigGlobal])
	}
	closed := []closedDirectoryPlan{
		newClosedDirectoryPlan(current.Node.DataRoot, rootChildren),
		newClosedDirectoryPlan(environment["USERPROFILE"], profileChildren),
	}
	return runtimePathPlan{
		root: root, rootPath: current.Node.DataRoot, managedAnchor: anchor,
		directories: directories, files: files, closed: closed,
	}, nil
}

func newPlannedDirectory(purpose PathPurpose, path string) plannedPath {
	return plannedPath{purpose: purpose, class: PathClassRuntimeContent, path: path, kind: winfile.ObjectKindDirectory}
}

func newPlannedStructureDirectory(purpose PathPurpose, path string) plannedPath {
	return plannedPath{purpose: purpose, class: PathClassStructureDirectory, path: path, kind: winfile.ObjectKindDirectory}
}

func newClosedDirectoryPlan(path string, children []plannedPath) closedDirectoryPlan {
	result := closedDirectoryPlan{path: path, children: make([]closedChildPlan, 0, len(children))}
	for _, child := range children {
		name := child.components[len(child.components)-1]
		result.children = append(result.children, closedChildPlan{name: name, path: child.path, kind: child.kind})
	}
	return result
}

func bindPlannedPath(root string, item *plannedPath) error {
	file := item.kind == winfile.ObjectKindFile
	relative, components, err := relativePathExact(root, item.path, file)
	if err != nil {
		return fmt.Errorf("%w: %s: %v", ErrPathPlan, item.purpose, err)
	}
	item.relative = relative
	item.components = components
	return nil
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
	if len(components) == 0 || len(components) > maximumPathDepth {
		return windowsPath{}, errors.New("path depth is outside the supported range")
	}
	for _, component := range components {
		if err := validatePathComponent(component); err != nil {
			return windowsPath{}, err
		}
	}
	return windowsPath{drive: value[:3], components: components}, nil
}

func validatePathComponent(component string) error {
	if component == "" || component == "." || component == ".." || strings.ContainsRune(component, '~') ||
		strings.HasSuffix(component, ".") || strings.HasSuffix(component, " ") {
		return errors.New("path contains an empty, relative, or ambiguous component")
	}
	for _, character := range component {
		if character < 0x20 || character == 0x7f || strings.ContainsRune(`<>:"|?*`, character) {
			return errors.New("path contains an invalid Windows character")
		}
	}
	base := strings.ToUpper(strings.SplitN(component, ".", 2)[0])
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || base == "CONIN$" ||
		base == "CONOUT$" || base == "CLOCK$" {
		return errors.New("path contains a reserved Windows device name")
	}
	runes := []rune(base)
	if len(runes) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) &&
		(runes[3] >= '1' && runes[3] <= '9' || runes[3] == '\u00b9' || runes[3] == '\u00b2' || runes[3] == '\u00b3') {
		return errors.New("path contains a reserved Windows device name")
	}
	return nil
}

func relativePathExact(rootValue, childValue string, file bool) (string, []string, error) {
	root, err := parseWindowsPath(rootValue, false)
	if err != nil {
		return "", nil, err
	}
	child, err := parseWindowsPath(childValue, file)
	if err != nil {
		return "", nil, err
	}
	if root.drive != child.drive || len(child.components) <= len(root.components) {
		return "", nil, errors.New("path is not an exact strict descendant")
	}
	for index := range root.components {
		if root.components[index] != child.components[index] {
			return "", nil, errors.New("path changes the configured root spelling")
		}
	}
	components := append([]string(nil), child.components[len(root.components):]...)
	return strings.Join(components, `\`), components, nil
}

func isDirectChildPath(parentValue, childValue string) bool {
	parent, parentErr := parseWindowsPath(parentValue, false)
	child, childErr := parseWindowsPath(childValue, false)
	if childErr != nil {
		child, childErr = parseWindowsPath(childValue, true)
	}
	if parentErr != nil || childErr != nil || parent.drive != child.drive || len(child.components) != len(parent.components)+1 {
		return false
	}
	for index := range parent.components {
		if parent.components[index] != child.components[index] {
			return false
		}
	}
	return true
}

func pathsOverlapFold(leftValue, rightValue string) bool {
	left, leftErr := parseWindowsPath(leftValue, false)
	if leftErr != nil {
		left, leftErr = parseWindowsPath(leftValue, true)
	}
	right, rightErr := parseWindowsPath(rightValue, false)
	if rightErr != nil {
		right, rightErr = parseWindowsPath(rightValue, true)
	}
	if leftErr != nil || rightErr != nil || !strings.EqualFold(left.drive, right.drive) {
		return false
	}
	minimum := len(left.components)
	if len(right.components) < minimum {
		minimum = len(right.components)
	}
	for index := 0; index < minimum; index++ {
		if !strings.EqualFold(left.components[index], right.components[index]) {
			return false
		}
	}
	return true
}

func joinPath(parent, component string) string {
	if len(parent) == 3 {
		return parent + component
	}
	return parent + `\` + component
}
