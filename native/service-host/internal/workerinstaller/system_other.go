//go:build !windows

package workerinstaller

import "errors"

var ErrUnsupportedPlatform = errors.New("Worker installation requires Windows")

func NewSystem() (System, error) {
	return nil, ErrUnsupportedPlatform
}
