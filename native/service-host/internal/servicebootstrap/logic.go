package servicebootstrap

import (
	"errors"
	"fmt"
	"sync"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winidentity"
)

type daclTarget interface {
	applyAndReadBackDACL(daclPolicy) (daclEvidence, error)
}

type primaryToken interface {
	daclTarget
	Close() error
}

type bootstrapPlatform interface {
	currentProcess() (daclTarget, uint32, error)
	openCurrentPrimaryToken() (primaryToken, error)
}

type identityPreflight func(winidentity.Options) (winidentity.Evidence, error)

type dependencies struct {
	platform          bootstrapPlatform
	identityPreflight identityPreflight
}

type prepareGate struct {
	mu        sync.Mutex
	attempted bool
}

var productionPrepareGate prepareGate

func (gate *prepareGate) run(role config.Role, deps dependencies) error {
	if _, err := resolveRole(role); err != nil {
		return err
	}
	gate.mu.Lock()
	defer gate.mu.Unlock()
	if gate.attempted {
		return ErrAlreadyPrepared
	}
	gate.attempted = true
	return prepare(role, deps)
}

func prepare(role config.Role, deps dependencies) (err error) {
	resolved, err := resolveRole(role)
	if err != nil {
		return err
	}
	if deps.platform == nil || deps.identityPreflight == nil {
		return errors.New("ServiceHost bootstrap dependencies are unavailable")
	}
	identity, err := deps.identityPreflight(winidentity.Options{
		OwnService:  resolved.own,
		PeerService: resolved.peer,
	})
	if err != nil {
		return fmt.Errorf("verify fixed ServiceHost identity: %w", err)
	}
	if identity.ProcessID == 0 || identity.OwnService.Name != resolved.own.Name ||
		identity.OwnService.SID != resolved.own.SID || identity.PeerService.Name != resolved.peer.Name ||
		identity.PeerService.SID != resolved.peer.SID {
		return errors.New("Windows identity preflight returned inconsistent fixed identities")
	}

	process, processID, err := deps.platform.currentProcess()
	if err != nil {
		return fmt.Errorf("open current ServiceHost process: %w", err)
	}
	if process == nil || processID == 0 || processID != identity.ProcessID {
		return errors.New("current ServiceHost process differs from identity preflight")
	}
	token, err := deps.platform.openCurrentPrimaryToken()
	if err != nil {
		return fmt.Errorf("open current ServiceHost primary token: %w", err)
	}
	if token == nil {
		return errors.New("current ServiceHost primary token is unavailable")
	}
	defer func() {
		err = errors.Join(err, token.Close())
	}()

	processPolicy, tokenPolicy := policiesForRole(resolved)
	if err := applyAndValidateDACL(process, processPolicy, "current ServiceHost process"); err != nil {
		return err
	}
	if err := applyAndValidateDACL(token, tokenPolicy, "current ServiceHost primary token"); err != nil {
		return err
	}
	return nil
}

func applyAndValidateDACL(target daclTarget, policy daclPolicy, label string) error {
	evidence, err := target.applyAndReadBackDACL(policy)
	if err != nil {
		return fmt.Errorf("apply and read back protected %s DACL: %w", label, err)
	}
	if err := validateDACL(evidence, policy); err != nil {
		return fmt.Errorf("validate protected %s DACL: %w", label, err)
	}
	return nil
}
