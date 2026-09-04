//go:build windows

package host

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestAcquireGlobalInstanceMutexRejectsInvalidKey(t *testing.T) {
	for _, key := range []string{"", "A", "g", "abc"} {
		if _, err := AcquireGlobalInstanceMutex(key); err == nil {
			t.Fatalf("expected invalid key %q to fail", key)
		}
	}
}

func TestAcquireGlobalInstanceMutexRejectsDuplicateProcessHostInstance(t *testing.T) {
	instanceKey := testInstanceKey(t.Name())
	releaseFirst, err := AcquireGlobalInstanceMutex(instanceKey)
	if err != nil {
		t.Fatalf("acquire first mutex: %v", err)
	}
	t.Cleanup(func() {
		if releaseFirst == nil {
			return
		}
		if releaseErr := releaseFirst(); releaseErr != nil {
			t.Fatalf("release first mutex: %v", releaseErr)
		}
	})

	releaseSecond, err := AcquireGlobalInstanceMutex(instanceKey)
	if !errors.Is(err, ErrInstanceMutexAlreadyHeld) {
		if releaseSecond != nil {
			_ = releaseSecond()
		}
		t.Fatalf("duplicate acquisition error = %v, want %v", err, ErrInstanceMutexAlreadyHeld)
	}

	if err := releaseFirst(); err != nil {
		t.Fatalf("release first mutex before reacquire: %v", err)
	}
	releaseFirst = nil

	releaseThird, err := AcquireGlobalInstanceMutex(instanceKey)
	if err != nil {
		t.Fatalf("reacquire mutex after release: %v", err)
	}
	if err := releaseThird(); err != nil {
		t.Fatalf("release reacquired mutex: %v", err)
	}
}

func testInstanceKey(name string) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%d:%d", name, os.Getpid(), time.Now().UnixNano())))
	return hex.EncodeToString(sum[:])
}
