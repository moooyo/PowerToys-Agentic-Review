package workerpackage

import "errors"

const (
	MaximumManifestBytes  = 1 * 1024 * 1024
	MaximumFiles          = 4_096
	MaximumPathBytes      = 4_096
	MaximumFileBytes      = uint64(8 * 1024 * 1024 * 1024)
	MaximumReleaseIDBytes = 128
)

var (
	ErrManifest  = errors.New("invalid worker package manifest")
	ErrCanonical = errors.New("worker package manifest is not canonical")
	ErrSignature = errors.New("worker package signature is invalid")
	ErrFiles     = errors.New("worker package files do not match manifest")
	ErrLimit     = errors.New("worker package limit exceeded")
)

type Architecture string

const (
	ArchitectureAMD64 Architecture = "amd64"
	ArchitectureARM64 Architecture = "arm64"
)

type File struct {
	RelativePath string `json:"relativePath"`
	Size         uint64 `json:"size"`
	SHA256       string `json:"sha256"`
}

type Manifest struct {
	ReleaseID    string       `json:"releaseId"`
	Architecture Architecture `json:"architecture"`
	Files        []File       `json:"files"`
}

type Error struct {
	Kind    error
	Path    string
	Message string
	Cause   error
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if e.Path == "" {
		return e.Message
	}
	return e.Message + ": " + e.Path
}

func (e *Error) Unwrap() error { return e.Cause }

func (e *Error) Is(target error) bool {
	if e == nil {
		return false
	}
	return e.Kind == target
}

func newError(kind error, path, message string, cause error) error {
	return &Error{Kind: kind, Path: path, Message: message, Cause: cause}
}
