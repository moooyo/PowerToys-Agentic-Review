//go:build windows

package winfile

import (
	"fmt"
	"reflect"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
)

// VerifyAuthenticode lends the retained file handle to an opaque synchronous
// verifier while holding the file lock. It never exposes the native handle and
// therefore serializes verification with reads, hashing, reinspection, and Close.
func (file *File) VerifyAuthenticode(verifier authenticode.Verifier) (authenticode.Evidence, error) {
	if file == nil {
		return authenticode.Evidence{}, ErrClosed
	}
	if nilAuthenticodeVerifier(verifier) {
		return authenticode.Evidence{}, fmt.Errorf("%w: Authenticode verifier is required", ErrInvalidOptions)
	}
	file.mu.Lock()
	defer file.mu.Unlock()
	if file.closed || file.handle == 0 {
		return authenticode.Evidence{}, ErrClosed
	}
	return authenticode.WithBorrowedFileHandle(file.handle, verifier.Verify)
}

func nilAuthenticodeVerifier(verifier authenticode.Verifier) bool {
	if verifier == nil {
		return true
	}
	value := reflect.ValueOf(verifier)
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return value.IsNil()
	default:
		return false
	}
}
