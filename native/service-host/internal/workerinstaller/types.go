package workerinstaller

import (
	"errors"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/workerpackage"
)

var (
	ErrArchitectureMismatch = errors.New("worker package architecture does not match current architecture")
	ErrMissingRequiredFiles = errors.New("worker package is missing required files")
)

// Inputs defines the full clean-install input set.
type Inputs struct {
	SourceRoot          string
	ManifestBytes       []byte
	RawSignature        []byte
	ReleasePublicKey    []byte
	ServerOrigin        string
	WorkerNodeID        string
	Token               string
	CurrentArchitecture workerpackage.Architecture
}

// InstallFile maps one verified manifest entry into one destination path.
type InstallFile struct {
	SourcePath      string
	DestinationPath string
}

// LocalConfig contains the fixed local configuration documents written after payload files.
type LocalConfig struct {
	ControlPath         string
	ControlDocument     []byte
	ExecutorPath        string
	ExecutorDocument    []byte
	WorkerAuthPath      string
	WorkerAuthDocument  []byte
}

// System provides semantic install-side effects.
type System interface {
	EnsureClean() error
	InstallFiles(files []InstallFile) error
	WriteLocalConfig(value LocalConfig) error
	CreateServicesDisabled() error
	EnableServicesManual() error
	StartExecutor() error
	StartControl() error
	SetServicesAutomatic() error
	StopAndDisable() error
}

