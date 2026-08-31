//go:build !windows

package peerverify

import (
	"errors"
	"sync"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
)

func TestPreflightWindowsVerifierHasOneConcurrentClaimAndFailsClosedOutsideWindows(t *testing.T) {
	if verifier, err := ClaimPreflightWindowsVerifier(); verifier.verify != nil || !errors.Is(err, ErrPreflightVerifierUnavailable) {
		t.Fatalf("unauthorized public claim returned (%#v, %v)", verifier, err)
	}
	const contenders = 32
	type claimResult struct {
		verifier PreflightWindowsVerifier
		err      error
	}
	start := make(chan struct{})
	results := make(chan claimResult, contenders)
	var ready sync.WaitGroup
	ready.Add(contenders)
	for range contenders {
		go func() {
			ready.Done()
			<-start
			verifier, err := claimPreflightWindowsVerifier()
			results <- claimResult{verifier: verifier, err: err}
		}()
	}
	ready.Wait()
	close(start)

	var winner PreflightWindowsVerifier
	successes := 0
	for range contenders {
		result := <-results
		if result.err == nil {
			successes++
			winner = result.verifier
			continue
		}
		if !errors.Is(result.err, ErrPreflightVerifierUnavailable) {
			t.Fatalf("losing claim error = %v", result.err)
		}
	}
	if successes != 1 {
		t.Fatalf("successful concurrent claims = %d, want 1", successes)
	}

	session, err := winner.Verify(config.RoleControl, nil, ImageExpectation{}, ImageExpectation{}, "")
	if session != nil || !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("claimed verifier returned (%v, %v), want nil and ErrUnsupportedPlatform", session, err)
	}
	session, err = (PreflightWindowsVerifier{}).Verify(
		config.RoleControl,
		nil,
		ImageExpectation{},
		ImageExpectation{},
		"",
	)
	if session != nil || !errors.Is(err, ErrPreflightVerifierUnavailable) {
		t.Fatalf("zero verifier returned (%v, %v), want nil and ErrPreflightVerifierUnavailable", session, err)
	}
}

func TestNewWindowsAuthenticodeVerifierFailsClosedOutsideWindows(t *testing.T) {
	verifier, err := NewWindowsAuthenticodeVerifier()
	if verifier != nil || !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("NewWindowsAuthenticodeVerifier returned (%v, %v)", verifier, err)
	}
}
