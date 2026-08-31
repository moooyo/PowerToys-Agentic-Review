//go:build !windows

package authenticode

type subjectState struct{}

// NewWindowsVerifier fails closed outside Windows.
func NewWindowsVerifier() (Verifier, error) {
	return nil, ErrUnsupportedPlatform
}
