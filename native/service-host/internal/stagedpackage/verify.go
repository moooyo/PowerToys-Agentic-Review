package stagedpackage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

type openedDirectory struct {
	handle        directoryHandle
	object        secureconfig.ObjectEvidence
	resourceIndex int
	relativePath  string
	depth         uint32
}

type openedFile struct {
	handle        fileHandle
	object        secureconfig.ObjectEvidence
	resourceIndex int
	relativePath  string
}

type verifiedTree struct {
	rootType    outerpackage.Root
	path        string
	root        *openedDirectory
	directories map[string]*openedDirectory
	files       map[string]*openedFile
}

type verifier struct {
	ctx               context.Context
	rootPath          string
	deps              verifierDependencies
	owner             *handleOwner
	stagingRoot       *openedDirectory
	trees             map[outerpackage.Root]*verifiedTree
	seenIdentities    map[winfile.FileIdentity]string
	directoryCount    uint32
	totalEntries      uint32
	totalNameUnits    uint64
	plan              logicalPlan
	signatureVerifier authenticode.Verifier
	captured          map[string][]byte
	files             map[string]FileSnapshot
	documents         documentSet
}

type documentSet struct {
	index        []byte
	envelope     []byte
	control      []byte
	executor     []byte
	descriptor   []byte
	prepare      []byte
	closure      []byte
	template     []byte
	buildReceipt []byte
	manifest     []byte
}

func verifyWithDependencies(
	ctx context.Context,
	stagedRoot string,
	deps verifierDependencies,
) (result StagedPackageEvidence, resultErr error) {
	if ctx == nil {
		return StagedPackageEvidence{}, ErrInvalidInput
	}
	if cause := context.Cause(ctx); cause != nil {
		return StagedPackageEvidence{}, cause
	}
	operation, err := beginCleanupOperation()
	if err != nil {
		return StagedPackageEvidence{}, ErrCleanupFatal
	}
	parsed, err := parseStagedRootPath(stagedRoot)
	if err != nil || validateDependencies(deps) != nil {
		return StagedPackageEvidence{}, ErrInvalidInput
	}
	state := &verifier{
		ctx:            ctx,
		rootPath:       stagedRoot,
		deps:           deps,
		owner:          &handleOwner{},
		trees:          make(map[outerpackage.Root]*verifiedTree, 3),
		seenIdentities: make(map[winfile.FileIdentity]string),
		captured:       make(map[string][]byte),
		files:          make(map[string]FileSnapshot),
	}
	committed := false
	defer func() {
		if committed {
			return
		}
		cleanupErr, unresolved := state.owner.close()
		if unresolved {
			publishCleanupFatal(state.owner)
			result = StagedPackageEvidence{}
			resultErr = ErrCleanupFatal
			return
		}
		if cleanupErr != nil && !errors.Is(resultErr, ErrCleanupFatal) {
			result = StagedPackageEvidence{}
			resultErr = ErrCleanup
		}
	}()

	if err := state.openStagingRoot(parsed); err != nil {
		return StagedPackageEvidence{}, stageError(ErrTree, "staging root traversal failed")
	}
	if err := state.openLogicalRoots(); err != nil {
		return StagedPackageEvidence{}, stageError(ErrTree, "staging root closure failed")
	}
	if err := state.readAdmissionDocuments(); err != nil {
		return StagedPackageEvidence{}, stageError(ErrFile, "admission documents could not be read")
	}
	plan, err := deps.admit(
		state.documents.index,
		state.documents.envelope,
		state.documents.control,
		state.documents.executor,
	)
	if err != nil || validateLogicalPlan(plan, state.documents) != nil {
		return StagedPackageEvidence{}, ErrTrust
	}
	state.plan = plan
	trees, err := buildExpectedTrees(plan.index, state.documents.index, state.documents.envelope)
	if err != nil {
		return StagedPackageEvidence{}, stageError(ErrTree, "signed package plan is not a closed tree")
	}
	state.signatureVerifier, err = deps.newAuthenticodeVerifier()
	if err != nil || nilInterface(state.signatureVerifier) {
		return StagedPackageEvidence{}, ErrAuthenticode
	}
	for _, root := range []outerpackage.Root{
		outerpackage.RootMetadata,
		outerpackage.RootInstallation,
		outerpackage.RootTrustedConfiguration,
	} {
		if err := state.walkDirectory(state.trees[root], state.trees[root].root, trees[root]); err != nil {
			switch {
			case errors.Is(err, ErrAuthenticode):
				return StagedPackageEvidence{}, ErrAuthenticode
			case errors.Is(err, ErrDocuments):
				return StagedPackageEvidence{}, ErrDocuments
			case errors.Is(err, ErrFile):
				return StagedPackageEvidence{}, stageError(ErrFile, "signed package file verification failed")
			default:
				if cause := context.Cause(ctx); cause != nil {
					return StagedPackageEvidence{}, cause
				}
				return StagedPackageEvidence{}, stageError(ErrTree, "signed package tree verification failed")
			}
		}
	}
	facts, err := state.inspectDocuments()
	if err != nil {
		return StagedPackageEvidence{}, ErrDocuments
	}
	if cause := context.Cause(ctx); cause != nil {
		return StagedPackageEvidence{}, cause
	}
	if err := state.owner.recheck(); err != nil {
		return StagedPackageEvidence{}, ErrInvalidEvidence
	}

	evidenceState := &evidenceState{
		issuer:      successfulEvidenceIssuer,
		rootPath:    stagedRoot,
		owner:       state.owner,
		index:       cloneIndex(plan.index),
		control:     cloneConfig(plan.control),
		executor:    cloneConfig(plan.executor),
		signerKeyID: plan.signerKeyID,
		envelope:    bytes.Clone(state.documents.envelope),
		documents:   cloneDocumentFacts(facts),
		roots:       state.rootSnapshots(),
		files:       state.fileSnapshots(),
	}
	evidenceState.digest = digestEvidenceState(evidenceState)
	if evidenceState.digest == ([32]byte{}) {
		return StagedPackageEvidence{}, ErrInvalidEvidence
	}
	if err := operation.commit(func() {
		result = StagedPackageEvidence{state: evidenceState}
	}); err != nil {
		return StagedPackageEvidence{}, ErrCleanupFatal
	}
	committed = true
	return result, nil
}

func validateDependencies(value verifierDependencies) error {
	if value.openTraversalRoot == nil || value.newAuthenticodeVerifier == nil ||
		value.admit == nil || value.checkSecurity == nil {
		return ErrInvalidInput
	}
	return nil
}

func validateLogicalPlan(plan logicalPlan, documents documentSet) error {
	index, err := outerpackage.MarshalIndexCanonical(plan.index)
	if err != nil || !bytes.Equal(index, documents.index) || plan.signerKeyID == "" {
		return ErrTrust
	}
	control, err := config.MarshalCanonical(plan.control)
	if err != nil || !bytes.Equal(control, documents.control) {
		return ErrTrust
	}
	executor, err := config.MarshalCanonical(plan.executor)
	if err != nil || !bytes.Equal(executor, documents.executor) {
		return ErrTrust
	}
	return nil
}

func (v *verifier) openStagingRoot(path windowsPath) error {
	if err := v.reserveDirectory(); err != nil {
		return err
	}
	handle, err := v.deps.openTraversalRoot(path.drive, winfile.OpenOptions{
		VolumeUse: winfile.VolumeUseReadOnly, SecurityMode: winfile.SecurityModeAmbientAncestor,
	})
	if err != nil || nilInterface(handle) {
		return ErrTree
	}
	current, err := v.retainDirectory(path.drive, handle, winfile.SecurityModeAmbientAncestor, 0)
	if err != nil {
		return err
	}
	volume := current.object.Evidence.Identity.VolumeSerialNumber
	for index, component := range path.components {
		if cause := context.Cause(v.ctx); cause != nil {
			return cause
		}
		if err := v.reserveDirectory(); err != nil {
			return err
		}
		last := index == len(path.components)-1
		mode := winfile.SecurityModeAmbientAncestor
		if last {
			mode = winfile.SecurityModeManaged
		}
		child, err := current.handle.OpenDirectoryComponent(component, winfile.OpenOptions{
			VolumeUse: winfile.VolumeUseReadOnly, DirectoryEnumeration: last, SecurityMode: mode,
		})
		if err != nil || nilInterface(child) {
			return ErrTree
		}
		opened, err := v.retainDirectory(joinPath(current.object.Path, component), child, mode, uint32(index+1))
		if err != nil || opened.object.Evidence.Identity.VolumeSerialNumber != volume {
			return ErrTree
		}
		current = opened
	}
	v.stagingRoot = current
	return nil
}

func (v *verifier) openLogicalRoots() error {
	enumeration, err := v.enumerate(v.stagingRoot)
	if err != nil || len(enumeration.Entries) != 3 {
		return ErrTree
	}
	expected := map[string]outerpackage.Root{
		string(outerpackage.RootMetadata):             outerpackage.RootMetadata,
		string(outerpackage.RootInstallation):         outerpackage.RootInstallation,
		string(outerpackage.RootTrustedConfiguration): outerpackage.RootTrustedConfiguration,
	}
	for _, entry := range enumeration.Entries {
		root, ok := expected[entry.Name]
		if !ok || entry.Kind != winfile.ObjectKindDirectory {
			return ErrTree
		}
		if err := v.reserveDirectory(); err != nil {
			return err
		}
		handle, err := v.stagingRoot.handle.OpenDirectoryComponent(entry.Name, winfile.OpenOptions{
			VolumeUse:            winfile.VolumeUseReadOnly,
			DirectoryEnumeration: true,
			SecurityMode:         winfile.SecurityModeManaged,
		})
		if err != nil || nilInterface(handle) {
			return ErrTree
		}
		opened, err := v.retainDirectory(
			joinPath(v.stagingRoot.object.Path, entry.Name),
			handle,
			winfile.SecurityModeManaged,
			v.stagingRoot.depth+1,
		)
		if err != nil || compareDirectoryEntry(entry, opened.object, false) != nil ||
			opened.object.Evidence.Identity.VolumeSerialNumber != v.stagingRoot.object.Evidence.Identity.VolumeSerialNumber {
			return ErrTree
		}
		opened.relativePath = ""
		v.trees[root] = &verifiedTree{
			rootType: root,
			path:     opened.object.Path,
			root:     opened,
			directories: map[string]*openedDirectory{
				"": opened,
			},
			files: make(map[string]*openedFile),
		}
		delete(expected, entry.Name)
	}
	if len(expected) != 0 || len(v.trees) != 3 {
		return ErrTree
	}
	return nil
}

func (v *verifier) readAdmissionDocuments() error {
	var err error
	v.documents.index, err = v.readKnownFile(
		outerpackage.RootMetadata, outerpackage.PackageIndexPath, outerpackage.MaximumIndexBytes,
	)
	if err != nil {
		return err
	}
	v.documents.envelope, err = v.readKnownFile(
		outerpackage.RootMetadata, outerpackage.SignatureEnvelopePath, outerpackage.MaximumEnvelopeBytes,
	)
	if err != nil {
		return err
	}
	v.documents.control, err = v.readKnownFile(
		outerpackage.RootTrustedConfiguration, outerpackage.ControlBootstrapPath, config.MaximumDocumentBytes,
	)
	if err != nil {
		return err
	}
	v.documents.executor, err = v.readKnownFile(
		outerpackage.RootTrustedConfiguration, outerpackage.ExecutorBootstrapPath, config.MaximumDocumentBytes,
	)
	return err
}

func (v *verifier) readKnownFile(root outerpackage.Root, path string, maximum int) ([]byte, error) {
	file, err := v.trees[root].openFilePath(v, path)
	if err != nil {
		return nil, err
	}
	data, err := file.handle.ReadAll(uint64(maximum))
	if err != nil || len(data) == 0 || uint64(len(data)) != file.object.Evidence.Size {
		return nil, ErrFile
	}
	if err := file.handle.VerifyUnchanged(); err != nil {
		return nil, ErrFile
	}
	v.captured[packageFileKey(root, path)] = bytes.Clone(data)
	return bytes.Clone(data), nil
}

func (v *verifier) retainDirectory(
	path string,
	handle directoryHandle,
	mode winfile.SecurityMode,
	depth uint32,
) (*openedDirectory, error) {
	if nilInterface(handle) {
		return nil, ErrTree
	}
	resourceIndex := v.owner.addDirectory(path, handle, secureconfig.ObjectEvidence{})
	object, err := secureconfig.NewObjectEvidenceForMode(path, mode, handle.Evidence())
	if err != nil {
		return nil, err
	}
	v.owner.setObject(resourceIndex, object)
	if err := v.registerIdentity(path, object); err != nil {
		return nil, err
	}
	if err := v.deps.checkSecurity(object.Evidence, winfile.ObjectKindDirectory, mode == winfile.SecurityModeManaged); err != nil {
		return nil, err
	}
	caseSensitive, err := handle.ReinspectCaseSensitivity()
	if err != nil || caseSensitive {
		return nil, ErrTree
	}
	return &openedDirectory{
		handle: handle, object: object, resourceIndex: resourceIndex, depth: depth,
	}, nil
}

func (v *verifier) retainFile(path string, handle fileHandle) (*openedFile, error) {
	if nilInterface(handle) {
		return nil, ErrFile
	}
	resourceIndex := v.owner.addFile(path, handle, secureconfig.ObjectEvidence{})
	object, err := secureconfig.NewObjectEvidenceForMode(
		path,
		winfile.SecurityModeManaged,
		handle.Evidence(),
	)
	if err != nil {
		return nil, err
	}
	v.owner.setObject(resourceIndex, object)
	if err := v.registerIdentity(path, object); err != nil {
		return nil, err
	}
	if err := v.deps.checkSecurity(object.Evidence, winfile.ObjectKindFile, true); err != nil {
		return nil, err
	}
	return &openedFile{handle: handle, object: object, resourceIndex: resourceIndex}, nil
}

func (v *verifier) registerIdentity(path string, object secureconfig.ObjectEvidence) error {
	identity := object.Evidence.Identity
	if identity == (winfile.FileIdentity{}) || identity.FileID == ([16]byte{}) {
		return ErrTree
	}
	if _, exists := v.seenIdentities[identity]; exists {
		return ErrTree
	}
	v.seenIdentities[identity] = path
	return nil
}

func (v *verifier) reserveDirectory() error {
	if v.directoryCount >= maximumDirectories {
		return ErrTree
	}
	v.directoryCount++
	return nil
}

func (v *verifier) enumerate(directory *openedDirectory) (winfile.DirectoryEnumeration, error) {
	if directory == nil || directory.handle == nil || v.totalEntries >= maximumTotalEntries ||
		v.totalNameUnits >= maximumTotalNameUTF16Units {
		return winfile.DirectoryEnumeration{}, ErrTree
	}
	remainingEntries := maximumTotalEntries - v.totalEntries
	maximumEntries := maximumEntriesPerDirectory
	if remainingEntries < maximumEntries {
		maximumEntries = remainingEntries
	}
	remainingNames := maximumTotalNameUTF16Units - v.totalNameUnits
	options := winfile.DirectoryEnumerationOptions{
		MaximumEntries:             maximumEntries,
		MaximumNameUTF16Units:      maximumNameUTF16Units,
		MaximumTotalNameUTF16Units: remainingNames,
	}
	value, err := directory.handle.Enumerate(options)
	if err != nil || uint32(len(value.Entries)) > remainingEntries || value.NameUTF16Units > remainingNames {
		return winfile.DirectoryEnumeration{}, ErrTree
	}
	v.totalEntries += uint32(len(value.Entries))
	v.totalNameUnits += value.NameUTF16Units
	v.owner.recordEnumeration(directory.resourceIndex, value, options)
	return value, nil
}

func (v *verifier) rootSnapshots() []RootSnapshot {
	result := make([]RootSnapshot, 0, 3)
	for _, root := range []outerpackage.Root{
		outerpackage.RootMetadata,
		outerpackage.RootInstallation,
		outerpackage.RootTrustedConfiguration,
	} {
		tree := v.trees[root]
		result = append(result, RootSnapshot{
			root: root, path: tree.path, object: cloneObjectEvidence(tree.root.object),
		})
	}
	return result
}

func (v *verifier) fileSnapshots() []FileSnapshot {
	result := make([]FileSnapshot, 0, len(v.files))
	for _, root := range []outerpackage.Root{
		outerpackage.RootMetadata,
		outerpackage.RootInstallation,
		outerpackage.RootTrustedConfiguration,
	} {
		for _, payload := range v.plan.index.Payloads {
			if payload.Root == root {
				result = append(result, cloneFileSnapshot(v.files[packageFileKey(root, payload.Path)]))
			}
		}
		if root == outerpackage.RootMetadata {
			result = append(result,
				cloneFileSnapshot(v.files[packageFileKey(root, outerpackage.PackageIndexPath)]),
				cloneFileSnapshot(v.files[packageFileKey(root, outerpackage.SignatureEnvelopePath)]),
			)
		}
	}
	return result
}

func packageFileKey(root outerpackage.Root, path string) string {
	return string(root) + "\x00" + strings.ToLower(path)
}

func stageError(cause error, message string) error { return fmt.Errorf("%w: %s", cause, message) }
