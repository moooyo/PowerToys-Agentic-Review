package winprocess

import (
	"errors"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestNonConsumingLaunchCleanupRetryRecoversWithinBound(t *testing.T) {
	transient := errors.New("transient close failure")
	attempts := 0
	result := retryNonConsumingLaunchCleanup("terminate test process", func() error {
		attempts++
		if attempts < launchCleanupRetryLimit {
			return transient
		}
		return nil
	})
	if !result.succeeded || attempts != launchCleanupRetryLimit {
		t.Fatalf("cleanup result = %#v after %d attempts", result, attempts)
	}
	if !errors.Is(result.err, transient) {
		t.Fatalf("recovered cleanup diagnostics = %v", result.err)
	}
}

func TestNonConsumingLaunchCleanupRetryReportsExhaustion(t *testing.T) {
	persistent := errors.New("persistent close failure")
	attempts := 0
	result := retryNonConsumingLaunchCleanup("terminate test process", func() error {
		attempts++
		return persistent
	})
	if result.succeeded || attempts != launchCleanupRetryLimit {
		t.Fatalf("cleanup result = %#v after %d attempts", result, attempts)
	}
	fatal := fatalLaunchCleanupError(result.err)
	if !errors.Is(fatal, ErrLaunchCleanupFatal) || !errors.Is(fatal, persistent) {
		t.Fatalf("fatal cleanup error = %v", fatal)
	}
}

func TestNonConsumingLaunchCleanupDoesNotRetryInvalidHandle(t *testing.T) {
	attempts := 0
	result := retryNonConsumingLaunchCleanup("terminate invalid handle", func() error {
		attempts++
		return syscall.Errno(6)
	})
	if result.succeeded || !result.invalidHandle || attempts != 1 {
		t.Fatalf("invalid-handle cleanup result=%#v attempts=%d", result, attempts)
	}
	var report launchCleanupReport
	report.addRequired(result)
	if err := report.result(); !errors.Is(err, ErrLaunchCleanupFatal) || !errors.Is(err, syscall.Errno(6)) {
		t.Fatalf("invalid-handle report = %v", err)
	}
}

func TestLaunchCleanupReportIsFatalOnlyWhileStateRemainsUnresolved(t *testing.T) {
	transient := errors.New("transient cleanup failure")
	recovered := launchCleanupReport{}
	recovered.addRequired(cleanupRetryResult{err: transient, succeeded: true})
	if err := recovered.result(); !errors.Is(err, transient) || errors.Is(err, ErrLaunchCleanupFatal) {
		t.Fatalf("recovered cleanup result = %v", err)
	}

	unresolved := launchCleanupReport{}
	unresolved.addRequired(cleanupRetryResult{err: transient})
	if err := unresolved.result(); !errors.Is(err, transient) || !errors.Is(err, ErrLaunchCleanupFatal) {
		t.Fatalf("unresolved cleanup result = %v", err)
	}
}

func TestCreatedLaunchResourceValidationClosesAfterSetOrVerifyFailure(t *testing.T) {
	setFailure := errors.New("set limits failure")
	verifyFailure := errors.New("verify limits failure")
	for _, test := range []struct {
		name        string
		setErr      error
		verifyErr   error
		wantFailure error
		wantChecks  int
	}{
		{name: "set", setErr: setFailure, wantFailure: setFailure, wantChecks: 1},
		{name: "verify", verifyErr: verifyFailure, wantFailure: verifyFailure, wantChecks: 2},
	} {
		t.Run(test.name, func(t *testing.T) {
			checks := 0
			closes := 0
			err := validateCreatedLaunchResource(
				[]func() error{
					func() error { checks++; return test.setErr },
					func() error { checks++; return test.verifyErr },
				},
				func(error) error { closes++; return nil },
			)
			if !errors.Is(err, test.wantFailure) || errors.Is(err, ErrLaunchCleanupFatal) {
				t.Fatalf("validation error = %v", err)
			}
			if checks != test.wantChecks || closes != 1 {
				t.Fatalf("checks=%d closes=%d", checks, closes)
			}
		})
	}
}

func TestCreatedLaunchResourceCloseFailureIsFatalWithoutRetry(t *testing.T) {
	validationFailure := errors.New("verify limits failure")
	closeFailure := errors.New("Job close failure")
	closes := 0
	quarantine := processLifetimeQuarantine{}
	err := validateCreatedLaunchResource(
		[]func() error{func() error { return validationFailure }},
		func(error) error {
			return consumeOwnedResourceOnce(
				"close test Job",
				&struct{}{},
				func() error { closes++; return closeFailure },
				&quarantine,
			)
		},
	)
	if !errors.Is(err, validationFailure) || !errors.Is(err, closeFailure) ||
		!errors.Is(err, ErrLaunchCleanupFatal) {
		t.Fatalf("validation error = %v", err)
	}
	if closes != 1 || quarantine.count() != 1 {
		t.Fatalf("raw close calls=%d quarantine=%d", closes, quarantine.count())
	}
}

func TestOwnedRawCloseInvalidHandleIsConsumedOnce(t *testing.T) {
	closes := 0
	quarantine := processLifetimeQuarantine{}
	err := consumeOwnedResourceOnce(
		"close invalid raw handle",
		&struct{}{},
		func() error { closes++; return syscall.Errno(6) },
		&quarantine,
	)
	if !errors.Is(err, syscall.Errno(6)) || !errors.Is(err, ErrLaunchCleanupFatal) {
		t.Fatalf("raw close error = %v", err)
	}
	if closes != 1 || quarantine.count() != 1 {
		t.Fatalf("raw close calls=%d quarantine=%d", closes, quarantine.count())
	}
}

func TestFatalLaunchCleanupPermanentlyClosesGate(t *testing.T) {
	var gate launchCleanupGate
	permit, err := gate.begin()
	if err != nil {
		t.Fatal(err)
	}
	blocked := make(chan error, 1)
	go func() {
		second, err := gate.begin()
		if second != nil {
			second.release()
		}
		blocked <- err
	}()

	select {
	case err := <-blocked:
		t.Fatalf("concurrent launch passed an active gate: %v", err)
	case <-time.After(time.Millisecond):
	}
	permit.markFatal()
	permit.release()
	permit.release()
	if err := <-blocked; !errors.Is(err, ErrLaunchCleanupFatal) {
		t.Fatalf("launch after fatal cleanup error = %v", err)
	}
	if next, err := gate.begin(); next != nil || !errors.Is(err, ErrLaunchCleanupFatal) {
		t.Fatalf("later launch after fatal cleanup = (%v, %v)", next, err)
	}
}

func TestSuccessfulLaunchCleanupGateSerializesAttempts(t *testing.T) {
	var gate launchCleanupGate
	first, err := gate.begin()
	if err != nil {
		t.Fatal(err)
	}
	var group sync.WaitGroup
	group.Add(1)
	secondReady := make(chan struct{})
	go func() {
		defer group.Done()
		second, err := gate.begin()
		if err != nil {
			t.Errorf("second begin error = %v", err)
			return
		}
		close(secondReady)
		second.release()
	}()
	first.release()
	group.Wait()
	select {
	case <-secondReady:
	default:
		t.Fatal("second launch did not acquire a released gate")
	}
}

func TestFatalMarkInvalidatesInFlightLaunchBeforeCommit(t *testing.T) {
	var gate launchCleanupGate
	permit, err := gate.begin()
	if err != nil {
		t.Fatal(err)
	}
	marked := make(chan struct{})
	go func() {
		gate.markFatal()
		close(marked)
	}()
	select {
	case <-marked:
	case <-time.After(time.Second):
		t.Fatal("asynchronous fatal mark blocked behind the in-flight launch")
	}
	committed := false
	if err := permit.check(); !errors.Is(err, ErrLaunchCleanupFatal) {
		t.Fatalf("in-flight launch check error = %v", err)
	}
	if err := permit.commit(func() { committed = true }); !errors.Is(err, ErrLaunchCleanupFatal) {
		t.Fatalf("in-flight launch commit error = %v", err)
	}
	permit.release()
	if committed {
		t.Fatal("fatal-marked launch committed ownership")
	}
}

func TestQuarantinePublishesFatalBeforeLaunchCommit(t *testing.T) {
	var gate launchCleanupGate
	permit, err := gate.begin()
	if err != nil {
		t.Fatal(err)
	}
	quarantine := processLifetimeQuarantine{markFatal: gate.markFatal}
	cause := errors.New("unknown native completion")
	if err := quarantine.retain(&struct{}{}, cause); !errors.Is(err, ErrLaunchCleanupFatal) {
		t.Fatalf("quarantine error = %v", err)
	}
	committed := false
	if err := permit.commit(func() { committed = true }); !errors.Is(err, ErrLaunchCleanupFatal) {
		t.Fatalf("commit after quarantine error = %v", err)
	}
	permit.release()
	if committed || quarantine.count() != 1 {
		t.Fatalf("committed=%v quarantine=%d", committed, quarantine.count())
	}
}

func TestProcessLifetimeQuarantineRetainsOwnerAndMarksFatal(t *testing.T) {
	fatal := false
	quarantine := processLifetimeQuarantine{markFatal: func() { fatal = true }}
	owner := &struct{ value int }{value: 42}
	cause := errors.New("unknown completion")
	err := quarantine.retain(owner, cause)
	if !errors.Is(err, ErrLaunchCleanupFatal) || !errors.Is(err, cause) {
		t.Fatalf("quarantine error = %v", err)
	}
	if quarantine.count() != 1 || !fatal {
		t.Fatalf("quarantine count=%d fatal=%v", quarantine.count(), fatal)
	}
}

func TestCloseDoesNotWaitForProcessHandleWhenJobCleanupFails(t *testing.T) {
	terminateFailure := errors.New("terminate Job failure")
	closeJobFailure := errors.New("close Job failure")
	var processMu sync.RWMutex
	waitHoldingProcess := make(chan struct{})
	releaseWait := make(chan struct{})
	go func() {
		processMu.RLock()
		close(waitHoldingProcess)
		<-releaseWait
		processMu.RUnlock()
	}()
	<-waitHoldingProcess

	jobAttempts := 0
	processCloseCalls := 0
	firstResult := make(chan error, 1)
	go func() {
		firstResult <- closeNodeResourcesAfterJob(
			func() error {
				jobAttempts++
				return errors.Join(terminateFailure, closeJobFailure)
			},
			func() error { return nil },
			func() error {
				processCloseCalls++
				processMu.Lock()
				processMu.Unlock()
				return nil
			},
		)
	}()
	select {
	case err := <-firstResult:
		if !errors.Is(err, terminateFailure) || !errors.Is(err, closeJobFailure) {
			t.Fatalf("first Close error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Close blocked behind the active Wait process read lock")
	}
	if processCloseCalls != 0 {
		t.Fatal("failed Job cleanup attempted to close the retained process handle")
	}

	close(releaseWait)
	if err := closeNodeResourcesAfterJob(
		func() error { jobAttempts++; return nil },
		func() error { return nil },
		func() error {
			processCloseCalls++
			processMu.Lock()
			processMu.Unlock()
			return nil
		},
	); err != nil {
		t.Fatalf("retry Close error = %v", err)
	}
	if jobAttempts != 2 || processCloseCalls != 1 {
		t.Fatalf("job attempts=%d process closes=%d", jobAttempts, processCloseCalls)
	}
}
