//go:build !windows

package platform

func NewHost() Host {
	return unavailableHost{err: ErrUnsupportedPlatform}
}
