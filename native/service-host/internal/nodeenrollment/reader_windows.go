//go:build windows

package nodeenrollment

// readRecordEvidenceState remains unavailable until the fixed reader identity, handle-bound
// filesystem reader, and Server binding receipt verifier are implemented and reviewed.
func readRecordEvidenceState() (*recordEvidenceState, error) {
	return nil, ErrUnavailable
}
