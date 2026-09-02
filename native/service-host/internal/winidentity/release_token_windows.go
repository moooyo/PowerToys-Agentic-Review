//go:build windows

package winidentity

import (
	"errors"
	"fmt"

	"golang.org/x/sys/windows"
)

// VerifyReleaseProcessToken snapshots and validates one caller-owned primary token for use by a
// release evidence reader. The caller must retain and close the token handle.
func VerifyReleaseProcessToken(token windows.Token) error {
	if token == 0 {
		return fmt.Errorf("%w: release process token handle is absent", ErrUnsafeToken)
	}
	if err := lookupPrivilegeNameW.Find(); err != nil {
		return fmt.Errorf("resolve LookupPrivilegeNameW: %w", err)
	}
	evidence, err := inspectToken(token)
	if err != nil {
		return err
	}
	if err := validateReleaseProcessTokenEvidence(evidence); err != nil {
		return errors.Join(ErrUnsafeToken, err)
	}
	return nil
}
