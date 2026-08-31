package winfile

import (
	"errors"
	"fmt"
)

var (
	ErrAccessCheck       = errors.New("Windows AccessCheck failed")
	ErrAccessTokenClosed = errors.New("stable access token is closed")
)

const (
	genericReadMask                   AccessMask = 0x80000000
	genericWriteMask                  AccessMask = 0x40000000
	genericExecuteMask                AccessMask = 0x20000000
	genericAllMask                    AccessMask = 0x10000000
	maximumAllowedMask                AccessMask = 0x02000000
	genericRightsMask                            = genericReadMask | genericWriteMask | genericExecuteMask | genericAllMask
	maximumPrivilegeBytes                        = 64 * 1024
	maximumAccessCheckDescriptorBytes            = 1024 * 1024
)

// StableAccessToken owns a duplicated Windows impersonation-token handle. It
// never exposes that handle. Copies of the Go value share one owned handle;
// callers that need independent lifetimes must call Duplicate.
type StableAccessToken struct {
	state *stableAccessTokenState
}

func validateAccessEvaluation(
	security SecurityDescriptorEvidence,
	desiredAccess AccessMask,
	mapping GenericMapping,
) error {
	if desiredAccess == 0 || desiredAccess&maximumAllowedMask != 0 {
		return fmt.Errorf("%w: desired access is invalid", ErrAccessCheck)
	}
	if desiredAccess&genericReadMask != 0 && mapping.Read == 0 ||
		desiredAccess&genericWriteMask != 0 && mapping.Write == 0 ||
		desiredAccess&genericExecuteMask != 0 && mapping.Execute == 0 ||
		desiredAccess&genericAllMask != 0 && mapping.All == 0 {
		return fmt.Errorf("%w: generic access mapping is incomplete", ErrAccessCheck)
	}
	if !security.DACLPresent || security.DACLNull || !security.DACLProtected ||
		len(security.SelfRelativeDescriptor) == 0 || len(security.SelfRelativeDescriptor) > maximumAccessCheckDescriptorBytes {
		return fmt.Errorf("%w: security descriptor evidence is incomplete", ErrAccessCheck)
	}
	return nil
}

func mapRequestedAccess(mask AccessMask, mapping GenericMapping) AccessMask {
	if mask&genericReadMask != 0 {
		mask = mask&^genericReadMask | mapping.Read
	}
	if mask&genericWriteMask != 0 {
		mask = mask&^genericWriteMask | mapping.Write
	}
	if mask&genericExecuteMask != 0 {
		mask = mask&^genericExecuteMask | mapping.Execute
	}
	if mask&genericAllMask != 0 {
		mask = mask&^genericAllMask | mapping.All
	}
	return mask
}
