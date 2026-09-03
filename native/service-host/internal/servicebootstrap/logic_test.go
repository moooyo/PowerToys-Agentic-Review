package servicebootstrap

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winidentity"
)

type fakeTarget struct {
	events *[]string
	label  string
	policy daclPolicy
	err    error
}

func (target *fakeTarget) applyAndReadBackDACL(policy daclPolicy) (daclEvidence, error) {
	*target.events = append(*target.events, target.label)
	target.policy = policy
	if target.err != nil {
		return daclEvidence{}, target.err
	}
	return daclEvidence{
		control: securityDescriptorDACLPresent | securityDescriptorDACLProtected,
		present: true, protected: true, accessRules: append([]accessEntry(nil), policy.entries...),
	}, nil
}

type fakeToken struct {
	fakeTarget
	closeErr error
}

func (token *fakeToken) Close() error {
	*token.events = append(*token.events, "close-token")
	return token.closeErr
}

type fakePlatform struct {
	events    *[]string
	process   *fakeTarget
	token     *fakeToken
	processID uint32
}

func (platform *fakePlatform) currentProcess() (daclTarget, uint32, error) {
	*platform.events = append(*platform.events, "current-process")
	return platform.process, platform.processID, nil
}

func (platform *fakePlatform) openCurrentPrimaryToken() (primaryToken, error) {
	*platform.events = append(*platform.events, "open-token")
	return platform.token, nil
}

func TestPrepareAppliesOnlyFixedRoleDACLsAfterIdentityPreflight(t *testing.T) {
	for _, role := range []config.Role{config.RoleControl, config.RoleExecutor} {
		t.Run(string(role), func(t *testing.T) {
			resolved, err := resolveRole(role)
			if err != nil {
				t.Fatal(err)
			}
			events := []string{}
			process := &fakeTarget{events: &events, label: "process-dacl"}
			token := &fakeToken{fakeTarget: fakeTarget{events: &events, label: "token-dacl"}}
			platform := &fakePlatform{events: &events, process: process, token: token, processID: 42}
			err = prepare(role, dependencies{
				platform: platform,
				identityPreflight: func(options winidentity.Options) (winidentity.Evidence, error) {
					events = append(events, "identity-preflight")
					if options.OwnService != resolved.own || options.PeerService != resolved.peer {
						t.Fatalf("identity options = %#v", options)
					}
					return winidentity.Evidence{
						ProcessID:   42,
						OwnService:  winidentity.ServiceEvidence{Name: resolved.own.Name, SID: resolved.own.SID},
						PeerService: winidentity.ServiceEvidence{Name: resolved.peer.Name, SID: resolved.peer.SID},
					}, nil
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			wantEvents := []string{"identity-preflight", "current-process", "open-token", "process-dacl", "token-dacl", "close-token"}
			if !reflect.DeepEqual(events, wantEvents) {
				t.Fatalf("events = %v, want %v", events, wantEvents)
			}
			processPolicy, tokenPolicy := policiesForRole(resolved)
			if !reflect.DeepEqual(process.policy, processPolicy) || !reflect.DeepEqual(token.policy, tokenPolicy) {
				t.Fatal("Prepare applied a non-fixed DACL policy")
			}
		})
	}
}

func TestPrepareFailsBeforeMutationAndAlwaysClosesOpenedToken(t *testing.T) {
	resolved, err := resolveRole(config.RoleControl)
	if err != nil {
		t.Fatal(err)
	}
	events := []string{}
	process := &fakeTarget{events: &events, label: "process-dacl", err: errors.New("process DACL failed")}
	token := &fakeToken{fakeTarget: fakeTarget{events: &events, label: "token-dacl"}, closeErr: errors.New("close failed")}
	platform := &fakePlatform{events: &events, process: process, token: token, processID: 42}
	err = prepare(config.RoleControl, dependencies{
		platform: platform,
		identityPreflight: func(winidentity.Options) (winidentity.Evidence, error) {
			return winidentity.Evidence{
				ProcessID:   42,
				OwnService:  winidentity.ServiceEvidence{Name: resolved.own.Name, SID: resolved.own.SID},
				PeerService: winidentity.ServiceEvidence{Name: resolved.peer.Name, SID: resolved.peer.SID},
			}, nil
		},
	})
	if err == nil || !strings.Contains(err.Error(), "process DACL failed") || !strings.Contains(err.Error(), "close failed") {
		t.Fatalf("prepare error = %v", err)
	}
	if !reflect.DeepEqual(events, []string{"current-process", "open-token", "process-dacl", "close-token"}) {
		t.Fatalf("events = %v", events)
	}
}

func TestRolePoliciesGrantOnlyRequiredPeerAccess(t *testing.T) {
	resolved, err := resolveRole(config.RoleControl)
	if err != nil {
		t.Fatal(err)
	}
	process, token := policiesForRole(resolved)
	if len(process.entries) != 4 || len(token.entries) != 4 {
		t.Fatalf("policy lengths = %d/%d", len(process.entries), len(token.entries))
	}
	if process.entries[3] != (accessEntry{sid: resolved.peer.SID, mask: processQueryLimitedAccessMask | synchronizeAccessMask}) {
		t.Fatalf("peer process ACE = %#v", process.entries[3])
	}
	if token.entries[3] != (accessEntry{sid: resolved.peer.SID, mask: tokenQueryAccessMask}) {
		t.Fatalf("peer token ACE = %#v", token.entries[3])
	}
	for _, entries := range [][]accessEntry{process.entries[:3], token.entries[:3]} {
		for _, entry := range entries {
			if entry.mask != genericAllAccessMask {
				t.Fatalf("full-access ACE = %#v", entry)
			}
		}
	}
}

func TestValidateDACLRejectsAnythingExceptTheExactProtectedPolicy(t *testing.T) {
	resolved, err := resolveRole(config.RoleControl)
	if err != nil {
		t.Fatal(err)
	}
	policy, _ := policiesForRole(resolved)
	valid := daclEvidence{
		control: securityDescriptorDACLPresent | securityDescriptorDACLProtected,
		present: true, protected: true, accessRules: append([]accessEntry(nil), policy.entries...),
	}
	tests := []struct {
		name   string
		mutate func(*daclEvidence)
	}{
		{"not protected", func(value *daclEvidence) { value.protected = false }},
		{"null", func(value *daclEvidence) { value.null = true }},
		{"defaulted", func(value *daclEvidence) { value.defaulted = true }},
		{"missing ACE", func(value *daclEvidence) { value.accessRules = value.accessRules[:3] }},
		{"extra ACE", func(value *daclEvidence) {
			value.accessRules = append(value.accessRules, accessEntry{sid: "S-1-1-0", mask: genericAllAccessMask})
		}},
		{"wrong peer mask", func(value *daclEvidence) { value.accessRules[3].mask = genericAllAccessMask }},
		{"wrong ACE type", func(value *daclEvidence) { value.accessRules[3].aceType = 1 }},
		{"inheritance flags", func(value *daclEvidence) { value.accessRules[3].flags = 1 }},
		{"duplicate SID", func(value *daclEvidence) { value.accessRules[3].sid = value.accessRules[2].sid }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := valid
			candidate.accessRules = append([]accessEntry(nil), valid.accessRules...)
			test.mutate(&candidate)
			if err := validateDACL(candidate, policy); !errors.Is(err, ErrDACLVerification) {
				t.Fatalf("validateDACL = %v, want ErrDACLVerification", err)
			}
		})
	}
}

func TestPrepareRejectsUnsupportedRoleBeforePreflight(t *testing.T) {
	called := false
	err := prepare(config.Role("other"), dependencies{
		platform: &fakePlatform{},
		identityPreflight: func(winidentity.Options) (winidentity.Evidence, error) {
			called = true
			return winidentity.Evidence{}, nil
		},
	})
	if !errors.Is(err, ErrInvalidRole) || called {
		t.Fatalf("Prepare = %v, preflight called = %v", err, called)
	}
}

func TestPrepareGateMakesEveryAttemptTerminal(t *testing.T) {
	gate := prepareGate{}
	resolved, err := resolveRole(config.RoleControl)
	if err != nil {
		t.Fatal(err)
	}
	events := []string{}
	process := &fakeTarget{events: &events, label: "process-dacl", err: errors.New("first attempt failed")}
	token := &fakeToken{fakeTarget: fakeTarget{events: &events, label: "token-dacl"}}
	deps := dependencies{
		platform: &fakePlatform{events: &events, process: process, token: token, processID: 42},
		identityPreflight: func(winidentity.Options) (winidentity.Evidence, error) {
			return winidentity.Evidence{
				ProcessID:   42,
				OwnService:  winidentity.ServiceEvidence{Name: resolved.own.Name, SID: resolved.own.SID},
				PeerService: winidentity.ServiceEvidence{Name: resolved.peer.Name, SID: resolved.peer.SID},
			}, nil
		},
	}
	if err := gate.run(config.RoleControl, deps); err == nil {
		t.Fatal("first failed attempt returned nil")
	}
	if err := gate.run(config.RoleControl, deps); !errors.Is(err, ErrAlreadyPrepared) {
		t.Fatalf("second attempt = %v, want ErrAlreadyPrepared", err)
	}
}
