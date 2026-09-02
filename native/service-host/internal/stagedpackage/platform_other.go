//go:build !windows

package stagedpackage

import "context"

// Verify fails closed outside Windows because retained component-relative handles and
// Authenticode verification are required.
func Verify(context.Context, string) (StagedPackageEvidence, error) {
	return StagedPackageEvidence{}, ErrUnsupportedPlatform
}
