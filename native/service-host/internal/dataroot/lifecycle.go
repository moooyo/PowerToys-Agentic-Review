package dataroot

import (
	"context"
	"errors"
)

// VerifyUnchanged rechecks every retained object from leaves to the volume
// root. A failure permanently invalidates all public evidence accessors.
func (e Evidence) VerifyUnchanged(ctx context.Context) error {
	if e.state == nil {
		return ErrClosed
	}
	e.state.mu.Lock()
	defer e.state.mu.Unlock()
	if err := e.state.validateLocked(); err != nil {
		return err
	}
	if ctx == nil {
		e.state.invalidateLocked()
		return verificationError(ErrorInput, "reinspection context is required", ErrInvalidInput)
	}
	if cause := context.Cause(ctx); cause != nil {
		e.state.invalidateLocked()
		return cause
	}
	if err := e.state.resources.recheck(); err != nil {
		e.state.invalidateLocked()
		return verificationError(ErrorChanged, "retained data-root evidence changed", errors.Join(ErrChanged, err))
	}
	if cause := context.Cause(ctx); cause != nil {
		e.state.invalidateLocked()
		return cause
	}
	return nil
}

// Close performs one final pre-launch reinspection, invalidates detached
// accessors, and releases handles from leaves to the volume root. It must
// complete before Node starts. Native close failures retain only the failed
// handles so a later Close call can retry them.
func (e Evidence) Close() error {
	if e.state == nil {
		return nil
	}
	e.state.mu.Lock()
	defer e.state.mu.Unlock()
	if len(e.state.resources.values) == 0 {
		e.state.invalidateLocked()
		return nil
	}
	var result error
	if e.state.valid {
		if err := e.state.resources.recheck(); err != nil {
			result = errors.Join(result, verificationError(ErrorChanged, "final data-root reinspection failed", errors.Join(ErrChanged, err)))
		}
	}
	e.state.invalidateLocked()
	if err := e.state.resources.close(1); err != nil {
		result = errors.Join(result, verificationError(ErrorCleanup, "close retained data-root handles", errors.Join(ErrCleanup, err)))
	}
	return result
}
