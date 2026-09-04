//go:build windows

package workerinstaller

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

var ErrUnsupportedPlatform = errors.New("Worker installation requires Windows")

const (
	serviceStartTimeout = 2 * time.Minute
	serviceStopTimeout  = 30 * time.Second
	commandTimeout      = 2 * time.Minute
)

type commandRunner func(context.Context, string, ...string) error

type windowsSystem struct {
	run commandRunner
}

func NewSystem() (System, error) {
	return &windowsSystem{run: runCommand}, nil
}

func runCommand(ctx context.Context, name string, arguments ...string) error {
	command := exec.CommandContext(ctx, name, arguments...)
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s failed: %w: %s", name, err, strings.TrimSpace(string(output)))
	}
	return nil
}

func (system *windowsSystem) EnsureClean() error {
	for _, path := range []string{
		config.InstallationRoot,
		config.TrustedConfigurationRoot,
		config.ControlDataRoot,
		config.ExecutorDataRoot,
	} {
		if _, err := os.Lstat(path); err == nil {
			return fmt.Errorf("clean install requires absent path %s", path)
		} else if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("inspect clean-install path %s: %w", path, err)
		}
	}
	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect Service Control Manager: %w", err)
	}
	defer manager.Disconnect()
	for _, name := range []string{config.ExecutorServiceName, config.ControlServiceName} {
		service, openErr := manager.OpenService(name)
		if openErr == nil {
			_ = service.Close()
			return fmt.Errorf("clean install requires absent service %s", name)
		}
		if !errors.Is(openErr, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			return fmt.Errorf("inspect service %s: %w", name, openErr)
		}
	}
	return nil
}

func (system *windowsSystem) InstallFiles(files []InstallFile) error {
	for _, file := range files {
		if !allowedDestination(file.DestinationPath) {
			return fmt.Errorf("installer destination is outside fixed roots: %s", file.DestinationPath)
		}
		if err := os.MkdirAll(filepath.Dir(file.DestinationPath), 0o755); err != nil {
			return fmt.Errorf("create destination directory: %w", err)
		}
		if err := copyExclusive(file.SourcePath, file.DestinationPath); err != nil {
			return fmt.Errorf("copy %s: %w", filepath.Base(file.SourcePath), err)
		}
	}
	return nil
}

func (system *windowsSystem) WriteLocalConfig(value LocalConfig) error {
	if value.ControlPath != config.ControlBootstrapPath || value.ExecutorPath != config.ExecutorBootstrapPath ||
		value.WorkerAuthPath != config.WorkerAuthenticationProfilePath {
		return errors.New("local configuration paths are not fixed")
	}
	for _, path := range requiredRuntimeDirectories() {
		if err := os.MkdirAll(path, 0o755); err != nil {
			return fmt.Errorf("create runtime directory %s: %w", path, err)
		}
	}
	if err := system.applyRootACLs(); err != nil {
		return err
	}
	for _, file := range []struct {
		path     string
		document []byte
	}{
		{path: value.ControlPath, document: value.ControlDocument},
		{path: value.ExecutorPath, document: value.ExecutorDocument},
		{path: value.WorkerAuthPath, document: value.WorkerAuthDocument},
	} {
		if err := writeExclusive(file.path, file.document); err != nil {
			return fmt.Errorf("write local configuration %s: %w", filepath.Base(file.path), err)
		}
	}
	return nil
}

func (system *windowsSystem) CreateServicesDisabled() error {
	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect Service Control Manager: %w", err)
	}
	defer manager.Disconnect()
	for _, role := range []config.Role{config.RoleExecutor, config.RoleControl} {
		name, serviceConfig, arguments := serviceDefinition(role, mgr.StartDisabled)
		service, err := manager.CreateService(name, serviceHostPath(), serviceConfig, arguments...)
		if err != nil {
			return fmt.Errorf("create service %s: %w", name, err)
		}
		if err := service.Close(); err != nil {
			return fmt.Errorf("close created service %s: %w", name, err)
		}
	}
	return nil
}

func (system *windowsSystem) EnableServicesManual() error {
	return updateStartTypes(mgr.StartManual)
}

func (system *windowsSystem) StartExecutor() error {
	return startAndWait(config.ExecutorServiceName)
}

func (system *windowsSystem) StartControl() error {
	return startAndWait(config.ControlServiceName)
}

func (system *windowsSystem) SetServicesAutomatic() error {
	return updateStartTypes(mgr.StartAutomatic)
}

func (system *windowsSystem) StopAndDisable() error {
	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect Service Control Manager: %w", err)
	}
	defer manager.Disconnect()
	var failures []error
	for _, name := range []string{config.ControlServiceName, config.ExecutorServiceName} {
		service, openErr := manager.OpenService(name)
		if errors.Is(openErr, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			continue
		}
		if openErr != nil {
			failures = append(failures, fmt.Errorf("open service %s: %w", name, openErr))
			continue
		}
		if _, controlErr := service.Control(svc.Stop); controlErr != nil &&
			!errors.Is(controlErr, windows.ERROR_SERVICE_NOT_ACTIVE) {
			failures = append(failures, fmt.Errorf("stop service %s: %w", name, controlErr))
		} else if controlErr == nil {
			if waitErr := waitForState(service, svc.Stopped, serviceStopTimeout); waitErr != nil {
				failures = append(failures, fmt.Errorf("wait for service %s to stop: %w", name, waitErr))
			}
		}
		serviceConfig, configErr := service.Config()
		if configErr != nil {
			failures = append(failures, fmt.Errorf("read service %s config: %w", name, configErr))
		} else {
			serviceConfig.StartType = mgr.StartDisabled
			if updateErr := service.UpdateConfig(serviceConfig); updateErr != nil {
				failures = append(failures, fmt.Errorf("disable service %s: %w", name, updateErr))
			}
		}
		if closeErr := service.Close(); closeErr != nil {
			failures = append(failures, fmt.Errorf("close service %s: %w", name, closeErr))
		}
	}
	return errors.Join(failures...)
}

func (system *windowsSystem) applyRootACLs() error {
	for _, policy := range []struct {
		path   string
		grants []string
	}{
		{path: config.InstallationRoot, grants: []string{sidGrant(config.ControlServiceSID, "RX"), sidGrant(config.ExecutorServiceSID, "RX")}},
		{path: config.TrustedConfigurationRoot, grants: []string{sidGrant(config.ControlServiceSID, "R"), sidGrant(config.ExecutorServiceSID, "R")}},
		{path: config.ControlDataRoot, grants: []string{sidGrant(config.ControlServiceSID, "F")}},
		{path: config.ExecutorDataRoot, grants: []string{sidGrant(config.ExecutorServiceSID, "F")}},
	} {
		ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
		arguments := []string{
			policy.path,
			"/inheritance:r",
			"/grant:r",
			sidGrant("S-1-5-18", "F"),
			sidGrant("S-1-5-32-544", "F"),
		}
		arguments = append(arguments, policy.grants...)
		err := system.run(ctx, "icacls.exe", arguments...)
		cancel()
		if err != nil {
			return fmt.Errorf("apply fixed ACL to %s: %w", policy.path, err)
		}
	}
	return nil
}

func sidGrant(sid, rights string) string {
	return "*" + sid + ":(OI)(CI)" + rights
}

func requiredRuntimeDirectories() []string {
	return []string{
		config.TrustedConfigurationRoot,
		config.ControlDataRoot,
		config.ControlDataRoot + `\Work`,
		config.ControlDataRoot + `\Temp`,
		config.ControlDataRoot + `\Profile\AppData`,
		config.ControlDataRoot + `\Profile\LocalAppData`,
		config.ExecutorDataRoot,
		config.ExecutorDataRoot + `\Work`,
		config.ExecutorDataRoot + `\Temp`,
		config.ExecutorDataRoot + `\Profile\AppData`,
		config.ExecutorDataRoot + `\Profile\LocalAppData`,
		config.ExecutorDataRoot + `\Codex`,
	}
}

func serviceHostPath() string {
	return config.InstallationRoot + `\native\AgenticReview.ServiceHost.exe`
}

func serviceDefinition(role config.Role, startType uint32) (string, mgr.Config, []string) {
	name := config.ExecutorServiceName
	bootstrap := config.ExecutorBootstrapPath
	displayRole := "Executor"
	dependencies := []string(nil)
	if role == config.RoleControl {
		name = config.ControlServiceName
		bootstrap = config.ControlBootstrapPath
		displayRole = "Control"
		dependencies = []string{config.ExecutorServiceName}
	}
	return name, mgr.Config{
		StartType:        startType,
		ErrorControl:     mgr.ErrorNormal,
		Dependencies:     dependencies,
		ServiceStartName: `NT SERVICE\` + name,
		DisplayName:      name,
		Description:      "Agentic Review Worker " + displayRole,
		SidType:          windows.SERVICE_SID_TYPE_RESTRICTED,
	}, []string{"--config", bootstrap}
}

func updateStartTypes(startType uint32) error {
	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect Service Control Manager: %w", err)
	}
	defer manager.Disconnect()
	for _, name := range []string{config.ExecutorServiceName, config.ControlServiceName} {
		service, err := manager.OpenService(name)
		if err != nil {
			return fmt.Errorf("open service %s: %w", name, err)
		}
		serviceConfig, err := service.Config()
		if err == nil {
			serviceConfig.StartType = startType
			err = service.UpdateConfig(serviceConfig)
		}
		closeErr := service.Close()
		if err != nil {
			return errors.Join(fmt.Errorf("update service %s start type: %w", name, err), closeErr)
		}
		if closeErr != nil {
			return fmt.Errorf("close service %s after start-type update: %w", name, closeErr)
		}
	}
	return nil
}

func startAndWait(name string) error {
	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect Service Control Manager: %w", err)
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(name)
	if err != nil {
		return fmt.Errorf("open service %s: %w", name, err)
	}
	defer service.Close()
	if err := service.Start(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
		return fmt.Errorf("start service %s: %w", name, err)
	}
	if err := waitForState(service, svc.Running, serviceStartTimeout); err != nil {
		return fmt.Errorf("wait for service %s: %w", name, err)
	}
	return nil
}

func waitForState(service *mgr.Service, expected svc.State, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		status, err := service.Query()
		if err != nil {
			return err
		}
		if status.State == expected {
			return nil
		}
		if status.State == svc.Stopped && expected != svc.Stopped {
			return fmt.Errorf("service stopped with exit code %d", status.Win32ExitCode)
		}
		if !time.Now().Before(deadline) {
			return context.DeadlineExceeded
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func allowedDestination(path string) bool {
	return withinRoot(path, config.InstallationRoot) || withinRoot(path, config.TrustedConfigurationRoot)
}

func withinRoot(path, root string) bool {
	cleanPath := filepath.Clean(path)
	cleanRoot := filepath.Clean(root)
	return strings.EqualFold(cleanPath, cleanRoot) ||
		strings.HasPrefix(strings.ToUpper(cleanPath), strings.ToUpper(cleanRoot+string(filepath.Separator)))
}

func copyExclusive(sourcePath, destinationPath string) (err error) {
	source, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer source.Close()
	destination, err := os.OpenFile(destinationPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	defer func() {
		err = errors.Join(err, destination.Close())
	}()
	if _, err := io.Copy(destination, source); err != nil {
		return err
	}
	return destination.Sync()
}

func writeExclusive(path string, document []byte) (err error) {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer func() {
		err = errors.Join(err, file.Close())
	}()
	if _, err := file.Write(document); err != nil {
		return err
	}
	return file.Sync()
}
