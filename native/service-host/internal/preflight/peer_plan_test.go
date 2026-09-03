package preflight

import (
	"errors"
	"strings"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peerverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winpipe"
)

func TestPeerVerificationPlanAtomicallyMapsAttestedRoleInputs(t *testing.T) {
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
			if err := plan.Validate(); err != nil {
				t.Fatal(err)
			}
			preflightDigest, err := evidence.Digest()
			if err != nil {
				t.Fatal(err)
			}
			currentImage, ok := evidence.CurrentImageBinding()
			if !ok {
				t.Fatal("Evidence omitted current-image binding")
			}
			configuration := evidence.Configuration()
			expectedWrapper := configuration.Installation.Root + `\` + configuration.PeerService.Name + ".exe"
			if plan.Role() != role || plan.OwnService() != configuration.OwnService ||
				plan.PeerService() != configuration.PeerService || plan.PipeName() != configuration.PipeName ||
				!windowsPathEqual(plan.Wrapper().Path(), expectedWrapper) ||
				plan.Wrapper().SHA256() == "" || plan.ServiceHost().SHA256() == "" ||
				plan.ApprovedSignerCertificateDERSHA256() != evidence.ApprovedSignerCertificateDERSHA256() ||
				plan.PreflightDigest() != preflightDigest ||
				plan.ReleaseTemplateDigest() != evidence.ReleaseTemplateDigest() ||
				plan.CurrentImageDigest() != currentImage.SourceDigest() {
				t.Fatalf("plan omitted or selected wrong peer inputs: %#v", plan)
			}

			endpoint := new(winpipe.Endpoint)
			wantSession := new(peerverify.Session)
			var captured peerVerificationRequest
			attestCalls := 0
			verifyCalls := 0
			gotSession, err := verifyPeerWindows(
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
			)
			if err != nil || gotSession != wantSession || attestCalls != 2 || verifyCalls != 1 ||
				captured.role != role || captured.endpoint != endpoint ||
				captured.wrapper.Path != plan.Wrapper().Path() ||
				captured.wrapper.SHA256 != plan.Wrapper().SHA256() ||
				captured.serviceHost.Path != plan.ServiceHost().Path() ||
				captured.serviceHost.SHA256 != plan.ServiceHost().SHA256() ||
				captured.signerDERSHA != plan.ApprovedSignerCertificateDERSHA256() {
				t.Fatalf(
					"verify result=(%p,%v), attest=%d verify=%d options=%#v",
					gotSession,
					err,
					attestCalls,
					verifyCalls,
					captured,
				)
			}
		})
	}
}

func TestPreflightPackageInitializationClaimsPeerVerifierAuthority(t *testing.T) {
	if productionPeerWindowsVerifierErr != nil {
		t.Fatalf("preflight peer verifier authority was not claimed: %v", productionPeerWindowsVerifierErr)
	}
}

func TestPeerVerificationPlanRejectsSecondAttestationFailureOrMutation(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleControl)
	evidence, err := composeSnapshots(fixture.input)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := evidence.PeerVerificationPlan()
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name     string
		afterErr error
		mutate   func(*peerEndpointAttestationFacts)
		want     error
	}{
		{"closed", winpipe.ErrClosed, nil, winpipe.ErrClosed},
		{"fatal", winpipe.ErrIOUnresolvedFatal, nil, winpipe.ErrIOUnresolvedFatal},
		{"changed", nil, func(value *peerEndpointAttestationFacts) { value.pipeName += ".changed" }, ErrInvalidEvidence},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			attestCalls := 0
			verifyCalls := 0
			closeCalls := 0
			session := new(peerverify.Session)
			got, err := verifyPeerWindowsWithLifecycle(
				plan,
				new(winpipe.Endpoint),
				func() (peerEndpointAttestationFacts, error) {
					attestCalls++
					if attestCalls == 2 && test.afterErr != nil {
						return peerEndpointAttestationFacts{}, test.afterErr
					}
					facts := validPeerAttestationFacts(plan)
					if attestCalls == 2 && test.mutate != nil {
						test.mutate(&facts)
					}
					return facts, nil
				},
				func(peerVerificationRequest) (*peerverify.Session, error) {
					verifyCalls++
					return session, nil
				},
				func(observed *peerverify.Session) error {
					closeCalls++
					if observed != session {
						return errors.New("closed a different peer session")
					}
					return nil
				},
				&peerSessionLifetimeQuarantine{},
			)
			if got != nil || !errors.Is(err, test.want) || attestCalls != 2 ||
				verifyCalls != 1 || closeCalls != 1 {
				t.Fatalf(
					"result=(%p,%v), attest=%d verify=%d close=%d",
					got,
					err,
					attestCalls,
					verifyCalls,
					closeCalls,
				)
			}
		})
	}
}

func TestRejectedPeerSessionCleanupRetriesAndQuarantinesPersistentFailure(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleExecutor)
	evidence, err := composeSnapshots(fixture.input)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := evidence.PeerVerificationPlan()
	if err != nil {
		t.Fatal(err)
	}
	session := new(peerverify.Session)
	rejection := winpipe.ErrClosed

	t.Run("retry succeeds", func(t *testing.T) {
		quarantine := &peerSessionLifetimeQuarantine{}
		firstClose := errors.New("first close failed")
		closeCalls := 0
		attestCalls := 0
		got, err := verifyPeerWindowsWithLifecycle(
			plan,
			new(winpipe.Endpoint),
			func() (peerEndpointAttestationFacts, error) {
				attestCalls++
				if attestCalls == 2 {
					return peerEndpointAttestationFacts{}, rejection
				}
				return validPeerAttestationFacts(plan), nil
			},
			func(peerVerificationRequest) (*peerverify.Session, error) { return session, nil },
			func(*peerverify.Session) error {
				closeCalls++
				if closeCalls == 1 {
					return firstClose
				}
				return nil
			},
			quarantine,
		)
		if got != nil || !errors.Is(err, rejection) || !errors.Is(err, firstClose) ||
			errors.Is(err, ErrPeerCleanupFatal) || closeCalls != 2 || quarantine.count() != 0 {
			t.Fatalf("result=(%p,%v), close=%d quarantine=%d", got, err, closeCalls, quarantine.count())
		}
	})

	t.Run("persistent failure", func(t *testing.T) {
		quarantine := &peerSessionLifetimeQuarantine{}
		closeErrors := []error{
			errors.New("close attempt one"),
			errors.New("close attempt two"),
			errors.New("close attempt three"),
		}
		closeCalls := 0
		attestCalls := 0
		got, err := verifyPeerWindowsWithLifecycle(
			plan,
			new(winpipe.Endpoint),
			func() (peerEndpointAttestationFacts, error) {
				attestCalls++
				if attestCalls == 2 {
					return peerEndpointAttestationFacts{}, rejection
				}
				return validPeerAttestationFacts(plan), nil
			},
			func(peerVerificationRequest) (*peerverify.Session, error) { return session, nil },
			func(*peerverify.Session) error {
				err := closeErrors[closeCalls]
				closeCalls++
				return err
			},
			quarantine,
		)
		if got != nil || !errors.Is(err, rejection) || !errors.Is(err, ErrPeerCleanupFatal) ||
			closeCalls != rejectedPeerSessionCloseAttempts || quarantine.count() != 1 {
			t.Fatalf("result=(%p,%v), close=%d quarantine=%d", got, err, closeCalls, quarantine.count())
		}
		for _, closeErr := range closeErrors {
			if !errors.Is(err, closeErr) {
				t.Fatalf("cleanup error omitted %v: %v", closeErr, err)
			}
		}
		quarantine.mu.RLock()
		retained := append([]*peerverify.Session(nil), quarantine.owners...)
		quarantine.mu.RUnlock()
		if len(retained) != 1 || retained[0] != session {
			t.Fatalf("quarantine retained %v, want session %p", retained, session)
		}

		attestCalled := false
		verifyCalled := false
		got, secondErr := verifyPeerWindowsWithLifecycle(
			plan,
			new(winpipe.Endpoint),
			func() (peerEndpointAttestationFacts, error) {
				attestCalled = true
				return validPeerAttestationFacts(plan), nil
			},
			func(peerVerificationRequest) (*peerverify.Session, error) {
				verifyCalled = true
				return new(peerverify.Session), nil
			},
			func(*peerverify.Session) error { return nil },
			quarantine,
		)
		if got != nil || !errors.Is(secondErr, ErrPeerCleanupFatal) || attestCalled || verifyCalled {
			t.Fatalf("post-fatal result=(%p,%v), attest=%v verify=%v", got, secondErr, attestCalled, verifyCalled)
		}
	})

	t.Run("invalid native handle stops retry", func(t *testing.T) {
		quarantine := &peerSessionLifetimeQuarantine{}
		closeCalls := 0
		attestCalls := 0
		got, err := verifyPeerWindowsWithLifecycle(
			plan,
			new(winpipe.Endpoint),
			func() (peerEndpointAttestationFacts, error) {
				attestCalls++
				if attestCalls == 2 {
					return peerEndpointAttestationFacts{}, rejection
				}
				return validPeerAttestationFacts(plan), nil
			},
			func(peerVerificationRequest) (*peerverify.Session, error) { return session, nil },
			func(*peerverify.Session) error {
				closeCalls++
				return peerverify.ErrNativeHandleOwnershipFatal
			},
			quarantine,
		)
		if got != nil || !errors.Is(err, rejection) ||
			!errors.Is(err, peerverify.ErrNativeHandleOwnershipFatal) ||
			!errors.Is(err, ErrPeerCleanupFatal) || closeCalls != 1 || quarantine.count() != 1 {
			t.Fatalf("result=(%p,%v), close=%d quarantine=%d", got, err, closeCalls, quarantine.count())
		}
	})

	t.Run("fatal published before return", func(t *testing.T) {
		quarantine := &peerSessionLifetimeQuarantine{}
		blocker := new(peerverify.Session)
		closeCalls := 0
		got, err := verifyPeerWindowsWithLifecycle(
			plan,
			new(winpipe.Endpoint),
			func() (peerEndpointAttestationFacts, error) { return validPeerAttestationFacts(plan), nil },
			func(peerVerificationRequest) (*peerverify.Session, error) {
				_ = quarantine.retain(blocker, errors.New("concurrent peer cleanup fatal"))
				return session, nil
			},
			func(observed *peerverify.Session) error {
				closeCalls++
				if observed != session {
					return errors.New("closed a different peer session")
				}
				return nil
			},
			quarantine,
		)
		if got != nil || !errors.Is(err, ErrPeerCleanupFatal) || closeCalls != 1 || quarantine.count() != 1 {
			t.Fatalf("result=(%p,%v), close=%d quarantine=%d", got, err, closeCalls, quarantine.count())
		}
	})

	t.Run("native owner fatal published before commit", func(t *testing.T) {
		quarantine := &peerSessionLifetimeQuarantine{}
		nativeFatal := errors.Join(
			peerverify.ErrNativeHandleOwnershipFatal,
			errors.New("concurrent native owner quarantine"),
		)
		closeCalls := 0
		got, err := verifyPeerWindowsWithLifecycleAndCommit(
			plan,
			new(winpipe.Endpoint),
			func() (peerEndpointAttestationFacts, error) { return validPeerAttestationFacts(plan), nil },
			func(peerVerificationRequest) (*peerverify.Session, error) { return session, nil },
			func(observed *peerverify.Session) error {
				closeCalls++
				if observed != session {
					return errors.New("closed a different peer session")
				}
				return nil
			},
			quarantine,
			func() (func(), error) { return func() {}, nativeFatal },
		)
		if got != nil || !errors.Is(err, peerverify.ErrNativeHandleOwnershipFatal) ||
			!errors.Is(err, ErrPeerCleanupFatal) || closeCalls != 1 || quarantine.count() != 0 {
			t.Fatalf("result=(%p,%v), close=%d quarantine=%d", got, err, closeCalls, quarantine.count())
		}
		attestCalled := false
		verifyCalled := false
		got, secondErr := verifyPeerWindowsWithLifecycleAndCommit(
			plan,
			new(winpipe.Endpoint),
			func() (peerEndpointAttestationFacts, error) {
				attestCalled = true
				return validPeerAttestationFacts(plan), nil
			},
			func(peerVerificationRequest) (*peerverify.Session, error) {
				verifyCalled = true
				return new(peerverify.Session), nil
			},
			func(*peerverify.Session) error { return nil },
			quarantine,
			func() (func(), error) { return func() {}, nil },
		)
		if got != nil || !errors.Is(secondErr, ErrPeerCleanupFatal) || attestCalled || verifyCalled {
			t.Fatalf("post-native-fatal result=(%p,%v), attest=%v verify=%v", got, secondErr, attestCalled, verifyCalled)
		}
	})
}

func TestPeerVerificationPlanIsCopyOnly(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleExecutor)
	evidence, err := composeSnapshots(fixture.input)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := evidence.PeerVerificationPlan()
	if err != nil {
		t.Fatal(err)
	}
	originalWrapper := plan.Wrapper()
	originalServiceHost := plan.ServiceHost()
	copy := plan
	copy.wrapper.path = `C:\Changed\wrapper.exe`
	copy.serviceHost.sha256 = strings.Repeat("a", 64)
	fixture.installation.files[0].AbsolutePath = `C:\Changed\from-installation.exe`
	if plan.Wrapper() != originalWrapper || plan.ServiceHost() != originalServiceHost {
		t.Fatal("PeerVerificationPlan copy exposed mutable internal storage")
	}
}

func TestPeerVerificationPlanRejectsZeroAndBoundMutations(t *testing.T) {
	if _, err := (Evidence{}).PeerVerificationPlan(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("zero Evidence.PeerVerificationPlan = %v", err)
	}
	if err := (PeerVerificationPlan{}).Validate(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("zero plan Validate = %v", err)
	}
	if _, err := (PeerVerificationPlan{}).VerifyWindows(nil); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("zero plan VerifyWindows = %v", err)
	}
	fixture := newCompositionFixture(t, config.RoleExecutor)
	evidence, err := composeSnapshots(fixture.input)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := evidence.PeerVerificationPlan()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := plan.VerifyWindows(nil); err == nil {
		t.Fatal("VerifyWindows accepted a nil endpoint")
	}
	if _, err := plan.VerifyWindows(new(winpipe.Endpoint)); err == nil {
		t.Fatal("VerifyWindows accepted a zero endpoint")
	}
	corruptedEvidence := cloneEvidenceForDigestTest(evidence)
	corruptedEvidence.dataRoot.digest[0] ^= 0xff
	if _, err := corruptedEvidence.PeerVerificationPlan(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("corrupted Evidence.PeerVerificationPlan = %v", err)
	}
	tests := []struct {
		name   string
		mutate func(*PeerVerificationPlan)
	}{
		{"valid marker", func(value *PeerVerificationPlan) { value.valid = false }},
		{"role", func(value *PeerVerificationPlan) { value.role = config.RoleControl }},
		{"own service", func(value *PeerVerificationPlan) { value.ownService.Name += ".other" }},
		{"peer service", func(value *PeerVerificationPlan) { value.peerService.SID = config.ExecutorServiceSID }},
		{"pipe", func(value *PeerVerificationPlan) { value.pipeName += ".other" }},
		{"root", func(value *PeerVerificationPlan) { value.installationRoot += `\other` }},
		{"wrapper path", func(value *PeerVerificationPlan) { value.wrapper.path += ".other" }},
		{"wrapper digest", func(value *PeerVerificationPlan) { value.wrapper.sha256 = "bad" }},
		{"ServiceHost path", func(value *PeerVerificationPlan) { value.serviceHost.path += ".other" }},
		{"ServiceHost digest", func(value *PeerVerificationPlan) { value.serviceHost.sha256 = "bad" }},
		{"signer", func(value *PeerVerificationPlan) { value.approvedSignerPin = "bad" }},
		{"preflight digest", func(value *PeerVerificationPlan) { value.preflightDigest = [32]byte{} }},
		{"release digest", func(value *PeerVerificationPlan) { value.releaseDigest = [32]byte{} }},
		{"current image digest", func(value *PeerVerificationPlan) { value.currentImageDigest = [32]byte{} }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := plan
			test.mutate(&candidate)
			if err := candidate.Validate(); !errors.Is(err, ErrInvalidEvidence) {
				t.Fatalf("Validate = %v, want ErrInvalidEvidence", err)
			}
		})
	}
}

func TestPeerVerificationPlanRejectsEveryAttestationMismatchBeforeVerify(t *testing.T) {
	type attestationMutation struct {
		name   string
		mutate func(*peerEndpointAttestationFacts)
	}
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
			tests := []attestationMutation{
				{"invalid", func(value *peerEndpointAttestationFacts) { value.valid = false }},
				{"pipe", func(value *peerEndpointAttestationFacts) { value.pipeName += ".other" }},
				{"frame bound", func(value *peerEndpointAttestationFacts) { value.maximumFrameBytes-- }},
				{"disconnected", func(value *peerEndpointAttestationFacts) { value.connected = false }},
				{"side", func(value *peerEndpointAttestationFacts) {
					if role == config.RoleControl {
						value.localSide = winpipe.EndpointSideClient
					} else {
						value.localSide = winpipe.EndpointSideServer
					}
				}},
			}
			if role == config.RoleControl {
				tests = append(tests,
					attestationMutation{"DACL", func(value *peerEndpointAttestationFacts) { value.serverDACL = false }},
					attestationMutation{"own SID", func(value *peerEndpointAttestationFacts) { value.ownServiceSID = config.ExecutorServiceSID }},
					attestationMutation{"peer SID", func(value *peerEndpointAttestationFacts) { value.peerServiceSID = config.ControlServiceSID }},
				)
			} else {
				tests = append(tests,
					attestationMutation{"DACL", func(value *peerEndpointAttestationFacts) { value.serverDACL = true }},
					attestationMutation{"own SID", func(value *peerEndpointAttestationFacts) { value.ownServiceSID = config.ExecutorServiceSID }},
					attestationMutation{"peer SID", func(value *peerEndpointAttestationFacts) { value.peerServiceSID = config.ControlServiceSID }},
				)
			}
			for _, test := range tests {
				t.Run(test.name, func(t *testing.T) {
					facts := validPeerAttestationFacts(plan)
					test.mutate(&facts)
					verifyCalled := false
					_, err := verifyPeerWindows(
						plan,
						new(winpipe.Endpoint),
						func() (peerEndpointAttestationFacts, error) { return facts, nil },
						func(peerVerificationRequest) (*peerverify.Session, error) {
							verifyCalled = true
							return new(peerverify.Session), nil
						},
					)
					if verifyCalled {
						t.Fatal("peer verifier ran before rejecting attestation mismatch")
					}
					assertPreflightErrorCode(t, err, ErrorPeerVerification)
				})
			}
		})
	}
}

func TestPeerVerificationPlanPropagatesEndpointFailureWithoutVerify(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleControl)
	evidence, err := composeSnapshots(fixture.input)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := evidence.PeerVerificationPlan()
	if err != nil {
		t.Fatal(err)
	}
	for _, endpointErr := range []error{winpipe.ErrClosed, winpipe.ErrIOUnresolvedFatal} {
		t.Run(endpointErr.Error(), func(t *testing.T) {
			verifyCalled := false
			_, err := verifyPeerWindows(
				plan,
				new(winpipe.Endpoint),
				func() (peerEndpointAttestationFacts, error) {
					return peerEndpointAttestationFacts{}, endpointErr
				},
				func(peerVerificationRequest) (*peerverify.Session, error) {
					verifyCalled = true
					return new(peerverify.Session), nil
				},
			)
			if verifyCalled || !errors.Is(err, endpointErr) {
				t.Fatalf("verifyCalled=%v error=%v, want %v", verifyCalled, err, endpointErr)
			}
		})
	}

	invalid := plan
	invalid.valid = false
	attestCalled := false
	_, err = verifyPeerWindows(
		invalid,
		new(winpipe.Endpoint),
		func() (peerEndpointAttestationFacts, error) {
			attestCalled = true
			return validPeerAttestationFacts(plan), nil
		},
		func(peerVerificationRequest) (*peerverify.Session, error) {
			return new(peerverify.Session), nil
		},
	)
	if attestCalled || !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("invalid plan attestation order = called:%v error:%v", attestCalled, err)
	}

	verifyFailure := errors.New("peer verification failed")
	_, err = verifyPeerWindows(
		plan,
		new(winpipe.Endpoint),
		func() (peerEndpointAttestationFacts, error) { return validPeerAttestationFacts(plan), nil },
		func(peerVerificationRequest) (*peerverify.Session, error) { return nil, verifyFailure },
	)
	if !errors.Is(err, verifyFailure) {
		t.Fatalf("peer verifier error = %v, want %v", err, verifyFailure)
	}
	nativeOwnerFatal := errors.Join(peerverify.ErrNativeHandleOwnershipFatal, errors.New("raw verifier retained native owner"))
	quarantine := &peerSessionLifetimeQuarantine{}
	attestCalls := 0
	got, err := verifyPeerWindowsWithLifecycle(
		plan,
		new(winpipe.Endpoint),
		func() (peerEndpointAttestationFacts, error) {
			attestCalls++
			return validPeerAttestationFacts(plan), nil
		},
		func(peerVerificationRequest) (*peerverify.Session, error) { return nil, nativeOwnerFatal },
		func(*peerverify.Session) error { return errors.New("nil session must not be closed") },
		quarantine,
	)
	if got != nil || !errors.Is(err, peerverify.ErrNativeHandleOwnershipFatal) ||
		!errors.Is(err, ErrPeerCleanupFatal) || attestCalls != 1 || quarantine.count() != 0 {
		t.Fatalf("raw owner fatal result=(%p,%v), attest=%d quarantine=%d", got, err, attestCalls, quarantine.count())
	}
	attestCalled = false
	verifyCalled := false
	got, secondErr := verifyPeerWindowsWithLifecycle(
		plan,
		new(winpipe.Endpoint),
		func() (peerEndpointAttestationFacts, error) {
			attestCalled = true
			return validPeerAttestationFacts(plan), nil
		},
		func(peerVerificationRequest) (*peerverify.Session, error) {
			verifyCalled = true
			return new(peerverify.Session), nil
		},
		func(*peerverify.Session) error { return nil },
		quarantine,
	)
	if got != nil || !errors.Is(secondErr, ErrPeerCleanupFatal) || attestCalled || verifyCalled {
		t.Fatalf("post-native-fatal result=(%p,%v), attest=%v verify=%v", got, secondErr, attestCalled, verifyCalled)
	}
	returnedSession := new(peerverify.Session)
	closeCalls := 0
	quarantine = &peerSessionLifetimeQuarantine{}
	got, err = verifyPeerWindowsWithLifecycle(
		plan,
		new(winpipe.Endpoint),
		func() (peerEndpointAttestationFacts, error) { return validPeerAttestationFacts(plan), nil },
		func(peerVerificationRequest) (*peerverify.Session, error) { return returnedSession, verifyFailure },
		func(observed *peerverify.Session) error {
			closeCalls++
			if observed != returnedSession {
				return errors.New("closed a different peer session")
			}
			return nil
		},
		quarantine,
	)
	if got != nil || !errors.Is(err, verifyFailure) || closeCalls != 1 || quarantine.count() != 0 {
		t.Fatalf("rejected verifier session=(%p,%v), close=%d quarantine=%d", got, err, closeCalls, quarantine.count())
	}
	persistentCloseFailure := errors.New("rejected verifier session close failed")
	closeCalls = 0
	attestCalls = 0
	quarantine = &peerSessionLifetimeQuarantine{}
	got, err = verifyPeerWindowsWithLifecycle(
		plan,
		new(winpipe.Endpoint),
		func() (peerEndpointAttestationFacts, error) {
			attestCalls++
			return validPeerAttestationFacts(plan), nil
		},
		func(peerVerificationRequest) (*peerverify.Session, error) { return returnedSession, verifyFailure },
		func(observed *peerverify.Session) error {
			closeCalls++
			if observed != returnedSession {
				return errors.New("closed a different peer session")
			}
			return persistentCloseFailure
		},
		quarantine,
	)
	if got != nil || !errors.Is(err, verifyFailure) || !errors.Is(err, persistentCloseFailure) ||
		!errors.Is(err, ErrPeerCleanupFatal) || attestCalls != 1 ||
		closeCalls != rejectedPeerSessionCloseAttempts || quarantine.count() != 1 {
		t.Fatalf(
			"persistent rejected verifier session=(%p,%v), attest=%d close=%d quarantine=%d",
			got,
			err,
			attestCalls,
			closeCalls,
			quarantine.count(),
		)
	}
	quarantine.mu.RLock()
	retained := append([]*peerverify.Session(nil), quarantine.owners...)
	quarantine.mu.RUnlock()
	if len(retained) != 1 || retained[0] != returnedSession {
		t.Fatalf("quarantine retained %v, want rejected session %p", retained, returnedSession)
	}
	_, err = verifyPeerWindows(
		plan,
		new(winpipe.Endpoint),
		func() (peerEndpointAttestationFacts, error) { return validPeerAttestationFacts(plan), nil },
		func(peerVerificationRequest) (*peerverify.Session, error) { return nil, nil },
	)
	assertPreflightErrorCode(t, err, ErrorPeerVerification)
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

func TestPeerVerificationFileSelectionRequiresFixedWrappersAndUniqueServiceHost(t *testing.T) {
	fixture := newCompositionFixture(t, config.RoleControl)
	configuration := cloneConfig(fixture.control)
	tests := []struct {
		name   string
		mutate func([]VerifiedFile) []VerifiedFile
	}{
		{"missing peer wrapper", func(files []VerifiedFile) []VerifiedFile {
			for index := range files {
				if files[index].Role == serviceWrapperVerificationRole &&
					strings.EqualFold(files[index].Path, configuration.PeerService.Name+".exe") {
					files[index].Role = releasemanifest.RoleRuntimeData
				}
			}
			return files
		}},
		{"missing own wrapper", func(files []VerifiedFile) []VerifiedFile {
			for index := range files {
				if files[index].Role == serviceWrapperVerificationRole &&
					strings.EqualFold(files[index].Path, configuration.OwnService.Name+".exe") {
					files[index].Path = `other.exe`
				}
			}
			return files
		}},
		{"duplicate peer wrapper", func(files []VerifiedFile) []VerifiedFile {
			for _, file := range files {
				if file.Role == serviceWrapperVerificationRole &&
					strings.EqualFold(file.Path, configuration.PeerService.Name+".exe") {
					return append(files, cloneFile(file))
				}
			}
			return files
		}},
		{"extra ServiceHost", func(files []VerifiedFile) []VerifiedFile {
			for _, file := range files {
				if file.Role == releasemanifest.RoleServiceHost {
					file.Path = `native\other-service-host.exe`
					file.AbsolutePath = configuration.Installation.Root + `\` + file.Path
					return append(files, file)
				}
			}
			return files
		}},
		{"ServiceHost wrong root", func(files []VerifiedFile) []VerifiedFile {
			for index := range files {
				if files[index].Role == releasemanifest.RoleServiceHost {
					files[index].Root = releasemanifest.RootTrustedConfiguration
				}
			}
			return files
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			files := cloneFiles(fixture.installation.files)
			files = test.mutate(files)
			_, _, err := selectPeerVerificationFiles(configuration, files, fixture.installation.release)
			assertPreflightErrorCode(t, err, ErrorPeerVerification)
		})
	}
}
