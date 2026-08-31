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
	binary.LittleEndian.PutUint32(prefix, MaximumFrameBytes+1)
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
