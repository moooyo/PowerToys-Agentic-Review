//go:build !windows

package servicebootstrap

import "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"

// Prepare fails closed outside Windows.
func Prepare(role config.Role) error {
	if _, err := resolveRole(role); err != nil {
		return err
	}
	return ErrUnsupportedPlatform
}
