//go:build windows

package installverify

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winidentity"
)

// Verify proves the fixed restricted service identity before constructing any
// authorization policy or opening configuration and installation objects.
func Verify(ctx context.Context, options Options) (Evidence, error) {
	return verifyWithDependencies(ctx, options, dependencies{
		identityPreflight: winidentity.Preflight,
		newSecurityPolicy: newProductionFilesystemSecurityPolicy,
		newAuthenticodeVerifier: func() (authenticode.Verifier, error) {
			return authenticode.NewWindowsVerifier()
		},
		managedAnchor:     productionManagedAnchor,
		secureRead:        secureconfig.Read,
		openTraversalRoot: openWindowsTraversalRoot,
	})
}

func productionManagedAnchor(root releasemanifest.FileRoot, path string) (string, error) {
	if root != releasemanifest.RootInstallation && root != releasemanifest.RootTrustedConfiguration {
		return "", fmt.Errorf("unsupported managed root %q", root)
	}
	parsed, err := parseWindowsPath(path, false)
	if err != nil {
		return "", err
	}
	if len(parsed.components) < 2 {
		return "", errors.New("verified root has no non-volume product anchor")
	}
	// The direct parent is the product-managed anchor. Ancestors above it use
	// the ambient profile; the anchor, verified root, and children are exact.
	return parsed.drive + strings.Join(parsed.components[:len(parsed.components)-1], `\`), nil
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
