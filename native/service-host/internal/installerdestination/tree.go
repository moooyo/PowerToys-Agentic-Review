package installerdestination

import (
	"bytes"
	"context"
	"crypto/sha256"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

func (v *verifier) walkDirectory(tree *verifiedTree, current *openedDirectory, expected *expectedNode) error {
	if cause := context.Cause(v.ctx); cause != nil {
		return cause
	}
	if expected == nil || expected.file != nil || len(expected.children) == 0 {
		return ErrTree
	}
	enumeration, err := v.enumerate(current)
	if err != nil || len(enumeration.Entries) != len(expected.children) {
		return ErrTree
	}
	matched := make(map[*expectedNode]struct{}, len(expected.children))
	for _, entry := range enumeration.Entries {
		childExpected := expectedChild(expected, entry.Name)
		if childExpected == nil {
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
			child, err := current.handle.OpenDirectoryComponent(entry.Name, winfile.OpenOptions{
				VolumeUse: winfile.VolumeUseReadOnly, DirectoryEnumeration: true, SecurityMode: winfile.SecurityModeManaged,
			})
			if err != nil || nilInterface(child) {
				return ErrTree
			}
			opened, err := v.retainDirectory(joinPath(current.object.Path, entry.Name), child, tree.rootType, relative, true)
			if err != nil || !sameEntry(entry, opened.object.Evidence, false) {
				return ErrTree
			}
			tree.directories[strings.ToLower(relative)] = opened
			if err := v.walkDirectory(tree, opened, childExpected); err != nil {
				return err
			}
			continue
		}
		if entry.Kind != winfile.ObjectKindFile || len(childExpected.children) != 0 {
			return ErrTree
		}
		file, err := current.handle.OpenFileComponent(entry.Name, winfile.OpenOptions{
			VolumeUse: winfile.VolumeUseReadOnly, SecurityMode: winfile.SecurityModeManaged,
		})
		if err != nil || nilInterface(file) {
			return ErrFile
		}
		opened, err := v.retainFile(
			joinPath(current.object.Path, entry.Name), file, tree.rootType, childExpected.file.role, relative,
		)
		if err != nil || !sameEntry(entry, opened.object.Evidence, true) {
			return ErrFile
		}
		tree.files[strings.ToLower(relative)] = opened
		if err := v.verifyFile(tree.rootType, opened, *childExpected.file); err != nil {
			return err
		}
	}
	return nil
}

func sameEntry(entry winfile.DirectoryEntry, evidence winfile.Evidence, file bool) bool {
	if entry.Identity != evidence.Identity || entry.Kind != evidence.Kind || entry.Attributes != evidence.Attributes {
		return false
	}
	return !file || entry.Size == evidence.Size
}

func (v *verifier) verifyFile(root outerpackage.Root, file *openedFile, expected expectedFile) error {
	if expected.size == 0 || expected.digest == "" {
		return ErrFile
	}
	hash, err := file.handle.HashSHA256(winfile.HashOptions{
		ExpectedSize: expected.size, MaximumBytes: outerpackage.MaximumPayloadBytes,
	})
	if err != nil || hash.Size != expected.size || !equalDigest(hash.SHA256, expected.digest) {
		return ErrFile
	}
	if expected.exact != nil {
		document, err := file.handle.ReadAll(uint64(len(expected.exact)))
		if err != nil || !bytes.Equal(document, expected.exact) || sha256.Sum256(document) != hash.SHA256 {
			return ErrFile
		}
	}
	var signature *authenticode.Evidence
	if portableExecutableRole(expected.role) {
		verified, err := file.handle.VerifyAuthenticode(v.signatureVerifier)
		if err != nil || validateAuthenticodeEvidence(
			verified,
			v.plan.control.Installation.ApprovedAuthenticodeSignerCertificateDERSHA256,
		) != nil {
			return ErrAuthenticode
		}
		after, err := file.handle.HashSHA256(winfile.HashOptions{
			ExpectedSize: expected.size, MaximumBytes: outerpackage.MaximumPayloadBytes,
		})
		if err != nil || after.Size != expected.size || after.SHA256 != hash.SHA256 {
			return ErrFile
		}
		copy := verified
		signature = &copy
	}
	if file.handle.VerifyUnchanged() != nil {
		return ErrFile
	}
	key := fileKey(string(root), file.relativePath)
	if _, duplicate := v.files[key]; duplicate {
		return ErrTree
	}
	snapshot := FileSnapshot{
		root: root, path: file.relativePath, role: expected.role, sha256: expected.digest,
		size: expected.size, object: cloneObjectEvidence(file.object),
	}
	if signature != nil {
		value := *signature
		snapshot.authenticode = &value
	}
	v.files[key] = snapshot
	return nil
}

func portableExecutableRole(role outerpackage.Role) bool {
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
