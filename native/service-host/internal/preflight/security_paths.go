package preflight

import (
	"fmt"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
)

type namedSecurityPath struct {
	name string
	path string
}

func validateConfigurationSecurityPaths(value config.Config) error {
	paths := []namedSecurityPath{
		{"installation.root", value.Installation.Root},
		{"installation.trustedConfigurationRoot", value.Installation.TrustedConfigurationRoot},
		{"installation.manifestPath", value.Installation.ManifestPath},
		{"node.executablePath", value.Node.ExecutablePath},
		{"node.bundlePath", value.Node.BundlePath},
		{"node.dataRoot", value.Node.DataRoot},
		{"node.workingDirectory", value.Node.WorkingDirectory},
	}
	if value.Control != nil {
		paths = append(paths, namedSecurityPath{"control.rootCertificatePath", value.Control.RootCertificatePath})
	}
	if value.Executor != nil {
		paths = append(paths,
			namedSecurityPath{"executor.codexPolicyPath", value.Executor.CodexPolicyPath},
			namedSecurityPath{"executor.processHostPath", value.Executor.ProcessHostPath},
		)
	}
	for _, candidate := range paths {
		if _, err := parseCanonicalWindowsPath(candidate.path, false); err != nil {
			return fmt.Errorf("%s: %w", candidate.name, err)
		}
	}

	if pathValue, exists := value.Node.Environment["PATH"]; exists {
		for index, path := range strings.Split(pathValue, ";") {
			if _, err := parseCanonicalWindowsPath(path, false); err != nil {
				return fmt.Errorf("node.environment.PATH[%d]: %w", index, err)
			}
		}
	}
	for _, name := range []string{
		"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA",
		"LOCALAPPDATA", "HOME", "CODEX_HOME", "GIT_CONFIG_GLOBAL", "PROGRAMDATA",
	} {
		path, exists := value.Node.Environment[name]
		if !exists {
			continue
		}
		if _, err := parseCanonicalWindowsPath(path, false); err != nil {
			return fmt.Errorf("node.environment.%s: %w", name, err)
		}
	}
	return nil
}
