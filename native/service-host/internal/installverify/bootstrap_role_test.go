package installverify

import (
	"errors"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
)

func TestRoleFromBootstrapPathUsesCanonicalWindowsIdentity(t *testing.T) {
	tests := []struct {
		name string
		path string
		want config.Role
	}{
		{
			name: "Control",
			path: config.ControlBootstrapPath,
			want: config.RoleControl,
		},
		{
			name: "Executor",
			path: config.ExecutorBootstrapPath,
			want: config.RoleExecutor,
		},
		{
			name: "case-insensitive full path identity",
			path: `c:\programdata\agenticreview\trustedconfig\CONTROL.JSON`,
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
		{"relative", `control.json`},
		{"root relative", `\ProgramData\AgenticReview\TrustedConfig\control.json`},
		{"drive relative", `C:ProgramData\AgenticReview\TrustedConfig\control.json`},
		{"volume root parent", `C:\control.json`},
		{"UNC", `\\server\share\control.json`},
		{"extended device", `\\?\C:\ProgramData\AgenticReview\TrustedConfig\control.json`},
		{"DOS device", `\\.\C:\ProgramData\AgenticReview\TrustedConfig\control.json`},
		{"alternate separator", `C:\ProgramData\AgenticReview\TrustedConfig/control.json`},
		{"trailing separator", `C:\ProgramData\AgenticReview\TrustedConfig\control.json\`},
		{"leaf alternate stream", `C:\ProgramData\AgenticReview\TrustedConfig\control.json:stream`},
		{"parent alternate stream", `C:\ProgramData\AgenticReview\TrustedConfig:stream\control.json`},
		{"short parent alias", `C:\PROGRA~1\AgenticReview\TrustedConfig\control.json`},
		{"short leaf alias", `C:\ProgramData\AgenticReview\TrustedConfig\CONTROL~1.JSON`},
		{"relative component", `C:\ProgramData\AgenticReview\TrustedConfig\..\control.json`},
		{"other directory", `C:\ProgramData\AgenticReview\TrustedConfig\staged\control.json`},
		{"leaf suffix", `C:\ProgramData\AgenticReview\TrustedConfig\control.json.bak`},
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
		path string
		ok   bool
	}{
		{"matching Control", config.RoleControl, config.ControlBootstrapPath, true},
		{"matching Executor", config.RoleExecutor, config.ExecutorBootstrapPath, true},
		{"Control path with Executor role", config.RoleExecutor, config.ControlBootstrapPath, false},
		{"Executor path with Control role", config.RoleControl, config.ExecutorBootstrapPath, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			selected, selectErr := RoleFromBootstrapPath(test.path)
			if selectErr != nil {
				t.Fatalf("RoleFromBootstrapPath(%q) returned an error: %v", test.path, selectErr)
			}
			normalized, err := normalizeOptions(Options{Role: test.role, ActualBootstrapPath: test.path})
			if test.ok {
				if err != nil || normalized.Role != selected || normalized.ActualBootstrapPath != test.path {
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
