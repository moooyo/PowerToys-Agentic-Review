//go:build windows

package workerinstaller

import (
	"context"
	"reflect"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc/mgr"
)

func TestServiceDefinitionsUseRestrictedVirtualAccountsAndDependency(t *testing.T) {
	executorName, executor, executorArguments := serviceDefinition(config.RoleExecutor, mgr.StartDisabled)
	if executorName != config.ExecutorServiceName || executor.StartType != mgr.StartDisabled ||
		executor.ServiceStartName != `NT SERVICE\`+config.ExecutorServiceName ||
		executor.SidType != windows.SERVICE_SID_TYPE_RESTRICTED || len(executor.Dependencies) != 0 ||
		!reflect.DeepEqual(executorArguments, []string{"--config", config.ExecutorBootstrapPath}) {
		t.Fatalf("unexpected Executor service definition: %s %+v %v", executorName, executor, executorArguments)
	}
	controlName, control, controlArguments := serviceDefinition(config.RoleControl, mgr.StartDisabled)
	if controlName != config.ControlServiceName ||
		!reflect.DeepEqual(control.Dependencies, []string{config.ExecutorServiceName}) ||
		!reflect.DeepEqual(controlArguments, []string{"--config", config.ControlBootstrapPath}) {
		t.Fatalf("unexpected Control service definition: %s %+v %v", controlName, control, controlArguments)
	}
}

func TestFixedACLGrantsUseNumericServiceSIDs(t *testing.T) {
	if got := sidGrant(config.ControlServiceSID, "R"); got != "*"+config.ControlServiceSID+":(OI)(CI)R" {
		t.Fatalf("sidGrant = %q", got)
	}
}

func TestApplyACLRemovesInheritanceBeforeChildrenAreCreated(t *testing.T) {
	var name string
	var arguments []string
	system := &windowsSystem{run: func(_ context.Context, executable string, values ...string) error {
		name = executable
		arguments = append([]string(nil), values...)
		return nil
	}}
	if err := system.applyACL(`C:\fixed`, []string{sidGrant(config.ControlServiceSID, "R")}); err != nil {
		t.Fatal(err)
	}
	want := []string{
		`C:\fixed`, "/inheritance:r", "/grant:r",
		sidGrant("S-1-5-18", "F"), sidGrant("S-1-5-32-544", "F"),
		sidGrant(config.ControlServiceSID, "R"),
	}
	if name != "icacls.exe" || !reflect.DeepEqual(arguments, want) {
		t.Fatalf("ACL command = %q %v, want icacls.exe %v", name, arguments, want)
	}
}

func TestAllowedDestinationRequiresFixedInstallOrTrustedRoot(t *testing.T) {
	for _, path := range []string{
		config.NodeExecutablePath,
		config.ExecutorCodexPolicyPath,
	} {
		if !allowedDestination(path) {
			t.Fatalf("fixed destination %q was rejected", path)
		}
	}
	for _, path := range []string{`C:\Windows\system32\evil.exe`, config.InstallationRoot + `-other\evil.exe`} {
		if allowedDestination(path) {
			t.Fatalf("outside destination %q was accepted", path)
		}
	}
}
