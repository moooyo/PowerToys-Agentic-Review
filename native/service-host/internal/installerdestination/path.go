package installerdestination

import (
	"errors"
	"strings"
)

type windowsPath struct {
	drive      string
	components []string
}

func parseWindowsPath(value string) (windowsPath, error) {
	if len(value) < 3 || value[0] < 'A' || value[0] > 'Z' || value[1] != ':' || value[2] != '\\' ||
		strings.Contains(value, "/") || strings.Contains(value[2:], ":") || strings.HasSuffix(value, `\`) {
		return windowsPath{}, errors.New("path is not a canonical absolute Windows path")
	}
	components := strings.Split(value[3:], `\`)
	if len(components) == 0 {
		return windowsPath{}, errors.New("path has no components")
	}
	for _, component := range components {
		if component == "" || component == "." || component == ".." || strings.HasSuffix(component, ".") ||
			strings.HasSuffix(component, " ") || strings.ContainsAny(component, `<>"|?*`) {
			return windowsPath{}, errors.New("path contains an invalid component")
		}
	}
	return windowsPath{drive: value[:3], components: components}, nil
}

func joinPath(parent, child string) string {
	if strings.HasSuffix(parent, `\`) {
		return parent + child
	}
	return parent + `\` + child
}

func fileKey(root string, path string) string { return root + "\x00" + strings.ToLower(path) }
