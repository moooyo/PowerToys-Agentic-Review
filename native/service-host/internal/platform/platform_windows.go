//go:build windows

package platform

// NewHost remains fail-closed until the reviewed Windows identity, process,
// Job Object, and Named Pipe adapters are implemented.
func NewHost() Host {
	return unavailableHost{err: ErrWindowsAdapterMissing}
}
