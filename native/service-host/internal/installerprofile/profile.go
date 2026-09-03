// Package installerprofile defines the immutable split Worker installation profiles selected by
// signed outer packages. Validation is data-only and does not install files or provision secrets.
package installerprofile

import (
	"errors"
	"regexp"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
)

var workerTokenShapePattern = regexp.MustCompile(`arw1_[A-Za-z0-9_-]{43}`)

const (
	// BearerTokenInstallerV2ID is the first installation profile that provisions the Worker API
	// credential independently from the signed package.
	BearerTokenInstallerV2ID = "agentic-review-worker-split-installer-v2"

	InstallationRoot             = `C:\Program Files\AgenticReview\Worker`
	TrustedConfigurationRoot     = `C:\ProgramData\AgenticReview\TrustedConfig`
	MetadataRootParent           = `C:\ProgramData\AgenticReview\Packages`
	ControlDataRoot              = `C:\ProgramData\AgenticReview\Control`
	ExecutorDataRoot             = `C:\ProgramData\AgenticReview\Executor`
	WorkerAuthenticationFileName = "worker-auth-v1.json"
)

var ErrInvalid = errors.New("invalid split Worker installer profile")

// ValidatePackageRoots binds one package ID to the fixed v2 physical package-root selection.
func ValidatePackageRoots(
	profileID string,
	packageID string,
	metadataRoot string,
	installationRoot string,
	trustedConfigurationRoot string,
) error {
	if profileID != BearerTokenInstallerV2ID || !validPackageID(packageID) ||
		metadataRoot != MetadataRootParent+`\`+packageID || installationRoot != InstallationRoot ||
		trustedConfigurationRoot != TrustedConfigurationRoot {
		return ErrInvalid
	}
	return nil
}

// ValidateBearerTokenBootstrapPair binds schema v4 to the fixed role data roots and the ordinary
// local Worker authentication file profile. It never reads or validates the Token itself.
func ValidateBearerTokenBootstrapPair(profileID string, control config.Config, executor config.Config) error {
	if control.Validate() != nil || executor.Validate() != nil ||
		profileID != BearerTokenInstallerV2ID ||
		control.SchemaVersion != config.BearerTokenSchemaVersion ||
		executor.SchemaVersion != config.BearerTokenSchemaVersion ||
		control.Role != config.RoleControl || executor.Role != config.RoleExecutor ||
		control.Control == nil || executor.Executor == nil ||
		control.Node.DataRoot != ControlDataRoot || executor.Node.DataRoot != ExecutorDataRoot ||
		control.Installation.Root != InstallationRoot || executor.Installation.Root != InstallationRoot ||
		control.Installation.TrustedConfigurationRoot != TrustedConfigurationRoot ||
		executor.Installation.TrustedConfigurationRoot != TrustedConfigurationRoot ||
		control.Control.WorkerAuthenticationProfile != config.WorkerAuthenticationProfileBearerTokenV1 ||
		control.Control.ClientCertificateStore != "" || control.Control.ClientCertificateDERSHA256 != "" ||
		control.Control.ClientPrivateKeySecurityDescriptorSHA256 != "" {
		return ErrInvalid
	}
	controlDocument, controlErr := config.MarshalCanonical(control)
	executorDocument, executorErr := config.MarshalCanonical(executor)
	if controlErr != nil || executorErr != nil || workerTokenShapePattern.Match(controlDocument) ||
		workerTokenShapePattern.Match(executorDocument) {
		return ErrInvalid
	}
	return nil
}

func validPackageID(value string) bool {
	if len(value) == 0 || len(value) > 128 ||
		!(value[0] >= 'a' && value[0] <= 'z' || value[0] >= '0' && value[0] <= '9') ||
		strings.HasSuffix(value, ".") || strings.HasSuffix(value, " ") {
		return false
	}
	for _, character := range []byte(value[1:]) {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' ||
			strings.ContainsRune("._+-", rune(character)) {
			continue
		}
		return false
	}
	base := strings.ToUpper(strings.SplitN(value, ".", 2)[0])
	return base != "CON" && base != "PRN" && base != "AUX" && base != "NUL" &&
		base != "CONIN$" && base != "CONOUT$" && base != "CLOCK$" &&
		!(len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) &&
			base[3] >= '1' && base[3] <= '9')
}
