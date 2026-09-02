package stagedpackage

import (
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winacl"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

type stagingSecurityPolicy struct {
	ambient   winacl.PolicyProfile
	directory winacl.PolicyProfile
	file      winacl.PolicyProfile
}

func newStagingSecurityPolicy() (*stagingSecurityPolicy, error) {
	directory, err := winacl.NewManagedTrustedDirectoryProfile(
		config.ControlServiceSID,
		config.ExecutorServiceSID,
	)
	if err != nil {
		return nil, err
	}
	file, err := winacl.NewManagedTrustedFileProfile(
		config.ControlServiceSID,
		config.ExecutorServiceSID,
	)
	if err != nil {
		return nil, err
	}
	return &stagingSecurityPolicy{
		ambient: winacl.NewAmbientAncestorProfile(), directory: directory, file: file,
	}, nil
}

func (policy *stagingSecurityPolicy) check(
	evidence winfile.Evidence,
	kind winfile.ObjectKind,
	managed bool,
) error {
	if policy == nil {
		return ErrInvalidInput
	}
	profile := policy.ambient
	if managed {
		if kind == winfile.ObjectKindDirectory {
			profile = policy.directory
		} else {
			profile = policy.file
		}
	}
	return winacl.Audit(evidence.Security, kind, profile)
}
