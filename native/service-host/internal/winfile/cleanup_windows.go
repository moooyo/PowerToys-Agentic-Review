//go:build windows

package winfile

import (
	"errors"
	"fmt"
	"sync"

	"golang.org/x/sys/windows"
)

type discardedHandleOwner struct {
	handle    windows.Handle
	operation string
}

type discardedHandleQuarantine struct {
	mu     sync.RWMutex
	owners []discardedHandleOwner
	fatal  error
}

var processDiscardedHandles discardedHandleQuarantine

func (quarantine *discardedHandleQuarantine) retain(
	handle windows.Handle,
	operation string,
	cause error,
) error {
	result := errors.Join(ErrCleanupFatal, fmt.Errorf("%s: %w", operation, cause))
	if quarantine == nil {
		return result
	}
	quarantine.mu.Lock()
	quarantine.owners = append(quarantine.owners, discardedHandleOwner{
		handle: handle, operation: operation,
	})
	quarantine.fatal = errors.Join(quarantine.fatal, result)
	quarantine.mu.Unlock()
	return result
}

func (quarantine *discardedHandleQuarantine) status() error {
	if quarantine == nil {
		return ErrCleanupFatal
	}
	quarantine.mu.RLock()
	defer quarantine.mu.RUnlock()
	return quarantine.fatal
}

// ProcessCleanupStatus reports whether a rejected native handle remains owned
// by the process-lifetime quarantine. Callers must stop before another launch.
func ProcessCleanupStatus() error { return processDiscardedHandles.status() }

// CommitIfCleanupHealthy runs commit while fatal cleanup publication is read
// locked. A concurrent rejected-handle close linearizes entirely before or
// after the commit.
func CommitIfCleanupHealthy(commit func()) error {
	return processDiscardedHandles.commitIfHealthy(commit)
}

func (quarantine *discardedHandleQuarantine) commitIfHealthy(commit func()) error {
	if commit == nil {
		return ErrCleanupFatal
	}
	if quarantine == nil {
		return ErrCleanupFatal
	}
	quarantine.mu.RLock()
	defer quarantine.mu.RUnlock()
	if quarantine.fatal != nil {
		return quarantine.fatal
	}
	commit()
	return nil
}
