//go:build !windows

package winfile

// ProcessCleanupStatus reports no native cleanup state outside Windows.
func ProcessCleanupStatus() error { return nil }

// CommitIfCleanupHealthy commits immediately outside Windows.
func CommitIfCleanupHealthy(commit func()) error {
	if commit == nil {
		return ErrCleanupFatal
	}
	commit()
	return nil
}
