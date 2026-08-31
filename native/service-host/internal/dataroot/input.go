package dataroot

import (
	"errors"
	"fmt"
	"reflect"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

type installationSnapshot struct {
	role               config.Role
	control            config.Config
	executor           config.Config
	roots              []InstallationRootBinding
	installDirectories map[string]struct{}
}

func snapshotInstallation(value installverify.Evidence) (installationSnapshot, error) {
	if err := value.Validate(); err != nil {
		return installationSnapshot{}, verificationError(
			ErrorInstallation,
			"installation evidence is invalid",
			errors.Join(ErrInstallationEvidence, err),
		)
	}
	result := installationSnapshot{
		role: value.Role(), control: value.ControlConfiguration(), executor: value.ExecutorConfiguration(),
		installDirectories: make(map[string]struct{}),
	}
	installationRoot := result.control.Installation.Root
	for _, file := range value.Files() {
		if file.Root() != releasemanifest.RootInstallation {
			continue
		}
		_, components, err := relativePathExact(installationRoot, file.AbsolutePath(), true)
		if err != nil {
			return installationSnapshot{}, verificationError(
				ErrorInstallation,
				"installation file evidence is outside its root",
				errors.Join(ErrInstallationEvidence, err),
			)
		}
		path := installationRoot
		for index := 0; index < len(components)-1; index++ {
			path = joinPath(path, components[index])
			result.installDirectories[path] = struct{}{}
		}
	}
	seenRoots := make(map[releasemanifest.FileRoot]struct{}, 2)
	for _, root := range value.Roots() {
		kind := root.Root()
		if kind != releasemanifest.RootInstallation && kind != releasemanifest.RootTrustedConfiguration {
			return installationSnapshot{}, verificationError(ErrorInstallation, "installation evidence contains an unknown root", ErrInstallationEvidence)
		}
		if _, duplicate := seenRoots[kind]; duplicate {
			return installationSnapshot{}, verificationError(ErrorInstallation, "installation evidence repeats a root", ErrInstallationEvidence)
		}
		seenRoots[kind] = struct{}{}
		object := root.Object()
		ancestors := root.Ancestors()
		if root.Path() == "" || object.Path != root.Path() || object.Evidence.Identity.FileID == ([16]byte{}) || len(ancestors) == 0 {
			return installationSnapshot{}, verificationError(ErrorInstallation, "installation root evidence is incomplete", ErrInstallationEvidence)
		}
		identities := make([]winfile.FileIdentity, 0, len(ancestors))
		paths := make([]string, 0, len(ancestors))
		seen := make(map[winfile.FileIdentity]struct{}, len(ancestors)+1)
		for _, ancestor := range ancestors {
			identity := ancestor.Evidence.Identity
			if identity.FileID == ([16]byte{}) || identity.VolumeSerialNumber != object.Evidence.Identity.VolumeSerialNumber {
				return installationSnapshot{}, verificationError(ErrorInstallation, "installation root ancestor identity is invalid", ErrInstallationEvidence)
			}
			if _, duplicate := seen[identity]; duplicate {
				return installationSnapshot{}, verificationError(ErrorInstallation, "installation root ancestor identity repeats", ErrInstallationEvidence)
			}
			seen[identity] = struct{}{}
			paths = append(paths, ancestor.Path)
			identities = append(identities, identity)
		}
		if _, duplicate := seen[object.Evidence.Identity]; duplicate {
			return installationSnapshot{}, verificationError(ErrorInstallation, "installation root target reuses an ancestor identity", ErrInstallationEvidence)
		}
		result.roots = append(result.roots, InstallationRootBinding{
			root: kind, path: root.Path(), ancestorPaths: paths,
			ancestors: identities, target: object.Evidence.Identity,
		})
	}
	if len(result.roots) != 2 {
		return installationSnapshot{}, verificationError(ErrorInstallation, "installation evidence lacks both required roots", ErrInstallationEvidence)
	}
	return result, nil
}

func validateInput(current, peer config.Config, installation installationSnapshot) error {
	if err := current.Validate(); err != nil {
		return verificationError(ErrorConfiguration, "current configuration is invalid", errors.Join(ErrConfiguration, err))
	}
	if err := peer.Validate(); err != nil {
		return verificationError(ErrorConfiguration, "peer configuration is invalid", errors.Join(ErrConfiguration, err))
	}
	if current.Role == peer.Role || current.OwnService != peer.PeerService || current.PeerService != peer.OwnService {
		return verificationError(ErrorConfiguration, "current and peer roles or service identities do not form the fixed pair", ErrConfiguration)
	}
	if installation.role != current.Role {
		return verificationError(ErrorInstallation, "installation evidence belongs to another current role", ErrInstallationEvidence)
	}
	expectedCurrent := installation.control
	expectedPeer := installation.executor
	if current.Role == config.RoleExecutor {
		expectedCurrent, expectedPeer = expectedPeer, expectedCurrent
	}
	if !reflect.DeepEqual(current, expectedCurrent) || !reflect.DeepEqual(peer, expectedPeer) {
		return verificationError(ErrorInstallation, "configurations differ from concrete installation evidence", ErrInstallationEvidence)
	}
	for _, path := range strings.Split(current.Node.Environment["PATH"], ";") {
		if _, verified := installation.installDirectories[path]; !verified {
			return verificationError(
				ErrorInstallation,
				"PATH directory is not witnessed by concrete installation evidence",
				ErrInstallationEvidence,
			)
		}
	}
	if pathsOverlapFold(current.Node.DataRoot, peer.Node.DataRoot) ||
		pathsOverlapFold(current.Node.DataRoot, current.Installation.Root) ||
		pathsOverlapFold(current.Node.DataRoot, current.Installation.TrustedConfigurationRoot) {
		return verificationError(ErrorConfiguration, "data-root lexical boundaries overlap", ErrConfiguration)
	}
	for _, root := range installation.roots {
		expected := current.Installation.Root
		if root.root == releasemanifest.RootTrustedConfiguration {
			expected = current.Installation.TrustedConfigurationRoot
		}
		if root.path != expected {
			return verificationError(
				ErrorInstallation,
				fmt.Sprintf("%s root path differs from installation evidence", root.root),
				ErrInstallationEvidence,
			)
		}
	}
	return nil
}
