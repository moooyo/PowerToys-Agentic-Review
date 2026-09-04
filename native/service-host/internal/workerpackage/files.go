package workerpackage

import (
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// VerifyFiles checks each file listed in the manifest before any write operation is allowed.
// Files not listed in the manifest are ignored.
func VerifyFiles(root string, manifest Manifest) error {
	normalized, err := normalizeManifest(manifest)
	if err != nil {
		return err
	}

	for _, entry := range normalized.Files {
		relativeOSPath := filepath.FromSlash(entry.RelativePath)
		filePath := filepath.Join(root, relativeOSPath)

		info, err := os.Lstat(filePath)
		if err != nil {
			return newError(ErrFiles, manifestPath(root, entry.RelativePath), "listed file is missing", err)
		}
		if !info.Mode().IsRegular() {
			return newError(ErrFiles, manifestPath(root, entry.RelativePath), "listed path is not a regular file", nil)
		}
		if info.Size() < 0 || uint64(info.Size()) != entry.Size {
			return newError(ErrFiles, manifestPath(root, entry.RelativePath), "file size does not match manifest", nil)
		}
		actualHash, err := hashFileSHA256(filePath)
		if err != nil {
			return newError(ErrFiles, manifestPath(root, entry.RelativePath), "failed to hash listed file", err)
		}
		if actualHash != entry.SHA256 {
			return newError(ErrFiles, manifestPath(root, entry.RelativePath), "file sha256 does not match manifest", nil)
		}
	}

	return nil
}

func hashFileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() {
		_ = file.Close()
	}()

	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", digest.Sum(nil)), nil
}
