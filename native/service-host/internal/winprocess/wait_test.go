package winprocess

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestNodeProcessWaitPreCanceledDoesNotPoll(t *testing.T) {
	cause := errors.New("wait canceled before entry")
	ctx, cancel := context.WithCancelCause(context.Background())
	cancel(cause)
	pollCalls := 0
	exitCalls := 0

	outcome := waitForNodeProcessContext(
		ctx,
		func(time.Duration) (uint32, error) {
			pollCalls++
			return nodeWaitObjectStatus, nil
		},
		func(*uint32) error {
			exitCalls++
			return nil
		},
	)
	if !errors.Is(outcome.waitErr, cause) || outcome.terminal || pollCalls != 0 || exitCalls != 0 {
		t.Fatalf("outcome=%+v poll calls=%d exit calls=%d", outcome, pollCalls, exitCalls)
	}
}

func TestNodeProcessWaitCancellationAfterPollIsObservational(t *testing.T) {
	cause := errors.New("wait canceled")
	ctx, cancel := context.WithCancelCause(context.Background())
	pollCalls := 0

	outcome := waitForNodeProcessContext(
		ctx,
		func(interval time.Duration) (uint32, error) {
			pollCalls++
			if interval != nodeWaitPollInterval {
				t.Fatalf("poll interval=%v, want %v", interval, nodeWaitPollInterval)
			}
			cancel(cause)
			return nodeWaitTimeoutStatus, nil
		},
		func(*uint32) error {
			t.Fatal("canceled wait read an exit code")
			return nil
		},
	)
	if !errors.Is(outcome.waitErr, cause) || outcome.terminal || pollCalls != 1 {
		t.Fatalf("outcome=%+v poll calls=%d", outcome, pollCalls)
	}
}

func TestNodeProcessWaitSignalWinsCancellationRace(t *testing.T) {
	cause := errors.New("concurrent cancellation")
	ctx, cancel := context.WithCancelCause(context.Background())

	outcome := waitForNodeProcessContext(
		ctx,
		func(time.Duration) (uint32, error) {
			cancel(cause)
			return nodeWaitObjectStatus, nil
		},
		func(exitCode *uint32) error {
			*exitCode = 42
			return nil
		},
	)
	if outcome.exitCode != 42 || outcome.waitErr != nil || outcome.exitErr != nil || !outcome.terminal {
		t.Fatalf("signal/cancel outcome=%+v", outcome)
	}
}

func TestNodeProcessWaitInfrastructureFailuresAreTerminal(t *testing.T) {
	waitFailure := errors.New("native wait failed")
	exitFailure := errors.New("exit code failed")
	tests := []struct {
		name        string
		poll        func(time.Duration) (uint32, error)
		readExit    func(*uint32) error
		want        error
		wantText    string
		wantCode    uint32
		wantExitErr bool
	}{
		{
			name: "native wait error",
			poll: func(time.Duration) (uint32, error) {
				return 0, waitFailure
			},
			readExit: func(*uint32) error { return nil },
			want:     waitFailure,
		},
		{
			name: "unexpected wait status",
			poll: func(time.Duration) (uint32, error) {
				return 0x81, nil
			},
			readExit: func(*uint32) error { return nil },
			wantText: "0x81",
		},
		{
			name: "exit query failure",
			poll: func(time.Duration) (uint32, error) {
				return nodeWaitObjectStatus, nil
			},
			readExit:    func(*uint32) error { return exitFailure },
			want:        exitFailure,
			wantExitErr: true,
		},
		{
			name: "signaled still active",
			poll: func(time.Duration) (uint32, error) {
				return nodeWaitObjectStatus, nil
			},
			readExit: func(exitCode *uint32) error {
				*exitCode = nodeStillActiveExitCode
				return nil
			},
			wantText:    "STILL_ACTIVE",
			wantCode:    nodeStillActiveExitCode,
			wantExitErr: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			outcome := waitForNodeProcessContext(context.Background(), test.poll, test.readExit)
			if !outcome.terminal || outcome.exitCode != test.wantCode {
				t.Fatalf("outcome=%+v", outcome)
			}
			got := outcome.waitErr
			if test.wantExitErr {
				got = outcome.exitErr
			}
			if test.want != nil && !errors.Is(got, test.want) {
				t.Fatalf("error=%v, want %v", got, test.want)
			}
			if test.wantText != "" && (got == nil || !strings.Contains(got.Error(), test.wantText)) {
				t.Fatalf("error=%v, want text %q", got, test.wantText)
			}
		})
	}
}

func TestNodeProcessWaitContinuesAfterTimeout(t *testing.T) {
	polls := 0
	outcome := waitForNodeProcessContext(
		context.Background(),
		func(time.Duration) (uint32, error) {
			polls++
			if polls == 1 {
				return nodeWaitTimeoutStatus, nil
			}
			return nodeWaitObjectStatus, nil
		},
		func(exitCode *uint32) error {
			*exitCode = 7
			return nil
		},
	)
	if polls != 2 || outcome.exitCode != 7 || outcome.waitErr != nil || outcome.exitErr != nil || !outcome.terminal {
		t.Fatalf("polls=%d outcome=%+v", polls, outcome)
	}
}
