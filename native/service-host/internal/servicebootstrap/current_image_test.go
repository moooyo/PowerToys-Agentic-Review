package servicebootstrap

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"io"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peerverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"
)

const testCurrentImagePath = `C:\Program Files\AgenticReview\native\AgenticReview.ServiceHost.exe`

type fakeCurrentImage struct {
	data            []byte
	size            int64
	identity        peerverify.FileIdentity
	processPath     string
	finalPath       string
	finalPathErr    error
	unchangedErr    error
	closeErrors     []error
	closeCalls      int
	events          *[]string
	readEntered     chan struct{}
	readRelease     chan struct{}
	readEnteredOnce sync.Once
}

func (image *fakeCurrentImage) ReadAt(buffer []byte, offset int64) (int, error) {
	if image.readEntered != nil {
		image.readEnteredOnce.Do(func() { close(image.readEntered) })
		<-image.readRelease
	}
	return bytes.NewReader(image.data).ReadAt(buffer, offset)
}

func (image *fakeCurrentImage) Size() int64 {
	if image.size != 0 {
		return image.size
	}
	return int64(len(image.data))
}

func (image *fakeCurrentImage) Identity() peerverify.FileIdentity { return image.identity }

func (image *fakeCurrentImage) ProcessPathDiagnostic() string { return image.processPath }

func (image *fakeCurrentImage) FinalPathDiagnostic() (string, error) {
	return image.finalPath, image.finalPathErr
}

func (image *fakeCurrentImage) VerifyUnchanged() error {
	*image.events = append(*image.events, "current-image-unchanged")
	return image.unchangedErr
}

func (image *fakeCurrentImage) Close() error {
	*image.events = append(*image.events, "current-image-close")
	index := image.closeCalls
	image.closeCalls++
	if index < len(image.closeErrors) {
		return image.closeErrors[index]
	}
	return nil
}

func TestMeasureCurrentImageIssuesOpaqueHandleBoundEvidence(t *testing.T) {
	session, platform, image := newCurrentImageSession(t)
	bootstrapDigest, err := session.Evidence().Digest()
	if err != nil {
		t.Fatal(err)
	}

	evidence, err := session.MeasureCurrentImage()
	if err != nil {
		t.Fatal(err)
	}
	if err := evidence.Validate(); err != nil {
		t.Fatal(err)
	}
	wantDigest := sha256.Sum256(image.data)
	if evidence.BootstrapDigest() != bootstrapDigest ||
		evidence.ProcessFacts() != session.Evidence().StableServiceHostFacts() ||
		evidence.ProcessPath() != testCurrentImagePath || evidence.Identity() != image.identity ||
		evidence.Size() != uint64(len(image.data)) || evidence.SHA256() != wantDigest {
		t.Fatalf("unexpected current image evidence: %#v", evidence)
	}
	finalPath, finalPathError := evidence.FinalPathDiagnostic()
	if finalPath != image.finalPath || finalPathError != "" {
		t.Fatalf("final-path diagnostic = (%q, %q)", finalPath, finalPathError)
	}
	if image.closeCalls != 1 {
		t.Fatalf("image close calls = %d, want 1", image.closeCalls)
	}
	if _, err := session.MeasureCurrentImage(); !errors.Is(err, ErrCurrentImageMeasured) {
		t.Fatalf("second measurement error = %v, want ErrCurrentImageMeasured", err)
	}
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	if platform.wrapper.closeCalls != 1 || platform.token.closeCalls != 1 || platform.service.closeCalls != 1 {
		t.Fatal("session resources were not closed exactly once")
	}
	if err := evidence.Validate(); err != nil {
		t.Fatalf("detached evidence became invalid after Session.Close: %v", err)
	}
}

func TestCurrentImageEvidenceIsOpaqueImmutableAndDigestComplete(t *testing.T) {
	zero := CurrentImageEvidence{}
	if err := zero.Validate(); !errors.Is(err, ErrInvalidCurrentImageEvidence) {
		t.Fatalf("zero Validate error = %v", err)
	}
	if digest, err := zero.Digest(); !errors.Is(err, ErrInvalidCurrentImageEvidence) || digest != ([sha256.Size]byte{}) {
		t.Fatalf("zero Digest = (%x, %v)", digest, err)
	}
	typeOfEvidence := reflect.TypeOf(zero)
	for index := 0; index < typeOfEvidence.NumField(); index++ {
		if typeOfEvidence.Field(index).IsExported() {
			t.Fatal("CurrentImageEvidence exposes constructible state")
		}
	}

	session, _, _ := newCurrentImageSession(t)
	evidence, err := session.MeasureCurrentImage()
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	baseline, err := evidence.Digest()
	if err != nil {
		t.Fatal(err)
	}
	copied := evidence
	if copiedDigest, err := copied.Digest(); err != nil || copiedDigest != baseline {
		t.Fatalf("copied evidence digest = (%x, %v), want %x", copiedDigest, err, baseline)
	}

	mutations := []struct {
		name   string
		mutate func(*currentImageEvidenceState)
	}{
		{name: "bootstrap digest", mutate: func(state *currentImageEvidenceState) { state.bootstrapDigest[0] ^= 1 }},
		{name: "process PID", mutate: func(state *currentImageEvidenceState) { state.processFacts.ProcessID++ }},
		{name: "process creation", mutate: func(state *currentImageEvidenceState) {
			state.processFacts.CreationTime = state.processFacts.CreationTime.Add(time.Nanosecond)
		}},
		{name: "process start key", mutate: func(state *currentImageEvidenceState) { state.processFacts.StartKey.SequenceNumber++ }},
		{name: "process path", mutate: func(state *currentImageEvidenceState) { state.processPath += ".other" }},
		{name: "volume", mutate: func(state *currentImageEvidenceState) { state.identity.VolumeSerialNumber++ }},
		{name: "file ID", mutate: func(state *currentImageEvidenceState) { state.identity.FileID[0] ^= 1 }},
		{name: "size", mutate: func(state *currentImageEvidenceState) { state.size++ }},
		{name: "SHA-256", mutate: func(state *currentImageEvidenceState) { state.sha256[0] ^= 1 }},
	}
	for _, test := range mutations {
		t.Run(test.name, func(t *testing.T) {
			state := *evidence.state
			test.mutate(&state)
			if digestCurrentImageEvidence(&state) == baseline {
				t.Fatalf("%s is missing from current-image digest", test.name)
			}
			if err := (CurrentImageEvidence{state: &state}).Validate(); !errors.Is(err, ErrInvalidCurrentImageEvidence) {
				t.Fatalf("mutated evidence error = %v", err)
			}
		})
	}

	forgedState := *evidence.state
	forgedState.issuer = &currentImageEvidenceIssuer{marker: successfulCurrentImageEvidenceIssuer.marker}
	forgedState.digest = digestCurrentImageEvidence(&forgedState)
	if err := (CurrentImageEvidence{state: &forgedState}).Validate(); !errors.Is(err, ErrInvalidCurrentImageEvidence) {
		t.Fatalf("forged evidence error = %v", err)
	}

	diagnosticState := *evidence.state
	diagnosticState.finalPathDiagnostic = `\\?\C:\different-diagnostic.exe`
	diagnosticState.finalPathDiagnosticError = "diagnostic only"
	if digestCurrentImageEvidence(&diagnosticState) != baseline {
		t.Fatal("final-path diagnostics changed the authority digest")
	}
	if err := (CurrentImageEvidence{state: &diagnosticState}).Validate(); err != nil {
		t.Fatalf("diagnostic-only mutation invalidated evidence: %v", err)
	}
}

func TestMeasureCurrentImageFailuresAreTerminalAndCloseImage(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*bootstrapSession, *fakePlatform, *fakeCurrentImage)
	}{
		{name: "path TOCTOU", mutate: func(_ *bootstrapSession, platform *fakePlatform, _ *fakeCurrentImage) {
			platform.current.imagePaths = []string{testCurrentImagePath, `C:\Other\AgenticReview.ServiceHost.exe`}
		}},
		{name: "process TOCTOU", mutate: func(_ *bootstrapSession, platform *fakePlatform, _ *fakeCurrentImage) {
			created := platform.current.creationTimes[len(platform.current.creationTimes)-1]
			platform.current.creationTimes = append(platform.current.creationTimes, created, created.Add(time.Nanosecond))
		}},
		{name: "image mutation", mutate: func(_ *bootstrapSession, _ *fakePlatform, image *fakeCurrentImage) {
			image.unchangedErr = errors.New("injected image mutation")
		}},
		{name: "short read", mutate: func(_ *bootstrapSession, _ *fakePlatform, image *fakeCurrentImage) {
			image.size = int64(len(image.data) + 1)
		}},
		{name: "oversize", mutate: func(_ *bootstrapSession, _ *fakePlatform, image *fakeCurrentImage) {
			image.size = int64(releaseprofile.MaximumServiceHostBytes + 1)
		}},
		{name: "identity", mutate: func(_ *bootstrapSession, _ *fakePlatform, image *fakeCurrentImage) {
			image.identity = peerverify.FileIdentity{}
		}},
		{name: "bootstrap evidence", mutate: func(session *bootstrapSession, _ *fakePlatform, _ *fakeCurrentImage) {
			state := *session.evidence.state
			state.options.ServiceName += ".mutated"
			session.evidence = Evidence{state: &state}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			session, platform, image := newCurrentImageSession(t)
			test.mutate(session, platform, image)
			evidence, err := session.MeasureCurrentImage()
			if err == nil || evidence.Validate() == nil {
				t.Fatalf("failed measurement returned evidence %#v and error %v", evidence, err)
			}
			if _, err := session.MeasureCurrentImage(); !errors.Is(err, ErrCurrentImageMeasured) {
				t.Fatalf("retry measurement error = %v, want ErrCurrentImageMeasured", err)
			}
			if test.name != "bootstrap evidence" && image.closeCalls == 0 {
				t.Fatal("failed measurement did not close the image")
			}
			if err := session.Close(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMeasureCurrentImageCloseFailureRetainsOnlyCleanupOwnership(t *testing.T) {
	session, _, image := newCurrentImageSession(t)
	closeFailure := errors.New("injected image close failure")
	image.closeErrors = []error{closeFailure, closeFailure, nil}

	evidence, err := session.MeasureCurrentImage()
	if !errors.Is(err, closeFailure) || evidence.Validate() == nil {
		t.Fatalf("measurement = (%#v, %v), want close failure and no evidence", evidence, err)
	}
	if image.closeCalls != 2 {
		t.Fatalf("measurement close calls = %d, want 2", image.closeCalls)
	}
	if _, err := session.MeasureCurrentImage(); !errors.Is(err, ErrCurrentImageMeasured) {
		t.Fatalf("retry measurement error = %v", err)
	}
	if err := session.Close(); err != nil {
		t.Fatalf("Session.Close cleanup error = %v", err)
	}
	if image.closeCalls != 3 {
		t.Fatalf("total image close calls = %d, want 3", image.closeCalls)
	}
}

func TestMeasureCurrentImageIsLinearizedWithClose(t *testing.T) {
	session, _, image := newCurrentImageSession(t)
	image.readEntered = make(chan struct{})
	image.readRelease = make(chan struct{})
	measurementDone := make(chan error, 1)
	closeDone := make(chan error, 1)

	go func() {
		evidence, err := session.MeasureCurrentImage()
		if err == nil {
			err = evidence.Validate()
		}
		measurementDone <- err
	}()
	<-image.readEntered
	go func() { closeDone <- session.Close() }()
	select {
	case err := <-closeDone:
		t.Fatalf("Close completed before measurement released: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(image.readRelease)
	if err := <-measurementDone; err != nil {
		t.Fatalf("measurement error = %v", err)
	}
	if err := <-closeDone; err != nil {
		t.Fatalf("Close error = %v", err)
	}
	if _, err := session.MeasureCurrentImage(); !errors.Is(err, ErrClosed) {
		t.Fatalf("post-close measurement error = %v, want ErrClosed", err)
	}
}

func TestMeasureCurrentImageRejectsClosedSession(t *testing.T) {
	session, _, image := newCurrentImageSession(t)
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := session.MeasureCurrentImage(); !errors.Is(err, ErrClosed) {
		t.Fatalf("measurement error = %v, want ErrClosed", err)
	}
	if image.closeCalls != 0 {
		t.Fatal("closed session opened or closed the current image")
	}
}

func newCurrentImageSession(t *testing.T) (*bootstrapSession, *fakePlatform, *fakeCurrentImage) {
	t.Helper()
	platform, _, _ := newSuccessfulFakePlatform()
	opened, err := openWithTestPlatform(validOptions(), platform)
	if err != nil {
		t.Fatal(err)
	}
	session := opened.(*bootstrapSession)
	data := []byte("MZ current ServiceHost image bytes")
	image := &fakeCurrentImage{
		data: data,
		identity: peerverify.FileIdentity{
			VolumeSerialNumber: 7,
			FileID:             [16]byte{1, 2, 3, 4},
		},
		processPath: testCurrentImagePath,
		finalPath:   `\\?\C:\Program Files\AgenticReview\native\AgenticReview.ServiceHost.exe`,
		events:      platform.events,
	}
	platform.current.imagePaths = []string{testCurrentImagePath, testCurrentImagePath}
	platform.current.image = image
	return session, platform, image
}

var _ peerverify.ImageSubject = (*fakeCurrentImage)(nil)
var _ io.ReaderAt = (*fakeCurrentImage)(nil)
