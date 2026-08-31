package localrpc

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
)

func TestLengthPrefixedFrameRoundTrip(t *testing.T) {
	payload := []byte(`{"protocolVersion":"1.0"}`)
	var stream bytes.Buffer
	if err := WriteFrame(&stream, payload, MaximumFrameBytes); err != nil {
		t.Fatal(err)
	}
	read, err := ReadFrame(&stream, MaximumFrameBytes)
	if err != nil || !bytes.Equal(read, payload) {
		t.Fatalf("ReadFrame = (%q, %v)", read, err)
	}
	if _, err := ReadFrame(&stream, MaximumFrameBytes); !errors.Is(err, io.EOF) {
		t.Fatalf("final error = %v, want EOF", err)
	}
}

func TestFrameRejectsOversizeBeforeReadingPayload(t *testing.T) {
	prefix := make([]byte, 4)
	binary.LittleEndian.PutUint32(prefix, uint32(MaximumFrameBytes+1))
	reader := &countingReader{reader: bytes.NewReader(prefix)}
	if _, err := ReadFrame(reader, MaximumFrameBytes); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("ReadFrame error = %v, want ErrFrameTooLarge", err)
	}
	if reader.bytesRead != 4 {
		t.Fatalf("ReadFrame consumed %d bytes, want only the prefix", reader.bytesRead)
	}
}

func TestFrameRejectsEmptyPartialAndShortWrites(t *testing.T) {
	for _, stream := range [][]byte{{0, 0, 0, 0}, {2, 0}, {2, 0, 0, 0, 'x'}} {
		if _, err := ReadFrame(bytes.NewReader(stream), MaximumFrameBytes); err == nil {
			t.Errorf("ReadFrame accepted %v", stream)
		}
	}
	if err := WriteFrame(zeroWriter{}, []byte("x"), MaximumFrameBytes); !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("WriteFrame error = %v, want short write", err)
	}
	large := bytes.Repeat([]byte{'x'}, MaximumFrameBytes+1)
	if err := WriteFrame(io.Discard, large, MaximumFrameBytes); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("large WriteFrame error = %v", err)
	}
}

func TestClaimResponseMaximumIsSeparate(t *testing.T) {
	payload := bytes.Repeat([]byte{'x'}, MaximumFrameBytes+1)
	var stream bytes.Buffer
	if err := WriteFrame(&stream, payload, MaximumClaimResponseFrameBytes); err != nil {
		t.Fatalf("claim response frame was rejected: %v", err)
	}
	if _, err := ReadFrame(&stream, MaximumClaimResponseFrameBytes); err != nil {
		t.Fatalf("claim response frame could not be read: %v", err)
	}
}

func TestDedicatedPhysicalFrameCeilings(t *testing.T) {
	request := bytes.Repeat([]byte{'x'}, MaximumRequestFrameBytes)
	var requestStream bytes.Buffer
	if err := WriteFrame(&requestStream, request, MaximumRequestFrameBytes); err != nil {
		t.Fatalf("maximum request frame was rejected: %v", err)
	}
	if _, err := ReadFrame(&requestStream, MaximumRequestFrameBytes); err != nil {
		t.Fatalf("maximum request frame could not be read: %v", err)
	}

	prefix := make([]byte, framePrefixBytes)
	binary.LittleEndian.PutUint32(prefix, uint32(MaximumRequestFrameBytes+1))
	reader := &countingReader{reader: bytes.NewReader(prefix)}
	if _, err := ReadFrame(reader, MaximumRequestFrameBytes); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("oversized request frame error = %v", err)
	}
	if reader.bytesRead != framePrefixBytes {
		t.Fatal("oversized request frame allocated or consumed its payload")
	}

	claim := bytes.Repeat([]byte{'x'}, MaximumClaimResponseFrameBytes)
	var claimStream bytes.Buffer
	if err := WriteFrame(&claimStream, claim, MaximumClaimResponseFrameBytes); err != nil {
		t.Fatalf("maximum claim frame was rejected: %v", err)
	}
	if _, err := ReadFrame(&claimStream, MaximumClaimResponseFrameBytes); err != nil {
		t.Fatalf("maximum claim frame could not be read: %v", err)
	}
	if err := WriteFrame(io.Discard, append(claim, 'x'), MaximumClaimResponseFrameBytes); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("oversized claim frame error = %v", err)
	}
}

func TestDescriptorFrameCeilingsMatchCrossLanguageContract(t *testing.T) {
	if MaximumCanonicalControlFrameBytes != 1_048_576 || MaximumWorkerAPIBodyBytes != 1_048_576 {
		t.Fatalf("ordinary limits = control %d body %d", MaximumCanonicalControlFrameBytes, MaximumWorkerAPIBodyBytes)
	}
	if MaximumFrameBytes != 1_398_599 {
		t.Fatalf("ordinary Worker API frame maximum = %d", MaximumFrameBytes)
	}
	if MaximumRunCompletionRequestBodyBytes != 2_113_536 || MaximumRequestFrameBytes != 2_818_535 {
		t.Fatalf("completion limits = body %d frame %d", MaximumRunCompletionRequestBodyBytes, MaximumRequestFrameBytes)
	}
	if MaximumClaimResponseBodyBytes != 16_777_216 || MaximumClaimResponseFrameBytes != 22_369_945 {
		t.Fatalf("claim limits = body %d frame %d", MaximumClaimResponseBodyBytes, MaximumClaimResponseFrameBytes)
	}
}

type countingReader struct {
	reader    io.Reader
	bytesRead int
}

func (r *countingReader) Read(target []byte) (int, error) {
	count, err := r.reader.Read(target)
	r.bytesRead += count
	return count, err
}

type zeroWriter struct{}

func (zeroWriter) Write([]byte) (int, error) { return 0, nil }
