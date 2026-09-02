package stagedpackage

import (
	"errors"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/secureconfig"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

func TestHandleOwnerRetriesAndRetainsUnresolvedHandles(t *testing.T) {
	retried := &cleanupTestFile{failures: 1}
	owner := &handleOwner{}
	owner.addFile("retry", retried, zeroObjectEvidence())
	err, unresolved := owner.close()
	if !errors.Is(err, ErrCleanup) || unresolved || retried.attempts != 2 || len(owner.objects) != 0 {
		t.Fatalf("retry close returned err=%v unresolved=%v attempts=%d objects=%d", err, unresolved, retried.attempts, len(owner.objects))
	}

	failed := &cleanupTestFile{failures: closeAttempts}
	owner = &handleOwner{}
	owner.addFile("unresolved", failed, zeroObjectEvidence())
	err, unresolved = owner.close()
	if !errors.Is(err, ErrCleanup) || !unresolved || failed.attempts != closeAttempts ||
		len(owner.objects) != 1 || owner.objects[0].file == nil {
		t.Fatalf("unresolved close returned err=%v unresolved=%v attempts=%d objects=%d", err, unresolved, failed.attempts, len(owner.objects))
	}
}

func TestCleanupOperationLinearizesPlatformAndPackageFatalState(t *testing.T) {
	platformFatal := false
	state := &cleanupState{
		platformStatus: func() error {
			if platformFatal {
				return winfile.ErrCleanupFatal
			}
			return nil
		},
		platformCommit: func(commit func()) error {
			if platformFatal {
				return winfile.ErrCleanupFatal
			}
			commit()
			return nil
		},
	}
	operation, err := state.begin()
	if err != nil {
		t.Fatal(err)
	}
	platformFatal = true
	called := false
	if err := operation.commit(func() { called = true }); !errors.Is(err, ErrCleanupFatal) || called {
		t.Fatalf("platform-fatal commit returned %v, called=%v", err, called)
	}
	platformFatal = false
	operation, err = state.begin()
	if err != nil {
		t.Fatal(err)
	}
	state.fatal = true
	state.epoch++
	if err := operation.commit(func() { called = true }); !errors.Is(err, ErrCleanupFatal) {
		t.Fatalf("package-fatal commit returned %v", err)
	}
}

type cleanupTestFile struct {
	failures int
	attempts int
}

func (*cleanupTestFile) Evidence() winfile.Evidence        { return winfile.Evidence{} }
func (*cleanupTestFile) ReadAll(uint64) ([]byte, error)    { return nil, nil }
func (*cleanupTestFile) ReadAt([]byte, int64) (int, error) { return 0, nil }
func (*cleanupTestFile) HashSHA256(winfile.HashOptions) (winfile.HashResult, error) {
	return winfile.HashResult{}, nil
}
func (*cleanupTestFile) VerifyAuthenticode(authenticode.Verifier) (authenticode.Evidence, error) {
	return authenticode.Evidence{}, nil
}
func (*cleanupTestFile) VerifyUnchanged() error { return nil }
func (*cleanupTestFile) ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error) {
	return winfile.SecurityDescriptorEvidence{}, nil
}
func (*cleanupTestFile) ReinspectDataStreams() ([]winfile.DataStream, error) { return nil, nil }
func (file *cleanupTestFile) Close() error {
	file.attempts++
	if file.attempts <= file.failures {
		return errors.New("close failed")
	}
	return nil
}

func zeroObjectEvidence() secureconfig.ObjectEvidence { return secureconfig.ObjectEvidence{} }
