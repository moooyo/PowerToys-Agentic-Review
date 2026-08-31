//go:build !windows

package winfile

import "github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"

// VerifyAuthenticode fails closed outside Windows.
func (*File) VerifyAuthenticode(authenticode.Verifier) (authenticode.Evidence, error) {
	return authenticode.Evidence{}, ErrUnsupportedPlatform
}
