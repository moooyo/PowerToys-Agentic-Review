//go:build windows

package installerdestination

import (
	"context"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/stagedpackage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

// Verify consumes one live v2 staged-package gate and read-only reverifies all three fixed
// destinations. It performs no filesystem mutation, SCM operation, secret provisioning, service
// start, or readiness check. Ownership transfers when the staged gate begins its one-shot borrow;
// a gate rejected before that point remains the caller's responsibility.
func Verify(ctx context.Context, selection stagedpackage.BearerTokenInstallerV2Package) (Evidence, error) {
	policy, err := newProductionSecurityPolicy()
	if err != nil {
		return Evidence{}, ErrInvalidSource
	}
	return verifyWithDependencies(ctx, dependencies{
		acquireSource:     func() sourceLease { return productionSource(selection) },
		openTraversalRoot: openWindowsTraversalRoot,
		newAuthenticodeVerifier: func() (authenticode.Verifier, error) {
			return authenticode.NewWindowsVerifier()
		},
		checkSecurity:    policy.check,
		admitDestination: productionAdmitDestination,
	})
}

type windowsDirectory struct{ value *winfile.Directory }

func openWindowsTraversalRoot(path string, options winfile.OpenOptions) (directoryHandle, error) {
	value, err := winfile.OpenTraversalRoot(path, options)
	if err != nil {
		return nil, err
	}
	return &windowsDirectory{value: value}, nil
}

func (directory *windowsDirectory) Evidence() winfile.Evidence { return directory.value.Evidence() }
func (directory *windowsDirectory) OpenDirectoryComponent(component string, options winfile.OpenOptions) (directoryHandle, error) {
	value, err := directory.value.OpenDirectoryComponent(component, options)
	if err != nil {
		return nil, err
	}
	return &windowsDirectory{value: value}, nil
}
func (directory *windowsDirectory) OpenFileComponent(component string, options winfile.OpenOptions) (fileHandle, error) {
	value, err := directory.value.OpenFileComponent(component, options)
	if err != nil {
		return nil, err
	}
	return &windowsFile{value: value}, nil
}
func (directory *windowsDirectory) Enumerate(options winfile.DirectoryEnumerationOptions) (winfile.DirectoryEnumeration, error) {
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

type windowsFile struct{ value *winfile.File }

func (file *windowsFile) Evidence() winfile.Evidence             { return file.value.Evidence() }
func (file *windowsFile) ReadAll(maximum uint64) ([]byte, error) { return file.value.ReadAll(maximum) }
func (file *windowsFile) HashSHA256(options winfile.HashOptions) (winfile.HashResult, error) {
	return file.value.HashSHA256(options)
}
func (file *windowsFile) VerifyAuthenticode(verifier authenticode.Verifier) (authenticode.Evidence, error) {
	return file.value.VerifyAuthenticode(verifier)
}
func (file *windowsFile) VerifyUnchanged() error { return file.value.VerifyUnchanged() }
func (file *windowsFile) ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error) {
	return file.value.ReinspectSecurity()
}
func (file *windowsFile) ReinspectDataStreams() ([]winfile.DataStream, error) {
	return file.value.ReinspectDataStreams()
}
func (file *windowsFile) Close() error { return file.value.Close() }
