package dataroot

import (
	"errors"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
)

func TestBuildRuntimePathPlanRequiresClosedPurposeLayout(t *testing.T) {
	control, executor := pairedConfigs()
	for _, current := range []config.Config{control, executor} {
		plan, err := buildRuntimePathPlan(current)
		if err != nil {
			t.Fatalf("buildRuntimePathPlan(%s) returned an error: %v", current.Role, err)
		}
		if plan.rootPath != current.Node.DataRoot || len(plan.directories) < 6 {
			t.Fatalf("plan omitted fixed paths: %#v", plan)
		}
	}
}

func TestBuildRuntimePathPlanRejectsUnsafePurposeRelationships(t *testing.T) {
	control, executor := pairedConfigs()
	tests := []struct {
		name   string
		value  config.Config
		mutate func(*config.Config)
	}{
		{name: "different TMP", value: control, mutate: func(value *config.Config) { value.Node.Environment["TMP"] = value.Node.DataRoot + `\OtherTemp` }},
		{name: "missing APPDATA", value: control, mutate: func(value *config.Config) { delete(value.Node.Environment, "APPDATA") }},
		{name: "nested work and temp", value: control, mutate: func(value *config.Config) { value.Node.WorkingDirectory = value.Node.Environment["TEMP"] + `\Work` }},
		{name: "missing Codex home", value: executor, mutate: func(value *config.Config) { delete(value.Node.Environment, "CODEX_HOME") }},
		{name: "Git config outside HOME", value: executor, mutate: func(value *config.Config) {
			value.Node.Environment["GIT_CONFIG_GLOBAL"] = value.Node.DataRoot + `\gitconfig`
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := cloneConfig(test.value)
			test.mutate(&value)
			if _, err := buildRuntimePathPlan(value); !errors.Is(err, ErrPathPlan) {
				t.Fatalf("buildRuntimePathPlan error = %v, want ErrPathPlan", err)
			}
		})
	}
}

func TestParseWindowsPathRejectsAliasAndDeviceForms(t *testing.T) {
	for _, path := range []string{
		`c:\ProgramData\AgenticReview`,
		`C:\PROGRA~1\AgenticReview`,
		`C:\ProgramData\..\Windows`,
		`\\server\share`,
		`C:\Data:stream`,
	} {
		if _, err := parseWindowsPath(path, false); err == nil {
			t.Fatalf("parseWindowsPath accepted %q", path)
		}
	}
}
