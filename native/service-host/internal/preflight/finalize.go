package preflight

import (
	"context"
	"errors"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/dataroot"
)

type dataRootLifecycle interface {
	VerifyUnchanged(context.Context) error
	Close() error
}

// FinalizeRuntimePlan consumes the retained data-root gate. It returns launch
// inputs only after the same installation-bound evidence passes final
// reinspection and all retained handles close successfully.
func (e Evidence) FinalizeRuntimePlan(
	ctx context.Context,
	root dataroot.Evidence,
) (RuntimePlan, error) {
	if err := e.Validate(); err != nil {
		return RuntimePlan{}, closeDataRootAfterFailure(root, err)
	}
	installation := &installationSnapshot{
		role:           e.role,
		controlConfig:  cloneConfig(e.control.Configuration),
		executorConfig: cloneConfig(e.executor.Configuration),
		roots:          cloneRoots(e.roots),
	}
	observed, err := captureDataRootBinding(root, installation)
	if err != nil {
		return RuntimePlan{}, closeDataRootAfterFailure(root, err)
	}
	return finalizeRuntimePlan(ctx, e, observed, root)
}

func finalizeRuntimePlan(
	ctx context.Context,
	evidence Evidence,
	observed DataRootBinding,
	root dataRootLifecycle,
) (RuntimePlan, error) {
	if err := evidence.Validate(); err != nil {
		return RuntimePlan{}, closeDataRootAfterFailure(root, err)
	}
	if !sameDataRootBinding(observed, evidence.dataRoot) {
		return RuntimePlan{}, closeDataRootAfterFailure(
			root,
			preflightError(ErrorDataRoot, "final data-root evidence differs from preflight", nil),
		)
	}
	verifyErr := root.VerifyUnchanged(ctx)
	closeErr := root.Close()
	if verifyErr != nil || closeErr != nil {
		return RuntimePlan{}, preflightError(
			ErrorDataRoot,
			"final data-root reinspection or cleanup failed",
			errors.Join(verifyErr, closeErr),
		)
	}
	return evidence.runtimePlan()
}

func closeDataRootAfterFailure(root interface{ Close() error }, cause error) error {
	if closeErr := root.Close(); closeErr != nil {
		return errors.Join(cause, preflightError(ErrorDataRoot, "close rejected data-root evidence", closeErr))
	}
	return cause
}

func sameDataRootBinding(left DataRootBinding, right DataRootBinding) bool {
	if left.role != right.role || left.currentPath != right.currentPath ||
		left.peerPath != right.peerPath || left.peerObservation != right.peerObservation ||
		left.digest != right.digest || !left.bound || !right.bound ||
		len(left.installationRoots) != len(right.installationRoots) {
		return false
	}
	for index, expected := range left.installationRoots {
		observed := right.installationRoots[index]
		if expected.root != observed.root || expected.path != observed.path ||
			expected.target != observed.target ||
			len(expected.ancestorPaths) != len(observed.ancestorPaths) ||
			len(expected.ancestors) != len(observed.ancestors) {
			return false
		}
		for ancestorIndex := range expected.ancestors {
			if expected.ancestorPaths[ancestorIndex] != observed.ancestorPaths[ancestorIndex] ||
				expected.ancestors[ancestorIndex] != observed.ancestors[ancestorIndex] {
				return false
			}
		}
	}
	return true
}
