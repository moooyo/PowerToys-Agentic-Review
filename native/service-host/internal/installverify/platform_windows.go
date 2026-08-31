//go:build windows

package installverify

import (
	"context"
	"errors"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

type productionSecurityPolicies struct {
	installation         secureconfig.SecurityPolicy
	trustedConfiguration secureconfig.SecurityPolicy
	installationAnchor   string
	trustedAnchor        string
	owned                []interface{ Close() error }
}

func (policies *productionSecurityPolicies) Close() error {
	if policies == nil {
		return nil
	}
	var result error
	for index := len(policies.owned) - 1; index >= 0; index-- {
		result = errors.Join(result, policies.owned[index].Close())
	}
	policies.owned = nil
	return result
}

// Verify performs production installation verification. It deliberately fails
// before filesystem access until the production filesystem policy factory can
// validate complete DACL semantics from fixed identities and managed anchors.
func Verify(ctx context.Context, options Options) (result Evidence, err error) {
	if ctx == nil {
		return Evidence{}, verificationError(ErrorInput, "verification context is required", ErrInvalidOptions)
	}
	options, err = normalizeOptions(options)
	if err != nil {
		return Evidence{}, err
	}
	if cause := context.Cause(ctx); cause != nil {
		return Evidence{}, cause
	}
	policies, observedRole, err := newProductionSecurityPolicies()
	if err != nil {
		return Evidence{}, err
	}
	if observedRole != options.Role {
		closeErr := policies.Close()
		return Evidence{}, verificationError(
			ErrorInput,
			"selected role does not match the current restricted service token",
			errors.Join(ErrInvalidOptions, closeErr),
		)
	}
	defer func() {
		if closeErr := policies.Close(); closeErr != nil {
			result = Evidence{}
			err = errors.Join(err, verificationError(
				ErrorCleanup,
				"close production installation security policies",
				errors.Join(ErrCleanup, closeErr),
			))
		}
	}()

	signatureVerifier, err := authenticode.NewWindowsVerifier()
	if err != nil {
		return Evidence{}, verificationError(
			ErrorSignature,
			"construct production Authenticode verifier",
			errors.Join(ErrAuthenticode, err),
		)
	}
	return verifyWithDependencies(ctx, options, dependencies{
		secureRead:                 secureconfig.Read,
		openTraversalRoot:          openWindowsTraversalRoot,
		installationPolicy:         policies.installation,
		trustedConfigurationPolicy: policies.trustedConfiguration,
		installationManagedAnchor:  policies.installationAnchor,
		trustedManagedAnchor:       policies.trustedAnchor,
		authenticodeVerifier:       signatureVerifier,
	})
}

func newProductionSecurityPolicies() (*productionSecurityPolicies, config.Role, error) {
	return nil, "", verificationError(
		ErrorInput,
		"production installation DACL policy construction is not implemented",
		ErrProductionPolicyUnavailable,
	)
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
