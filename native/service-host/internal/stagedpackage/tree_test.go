package stagedpackage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outerpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

func TestWalkDirectoryBindsEnumerationToRetainedFile(t *testing.T) {
	data := []byte("index")
	digest := sha256.Sum256(data)
	rootPath := `C:\Stage\metadata`
	filePath := rootPath + `\package-index.json`
	fileEvidence := stagedTestEvidence(filePath, winfile.ObjectKindFile, 2, uint64(len(data)))
	file := &stagedTestFile{evidence: fileEvidence, data: data}
	directory := &stagedTestDirectory{
		evidence: stagedTestEvidence(rootPath, winfile.ObjectKindDirectory, 1, 0),
		enumeration: winfile.DirectoryEnumeration{Entries: []winfile.DirectoryEntry{{
			Name:       outerpackage.PackageIndexPath,
			Kind:       winfile.ObjectKindFile,
			Identity:   fileEvidence.Identity,
			Attributes: fileEvidence.Attributes,
			Size:       uint64(len(data)),
		}}},
		file: file,
	}
	v, tree, expected := stagedTreeFixture(t, directory, hex.EncodeToString(digest[:]), uint64(len(data)))
	if err := v.walkDirectory(tree, tree.root, expected); err != nil {
		t.Fatal(err)
	}
	snapshot := v.files[packageFileKey(outerpackage.RootMetadata, outerpackage.PackageIndexPath)]
	if snapshot.indexed || snapshot.sha256 != hex.EncodeToString(digest[:]) || snapshot.size != uint64(len(data)) {
		t.Fatalf("unexpected file snapshot: %#v", snapshot)
	}
}

func TestWalkDirectoryRejectsPhysicalCaseAlias(t *testing.T) {
	data := []byte("index")
	digest := sha256.Sum256(data)
	rootPath := `C:\Stage\metadata`
	filePath := rootPath + `\PACKAGE-INDEX.JSON`
	fileEvidence := stagedTestEvidence(filePath, winfile.ObjectKindFile, 2, uint64(len(data)))
	directory := &stagedTestDirectory{
		evidence: stagedTestEvidence(rootPath, winfile.ObjectKindDirectory, 1, 0),
		enumeration: winfile.DirectoryEnumeration{Entries: []winfile.DirectoryEntry{{
			Name: outerpackage.PackageIndexPath, Kind: winfile.ObjectKindFile,
			Identity: fileEvidence.Identity, Size: uint64(len(data)),
		}}},
		file: &stagedTestFile{evidence: fileEvidence, data: data},
	}
	v, tree, expected := stagedTreeFixture(t, directory, hex.EncodeToString(digest[:]), uint64(len(data)))
	directory.enumeration.Entries[0].Name = "PACKAGE-INDEX.JSON"
	if err := v.walkDirectory(tree, tree.root, expected); !errors.Is(err, ErrTree) {
		t.Fatalf("case alias returned %v, want ErrTree", err)
	}
}

func stagedTreeFixture(
	t testing.TB,
	directory *stagedTestDirectory,
	digest string,
	size uint64,
) (*verifier, *verifiedTree, *expectedNode) {
	t.Helper()
	object, err := secureconfig.NewObjectEvidenceForMode(
		directory.evidence.Path.RequestedPath,
		winfile.SecurityModeManaged,
		directory.evidence,
	)
	if err != nil {
		t.Fatal(err)
	}
	owner := &handleOwner{}
	resourceIndex := owner.addDirectory(object.Path, directory, object)
	opened := &openedDirectory{
		handle: directory, object: object, resourceIndex: resourceIndex,
	}
	tree := &verifiedTree{
		rootType: outerpackage.RootMetadata,
		path:     object.Path,
		root:     opened,
		directories: map[string]*openedDirectory{
			"": opened,
		},
		files: make(map[string]*openedFile),
	}
	v := &verifier{
		ctx:            context.Background(),
		deps:           verifierDependencies{checkSecurity: func(winfile.Evidence, winfile.ObjectKind, bool) error { return nil }},
		owner:          owner,
		seenIdentities: map[winfile.FileIdentity]string{directory.evidence.Identity: object.Path},
		files:          make(map[string]FileSnapshot),
		captured:       make(map[string][]byte),
	}
	expected := newExpectedRoot()
	if err := expected.addFile(outerpackage.PackageIndexPath, expectedFile{
		purpose: purposeIndex, digest: digest, size: size,
	}); err != nil {
		t.Fatal(err)
	}
	return v, tree, expected
}

func stagedTestEvidence(path string, kind winfile.ObjectKind, identity byte, size uint64) winfile.Evidence {
	var fileID [16]byte
	fileID[0] = identity
	return winfile.Evidence{
		Kind: kind, Identity: winfile.FileIdentity{VolumeSerialNumber: 1, FileID: fileID},
		Size: size, LinkCount: 1,
		Path: winfile.PathEvidence{
			RequestedPath: path, TerminalComponentReparseFree: true,
			Ancestors: winfile.AncestorValidationNotPerformed,
		},
		Volume: winfile.VolumeEvidence{
			FileSystem: "NTFS", FileSystemFlags: 0x8, HandleSerialNumber: 1,
			PathSerialNumber: 1, DriveType: 3, PersistentACLs: true,
			RequiredUse: winfile.VolumeUseReadOnly, PathIdentityCrossCheck: true,
		},
		SecurityMode: winfile.SecurityModeManaged,
		Security: winfile.SecurityDescriptorEvidence{
			OwnerSID: "S-1-5-18", GroupSID: "S-1-5-18", DACLPresent: true,
			DACLProtected: true, Control: 0x9004, Revision: 1,
			SelfRelativeDescriptor: []byte{1},
		},
	}
}

type stagedTestDirectory struct {
	evidence    winfile.Evidence
	enumeration winfile.DirectoryEnumeration
	file        fileHandle
}

func (directory *stagedTestDirectory) Evidence() winfile.Evidence { return directory.evidence }
func (*stagedTestDirectory) OpenDirectoryComponent(string, winfile.OpenOptions) (directoryHandle, error) {
	return nil, errors.New("unexpected directory open")
}
func (directory *stagedTestDirectory) OpenFileComponent(string, winfile.OpenOptions) (fileHandle, error) {
	return directory.file, nil
}
func (directory *stagedTestDirectory) Enumerate(winfile.DirectoryEnumerationOptions) (winfile.DirectoryEnumeration, error) {
	return cloneEnumeration(directory.enumeration), nil
}
func (*stagedTestDirectory) VerifyUnchanged() error { return nil }
func (directory *stagedTestDirectory) ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error) {
	return directory.evidence.Security, nil
}
func (*stagedTestDirectory) ReinspectDataStreams() ([]winfile.DataStream, error) { return nil, nil }
func (*stagedTestDirectory) ReinspectCaseSensitivity() (bool, error)             { return false, nil }
func (*stagedTestDirectory) Close() error                                        { return nil }

type stagedTestFile struct {
	evidence winfile.Evidence
	data     []byte
}

func (file *stagedTestFile) Evidence() winfile.Evidence { return file.evidence }
func (file *stagedTestFile) ReadAll(uint64) ([]byte, error) {
	return append([]byte(nil), file.data...), nil
}
func (file *stagedTestFile) ReadAt(buffer []byte, offset int64) (int, error) {
	if offset < 0 || offset >= int64(len(file.data)) {
		return 0, errors.New("invalid offset")
	}
	return copy(buffer, file.data[offset:]), nil
}
func (file *stagedTestFile) HashSHA256(options winfile.HashOptions) (winfile.HashResult, error) {
	if options.ExpectedSize != uint64(len(file.data)) {
		return winfile.HashResult{}, winfile.ErrSizeMismatch
	}
	prefix := file.data
	if uint32(len(prefix)) > options.PrefixBytes {
		prefix = prefix[:options.PrefixBytes]
	}
	return winfile.HashResult{
		SHA256: sha256.Sum256(file.data), Size: uint64(len(file.data)), Prefix: append([]byte(nil), prefix...),
	}, nil
}
func (*stagedTestFile) VerifyAuthenticode(authenticode.Verifier) (authenticode.Evidence, error) {
	return authenticode.Evidence{}, errors.New("unexpected Authenticode verification")
}
func (*stagedTestFile) VerifyUnchanged() error { return nil }
func (file *stagedTestFile) ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error) {
	return file.evidence.Security, nil
}
func (*stagedTestFile) ReinspectDataStreams() ([]winfile.DataStream, error) {
	return []winfile.DataStream{{Name: "::$DATA"}}, nil
}
func (*stagedTestFile) Close() error { return nil }
