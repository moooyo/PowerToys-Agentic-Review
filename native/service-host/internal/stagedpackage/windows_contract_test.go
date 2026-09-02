//go:build windows

package stagedpackage

import (
	"io"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

func TestWindowsHandleAdaptersRetainReaderAndTraversalContracts(t *testing.T) {
	var _ directoryHandle = (*windowsDirectory)(nil)
	var _ fileHandle = (*windowsFile)(nil)
	var _ io.ReaderAt = (*winfile.File)(nil)
	if processCleanup.platformCommit == nil || processCleanup.platformStatus == nil {
		t.Fatal("production cleanup coordinator omits the winfile quarantine")
	}
}
