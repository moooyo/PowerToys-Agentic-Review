package preflight

import (
	"errors"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peerverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winpipe"
)

func TestPeerVerificationPlanContainsOnlyFixedIdentityAndProvenance(t *testing.T) {
	for _, role := range []config.Role{config.RoleControl, config.RoleExecutor} {
		t.Run(string(role), func(t *testing.T) {
			fixture := newCompositionFixture(t, role)
			evidence, err := composeSnapshots(fixture.input)
			if err != nil {
				t.Fatal(err)
			}
			plan, err := evidence.PeerVerificationPlan()
			if err != nil {
				t.Fatal(err)
			}
			configuration := evidence.Configuration()
			if plan.Role() != role || plan.OwnService() != configuration.OwnService ||
				plan.PeerService() != configuration.PeerService || plan.PipeName() != configuration.PipeName {
				t.Fatalf("plan = %#v", plan)
			}
		})
	}
}

func TestPreflightPackageInitializationClaimsPeerVerifierAuthority(t *testing.T) {
	if productionPeerWindowsVerifierErr != nil {
		t.Fatalf("preflight peer verifier authority was not claimed: %v", productionPeerWindowsVerifierErr)
	}
}

func TestVerifyPeerWindowsAttestsBeforeAndAfterAndPassesOnlyRoleAndEndpoint(t *testing.T) {
	plan := mustPeerPlan(t, config.RoleControl)
	endpoint := new(winpipe.Endpoint)
	wantSession := new(peerverify.Session)
	attestCalls := 0
	verifyCalls := 0
	closeCalls := 0
	var captured peerVerificationRequest
	got, err := verifyPeerWindows(
		plan,
		endpoint,
		func() (peerEndpointAttestationFacts, error) {
			attestCalls++
			return validPeerAttestationFacts(plan), nil
		},
		func(request peerVerificationRequest) (*peerverify.Session, error) {
			verifyCalls++
			captured = request
			return wantSession, nil
		},
		func(*peerverify.Session) error {
			closeCalls++
			return nil
		},
	)
	if err != nil || got != wantSession || attestCalls != 2 || verifyCalls != 1 || closeCalls != 0 ||
		captured.role != config.RoleControl || captured.endpoint != endpoint {
		t.Fatalf("result=(%p,%v) attest=%d verify=%d close=%d request=%#v", got, err, attestCalls, verifyCalls, closeCalls, captured)
	}
}

func TestVerifyPeerWindowsRejectsEndpointMutationAndClosesSession(t *testing.T) {
	plan := mustPeerPlan(t, config.RoleControl)
	endpoint := new(winpipe.Endpoint)
	session := new(peerverify.Session)
	attestCalls := 0
	closeCalls := 0
	got, err := verifyPeerWindows(
		plan,
		endpoint,
		func() (peerEndpointAttestationFacts, error) {
			attestCalls++
			facts := validPeerAttestationFacts(plan)
			if attestCalls == 2 {
				facts.connected = false
			}
			return facts, nil
		},
		func(peerVerificationRequest) (*peerverify.Session, error) { return session, nil },
		func(value *peerverify.Session) error {
			closeCalls++
			if value != session {
				t.Fatal("closed wrong session")
			}
			return nil
		},
	)
	if got != nil || !errors.Is(err, ErrInvalidEvidence) || closeCalls != 1 {
		t.Fatalf("result=(%v,%v), close=%d", got, err, closeCalls)
	}
}

func TestVerifyPeerWindowsClosesSessionReturnedWithFailure(t *testing.T) {
	plan := mustPeerPlan(t, config.RoleExecutor)
	endpoint := new(winpipe.Endpoint)
	session := new(peerverify.Session)
	verifyFailure := errors.New("verify failed")
	closeFailure := errors.New("close failed")
	closeCalls := 0
	got, err := verifyPeerWindows(
		plan,
		endpoint,
		func() (peerEndpointAttestationFacts, error) { return validPeerAttestationFacts(plan), nil },
		func(peerVerificationRequest) (*peerverify.Session, error) { return session, verifyFailure },
		func(*peerverify.Session) error {
			closeCalls++
			return closeFailure
		},
	)
	if got != nil || !errors.Is(err, verifyFailure) || !errors.Is(err, closeFailure) ||
		!errors.Is(err, ErrPeerCleanupFatal) || closeCalls != rejectedPeerSessionCloseAttempts {
		t.Fatalf("result=(%v,%v), close=%d", got, err, closeCalls)
	}
}

func TestPeerVerificationPlanRejectsEveryMutableIdentityField(t *testing.T) {
	plan := mustPeerPlan(t, config.RoleControl)
	tests := []struct {
		name   string
		mutate func(*PeerVerificationPlan)
	}{
		{"valid", func(value *PeerVerificationPlan) { value.valid = false }},
		{"role", func(value *PeerVerificationPlan) { value.role = config.RoleExecutor }},
		{"own service", func(value *PeerVerificationPlan) { value.ownService.Name += ".other" }},
		{"peer service", func(value *PeerVerificationPlan) { value.peerService.SID = config.ControlServiceSID }},
		{"pipe", func(value *PeerVerificationPlan) { value.pipeName += ".other" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			mutated := plan
			test.mutate(&mutated)
			if err := mutated.Validate(); !errors.Is(err, ErrInvalidEvidence) {
				t.Fatalf("Validate error = %v", err)
			}
		})
	}
	if err := (PeerVerificationPlan{}).Validate(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("zero Validate error = %v", err)
	}
}

func TestPeerEndpointAttestationRequiresFixedRoleSecurity(t *testing.T) {
	for _, role := range []config.Role{config.RoleControl, config.RoleExecutor} {
		plan := mustPeerPlan(t, role)
		base := validPeerAttestationFacts(plan)
		tests := []struct {
			name   string
			mutate func(*peerEndpointAttestationFacts)
		}{
			{"invalid", func(value *peerEndpointAttestationFacts) { value.valid = false }},
			{"disconnected", func(value *peerEndpointAttestationFacts) { value.connected = false }},
			{"pipe", func(value *peerEndpointAttestationFacts) { value.pipeName += ".other" }},
			{"frame limit", func(value *peerEndpointAttestationFacts) { value.maximumFrameBytes++ }},
			{"side", func(value *peerEndpointAttestationFacts) { value.localSide = winpipe.EndpointSideUnknown }},
		}
		if role == config.RoleControl {
			tests = append(tests,
				struct {
					name   string
					mutate func(*peerEndpointAttestationFacts)
				}{"DACL", func(value *peerEndpointAttestationFacts) { value.serverDACL = false }},
				struct {
					name   string
					mutate func(*peerEndpointAttestationFacts)
				}{"own SID", func(value *peerEndpointAttestationFacts) { value.ownServiceSID = "" }},
			)
		} else {
			tests = append(tests, struct {
				name   string
				mutate func(*peerEndpointAttestationFacts)
			}{"client claims server DACL", func(value *peerEndpointAttestationFacts) { value.serverDACL = true }})
		}
		for _, test := range tests {
			t.Run(string(role)+"/"+test.name, func(t *testing.T) {
				facts := base
				test.mutate(&facts)
				if err := validatePeerEndpointAttestation(plan, facts); !errors.Is(err, ErrInvalidEvidence) {
					t.Fatalf("error = %v", err)
				}
			})
		}
	}
}

func TestVerifyPeerWindowsRejectsMissingInputsBeforeNativeVerify(t *testing.T) {
	plan := mustPeerPlan(t, config.RoleControl)
	verifyCalls := 0
	verify := func(peerVerificationRequest) (*peerverify.Session, error) {
		verifyCalls++
		return nil, nil
	}
	if _, err := verifyPeerWindows(plan, nil, nil, verify, nil); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("nil endpoint error = %v", err)
	}
	if verifyCalls != 0 {
		t.Fatal("native verifier ran for invalid input")
	}
}

func mustPeerPlan(t *testing.T, role config.Role) PeerVerificationPlan {
	t.Helper()
	fixture := newCompositionFixture(t, role)
	evidence, err := composeSnapshots(fixture.input)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := evidence.PeerVerificationPlan()
	if err != nil {
		t.Fatal(err)
	}
	return plan
}

func validPeerAttestationFacts(plan PeerVerificationPlan) peerEndpointAttestationFacts {
	facts := peerEndpointAttestationFacts{
		valid:             true,
		pipeName:          plan.pipeName,
		maximumFrameBytes: config.MaximumFrameBytes,
		connected:         true,
	}
	if plan.role == config.RoleControl {
		facts.localSide = winpipe.EndpointSideServer
		facts.ownServiceSID = plan.ownService.SID
		facts.peerServiceSID = plan.peerService.SID
		facts.serverDACL = true
	} else {
		facts.localSide = winpipe.EndpointSideClient
	}
	return facts
}
