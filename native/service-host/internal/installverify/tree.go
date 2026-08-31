package installverify

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

func (v *verifier) verifyClosedTrees() error {
	installationExpected := newExpectedRoot()
	manifestRelative, err := relativePath(v.installation.path, v.controlConfig.Installation.ManifestPath)
	if err != nil {
		return verificationError(ErrorTree, "release manifest is outside the installation tree", errors.Join(ErrClosedTree, err))
	}
	if err := installationExpected.addFile(
		manifestRelative,
		expectedFile{purpose: purposeManifest},
		v.options.Limits.MaximumPathDepth,
	); err != nil {
		return verificationError(ErrorTree, "add release manifest to the installation tree", errors.Join(ErrClosedTree, err))
	}

	trustedExpected := newExpectedRoot()
	if err := trustedExpected.addFile(
		releasemanifest.ControlBootstrapConfigurationPath,
		expectedFile{purpose: purposeControlBootstrap},
		v.options.Limits.MaximumPathDepth,
	); err != nil {
		return verificationError(ErrorTree, "add Control bootstrap to the trusted tree", errors.Join(ErrClosedTree, err))
	}
	if err := trustedExpected.addFile(
		releasemanifest.ExecutorBootstrapConfigurationPath,
		expectedFile{purpose: purposeExecutorBootstrap},
		v.options.Limits.MaximumPathDepth,
	); err != nil {
		return verificationError(ErrorTree, "add Executor bootstrap to the trusted tree", errors.Join(ErrClosedTree, err))
	}

	for index := range v.manifest.Files {
		file := &v.manifest.Files[index]
		tree := installationExpected
		if file.Root == releasemanifest.RootTrustedConfiguration {
			tree = trustedExpected
		}
		if err := tree.addFile(
			file.Path,
			expectedFile{purpose: purposeManifestEntry, manifest: file},
			v.options.Limits.MaximumPathDepth,
		); err != nil {
			return verificationError(ErrorTree, "release manifest paths do not form a closed tree", errors.Join(ErrClosedTree, err))
		}
	}

	if err := v.walkDirectory(v.installation, v.installation.root, installationExpected); err != nil {
		return verificationError(ErrorTree, "verify closed installation tree", errors.Join(ErrClosedTree, err))
	}
	if err := v.walkDirectory(v.trusted, v.trusted.root, trustedExpected); err != nil {
		return verificationError(ErrorTree, "verify closed trusted configuration tree", errors.Join(ErrClosedTree, err))
	}
	if len(v.verifiedFiles) != len(v.manifest.Files) {
		return verificationError(ErrorTree, "verified file count differs from the release manifest", ErrClosedTree)
	}
	return nil
}

func (tree *verifiedTree) openFilePath(
	v *verifier,
	relative string,
) (*openedFile, []secureconfig.ObjectEvidence, error) {
	components := strings.Split(relative, `\`)
	if len(components) == 0 || uint32(len(components)) > v.options.Limits.MaximumPathDepth {
		return nil, nil, errors.New("relative file path exceeds its depth limit")
	}
	current := tree.root
	ancestors := cloneObjectEvidenceSlice(tree.ancestors)
	ancestors = append(ancestors, cloneObjectEvidence(tree.root.object))
	for index := 0; index < len(components)-1; index++ {
		relativeDirectory := strings.Join(components[:index+1], `\`)
		key := strings.ToLower(relativeDirectory)
		next := tree.directories[key]
		if next == nil {
			var err error
			next, err = tree.openDirectoryChild(v, current, components[index], relativeDirectory)
			if err != nil {
				return nil, nil, err
			}
		}
		current = next
		ancestors = append(ancestors, cloneObjectEvidence(current.object))
	}
	key := strings.ToLower(relative)
	file := tree.files[key]
	if file == nil {
		var err error
		file, err = tree.openFileChild(v, current, components[len(components)-1], relative)
		if err != nil {
			return nil, nil, err
		}
	}
	return file, ancestors, nil
}

func (tree *verifiedTree) openDirectoryChild(
	v *verifier,
	parent *openedDirectory,
	actualName string,
	relative string,
) (*openedDirectory, error) {
	if err := v.reserveDirectory(); err != nil {
		return nil, err
	}
	path := joinPath(parent.object.Path, actualName)
	handle, err := parent.handle.OpenDirectoryComponent(actualName, winfile.OpenOptions{
		VolumeUse:            winfile.VolumeUseReadOnly,
		DirectoryEnumeration: true,
		SecurityMode:         winfile.SecurityModeManaged,
	})
	if err != nil {
		return nil, fmt.Errorf("open directory %s: %w", path, err)
	}
	opened, err := v.retainDirectory(
		path,
		handle,
		tree.policy,
		winfile.SecurityModeManaged,
		parent.depth+1,
		parent.depth+2,
	)
	if err != nil {
		return nil, err
	}
	if opened.object.Evidence.Identity.VolumeSerialNumber != tree.root.object.Evidence.Identity.VolumeSerialNumber {
		return nil, fmt.Errorf("directory %s is on a different volume", path)
	}
	opened.relativePath = relative
	tree.directories[strings.ToLower(relative)] = opened
	return opened, nil
}

func (tree *verifiedTree) openFileChild(
	v *verifier,
	parent *openedDirectory,
	actualName string,
	relative string,
) (*openedFile, error) {
	path := joinPath(parent.object.Path, actualName)
	handle, err := parent.handle.OpenFileComponent(actualName, winfile.OpenOptions{
		VolumeUse: winfile.VolumeUseReadOnly, SecurityMode: winfile.SecurityModeManaged,
	})
	if err != nil {
		return nil, fmt.Errorf("open file %s: %w", path, err)
	}
	object, err := secureconfig.NewObjectEvidenceForMode(
		path,
		winfile.SecurityModeManaged,
		handle.Evidence(),
	)
	if err != nil {
		return nil, errors.Join(err, closeRejectedFile(handle))
	}
	resourceIndex := v.resources.addFile(path, handle, object)
	if err := tree.policy.CheckFile(secureconfig.FileSecurityRequest{Object: cloneObjectEvidence(object)}); err != nil {
		return nil, fmt.Errorf("file security policy rejected %s: %w", path, err)
	}
	if object.Evidence.Identity.VolumeSerialNumber != tree.root.object.Evidence.Identity.VolumeSerialNumber {
		return nil, fmt.Errorf("file %s is on a different volume", path)
	}
	if err := registerIdentity(v.seenIdentities, path, object.Evidence.Identity); err != nil {
		return nil, err
	}
	opened := &openedFile{
		handle: handle, object: object, resourceIndex: resourceIndex, relativePath: relative,
	}
	tree.files[strings.ToLower(relative)] = opened
	return opened, nil
}

func (v *verifier) walkDirectory(
	tree *verifiedTree,
	current *openedDirectory,
	expected *expectedNode,
) error {
	if cause := context.Cause(v.ctx); cause != nil {
		return cause
	}
	if expected.file != nil || len(expected.children) == 0 {
		return errors.New("expected directory is empty or also marked as a file")
	}
	remainingEntries := v.options.Limits.MaximumTotalEntries - v.totalEntries
	if remainingEntries == 0 {
		return fmt.Errorf("total directory entry limit %d is exhausted", v.options.Limits.MaximumTotalEntries)
	}
	maximumEntries := v.options.Limits.MaximumEntriesPerDirectory
	if remainingEntries < maximumEntries {
		maximumEntries = remainingEntries
	}
	remainingNames := v.options.Limits.MaximumTotalNameUTF16Units - v.totalNameUnits
	if remainingNames == 0 {
		return fmt.Errorf("total directory name limit %d is exhausted", v.options.Limits.MaximumTotalNameUTF16Units)
	}
	enumerationOptions := winfile.DirectoryEnumerationOptions{
		MaximumEntries:             maximumEntries,
		MaximumNameUTF16Units:      v.options.Limits.MaximumNameUTF16Units,
		MaximumTotalNameUTF16Units: remainingNames,
	}
	enumeration, err := current.handle.Enumerate(enumerationOptions)
	if err != nil {
		return fmt.Errorf("enumerate %s: %w", current.object.Path, err)
	}
	if uint64(len(enumeration.Entries)) > uint64(remainingEntries) ||
		enumeration.NameUTF16Units > remainingNames {
		return errors.New("directory enumeration exceeds aggregate limits")
	}
	v.totalEntries += uint32(len(enumeration.Entries))
	v.totalNameUnits += enumeration.NameUTF16Units
	v.resources.recordEnumeration(current.resourceIndex, enumeration, enumerationOptions)
	if len(enumeration.Entries) != len(expected.children) {
		return fmt.Errorf(
			"directory %s contains %d entries, expected %d",
			current.object.Path,
			len(enumeration.Entries),
			len(expected.children),
		)
	}

	matched := make(map[*expectedNode]struct{}, len(expected.children))
	for _, entry := range enumeration.Entries {
		expectedChild := expectedChildByName(expected, entry.Name)
		if expectedChild == nil {
			return fmt.Errorf("directory %s contains unexpected entry %q", current.object.Path, entry.Name)
		}
		if _, duplicate := matched[expectedChild]; duplicate {
			return fmt.Errorf("directory %s maps multiple entries to %q", current.object.Path, expectedChild.component)
		}
		matched[expectedChild] = struct{}{}
		relative := expectedChild.component
		if current.relativePath != "" {
			relative = current.relativePath + `\` + expectedChild.component
		}

		if expectedChild.file == nil {
			if entry.Kind != winfile.ObjectKindDirectory || len(expectedChild.children) == 0 {
				return fmt.Errorf("entry %s has the wrong kind or represents an empty directory", relative)
			}
			key := strings.ToLower(relative)
			child := tree.directories[key]
			if child == nil {
				child, err = tree.openDirectoryChild(v, current, entry.Name, relative)
				if err != nil {
					return err
				}
			}
			if err := compareDirectoryEntry(entry, child.object, false); err != nil {
				return fmt.Errorf("bind enumerated directory %s: %w", relative, err)
			}
			if err := v.walkDirectory(tree, child, expectedChild); err != nil {
				return err
			}
			continue
		}

		if entry.Kind != winfile.ObjectKindFile || len(expectedChild.children) != 0 {
			return fmt.Errorf("entry %s has the wrong kind or is both a file and directory", relative)
		}
		key := strings.ToLower(relative)
		file := tree.files[key]
		if file == nil {
			file, err = tree.openFileChild(v, current, entry.Name, relative)
			if err != nil {
				return err
			}
		}
		if err := compareDirectoryEntry(entry, file.object, true); err != nil {
			return fmt.Errorf("bind enumerated file %s: %w", relative, err)
		}
		if err := v.verifyExpectedFile(tree, file, *expectedChild.file); err != nil {
			return err
		}
	}
	return nil
}

func expectedChildByName(parent *expectedNode, name string) *expectedNode {
	if child := parent.children[strings.ToLower(name)]; child != nil && strings.EqualFold(child.component, name) {
		return child
	}
	for _, child := range parent.children {
		if strings.EqualFold(child.component, name) {
			return child
		}
	}
	return nil
}

func compareDirectoryEntry(
	entry winfile.DirectoryEntry,
	object secureconfig.ObjectEvidence,
	file bool,
) error {
	evidence := object.Evidence
	if entry.Identity != evidence.Identity || entry.Kind != evidence.Kind || entry.Attributes != evidence.Attributes {
		return errors.New("enumeration identity, kind, or attributes differ from the child handle")
	}
	if file && entry.Size != evidence.Size {
		return errors.New("enumeration size differs from the child file handle")
	}
	return nil
}

func (v *verifier) verifyExpectedFile(
	tree *verifiedTree,
	file *openedFile,
	expected expectedFile,
) error {
	if cause := context.Cause(v.ctx); cause != nil {
		return cause
	}
	switch expected.purpose {
	case purposeManifest:
		if !sameUnderlyingObject(file.object, v.manifestRead.File) {
			return errors.New("re-enumerated release manifest differs from the retained manifest handle")
		}
		return nil
	case purposeControlBootstrap:
		return v.verifyBootstrapFile(file, v.controlBootstrap, "Control")
	case purposeExecutorBootstrap:
		return v.verifyBootstrapFile(file, v.executorBootstrap, "Executor")
	case purposeManifestEntry:
		if expected.manifest == nil || expected.manifest.Root != tree.rootType {
			return errors.New("manifest tree entry lacks matching file metadata")
		}
		return v.verifyManifestFile(file, *expected.manifest)
	default:
		return errors.New("unknown expected file purpose")
	}
}

func (v *verifier) verifyBootstrapFile(
	file *openedFile,
	read secureconfig.Result,
	label string,
) error {
	if !sameUnderlyingObject(file.object, read.File) {
		return fmt.Errorf("%s bootstrap changed after its secure read", label)
	}
	hash, err := file.handle.HashSHA256(winfile.HashOptions{
		ExpectedSize: uint64(len(read.Data)), MaximumBytes: configBootstrapMaximumBytes(), PrefixBytes: 0,
	})
	if err != nil {
		return fmt.Errorf("hash %s bootstrap: %w", label, err)
	}
	if hash.Size != uint64(len(read.Data)) || subtle.ConstantTimeCompare(hash.SHA256[:], read.ContentSHA256[:]) != 1 {
		return fmt.Errorf("%s bootstrap content changed after its secure read", label)
	}
	return nil
}

func (v *verifier) verifyManifestFile(file *openedFile, expected releasemanifest.File) error {
	size, err := parseManifestSize(expected.Size)
	if err != nil || size == 0 || size > v.options.Limits.MaximumFileBytes {
		return verificationError(ErrorFile, "manifest file size is invalid", errors.Join(ErrFileContent, err))
	}
	hash, err := file.handle.HashSHA256(winfile.HashOptions{
		ExpectedSize: size,
		MaximumBytes: v.options.Limits.MaximumFileBytes,
		PrefixBytes:  5,
	})
	if err != nil {
		return verificationError(ErrorFile, "hash manifest file from retained handle", errors.Join(ErrFileContent, err))
	}
	if hash.Size != size || !equalDigest(hash.SHA256, expected.SHA256) {
		return verificationError(ErrorFile, "manifest file digest or size differs from its entry", ErrFileContent)
	}
	if err := releasemanifest.ValidateFileContentPrefix(expected, hash.Prefix); err != nil {
		return verificationError(ErrorFile, "manifest file content prefix violates its role", errors.Join(ErrFileContent, err))
	}

	var signature *authenticode.Evidence
	if requiresAuthenticode(expected.Role) {
		evidence, err := file.handle.VerifyAuthenticode(v.deps.authenticodeVerifier)
		if err != nil {
			return verificationError(ErrorSignature, "verify file Authenticode signature from retained handle", errors.Join(ErrAuthenticode, err))
		}
		if err := validateAuthenticodeEvidence(
			evidence,
			v.controlConfig.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256,
		); err != nil {
			return verificationError(ErrorSignature, "file Authenticode signer differs from the bootstrap pin", err)
		}
		copy := evidence
		signature = &copy
	}
	key := manifestFileKey(expected.Root, expected.Path)
	if _, duplicate := v.verifiedFiles[key]; duplicate {
		return verificationError(ErrorTree, "manifest file was verified more than once", ErrClosedTree)
	}
	v.verifiedFiles[key] = FileSnapshot{
		root: expected.Root, path: expected.Path, absolutePath: file.object.Path,
		role: expected.Role, sha256: expected.SHA256, size: size,
		object: cloneObjectEvidence(file.object), authenticode: signature,
	}
	return nil
}

func sameUnderlyingObject(left, right secureconfig.ObjectEvidence) bool {
	leftVolume := left.Evidence.Volume
	rightVolume := right.Evidence.Volume
	return left.Evidence.Identity == right.Evidence.Identity &&
		left.Evidence.Kind == right.Evidence.Kind &&
		left.Evidence.SecurityMode == right.Evidence.SecurityMode &&
		left.Evidence.Attributes == right.Evidence.Attributes &&
		left.Evidence.Size == right.Evidence.Size &&
		left.Evidence.LinkCount == right.Evidence.LinkCount &&
		left.SecurityDescriptorSHA256 == right.SecurityDescriptorSHA256 &&
		strings.EqualFold(leftVolume.FileSystem, rightVolume.FileSystem) &&
		leftVolume.FileSystemFlags == rightVolume.FileSystemFlags &&
		leftVolume.HandleSerialNumber == rightVolume.HandleSerialNumber &&
		leftVolume.PathSerialNumber == rightVolume.PathSerialNumber &&
		leftVolume.DriveType == rightVolume.DriveType &&
		leftVolume.PersistentACLs == rightVolume.PersistentACLs &&
		leftVolume.ReadOnly == rightVolume.ReadOnly &&
		leftVolume.RequiredUse == rightVolume.RequiredUse &&
		leftVolume.PathIdentityCrossCheck == rightVolume.PathIdentityCrossCheck
}

func configBootstrapMaximumBytes() uint64 {
	return releasemanifest.MaximumBootstrapConfigurationBytes
}

func closeRejectedFile(file fileHandle) error {
	if file == nil {
		return nil
	}
	return file.Close()
}
