package installverify

import (
	"errors"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
)

func TestRoleFromBootstrapPathUsesCanonicalWindowsIdentity(t *testing.T) {
	tests := []struct {
		name string
		path string
		want config.Role
	}{
		{
			name: "Control",
			path: `C:\ProgramData\AgenticReview\TrustedConfig\` + releasemanifest.ControlBootstrapConfigurationPath,
			want: config.RoleControl,
		},
		{
			name: "Executor",
			path: `D:\Trusted\` + releasemanifest.ExecutorBootstrapConfigurationPath,
			want: config.RoleExecutor,
		},
		{
			name: "case-insensitive leaf identity",
			path: `C:\trusted\CONTROL-SERVICE-HOST.JSON`,
			want: config.RoleControl,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			role, err := RoleFromBootstrapPath(test.path)
			if err != nil || role != test.want {
				t.Fatalf("RoleFromBootstrapPath(%q) = (%q, %v), want (%q, nil)", test.path, role, err, test.want)
			}
		})
	}
}

func TestRoleFromBootstrapPathRejectsAliasesAndNoncanonicalPaths(t *testing.T) {
	tests := []struct {
		name string
		path string
	}{
		{"empty", ""},
		{"relative", releasemanifest.ControlBootstrapConfigurationPath},
		{"root relative", `\Trusted\control-service-host.json`},
		{"drive relative", `C:Trusted\control-service-host.json`},
		{"lowercase drive", `c:\Trusted\control-service-host.json`},
		{"volume root parent", `C:\control-service-host.json`},
		{"UNC", `\\server\share\control-service-host.json`},
		{"extended device", `\\?\C:\Trusted\control-service-host.json`},
		{"DOS device", `\\.\C:\Trusted\control-service-host.json`},
		{"alternate separator", `C:\Trusted/control-service-host.json`},
		{"trailing separator", `C:\Trusted\control-service-host.json\`},
		{"leaf alternate stream", `C:\Trusted\control-service-host.json:stream`},
		{"parent alternate stream", `C:\Trusted:stream\control-service-host.json`},
		{"short parent alias", `C:\PROGRA~1\control-service-host.json`},
		{"short leaf alias", `C:\Trusted\CONTROL~1.JSON`},
		{"relative component", `C:\Trusted\..\control-service-host.json`},
		{"reserved component", `C:\CON\control-service-host.json`},
		{"trailing dot", `C:\Trusted\control-service-host.json.`},
		{"trailing space", `C:\Trusted\control-service-host.json `},
		{"unknown leaf", `C:\Trusted\service-host.json`},
		{"leaf suffix", `C:\Trusted\control-service-host.json.bak`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			role, err := RoleFromBootstrapPath(test.path)
			if !errors.Is(err, ErrInvalidOptions) {
				t.Fatalf("RoleFromBootstrapPath(%q) = (%q, %v), want empty role and ErrInvalidOptions", test.path, role, err)
			}
			if role != "" {
				t.Fatalf("RoleFromBootstrapPath(%q) returned role %q after rejection", test.path, role)
			}
		})
	}
}

func TestNormalizeOptionsRequiresBootstrapSelectorRole(t *testing.T) {
	tests := []struct {
		name string
		role config.Role
		leaf string
		ok   bool
	}{
		{"matching Control", config.RoleControl, releasemanifest.ControlBootstrapConfigurationPath, true},
		{"matching Executor", config.RoleExecutor, releasemanifest.ExecutorBootstrapConfigurationPath, true},
		{"Control path with Executor role", config.RoleExecutor, releasemanifest.ControlBootstrapConfigurationPath, false},
		{"Executor path with Control role", config.RoleControl, releasemanifest.ExecutorBootstrapConfigurationPath, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := `C:\Trusted\` + test.leaf
			selected, selectErr := RoleFromBootstrapPath(path)
			if selectErr != nil {
				t.Fatalf("RoleFromBootstrapPath(%q) returned an error: %v", path, selectErr)
			}
			normalized, err := normalizeOptions(Options{Role: test.role, ActualBootstrapPath: path})
			if test.ok {
				if err != nil || normalized.Role != selected || normalized.ActualBootstrapPath != path {
					t.Fatalf("normalizeOptions returned (%#v, %v), selector role %q", normalized, err, selected)
				}
				return
			}
			if !errors.Is(err, ErrInvalidOptions) {
				t.Fatalf("normalizeOptions returned %v, want ErrInvalidOptions", err)
			}
		})
	}
}
