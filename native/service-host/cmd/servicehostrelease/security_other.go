//go:build unix

package main

import (
	"fmt"
	"os"
	"syscall"
)

func secureTemporaryDirectory(path string) error {
	if err := os.Chmod(path, 0o700); err != nil {
		return fmt.Errorf("protect secure build directory: %w", err)
	}
	return validatePrivateDirectory(path, "secure build directory")
}

func validatePublishDirectory(path string) error {
	return validatePrivateDirectory(path, "release output directory")
}

func validateReadOnlyModuleCache(path string) error {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("read-only Go module cache must be a physical directory: %w", err)
	}
	if info.Mode().Perm()&0o222 != 0 {
		return fmt.Errorf("Go module cache must be read-only")
	}
	if err := validateCurrentOwner(info, "read-only Go module cache"); err != nil {
		return err
	}
	return nil
}

func validatePrivateDirectory(path, label string) error {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s must be a physical directory: %w", label, err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("%s grants group or other access", label)
	}
	if err := validateCurrentOwner(info, label); err != nil {
		return err
	}
	return nil
}

func validateAnchoredDirectoryInfo(info os.FileInfo, label string) error {
	if info == nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s is not a physical directory", label)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("%s grants group or other access", label)
	}
	return validateCurrentOwner(info, label)
}

func validateSnapshotNodeInfo(info os.FileInfo, label string) error {
	if info == nil {
		return fmt.Errorf("source snapshot path %q has no file metadata", label)
	}
	return validateCurrentOwner(info, "source snapshot path "+label)
}

func validateCurrentOwner(info os.FileInfo, label string) error {
	effectiveUID := os.Geteuid()
	stat, ok := info.Sys().(*syscall.Stat_t)
	if effectiveUID < 0 || !ok || stat == nil {
		return fmt.Errorf("%s ownership cannot be verified", label)
	}
	if uint64(stat.Uid) != uint64(effectiveUID) {
		return fmt.Errorf("%s is not owned by the effective release-builder UID", label)
	}
	return nil
}
