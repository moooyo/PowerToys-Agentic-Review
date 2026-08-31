//go:build windows

package authenticode

import (
	"fmt"
	"sync"

	"golang.org/x/sys/windows"
)

type subjectState struct {
	mu       sync.Mutex
	handle   windows.Handle
	active   bool
	consumed bool
}

// WithBorrowedFileHandle creates an opaque Subject for one synchronous
// callback. It does not take ownership of handle. The caller must keep the
// handle open and prevent concurrent file operations until use returns.
func WithBorrowedFileHandle(
	handle windows.Handle,
	use func(Subject) (Evidence, error),
) (Evidence, error) {
	if handle == 0 || handle == windows.InvalidHandle {
		return Evidence{}, fmt.Errorf("%w: native file handle is invalid", ErrInvalidSubject)
	}
	if use == nil {
		return Evidence{}, fmt.Errorf("%w: subject callback is nil", ErrInvalidSubject)
	}
	state := &subjectState{handle: handle, active: true}
	defer state.invalidate()
	return use(Subject{state: state})
}

func (subject Subject) borrowHandle() (windows.Handle, func(), error) {
	if subject.state == nil {
		return 0, nil, ErrInvalidSubject
	}
	state := subject.state
	state.mu.Lock()
	if !state.active || state.handle == 0 || state.handle == windows.InvalidHandle {
		state.mu.Unlock()
		return 0, nil, ErrInvalidSubject
	}
	if state.consumed {
		state.mu.Unlock()
		return 0, nil, ErrSubjectConsumed
	}
	state.consumed = true
	return state.handle, state.mu.Unlock, nil
}

func (state *subjectState) invalidate() {
	state.mu.Lock()
	state.active = false
	state.handle = 0
	state.mu.Unlock()
}
