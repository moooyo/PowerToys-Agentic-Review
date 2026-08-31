package servicebootstrap

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peerverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winprocess"
)

const (
	testOwnServiceSID  = "S-1-5-80-1-2-3-4-5"
	testPeerServiceSID = "S-1-5-80-6-7-8-9-10"
)

type fakeSCMService struct {
	statuses   []ServiceObservation
	statusCall int
	closeCalls int
	closeErrs  []error
	events     *[]string
}

func (s *fakeSCMService) Status() (ServiceObservation, error) {
	*s.events = append(*s.events, "scm-status")
	if s.statusCall >= len(s.statuses) {
		return ServiceObservation{}, errors.New("unexpected SCM status call")
	}
	status := s.statuses[s.statusCall]
	s.statusCall++
	return status, nil
}

func (s *fakeSCMService) Close() error {
	*s.events = append(*s.events, "close-scm")
	index := s.closeCalls
	s.closeCalls++
	if index < len(s.closeErrs) {
		return s.closeErrs[index]
	}
	return nil
}

type fakeProcess struct {
	processID     uint32
	active        bool
	creationTimes []time.Time
	creationCalls int
	startKeys     []peerverify.ProcessStartKey
	startKeyCalls int
	daclOverride  *DACLEvidence
	daclPolicies  []daclPolicy
	closeErrs     []error
	closeCalls    int
	closed        bool
	events        *[]string
}

func (p *fakeProcess) HandleProcessID() (uint32, error) {
	*p.events = append(*p.events, "process-pid")
	if p.closed {
		return 0, ErrClosed
	}
	return p.processID, nil
}

func (p *fakeProcess) StillActive() (bool, error) {
	*p.events = append(*p.events, "process-active")
	if p.closed {
		return false, ErrClosed
	}
	return p.active, nil
}

func (p *fakeProcess) HandleCreationTime() (time.Time, error) {
	*p.events = append(*p.events, "process-created")
	if p.closed {
		return time.Time{}, ErrClosed
	}
	index := p.creationCalls
	p.creationCalls++
	if index >= len(p.creationTimes) {
		index = len(p.creationTimes) - 1
	}
	return p.creationTimes[index], nil
}

func (p *fakeProcess) HandleStartKey() (peerverify.ProcessStartKey, error) {
	*p.events = append(*p.events, "process-start-key")
	if p.closed {
		return peerverify.ProcessStartKey{}, ErrClosed
	}
	index := p.startKeyCalls
	p.startKeyCalls++
	if index >= len(p.startKeys) {
		index = len(p.startKeys) - 1
	}
	return p.startKeys[index], nil
}

func (p *fakeProcess) ApplyAndVerifyDACL(policy daclPolicy) (DACLEvidence, error) {
	*p.events = append(*p.events, "process-dacl")
	p.daclPolicies = append(p.daclPolicies, policy)
	if p.daclOverride != nil {
		return cloneDACLEvidence(*p.daclOverride), nil
	}
	return exactDACLEvidence(policy), nil
}

func (p *fakeProcess) ImagePathDiagnostic() (string, error) {
	return `C:\Program Files\AgenticReview\winsw.exe`, nil
}

func (p *fakeProcess) OpenImage() (peerverify.ImageSubject, error) {
	return nil, errors.New("not used by bootstrap tests")
}

func (p *fakeProcess) Wait(ctx context.Context) error {
	*p.events = append(*p.events, "process-wait")
	return ctx.Err()
}

func (p *fakeProcess) Close() error {
	*p.events = append(*p.events, "close-wrapper")
	index := p.closeCalls
	p.closeCalls++
	if index < len(p.closeErrs) && p.closeErrs[index] != nil {
		return p.closeErrs[index]
	}
	p.closed = true
	return nil
}

type fakeCurrentProcess struct {
	*fakeProcess
	parents     []uint32
	parentCalls int
}

func (p *fakeCurrentProcess) DirectParentProcessID() (uint32, error) {
	*p.events = append(*p.events, "current-parent")
	index := p.parentCalls
	p.parentCalls++
	if index >= len(p.parents) {
		index = len(p.parents) - 1
	}
	return p.parents[index], nil
}

type fakeToken struct {
	daclOverride *DACLEvidence
	policies     []daclPolicy
	closeErrs    []error
	closeCalls   int
	closed       bool
	events       *[]string
}

func (t *fakeToken) ApplyAndVerifyDACL(policy daclPolicy) (DACLEvidence, error) {
	*t.events = append(*t.events, "token-dacl")
	t.policies = append(t.policies, policy)
	if t.daclOverride != nil {
		return cloneDACLEvidence(*t.daclOverride), nil
	}
	return exactDACLEvidence(policy), nil
}

func (t *fakeToken) Close() error {
	*t.events = append(*t.events, "close-token")
	index := t.closeCalls
	t.closeCalls++
	if index < len(t.closeErrs) && t.closeErrs[index] != nil {
		return t.closeErrs[index]
	}
	t.closed = true
	return nil
}

type fakePlatform struct {
	service          *fakeSCMService
	wrapper          *fakeProcess
	current          *fakeCurrentProcess
	token            *fakeToken
	openWrapperCalls []uint32
	events           *[]string
}

type blockingPlatform struct {
	bootstrapPlatform
	entered chan struct{}
	release chan struct{}
}

func (p blockingPlatform) OpenSCMService(name string) (scmStatusSource, error) {
	close(p.entered)
	<-p.release
	return p.bootstrapPlatform.OpenSCMService(name)
}

func (p *fakePlatform) OpenSCMService(string) (scmStatusSource, error) {
	*p.events = append(*p.events, "open-service")
	return p.service, nil
}

func (p *fakePlatform) OpenWrapperProcess(processID uint32) (wrapperProcess, error) {
	*p.events = append(*p.events, "open-wrapper")
	p.openWrapperCalls = append(p.openWrapperCalls, processID)
	return p.wrapper, nil
}

func (p *fakePlatform) CurrentProcess() (currentProcess, error) {
	*p.events = append(*p.events, "current-process")
	return p.current, nil
}

func (p *fakePlatform) OpenCurrentPrimaryToken() (primaryToken, error) {
	*p.events = append(*p.events, "open-token")
	return p.token, nil
}

func TestOpenUsesOneSCMObservedWrapperForWatcherAndPeerVerification(t *testing.T) {
	platform, wrapperCreated, hostCreated := newSuccessfulFakePlatform()
	session, err := openWithPlatform(validOptions(), platform)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := session.Close(); err != nil {
			t.Fatal(err)
		}
	}()

	if !reflect.DeepEqual(platform.openWrapperCalls, []uint32{41}) {
		t.Fatalf("wrapper opens = %v, want one open for PID 41", platform.openWrapperCalls)
	}
	if platform.service.statusCall != 2 {
		t.Fatalf("SCM status calls = %d, want 2", platform.service.statusCall)
	}
	var watcher winprocess.WrapperWatcher = session
	var stable peerverify.StableWrapper = session
	if watcher.ProcessID() != 41 || !watcher.CreationTime().Equal(wrapperCreated) {
		t.Fatalf("watcher facts = (%d, %v)", watcher.ProcessID(), watcher.CreationTime())
	}
	if stable.StableFacts() != (peerverify.StableProcessFacts{
		ProcessID:    41,
		CreationTime: wrapperCreated,
		StartKey:     peerverify.ProcessStartKey{Available: true, SequenceNumber: 100},
	}) {
		t.Fatalf("stable wrapper facts = %+v", stable.StableFacts())
	}
	if processID, err := stable.HandleProcessID(); err != nil || processID != 41 {
		t.Fatalf("stable handle PID = %d, error = %v", processID, err)
	}

	evidence := session.Evidence()
	if evidence.SCMBeforeOpen != evidence.SCMAfterOpen ||
		evidence.DirectParentProcessID != 41 ||
		!evidence.StableServiceHostFacts.CreationTime.Equal(hostCreated) {
		t.Fatalf("unexpected evidence: %+v", evidence)
	}
	if len(platform.current.daclPolicies) != 1 || len(platform.wrapper.daclPolicies) != 1 ||
		len(platform.token.policies) != 1 {
		t.Fatal("all three bootstrap DACL targets were not applied exactly once")
	}
	peerProcessACE := platform.wrapper.daclPolicies[0].entries[3]
	if peerProcessACE.SID != testPeerServiceSID ||
		peerProcessACE.Mask != processQueryLimitedAccessMask|synchronizeAccessMask {
		t.Fatalf("peer process ACE = %+v", peerProcessACE)
	}
	peerTokenACE := platform.token.policies[0].entries[3]
	if peerTokenACE.SID != testPeerServiceSID || peerTokenACE.Mask != tokenQueryAccessMask {
		t.Fatalf("peer token ACE = %+v", peerTokenACE)
	}
}

func TestServiceDACLPoliciesGrantOnlyReviewedRights(t *testing.T) {
	processPolicy, tokenPolicy, err := serviceDACLPolicies(testOwnServiceSID, testPeerServiceSID)
	if err != nil {
		t.Fatal(err)
	}
	base := []AccessEntry{
		{SID: localSystemSID, Mask: genericAllAccessMask, ACEType: accessAllowedACEType, Flags: noACEFlags},
		{SID: builtinAdministratorsSID, Mask: genericAllAccessMask, ACEType: accessAllowedACEType, Flags: noACEFlags},
		{SID: testOwnServiceSID, Mask: genericAllAccessMask, ACEType: accessAllowedACEType, Flags: noACEFlags},
	}
	wantProcess := append(append([]AccessEntry(nil), base...), AccessEntry{
		SID:     testPeerServiceSID,
		Mask:    processQueryLimitedAccessMask | synchronizeAccessMask,
		ACEType: accessAllowedACEType,
		Flags:   noACEFlags,
	})
	wantToken := append(append([]AccessEntry(nil), base...), AccessEntry{
		SID:     testPeerServiceSID,
		Mask:    tokenQueryAccessMask,
		ACEType: accessAllowedACEType,
		Flags:   noACEFlags,
	})
	if !reflect.DeepEqual(processPolicy.entries, wantProcess) {
		t.Fatalf("process DACL policy = %#v, want %#v", processPolicy.entries, wantProcess)
	}
	if !reflect.DeepEqual(tokenPolicy.entries, wantToken) {
		t.Fatalf("token DACL policy = %#v, want %#v", tokenPolicy.entries, wantToken)
	}
}

func TestBootstrapGateAllowsOnlyOneProcessWideAttempt(t *testing.T) {
	gate := &bootstrapGate{}
	firstPlatform, _, _ := newSuccessfulFakePlatform()
	entered := make(chan struct{})
	release := make(chan struct{})
	firstResult := make(chan Session, 1)
	firstError := make(chan error, 1)
	go func() {
		session, err := gate.open(validOptions(), blockingPlatform{
			bootstrapPlatform: firstPlatform,
			entered:           entered,
			release:           release,
		})
		firstResult <- session
		firstError <- err
	}()
	<-entered

	secondPlatform, _, _ := newSuccessfulFakePlatform()
	second, err := gate.open(validOptions(), secondPlatform)
	if second != nil || !errors.Is(err, ErrAlreadyBootstrapped) {
		t.Fatalf("second session = %v, error = %v", second, err)
	}
	if len(*secondPlatform.events) != 0 {
		t.Fatalf("second bootstrap reached platform operations: %v", *secondPlatform.events)
	}

	close(release)
	first := <-firstResult
	if err := <-firstError; err != nil {
		t.Fatal(err)
	}
	if first == nil {
		t.Fatal("first bootstrap returned no session")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestBootstrapGateDoesNotRetryAfterPartiallyMutatingFailure(t *testing.T) {
	gate := &bootstrapGate{}
	firstPlatform, _, _ := newSuccessfulFakePlatform()
	invalidDACL := exactDACLEvidence(daclPolicy{entries: []AccessEntry{{SID: localSystemSID, Mask: 1}}})
	firstPlatform.wrapper.daclOverride = &invalidDACL
	if session, err := gate.open(validOptions(), firstPlatform); session != nil || !errors.Is(err, ErrDACLVerification) {
		t.Fatalf("first session = %v, error = %v", session, err)
	}
	secondPlatform, _, _ := newSuccessfulFakePlatform()
	if session, err := gate.open(validOptions(), secondPlatform); session != nil || !errors.Is(err, ErrAlreadyBootstrapped) {
		t.Fatalf("second session = %v, error = %v", session, err)
	}
	if len(*secondPlatform.events) != 0 {
		t.Fatalf("retry reached platform operations: %v", *secondPlatform.events)
	}
}

func TestOpenRejectsSCMStateOrPIDChangesAroundOneProcessOpen(t *testing.T) {
	tests := []struct {
		name   string
		second ServiceObservation
	}{
		{name: "state", second: ServiceObservation{State: ServicePaused, ProcessID: 41}},
		{name: "PID", second: ServiceObservation{State: ServiceRunning, ProcessID: 42}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			platform, _, _ := newSuccessfulFakePlatform()
			platform.service.statuses[1] = test.second
			session, err := openWithPlatform(validOptions(), platform)
			if session != nil || !errors.Is(err, ErrWrapperUnstable) {
				t.Fatalf("session = %v, error = %v", session, err)
			}
			if !reflect.DeepEqual(platform.openWrapperCalls, []uint32{41}) {
				t.Fatalf("wrapper opens = %v", platform.openWrapperCalls)
			}
			if platform.wrapper.closeCalls == 0 || platform.service.closeCalls == 0 {
				t.Fatal("rejected handles were not closed")
			}
		})
	}
}

func TestOpenRejectsNonCurrentWinSWParentBeforeChangingDACLs(t *testing.T) {
	platform, _, _ := newSuccessfulFakePlatform()
	platform.current.parents = []uint32{99, 99}
	session, err := openWithPlatform(validOptions(), platform)
	if session != nil || !errors.Is(err, ErrParentMismatch) {
		t.Fatalf("session = %v, error = %v", session, err)
	}
	if len(platform.current.daclPolicies) != 0 || len(platform.wrapper.daclPolicies) != 0 ||
		len(platform.token.policies) != 0 {
		t.Fatal("DACLs were changed before direct-parent verification")
	}
}

func TestOpenRejectsCreationOrStartKeyInstability(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*fakePlatform)
	}{
		{
			name: "creation time",
			mutate: func(platform *fakePlatform) {
				platform.wrapper.creationTimes[1] = platform.wrapper.creationTimes[0].Add(time.Nanosecond)
			},
		},
		{
			name: "start key",
			mutate: func(platform *fakePlatform) {
				platform.wrapper.startKeys[1].SequenceNumber++
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			platform, _, _ := newSuccessfulFakePlatform()
			test.mutate(platform)
			session, err := openWithPlatform(validOptions(), platform)
			if session != nil || !errors.Is(err, ErrWrapperUnstable) {
				t.Fatalf("session = %v, error = %v", session, err)
			}
		})
	}
}

func TestServiceDACLValidationRejectsExtraDuplicateAndBroadACEs(t *testing.T) {
	processPolicy, _, err := serviceDACLPolicies(testOwnServiceSID, testPeerServiceSID)
	if err != nil {
		t.Fatal(err)
	}
	valid := exactDACLEvidence(processPolicy)
	if err := validateDACL(valid, processPolicy); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		mutate func(*DACLEvidence)
	}{
		{name: "unprotected", mutate: func(value *DACLEvidence) {
			value.Control &^= securityDescriptorDACLProtected
			value.Protected = false
		}},
		{name: "defaulted", mutate: func(value *DACLEvidence) { value.Defaulted = true }},
		{name: "null", mutate: func(value *DACLEvidence) { value.Null = true }},
		{name: "extra", mutate: func(value *DACLEvidence) {
			value.AccessRules = append(value.AccessRules, AccessEntry{SID: "S-1-1-0", Mask: 1})
		}},
		{name: "duplicate", mutate: func(value *DACLEvidence) {
			value.AccessRules[0] = value.AccessRules[1]
		}},
		{name: "peer broad", mutate: func(value *DACLEvidence) {
			value.AccessRules[3].Mask = genericAllAccessMask
		}},
		{name: "deny", mutate: func(value *DACLEvidence) { value.AccessRules[3].ACEType = 1 }},
		{name: "inherited", mutate: func(value *DACLEvidence) { value.AccessRules[3].Flags = 0x10 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := cloneDACLEvidence(valid)
			test.mutate(&candidate)
			if err := validateDACL(candidate, processPolicy); !errors.Is(err, ErrDACLVerification) {
				t.Fatalf("error = %v, want ErrDACLVerification", err)
			}
		})
	}
}

func TestEvidenceIsDetached(t *testing.T) {
	platform, _, _ := newSuccessfulFakePlatform()
	session, err := openWithPlatform(validOptions(), platform)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	first := session.Evidence()
	first.ServiceHostProcessDACL.AccessRules[0].SID = "mutated"
	second := session.Evidence()
	if second.ServiceHostProcessDACL.AccessRules[0].SID == "mutated" {
		t.Fatal("Evidence exposed mutable internal DACL storage")
	}
}

func TestSessionCloseKeepsFailedWrapperHandleForRetry(t *testing.T) {
	platform, _, _ := newSuccessfulFakePlatform()
	closeFailure := errors.New("injected CloseHandle failure")
	platform.wrapper.closeErrs = []error{closeFailure, nil}
	session, err := openWithPlatform(validOptions(), platform)
	if err != nil {
		t.Fatal(err)
	}
	if err := session.Close(); !errors.Is(err, closeFailure) {
		t.Fatalf("first Close error = %v", err)
	}
	if processID, err := session.HandleProcessID(); err != nil || processID != 41 {
		t.Fatalf("retained handle after failed Close = PID %d, error %v", processID, err)
	}
	if err := session.Close(); err != nil {
		t.Fatalf("retry Close error = %v", err)
	}
	if platform.wrapper.closeCalls != 2 {
		t.Fatalf("wrapper close calls = %d, want 2", platform.wrapper.closeCalls)
	}
	if _, err := session.HandleProcessID(); !errors.Is(err, ErrClosed) {
		t.Fatalf("post-close HandleProcessID error = %v, want ErrClosed", err)
	}
}

func TestValidateOptionsRejectsNoncanonicalBootstrapIdentity(t *testing.T) {
	tests := []Options{
		{},
		{ServiceName: "bad\x00name", OwnServiceSID: testOwnServiceSID, PeerServiceSID: testPeerServiceSID},
		{ServiceName: "service", OwnServiceSID: "S-1-5-18", PeerServiceSID: testPeerServiceSID},
		{ServiceName: "service", OwnServiceSID: testOwnServiceSID, PeerServiceSID: testOwnServiceSID},
	}
	for _, options := range tests {
		if err := validateOptions(options); !errors.Is(err, ErrInvalidOptions) {
			t.Fatalf("options = %+v, error = %v", options, err)
		}
	}
}

func newSuccessfulFakePlatform() (*fakePlatform, time.Time, time.Time) {
	events := []string{}
	wrapperCreated := time.Unix(1_700_000_000, 100).UTC()
	hostCreated := wrapperCreated.Add(time.Second)
	wrapper := &fakeProcess{
		processID:     41,
		active:        true,
		creationTimes: []time.Time{wrapperCreated, wrapperCreated},
		startKeys: []peerverify.ProcessStartKey{
			{Available: true, SequenceNumber: 100},
			{Available: true, SequenceNumber: 100},
		},
		events: &events,
	}
	currentProcess := &fakeCurrentProcess{
		fakeProcess: &fakeProcess{
			processID:     42,
			active:        true,
			creationTimes: []time.Time{hostCreated, hostCreated},
			startKeys: []peerverify.ProcessStartKey{
				{Available: true, SequenceNumber: 101},
				{Available: true, SequenceNumber: 101},
			},
			events: &events,
		},
		parents: []uint32{41, 41},
	}
	service := &fakeSCMService{
		statuses: []ServiceObservation{
			{State: ServiceRunning, ProcessID: 41},
			{State: ServiceRunning, ProcessID: 41},
		},
		events: &events,
	}
	token := &fakeToken{events: &events}
	return &fakePlatform{
		service: service,
		wrapper: wrapper,
		current: currentProcess,
		token:   token,
		events:  &events,
	}, wrapperCreated, hostCreated
}

func validOptions() Options {
	return Options{
		ServiceName:    "AgenticReview.Worker.Control",
		OwnServiceSID:  testOwnServiceSID,
		PeerServiceSID: testPeerServiceSID,
	}
}

func exactDACLEvidence(policy daclPolicy) DACLEvidence {
	return DACLEvidence{
		Control:     securityDescriptorDACLPresent | securityDescriptorDACLProtected,
		Present:     true,
		Protected:   true,
		AccessRules: append([]AccessEntry(nil), policy.entries...),
	}
}
