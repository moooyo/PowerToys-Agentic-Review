//go:build windows

package dataroot

import (
	"context"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

// VerifyRuntime derives both configurations and the current role exclusively
// from opaque installation evidence, then verifies only the current role's
// live data root. The peer data root is deliberately never opened.
func VerifyRuntime(
	ctx context.Context,
	installation installverify.Evidence,
) (Evidence, error) {
	snapshot, err := snapshotInstallation(installation)
	if err != nil {
		return Evidence{}, err
	}
	current, peer := snapshot.control, snapshot.executor
	if snapshot.role == config.RoleExecutor {
		current, peer = peer, current
	}
	return verifyWithDependencies(ctx, current, peer, snapshot, dependencies{
		openTraversalRoot: openWindowsTraversalRoot,
	})
}

type windowsDirectory struct {
	value *winfile.Directory
}

func openWindowsTraversalRoot(path string, options winfile.OpenOptions) (directoryHandle, error) {
	value, err := winfile.OpenTraversalRoot(path, options)
	if err != nil {
		return nil, err
	}
	return &windowsDirectory{value: value}, nil
}

func (directory *windowsDirectory) Evidence() winfile.Evidence {
	return directory.value.Evidence()
}

func (directory *windowsDirectory) OpenDirectoryComponent(
	component string,
	options winfile.OpenOptions,
) (directoryHandle, error) {
	value, err := directory.value.OpenDirectoryComponent(component, options)
	if err != nil {
		return nil, err
	}
	return &windowsDirectory{value: value}, nil
}

func (directory *windowsDirectory) OpenFileComponent(
	component string,
	options winfile.OpenOptions,
) (fileHandle, error) {
	value, err := directory.value.OpenFileComponent(component, options)
	if err != nil {
		return nil, err
	}
	return &windowsFile{value: value}, nil
}

func (directory *windowsDirectory) Enumerate(
	options winfile.DirectoryEnumerationOptions,
) (winfile.DirectoryEnumeration, error) {
	return directory.value.Enumerate(options)
}

func (directory *windowsDirectory) VerifyUnchanged() error { return directory.value.VerifyUnchanged() }
func (directory *windowsDirectory) ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error) {
	return directory.value.ReinspectSecurity()
}
func (directory *windowsDirectory) ReinspectDataStreams() ([]winfile.DataStream, error) {
	return directory.value.ReinspectDataStreams()
}
func (directory *windowsDirectory) ReinspectCaseSensitivity() (bool, error) {
	return directory.value.ReinspectCaseSensitivity()
}
func (directory *windowsDirectory) Close() error { return directory.value.Close() }

type windowsFile struct {
	value *winfile.File
}

func (file *windowsFile) Evidence() winfile.Evidence { return file.value.Evidence() }
func (file *windowsFile) VerifyUnchanged() error     { return file.value.VerifyUnchanged() }
func (file *windowsFile) ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error) {
	return file.value.ReinspectSecurity()
}
func (file *windowsFile) ReinspectDataStreams() ([]winfile.DataStream, error) {
	return file.value.ReinspectDataStreams()
}
func (file *windowsFile) Close() error { return file.value.Close() }

var (
	_ directoryHandle = (*windowsDirectory)(nil)
	_ fileHandle      = (*windowsFile)(nil)
)
