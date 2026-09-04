package workerinstaller

import (
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/workerpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/workertransport"
)

var requiredEntries = []string{
	"native/AgenticReview.ServiceHost.exe",
	"runtime/node.exe",
	"app/control.mjs",
	"app/executor.mjs",
	"bin/AgenticReview.ProcessHost.exe",
	"codex/codex.exe",
	"git/cmd/git.exe",
	"trusted/codex-requirements.toml",
}

const trustedCodexRequirementsPath = "trusted/codex-requirements.toml"

// InstallClean performs one strict clean install with no rollback, journal, repair, or resume flow.
func InstallClean(system System, input Inputs) error {
	if system == nil {
		return errors.New("system is required")
	}
	if input.SourceRoot == "" {
		return errors.New("sourceRoot is required")
	}

	manifest, err := workerpackage.ParseManifest(input.ManifestBytes)
	if err != nil {
		return fmt.Errorf("parse manifest: %w", err)
	}
	if manifest.Architecture != input.CurrentArchitecture {
		return fmt.Errorf(
			"%w: manifest=%q current=%q",
			ErrArchitectureMismatch,
			manifest.Architecture,
			input.CurrentArchitecture,
		)
	}
	if err := workerpackage.VerifySignature(input.ManifestBytes, input.RawSignature, input.ReleasePublicKey); err != nil {
		return fmt.Errorf("verify signature: %w", err)
	}
	if err := workerpackage.VerifyFiles(input.SourceRoot, manifest); err != nil {
		return fmt.Errorf("verify package files: %w", err)
	}
	if err := verifyRequiredEntries(manifest); err != nil {
		return err
	}

	installFiles := buildInstallFiles(input.SourceRoot, manifest)
	localConfig, err := buildLocalConfig(input.ServerOrigin, input.WorkerNodeID, input.Token)
	if err != nil {
		return err
	}

	if err := system.EnsureClean(); err != nil {
		return fmt.Errorf("ensure clean system state: %w", err)
	}

	if err := system.InstallFiles(installFiles); err != nil {
		return failAfterMutation(system, "install manifest files", err)
	}
	if err := system.WriteLocalConfig(localConfig); err != nil {
		return failAfterMutation(system, "write local config", err)
	}
	if err := system.CreateServicesDisabled(); err != nil {
		return failAfterMutation(system, "create services disabled", err)
	}
	if err := system.EnableServicesManual(); err != nil {
		return failAfterMutation(system, "enable services manual", err)
	}
	if err := system.StartExecutor(); err != nil {
		return failAfterMutation(system, "start executor service", err)
	}
	if err := system.StartControl(); err != nil {
		return failAfterMutation(system, "start control service", err)
	}
	if err := system.SetServicesAutomatic(); err != nil {
		return failAfterMutation(system, "set services automatic", err)
	}

	return nil
}

func verifyRequiredEntries(manifest workerpackage.Manifest) error {
	seen := make(map[string]struct{}, len(manifest.Files))
	for _, file := range manifest.Files {
		seen[strings.ToUpper(file.RelativePath)] = struct{}{}
	}

	missing := make([]string, 0, len(requiredEntries))
	for _, relativePath := range requiredEntries {
		if _, ok := seen[strings.ToUpper(relativePath)]; ok {
			continue
		}
		missing = append(missing, relativePath)
	}
	if len(missing) == 0 {
		return nil
	}
	sort.Strings(missing)
	return fmt.Errorf("%w: %s", ErrMissingRequiredFiles, strings.Join(missing, ", "))
}

func buildInstallFiles(sourceRoot string, manifest workerpackage.Manifest) []InstallFile {
	files := make([]InstallFile, 0, len(manifest.Files))
	for _, entry := range manifest.Files {
		relativeOSPath := filepath.FromSlash(entry.RelativePath)
		destinationPath := filepath.Join(config.InstallationRoot, relativeOSPath)
		if strings.EqualFold(entry.RelativePath, trustedCodexRequirementsPath) {
			destinationPath = config.ExecutorCodexPolicyPath
		}
		files = append(files, InstallFile{
			SourcePath:      filepath.Join(sourceRoot, relativeOSPath),
			DestinationPath: destinationPath,
		})
	}
	return files
}

func buildLocalConfig(serverOrigin string, workerNodeID string, token string) (LocalConfig, error) {
	control, err := config.MarshalCanonical(config.Config{
		SchemaVersion: config.SchemaVersion,
		Role:          config.RoleControl,
		WorkerNodeID:  workerNodeID,
		ServerOrigin:  serverOrigin,
	})
	if err != nil {
		return LocalConfig{}, fmt.Errorf("build control config: %w", err)
	}

	executor, err := config.MarshalCanonical(config.Config{
		SchemaVersion: config.SchemaVersion,
		Role:          config.RoleExecutor,
		WorkerNodeID:  workerNodeID,
	})
	if err != nil {
		return LocalConfig{}, fmt.Errorf("build executor config: %w", err)
	}

	workerAuth, err := workertransport.MarshalWorkerAuth(workerNodeID, token)
	if err != nil {
		return LocalConfig{}, fmt.Errorf("build worker auth profile: %w", err)
	}

	return LocalConfig{
		ControlPath:        config.ControlBootstrapPath,
		ControlDocument:    control,
		ExecutorPath:       config.ExecutorBootstrapPath,
		ExecutorDocument:   executor,
		WorkerAuthPath:     config.WorkerAuthenticationProfilePath,
		WorkerAuthDocument: workerAuth,
	}, nil
}

func failAfterMutation(system System, step string, actionErr error) error {
	cleanupErr := system.StopAndDisable()
	if cleanupErr == nil {
		return fmt.Errorf("%s: %w", step, actionErr)
	}
	return fmt.Errorf("%s: %w", step, errors.Join(actionErr, fmt.Errorf("stop and disable services: %w", cleanupErr)))
}

