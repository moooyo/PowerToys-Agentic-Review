//go:build !windows

package peerverify

import "errors"

func isNativeHandleOwnershipFatal(err error) bool {
	return errors.Is(err, ErrNativeHandleOwnershipFatal)
}

// verifyPreflightWindows fails closed outside Windows without observing the
// pipe or opening any native resource.
func verifyPreflightWindows(productionOptions) (*Session, error) {
	return nil, ErrUnsupportedPlatform
}
