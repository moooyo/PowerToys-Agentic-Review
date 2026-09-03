package installerdestination

import (
	"errors"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

func TestCleanupOperationLinearizesDestinationEvidenceCommit(t *testing.T) {
	original := processCleanup
	t.Cleanup(func() { processCleanup = original })
	processCleanup = &cleanupState{
		platformStatus: func() error { return nil },
		platformCommit: func(commit func()) error { commit(); return nil },
	}
	operation, err := beginCleanupOperation()
	if err != nil {
		t.Fatal(err)
	}
	processCleanup.mu.Lock()
	processCleanup.fatal = true
	processCleanup.epoch++
	processCleanup.mu.Unlock()
	committed := false
	if err := operation.commit(func() { committed = true }); !errors.Is(err, ErrCleanupFatal) || committed {
		t.Fatalf("commit returned %v committed=%t", err, committed)
	}

	processCleanup = &cleanupState{
		platformStatus: func() error { return nil },
		platformCommit: func(func()) error { return winfile.ErrCleanupFatal },
	}
	operation, err = beginCleanupOperation()
	if err != nil {
		t.Fatal(err)
	}
	committed = false
	if err := operation.commit(func() { committed = true }); !errors.Is(err, ErrCleanupFatal) || committed {
		t.Fatalf("platform commit returned %v committed=%t", err, committed)
	}
}
