package stagedpackage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outertrust"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peimage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/servicehostreceipt"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

func (tree *verifiedTree) openFilePath(v *verifier, relative string) (*openedFile, error) {
	if tree == nil || tree.root == nil || validateRelativePath(relative) != nil {
		return nil, ErrTree
	}
	components := strings.Split(relative, `\`)
	current := tree.root
	for index := 0; index < len(components)-1; index++ {
		relativeDirectory := strings.Join(components[:index+1], `\`)
		next := tree.directories[strings.ToLower(relativeDirectory)]
		if next == nil {
			var err error
			next, err = tree.openDirectoryChild(v, current, components[index], relativeDirectory)
			if err != nil {
				return nil, err
			}
		}
		current = next
	}
	file := tree.files[strings.ToLower(relative)]
	if file != nil {
		return file, nil
	}
	return tree.openFileChild(v, current, components[len(components)-1], relative)
}

func (tree *verifiedTree) openDirectoryChild(
	v *verifier,
	parent *openedDirectory,
	actualName string,
	relative string,
) (*openedDirectory, error) {
	if tree == nil || parent == nil || actualName == "" || relative == "" {
		return nil, ErrTree
	}
	if err := v.reserveDirectory(); err != nil {
		return nil, err
	}
	handle, err := parent.handle.OpenDirectoryComponent(actualName, winfile.OpenOptions{
		VolumeUse:            winfile.VolumeUseReadOnly,
		DirectoryEnumeration: true,
		SecurityMode:         winfile.SecurityModeManaged,
	})
	if err != nil || nilInterface(handle) {
		return nil, ErrTree
	}
	opened, err := v.retainDirectory(
		joinPath(parent.object.Path, actualName),
		handle,
		winfile.SecurityModeManaged,
		parent.depth+1,
	)
	if err != nil || opened.object.Evidence.Identity.VolumeSerialNumber !=
		tree.root.object.Evidence.Identity.VolumeSerialNumber {
		return nil, ErrTree
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
	if tree == nil || parent == nil || actualName == "" || relative == "" {
		return nil, ErrTree
	}
	handle, err := parent.handle.OpenFileComponent(actualName, winfile.OpenOptions{
		VolumeUse: winfile.VolumeUseReadOnly, SecurityMode: winfile.SecurityModeManaged,
	})
	if err != nil || nilInterface(handle) {
		return nil, ErrFile
	}
	opened, err := v.retainFile(joinPath(parent.object.Path, actualName), handle)
	if err != nil || opened.object.Evidence.Identity.VolumeSerialNumber !=
		tree.root.object.Evidence.Identity.VolumeSerialNumber {
		return nil, ErrFile
	}
	opened.relativePath = relative
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
	if tree == nil || current == nil || expected == nil || expected.file != nil || len(expected.children) == 0 {
		return ErrTree
	}
	enumeration, err := v.enumerate(current)
	if err != nil || len(enumeration.Entries) != len(expected.children) {
		return ErrTree
	}
	matched := make(map[*expectedNode]struct{}, len(expected.children))
	for _, entry := range enumeration.Entries {
		childExpected := expectedChild(expected, entry.Name)
		if childExpected == nil || childExpected.component != entry.Name {
			return ErrTree
		}
		if _, duplicate := matched[childExpected]; duplicate {
			return ErrTree
		}
		matched[childExpected] = struct{}{}
		relative := childExpected.component
		if current.relativePath != "" {
			relative = current.relativePath + `\` + childExpected.component
		}
		if childExpected.file == nil {
			if entry.Kind != winfile.ObjectKindDirectory || len(childExpected.children) == 0 {
				return ErrTree
			}
			child := tree.directories[strings.ToLower(relative)]
			if child == nil {
				child, err = tree.openDirectoryChild(v, current, entry.Name, relative)
				if err != nil {
					return err
				}
			}
			if compareDirectoryEntry(entry, child.object, false) != nil {
				return ErrTree
			}
			if err := v.walkDirectory(tree, child, childExpected); err != nil {
				return err
			}
			continue
		}
		if entry.Kind != winfile.ObjectKindFile || len(childExpected.children) != 0 {
			return ErrTree
		}
		file := tree.files[strings.ToLower(relative)]
		if file == nil {
			file, err = tree.openFileChild(v, current, entry.Name, relative)
			if err != nil {
				return err
			}
		}
		if compareDirectoryEntry(entry, file.object, true) != nil {
			return ErrFile
		}
		if err := v.verifyExpectedFile(tree.rootType, file, *childExpected.file); err != nil {
			return err
		}
	}
	return nil
}

func compareDirectoryEntry(
	entry winfile.DirectoryEntry,
	object secureconfig.ObjectEvidence,
	file bool,
) error {
	objectEvidence := object.Evidence
	if entry.Identity != objectEvidence.Identity || entry.Kind != objectEvidence.Kind ||
		entry.Attributes != objectEvidence.Attributes {
		return ErrTree
	}
	if file && entry.Size != objectEvidence.Size {
		return ErrTree
	}
	return nil
}

func (v *verifier) verifyExpectedFile(
	root outerpackage.Root,
	file *openedFile,
	expected expectedFile,
) error {
	if file == nil || file.handle == nil || expected.size == 0 || expected.digest == "" {
		return ErrFile
	}
	prefixBytes := uint32(0)
	if expected.payload != nil && !isSpecialPayloadRole(expected.payload.Role) {
		prefixBytes = 5
	}
	hash, err := file.handle.HashSHA256(winfile.HashOptions{
		ExpectedSize: expected.size,
		MaximumBytes: maximumBytesForExpected(expected),
		PrefixBytes:  prefixBytes,
	})
	if err != nil || hash.Size != expected.size || !equalHexDigest(hash.SHA256, expected.digest) {
		return ErrFile
	}
	key := packageFileKey(root, file.relativePath)
	if captured, ok := v.captured[key]; ok {
		digest := sha256.Sum256(captured)
		if uint64(len(captured)) != expected.size || digest != hash.SHA256 {
			return ErrFile
		}
	}
	var signature *authenticode.Evidence
	role := outerpackage.Role("")
	indexed := expected.payload != nil
	if expected.payload != nil {
		payload := *expected.payload
		if payload.Root != root || payload.Path != file.relativePath || payload.Size == "" {
			return ErrFile
		}
		role = payload.Role
		if !isSpecialPayloadRole(payload.Role) {
			manifestFile := releasemanifest.File{
				Root: releasemanifest.FileRoot(payload.Root), Path: payload.Path,
				Role: releasemanifest.FileRole(payload.Role), SHA256: payload.SHA256, Size: payload.Size,
			}
			if err := releasemanifest.ValidateFileContentPrefix(manifestFile, hash.Prefix); err != nil {
				return ErrFile
			}
		}
		if err := v.capturePayloadDocument(file, payload, hash.SHA256); err != nil {
			return err
		}
		if isPortableExecutableRole(payload.Role) {
			verified, err := v.verifyPortableExecutable(file, payload, hash.SHA256)
			if err != nil {
				return err
			}
			signature = &verified
		}
		if payload.Root == outerpackage.RootTrustedConfiguration &&
			payload.Path == v.plan.index.NodeSpecificLocalAuthorityPublicSPKI.Path &&
			payload.Role == outerpackage.RoleTrustedConfig {
			if err := v.verifyNodeSPKI(file, payload, hash.SHA256); err != nil {
				return err
			}
		}
	}
	if err := file.handle.VerifyUnchanged(); err != nil {
		return ErrFile
	}
	if _, duplicate := v.files[key]; duplicate {
		return ErrTree
	}
	v.files[key] = FileSnapshot{
		root: root, path: file.relativePath, role: role, sha256: expected.digest,
		size: expected.size, indexed: indexed, object: cloneObjectEvidence(file.object),
		authenticode: signature,
	}
	return nil
}

func (v *verifier) capturePayloadDocument(
	file *openedFile,
	payload outerpackage.Payload,
	digest [sha256.Size]byte,
) error {
	maximum := uint64(0)
	switch payload.Role {
	case outerpackage.RolePackageDescriptor,
		outerpackage.RolePrepareReceipt,
		outerpackage.RoleReviewedClosure,
		outerpackage.RoleCompiledReleaseTemplate,
		outerpackage.RoleRuntimeManifest:
		maximum = releasemanifest.MaximumDocumentBytes
	case outerpackage.RoleServiceHostBuildReceipt:
		maximum = servicehostreceipt.MaximumDocumentBytes
	case outerpackage.RoleControlBootstrap, outerpackage.RoleExecutorBootstrap:
		maximum = releasemanifest.MaximumBootstrapConfigurationBytes
	default:
		return nil
	}
	key := packageFileKey(payload.Root, payload.Path)
	data := v.captured[key]
	if data == nil {
		var err error
		data, err = file.handle.ReadAll(maximum)
		if err != nil {
			return ErrFile
		}
		v.captured[key] = bytes.Clone(data)
	}
	if uint64(len(data)) != file.object.Evidence.Size || sha256.Sum256(data) != digest {
		return ErrFile
	}
	switch payload.Role {
	case outerpackage.RolePackageDescriptor:
		v.documents.descriptor = bytes.Clone(data)
	case outerpackage.RolePrepareReceipt:
		v.documents.prepare = bytes.Clone(data)
	case outerpackage.RoleReviewedClosure:
		v.documents.closure = bytes.Clone(data)
	case outerpackage.RoleCompiledReleaseTemplate:
		v.documents.template = bytes.Clone(data)
	case outerpackage.RoleServiceHostBuildReceipt:
		v.documents.buildReceipt = bytes.Clone(data)
	case outerpackage.RoleRuntimeManifest:
		v.documents.manifest = bytes.Clone(data)
	case outerpackage.RoleControlBootstrap:
		if !bytes.Equal(data, v.documents.control) {
			return ErrFile
		}
	case outerpackage.RoleExecutorBootstrap:
		if !bytes.Equal(data, v.documents.executor) {
			return ErrFile
		}
	}
	return nil
}

func (v *verifier) verifyPortableExecutable(
	file *openedFile,
	payload outerpackage.Payload,
	digest [sha256.Size]byte,
) (authenticode.Evidence, error) {
	if payload.TargetArchitecture == nil ||
		*payload.TargetArchitecture != v.plan.index.TargetArchitecture {
		return authenticode.Evidence{}, ErrFile
	}
	if peimage.ValidatePortableExecutable(
		file.handle,
		int64(file.object.Evidence.Size),
		string(*payload.TargetArchitecture),
		outerpackage.MaximumPayloadBytes,
	) != nil {
		return authenticode.Evidence{}, ErrFile
	}
	if payload.Role == outerpackage.RoleServiceHost {
		receipt, err := servicehostreceipt.Parse(v.documents.buildReceipt)
		if err != nil {
			return authenticode.Evidence{}, ErrDocuments
		}
		invariant, signed, err := peimage.SigningInvariantSHA256(
			file.handle, int64(file.object.Evidence.Size), string(*payload.TargetArchitecture),
		)
		if err != nil || !signed || hex.EncodeToString(invariant[:]) != receipt.SigningInvariantSHA256 {
			return authenticode.Evidence{}, ErrDocuments
		}
	}
	if err := file.handle.VerifyUnchanged(); err != nil {
		return authenticode.Evidence{}, ErrFile
	}
	signature, err := file.handle.VerifyAuthenticode(v.signatureVerifier)
	if err != nil || validateAuthenticodeEvidence(
		signature,
		v.plan.control.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256,
	) != nil {
		return authenticode.Evidence{}, ErrAuthenticode
	}
	after, err := file.handle.HashSHA256(winfile.HashOptions{
		ExpectedSize: file.object.Evidence.Size,
		MaximumBytes: outerpackage.MaximumPayloadBytes,
	})
	if err != nil || after.Size != file.object.Evidence.Size || after.SHA256 != digest ||
		file.handle.VerifyUnchanged() != nil {
		return authenticode.Evidence{}, ErrFile
	}
	return signature, nil
}

func (v *verifier) verifyNodeSPKI(
	file *openedFile,
	payload outerpackage.Payload,
	digest [sha256.Size]byte,
) error {
	if file.object.Evidence.Size > outertrust.MaximumSPKIBytes {
		return ErrDocuments
	}
	document, err := file.handle.ReadAll(outertrust.MaximumSPKIBytes)
	if err != nil || uint64(len(document)) != file.object.Evidence.Size || sha256.Sum256(document) != digest ||
		outertrust.ValidateSignerSPKI(document) != nil {
		return ErrDocuments
	}
	if payload.SHA256 != v.plan.index.NodeSpecificLocalAuthorityPublicSPKI.SHA256 {
		return ErrDocuments
	}
	return nil
}

func maximumBytesForExpected(expected expectedFile) uint64 {
	switch expected.purpose {
	case purposeIndex:
		return outerpackage.MaximumIndexBytes
	case purposeSignature:
		return outerpackage.MaximumEnvelopeBytes
	default:
		return outerpackage.MaximumPayloadBytes
	}
}

func isSpecialPayloadRole(role outerpackage.Role) bool {
	switch role {
	case outerpackage.RolePackageDescriptor,
		outerpackage.RolePrepareReceipt,
		outerpackage.RoleReviewedClosure,
		outerpackage.RoleCompiledReleaseTemplate,
		outerpackage.RoleServiceHostBuildReceipt,
		outerpackage.RoleRuntimeManifest,
		outerpackage.RoleControlBootstrap,
		outerpackage.RoleExecutorBootstrap:
		return true
	default:
		return false
	}
}

func isPortableExecutableRole(role outerpackage.Role) bool {
	switch role {
	case outerpackage.RoleServiceWrapper,
		outerpackage.RoleServiceHost,
		outerpackage.RoleNodeRuntime,
		outerpackage.RoleProcessHost,
		outerpackage.RoleCodexCLI,
		outerpackage.RoleGitCLI,
		outerpackage.RoleGitHelper,
		outerpackage.RoleCodexRuntime,
		outerpackage.RoleNativeLibrary:
		return true
	default:
		return false
	}
}

func validateAuthenticodeEvidence(evidence authenticode.Evidence, expectedSigner string) error {
	if !evidence.Trusted || evidence.SignatureKind != authenticode.SignatureKindEmbedded ||
		evidence.SignatureCount != 1 || evidence.VerifiedSignatureIndex != 0 ||
		evidence.TimestampCounterSignerCount > 64 ||
		evidence.RevocationPolicy != authenticode.RevocationPolicyRuntimeCacheOnlyNoCheck ||
		evidence.DigestPolicy != authenticode.DigestPolicySHA256Only ||
		evidence.StrongSignaturePolicy != authenticode.StrongSignaturePolicyWindowsOSCurrent ||
		evidence.SignerDigestAlgorithmOID != authenticode.SHA256ObjectIdentifier ||
		evidence.FileDigestAlgorithmOID != authenticode.SHA256ObjectIdentifier ||
		strings.TrimSpace(evidence.SignerIdentity) == "" || len(evidence.SignerIdentity) > 4<<10 ||
		strings.ContainsRune(evidence.SignerIdentity, '\x00') || !validSHA256(expectedSigner) ||
		subtle.ConstantTimeCompare(
			[]byte(evidence.VerifiedLeafSignerCertificateDERSHA256),
			[]byte(expectedSigner),
		) != 1 {
		return ErrAuthenticode
	}
	return nil
}

func equalHexDigest(actual [sha256.Size]byte, expected string) bool {
	return subtle.ConstantTimeCompare([]byte(hex.EncodeToString(actual[:])), []byte(expected)) == 1
}

func cloneFileSnapshot(value FileSnapshot) FileSnapshot {
	value.object = cloneObjectEvidence(value.object)
	if value.authenticode != nil {
		copy := *value.authenticode
		value.authenticode = &copy
	}
	return value
}
