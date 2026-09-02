package stagedpackage

import (
	"sync"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

type cleanupState struct {
	mu             sync.Mutex
	epoch          uint64
	fatal          bool
	owners         []*handleOwner
	platformStatus func() error
	platformCommit func(func()) error
}

type cleanupOperation struct {
	state *cleanupState
	epoch uint64
}

var processCleanup = &cleanupState{
	platformStatus: winfile.ProcessCleanupStatus,
	platformCommit: winfile.CommitIfCleanupHealthy,
}

func beginCleanupOperation() (cleanupOperation, error) {
	return processCleanup.begin()
}

func (state *cleanupState) begin() (cleanupOperation, error) {
	if state == nil {
		return cleanupOperation{}, ErrCleanupFatal
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.fatal || state.platformStatus == nil || state.platformStatus() != nil {
		return cleanupOperation{}, ErrCleanupFatal
	}
	return cleanupOperation{state: state, epoch: state.epoch}, nil
}

func (operation cleanupOperation) commit(commit func()) error {
	if operation.state == nil || commit == nil {
		return ErrCleanupFatal
	}
	operation.state.mu.Lock()
	defer operation.state.mu.Unlock()
	if operation.state.fatal || operation.epoch != operation.state.epoch ||
		operation.state.platformCommit == nil {
		return ErrCleanupFatal
	}
	committed := false
	if err := operation.state.platformCommit(func() {
		committed = true
		commit()
	}); err != nil || !committed {
		return ErrCleanupFatal
	}
	return nil
}

func publishCleanupFatal(owner *handleOwner) {
	if owner == nil || processCleanup == nil {
		return
	}
	processCleanup.mu.Lock()
	if !processCleanup.fatal {
		processCleanup.epoch++
		processCleanup.fatal = true
	}
	processCleanup.owners = append(processCleanup.owners, owner)
	processCleanup.mu.Unlock()
}

func cleanupHealthy() bool {
	if processCleanup == nil {
		return false
	}
	processCleanup.mu.Lock()
	defer processCleanup.mu.Unlock()
	return !processCleanup.fatal && processCleanup.platformStatus != nil &&
		processCleanup.platformStatus() == nil
}
