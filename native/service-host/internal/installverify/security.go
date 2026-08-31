package installverify

import (
	"errors"
	"fmt"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winacl"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winidentity"
)

type serviceAccess struct {
	control  winacl.AccessClass
	executor winacl.AccessClass
}

var (
	readBoth        = serviceAccess{control: winacl.AccessRead, executor: winacl.AccessRead}
	executeBoth     = serviceAccess{control: winacl.AccessReadExecute, executor: winacl.AccessReadExecute}
	executeControl  = serviceAccess{control: winacl.AccessReadExecute, executor: winacl.AccessRead}
	executeExecutor = serviceAccess{
		control: winacl.AccessRead, executor: winacl.AccessReadExecute,
	}
)

type productionFilesystemSecurityPolicy struct {
	ambient               winacl.PolicyProfile
	installationDirectory winacl.PolicyProfile
	trustedDirectory      winacl.PolicyProfile
	trustedFile           winacl.PolicyProfile
	installationFiles     map[serviceAccess]winacl.PolicyProfile
}

func newProductionFilesystemSecurityPolicy(
	identity winidentity.Evidence,
) (filesystemSecurityPolicy, error) {
	if _, err := roleFromIdentityEvidence(identity); err != nil {
		return nil, verificationError(
			ErrorIdentity,
			"construct filesystem policy from invalid service identity evidence",
			errors.Join(ErrServiceIdentity, err),
		)
	}
	installationDirectory, err := winacl.NewManagedInstallationDirectoryProfile(
		config.ControlServiceSID,
		config.ExecutorServiceSID,
	)
	if err != nil {
		return nil, fmt.Errorf("construct installation directory ACL profile: %w", err)
	}
	trustedDirectory, err := winacl.NewManagedTrustedDirectoryProfile(
		config.ControlServiceSID,
		config.ExecutorServiceSID,
	)
	if err != nil {
		return nil, fmt.Errorf("construct trusted directory ACL profile: %w", err)
	}
	trustedFile, err := winacl.NewManagedTrustedFileProfile(
		config.ControlServiceSID,
		config.ExecutorServiceSID,
	)
	if err != nil {
		return nil, fmt.Errorf("construct trusted file ACL profile: %w", err)
	}

	files := make(map[serviceAccess]winacl.PolicyProfile, 4)
	for _, access := range []serviceAccess{readBoth, executeBoth, executeControl, executeExecutor} {
		profile, profileErr := winacl.NewManagedInstallationFileProfile(
			config.ControlServiceSID,
			config.ExecutorServiceSID,
			access.control,
			access.executor,
		)
		if profileErr != nil {
			return nil, fmt.Errorf("construct installation file ACL profile: %w", profileErr)
		}
		files[access] = profile
	}
	return &productionFilesystemSecurityPolicy{
		ambient:               winacl.NewAmbientAncestorProfile(),
		installationDirectory: installationDirectory,
		trustedDirectory:      trustedDirectory,
		trustedFile:           trustedFile,
		installationFiles:     files,
	}, nil
}

func (policy *productionFilesystemSecurityPolicy) CheckDirectory(
	request directorySecurityRequest,
) error {
	if policy == nil {
		return errors.New("filesystem security policy is nil")
	}
	mode := request.object.Evidence.SecurityMode
	var profile winacl.PolicyProfile
	switch mode {
	case winfile.SecurityModeAmbientAncestor:
		profile = policy.ambient
	case winfile.SecurityModeManaged:
		switch request.root {
		case releasemanifest.RootInstallation:
			profile = policy.installationDirectory
		case releasemanifest.RootTrustedConfiguration:
			profile = policy.trustedDirectory
		default:
			return fmt.Errorf("unsupported directory root %q", request.root)
		}
	default:
		return fmt.Errorf("unsupported directory security mode %d", mode)
	}
	if request.isVolumeRoot != (len(request.object.Path) == 3) {
		return errors.New("directory volume-root designation is inconsistent")
	}
	return winacl.Audit(request.object.Evidence.Security, winfile.ObjectKindDirectory, profile)
}

func (policy *productionFilesystemSecurityPolicy) CheckFile(request fileSecurityRequest) error {
	if policy == nil {
		return errors.New("filesystem security policy is nil")
	}
	if request.object.Evidence.SecurityMode != winfile.SecurityModeManaged {
		return errors.New("verified file is not in managed security mode")
	}
	access, err := accessForFile(request)
	if err != nil {
		return err
	}
	profile := policy.trustedFile
	if request.root == releasemanifest.RootInstallation {
		var exists bool
		profile, exists = policy.installationFiles[access]
		if !exists {
			return errors.New("installation access mapping lacks a canonical ACL profile")
		}
	} else if request.root != releasemanifest.RootTrustedConfiguration || access != readBoth {
		return errors.New("trusted file does not use the fixed read-only profile")
	}
	return winacl.Audit(request.object.Evidence.Security, winfile.ObjectKindFile, profile)
}

func accessForFile(request fileSecurityRequest) (serviceAccess, error) {
	if request.relativePath == "" {
		return serviceAccess{}, errors.New("file security request has an empty relative path")
	}
	switch request.purpose {
	case purposeControlBootstrap:
		if request.root != releasemanifest.RootTrustedConfiguration || request.manifest != nil ||
			!strings.EqualFold(request.relativePath, releasemanifest.ControlBootstrapConfigurationPath) {
			return serviceAccess{}, errors.New("Control bootstrap security request is inconsistent")
		}
		return readBoth, nil
	case purposeExecutorBootstrap:
		if request.root != releasemanifest.RootTrustedConfiguration || request.manifest != nil ||
			!strings.EqualFold(request.relativePath, releasemanifest.ExecutorBootstrapConfigurationPath) {
			return serviceAccess{}, errors.New("Executor bootstrap security request is inconsistent")
		}
		return readBoth, nil
	case purposeManifest:
		if request.root != releasemanifest.RootInstallation || request.manifest != nil {
			return serviceAccess{}, errors.New("release manifest security request is inconsistent")
		}
		return readBoth, nil
	case purposeManifestEntry:
		if request.manifest == nil || request.manifest.Root != request.root ||
			!strings.EqualFold(request.manifest.Path, request.relativePath) {
			return serviceAccess{}, errors.New("manifest entry security request is inconsistent")
		}
	default:
		return serviceAccess{}, fmt.Errorf("unsupported file purpose %d", request.purpose)
	}

	if request.root == releasemanifest.RootTrustedConfiguration {
		switch request.manifest.Role {
		case releasemanifest.RoleCABundle,
			releasemanifest.RoleTrustedConfig,
			releasemanifest.RolePolicy,
			releasemanifest.RoleSchema,
			releasemanifest.RolePrompt,
			releasemanifest.RoleRecipe:
			return readBoth, nil
		default:
			return serviceAccess{}, fmt.Errorf(
				"manifest role %q is not permitted in the trusted configuration root",
				request.manifest.Role,
			)
		}
	}
	if request.root != releasemanifest.RootInstallation {
		return serviceAccess{}, fmt.Errorf("unsupported file root %q", request.root)
	}

	switch request.manifest.Role {
	case releasemanifest.RoleServiceWrapper:
		switch {
		case strings.EqualFold(request.relativePath, config.ControlServiceName+".exe"):
			return executeControl, nil
		case strings.EqualFold(request.relativePath, config.ExecutorServiceName+".exe"):
			return executeExecutor, nil
		default:
			return serviceAccess{}, errors.New("service wrapper path does not identify a fixed service")
		}
	case releasemanifest.RoleServiceHost, releasemanifest.RoleNodeRuntime:
		return executeBoth, nil
	case releasemanifest.RoleControlBundle:
		return executeControl, nil
	case releasemanifest.RoleExecutorBundle,
		releasemanifest.RoleProcessHost,
		releasemanifest.RoleCodexCLI,
		releasemanifest.RoleGitCLI,
		releasemanifest.RoleGitHelper,
		releasemanifest.RoleCodexRuntime:
		return executeExecutor, nil
	case releasemanifest.RoleNativeLibrary:
		if firstPathComponentEqual(request.relativePath, "runtime") {
			return executeBoth, nil
		}
		return executeExecutor, nil
	case releasemanifest.RoleCABundle,
		releasemanifest.RoleServiceConfig,
		releasemanifest.RoleRuntimeData,
		releasemanifest.RoleLicense:
		return readBoth, nil
	default:
		return serviceAccess{}, fmt.Errorf(
			"manifest role %q is not permitted in the installation root",
			request.manifest.Role,
		)
	}
}

func firstPathComponentEqual(path string, expected string) bool {
	component := path
	if separator := strings.IndexByte(path, '\\'); separator >= 0 {
		component = path[:separator]
	}
	return strings.EqualFold(component, expected)
}

type secureReadPolicy struct {
	policy       filesystemSecurityPolicy
	root         releasemanifest.FileRoot
	rootPath     string
	expectedPath string
	purpose      filePurpose
}

func (policy secureReadPolicy) CheckAncestor(request secureconfig.AncestorSecurityRequest) error {
	return policy.policy.CheckDirectory(directorySecurityRequest{
		root:         policy.root,
		isVolumeRoot: request.IsVolumeRoot,
		object:       cloneObjectEvidence(request.Object),
	})
}

func (policy secureReadPolicy) CheckFile(request secureconfig.FileSecurityRequest) error {
	if !windowsPathEqual(request.Object.Path, policy.expectedPath) {
		return errors.New("secure reader returned an unexpected file path to its policy")
	}
	relative, err := relativePath(policy.rootPath, request.Object.Path)
	if err != nil {
		return err
	}
	return policy.policy.CheckFile(fileSecurityRequest{
		root:         policy.root,
		relativePath: relative,
		purpose:      policy.purpose,
		object:       cloneObjectEvidence(request.Object),
	})
}

func fixedIdentityOptions(role config.Role) (winidentity.Options, error) {
	control := winidentity.ServiceIdentity{Name: config.ControlServiceName, SID: config.ControlServiceSID}
	executor := winidentity.ServiceIdentity{Name: config.ExecutorServiceName, SID: config.ExecutorServiceSID}
	switch role {
	case config.RoleControl:
		return winidentity.Options{OwnService: control, PeerService: executor}, nil
	case config.RoleExecutor:
		return winidentity.Options{OwnService: executor, PeerService: control}, nil
	default:
		return winidentity.Options{}, ErrInvalidOptions
	}
}

func roleFromIdentityEvidence(evidence winidentity.Evidence) (config.Role, error) {
	if evidence.ProcessID == 0 || !evidence.Token.HasRestrictions || evidence.Token.User.SID == "" ||
		evidence.OwnService.SIDType != winidentity.ServiceSIDTypeRestricted ||
		evidence.PeerService.SIDType != winidentity.ServiceSIDTypeRestricted {
		return "", errors.New("service identity evidence is incomplete")
	}
	var role config.Role
	switch {
	case evidence.OwnService.Name == config.ControlServiceName &&
		evidence.OwnService.SID == config.ControlServiceSID &&
		evidence.PeerService.Name == config.ExecutorServiceName &&
		evidence.PeerService.SID == config.ExecutorServiceSID &&
		evidence.Token.User.SID == config.ControlServiceSID:
		role = config.RoleControl
	case evidence.OwnService.Name == config.ExecutorServiceName &&
		evidence.OwnService.SID == config.ExecutorServiceSID &&
		evidence.PeerService.Name == config.ControlServiceName &&
		evidence.PeerService.SID == config.ControlServiceSID &&
		evidence.Token.User.SID == config.ExecutorServiceSID:
		role = config.RoleExecutor
	default:
		return "", errors.New("service identity evidence does not match either fixed role")
	}
	return role, nil
}
