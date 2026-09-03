package installerdestination

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
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
	deps              dependencies
	plan              sourcePlan
	owner             *handleOwner
	trees             map[outerpackage.Root]*verifiedTree
	seenIdentities    map[winfile.FileIdentity]string
	directoryCount    uint32
	totalEntries      uint32
	totalNameUnits    uint64
	signatureVerifier authenticode.Verifier
	files             map[string]FileSnapshot
}

func verifyWithDependencies(ctx context.Context, deps dependencies) (result Evidence, resultErr error) {
	operation, err := beginCleanupOperation()
	if err != nil {
		return Evidence{}, ErrCleanupFatal
	}
	if ctx == nil || context.Cause(ctx) != nil || deps.acquireSource == nil || deps.openTraversalRoot == nil ||
		deps.newAuthenticodeVerifier == nil || deps.checkSecurity == nil || deps.admitDestination == nil {
		return Evidence{}, ErrInvalidSource
	}
	source := deps.acquireSource()
	if source.withBinding == nil || source.validate == nil || source.close == nil || source.commit == nil {
		return Evidence{}, ErrInvalidSource
	}
	committed := false
	sourceAcquired := false
	var state *evidenceState
	defer func() {
		if committed {
			return
		}
		var cleanupErr error
		if state != nil && state.owner != nil {
			err, unresolved := state.owner.close()
			cleanupErr = errors.Join(cleanupErr, cleanupError(err))
			if unresolved {
				publishCleanupFatal(state.owner)
				resultErr = errors.Join(resultErr, ErrCleanupFatal)
			}
		}
		if sourceAcquired {
			cleanupErr = errors.Join(cleanupErr, cleanupError(source.close()))
		}
		if cleanupErr != nil {
			result = Evidence{}
			resultErr = errors.Join(resultErr, cleanupErr)
		}
	}()

	err = source.withBinding(func(plan sourcePlan) error {
		sourceAcquired = true
		if err := translateStagedError(source.validate()); err != nil {
			return errors.Join(ErrInvalidSource, err)
		}
		validatedPlan, err := parseSourcePlan(
			plan.indexDocument,
			plan.envelopeDocument,
			plan.controlDocument,
			plan.executorDocument,
			plan.signerKeyID,
		)
		if err != nil {
			return err
		}
		plan = validatedPlan
		trees, err := expectedTrees(plan)
		if err != nil {
			return err
		}
		verifier := &verifier{
			ctx: ctx, deps: deps, plan: plan, owner: &handleOwner{},
			trees:          make(map[outerpackage.Root]*verifiedTree, 3),
			seenIdentities: make(map[winfile.FileIdentity]string), files: make(map[string]FileSnapshot),
		}
		state = &evidenceState{source: source, owner: verifier.owner}
		verifier.signatureVerifier, err = deps.newAuthenticodeVerifier()
		if err != nil || nilInterface(verifier.signatureVerifier) {
			return ErrAuthenticode
		}
		for _, root := range []outerpackage.Root{
			outerpackage.RootMetadata,
			outerpackage.RootInstallation,
			outerpackage.RootTrustedConfiguration,
		} {
			path := rootPath(plan.index, root)
			tree, err := verifier.openTree(root, path)
			if err != nil {
				return errors.Join(ErrTree, err)
			}
			verifier.trees[root] = tree
			if err := verifier.walkDirectory(tree, tree.root, trees[root]); err != nil {
				return err
			}
		}
		if err := deps.admitDestination(plan); err != nil {
			return errors.Join(ErrInvalidSource, err)
		}
		if err := translateStagedError(source.validate()); err != nil {
			return errors.Join(ErrInvalidSource, err)
		}
		if verifier.owner.recheck() != nil {
			return ErrInvalidEvidence
		}
		state.issuer = successfulEvidenceIssuer
		state.plan = cloneSourcePlan(plan)
		state.roots = verifier.rootSnapshots()
		state.files = verifier.fileSnapshots()
		state.digest = digestEvidenceState(state)
		if validateEvidenceState(state) != nil {
			return ErrInvalidEvidence
		}
		return nil
	})
	err = translateStagedError(err)
	if err != nil {
		return Evidence{}, err
	}
	if state == nil {
		return Evidence{}, ErrInvalidEvidence
	}
	destinationValid := false
	if err := source.commit(operation, func() {
		// Retained-handle rechecks do not open or close objects and do not re-enter the winfile
		// cleanup fence. Running them here establishes one common source/destination valid point.
		if state.owner.recheck() != nil {
			return
		}
		destinationValid = true
		result = Evidence{state: state}
	}); err != nil {
		err = translateStagedError(err)
		if errors.Is(err, ErrCleanupFatal) {
			return Evidence{}, ErrCleanupFatal
		}
		return Evidence{}, errors.Join(ErrInvalidSource, err)
	}
	if !destinationValid {
		return Evidence{}, ErrInvalidEvidence
	}
	committed = true
	return result, nil
}

func rootPath(index outerpackage.Index, root outerpackage.Root) string {
	switch root {
	case outerpackage.RootMetadata:
		return index.TargetRoots.Metadata
	case outerpackage.RootInstallation:
		return index.TargetRoots.Installation
	case outerpackage.RootTrustedConfiguration:
		return index.TargetRoots.TrustedConfiguration
	default:
		return ""
	}
}

func (v *verifier) openTree(root outerpackage.Root, path string) (*verifiedTree, error) {
	parsed, err := parseWindowsPath(path)
	if err != nil {
		return nil, err
	}
	handle, err := v.deps.openTraversalRoot(parsed.drive, winfile.OpenOptions{
		VolumeUse: winfile.VolumeUseReadOnly, DirectoryEnumeration: true, SecurityMode: winfile.SecurityModeAmbientAncestor,
	})
	if err != nil || nilInterface(handle) {
		return nil, ErrTree
	}
	current, err := v.retainDirectory(parsed.drive, handle, root, "", false)
	if err != nil {
		return nil, err
	}
	managed := false
	for _, component := range parsed.components {
		if cause := context.Cause(v.ctx); cause != nil {
			return nil, cause
		}
		entry, err := v.exactDirectoryEntry(current, component)
		if err != nil {
			return nil, err
		}
		if component == "AgenticReview" {
			managed = true
		}
		mode := winfile.SecurityModeAmbientAncestor
		if managed {
			mode = winfile.SecurityModeManaged
		}
		child, err := current.handle.OpenDirectoryComponent(component, winfile.OpenOptions{
			VolumeUse: winfile.VolumeUseReadOnly, DirectoryEnumeration: true, SecurityMode: mode,
		})
		if err != nil || nilInterface(child) {
			return nil, ErrTree
		}
		opened, err := v.retainDirectory(joinPath(current.object.Path, component), child, root, "", managed)
		if err != nil || entry.Identity != opened.object.Evidence.Identity || entry.Kind != winfile.ObjectKindDirectory ||
			entry.Attributes != opened.object.Evidence.Attributes {
			return nil, ErrTree
		}
		current = opened
	}
	if !managed || current.object.Path != path {
		return nil, ErrTree
	}
	current.relativePath = ""
	return &verifiedTree{
		rootType: root, path: path, root: current,
		directories: map[string]*openedDirectory{"": current}, files: make(map[string]*openedFile),
	}, nil
}

func (v *verifier) exactDirectoryEntry(parent *openedDirectory, component string) (winfile.DirectoryEntry, error) {
	if v.totalEntries >= maximumTotalEntries || v.totalNameUnits >= maximumTotalNameUTF16Units {
		return winfile.DirectoryEntry{}, ErrTree
	}
	remainingEntries := maximumTotalEntries - v.totalEntries
	maximumEntries := maximumEntriesPerDirectory
	if remainingEntries < maximumEntries {
		maximumEntries = remainingEntries
	}
	remainingNames := maximumTotalNameUTF16Units - v.totalNameUnits
	options := winfile.DirectoryEnumerationOptions{
		MaximumEntries: maximumEntries, MaximumNameUTF16Units: maximumNameUTF16Units,
		MaximumTotalNameUTF16Units: remainingNames,
	}
	enumeration, err := parent.handle.Enumerate(options)
	if err != nil || uint32(len(enumeration.Entries)) > remainingEntries ||
		enumeration.NameUTF16Units > remainingNames {
		return winfile.DirectoryEntry{}, ErrTree
	}
	v.totalEntries += uint32(len(enumeration.Entries))
	v.totalNameUnits += enumeration.NameUTF16Units
	for _, entry := range enumeration.Entries {
		if entry.Name == component {
			return entry, nil
		}
	}
	return winfile.DirectoryEntry{}, ErrTree
}

func (v *verifier) retainDirectory(path string, handle directoryHandle, root outerpackage.Root, relative string, managed bool) (*openedDirectory, error) {
	if nilInterface(handle) || v.owner == nil {
		return nil, ErrTree
	}
	resourceIndex := v.owner.addDirectory(path, handle, secureconfig.ObjectEvidence{})
	if v.directoryCount >= maximumDirectories {
		return nil, ErrTree
	}
	v.directoryCount++
	mode := winfile.SecurityModeAmbientAncestor
	if managed {
		mode = winfile.SecurityModeManaged
	}
	object, err := secureconfig.NewObjectEvidenceForMode(path, mode, handle.Evidence())
	if err != nil {
		return nil, err
	}
	v.owner.setObject(resourceIndex, object)
	if err := v.registerIdentity(path, object.Evidence.Identity); err != nil ||
		v.deps.checkSecurity(root, "", relative, object.Evidence, managed) != nil {
		return nil, ErrTree
	}
	if sensitive, err := handle.ReinspectCaseSensitivity(); err != nil || sensitive {
		return nil, ErrTree
	}
	return &openedDirectory{handle: handle, object: object, resourceIndex: resourceIndex, relativePath: relative}, nil
}

func (v *verifier) retainFile(path string, handle fileHandle, root outerpackage.Root, role outerpackage.Role, relative string) (*openedFile, error) {
	if nilInterface(handle) || v.owner == nil {
		return nil, ErrFile
	}
	resourceIndex := v.owner.addFile(path, handle, secureconfig.ObjectEvidence{})
	object, err := secureconfig.NewObjectEvidenceForMode(path, winfile.SecurityModeManaged, handle.Evidence())
	if err != nil {
		return nil, err
	}
	v.owner.setObject(resourceIndex, object)
	if err := v.registerIdentity(path, object.Evidence.Identity); err != nil ||
		v.deps.checkSecurity(root, role, relative, object.Evidence, true) != nil {
		return nil, ErrFile
	}
	return &openedFile{handle: handle, object: object, resourceIndex: resourceIndex, relativePath: relative}, nil
}

func (v *verifier) registerIdentity(path string, identity winfile.FileIdentity) error {
	if identity == (winfile.FileIdentity{}) || identity.FileID == ([16]byte{}) {
		return ErrTree
	}
	if previous, duplicate := v.seenIdentities[identity]; duplicate && previous != path {
		return ErrTree
	}
	v.seenIdentities[identity] = path
	return nil
}

func (v *verifier) enumerate(directory *openedDirectory) (winfile.DirectoryEnumeration, error) {
	if v.totalEntries >= maximumTotalEntries || v.totalNameUnits >= maximumTotalNameUTF16Units {
		return winfile.DirectoryEnumeration{}, ErrTree
	}
	remainingEntries := maximumTotalEntries - v.totalEntries
	maximumEntries := maximumEntriesPerDirectory
	if remainingEntries < maximumEntries {
		maximumEntries = remainingEntries
	}
	remainingNames := maximumTotalNameUTF16Units - v.totalNameUnits
	options := winfile.DirectoryEnumerationOptions{
		MaximumEntries: maximumEntries, MaximumNameUTF16Units: maximumNameUTF16Units,
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
	for _, root := range []outerpackage.Root{outerpackage.RootMetadata, outerpackage.RootInstallation, outerpackage.RootTrustedConfiguration} {
		tree := v.trees[root]
		result = append(result, RootSnapshot{root: root, path: tree.path, object: cloneObjectEvidence(tree.root.object)})
	}
	return result
}

func (v *verifier) fileSnapshots() []FileSnapshot {
	result := make([]FileSnapshot, 0, len(v.files))
	for _, root := range []outerpackage.Root{outerpackage.RootMetadata, outerpackage.RootInstallation, outerpackage.RootTrustedConfiguration} {
		if root == outerpackage.RootMetadata {
			result = append(result, cloneFileSnapshot(v.files[fileKey(string(root), outerpackage.PackageIndexPath)]))
			result = append(result, cloneFileSnapshot(v.files[fileKey(string(root), outerpackage.SignatureEnvelopePath)]))
		}
		for _, payload := range v.plan.index.Payloads {
			if payload.Root == root {
				result = append(result, cloneFileSnapshot(v.files[fileKey(string(root), payload.Path)]))
			}
		}
	}
	return result
}

func validateAuthenticodeEvidence(evidence authenticode.Evidence, expectedSigner string) error {
	if !evidence.Trusted || evidence.SignatureKind != authenticode.SignatureKindEmbedded ||
		evidence.SignatureCount != 1 || evidence.VerifiedSignatureIndex != 0 ||
		evidence.RevocationPolicy != authenticode.RevocationPolicyRuntimeCacheOnlyNoCheck ||
		evidence.DigestPolicy != authenticode.DigestPolicySHA256Only ||
		evidence.StrongSignaturePolicy != authenticode.StrongSignaturePolicyWindowsOSCurrent ||
		evidence.SignerDigestAlgorithmOID != authenticode.SHA256ObjectIdentifier ||
		evidence.FileDigestAlgorithmOID != authenticode.SHA256ObjectIdentifier ||
		strings.TrimSpace(evidence.SignerIdentity) == "" ||
		subtle.ConstantTimeCompare([]byte(evidence.VerifiedLeafSignerCertificateDERSHA256), []byte(expectedSigner)) != 1 {
		return ErrAuthenticode
	}
	return nil
}

func equalDigest(actual [sha256.Size]byte, expected string) bool {
	return subtle.ConstantTimeCompare([]byte(hex.EncodeToString(actual[:])), []byte(expected)) == 1
}

func cloneSourcePlan(value sourcePlan) sourcePlan {
	value.indexDocument = bytes.Clone(value.indexDocument)
	value.envelopeDocument = bytes.Clone(value.envelopeDocument)
	value.controlDocument = bytes.Clone(value.controlDocument)
	value.executorDocument = bytes.Clone(value.executorDocument)
	index, _ := outerpackage.ParseIndex(value.indexDocument)
	value.index = index
	control, _ := config.Parse(value.controlDocument)
	executor, _ := config.Parse(value.executorDocument)
	value.control = control
	value.executor = executor
	return value
}
