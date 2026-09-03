package installerdestination

import (
	"errors"
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
	if processCleanup == nil {
		return cleanupOperation{}, ErrCleanupFatal
	}
	if processCleanup.platformStatus == nil || processCleanup.platformStatus() != nil {
		return cleanupOperation{}, ErrCleanupFatal
	}
	processCleanup.mu.Lock()
	defer processCleanup.mu.Unlock()
	if processCleanup.fatal {
		return cleanupOperation{}, ErrCleanupFatal
	}
	return cleanupOperation{state: processCleanup, epoch: processCleanup.epoch}, nil
}

func (operation cleanupOperation) commit(commit func()) error {
	if operation.state == nil || commit == nil {
		return ErrCleanupFatal
	}
	operation.state.mu.Lock()
	if operation.state.fatal || operation.epoch != operation.state.epoch || operation.state.platformCommit == nil {
		operation.state.mu.Unlock()
		return ErrCleanupFatal
	}
	platformCommit := operation.state.platformCommit
	operation.state.mu.Unlock()
	committed := false
	if err := platformCommit(func() {
		operation.state.mu.Lock()
		defer operation.state.mu.Unlock()
		if operation.state.fatal || operation.epoch != operation.state.epoch {
			return
		}
		commit()
		committed = true
	}); err != nil || !committed {
		return ErrCleanupFatal
	}
	return nil
}

// commitWithinPlatformFence is used only while a transferred staged lease already holds the
// shared winfile cleanup fence. It still linearizes the destination-local fatal epoch.
func (operation cleanupOperation) commitWithinPlatformFence(commit func()) error {
	if operation.state == nil || commit == nil {
		return ErrCleanupFatal
	}
	operation.state.mu.Lock()
	defer operation.state.mu.Unlock()
	if operation.state.fatal || operation.epoch != operation.state.epoch {
		return ErrCleanupFatal
	}
	commit()
	return nil
}

func cleanupHealthy() bool {
	if processCleanup == nil {
		return false
	}
	if processCleanup.platformStatus == nil || processCleanup.platformStatus() != nil {
		return false
	}
	processCleanup.mu.Lock()
	defer processCleanup.mu.Unlock()
	return !processCleanup.fatal
}

func publishCleanupFatal(owner *handleOwner) {
	if processCleanup == nil {
		return
	}
	processCleanup.mu.Lock()
	defer processCleanup.mu.Unlock()
	if !processCleanup.fatal {
		processCleanup.epoch++
		processCleanup.fatal = true
	}
	if owner != nil {
		processCleanup.owners = append(processCleanup.owners, owner)
	}
}

func cleanupError(err error) error {
	err = translateStagedError(err)
	if err == nil {
		return nil
	}
	if errors.Is(err, winfile.ErrCleanupFatal) || errors.Is(err, ErrCleanupFatal) {
		return errors.Join(ErrCleanupFatal, err)
	}
	return errors.Join(ErrCleanup, err)
}
