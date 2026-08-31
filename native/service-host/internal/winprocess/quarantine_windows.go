//go:build windows

package winprocess

import (
	"errors"
	"fmt"

	"golang.org/x/sys/windows"
)

var windowsProcessLifetimeQuarantine = &processLifetimeQuarantine{
	markFatal: processLaunchCleanupGate.markFatal,
}

type windowsRawHandleOwner struct {
	kind  string
	value windows.Handle
}

// adoptWindowsHandleOutput accepts ownership only after a successful native
// call returns a real handle. A valid-looking output written together with an
// error is untrusted and must remain alive until process exit.
func adoptWindowsHandleOutput(
	label string,
	handle windows.Handle,
	callErr error,
	quarantine *processLifetimeQuarantine,
) (windows.Handle, error) {
	if callErr != nil {
		if handle != 0 && handle != windows.InvalidHandle {
			return 0, errors.Join(
				callErr,
				quarantine.retain(
					&windowsRawHandleOwner{kind: "untrusted " + label + " output", value: handle},
					fmt.Errorf("%s returned a handle together with an error", label),
				),
			)
		}
		return 0, callErr
	}
	if handle == 0 {
		return 0, fmt.Errorf("%s returned a null handle without an error", label)
	}
	if handle == windows.InvalidHandle {
		return 0, quarantine.retain(
			&windowsRawHandleOwner{kind: "invalid " + label + " output", value: handle},
			fmt.Errorf("%s returned INVALID_HANDLE_VALUE without an error", label),
		)
	}
	return handle, nil
}

func consumeWindowsHandle(
	label string,
	handle windows.Handle,
	closeHandle func(windows.Handle) error,
	quarantine *processLifetimeQuarantine,
) error {
	if handle == 0 {
		return nil
	}
	owner := &windowsRawHandleOwner{kind: label, value: handle}
	if handle == windows.InvalidHandle {
		return quarantine.retain(owner, windows.ERROR_INVALID_HANDLE)
	}
	if closeHandle == nil {
		return consumeOwnedResourceOnce(label, owner, nil, quarantine)
	}
	return consumeOwnedResourceOnce(
		label,
		owner,
		func() error { return closeHandle(handle) },
		quarantine,
	)
}
