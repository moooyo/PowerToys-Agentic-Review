package installerdestination

import (
	"errors"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winacl"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

type accessPair struct {
	control  winacl.AccessClass
	executor winacl.AccessClass
}

var (
	readBothAccess        = accessPair{winacl.AccessRead, winacl.AccessRead}
	executeBothAccess     = accessPair{winacl.AccessReadExecute, winacl.AccessReadExecute}
	executeControlAccess  = accessPair{winacl.AccessReadExecute, winacl.AccessRead}
	executeExecutorAccess = accessPair{winacl.AccessRead, winacl.AccessReadExecute}
)

type productionSecurityPolicy struct {
	ambient          winacl.PolicyProfile
	installationDir  winacl.PolicyProfile
	trustedDir       winacl.PolicyProfile
	trustedFile      winacl.PolicyProfile
	installationFile map[accessPair]winacl.PolicyProfile
}

func newProductionSecurityPolicy() (*productionSecurityPolicy, error) {
	installationDir, err := winacl.NewManagedInstallationDirectoryProfile(config.ControlServiceSID, config.ExecutorServiceSID)
	if err != nil {
		return nil, err
	}
	trustedDir, err := winacl.NewManagedTrustedDirectoryProfile(config.ControlServiceSID, config.ExecutorServiceSID)
	if err != nil {
		return nil, err
	}
	trustedFile, err := winacl.NewManagedTrustedFileProfile(config.ControlServiceSID, config.ExecutorServiceSID)
	if err != nil {
		return nil, err
	}
	files := make(map[accessPair]winacl.PolicyProfile, 4)
	for _, access := range []accessPair{readBothAccess, executeBothAccess, executeControlAccess, executeExecutorAccess} {
		profile, err := winacl.NewManagedInstallationFileProfile(
			config.ControlServiceSID, config.ExecutorServiceSID, access.control, access.executor,
		)
		if err != nil {
			return nil, err
		}
		files[access] = profile
	}
	return &productionSecurityPolicy{
		ambient: winacl.NewAmbientAncestorProfile(), installationDir: installationDir,
		trustedDir: trustedDir, trustedFile: trustedFile, installationFile: files,
	}, nil
}

func (policy *productionSecurityPolicy) check(root outerpackage.Root, role outerpackage.Role, relativePath string, evidence winfile.Evidence, managed bool) error {
	if policy == nil {
		return errors.New("installer destination security policy is nil")
	}
	if !managed {
		if evidence.Kind != winfile.ObjectKindDirectory || evidence.SecurityMode != winfile.SecurityModeAmbientAncestor {
			return errors.New("ambient destination ancestor is invalid")
		}
		return winacl.Audit(evidence.Security, evidence.Kind, policy.ambient)
	}
	if evidence.SecurityMode != winfile.SecurityModeManaged {
		return errors.New("managed destination object has the wrong security mode")
	}
	if evidence.Kind == winfile.ObjectKindDirectory {
		profile := policy.trustedDir
		if root == outerpackage.RootInstallation {
			profile = policy.installationDir
		} else if root != outerpackage.RootMetadata && root != outerpackage.RootTrustedConfiguration {
			return errors.New("destination directory has an unsupported root")
		}
		return winacl.Audit(evidence.Security, evidence.Kind, profile)
	}
	if evidence.Kind != winfile.ObjectKindFile || relativePath == "" {
		return errors.New("destination file request is invalid")
	}
	if root == outerpackage.RootMetadata || root == outerpackage.RootTrustedConfiguration {
		return winacl.Audit(evidence.Security, evidence.Kind, policy.trustedFile)
	}
	if root != outerpackage.RootInstallation {
		return errors.New("destination file has an unsupported root")
	}
	access, err := installationAccess(role, relativePath)
	if err != nil {
		return err
	}
	profile, ok := policy.installationFile[access]
	if !ok {
		return errors.New("destination file access has no canonical ACL profile")
	}
	return winacl.Audit(evidence.Security, evidence.Kind, profile)
}

func installationAccess(role outerpackage.Role, path string) (accessPair, error) {
	switch role {
	case outerpackage.RoleRuntimeManifest,
		outerpackage.RoleCABundle,
		outerpackage.RoleRuntimeData,
		outerpackage.RoleLicense:
		return readBothAccess, nil
	case outerpackage.RoleServiceHost, outerpackage.RoleNodeRuntime:
		return executeBothAccess, nil
	case outerpackage.RoleControlBundle:
		return executeControlAccess, nil
	case outerpackage.RoleExecutorBundle,
		outerpackage.RoleProcessHost,
		outerpackage.RoleCodexCLI,
		outerpackage.RoleGitCLI,
		outerpackage.RoleGitHelper,
		outerpackage.RoleCodexRuntime:
		return executeExecutorAccess, nil
	case outerpackage.RoleNativeLibrary:
		if firstComponentEqual(path, "runtime") {
			return executeBothAccess, nil
		}
		return executeExecutorAccess, nil
	default:
		return accessPair{}, errors.New("installation file role is not permitted")
	}
}

func firstComponentEqual(path, expected string) bool {
	component := path
	if separator := strings.IndexByte(path, '\\'); separator >= 0 {
		component = path[:separator]
	}
	return strings.EqualFold(component, expected)
}
