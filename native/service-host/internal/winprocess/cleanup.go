package winprocess

import (
	"errors"
	"fmt"
	"sync"
	"syscall"
)

const launchCleanupRetryLimit = 3

const windowsErrorInvalidHandle = syscall.Errno(6)

// ErrLaunchCleanupFatal means a failed launch left native state unresolved.
// The current ServiceHost process must exit and must not attempt another launch.
var ErrLaunchCleanupFatal = errors.New("Node launch cleanup is unresolved; the current ServiceHost process must exit")

type cleanupRetryResult struct {
	err           error
	succeeded     bool
	invalidHandle bool
}

type launchCleanupReport struct {
	err        error
	unresolved bool
}

func (r *launchCleanupReport) addDiagnostics(err error) {
	if r != nil {
		r.err = errors.Join(r.err, err)
	}
}

func (r *launchCleanupReport) addRequired(result cleanupRetryResult) {
	if r == nil {
		return
	}
	r.err = errors.Join(r.err, result.err)
	if !result.succeeded {
		r.unresolved = true
	}
}

func (r *launchCleanupReport) addUnresolved(err error) {
	if r == nil || err == nil {
		return
	}
	r.err = errors.Join(r.err, err)
	r.unresolved = true
}

func (r *launchCleanupReport) merge(other launchCleanupReport) {
	if r == nil {
		return
	}
	r.err = errors.Join(r.err, other.err)
	r.unresolved = r.unresolved || other.unresolved
}

func (r launchCleanupReport) result() error {
	if r.unresolved {
		return fatalLaunchCleanupError(r.err)
	}
	return r.err
}

// retryNonConsumingLaunchCleanup is only for operations that never consume the
// retained handle when they fail, such as TerminateJobObject. Raw handle close
// operations must use consumeOwnedResourceOnce instead.
func retryNonConsumingLaunchCleanup(label string, operation func() error) cleanupRetryResult {
	if operation == nil {
		return cleanupRetryResult{err: fmt.Errorf("%s operation is unavailable", label)}
	}
	failures := make([]error, 0, launchCleanupRetryLimit)
	for attempt := 1; attempt <= launchCleanupRetryLimit; attempt++ {
		if err := operation(); err != nil {
			failures = append(failures, fmt.Errorf("%s attempt %d: %w", label, attempt, err))
			// ERROR_INVALID_HANDLE proves that the numeric value is not the
			// retained object. Retrying could close a subsequently reused handle.
			if errors.Is(err, windowsErrorInvalidHandle) {
				return cleanupRetryResult{
					err:           errors.Join(failures...),
					invalidHandle: true,
				}
			}
			continue
		}
		return cleanupRetryResult{err: errors.Join(failures...), succeeded: true}
	}
	return cleanupRetryResult{err: errors.Join(failures...)}
}

func fatalLaunchCleanupError(cause error) error {
	return errors.Join(ErrLaunchCleanupFatal, cause)
}

func validateCreatedLaunchResource(
	checks []func() error,
	consumeResource func(error) error,
) error {
	for _, check := range checks {
		var err error
		if check == nil {
			err = errors.New("launch resource validation step is unavailable")
		} else {
			err = check()
		}
		if err != nil {
			if consumeResource == nil {
				return errors.Join(err, errors.New("consume rejected launch resource operation is unavailable"))
			}
			return errors.Join(err, consumeResource(err))
		}
	}
	return nil
}

// consumeOwnedResourceOnce never retries a consuming close operation. A close
// failure poisons the host because the numeric handle could already be reused.
func consumeOwnedResourceOnce(
	label string,
	owner any,
	closeResource func() error,
	quarantine *processLifetimeQuarantine,
) error {
	if closeResource == nil {
		return quarantine.retain(owner, fmt.Errorf("%s operation is unavailable", label))
	}
	if err := closeResource(); err != nil {
		return quarantine.retain(owner, fmt.Errorf("%s: %w", label, err))
	}
	return nil
}

type launchCleanupGate struct {
	launchMu sync.Mutex
	stateMu  sync.Mutex
	fatal    bool
	epoch    uint64
}

type launchCleanupPermit struct {
	gate        *launchCleanupGate
	epoch       uint64
	releaseOnce sync.Once
}

func (g *launchCleanupGate) begin() (*launchCleanupPermit, error) {
	if g == nil {
		return nil, ErrLaunchCleanupFatal
	}
	g.launchMu.Lock()
	g.stateMu.Lock()
	defer g.stateMu.Unlock()
	if g.fatal {
		g.launchMu.Unlock()
		return nil, ErrLaunchCleanupFatal
	}
	return &launchCleanupPermit{gate: g, epoch: g.epoch}, nil
}

func (p *launchCleanupPermit) markFatal() {
	if p != nil && p.gate != nil {
		p.gate.markFatal()
	}
}

func (g *launchCleanupGate) markFatal() {
	if g == nil {
		return
	}
	g.stateMu.Lock()
	g.fatal = true
	g.epoch++
	g.stateMu.Unlock()
}

func (p *launchCleanupPermit) check() error {
	if p == nil || p.gate == nil {
		return ErrLaunchCleanupFatal
	}
	p.gate.stateMu.Lock()
	defer p.gate.stateMu.Unlock()
	if p.gate.fatal || p.gate.epoch != p.epoch {
		return ErrLaunchCleanupFatal
	}
	return nil
}

func (p *launchCleanupPermit) commit(commit func()) error {
	if p == nil || p.gate == nil || commit == nil {
		return ErrLaunchCleanupFatal
	}
	p.gate.stateMu.Lock()
	defer p.gate.stateMu.Unlock()
	if p.gate.fatal || p.gate.epoch != p.epoch {
		return ErrLaunchCleanupFatal
	}
	commit()
	return nil
}

func (p *launchCleanupPermit) release() {
	if p == nil || p.gate == nil {
		return
	}
	p.releaseOnce.Do(p.gate.launchMu.Unlock)
}

type processLifetimeQuarantine struct {
	mu        sync.Mutex
	owners    []any
	markFatal func()
}

func (q *processLifetimeQuarantine) retain(owner any, cause error) error {
	if q == nil {
		return fatalLaunchCleanupError(errors.Join(cause, errors.New("process-lifetime quarantine is unavailable")))
	}
	// Fatal publication linearizes with launch commit before ownership moves to
	// the quarantine. The caller's stack keeps owner alive during this handoff.
	if q.markFatal != nil {
		q.markFatal()
	}
	if owner == nil {
		return fatalLaunchCleanupError(errors.Join(cause, errors.New("process-lifetime quarantine owner is unavailable")))
	}
	q.mu.Lock()
	q.owners = append(q.owners, owner)
	q.mu.Unlock()
	return fatalLaunchCleanupError(cause)
}

func (q *processLifetimeQuarantine) count() int {
	if q == nil {
		return 0
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.owners)
}

func closeNodeResourcesAfterJob(
	closeJob func() error,
	closeStandardIO func() error,
	closeProcess func() error,
) error {
	jobErr := callRequiredCleanup("close Node Job", closeJob)
	standardIOErr := callRequiredCleanup("close Node standard I/O", closeStandardIO)
	if jobErr != nil {
		return errors.Join(jobErr, standardIOErr)
	}
	return errors.Join(standardIOErr, callRequiredCleanup("close Node process handle", closeProcess))
}

func callRequiredCleanup(label string, operation func() error) error {
	if operation == nil {
		return fmt.Errorf("%s operation is unavailable", label)
	}
	return operation()
}
