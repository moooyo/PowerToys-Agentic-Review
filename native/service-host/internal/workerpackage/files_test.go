package workerpackage

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestVerifyFilesAcceptsMatchingFiles(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "bin", "worker.exe"), []byte("abc"))

	manifest := Manifest{
		ReleaseID:    "R-1",
		Architecture: ArchitectureAMD64,
		Files: []File{{
			RelativePath: "bin/worker.exe",
			Size:         3,
			SHA256:       sha256Hex([]byte("abc")),
		}},
	}

	if err := VerifyFiles(root, manifest); err != nil {
		t.Fatalf("VerifyFiles error = %v", err)
	}
}

func TestVerifyFilesIgnoresUnlistedFiles(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "bin", "worker.exe"), []byte("abc"))
	mustWriteFile(t, filepath.Join(root, "bin", "extra.txt"), []byte("not listed"))

	manifest := Manifest{
		ReleaseID:    "R-1",
		Architecture: ArchitectureARM64,
		Files: []File{{
			RelativePath: "bin/worker.exe",
			Size:         3,
			SHA256:       sha256Hex([]byte("abc")),
		}},
	}

	if err := VerifyFiles(root, manifest); err != nil {
		t.Fatalf("VerifyFiles error = %v", err)
	}
}

func TestVerifyFilesRejectsMissingFile(t *testing.T) {
	root := t.TempDir()
	manifest := Manifest{
		ReleaseID:    "R-1",
		Architecture: ArchitectureAMD64,
		Files: []File{{
			RelativePath: "bin/worker.exe",
			Size:         1,
			SHA256:       strings.Repeat("a", 64),
		}},
	}

	err := VerifyFiles(root, manifest)
	if err == nil || !errors.Is(err, ErrFiles) {
		t.Fatalf("VerifyFiles error = %v, want ErrFiles", err)
	}
}

func TestVerifyFilesRejectsNonRegularPath(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "bin", "worker.exe"), 0o755); err != nil {
		t.Fatal(err)
	}

	manifest := Manifest{
		ReleaseID:    "R-1",
		Architecture: ArchitectureAMD64,
		Files: []File{{
			RelativePath: "bin/worker.exe",
			Size:         0,
			SHA256:       sha256Hex(nil),
		}},
	}

	err := VerifyFiles(root, manifest)
	if err == nil || !errors.Is(err, ErrFiles) {
		t.Fatalf("VerifyFiles error = %v, want ErrFiles", err)
	}
}

func TestVerifyFilesRejectsSymlinkAncestor(t *testing.T) {
	root := t.TempDir()
	external := t.TempDir()
	mustWriteFile(t, filepath.Join(external, "worker.exe"), []byte("abc"))
	if err := os.Symlink(external, filepath.Join(root, "bin")); err != nil {
		t.Skipf("create directory symlink: %v", err)
	}
	manifest := Manifest{
		ReleaseID:    "R-1",
		Architecture: ArchitectureAMD64,
		Files: []File{{
			RelativePath: "bin/worker.exe",
			Size:         3,
			SHA256:       sha256Hex([]byte("abc")),
		}},
	}
	if err := VerifyFiles(root, manifest); err == nil || !errors.Is(err, ErrFiles) {
		t.Fatalf("VerifyFiles symlink ancestor error = %v, want ErrFiles", err)
	}
}

func TestVerifyFilesRejectsSizeMismatch(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "bin", "worker.exe"), []byte("abc"))

	manifest := Manifest{
		ReleaseID:    "R-1",
		Architecture: ArchitectureAMD64,
		Files: []File{{
			RelativePath: "bin/worker.exe",
			Size:         4,
			SHA256:       sha256Hex([]byte("abc")),
		}},
	}

	err := VerifyFiles(root, manifest)
	if err == nil || !errors.Is(err, ErrFiles) {
		t.Fatalf("VerifyFiles error = %v, want ErrFiles", err)
	}
}

func TestVerifyFilesRejectsHashMismatch(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "bin", "worker.exe"), []byte("abc"))

	manifest := Manifest{
		ReleaseID:    "R-1",
		Architecture: ArchitectureAMD64,
		Files: []File{{
			RelativePath: "bin/worker.exe",
			Size:         3,
			SHA256:       strings.Repeat("f", 64),
		}},
	}

	err := VerifyFiles(root, manifest)
	if err == nil || !errors.Is(err, ErrFiles) {
		t.Fatalf("VerifyFiles error = %v, want ErrFiles", err)
	}
}

func mustWriteFile(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%q): %v", path, err)
	}
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}

func sha256Hex(content []byte) string {
	digest := sha256.Sum256(content)
	return fmt.Sprintf("%x", digest)
}
