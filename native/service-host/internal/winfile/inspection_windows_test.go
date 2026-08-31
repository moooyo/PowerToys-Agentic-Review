//go:build windows

package winfile

import (
	"encoding/binary"
	"errors"
	"reflect"
	"testing"
	"unicode/utf16"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/authenticode"
	"golang.org/x/sys/windows"
)

type recordingAuthenticodeVerifier struct {
	calls    int
	evidence authenticode.Evidence
	err      error
}

func (verifier *recordingAuthenticodeVerifier) Verify(subject authenticode.Subject) (authenticode.Evidence, error) {
	verifier.calls++
	if subject == (authenticode.Subject{}) {
		return authenticode.Evidence{}, errors.New("received an empty subject")
	}
	return verifier.evidence, verifier.err
}

func TestWindowsInspectionConstantsMatchNativeContracts(t *testing.T) {
	if windows.FileIdExtdDirectoryInfo != 19 || windows.FileIdExtdDirectoryRestartInfo != 20 {
		t.Fatal("extended directory information classes changed")
	}
	if windows.FileStreamInfo != 7 || windows.FileCaseSensitiveInfo != 23 {
		t.Fatal("stream or case-sensitivity information class changed")
	}
	if caseSensitiveDirectoryBit != windows.FILE_CS_FLAG_CASE_SENSITIVE_DIR {
		t.Fatal("case-sensitive directory flag changed")
	}
	if extendedDirectoryEntryHeaderBytes != 88 || streamInformationHeaderBytes != 24 {
		t.Fatal("native variable-length record layout changed")
	}
}

func TestParseExtendedDirectoryInformation(t *testing.T) {
	first := makeExtendedDirectoryRecord("zeta.txt", 0, 7, 11)
	second := makeExtendedDirectoryRecord("Folder", fileAttributeDirectory, 0, 12)
	firstLength := alignToEight(uint32(len(first)))
	buffer := make([]byte, int(firstLength)+len(second))
	copy(buffer, first)
	binary.LittleEndian.PutUint32(buffer[0:4], firstLength)
	copy(buffer[int(firstLength):], second)

	var entries []rawDirectoryEntry
	err := parseExtendedDirectoryInformation(buffer, func(entry rawDirectoryEntry) error {
		entries = append(entries, entry)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].entry.Name != "zeta.txt" || entries[0].entry.Kind != ObjectKindFile ||
		entries[0].entry.Size != 7 || entries[0].entry.Identity.FileID[0] != 11 ||
		entries[1].entry.Name != "Folder" || entries[1].entry.Kind != ObjectKindDirectory ||
		entries[1].entry.Identity.FileID[0] != 12 {
		t.Fatalf("unexpected entries: %+v", entries)
	}
}

func TestParseExtendedDirectoryInformationRejectsMalformedOffset(t *testing.T) {
	buffer := makeExtendedDirectoryRecord("file.txt", 0, 1, 1)
	binary.LittleEndian.PutUint32(buffer[0:4], 8)
	if err := parseExtendedDirectoryInformation(buffer, func(rawDirectoryEntry) error { return nil }); !errors.Is(err, ErrDirectoryEnumeration) {
		t.Fatalf("malformed directory record returned %v", err)
	}
}

func TestParseStreamInformation(t *testing.T) {
	buffer := makeStreamInformationRecord(defaultDataStreamName, 9, 16)
	streams, err := parseStreamInformation(buffer)
	if err != nil {
		t.Fatal(err)
	}
	want := []DataStream{{Name: defaultDataStreamName, Size: 9, AllocationSize: 16}}
	if !reflect.DeepEqual(streams, want) {
		t.Fatalf("streams = %+v, want %+v", streams, want)
	}
}

func TestParseStreamInformationAcceptsSuccessfulEmptyDirectoryBuffer(t *testing.T) {
	streams, err := parseStreamInformation(make([]byte, initialStreamInformationBytes))
	if err != nil {
		t.Fatal(err)
	}
	if streams != nil {
		t.Fatalf("empty buffer returned streams %+v", streams)
	}
	if err := validateDataStreams(ObjectKindDirectory, 0, streams); err != nil {
		t.Fatalf("empty directory stream set rejected: %v", err)
	}
	if err := validateDataStreams(ObjectKindFile, 0, streams); !errors.Is(err, ErrStreamEnumeration) {
		t.Fatalf("empty file stream set returned %v", err)
	}
}

func TestWindowsFileCloseRetainsHandleForRetry(t *testing.T) {
	closeFailure := errors.New("close failed")
	attempts := 0
	file := &File{
		handle: windows.Handle(123),
		closeHandle: func(handle windows.Handle) error {
			attempts++
			if handle != windows.Handle(123) {
				t.Fatalf("handle = %d", handle)
			}
			if attempts == 1 {
				return closeFailure
			}
			return nil
		},
	}
	if err := file.Close(); !errors.Is(err, closeFailure) {
		t.Fatalf("first Close error = %v", err)
	}
	if file.handle != windows.Handle(123) || !file.closed {
		t.Fatal("failed Close discarded the file handle")
	}
	if _, err := file.HashSHA256(HashOptions{MaximumBytes: 1}); !errors.Is(err, ErrClosed) {
		t.Fatalf("HashSHA256 after failed Close returned %v", err)
	}
	if _, err := file.VerifyAuthenticode(&recordingAuthenticodeVerifier{}); !errors.Is(err, ErrClosed) {
		t.Fatalf("VerifyAuthenticode after failed Close returned %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("retry Close error = %v", err)
	}
	if file.handle != 0 || !file.closed || attempts != 2 {
		t.Fatalf("retry left handle=%d closed=%v attempts=%d", file.handle, file.closed, attempts)
	}
}

func TestWindowsDirectoryCloseRetainsHandleForRetry(t *testing.T) {
	closeFailure := errors.New("close failed")
	attempts := 0
	directory := &Directory{
		handle: windows.Handle(456),
		closeHandle: func(handle windows.Handle) error {
			attempts++
			if handle != windows.Handle(456) {
				t.Fatalf("handle = %d", handle)
			}
			if attempts == 1 {
				return closeFailure
			}
			return nil
		},
	}
	if err := directory.Close(); !errors.Is(err, closeFailure) {
		t.Fatalf("first Close error = %v", err)
	}
	if directory.handle != windows.Handle(456) || !directory.closed {
		t.Fatal("failed Close discarded the directory handle")
	}
	if _, err := directory.Enumerate(DirectoryEnumerationOptions{
		MaximumEntries: 1, MaximumNameUTF16Units: 1, MaximumTotalNameUTF16Units: 1,
	}); !errors.Is(err, ErrClosed) {
		t.Fatalf("Enumerate after failed Close returned %v", err)
	}
	if err := directory.Close(); err != nil {
		t.Fatalf("retry Close error = %v", err)
	}
	if directory.handle != 0 || !directory.closed || attempts != 2 {
		t.Fatalf("retry left handle=%d closed=%v attempts=%d", directory.handle, directory.closed, attempts)
	}
}

func TestDiscardedObjectRetriesCloseAndPreservesFailures(t *testing.T) {
	closeFailure := errors.New("transient close failure")
	attempts := 0
	file := &File{
		handle: windows.Handle(600),
		closeHandle: func(windows.Handle) error {
			attempts++
			if attempts < discardedHandleCloseAttempts {
				return closeFailure
			}
			return nil
		},
	}
	err := closeDiscardedObject("close discarded fixture", file)
	if !errors.Is(err, closeFailure) {
		t.Fatalf("close error = %v", err)
	}
	if attempts != discardedHandleCloseAttempts || file.handle != 0 || !file.closed {
		t.Fatalf("attempts=%d handle=%d closed=%v", attempts, file.handle, file.closed)
	}
}

func TestDiscardedNativeHandleIsConsumedOnceAndQuarantined(t *testing.T) {
	closeFailure := errors.New("persistent close failure")
	attempts := 0
	quarantine := &discardedHandleQuarantine{}
	err := closeDiscardedHandleWithQuarantine(windows.Handle(601), "close native fixture", func(windows.Handle) error {
		attempts++
		return closeFailure
	}, quarantine)
	if !errors.Is(err, closeFailure) || !errors.Is(err, ErrCleanupFatal) || attempts != 1 ||
		!errors.Is(quarantine.status(), ErrCleanupFatal) || len(quarantine.owners) != 1 ||
		quarantine.owners[0].handle != windows.Handle(601) {
		t.Fatalf("close returned %v after %d attempts", err, attempts)
	}
}

func TestDiscardedHandleFatalPublicationLinearizesWithHealthyCommit(t *testing.T) {
	t.Run("commit first", func(t *testing.T) {
		quarantine := &discardedHandleQuarantine{}
		entered := make(chan struct{})
		release := make(chan struct{})
		committed := false
		commitDone := make(chan error, 1)
		go func() {
			commitDone <- quarantine.commitIfHealthy(func() {
				close(entered)
				<-release
				committed = true
			})
		}()
		<-entered
		publishDone := make(chan error, 1)
		go func() {
			publishDone <- quarantine.retain(windows.Handle(602), "publish fixture", errors.New("close failed"))
		}()
		close(release)
		if err := <-commitDone; err != nil || !committed {
			t.Fatalf("healthy commit = %v, committed=%v", err, committed)
		}
		if err := <-publishDone; !errors.Is(err, ErrCleanupFatal) {
			t.Fatalf("fatal publication = %v", err)
		}
	})

	t.Run("fatal first", func(t *testing.T) {
		quarantine := &discardedHandleQuarantine{}
		_ = quarantine.retain(windows.Handle(603), "publish fixture", errors.New("close failed"))
		committed := false
		if err := quarantine.commitIfHealthy(func() { committed = true }); !errors.Is(err, ErrCleanupFatal) || committed {
			t.Fatalf("post-fatal commit = %v, committed=%v", err, committed)
		}
	})
}

func TestWindowsFileVerifyAuthenticodeUsesOpaqueRetainedHandle(t *testing.T) {
	want := authenticode.Evidence{Trusted: true, SignatureKind: authenticode.SignatureKindEmbedded}
	verifier := &recordingAuthenticodeVerifier{evidence: want}
	file := &File{handle: windows.Handle(777)}
	got, err := file.VerifyAuthenticode(verifier)
	if err != nil {
		t.Fatal(err)
	}
	if got != want || verifier.calls != 1 || file.handle != windows.Handle(777) {
		t.Fatalf("verification returned %+v after %d calls with handle %d", got, verifier.calls, file.handle)
	}
}

func TestWindowsFileVerifyAuthenticodeRejectsNilAndClosedInputs(t *testing.T) {
	var typedNil *recordingAuthenticodeVerifier
	file := &File{handle: windows.Handle(778)}
	if _, err := file.VerifyAuthenticode(typedNil); !errors.Is(err, ErrInvalidOptions) {
		t.Fatalf("typed nil verifier returned %v", err)
	}
	closed := &File{}
	verifier := &recordingAuthenticodeVerifier{}
	if _, err := closed.VerifyAuthenticode(verifier); !errors.Is(err, ErrClosed) {
		t.Fatalf("closed file returned %v", err)
	}
	if verifier.calls != 0 {
		t.Fatal("closed file invoked the verifier")
	}
}

func makeExtendedDirectoryRecord(name string, attributes uint32, size uint64, fileID byte) []byte {
	nameBytes := encodeNativeUTF16(name)
	buffer := make([]byte, extendedDirectoryEntryHeaderBytes+len(nameBytes))
	binary.LittleEndian.PutUint64(buffer[40:48], size)
	binary.LittleEndian.PutUint32(buffer[56:60], attributes)
	binary.LittleEndian.PutUint32(buffer[60:64], uint32(len(nameBytes)))
	buffer[72] = fileID
	copy(buffer[extendedDirectoryEntryHeaderBytes:], nameBytes)
	return buffer
}

func makeStreamInformationRecord(name string, size uint64, allocationSize uint64) []byte {
	nameBytes := encodeNativeUTF16(name)
	buffer := make([]byte, streamInformationHeaderBytes+len(nameBytes))
	binary.LittleEndian.PutUint32(buffer[4:8], uint32(len(nameBytes)))
	binary.LittleEndian.PutUint64(buffer[8:16], size)
	binary.LittleEndian.PutUint64(buffer[16:24], allocationSize)
	copy(buffer[streamInformationHeaderBytes:], nameBytes)
	return buffer
}

func encodeNativeUTF16(value string) []byte {
	units := utf16.Encode([]rune(value))
	encoded := make([]byte, len(units)*2)
	for index, unit := range units {
		binary.LittleEndian.PutUint16(encoded[index*2:index*2+2], unit)
	}
	return encoded
}
