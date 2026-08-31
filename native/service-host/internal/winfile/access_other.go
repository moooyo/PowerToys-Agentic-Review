//go:build !windows

package winfile

type stableAccessTokenState struct{}

// Duplicate fails closed outside Windows.
func (*StableAccessToken) Duplicate() (*StableAccessToken, error) {
	return nil, ErrUnsupportedPlatform
}

// CheckAccess fails closed outside Windows.
func (*StableAccessToken) CheckAccess(
	SecurityDescriptorEvidence,
	AccessMask,
	GenericMapping,
) (AccessCheckDecision, error) {
	return AccessCheckDecision{}, ErrUnsupportedPlatform
}

// Close reports that no Windows token handle exists.
func (*StableAccessToken) Close() error {
	return ErrUnsupportedPlatform
}
