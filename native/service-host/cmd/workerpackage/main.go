package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	buildworkerpackage "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/workerpackage"
)

type options struct {
	rootPath       string
	releaseID      string
	architecture   string
	privateKeyPath string
	manifestPath   string
	signaturePath  string
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "workerpackage: %v\n", err)
		os.Exit(1)
	}
}

func run(arguments []string) error {
	flags := flag.NewFlagSet("workerpackage", flag.ContinueOnError)
	flags.SetOutput(io.Discard)

	var value options
	flags.StringVar(&value.rootPath, "root", "", "payload root directory")
	flags.StringVar(&value.releaseID, "release-id", "", "release identifier")
	flags.StringVar(&value.architecture, "architecture", "", "target architecture: amd64 or arm64")
	flags.StringVar(&value.privateKeyPath, "private-key", "", "Ed25519 private key file (raw 64 bytes or PKCS8)")
	flags.StringVar(&value.manifestPath, "manifest", "", "manifest output path")
	flags.StringVar(&value.signaturePath, "signature", "", "signature output path")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 || value.rootPath == "" || value.releaseID == "" || value.architecture == "" ||
		value.privateKeyPath == "" || value.manifestPath == "" || value.signaturePath == "" {
		return errors.New("-root, -release-id, -architecture, -private-key, -manifest, and -signature are required; positional arguments are not accepted")
	}

	rootPath, err := filepath.Abs(value.rootPath)
	if err != nil {
		return fmt.Errorf("resolve root path: %w", err)
	}
	manifestPath, err := filepath.Abs(value.manifestPath)
	if err != nil {
		return fmt.Errorf("resolve manifest output path: %w", err)
	}
	signaturePath, err := filepath.Abs(value.signaturePath)
	if err != nil {
		return fmt.Errorf("resolve signature output path: %w", err)
	}
	privateKeyPath, err := filepath.Abs(value.privateKeyPath)
	if err != nil {
		return fmt.Errorf("resolve private key path: %w", err)
	}

	if pathsEqual(manifestPath, signaturePath) {
		return errors.New("manifest and signature outputs must be different files")
	}

	architecture, err := parseArchitecture(value.architecture)
	if err != nil {
		return err
	}

	privateKeyDocument, err := readRegularFile(privateKeyPath)
	if err != nil {
		return fmt.Errorf("read private key file: %w", err)
	}
	privateKey, err := parsePrivateKey(privateKeyDocument)
	if err != nil {
		return err
	}

	manifest, err := buildManifest(rootPath, value.releaseID, architecture, manifestPath, signaturePath)
	if err != nil {
		return err
	}
	canonicalManifest, err := buildworkerpackage.MarshalManifestCanonical(manifest)
	if err != nil {
		return err
	}

	signature := ed25519.Sign(privateKey, canonicalManifest)

	if err := writeAtomic(manifestPath, canonicalManifest, 0o644); err != nil {
		return fmt.Errorf("write manifest output: %w", err)
	}
	if err := writeAtomic(signaturePath, signature, 0o600); err != nil {
		return fmt.Errorf("write signature output: %w", err)
	}

	return nil
}

func parseArchitecture(value string) (buildworkerpackage.Architecture, error) {
	switch value {
	case string(buildworkerpackage.ArchitectureAMD64):
		return buildworkerpackage.ArchitectureAMD64, nil
	case string(buildworkerpackage.ArchitectureARM64):
		return buildworkerpackage.ArchitectureARM64, nil
	default:
		return "", errors.New("architecture must be amd64 or arm64")
	}
}

func parsePrivateKey(document []byte) (ed25519.PrivateKey, error) {
	if len(document) == ed25519.PrivateKeySize {
		return ed25519.PrivateKey(append([]byte(nil), document...)), nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(document)
	if err != nil {
		return nil, errors.New("private key must be either a raw 64-byte Ed25519 key or a PKCS8 Ed25519 private key")
	}
	privateKey, ok := parsed.(ed25519.PrivateKey)
	if !ok || len(privateKey) != ed25519.PrivateKeySize {
		return nil, errors.New("private key must be either a raw 64-byte Ed25519 key or a PKCS8 Ed25519 private key")
	}
	return append(ed25519.PrivateKey(nil), privateKey...), nil
}

func buildManifest(
	rootPath string,
	releaseID string,
	architecture buildworkerpackage.Architecture,
	manifestPath string,
	signaturePath string,
) (buildworkerpackage.Manifest, error) {
	rootInfo, err := os.Lstat(rootPath)
	if err != nil {
		return buildworkerpackage.Manifest{}, fmt.Errorf("inspect root directory: %w", err)
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 || hasReparsePoint(rootInfo) {
		return buildworkerpackage.Manifest{}, errors.New("root must be a directory without symlink or reparse-point attributes")
	}

	files := make([]buildworkerpackage.File, 0, 64)
	err = filepath.WalkDir(rootPath, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return fmt.Errorf("walk payload: %w", walkErr)
		}
		info, err := entry.Info()
		if err != nil {
			return fmt.Errorf("inspect payload entry %s: %w", path, err)
		}
		if info.Mode()&os.ModeSymlink != 0 || hasReparsePoint(info) {
			return fmt.Errorf("payload contains symlink or reparse point: %s", path)
		}
		if info.IsDir() {
			return nil
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("payload contains a non-regular file: %s", path)
		}

		if pathsEqual(path, manifestPath) || pathsEqual(path, signaturePath) {
			return nil
		}

		relativePath, err := filepath.Rel(rootPath, path)
		if err != nil {
			return fmt.Errorf("resolve relative path: %w", err)
		}
		if pathEscapesRoot(relativePath) {
			return fmt.Errorf("payload path escapes root: %s", path)
		}

		digest, err := hashFileSHA256(path)
		if err != nil {
			return fmt.Errorf("hash payload file %s: %w", path, err)
		}
		files = append(files, buildworkerpackage.File{
			RelativePath: filepath.ToSlash(relativePath),
			Size:         uint64(info.Size()),
			SHA256:       digest,
		})
		return nil
	})
	if err != nil {
		return buildworkerpackage.Manifest{}, err
	}

	return buildworkerpackage.Manifest{
		ReleaseID:    releaseID,
		Architecture: architecture,
		Files:        files,
	}, nil
}

func pathEscapesRoot(relativePath string) bool {
	if relativePath == "" || relativePath == "." {
		return true
	}
	clean := filepath.Clean(relativePath)
	if filepath.IsAbs(clean) {
		return true
	}
	return clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator))
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

func writeAtomic(path string, document []byte, permission os.FileMode) error {
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("create temporary output: %w", err)
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		if !committed {
			_ = temporary.Close()
			_ = os.Remove(temporaryPath)
		}
	}()

	if err := temporary.Chmod(permission); err != nil {
		return fmt.Errorf("set temporary output permissions: %w", err)
	}
	written, err := temporary.Write(document)
	if err != nil {
		return fmt.Errorf("write temporary output: %w", err)
	}
	if written != len(document) {
		return io.ErrShortWrite
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("flush temporary output: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close temporary output: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		if removeErr := os.Remove(path); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			return fmt.Errorf("replace output: %w", err)
		}
		if retryErr := os.Rename(temporaryPath, path); retryErr != nil {
			return fmt.Errorf("replace output: %w", err)
		}
	}
	committed = true
	return nil
}

func readRegularFile(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || hasReparsePoint(info) {
		return nil, errors.New("path must be a regular file without symlink or reparse-point attributes")
	}
	return os.ReadFile(path)
}

func pathsEqual(left, right string) bool {
	return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
}
