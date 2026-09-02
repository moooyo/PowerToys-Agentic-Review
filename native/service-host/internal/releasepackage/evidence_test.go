package releasepackage

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peimage"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/servicehostreceipt"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winfile"
)

func TestReviewedClosureLoaderUsesDistinctStableReadOnceInputs(t *testing.T) {
	request := validPrepareRequest(t)
	document := request.ReviewedClosure.Document()
	digest := sha256.Sum256(document)
	approval := newFakeReleaseFile(`C:\approved\closure.sha256`, []byte(hex.EncodeToString(digest[:])), 1)
	closure := newFakeReleaseFile(`C:\staging\closure.json`, document, 2)
	checked := 0
	loaded, err := loadReviewedClosure("approval", "closure", evidenceDependencies{
		openFile: fakeReleaseOpener(map[string]*fakeReleaseFile{
			"approval": approval,
			"closure":  closure,
		}),
		checkIndependentApproval: func(value retainedReleaseFile) error {
			checked++
			if value != approval {
				return errors.New("wrong approval file")
			}
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if loaded.SHA256() != digest || checked != 1 || approval.readCalls != 1 || closure.readCalls != 1 ||
		approval.verifyCalls != 1 || closure.verifyCalls != 1 || approval.securityCalls != 2 {
		t.Fatalf("loader did not retain, read once, and recheck both inputs: approval=%+v closure=%+v", approval, closure)
	}
}

func TestApprovedDocumentLoadersRejectSameIdentityMutationAndUnapprovedReceipt(t *testing.T) {
	request := validPrepareRequest(t)
	document := request.ReviewedClosure.Document()
	digest := sha256.Sum256(document)
	approval := newFakeReleaseFile("approval", []byte(hex.EncodeToString(digest[:])), 1)
	closure := newFakeReleaseFile("closure", document, 1)
	_, err := loadReviewedClosure("approval", "closure", evidenceDependencies{
		openFile:                 fakeReleaseOpener(map[string]*fakeReleaseFile{"approval": approval, "closure": closure}),
		checkIndependentApproval: func(retainedReleaseFile) error { return nil },
	})
	if !errors.Is(err, ErrReviewedClosureVerification) {
		t.Fatalf("same-identity closure inputs returned %v", err)
	}

	prepared, err := Prepare(request)
	if err != nil {
		t.Fatal(err)
	}
	build := validBuildEvidenceForUnsigned(t, prepared, minimalUnsignedServiceHost(t, ArchitectureAMD64))
	receiptApproval := newFakeReleaseFile("receipt approval", []byte(strings.Repeat("0", 64)), 3)
	receiptFile := newFakeReleaseFile("receipt", build.state.document, 4)
	_, err = loadServiceHostBuildReceipt("approval", "receipt", evidenceDependencies{
		openFile: fakeReleaseOpener(map[string]*fakeReleaseFile{
			"approval": receiptApproval,
			"receipt":  receiptFile,
		}),
		checkIndependentApproval: func(retainedReleaseFile) error { return nil },
	})
	if !errors.Is(err, ErrServiceHostBuildVerification) {
		t.Fatalf("unapproved build receipt returned %v", err)
	}
}

func TestServiceHostBuildReceiptLoaderUsesIndependentApproval(t *testing.T) {
	prepared, err := Prepare(validPrepareRequest(t))
	if err != nil {
		t.Fatal(err)
	}
	build := validBuildEvidenceForUnsigned(t, prepared, minimalUnsignedServiceHost(t, ArchitectureAMD64))
	digest := sha256.Sum256(build.state.document)
	approval := newFakeReleaseFile("receipt approval", []byte(hex.EncodeToString(digest[:])), 5)
	receipt := newFakeReleaseFile("receipt", build.state.document, 6)
	loaded, err := loadServiceHostBuildReceipt("approval", "receipt", evidenceDependencies{
		openFile: fakeReleaseOpener(map[string]*fakeReleaseFile{
			"approval": approval,
			"receipt":  receipt,
		}),
		checkIndependentApproval: func(value retainedReleaseFile) error {
			if value != approval {
				return errors.New("wrong approval file")
			}
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if loaded.state == nil || loaded.state.sha256 != digest || loaded.state.receipt != build.state.receipt ||
		approval.readCalls != 1 || receipt.readCalls != 1 || approval.securityCalls != 2 {
		t.Fatalf("unexpected approved build evidence: %#v", loaded.state)
	}
}

func TestVerifyServiceHostBindsApprovedBuildLineageToSignedImage(t *testing.T) {
	prepareRequest := validPrepareRequest(t)
	prepared, err := Prepare(prepareRequest)
	if err != nil {
		t.Fatal(err)
	}
	unsigned := minimalUnsignedServiceHost(t, ArchitectureAMD64)
	build := validBuildEvidenceForUnsigned(t, prepared, unsigned)
	signed := signServiceHostFixture(unsigned)
	file := newFakeReleaseFile("signed ServiceHost", signed, 9)
	file.signature = validAuthenticodeFixture(prepareRequest.AuthenticodeLeafSignerCertificateDERSHA256)
	evidence, err := verifyServiceHost(prepared, build, "service-host", evidenceDependencies{
		openFile:                fakeReleaseOpener(map[string]*fakeReleaseFile{"service-host": file}),
		newAuthenticodeVerifier: func() (authenticode.Verifier, error) { return unusedAuthenticodeVerifier{}, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	wantDigest := sha256.Sum256(signed)
	if evidence.state == nil || evidence.state.digest != wantDigest ||
		evidence.state.buildReceiptSHA256 != build.state.sha256 || file.readCalls != 1 ||
		file.authenticodeCalls != 1 || file.hashCalls != 1 || file.verifyCalls != 2 {
		t.Fatalf("unexpected verified ServiceHost evidence or call sequence: %#v file=%+v", evidence.state, file)
	}
}

func TestVerifyServiceHostRejectsLineageMixAndPostSignatureMutation(t *testing.T) {
	prepared, err := Prepare(validPrepareRequest(t))
	if err != nil {
		t.Fatal(err)
	}
	unsigned := minimalUnsignedServiceHost(t, ArchitectureAMD64)
	build := validBuildEvidenceForUnsigned(t, prepared, unsigned)
	signed := signServiceHostFixture(unsigned)

	t.Run("same signer different image", func(t *testing.T) {
		changed := append([]byte(nil), signed...)
		changed[0x200] ^= 0xff
		file := newFakeReleaseFile("old signed ServiceHost", changed, 10)
		file.signature = validAuthenticodeFixture(prepared.state.receipt.AuthenticodeLeafSignerCertificateDERSHA256)
		_, err := verifyServiceHost(prepared, build, "service-host", evidenceDependencies{
			openFile:                fakeReleaseOpener(map[string]*fakeReleaseFile{"service-host": file}),
			newAuthenticodeVerifier: func() (authenticode.Verifier, error) { return unusedAuthenticodeVerifier{}, nil },
		})
		if !errors.Is(err, ErrServiceHostVerification) || file.authenticodeCalls != 0 {
			t.Fatalf("mixed signed image returned %v after %d signature calls", err, file.authenticodeCalls)
		}
	})

	t.Run("post signature mutation", func(t *testing.T) {
		file := newFakeReleaseFile("mutating signed ServiceHost", signed, 11)
		file.signature = validAuthenticodeFixture(prepared.state.receipt.AuthenticodeLeafSignerCertificateDERSHA256)
		file.afterAuthenticode = func() { file.data[0x200] ^= 0xff }
		_, err := verifyServiceHost(prepared, build, "service-host", evidenceDependencies{
			openFile:                fakeReleaseOpener(map[string]*fakeReleaseFile{"service-host": file}),
			newAuthenticodeVerifier: func() (authenticode.Verifier, error) { return unusedAuthenticodeVerifier{}, nil },
		})
		if !errors.Is(err, ErrServiceHostVerification) {
			t.Fatalf("post-signature mutation returned %v", err)
		}
	})

	t.Run("different source receipt", func(t *testing.T) {
		mixed := cloneBuildEvidence(build)
		mixed.state.receipt.Source.Tree = strings.Repeat("f", 40)
		mixed.state.document, err = servicehostreceipt.MarshalCanonical(mixed.state.receipt)
		if err != nil {
			t.Fatal(err)
		}
		mixed.state.sha256 = sha256.Sum256(mixed.state.document)
		openCalls := 0
		_, err := verifyServiceHost(prepared, mixed, "service-host", evidenceDependencies{
			openFile: func(string, winfile.OpenOptions) (retainedReleaseFile, error) {
				openCalls++
				return nil, errors.New("must not open")
			},
			newAuthenticodeVerifier: func() (authenticode.Verifier, error) { return unusedAuthenticodeVerifier{}, nil },
		})
		if !errors.Is(err, ErrServiceHostVerification) || openCalls != 0 {
			t.Fatalf("mixed build lineage returned %v after %d opens", err, openCalls)
		}
	})
}

func TestEvidenceVerificationErrorsDoNotExposePathsOrSignerPins(t *testing.T) {
	secretPath := `C:\secret\approval.sha256`
	secretPin := strings.Repeat("e", 64)
	_, err := loadReviewedClosure(secretPath, "closure", evidenceDependencies{
		openFile: func(string, winfile.OpenOptions) (retainedReleaseFile, error) {
			return nil, fmt.Errorf("open %s with signer %s", secretPath, secretPin)
		},
		checkIndependentApproval: func(retainedReleaseFile) error { return nil },
	})
	if err == nil || strings.Contains(err.Error(), secretPath) || strings.Contains(err.Error(), secretPin) {
		t.Fatalf("verification error leaked sensitive input: %v", err)
	}
}

func TestEvidenceIsWithheldAfterAnyRetainedHandleCloseFailure(t *testing.T) {
	request := validPrepareRequest(t)
	document := request.ReviewedClosure.Document()
	digest := sha256.Sum256(document)
	approval := newFakeReleaseFile("approval", []byte(hex.EncodeToString(digest[:])), 21)
	closure := newFakeReleaseFile("closure", document, 22)
	closure.closeFailures = 1
	loaded, err := loadReviewedClosure("approval", "closure", evidenceDependencies{
		openFile: fakeReleaseOpener(map[string]*fakeReleaseFile{
			"approval": approval,
			"closure":  closure,
		}),
		checkIndependentApproval: func(retainedReleaseFile) error { return nil },
	})
	if !errors.Is(err, ErrReviewedClosureVerification) || loaded.state != nil || closure.closeCalls != 2 {
		t.Fatalf("close failure returned evidence=%#v err=%v closeCalls=%d", loaded, err, closure.closeCalls)
	}
}

func TestCleanupFatalInvalidatesInflightAndFutureCommits(t *testing.T) {
	coordinator := healthyReleaseCleanupState()
	inflight, err := coordinator.begin()
	if err != nil {
		t.Fatal(err)
	}
	resource := newFakeReleaseFile("unresolved", []byte{1}, 23)
	coordinator.publish(resource)
	if err := inflight.commit(); !errors.Is(err, ErrReleaseCleanupFatal) {
		t.Fatalf("inflight commit returned %v", err)
	}
	if _, err := coordinator.begin(); !errors.Is(err, ErrReleaseCleanupFatal) {
		t.Fatalf("future begin returned %v", err)
	}
	if len(coordinator.resources) != 1 || coordinator.resources[0] != resource {
		t.Fatal("cleanup coordinator did not retain the unresolved resource")
	}
}

func TestFinalizeRejectsPreviouslyIssuedEvidenceAfterCleanupFatal(t *testing.T) {
	previous := releaseCleanupCoordinator
	releaseCleanupCoordinator = healthyReleaseCleanupState()
	t.Cleanup(func() { releaseCleanupCoordinator = previous })
	prepared, request := validFinalization(t)
	releaseCleanupCoordinator.publish(newFakeReleaseFile("unresolved", []byte{1}, 24))
	if _, err := Finalize(prepared, request); !errors.Is(err, ErrReleaseCleanupFatal) {
		t.Fatalf("Finalize after cleanup fatal returned %v", err)
	}
}

func TestAssemblySnapshotRejectsFinalizedReleaseAfterCleanupFatal(t *testing.T) {
	t.Run("release cleanup fatal", func(t *testing.T) {
		previous := releaseCleanupCoordinator
		releaseCleanupCoordinator = healthyReleaseCleanupState()
		t.Cleanup(func() { releaseCleanupCoordinator = previous })
		prepared, request := validFinalization(t)
		finalized, err := Finalize(prepared, request)
		if err != nil {
			t.Fatal(err)
		}
		releaseCleanupCoordinator.publish(newFakeReleaseFile("unresolved", []byte{1}, 26))
		if snapshot, err := finalized.SnapshotForAssembly(); !errors.Is(err, ErrReleaseCleanupFatal) || snapshot.state != nil {
			t.Fatalf("SnapshotForAssembly returned snapshot=%#v err=%v", snapshot, err)
		}
	})

	t.Run("platform cleanup fatal", func(t *testing.T) {
		previous := releaseCleanupCoordinator
		platform := &fakePlatformCleanupGate{}
		releaseCleanupCoordinator = &releaseCleanupState{
			platformStatus: platform.status,
			platformCommit: platform.commit,
		}
		t.Cleanup(func() { releaseCleanupCoordinator = previous })
		prepared, request := validFinalization(t)
		finalized, err := Finalize(prepared, request)
		if err != nil {
			t.Fatal(err)
		}
		platform.publish(errors.New("platform cleanup fatal"))
		if snapshot, err := finalized.SnapshotForAssembly(); !errors.Is(err, ErrReleaseCleanupFatal) || snapshot.state != nil {
			t.Fatalf("SnapshotForAssembly returned snapshot=%#v err=%v", snapshot, err)
		}
	})
}

func TestUnresolvedResourceClosePublishesFatalBeforeCommit(t *testing.T) {
	previous := releaseCleanupCoordinator
	releaseCleanupCoordinator = healthyReleaseCleanupState()
	t.Cleanup(func() { releaseCleanupCoordinator = previous })
	operation, err := beginReleaseEvidenceOperation()
	if err != nil {
		t.Fatal(err)
	}
	resource := newFakeReleaseFile("unresolved", []byte{1}, 25)
	resource.closeFailures = releaseFileCloseAttempts
	if err := closeReleaseCleanupResource(resource); err == nil {
		t.Fatal("unresolved close unexpectedly succeeded")
	}
	if err := operation.commit(); !errors.Is(err, ErrReleaseCleanupFatal) {
		t.Fatalf("commit after unresolved close returned %v", err)
	}
	if len(releaseCleanupCoordinator.resources) != 1 ||
		releaseCleanupCoordinator.resources[0] != resource {
		t.Fatal("unresolved resource was not retained by the fatal coordinator")
	}
}

func TestCleanupCommitLinearizesWithPlatformQuarantine(t *testing.T) {
	t.Run("platform fatal before begin", func(t *testing.T) {
		platform := &fakePlatformCleanupGate{fatal: errors.New("platform cleanup fatal")}
		coordinator := &releaseCleanupState{
			platformStatus: platform.status,
			platformCommit: platform.commit,
		}
		if _, err := coordinator.begin(); !errors.Is(err, ErrReleaseCleanupFatal) {
			t.Fatalf("begin returned %v", err)
		}
	})

	t.Run("platform fatal before commit", func(t *testing.T) {
		platform := &fakePlatformCleanupGate{}
		coordinator := &releaseCleanupState{
			platformStatus: platform.status,
			platformCommit: platform.commit,
		}
		operation, err := coordinator.begin()
		if err != nil {
			t.Fatal(err)
		}
		platform.publish(errors.New("platform cleanup fatal"))
		if err := operation.commit(); !errors.Is(err, ErrReleaseCleanupFatal) {
			t.Fatalf("commit returned %v", err)
		}
	})

	t.Run("healthy commit before platform fatal", func(t *testing.T) {
		platform := &fakePlatformCleanupGate{
			commitEntered: make(chan struct{}),
			releaseCommit: make(chan struct{}),
		}
		coordinator := &releaseCleanupState{
			platformStatus: platform.status,
			platformCommit: platform.commit,
		}
		operation, err := coordinator.begin()
		if err != nil {
			t.Fatal(err)
		}
		commitDone := make(chan error, 1)
		go func() { commitDone <- operation.commit() }()
		<-platform.commitEntered
		publishDone := make(chan struct{})
		go func() {
			platform.publish(errors.New("platform cleanup fatal"))
			close(publishDone)
		}()
		close(platform.releaseCommit)
		if err := <-commitDone; err != nil {
			t.Fatalf("healthy commit returned %v", err)
		}
		<-publishDone
		if _, err := coordinator.begin(); !errors.Is(err, ErrReleaseCleanupFatal) {
			t.Fatalf("begin after platform fatal returned %v", err)
		}
	})
}

func healthyReleaseCleanupState() *releaseCleanupState {
	return &releaseCleanupState{
		platformStatus: func() error { return nil },
		platformCommit: func(commit func()) error {
			if commit == nil {
				return errors.New("commit is absent")
			}
			commit()
			return nil
		},
	}
}

type fakePlatformCleanupGate struct {
	mu            sync.RWMutex
	fatal         error
	commitEntered chan struct{}
	releaseCommit chan struct{}
}

func (gate *fakePlatformCleanupGate) status() error {
	gate.mu.RLock()
	defer gate.mu.RUnlock()
	return gate.fatal
}

func (gate *fakePlatformCleanupGate) commit(commit func()) error {
	gate.mu.RLock()
	defer gate.mu.RUnlock()
	if gate.fatal != nil {
		return gate.fatal
	}
	if gate.commitEntered != nil {
		close(gate.commitEntered)
		<-gate.releaseCommit
	}
	commit()
	return nil
}

func (gate *fakePlatformCleanupGate) publish(err error) {
	gate.mu.Lock()
	gate.fatal = err
	gate.mu.Unlock()
}

type fakeReleaseFile struct {
	data              []byte
	evidence          winfile.Evidence
	ancestors         []winfile.Evidence
	signature         authenticode.Evidence
	afterAuthenticode func()
	readCalls         int
	hashCalls         int
	authenticodeCalls int
	verifyCalls       int
	securityCalls     int
	closeCalls        int
	closeFailures     int
	verifyErr         error
}

func newFakeReleaseFile(path string, data []byte, identity byte) *fakeReleaseFile {
	security := winfile.SecurityDescriptorEvidence{
		OwnerSID: "owner", GroupSID: "group", DACLPresent: true, DACLProtected: true,
		SelfRelativeDescriptor: []byte{1},
	}
	return &fakeReleaseFile{
		data: append([]byte(nil), data...),
		evidence: winfile.Evidence{
			Kind:     winfile.ObjectKindFile,
			Identity: winfile.FileIdentity{VolumeSerialNumber: 1, FileID: [16]byte{identity}},
			Size:     uint64(len(data)), LinkCount: 1,
			Path: winfile.PathEvidence{
				RequestedPath: path, TerminalComponentReparseFree: true,
				Ancestors: winfile.AncestorValidationNotPerformed,
			},
			Volume: winfile.VolumeEvidence{
				PersistentACLs: true, PathIdentityCrossCheck: true, RequiredUse: winfile.VolumeUseReadOnly,
			},
			SecurityMode: winfile.SecurityModeManaged,
			Security:     security,
		},
	}
}

func (file *fakeReleaseFile) Evidence() winfile.Evidence { return file.evidence }
func (file *fakeReleaseFile) AncestorEvidence() []winfile.Evidence {
	return append([]winfile.Evidence(nil), file.ancestors...)
}
func (file *fakeReleaseFile) ReadAll(maximum uint64) ([]byte, error) {
	file.readCalls++
	if uint64(len(file.data)) > maximum {
		return nil, winfile.ErrTooLarge
	}
	return append([]byte(nil), file.data...), nil
}
func (file *fakeReleaseFile) HashSHA256(options winfile.HashOptions) (winfile.HashResult, error) {
	file.hashCalls++
	if uint64(len(file.data)) != options.ExpectedSize || options.ExpectedSize > options.MaximumBytes {
		return winfile.HashResult{}, winfile.ErrSizeMismatch
	}
	return winfile.HashResult{SHA256: sha256.Sum256(file.data), Size: uint64(len(file.data))}, nil
}
func (file *fakeReleaseFile) VerifyAuthenticode(authenticode.Verifier) (authenticode.Evidence, error) {
	file.authenticodeCalls++
	result := file.signature
	if file.afterAuthenticode != nil {
		file.afterAuthenticode()
	}
	return result, nil
}
func (file *fakeReleaseFile) VerifyUnchanged() error {
	file.verifyCalls++
	return file.verifyErr
}
func (file *fakeReleaseFile) ReinspectSecurity() (winfile.SecurityDescriptorEvidence, error) {
	file.securityCalls++
	return file.evidence.Security, nil
}
func (file *fakeReleaseFile) Close() error {
	file.closeCalls++
	if file.closeCalls <= file.closeFailures {
		return errors.New("close failed")
	}
	return nil
}

type unusedAuthenticodeVerifier struct{}

func (unusedAuthenticodeVerifier) Verify(authenticode.Subject) (authenticode.Evidence, error) {
	return authenticode.Evidence{}, errors.New("fake file must not call verifier directly")
}

func fakeReleaseOpener(values map[string]*fakeReleaseFile) func(string, winfile.OpenOptions) (retainedReleaseFile, error) {
	return func(path string, options winfile.OpenOptions) (retainedReleaseFile, error) {
		if options != releaseInputOpenOptions() || values[path] == nil {
			return nil, errors.New("unexpected release file open")
		}
		return values[path], nil
	}
}

func validBuildEvidenceForUnsigned(
	t *testing.T,
	prepared PreparedRelease,
	unsigned []byte,
) ServiceHostBuildEvidence {
	t.Helper()
	invariant, signed, err := peimage.SigningInvariantSHA256(
		bytes.NewReader(unsigned),
		int64(len(unsigned)),
		string(prepared.state.receipt.TargetArchitecture),
	)
	if err != nil || signed {
		t.Fatalf("derive unsigned signing invariant: signed=%t err=%v", signed, err)
	}
	unsignedDigest := sha256.Sum256(unsigned)
	receipt := servicehostreceipt.Receipt{
		CompiledReleaseTemplateSHA256: prepared.state.receipt.CompiledReleaseTemplateSHA256,
		PackageProfile:                servicehostreceipt.PackageProfile,
		ReleaseID:                     prepared.state.receipt.ReleaseID,
		SchemaVersion:                 servicehostreceipt.SchemaVersion,
		SigningInvariantSHA256:        hex.EncodeToString(invariant[:]),
		Source: servicehostreceipt.Source{
			Commit: prepared.state.receipt.Source.Commit,
			Tree:   prepared.state.receipt.Source.Tree,
		},
		TargetArchitecture: string(prepared.state.receipt.TargetArchitecture),
		UnsignedSHA256:     hex.EncodeToString(unsignedDigest[:]),
		UnsignedSize:       fmt.Sprintf("%d", len(unsigned)),
	}
	document, err := servicehostreceipt.MarshalCanonical(receipt)
	if err != nil {
		t.Fatal(err)
	}
	return ServiceHostBuildEvidence{state: &serviceHostBuildState{
		document: document,
		sha256:   sha256.Sum256(document),
		receipt:  receipt,
	}}
}

func cloneBuildEvidence(value ServiceHostBuildEvidence) ServiceHostBuildEvidence {
	state := *value.state
	state.document = append([]byte(nil), value.state.document...)
	return ServiceHostBuildEvidence{state: &state}
}

func minimalUnsignedServiceHost(t *testing.T, architecture TargetArchitecture) []byte {
	t.Helper()
	machine, err := peimage.ExpectedMachine(string(architecture))
	if err != nil {
		t.Fatal(err)
	}
	const (
		peOffset         = 0x80
		optionalHeader   = peOffset + 4 + 20
		sectionTable     = optionalHeader + 0xf0
		rawSectionOffset = 0x200
		rawSectionSize   = 0x200
		imageSize        = rawSectionOffset + rawSectionSize
	)
	image := make([]byte, imageSize)
	image[0], image[1] = 'M', 'Z'
	binary.LittleEndian.PutUint32(image[0x3c:], peOffset)
	copy(image[peOffset:], []byte{'P', 'E', 0, 0})
	coff := image[peOffset+4 : optionalHeader]
	binary.LittleEndian.PutUint16(coff[0:], machine)
	binary.LittleEndian.PutUint16(coff[2:], 1)
	binary.LittleEndian.PutUint16(coff[16:], 0xf0)
	binary.LittleEndian.PutUint16(coff[18:], 0x22)
	optional := image[optionalHeader:sectionTable]
	binary.LittleEndian.PutUint16(optional[0:], 0x20b)
	binary.LittleEndian.PutUint32(optional[4:], rawSectionSize)
	binary.LittleEndian.PutUint32(optional[16:], 0x1000)
	binary.LittleEndian.PutUint32(optional[20:], 0x1000)
	binary.LittleEndian.PutUint64(optional[24:], 0x140000000)
	binary.LittleEndian.PutUint32(optional[32:], 0x1000)
	binary.LittleEndian.PutUint32(optional[36:], 0x200)
	binary.LittleEndian.PutUint16(optional[40:], 6)
	binary.LittleEndian.PutUint16(optional[48:], 6)
	binary.LittleEndian.PutUint32(optional[56:], 0x2000)
	binary.LittleEndian.PutUint32(optional[60:], rawSectionOffset)
	binary.LittleEndian.PutUint16(optional[68:], 3)
	binary.LittleEndian.PutUint64(optional[72:], 0x100000)
	binary.LittleEndian.PutUint64(optional[80:], 0x1000)
	binary.LittleEndian.PutUint64(optional[88:], 0x100000)
	binary.LittleEndian.PutUint64(optional[96:], 0x1000)
	binary.LittleEndian.PutUint32(optional[108:], 16)
	section := image[sectionTable : sectionTable+40]
	copy(section[:8], []byte(".text"))
	binary.LittleEndian.PutUint32(section[8:], 1)
	binary.LittleEndian.PutUint32(section[12:], 0x1000)
	binary.LittleEndian.PutUint32(section[16:], rawSectionSize)
	binary.LittleEndian.PutUint32(section[20:], rawSectionOffset)
	binary.LittleEndian.PutUint32(section[36:], 0x60000020)
	image[rawSectionOffset] = 0xc3
	return image
}

func signServiceHostFixture(unsigned []byte) []byte {
	result := append([]byte(nil), unsigned...)
	const certificateSize = 16
	certificateOffset := len(result)
	certificate := make([]byte, certificateSize)
	binary.LittleEndian.PutUint32(certificate[0:], certificateSize)
	binary.LittleEndian.PutUint16(certificate[4:], 0x0200)
	binary.LittleEndian.PutUint16(certificate[6:], 0x0002)
	copy(certificate[8:], []byte("fixture!"))
	result = append(result, certificate...)
	optionalHeaderOffset := 0x80 + 4 + 20
	binary.LittleEndian.PutUint32(result[optionalHeaderOffset+64:], 0x12345678)
	securityDirectoryOffset := optionalHeaderOffset + 112 + 4*8
	binary.LittleEndian.PutUint32(result[securityDirectoryOffset:], uint32(certificateOffset))
	binary.LittleEndian.PutUint32(result[securityDirectoryOffset+4:], certificateSize)
	return result
}
