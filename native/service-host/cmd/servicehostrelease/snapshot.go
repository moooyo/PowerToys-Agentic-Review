package main

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile/generator"
)

const (
	maximumSourceArchiveBytes  = 64 * 1024 * 1024
	maximumSourceTreeBytes     = 16 * 1024 * 1024
	maximumSnapshotEntries     = 65_536
	maximumSnapshotDirectories = 16_384
	maximumSnapshotFileBytes   = 16 * 1024 * 1024
	maximumSnapshotTotalBytes  = 256 * 1024 * 1024
	maximumSnapshotPathBytes   = 4_096
	serviceHostArchivePrefix   = "native/service-host"
)

type gitSourceIdentity struct {
	commit string
	tree   string
}

type gitSourceFile struct {
	objectID string
	size     int64
}

func captureGitSourceIdentity(
	ctx context.Context,
	dependencies buildDependencies,
	repositoryPath string,
	toolchain verifiedToolchain,
) (gitSourceIdentity, error) {
	commit, err := runGitObjectQuery(ctx, dependencies, repositoryPath, toolchain, "HEAD^{commit}")
	if err != nil {
		return gitSourceIdentity{}, err
	}
	tree, err := runGitObjectQuery(ctx, dependencies, repositoryPath, toolchain, commit+"^{tree}")
	if err != nil {
		return gitSourceIdentity{}, err
	}
	return gitSourceIdentity{commit: commit, tree: tree}, nil
}

func captureSourceTree(
	ctx context.Context,
	dependencies buildDependencies,
	repositoryPath string,
	toolchain verifiedToolchain,
	identity gitSourceIdentity,
) (map[string]gitSourceFile, error) {
	output, err := dependencies.runCommand(ctx, commandRequest{
		name: toolchain.gitTool.path,
		arguments: gitArguments(
			toolchain,
			"-C", repositoryPath,
			"ls-tree", "-r", "-z", "-l", "--full-tree", identity.tree,
			"--", serviceHostArchivePrefix,
		),
		directory:          repositoryPath,
		environment:        gitEnvironment(toolchain),
		timeout:            gitStageTimeout,
		maximumOutputBytes: maximumSourceTreeBytes,
	})
	if err != nil {
		return nil, fmt.Errorf("inventory fixed ServiceHost tree: %w: %s", err, boundedDiagnostic(output))
	}
	if len(output) == 0 || len(output) > maximumSourceTreeBytes {
		return nil, errors.New("ServiceHost tree inventory size is outside the supported range")
	}
	return parseSourceTree(output)
}

func parseSourceTree(output []byte) (map[string]gitSourceFile, error) {
	files := make(map[string]gitSourceFile)
	caseFolded := make(map[string]string)
	canonicalComponents := make(map[string]string)
	var count uint64
	var total uint64
	for len(output) > 0 {
		terminator := bytes.IndexByte(output, 0)
		if terminator < 0 {
			return nil, errors.New("Git source-tree inventory is not NUL terminated")
		}
		record := output[:terminator]
		output = output[terminator+1:]
		metadata, nameBytes, found := bytes.Cut(record, []byte{'\t'})
		if !found || len(nameBytes) == 0 {
			return nil, errors.New("Git source-tree inventory has an invalid record")
		}
		fields := strings.Fields(string(metadata))
		if len(fields) != 4 || (fields[0] != "100644" && fields[0] != "100755") || fields[1] != "blob" ||
			!validGitObjectID(fields[2]) {
			return nil, errors.New("ServiceHost tree contains a non-regular or invalid Git object")
		}
		size, err := strconv.ParseUint(fields[3], 10, 63)
		if err != nil || size > maximumSnapshotFileBytes {
			return nil, errors.New("ServiceHost tree contains a file outside the supported size range")
		}
		name := string(nameBytes)
		prefix := serviceHostArchivePrefix + "/"
		if !strings.HasPrefix(name, prefix) {
			return nil, fmt.Errorf("Git source-tree path %q is outside %s", name, serviceHostArchivePrefix)
		}
		relative := strings.TrimPrefix(name, prefix)
		if err := validateSnapshotRelativePath(relative); err != nil {
			return nil, fmt.Errorf("Git source-tree path %q: %w", name, err)
		}
		if relative == "internal/releaseprofile/"+generator.GeneratedFileName {
			return nil, errors.New("Git source tree contains the generated release source")
		}
		key := strings.ToLower(relative)
		if previous, exists := caseFolded[key]; exists {
			return nil, fmt.Errorf("Git source-tree paths %q and %q conflict", previous, relative)
		}
		if err := registerCanonicalPathComponents(canonicalComponents, relative); err != nil {
			return nil, err
		}
		caseFolded[key] = relative
		count++
		if count > maximumSnapshotEntries {
			return nil, fmt.Errorf("ServiceHost tree exceeds %d files", maximumSnapshotEntries)
		}
		if size > maximumSnapshotTotalBytes || total > maximumSnapshotTotalBytes-size {
			return nil, errors.New("ServiceHost tree exceeds its aggregate byte limit")
		}
		total += size
		files[relative] = gitSourceFile{objectID: fields[2], size: int64(size)}
	}
	if len(files) == 0 {
		return nil, errors.New("Git source-tree inventory is empty")
	}
	return files, nil
}

func registerCanonicalPathComponents(seen map[string]string, value string) error {
	components := strings.Split(value, "/")
	for index := range components {
		prefix := strings.Join(components[:index+1], "/")
		key := strings.ToLower(prefix)
		if previous, exists := seen[key]; exists && previous != prefix {
			return fmt.Errorf("source paths %q and %q use conflicting component spelling", previous, prefix)
		}
		seen[key] = prefix
	}
	return nil
}

func runGitObjectQuery(
	ctx context.Context,
	dependencies buildDependencies,
	repositoryPath string,
	toolchain verifiedToolchain,
	object string,
) (string, error) {
	output, err := dependencies.runCommand(ctx, commandRequest{
		name:               toolchain.gitTool.path,
		arguments:          gitArguments(toolchain, "-C", repositoryPath, "rev-parse", "--verify", object),
		directory:          repositoryPath,
		environment:        gitEnvironment(toolchain),
		timeout:            gitStageTimeout,
		maximumOutputBytes: maximumCommandOutputBytes,
	})
	if err != nil {
		return "", fmt.Errorf("resolve Git object %s: %w: %s", object, err, boundedDiagnostic(output))
	}
	value := strings.TrimSpace(string(output))
	if !validGitObjectID(value) {
		return "", fmt.Errorf("Git returned an invalid object ID for %s", object)
	}
	return value, nil
}

func captureSourceArchive(
	ctx context.Context,
	dependencies buildDependencies,
	repositoryPath string,
	toolchain verifiedToolchain,
	identity gitSourceIdentity,
) ([]byte, error) {
	output, err := dependencies.runCommand(ctx, commandRequest{
		name: toolchain.gitTool.path,
		arguments: gitArguments(
			toolchain,
			"-C", repositoryPath,
			"archive", "--format=tar", identity.commit, "--", serviceHostModulePath,
		),
		directory:          repositoryPath,
		environment:        gitEnvironment(toolchain),
		timeout:            gitStageTimeout,
		maximumOutputBytes: maximumSourceArchiveBytes,
	})
	if err != nil {
		return nil, fmt.Errorf("archive fixed ServiceHost commit: %w: %s", err, boundedDiagnostic(output))
	}
	if len(output) == 0 || len(output) > maximumSourceArchiveBytes {
		return nil, fmt.Errorf("ServiceHost source archive size is outside the supported range")
	}
	return output, nil
}

func extractSourceSnapshot(
	ctx context.Context,
	archive []byte,
	treeFiles map[string]gitSourceFile,
	temporaryDirectory string,
) (string, error) {
	if len(treeFiles) == 0 {
		return "", errors.New("source snapshot requires a non-empty Git tree inventory")
	}
	if len(archive) == 0 || len(archive) > maximumSourceArchiveBytes {
		return "", errors.New("source archive size is outside the supported range")
	}
	root := filepath.Join(temporaryDirectory, "source-snapshot")
	if err := os.Mkdir(root, 0o700); err != nil {
		return "", fmt.Errorf("create source snapshot root: %w", err)
	}
	if err := secureTemporaryDirectory(root); err != nil {
		return "", err
	}
	reader := tar.NewReader(bytes.NewReader(archive))
	seen := make(map[string]string)
	remainingFiles := make(map[string]gitSourceFile, len(treeFiles))
	allowedDirectories := map[string]struct{}{
		"native":                 {},
		serviceHostArchivePrefix: {},
	}
	for relative, file := range treeFiles {
		remainingFiles[relative] = file
		for directory := path.Dir(serviceHostArchivePrefix + "/" + relative); directory != "."; directory = path.Dir(directory) {
			allowedDirectories[directory] = struct{}{}
		}
	}
	directories := []string{root}
	var entryCount uint64
	var directoryCount uint64 = 1
	var totalBytes uint64
	required := map[string]bool{
		"go.mod":                             false,
		"go.sum":                             false,
		"main.go":                            false,
		"release_profile_release.go":         false,
		"internal/releaseprofile/profile.go": false,
		"internal/releaseprofile/compiled_unavailable.go": false,
	}

	for {
		if err := ctx.Err(); err != nil {
			return "", fmt.Errorf("extract source snapshot: %w", err)
		}
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", fmt.Errorf("read ServiceHost source archive: %w", err)
		}
		entryCount++
		if entryCount > maximumSnapshotEntries {
			return "", fmt.Errorf("source snapshot exceeds %d entries", maximumSnapshotEntries)
		}
		if header.Name == "" || strings.HasSuffix(header.Name, "//") {
			return "", errors.New("source archive contains a noncanonical empty or repeated-slash name")
		}
		name := strings.TrimSuffix(header.Name, "/")
		if path.IsAbs(name) || path.Clean(name) != name || strings.ContainsAny(name, "\\:\x00") {
			return "", fmt.Errorf("source archive entry %q has a noncanonical name", header.Name)
		}
		key := strings.ToLower(name)
		if previous, duplicate := seen[key]; duplicate {
			return "", fmt.Errorf("source archive entries %q and %q conflict", previous, name)
		}
		seen[key] = name
		if name == "native" || name == serviceHostArchivePrefix {
			if header.Typeflag != tar.TypeDir || header.Linkname != "" {
				return "", fmt.Errorf("source archive ancestor %q is not a directory", header.Name)
			}
			continue
		}
		prefix := serviceHostArchivePrefix + "/"
		if !strings.HasPrefix(name, prefix) {
			return "", fmt.Errorf("source archive entry %q is outside %s", header.Name, serviceHostArchivePrefix)
		}
		relative := strings.TrimPrefix(name, prefix)
		if err := validateSnapshotRelativePath(relative); err != nil {
			return "", fmt.Errorf("source archive entry %q: %w", header.Name, err)
		}
		destination := filepath.Join(root, filepath.FromSlash(relative))
		if !pathWithin(root, destination) {
			return "", fmt.Errorf("source archive entry %q escapes the snapshot", header.Name)
		}
		if header.Linkname != "" {
			return "", fmt.Errorf("source archive entry %q contains a link target", header.Name)
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if _, allowed := allowedDirectories[name]; !allowed {
				return "", fmt.Errorf("source archive contains unexpected directory %q", header.Name)
			}
			directoryCount++
			if directoryCount > maximumSnapshotDirectories {
				return "", fmt.Errorf("source snapshot exceeds %d directories", maximumSnapshotDirectories)
			}
			if err := requireSnapshotParent(root, destination); err != nil {
				return "", err
			}
			if err := os.Mkdir(destination, 0o700); err != nil {
				return "", fmt.Errorf("create snapshot directory %q: %w", relative, err)
			}
			directories = append(directories, destination)
		case tar.TypeReg, tar.TypeRegA:
			expected, exists := remainingFiles[relative]
			if !exists {
				return "", fmt.Errorf("source archive contains unexpected or repeated file %q", relative)
			}
			if header.Size < 0 || header.Size > maximumSnapshotFileBytes || header.Size != expected.size {
				return "", fmt.Errorf("source archive file %q differs from its Git tree size", relative)
			}
			size := uint64(header.Size)
			if size > maximumSnapshotTotalBytes || totalBytes > maximumSnapshotTotalBytes-size {
				return "", fmt.Errorf("source snapshot exceeds its aggregate byte limit")
			}
			totalBytes += size
			if err := requireSnapshotParent(root, destination); err != nil {
				return "", err
			}
			if err := writeSnapshotFile(ctx, destination, reader, expected); err != nil {
				return "", fmt.Errorf("extract snapshot file %q: %w", relative, err)
			}
			delete(remainingFiles, relative)
			if _, exists := required[relative]; exists {
				required[relative] = true
			}
		default:
			return "", fmt.Errorf("source archive entry %q has unsupported type %d", header.Name, header.Typeflag)
		}
	}
	if len(remainingFiles) != 0 {
		return "", errors.New("source archive omits files present in the fixed Git tree")
	}
	for requiredPath, present := range required {
		if !present {
			return "", fmt.Errorf("source snapshot omits required tracked file %q", requiredPath)
		}
	}
	for index := len(directories) - 1; index >= 0; index-- {
		if err := os.Chmod(directories[index], 0o500); err != nil {
			return "", fmt.Errorf("seal snapshot directory: %w", err)
		}
	}
	if err := verifySourceSnapshot(ctx, root, treeFiles); err != nil {
		return "", err
	}
	return root, nil
}

func writeSnapshotFile(ctx context.Context, path string, reader io.Reader, expected gitSourceFile) (err error) {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	complete := false
	defer func() {
		if !complete {
			_ = file.Close()
			_ = os.Remove(path)
		}
	}()
	objectHash, err := newGitBlobHash(expected.objectID, expected.size)
	if err != nil {
		return err
	}
	written, err := io.CopyN(io.MultiWriter(file, objectHash), contextReader{ctx: ctx, reader: reader}, expected.size)
	if err != nil {
		return fmt.Errorf("write %d archive bytes: wrote %d: %w", expected.size, written, err)
	}
	if written != expected.size {
		return fmt.Errorf("write %d archive bytes: wrote %d", expected.size, written)
	}
	if actual := hex.EncodeToString(objectHash.Sum(nil)); actual != expected.objectID {
		return errors.New("archive file content differs from its fixed Git blob")
	}
	if err := file.Chmod(0o400); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	complete = true
	return nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (reader contextReader) Read(value []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	return reader.reader.Read(value)
}

func verifySourceSnapshot(ctx context.Context, root string, treeFiles map[string]gitSourceFile) error {
	remaining := make(map[string]gitSourceFile, len(treeFiles))
	allowedDirectories := map[string]struct{}{".": {}}
	for relative, file := range treeFiles {
		remaining[relative] = file
		for directory := path.Dir(relative); directory != "."; directory = path.Dir(directory) {
			allowedDirectories[directory] = struct{}{}
		}
	}
	caseFolded := make(map[string]string)
	var entryCount uint64
	err := filepath.WalkDir(root, func(current string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		relative, err := filepath.Rel(root, current)
		if err != nil {
			return err
		}
		if relative != "." {
			relative = filepath.ToSlash(relative)
		}
		entryCount++
		if entryCount > maximumSnapshotEntries+maximumSnapshotDirectories {
			return errors.New("source snapshot exceeds its entry limit during verification")
		}
		key := strings.ToLower(relative)
		if previous, exists := caseFolded[key]; exists {
			return fmt.Errorf("source snapshot paths %q and %q conflict", previous, relative)
		}
		caseFolded[key] = relative
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("source snapshot path %q is a symlink", relative)
		}
		if err := validateSnapshotNodeInfo(info, relative); err != nil {
			return err
		}
		if entry.IsDir() {
			if _, exists := allowedDirectories[relative]; !exists || info.Mode().Perm()&0o222 != 0 {
				return fmt.Errorf("source snapshot directory %q is unexpected or writable", relative)
			}
			return nil
		}
		expected, exists := remaining[relative]
		if !exists || !info.Mode().IsRegular() || info.Size() != expected.size || info.Mode().Perm()&0o222 != 0 {
			return fmt.Errorf("source snapshot file %q differs from its fixed tree metadata", relative)
		}
		if err := verifySnapshotFile(ctx, current, info, expected); err != nil {
			return fmt.Errorf("verify source snapshot file %q: %w", relative, err)
		}
		delete(remaining, relative)
		return nil
	})
	if err != nil {
		return fmt.Errorf("verify source snapshot: %w", err)
	}
	if len(remaining) != 0 {
		return errors.New("source snapshot omits files from its fixed Git tree")
	}
	return nil
}

func rejectAssemblySources(ctx context.Context, treeFiles map[string]gitSourceFile) error {
	for relative := range treeFiles {
		if !strings.EqualFold(path.Ext(relative), ".s") {
			continue
		}
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("inspect assembly source closure: %w", err)
		}
		return fmt.Errorf("assembly source %q is not permitted in the closed source snapshot", relative)
	}
	return nil
}

func verifySnapshotFile(
	ctx context.Context,
	path string,
	pathInfo os.FileInfo,
	expected gitSourceFile,
) (err error) {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer func() {
		err = errors.Join(err, file.Close())
	}()
	openedInfo, err := file.Stat()
	if err != nil || !os.SameFile(pathInfo, openedInfo) || openedInfo.Size() != expected.size {
		return errors.New("source snapshot file identity changed while opening")
	}
	digest, err := newGitBlobHash(expected.objectID, expected.size)
	if err != nil {
		return err
	}
	read, err := io.CopyN(digest, contextReader{
		ctx:    ctx,
		reader: io.NewSectionReader(file, 0, expected.size),
	}, expected.size)
	if err != nil || read != expected.size {
		return fmt.Errorf("hash source snapshot file: read %d of %d bytes: %w", read, expected.size, err)
	}
	if actual := hex.EncodeToString(digest.Sum(nil)); actual != expected.objectID {
		return errors.New("source snapshot file differs from its fixed Git blob")
	}
	currentInfo, err := file.Stat()
	if err != nil || !os.SameFile(pathInfo, currentInfo) || currentInfo.Size() != expected.size {
		return errors.New("source snapshot file identity changed while hashing")
	}
	currentPathInfo, err := os.Lstat(path)
	if err != nil || !os.SameFile(currentInfo, currentPathInfo) {
		return errors.New("source snapshot file path changed while hashing")
	}
	return nil
}

func newGitBlobHash(objectID string, size int64) (hash.Hash, error) {
	var digest hash.Hash
	switch len(objectID) {
	case sha1.Size * 2:
		digest = sha1.New()
	case sha256.Size * 2:
		digest = sha256.New()
	default:
		return nil, errors.New("Git blob object ID uses an unsupported hash length")
	}
	_, _ = fmt.Fprintf(digest, "blob %d\x00", size)
	return digest, nil
}

func requireSnapshotParent(root, destination string) error {
	parent := filepath.Dir(destination)
	info, err := os.Lstat(parent)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !pathWithin(root, parent) {
		return fmt.Errorf("snapshot parent for %q is missing or unsafe", destination)
	}
	return nil
}

func validateSnapshotRelativePath(value string) error {
	if value == "" || len(value) > maximumSnapshotPathBytes || path.IsAbs(value) ||
		path.Clean(value) != value || strings.ContainsAny(value, "\\:\x00") {
		return errors.New("path is not canonical relative archive syntax")
	}
	for _, character := range value {
		if character < 0x20 || character > 0x7e {
			return errors.New("path must use printable ASCII")
		}
	}
	for _, component := range strings.Split(value, "/") {
		if component == "" || component == "." || component == ".." ||
			strings.HasSuffix(component, ".") || strings.HasSuffix(component, " ") ||
			strings.ContainsAny(component, `<>"|?*`) || reservedWindowsSourceName(component) {
			return errors.New("path contains an unsafe Windows component")
		}
	}
	return nil
}

func reservedWindowsSourceName(component string) bool {
	base := strings.ToUpper(strings.SplitN(component, ".", 2)[0])
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
		base == "CONIN$" || base == "CONOUT$" || base == "CLOCK$" {
		return true
	}
	return len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) &&
		base[3] >= '1' && base[3] <= '9'
}

func validGitObjectID(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			if character < 'a' || character > 'f' {
				return false
			}
		}
	}
	return true
}
