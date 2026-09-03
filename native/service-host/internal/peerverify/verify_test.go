package peerverify

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

const (
	testServiceSID = "S-1-5-80-1-2-3-4-5"
	testLogonSID   = "S-1-5-5-100-200"
)

type observedPID struct {
	value uint32
	err   error
}

type fakeObserver struct {
	client []observedPID
	server []observedPID
	events *[]string
}

func (observer *fakeObserver) GetNamedPipeClientProcessID() (uint32, error) {
	*observer.events = append(*observer.events, "pipe-client")
	return popObservedPID(&observer.client)
}

func (observer *fakeObserver) GetNamedPipeServerProcessID() (uint32, error) {
	*observer.events = append(*observer.events, "pipe-server")
	return popObservedPID(&observer.server)
}

func popObservedPID(values *[]observedPID) (uint32, error) {
	if len(*values) == 0 {
		return 0, nil
	}
	value := (*values)[0]
	*values = (*values)[1:]
	return value.value, value.err
}

type fakeService struct {
	observations []serviceObservation
	events       *[]string
	closed       int
	closeErr     error
}

func (service *fakeService) Status() (serviceObservation, error) {
	*service.events = append(*service.events, "scm")
	if len(service.observations) == 0 {
		return serviceObservation{}, errors.New("no SCM observation")
	}
	value := service.observations[0]
	service.observations = service.observations[1:]
	return value, nil
}

func (service *fakeService) Close() error {
	service.closed++
	return service.closeErr
}

type fakeProcess struct {
	pid         uint32
	active      []bool
	snapshot    TokenSnapshot
	events      *[]string
	waitStarted chan struct{}
	closeErrors []error
	closeCount  int
}

func (process *fakeProcess) HandleProcessID() (uint32, error) {
	*process.events = append(*process.events, "handle-pid")
	return process.pid, nil
}

func (process *fakeProcess) StillActive() (bool, error) {
	*process.events = append(*process.events, "active")
	if len(process.active) == 0 {
		return false, nil
	}
	value := process.active[0]
	if len(process.active) > 1 {
		process.active = process.active[1:]
	}
	return value, nil
}

func (process *fakeProcess) TokenSnapshot() (TokenSnapshot, error) {
	*process.events = append(*process.events, "token")
	return process.snapshot, nil
}

func (process *fakeProcess) Wait(ctx context.Context) error {
	if process.waitStarted != nil {
		select {
		case <-process.waitStarted:
		default:
			close(process.waitStarted)
		}
	}
	<-ctx.Done()
	return context.Cause(ctx)
}

func (process *fakeProcess) Close() error {
	process.closeCount++
	if len(process.closeErrors) == 0 {
		return nil
	}
	err := process.closeErrors[0]
	process.closeErrors = process.closeErrors[1:]
	return err
}

type fakeOpener struct {
	process *fakeProcess
	events  *[]string
}

func (opener fakeOpener) OpenProcess(pid uint32) (PeerProcess, error) {
	*opener.events = append(*opener.events, "open")
	return opener.process, nil
}

func TestVerifyRetainedPeerBindsSCMPipeHandleAndToken(t *testing.T) {
	fixture := newVerificationFixture(PipePeerClient)
	session, err := verifyRetainedPeer(fixture.observer, fixture.service, fixture.options, fixture.opener)
	if err != nil {
		t.Fatal(err)
	}
	wantEvents := []string{"scm", "pipe-client", "open", "scm", "pipe-client", "handle-pid", "active", "token", "active"}
	if !reflect.DeepEqual(fixture.events, wantEvents) {
		t.Fatalf("events = %v, want %v", fixture.events, wantEvents)
	}
	evidence := session.Evidence()
	if evidence.SCMPID != (PIDObservationEvidence{BeforeOpen: 200, AfterOpen: 200}) ||
		evidence.PipePID != (PIDObservationEvidence{BeforeOpen: 200, AfterOpen: 200}) ||
		evidence.PeerProcessID != 200 || evidence.PeerToken.ServiceSID != testServiceSID {
		t.Fatalf("evidence = %+v", evidence)
	}
	if fixture.process.closeCount != 0 {
		t.Fatal("accepted process was closed before session cleanup")
	}
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	if fixture.process.closeCount != 1 {
		t.Fatalf("process close count = %d", fixture.process.closeCount)
	}
}

func TestVerifyRetainedPeerUsesServerPIDForExecutor(t *testing.T) {
	fixture := newVerificationFixture(PipePeerServer)
	session, err := verifyRetainedPeer(fixture.observer, fixture.service, fixture.options, fixture.opener)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if fixture.events[1] != "pipe-server" || fixture.events[4] != "pipe-server" {
		t.Fatalf("events = %v", fixture.events)
	}
}

func TestVerifyRetainedPeerAcceptsStartPendingToRunningTransition(t *testing.T) {
	fixture := newVerificationFixture(PipePeerClient)
	fixture.service.observations[0].state = serviceStateStartPending
	fixture.service.observations[1].state = serviceStateRunning
	session, err := verifyRetainedPeer(fixture.observer, fixture.service, fixture.options, fixture.opener)
	if err != nil {
		t.Fatal(err)
	}
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyRetainedPeerRejectsEveryIdentityMismatch(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*verificationFixture)
		want   error
	}{
		{"service not running", func(f *verificationFixture) { f.service.observations[0].state = 1 }, ErrPeerUnstable},
		{"SCM and pipe differ", func(f *verificationFixture) { f.observer.client[0].value = 201 }, ErrPeerUnstable},
		{"SCM changes", func(f *verificationFixture) { f.service.observations[1].processID = 201 }, ErrPeerUnstable},
		{"pipe changes", func(f *verificationFixture) { f.observer.client[1].value = 201 }, ErrPeerUnstable},
		{"handle differs", func(f *verificationFixture) { f.process.pid = 201 }, ErrPeerUnstable},
		{"process exited", func(f *verificationFixture) { f.process.active = []bool{false} }, ErrPeerUnstable},
		{"process exits after token", func(f *verificationFixture) { f.process.active = []bool{true, false} }, ErrPeerUnstable},
		{"token differs", func(f *verificationFixture) { f.process.snapshot.User.SID = localSystemSID }, ErrTokenMismatch},
		{"token is not restricted", func(f *verificationFixture) { f.process.snapshot.HasRestrictions = false }, ErrTokenMismatch},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newVerificationFixture(PipePeerClient)
			test.mutate(fixture)
			session, err := verifyRetainedPeer(fixture.observer, fixture.service, fixture.options, fixture.opener)
			if session != nil || !errors.Is(err, test.want) {
				t.Fatalf("result = (%v, %v), want %v", session, err, test.want)
			}
			if fixture.process.closeCount != 0 && fixture.process.closeCount != 1 {
				t.Fatalf("rejected process close count = %d", fixture.process.closeCount)
			}
		})
	}
}

func TestSessionWaitAndCloseShareOneRetainedProcess(t *testing.T) {
	fixture := newVerificationFixture(PipePeerClient)
	fixture.process.waitStarted = make(chan struct{})
	session, err := verifyRetainedPeer(fixture.observer, fixture.service, fixture.options, fixture.opener)
	if err != nil {
		t.Fatal(err)
	}
	waitResult := make(chan error, 1)
	go func() { waitResult <- session.WaitPeer(context.Background()) }()
	<-fixture.process.waitStarted
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-waitResult; !errors.Is(err, context.Canceled) {
		t.Fatalf("WaitPeer error = %v", err)
	}
	if err := session.WaitPeer(context.Background()); !errors.Is(err, ErrClosed) {
		t.Fatalf("closed WaitPeer error = %v", err)
	}
}

func TestSessionCloseRetainsProcessAfterTransientFailure(t *testing.T) {
	fixture := newVerificationFixture(PipePeerClient)
	session, err := verifyRetainedPeer(fixture.observer, fixture.service, fixture.options, fixture.opener)
	if err != nil {
		t.Fatal(err)
	}
	closeFailure := errors.New("close failed")
	fixture.process.closeErrors = []error{closeFailure, nil}
	if err := session.Close(); !errors.Is(err, closeFailure) {
		t.Fatalf("first Close error = %v", err)
	}
	if err := session.Close(); err != nil {
		t.Fatalf("retry Close error = %v", err)
	}
	if fixture.process.closeCount != 2 {
		t.Fatalf("close attempts = %d", fixture.process.closeCount)
	}
}

func TestRejectedPeerCloseFailureRetainsNativeOwner(t *testing.T) {
	original := rejectedNativeOwners
	rejectedNativeOwners = &nativeOwnershipLifetimeQuarantine{}
	t.Cleanup(func() { rejectedNativeOwners = original })

	fixture := newVerificationFixture(PipePeerClient)
	fixture.process.pid = 201
	closeFailure := errors.New("close failed")
	fixture.process.closeErrors = []error{closeFailure, closeFailure, closeFailure}
	session, err := verifyRetainedPeer(fixture.observer, fixture.service, fixture.options, fixture.opener)
	if session != nil || !errors.Is(err, ErrPeerUnstable) ||
		!errors.Is(err, ErrNativeHandleOwnershipFatal) {
		t.Fatalf("result = (%v, %v)", session, err)
	}
	if fixture.process.closeCount != discardedResourceCloseAttempts {
		t.Fatalf("close attempts = %d", fixture.process.closeCount)
	}
	rejectedNativeOwners.mu.RLock()
	defer rejectedNativeOwners.mu.RUnlock()
	if len(rejectedNativeOwners.owners) != 1 || rejectedNativeOwners.owners[0] != fixture.process {
		t.Fatalf("retained owners = %#v", rejectedNativeOwners.owners)
	}
}

func TestZeroSessionFailsClosed(t *testing.T) {
	var session Session
	if session.Evidence() != (VerificationEvidence{}) {
		t.Fatal("zero session returned evidence")
	}
	if err := session.WaitPeer(context.Background()); !errors.Is(err, ErrClosed) {
		t.Fatalf("zero WaitPeer error = %v", err)
	}
	if err := session.Close(); !errors.Is(err, ErrClosed) {
		t.Fatalf("zero Close error = %v", err)
	}
}

type verificationFixture struct {
	events   []string
	observer *fakeObserver
	service  *fakeService
	process  *fakeProcess
	opener   fakeOpener
	options  verificationOptions
}

func newVerificationFixture(pipePeer PipePeer) *verificationFixture {
	fixture := &verificationFixture{}
	fixture.observer = &fakeObserver{
		client: []observedPID{{value: 200}, {value: 200}},
		server: []observedPID{{value: 200}, {value: 200}},
		events: &fixture.events,
	}
	fixture.service = &fakeService{
		observations: []serviceObservation{{state: serviceStateRunning, processID: 200}, {state: serviceStateRunning, processID: 200}},
		events:       &fixture.events,
	}
	fixture.process = &fakeProcess{
		pid:      200,
		active:   []bool{true, true},
		snapshot: validTokenSnapshot(),
		events:   &fixture.events,
	}
	fixture.opener = fakeOpener{process: fixture.process, events: &fixture.events}
	fixture.options = verificationOptions{
		PipePeer:           pipePeer,
		LocalProcessID:     100,
		ExpectedServiceSID: testServiceSID,
		TokenVerifier:      ExactRestrictedServiceSIDVerifier{},
	}
	return fixture
}

func validTokenSnapshot() TokenSnapshot {
	return validTokenSnapshotForSID(testServiceSID)
}

func validTokenSnapshotForSID(serviceSID string) TokenSnapshot {
	statistics := TokenStatistics{
		TokenID:          LUID{LowPart: 1},
		AuthenticationID: LUID{LowPart: 2},
		ModifiedID:       LUID{LowPart: 3},
		Type:             tokenPrimaryType,
		GroupCount:       3,
		PrivilegeCount:   1,
	}
	return TokenSnapshot{
		StatisticsBefore: statistics,
		StatisticsAfter:  statistics,
		HasRestrictions:  true,
		User:             SIDAttributes{SID: serviceSID},
		Groups: []SIDAttributes{
			{SID: serviceSID, Attributes: serviceGroupMandatory | serviceGroupDefault | serviceGroupEnabled},
			{SID: allServicesSID, Attributes: serviceGroupDefault | serviceGroupEnabled},
			{SID: testLogonSID, Attributes: serviceLogonAttributes},
		},
		RestrictedSIDs: []SIDAttributes{
			{SID: serviceSID},
			{SID: worldSID},
			{SID: writeRestrictedSID},
			{SID: testLogonSID},
		},
		Privileges: []PrivilegeEvidence{
			{Name: "SeChangeNotifyPrivilege", LUID: LUID{LowPart: 23}, Attributes: privilegeEnabled},
		},
	}
}
