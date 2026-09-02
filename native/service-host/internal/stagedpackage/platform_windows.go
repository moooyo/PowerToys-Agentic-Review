//go:build windows

package stagedpackage

import (
	"context"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/outeradmission"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

// Verify opens one staged package root through retained relative Windows handles and verifies its
// complete signed closure. The returned evidence is observation-only and cannot authorize an
// installation, service operation, Claim, or execution.
func Verify(ctx context.Context, stagedRoot string) (StagedPackageEvidence, error) {
	policy, err := newStagingSecurityPolicy()
	if err != nil {
		return StagedPackageEvidence{}, ErrInvalidInput
	}
	return verifyWithDependencies(ctx, stagedRoot, verifierDependencies{
		openTraversalRoot: openWindowsTraversalRoot,
		newAuthenticodeVerifier: func() (authenticode.Verifier, error) {
			return authenticode.NewWindowsVerifier()
		},
		admit:         productionAdmit,
		checkSecurity: policy.check,
	})
}

func productionAdmit(index, envelope, control, executor []byte) (logicalPlan, error) {
	plan, err := outeradmission.Admit(index, envelope, control, executor)
	if err != nil || plan.Validate() != nil {
		return logicalPlan{}, ErrTrust
	}
	result := logicalPlan{
		index:       plan.Index(),
		control:     plan.ControlConfiguration(),
		executor:    plan.ExecutorConfiguration(),
		signerKeyID: plan.SignerKeyID(),
	}
	if result.signerKeyID == "" {
		return logicalPlan{}, ErrTrust
	}
	return result, nil
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

func (directory *windowsDirectory) Evidence() winfile.Evidence { return directory.value.Evidence() }

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

func (directory *windowsDirectory) VerifyUnchanged() error {
	return directory.value.VerifyUnchanged()
}

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
func (file *windowsFile) ReadAll(maximum uint64) ([]byte, error) {
	return file.value.ReadAll(maximum)
}
func (file *windowsFile) ReadAt(buffer []byte, offset int64) (int, error) {
	return file.value.ReadAt(buffer, offset)
}
func (file *windowsFile) HashSHA256(options winfile.HashOptions) (winfile.HashResult, error) {
	return file.value.HashSHA256(options)
}
func (file *windowsFile) VerifyAuthenticode(
	verifier authenticode.Verifier,
) (authenticode.Evidence, error) {
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

var (
	_ directoryHandle = (*windowsDirectory)(nil)
	_ fileHandle      = (*windowsFile)(nil)
)
