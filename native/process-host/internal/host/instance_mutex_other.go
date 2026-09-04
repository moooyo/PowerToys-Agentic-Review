//go:build !windows

package host

import "errors"

func AcquireGlobalInstanceMutex(instanceKey string) (func() error, error) {
	if !ValidInstanceKey(instanceKey) {
		return nil, errors.New("instance key must be exactly 64 lowercase hexadecimal characters")
	}
	return func() error { return nil }, nil
}
