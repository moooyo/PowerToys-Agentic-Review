//go:build windows

package secureconfig

import "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"

// Read opens every canonical path component, applies the required security
// policy, performs a stable bounded read, and closes all retained handles.
func Read(path string, options Options) (Result, error) {
	return readWithBackend(path, options, windowsBackend{})
}

type windowsBackend struct{}

func (windowsBackend) OpenRoot(path string, mode winfile.SecurityMode) (directoryHandle, error) {
	return winfile.OpenTraversalRoot(path, winfile.OpenOptions{
		VolumeUse: winfile.VolumeUseReadOnly, SecurityMode: mode,
	})
}

func (windowsBackend) OpenDirectory(
	parent directoryHandle,
	component string,
	mode winfile.SecurityMode,
) (directoryHandle, error) {
	directory, ok := parent.(*winfile.Directory)
	if !ok {
		return nil, ErrInvalidEvidence
	}
	return directory.OpenDirectoryComponent(component, winfile.OpenOptions{
		VolumeUse: winfile.VolumeUseReadOnly, SecurityMode: mode,
	})
}

func (windowsBackend) OpenFile(
	parent directoryHandle,
	component string,
	mode winfile.SecurityMode,
) (fileHandle, error) {
	directory, ok := parent.(*winfile.Directory)
	if !ok {
		return nil, ErrInvalidEvidence
	}
	return directory.OpenFileComponent(component, winfile.OpenOptions{
		VolumeUse: winfile.VolumeUseReadOnly, SecurityMode: mode,
	})
}
