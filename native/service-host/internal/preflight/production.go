package preflight

import (
	"reflect"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/dataroot"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
)

// Compose validates opaque installation and data-root evidence and then delegates to the
// side-effect-free snapshot composer.
func Compose(input Input) (Evidence, error) {
	if err := input.Installation.Validate(); err != nil {
		return Evidence{}, preflightError(ErrorInstallation, "installation evidence is invalid", err)
	}
	installation, err := captureInstallationSnapshot(input.Installation)
	if err != nil {
		return Evidence{}, err
	}
	if input.Role != installation.role ||
		!windowsPathEqual(input.ActualBootstrapPath, installation.actualBootstrapPath) {
		return Evidence{}, preflightError(ErrorInput, "preflight selectors do not match installation evidence", nil)
	}
	dataRoot, err := captureDataRootBinding(input.DataRoot, installation)
	if err != nil {
		return Evidence{}, err
	}
	contents, err := captureRuntimeContents(input.Installation, installation)
	if err != nil {
		return Evidence{}, err
	}
	installation.contents = cloneRuntimeContents(contents)
	return composeSnapshots(snapshotInput{
		role:                input.Role,
		actualBootstrapPath: input.ActualBootstrapPath,
		installation:        installation,
		dataRoot:            dataRoot,
	})
}

func captureInstallationSnapshot(evidence installverify.Evidence) (*installationSnapshot, error) {
	release, err := captureReleaseBinding(evidence)
	if err != nil {
		return nil, err
	}
	roots := evidence.Roots()
	rootSnapshots := make([]VerifiedRoot, len(roots))
	for index, root := range roots {
		rootSnapshots[index] = VerifiedRoot{
			Root: root.Root(), Path: root.Path(), Ancestors: root.Ancestors(), Object: root.Object(),
		}
	}
	files := evidence.Files()
	fileSnapshots := make([]VerifiedFile, len(files))
	for index, file := range files {
		fileSnapshots[index] = VerifiedFile{
			Root: file.Root(), Path: file.Path(), AbsolutePath: file.AbsolutePath(),
			Role: file.Role(), SHA256: file.SHA256(), Size: file.Size(), Object: file.Object(),
		}
	}
	return &installationSnapshot{
		role:                evidence.Role(),
		actualBootstrapPath: evidence.ActualBootstrapPath(),
		controlBootstrap:    evidence.ControlBootstrap(),
		executorBootstrap:   evidence.ExecutorBootstrap(),
		controlConfig:       evidence.ControlConfiguration(),
		executorConfig:      evidence.ExecutorConfiguration(),
		manifestRead:        evidence.ManifestRead(),
		manifest:            evidence.Manifest(),
		identity:            evidence.Identity(),
		roots:               rootSnapshots,
		files:               fileSnapshots,
		release:             release,
	}, nil
}

func captureDataRootBinding(
	evidence dataroot.Evidence,
	installation *installationSnapshot,
) (DataRootBinding, error) {
	if err := evidence.Validate(); err != nil {
		return DataRootBinding{}, preflightError(ErrorDataRoot, "data-root evidence is zero, closed, or invalid", err)
	}
	digest, err := evidence.Digest()
	if err != nil || digest == ([32]byte{}) {
		return DataRootBinding{}, preflightError(ErrorDataRoot, "data-root evidence digest is unavailable", err)
	}
	return validateDataRootFacts(dataRootFacts{
		role: evidence.Role(), current: evidence.CurrentConfiguration(), peer: evidence.PeerConfiguration(),
		currentPath: evidence.DataRoot().Path(), peerPath: evidence.PeerDataRootPath(),
		peerObservation:   evidence.PeerRootObservation(),
		installationRoots: captureDataRootInstallationBindings(evidence.InstallationRoots()),
		digest:            digest,
	}, installation)
}

type dataRootFacts struct {
	role              config.Role
	current           config.Config
	peer              config.Config
	currentPath       string
	peerPath          string
	peerObservation   dataroot.PeerRootObservation
	installationRoots []dataRootInstallationBinding
	digest            [32]byte
}

func validateDataRootFacts(facts dataRootFacts, installation *installationSnapshot) (DataRootBinding, error) {
	role := facts.role
	current := facts.current
	peer := facts.peer
	expectedCurrent := installation.controlConfig
	expectedPeer := installation.executorConfig
	if role == config.RoleExecutor {
		expectedCurrent, expectedPeer = expectedPeer, expectedCurrent
	}
	if facts.digest == ([32]byte{}) || role != installation.role || !reflect.DeepEqual(current, expectedCurrent) ||
		!reflect.DeepEqual(peer, expectedPeer) {
		return DataRootBinding{}, preflightError(ErrorDataRoot, "data-root role or configurations differ from installation evidence", nil)
	}
	if facts.peerObservation != dataroot.PeerLiveRootNotObservedByDesign ||
		facts.currentPath != current.Node.DataRoot || facts.peerPath != peer.Node.DataRoot {
		return DataRootBinding{}, preflightError(ErrorDataRoot, "data-root observation semantics or paths are invalid", nil)
	}
	if err := validateDataRootInstallationBindings(facts.installationRoots, installation.roots); err != nil {
		return DataRootBinding{}, err
	}
	return cloneDataRootBinding(DataRootBinding{
		role: role, currentPath: current.Node.DataRoot, peerPath: peer.Node.DataRoot,
		peerObservation:   dataroot.PeerLiveRootNotObservedByDesign,
		installationRoots: facts.installationRoots,
		digest:            facts.digest, bound: true,
	}), nil
}

func captureDataRootInstallationBindings(
	values []dataroot.InstallationRootBinding,
) []dataRootInstallationBinding {
	result := make([]dataRootInstallationBinding, len(values))
	for index, value := range values {
		result[index] = dataRootInstallationBinding{
			root: value.Root(), path: value.Path(), ancestorPaths: value.AncestorPaths(),
			ancestors: value.Ancestors(), target: value.Target(),
		}
	}
	return result
}

func validateDataRootInstallationBindings(
	observed []dataRootInstallationBinding,
	expected []VerifiedRoot,
) error {
	if len(observed) != len(expected) || len(expected) != 2 {
		return preflightError(ErrorDataRoot, "data-root installation-root binding count is invalid", nil)
	}
	for index, root := range expected {
		binding := observed[index]
		if binding.root != root.Root || binding.path != root.Path ||
			binding.target != root.Object.Evidence.Identity ||
			len(binding.ancestorPaths) != len(root.Ancestors) ||
			len(binding.ancestors) != len(root.Ancestors) {
			return preflightError(ErrorDataRoot, "data-root installation-root target differs from installation evidence", nil)
		}
		for ancestorIndex, ancestor := range root.Ancestors {
			if binding.ancestorPaths[ancestorIndex] != ancestor.Path ||
				binding.ancestors[ancestorIndex] != ancestor.Evidence.Identity {
				return preflightError(ErrorDataRoot, "data-root installation-root ancestor chain differs from installation evidence", nil)
			}
		}
	}
	return nil
}

type runtimeContentTarget struct {
	path   string
	role   releasemanifest.FileRole
	sha256 string
}

func captureRuntimeContents(
	evidence installverify.Evidence,
	installation *installationSnapshot,
) ([]VerifiedRuntimeContent, error) {
	targets, err := runtimeContentTargetsFor(
		installation.role,
		installation.controlConfig,
		installation.executorConfig,
	)
	if err != nil {
		return nil, err
	}
	result := make([]VerifiedRuntimeContent, 0, len(targets))
	trustedRoot := installation.controlConfig.Installation.TrustedConfigurationRoot
	for _, target := range targets {
		relative, err := ManifestRelativePath(trustedRoot, target.path)
		if err != nil {
			return nil, preflightError(ErrorRuntimeContent, "runtime content path is outside the trusted root", err)
		}
		content, err := evidence.VerifiedContent(releasemanifest.RootTrustedConfiguration, relative)
		if err != nil || content.Validate() != nil {
			return nil, preflightError(ErrorRuntimeContent, "required opaque runtime content is unavailable", err)
		}
		result = append(result, VerifiedRuntimeContent{
			root: content.Root(), path: content.Path(), absolutePath: content.AbsolutePath(),
			role: content.Role(), sha256: content.SHA256(), size: content.Size(),
			object: content.Object(), data: content.Bytes(),
		})
	}
	return result, nil
}
