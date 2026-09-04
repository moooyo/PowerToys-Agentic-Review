//go:build windows

package host

import (
	"errors"
	"fmt"
	"sync"

	"golang.org/x/sys/windows"
)

const globalInstanceMutexPrefix = `Global\AgenticReview.Worker.`

func AcquireGlobalInstanceMutex(instanceKey string) (func() error, error) {
	if !ValidInstanceKey(instanceKey) {
		return nil, errors.New("instance key must be exactly 64 lowercase hexadecimal characters")
	}

	name, err := windows.UTF16PtrFromString(globalInstanceMutexPrefix + instanceKey)
	if err != nil {
		return nil, fmt.Errorf("encode global mutex name: %w", err)
	}
	handle, err := windows.CreateMutex(nil, false, name)
	if err != nil {
		if handle != 0 {
			_ = windows.CloseHandle(handle)
		}
		if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
			return nil, ErrInstanceMutexAlreadyHeld
		}
		return nil, fmt.Errorf("CreateMutexW failed: %w", err)
	}
	if handle == 0 {
		return nil, errors.New("CreateMutexW returned a null mutex handle")
	}

	var closeOnce sync.Once
	var closeErr error
	return func() error {
		closeOnce.Do(func() {
			closeErr = windows.CloseHandle(handle)
		})
		return closeErr
	}, nil
}
