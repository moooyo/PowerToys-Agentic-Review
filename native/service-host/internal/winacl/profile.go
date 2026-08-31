package winacl

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

// NewAmbientAncestorProfile creates the semantic policy for an OS-managed
// ancestor above the first product-managed anchor.
func NewAmbientAncestorProfile() PolicyProfile {
	return PolicyProfile{kind: ProfileAmbientAncestor}
}

// NewManagedInstallationDirectoryProfile creates the exact installation
// directory policy. Both services may inspect and traverse the directory.
func NewManagedInstallationDirectoryProfile(controlSID, executorSID string) (PolicyProfile, error) {
	return newManagedProfile(
		ProfileManagedInstallationDirectory,
		controlSID,
		executorSID,
		AccessReadExecute,
		AccessReadExecute,
	)
}

// NewManagedInstallationFileProfile creates an exact installation file policy
// with explicit read or read/execute access for each service SID.
func NewManagedInstallationFileProfile(
	controlSID string,
	executorSID string,
	controlAccess AccessClass,
	executorAccess AccessClass,
) (PolicyProfile, error) {
	return newManagedProfile(
		ProfileManagedInstallationFile,
		controlSID,
		executorSID,
		controlAccess,
		executorAccess,
	)
}

// NewManagedTrustedDirectoryProfile creates the exact trusted-configuration
// directory policy. Both services may inspect and traverse the directory.
func NewManagedTrustedDirectoryProfile(controlSID, executorSID string) (PolicyProfile, error) {
	return newManagedProfile(
		ProfileManagedTrustedDirectory,
		controlSID,
		executorSID,
		AccessReadExecute,
		AccessReadExecute,
	)
}

// NewManagedTrustedFileProfile creates the exact trusted-configuration file
// policy. Both services receive read access and neither receives execute.
func NewManagedTrustedFileProfile(controlSID, executorSID string) (PolicyProfile, error) {
	return newManagedProfile(
		ProfileManagedTrustedFile,
		controlSID,
		executorSID,
		AccessRead,
		AccessRead,
	)
}

func newManagedProfile(
	kind ProfileKind,
	controlSID string,
	executorSID string,
	controlAccess AccessClass,
	executorAccess AccessClass,
) (PolicyProfile, error) {
	if kind < ProfileManagedInstallationDirectory || kind > ProfileManagedTrustedFile {
		return PolicyProfile{}, fmt.Errorf("%w: unsupported managed profile kind %d", ErrInvalidProfile, kind)
	}
	if err := validateServiceSID(controlSID); err != nil {
		return PolicyProfile{}, fmt.Errorf("%w: control SID: %v", ErrInvalidProfile, err)
	}
	if err := validateServiceSID(executorSID); err != nil {
		return PolicyProfile{}, fmt.Errorf("%w: executor SID: %v", ErrInvalidProfile, err)
	}
	if controlSID == executorSID {
		return PolicyProfile{}, fmt.Errorf("%w: control and executor SIDs must differ", ErrInvalidProfile)
	}
	if controlSID == trustedInstallerSID || executorSID == trustedInstallerSID {
		return PolicyProfile{}, fmt.Errorf("%w: TrustedInstaller cannot be a worker service SID", ErrInvalidProfile)
	}
	if !validAccessClass(controlAccess) || !validAccessClass(executorAccess) {
		return PolicyProfile{}, fmt.Errorf("%w: unsupported service access class", ErrInvalidProfile)
	}

	switch kind {
	case ProfileManagedInstallationDirectory, ProfileManagedTrustedDirectory:
		if controlAccess != AccessReadExecute || executorAccess != AccessReadExecute {
			return PolicyProfile{}, fmt.Errorf("%w: directory access classes are fixed", ErrInvalidProfile)
		}
	case ProfileManagedTrustedFile:
		if controlAccess != AccessRead || executorAccess != AccessRead {
			return PolicyProfile{}, fmt.Errorf("%w: trusted file access classes are fixed", ErrInvalidProfile)
		}
	case ProfileManagedInstallationFile:
	}

	return PolicyProfile{
		kind:           kind,
		controlSID:     controlSID,
		executorSID:    executorSID,
		controlAccess:  controlAccess,
		executorAccess: executorAccess,
	}, nil
}

func validateProfile(profile PolicyProfile, kind winfile.ObjectKind) error {
	if profile.kind == ProfileAmbientAncestor {
		if profile != NewAmbientAncestorProfile() || kind != winfile.ObjectKindDirectory {
			return fmt.Errorf("%w: ambient profile is malformed or used for a non-directory", ErrInvalidProfile)
		}
		return nil
	}

	expected, err := newManagedProfile(
		profile.kind,
		profile.controlSID,
		profile.executorSID,
		profile.controlAccess,
		profile.executorAccess,
	)
	if err != nil || expected != profile {
		if err == nil {
			err = errors.New("profile fields do not match a canonical constructor result")
		}
		return fmt.Errorf("%w: %v", ErrInvalidProfile, err)
	}
	if profile.kind == ProfileManagedInstallationDirectory || profile.kind == ProfileManagedTrustedDirectory {
		if kind != winfile.ObjectKindDirectory {
			return fmt.Errorf("%w: directory profile used for a non-directory", ErrInvalidProfile)
		}
		return nil
	}
	if kind != winfile.ObjectKindFile {
		return fmt.Errorf("%w: file profile used for a non-file", ErrInvalidProfile)
	}
	return nil
}

func validAccessClass(value AccessClass) bool {
	return value == AccessNone || value == AccessRead || value == AccessReadExecute
}

func validateServiceSID(value string) error {
	parts := strings.Split(value, "-")
	if len(parts) != 9 || parts[0] != "S" || parts[1] != "1" || parts[2] != "5" || parts[3] != "80" {
		return errors.New("must be a canonical S-1-5-80 service SID")
	}
	for _, part := range parts[4:] {
		parsed, err := strconv.ParseUint(part, 10, 32)
		if err != nil || strconv.FormatUint(parsed, 10) != part {
			return errors.New("must be a canonical S-1-5-80 service SID")
		}
	}
	return nil
}
