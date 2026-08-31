package dataroot

import (
	"errors"
	"fmt"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winacl"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

type directorySecurityClass uint8

const (
	directorySecurityAmbient directorySecurityClass = iota + 1
	directorySecurityProductAnchor
	directorySecurityRoleDataBoundary
	directorySecurityRoleDataInherited
)

type filesystemSecurityPolicy struct {
	ambient                winacl.PolicyProfile
	productAnchor          winacl.PolicyProfile
	dataBoundaryDirectory  winacl.PolicyProfile
	dataInheritedDirectory winacl.PolicyProfile
	dataInheritedFile      winacl.PolicyProfile
}

func newFilesystemSecurityPolicy(current config.Config) (filesystemSecurityPolicy, error) {
	anchor, err := winacl.NewManagedProductAnchorDirectoryProfile(
		config.ControlServiceSID,
		config.ExecutorServiceSID,
	)
	if err != nil {
		return filesystemSecurityPolicy{}, fmt.Errorf("construct product anchor ACL profile: %w", err)
	}
	boundaryDirectory, err := winacl.NewManagedRoleDataBoundaryDirectoryProfile(current.OwnService.SID, current.PeerService.SID)
	if err != nil {
		return filesystemSecurityPolicy{}, fmt.Errorf("construct role data boundary ACL profile: %w", err)
	}
	inheritedDirectory, err := winacl.NewInheritedRoleDataDirectoryProfile(current.OwnService.SID, current.PeerService.SID)
	if err != nil {
		return filesystemSecurityPolicy{}, fmt.Errorf("construct inherited role data directory ACL profile: %w", err)
	}
	inheritedFile, err := winacl.NewInheritedRoleDataFileProfile(current.OwnService.SID, current.PeerService.SID)
	if err != nil {
		return filesystemSecurityPolicy{}, fmt.Errorf("construct inherited role data file ACL profile: %w", err)
	}
	return filesystemSecurityPolicy{
		ambient:                winacl.NewAmbientAncestorProfile(),
		productAnchor:          anchor,
		dataBoundaryDirectory:  boundaryDirectory,
		dataInheritedDirectory: inheritedDirectory,
		dataInheritedFile:      inheritedFile,
	}, nil
}

func (policy filesystemSecurityPolicy) auditDirectory(evidence winfile.Evidence, class directorySecurityClass) error {
	var profile winacl.PolicyProfile
	expectedMode := winfile.SecurityModeManaged
	switch class {
	case directorySecurityAmbient:
		profile = policy.ambient
		expectedMode = winfile.SecurityModeAmbientAncestor
	case directorySecurityProductAnchor:
		profile = policy.productAnchor
	case directorySecurityRoleDataBoundary:
		profile = policy.dataBoundaryDirectory
	case directorySecurityRoleDataInherited:
		profile = policy.dataInheritedDirectory
		expectedMode = winfile.SecurityModeRoleDataInherited
	default:
		return errors.New("unknown data-root directory security class")
	}
	if evidence.SecurityMode != expectedMode {
		return fmt.Errorf("directory security mode %d does not match class %d", evidence.SecurityMode, class)
	}
	if err := winacl.Audit(evidence.Security, winfile.ObjectKindDirectory, profile); err != nil {
		return errors.Join(ErrACL, err)
	}
	return nil
}

func (policy filesystemSecurityPolicy) auditFile(evidence winfile.Evidence) error {
	if evidence.SecurityMode != winfile.SecurityModeRoleDataInherited {
		return fmt.Errorf("%w: role data file is not in inherited security mode", ErrACL)
	}
	if err := winacl.Audit(evidence.Security, winfile.ObjectKindFile, policy.dataInheritedFile); err != nil {
		return errors.Join(ErrACL, err)
	}
	return nil
}
