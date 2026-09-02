//go:build !windows

package nodeenrollment

// readRecordEvidenceState fails closed because trusted enrollment records are Windows-only inputs.
func readRecordEvidenceState() (*recordEvidenceState, error) {
	return nil, ErrUnsupported
}
