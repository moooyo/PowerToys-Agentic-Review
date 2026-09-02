//go:build !windows

package releasepackage

// LoadReviewedClosure fails closed outside Windows because the trusted approval path cannot be
// proven with retained Windows component handles and ACL evidence.
func LoadReviewedClosure(string, string) (ReviewedClosureEvidence, error) {
	return ReviewedClosureEvidence{}, ErrUnsupportedPlatform
}

// LoadServiceHostBuildReceipt fails closed outside Windows.
func LoadServiceHostBuildReceipt(string, string) (ServiceHostBuildEvidence, error) {
	return ServiceHostBuildEvidence{}, ErrUnsupportedPlatform
}

// VerifyServiceHost fails closed outside Windows.
func VerifyServiceHost(
	PreparedRelease,
	ServiceHostBuildEvidence,
	string,
) (VerifiedServiceHostEvidence, error) {
	return VerifiedServiceHostEvidence{}, ErrUnsupportedPlatform
}
