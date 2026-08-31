package peerverify

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"reflect"
	"testing"
	"time"
)

const (
	testServiceSID      = "S-1-5-80-1-2-3-4-5"
	testWrapperPath     = `C:\Program Files\AgenticReview\winsw.exe`
	testPeerPath        = `C:\Program Files\AgenticReview\AgenticReview.ServiceHost.exe`
	testSignerDERSHA256 = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	testLogonSID        = "S-1-5-5-100-200"
)

var (
	testWrapperCreated = time.Unix(1_700_000_000, 100).UTC()
	testPeerCreated    = time.Unix(1_700_000_001, 200).UTC()
	testWrapperBytes   = []byte("signed WinSW wrapper fixture")
	testPeerBytes      = []byte("signed ServiceHost fixture")
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

func (o *fakeObserver) GetNamedPipeClientProcessID() (uint32, error) {
	*o.events = append(*o.events, "observe-client")
	return popObservation(&o.client)
}

func (o *fakeObserver) GetNamedPipeServerProcessID() (uint32, error) {
	*o.events = append(*o.events, "observe-server")
	return popObservation(&o.server)
}

func popObservation(values *[]observedPID) (uint32, error) {
	if len(*values) == 0 {
		return 0, errors.New("unexpected PID observation")
	}
	value := (*values)[0]
	*values = (*values)[1:]
	return value.value, value.err
}

type fakeOpener struct {
	process PeerProcess
	err     error
	events  *[]string
}

func (o fakeOpener) OpenProcess(processID uint32) (PeerProcess, error) {
	*o.events = append(*o.events, fmt.Sprintf("open-%d", processID))
	return o.process, o.err
}

type fakeProcess struct {
	name          string
	events        *[]string
	processIDs    []uint32
	active        []bool
	creationTimes []time.Time
	startKeys     []ProcessStartKey
	parents       []uint32
	imagePath     string
	image         ImageSubject
	token         TokenSnapshot
	tokenErr      error
	waitErr       error
	closeErr      error
	closeErrors   []error
	closeCount    int
	waitFunc      func(context.Context) error
}

func (p *fakeProcess) HandleProcessID() (uint32, error) {
	*p.events = append(*p.events, p.name+"-pid")
	return popValue(&p.processIDs), nil
}

func (p *fakeProcess) StillActive() (bool, error) {
	*p.events = append(*p.events, p.name+"-active")
	return popValue(&p.active), nil
}

func (p *fakeProcess) HandleCreationTime() (time.Time, error) {
	*p.events = append(*p.events, p.name+"-created")
	return popValue(&p.creationTimes), nil
}

func (p *fakeProcess) HandleStartKey() (ProcessStartKey, error) {
	*p.events = append(*p.events, p.name+"-start-key")
	return popValue(&p.startKeys), nil
}

func (p *fakeProcess) DirectParentProcessID() (uint32, error) {
	*p.events = append(*p.events, p.name+"-parent")
	return popValue(&p.parents), nil
}

func (p *fakeProcess) ImagePathDiagnostic() (string, error) {
	*p.events = append(*p.events, p.name+"-image-path")
	return p.imagePath, nil
}

func (p *fakeProcess) OpenImage() (ImageSubject, error) {
	*p.events = append(*p.events, p.name+"-open-image")
	return p.image, nil
}

func (p *fakeProcess) TokenSnapshot() (TokenSnapshot, error) {
	*p.events = append(*p.events, p.name+"-token")
	return p.token, p.tokenErr
}

func (p *fakeProcess) Wait(ctx context.Context) error {
	*p.events = append(*p.events, p.name+"-wait")
	if p.waitFunc != nil {
		return p.waitFunc(ctx)
	}
	return p.waitErr
}

func (p *fakeProcess) Close() error {
	p.closeCount++
	*p.events = append(*p.events, p.name+"-close")
	if len(p.closeErrors) != 0 {
		err := p.closeErrors[0]
		p.closeErrors = p.closeErrors[1:]
		return err
	}
	return p.closeErr
}

type fakeWrapper struct {
	*fakeProcess
	facts StableProcessFacts
}

func (w *fakeWrapper) StableFacts() StableProcessFacts {
	return w.facts
}

type fakeImage struct {
	data         []byte
	identity     FileIdentity
	processPath  string
	finalPath    string
	finalPathErr error
	unchangedErr error
	closeErr     error
	closeErrors  []error
	closeCount   int
	events       *[]string
	name         string
}

func (i *fakeImage) ReadAt(buffer []byte, offset int64) (int, error) {
	return bytes.NewReader(i.data).ReadAt(buffer, offset)
}

func (i *fakeImage) Size() int64 { return int64(len(i.data)) }

func (i *fakeImage) Identity() FileIdentity { return i.identity }

func (i *fakeImage) ProcessPathDiagnostic() string { return i.processPath }

func (i *fakeImage) FinalPathDiagnostic() (string, error) {
	return i.finalPath, i.finalPathErr
}

func (i *fakeImage) VerifyUnchanged() error {
	*i.events = append(*i.events, i.name+"-image-unchanged")
	return i.unchangedErr
}

func (i *fakeImage) Close() error {
	i.closeCount++
	*i.events = append(*i.events, i.name+"-image-close")
	if len(i.closeErrors) != 0 {
		err := i.closeErrors[0]
		i.closeErrors = i.closeErrors[1:]
		return err
	}
	return i.closeErr
}

type fakeAuthenticodeVerifier struct {
	trusted         bool
	signerDERSHA256 string
	err             error
	events          *[]string
	mutateEvidence  func(*AuthenticodeEvidence)
}

func (v fakeAuthenticodeVerifier) VerifyAuthenticode(subject ImageSubject) (AuthenticodeEvidence, error) {
	*v.events = append(*v.events, "authenticode-"+subject.ProcessPathDiagnostic())
	signerDigest := v.signerDERSHA256
	if signerDigest == "" {
		signerDigest = testSignerDERSHA256
	}
	evidence := AuthenticodeEvidence{
		Trusted:                                v.trusted,
		SignatureKind:                          AuthenticodeSignatureKindEmbedded,
		SignatureCount:                         1,
		VerifiedSignatureIndex:                 0,
		RevocationPolicy:                       AuthenticodeRuntimeRevocationPolicy,
		DigestPolicy:                           AuthenticodeDigestPolicySHA256Only,
		StrongSignaturePolicy:                  AuthenticodeStrongSignaturePolicyCurrent,
		SignerDigestAlgorithmOID:               AuthenticodeSHA256ObjectIdentifier,
		FileDigestAlgorithmOID:                 AuthenticodeSHA256ObjectIdentifier,
		SignerIdentity:                         "test signer",
		VerifiedLeafSignerCertificateDERSHA256: signerDigest,
	}
	if v.mutateEvidence != nil {
		v.mutateEvidence(&evidence)
	}
	return evidence, v.err
}

type recordingTokenVerifier struct {
	events   *[]string
	evidence *TokenEvidence
}

func (v recordingTokenVerifier) VerifyToken(snapshot TokenSnapshot, expected string) (TokenEvidence, error) {
	*v.events = append(*v.events, "verify-token")
	if v.evidence != nil {
		return *v.evidence, nil
	}
	return ExactRestrictedServiceSIDVerifier{}.VerifyToken(snapshot, expected)
}

func TestVerifyUsesObserveOpenObserveBeforeHandleQueriesAndRetainsObjects(t *testing.T) {
	fixture := newVerificationFixture(PipePeerClient)
	session, err := verifyWithOpener(fixture.observer, fixture.wrapper, fixture.options, fixture.opener)
	if err != nil {
		t.Fatal(err)
	}
	if len(fixture.events) < 4 {
		t.Fatalf("events = %v", fixture.events)
	}
	wantPrefix := []string{"observe-client", "open-200", "observe-client", "peer-pid"}
	if !reflect.DeepEqual(fixture.events[:len(wantPrefix)], wantPrefix) {
		t.Fatalf("operation prefix = %v, want %v", fixture.events[:len(wantPrefix)], wantPrefix)
	}
	if fixture.peer.closeCount != 0 || fixture.wrapper.closeCount != 0 {
		t.Fatal("successful verification closed a retained process early")
	}
	evidence := session.Evidence()
	if evidence.PipePID.BeforeOpen != 200 || evidence.PipePID.AfterOpen != 200 ||
		evidence.ServiceHost.ProcessID != 200 || evidence.ServiceHost.DirectParentID != 100 ||
		evidence.ServiceHost.StartKey.SequenceNumber != 1_001 ||
		evidence.Wrapper.ProcessID != 100 || evidence.Wrapper.StartKey.SequenceNumber != 1_000 ||
		evidence.PeerToken.ServiceSID != testServiceSID {
		t.Fatalf("unexpected verification evidence: %+v", evidence)
	}
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	if fixture.peer.closeCount != 1 || fixture.wrapper.closeCount != 1 {
		t.Fatalf("process close counts = peer %d wrapper %d, want one each", fixture.peer.closeCount, fixture.wrapper.closeCount)
	}
	if err := session.WaitPeer(context.Background()); !errors.Is(err, ErrClosed) {
		t.Fatalf("closed session returned %v, want ErrClosed", err)
	}
}

func TestVerifySelectsServerPIDSource(t *testing.T) {
	fixture := newVerificationFixture(PipePeerServer)
	session, err := verifyWithOpener(fixture.observer, fixture.wrapper, fixture.options, fixture.opener)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	wantPrefix := []string{"observe-server", "open-200", "observe-server"}
	if !reflect.DeepEqual(fixture.events[:len(wantPrefix)], wantPrefix) {
		t.Fatalf("operation prefix = %v, want %v", fixture.events[:len(wantPrefix)], wantPrefix)
	}
}

func TestVerifyRejectsPipePIDRaceBeforeInspectingHandleAndClosesEverything(t *testing.T) {
	fixture := newVerificationFixture(PipePeerClient)
	fixture.observer.client = []observedPID{{value: 200}, {value: 201}}
	_, err := verifyWithOpener(fixture.observer, fixture.wrapper, fixture.options, fixture.opener)
	if !errors.Is(err, ErrPeerUnstable) {
		t.Fatalf("error = %v, want ErrPeerUnstable", err)
	}
	want := []string{"observe-client", "open-200", "observe-client", "peer-close", "wrapper-close"}
	if !reflect.DeepEqual(fixture.events, want) {
		t.Fatalf("events = %v, want %v", fixture.events, want)
	}
}

func TestVerifyRejectsHandlePIDReuseAndFinalLivenessRace(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*verificationFixture)
	}{
		{
			name: "handle PID does not match observation",
			mutate: func(f *verificationFixture) {
				f.peer.processIDs = []uint32{201}
			},
		},
		{
			name: "peer exits during evidence collection",
			mutate: func(f *verificationFixture) {
				f.peer.active = []bool{true, false}
			},
		},
		{
			name: "peer creation time changes",
			mutate: func(f *verificationFixture) {
				f.peer.creationTimes = []time.Time{testPeerCreated, testPeerCreated.Add(time.Nanosecond)}
			},
		},
		{
			name: "peer process start key changes",
			mutate: func(f *verificationFixture) {
				f.peer.startKeys = []ProcessStartKey{
					{Available: true, SequenceNumber: 1_001},
					{Available: true, SequenceNumber: 1_002},
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newVerificationFixture(PipePeerClient)
			test.mutate(fixture)
			_, err := verifyWithOpener(fixture.observer, fixture.wrapper, fixture.options, fixture.opener)
			if !errors.Is(err, ErrPeerUnstable) {
				t.Fatalf("error = %v, want ErrPeerUnstable", err)
			}
			assertRejectedProcessesClosed(t, fixture)
		})
	}
}

func TestVerifyRequiresPeerToStartStrictlyAfterRetainedWrapper(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*verificationFixture)
	}{
		{
			name: "equal creation time",
			mutate: func(f *verificationFixture) {
				f.peer.creationTimes = []time.Time{testWrapperCreated, testWrapperCreated}
			},
		},
		{
			name: "older creation time",
			mutate: func(f *verificationFixture) {
				older := testWrapperCreated.Add(-time.Nanosecond)
				f.peer.creationTimes = []time.Time{older, older}
			},
		},
		{
			name: "identical process sequence number",
			mutate: func(f *verificationFixture) {
				f.peer.startKeys = []ProcessStartKey{
					{Available: true, SequenceNumber: 1_000},
					{Available: true, SequenceNumber: 1_000},
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newVerificationFixture(PipePeerClient)
			test.mutate(fixture)
			_, err := verifyWithOpener(fixture.observer, fixture.wrapper, fixture.options, fixture.opener)
			if !errors.Is(err, ErrParentMismatch) {
				t.Fatalf("error = %v, want ErrParentMismatch", err)
			}
			assertRejectedProcessesClosed(t, fixture)
		})
	}
}

func TestVerifyUsesCreationTimeFallbackWhenProcessSequenceNumberIsUnavailable(t *testing.T) {
	fixture := newVerificationFixture(PipePeerClient)
	fixture.wrapper.facts.StartKey = ProcessStartKey{}
	fixture.wrapper.startKeys = nil
	fixture.peer.startKeys = nil
	session, err := verifyWithOpener(fixture.observer, fixture.wrapper, fixture.options, fixture.opener)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	evidence := session.Evidence()
	if evidence.Wrapper.StartKey.Available || evidence.ServiceHost.StartKey.Available {
		t.Fatalf("unexpected process start keys: wrapper=%+v peer=%+v", evidence.Wrapper.StartKey, evidence.ServiceHost.StartKey)
	}
}

func TestVerifyRequiresDirectWrapperParentThroughoutVerification(t *testing.T) {
	tests := []struct {
		name    string
		parents []uint32
		err     error
	}{
		{name: "not direct child", parents: []uint32{99}, err: ErrParentMismatch},
		{name: "parent changed", parents: []uint32{100, 101}, err: ErrPeerUnstable},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newVerificationFixture(PipePeerClient)
			fixture.peer.parents = test.parents
			_, err := verifyWithOpener(fixture.observer, fixture.wrapper, fixture.options, fixture.opener)
			if !errors.Is(err, test.err) {
				t.Fatalf("error = %v, want %v", err, test.err)
			}
			assertRejectedProcessesClosed(t, fixture)
		})
	}
}

func TestVerifyRejectsImageAndTokenFailuresAndClosesSubjects(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*verificationFixture)
		err    error
	}{
		{
			name: "wrong peer image path",
			mutate: func(f *verificationFixture) {
				f.peer.imagePath = `C:\Temp\ServiceHost.exe`
			},
			err: ErrImageMismatch,
		},
		{
			name: "wrong peer image digest",
			mutate: func(f *verificationFixture) {
				f.options.ServiceHostImage.SHA256 = digestString([]byte("different"))
			},
			err: ErrImageMismatch,
		},
		{
			name: "image changes during Authenticode",
			mutate: func(f *verificationFixture) {
				f.peerImage.unchangedErr = errors.New("changed")
			},
			err: ErrImageMismatch,
		},
		{
			name: "untrusted Authenticode",
			mutate: func(f *verificationFixture) {
				f.options.AuthenticodeVerifier = fakeAuthenticodeVerifier{events: &f.events}
			},
			err: ErrAuthenticode,
		},
		{
			name: "wrong Authenticode signer certificate",
			mutate: func(f *verificationFixture) {
				f.options.AuthenticodeVerifier = fakeAuthenticodeVerifier{
					trusted: true, signerDERSHA256: digestString([]byte("wrong signer")), events: &f.events,
				}
			},
			err: ErrAuthenticode,
		},
		{
			name: "non-embedded Authenticode evidence",
			mutate: func(f *verificationFixture) {
				f.options.AuthenticodeVerifier = fakeAuthenticodeVerifier{
					trusted: true,
					events:  &f.events,
					mutateEvidence: func(evidence *AuthenticodeEvidence) {
						evidence.SignatureKind = "catalog"
					},
				}
			},
			err: ErrAuthenticode,
		},
		{
			name: "multiple Authenticode signatures",
			mutate: func(f *verificationFixture) {
				f.options.AuthenticodeVerifier = fakeAuthenticodeVerifier{
					trusted: true,
					events:  &f.events,
					mutateEvidence: func(evidence *AuthenticodeEvidence) {
						evidence.SignatureCount = 2
					},
				}
			},
			err: ErrAuthenticode,
		},
		{
			name: "unexpected Authenticode revocation policy",
			mutate: func(f *verificationFixture) {
				f.options.AuthenticodeVerifier = fakeAuthenticodeVerifier{
					trusted: true,
					events:  &f.events,
					mutateEvidence: func(evidence *AuthenticodeEvidence) {
						evidence.RevocationPolicy = "online"
					},
				}
			},
			err: ErrAuthenticode,
		},
		{
			name: "weak Authenticode digest policy",
			mutate: func(f *verificationFixture) {
				f.options.AuthenticodeVerifier = fakeAuthenticodeVerifier{
					trusted: true,
					events:  &f.events,
					mutateEvidence: func(evidence *AuthenticodeEvidence) {
						evidence.FileDigestAlgorithmOID = "1.3.14.3.2.26"
					},
				}
			},
			err: ErrAuthenticode,
		},
		{
			name: "incomplete token evidence",
			mutate: func(f *verificationFixture) {
				bad := TokenEvidence{ServiceSID: testServiceSID}
				f.options.TokenVerifier = recordingTokenVerifier{events: &f.events, evidence: &bad}
			},
			err: ErrTokenMismatch,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newVerificationFixture(PipePeerClient)
			test.mutate(fixture)
			_, err := verifyWithOpener(fixture.observer, fixture.wrapper, fixture.options, fixture.opener)
			if !errors.Is(err, test.err) {
				t.Fatalf("error = %v, want %v", err, test.err)
			}
			assertRejectedProcessesClosed(t, fixture)
			if fixture.wrapperImage.closeCount != 1 {
				t.Fatalf("wrapper image close count = %d, want 1", fixture.wrapperImage.closeCount)
			}
			if fixture.peerImage.closeCount > 1 {
				t.Fatalf("peer image close count = %d, want at most 1", fixture.peerImage.closeCount)
			}
		})
	}
}

func TestMandatoryTokenPolicyCannotBeWeakenedByInjectedVerifier(t *testing.T) {
	fixture := newVerificationFixture(PipePeerClient)
	fixture.peer.token.User.SID = "S-1-5-80-6-7-8-9-10"
	claimed, err := (ExactRestrictedServiceSIDVerifier{}).VerifyToken(validTokenSnapshot(), testServiceSID)
	if err != nil {
		t.Fatal(err)
	}
	fixture.options.TokenVerifier = recordingTokenVerifier{events: &fixture.events, evidence: &claimed}
	_, err = verifyWithOpener(fixture.observer, fixture.wrapper, fixture.options, fixture.opener)
	if !errors.Is(err, ErrTokenMismatch) {
		t.Fatalf("error = %v, want ErrTokenMismatch", err)
	}
	assertRejectedProcessesClosed(t, fixture)
}

func TestVerifyJoinsCleanupFailures(t *testing.T) {
	fixture := newVerificationFixture(PipePeerClient)
	peerCloseErr := errors.New("peer close failed")
	wrapperCloseErr := errors.New("wrapper close failed")
	fixture.peer.closeErr = peerCloseErr
	fixture.wrapper.closeErr = wrapperCloseErr
	fixture.peer.parents = []uint32{99}
	_, err := verifyWithOpener(fixture.observer, fixture.wrapper, fixture.options, fixture.opener)
	if !errors.Is(err, ErrParentMismatch) || !errors.Is(err, peerCloseErr) || !errors.Is(err, wrapperCloseErr) {
		t.Fatalf("error = %v, want verification and both cleanup errors", err)
	}
}

func TestRejectedVerificationRetriesDiscardedProcessClose(t *testing.T) {
	fixture := newVerificationFixture(PipePeerClient)
	closeErr := errors.New("transient rejected-process close failure")
	fixture.peer.closeErrors = []error{closeErr, nil}
	fixture.peer.parents = []uint32{99}
	_, err := verifyWithOpener(fixture.observer, fixture.wrapper, fixture.options, fixture.opener)
	if !errors.Is(err, ErrParentMismatch) || !errors.Is(err, closeErr) {
		t.Fatalf("error = %v, want parent mismatch and cleanup failure", err)
	}
	if fixture.peer.closeCount != 2 || fixture.wrapper.closeCount != 1 {
		t.Fatalf("close counts = peer %d wrapper %d", fixture.peer.closeCount, fixture.wrapper.closeCount)
	}
}

func TestImageVerificationRetriesDiscardedImageClose(t *testing.T) {
	fixture := newVerificationFixture(PipePeerClient)
	closeErr := errors.New("transient image close failure")
	fixture.peerImage.closeErrors = []error{closeErr, nil}
	_, err := verifyWithOpener(fixture.observer, fixture.wrapper, fixture.options, fixture.opener)
	if !errors.Is(err, closeErr) {
		t.Fatalf("error = %v, want image cleanup failure", err)
	}
	if fixture.peerImage.closeCount != 2 {
		t.Fatalf("peer image close count = %d, want 2", fixture.peerImage.closeCount)
	}
	assertRejectedProcessesClosed(t, fixture)
}

func TestSessionCloseCancelsAndJoinsActiveWait(t *testing.T) {
	fixture := newVerificationFixture(PipePeerClient)
	started := make(chan struct{})
	finished := make(chan struct{})
	fixture.peer.waitFunc = func(ctx context.Context) error {
		close(started)
		<-ctx.Done()
		close(finished)
		return ctx.Err()
	}
	session, err := verifyWithOpener(fixture.observer, fixture.wrapper, fixture.options, fixture.opener)
	if err != nil {
		t.Fatal(err)
	}
	waitResult := make(chan error, 1)
	go func() {
		waitResult <- session.WaitPeer(context.Background())
	}()
	<-started
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	<-finished
	if err := <-waitResult; !errors.Is(err, context.Canceled) {
		t.Fatalf("wait error = %v, want context.Canceled", err)
	}
	if fixture.peer.closeCount != 1 || fixture.wrapper.closeCount != 1 {
		t.Fatalf("close counts = peer %d wrapper %d", fixture.peer.closeCount, fixture.wrapper.closeCount)
	}
}

func TestSessionCloseRetainsFailedObjectForRetry(t *testing.T) {
	fixture := newVerificationFixture(PipePeerClient)
	session, err := verifyWithOpener(fixture.observer, fixture.wrapper, fixture.options, fixture.opener)
	if err != nil {
		t.Fatal(err)
	}
	closeErr := errors.New("transient close failure")
	fixture.peer.closeErrors = []error{closeErr, nil}
	if err := session.Close(); !errors.Is(err, closeErr) {
		t.Fatalf("first Close error = %v, want transient failure", err)
	}
	if fixture.peer.closeCount != 1 || fixture.wrapper.closeCount != 1 {
		t.Fatalf("first close counts = peer %d wrapper %d", fixture.peer.closeCount, fixture.wrapper.closeCount)
	}
	if err := session.Close(); err != nil {
		t.Fatalf("retry Close returned %v", err)
	}
	if fixture.peer.closeCount != 2 || fixture.wrapper.closeCount != 1 {
		t.Fatalf("retry close counts = peer %d wrapper %d", fixture.peer.closeCount, fixture.wrapper.closeCount)
	}
}

func TestSessionCloseRetainsFailedWrapperHandleForRetry(t *testing.T) {
	fixture := newVerificationFixture(PipePeerClient)
	session, err := verifyWithOpener(fixture.observer, fixture.wrapper, fixture.options, fixture.opener)
	if err != nil {
		t.Fatal(err)
	}
	closeErr := errors.New("transient wrapper close failure")
	fixture.wrapper.closeErrors = []error{closeErr, nil}
	if err := session.Close(); !errors.Is(err, closeErr) {
		t.Fatalf("first Close error = %v, want transient wrapper failure", err)
	}
	if fixture.peer.closeCount != 1 || fixture.wrapper.closeCount != 1 {
		t.Fatalf("first close counts = peer %d wrapper %d", fixture.peer.closeCount, fixture.wrapper.closeCount)
	}
	if err := session.Close(); err != nil {
		t.Fatalf("retry Close returned %v", err)
	}
	if fixture.peer.closeCount != 1 || fixture.wrapper.closeCount != 2 {
		t.Fatalf("retry close counts = peer %d wrapper %d", fixture.peer.closeCount, fixture.wrapper.closeCount)
	}
}

func TestVerifyProcessImageTreatsFinalPathAsDiagnosticOnly(t *testing.T) {
	fixture := newVerificationFixture(PipePeerClient)
	fixture.peerImage.finalPath = ""
	fixture.peerImage.finalPathErr = errors.New("diagnostic unavailable")
	session, err := verifyWithOpener(fixture.observer, fixture.wrapper, fixture.options, fixture.opener)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	evidence := session.Evidence().ServiceHost.Image
	if evidence.FinalPathDiagnosticError != "diagnostic unavailable" {
		t.Fatalf("final path diagnostic error = %q", evidence.FinalPathDiagnosticError)
	}
}

type verificationFixture struct {
	events       []string
	observer     *fakeObserver
	opener       fakeOpener
	wrapper      *fakeWrapper
	peer         *fakeProcess
	wrapperImage *fakeImage
	peerImage    *fakeImage
	options      verificationOptions
}

func newVerificationFixture(pipePeer PipePeer) *verificationFixture {
	fixture := &verificationFixture{}
	fixture.wrapperImage = newFakeImage("wrapper", testWrapperPath, testWrapperBytes, &fixture.events, 1)
	fixture.peerImage = newFakeImage("peer", testPeerPath, testPeerBytes, &fixture.events, 2)
	fixture.wrapper = &fakeWrapper{
		fakeProcess: &fakeProcess{
			name:          "wrapper",
			events:        &fixture.events,
			processIDs:    []uint32{100, 100},
			active:        []bool{true, true},
			creationTimes: []time.Time{testWrapperCreated, testWrapperCreated},
			startKeys:     []ProcessStartKey{{Available: true, SequenceNumber: 1_000}, {Available: true, SequenceNumber: 1_000}},
			imagePath:     testWrapperPath,
			image:         fixture.wrapperImage,
		},
		facts: StableProcessFacts{
			ProcessID:    100,
			CreationTime: testWrapperCreated,
			StartKey:     ProcessStartKey{Available: true, SequenceNumber: 1_000},
		},
	}
	fixture.peer = &fakeProcess{
		name:          "peer",
		events:        &fixture.events,
		processIDs:    []uint32{200, 200},
		active:        []bool{true, true},
		creationTimes: []time.Time{testPeerCreated, testPeerCreated},
		startKeys:     []ProcessStartKey{{Available: true, SequenceNumber: 1_001}, {Available: true, SequenceNumber: 1_001}},
		parents:       []uint32{100, 100},
		imagePath:     testPeerPath,
		image:         fixture.peerImage,
		token:         validTokenSnapshot(),
	}
	fixture.observer = &fakeObserver{
		client: []observedPID{{value: 200}, {value: 200}},
		server: []observedPID{{value: 200}, {value: 200}},
		events: &fixture.events,
	}
	fixture.opener = fakeOpener{process: fixture.peer, events: &fixture.events}
	fixture.options = verificationOptions{
		PipePeer:           pipePeer,
		ExpectedServiceSID: testServiceSID,
		WrapperImage: ImageExpectation{
			Path:   testWrapperPath,
			SHA256: digestString(testWrapperBytes),
		},
		ServiceHostImage: ImageExpectation{
			Path:   testPeerPath,
			SHA256: digestString(testPeerBytes),
		},
		ExpectedLeafSignerCertificateDERSHA256: testSignerDERSHA256,
		AuthenticodeVerifier:                   fakeAuthenticodeVerifier{trusted: true, events: &fixture.events},
		TokenVerifier:                          recordingTokenVerifier{events: &fixture.events},
	}
	return fixture
}

func newFakeImage(name string, path string, data []byte, events *[]string, fileID byte) *fakeImage {
	return &fakeImage{
		name:        name,
		events:      events,
		data:        append([]byte(nil), data...),
		identity:    FileIdentity{VolumeSerialNumber: 10, FileID: [16]byte{fileID}},
		processPath: path,
		finalPath:   `\\?\` + path,
	}
}

func validTokenSnapshot() TokenSnapshot {
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
		User:             SIDAttributes{SID: testServiceSID},
		Groups: []SIDAttributes{
			{SID: testServiceSID, Attributes: serviceGroupMandatory | serviceGroupDefault | serviceGroupEnabled},
			{SID: allServicesSID, Attributes: serviceGroupDefault | serviceGroupEnabled},
			{SID: testLogonSID, Attributes: serviceLogonAttributes},
		},
		RestrictedSIDs: []SIDAttributes{
			{SID: testServiceSID},
			{SID: worldSID},
			{SID: writeRestrictedSID},
			{SID: testLogonSID},
		},
		Privileges: []PrivilegeEvidence{
			{Name: "SeChangeNotifyPrivilege", LUID: LUID{LowPart: 23}, Attributes: privilegeEnabled},
		},
	}
}

func digestString(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func assertRejectedProcessesClosed(t *testing.T, fixture *verificationFixture) {
	t.Helper()
	if fixture.peer.closeCount != 1 || fixture.wrapper.closeCount != 1 {
		t.Fatalf("rejected process close counts = peer %d wrapper %d, want one each", fixture.peer.closeCount, fixture.wrapper.closeCount)
	}
}

func popValue[T any](values *[]T) T {
	var zero T
	if len(*values) == 0 {
		return zero
	}
	value := (*values)[0]
	if len(*values) > 1 {
		*values = (*values)[1:]
	}
	return value
}

var _ io.ReaderAt = (*fakeImage)(nil)
