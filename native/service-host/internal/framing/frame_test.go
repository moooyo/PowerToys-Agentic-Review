package framing

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"testing"
)

func TestValidateFrameReturnsStructuralHeader(t *testing.T) {
	value := testFrame([]byte(`{"kind":"hello"}`))
	header, err := ValidateFrame(value, MaximumFrameBytes)
	if err != nil {
		t.Fatalf("ValidateFrame returned an error: %v", err)
	}
	if header.MessageType != 1 || header.Sequence != 1 || int(header.PayloadLength) != len(`{"kind":"hello"}`) {
		t.Fatalf("ValidateFrame returned the wrong header: %#v", header)
	}
}

func TestReadFrameSupportsPartialAndCoalescedStreamReads(t *testing.T) {
	first := testFrame([]byte("one"))
	second := testFrame([]byte("two"))
	reader := &oneByteReader{reader: bytes.NewReader(append(first, second...))}
	readFirst, err := ReadFrame(reader, MaximumFrameBytes)
	if err != nil {
		t.Fatalf("ReadFrame(first) returned an error: %v", err)
	}
	readSecond, err := ReadFrame(reader, MaximumFrameBytes)
	if err != nil {
		t.Fatalf("ReadFrame(second) returned an error: %v", err)
	}
	if !bytes.Equal(readFirst.Bytes, first) || !bytes.Equal(readSecond.Bytes, second) {
		t.Fatal("ReadFrame changed frame bytes")
	}
	if _, err := ReadFrame(reader, MaximumFrameBytes); err != io.EOF {
		t.Fatalf("ReadFrame clean EOF = %T %v, want literal EOF", err, err)
	}
}

func TestReadFrameCleanEOFRequiresLiteralZeroByteReaderEOF(t *testing.T) {
	cleanupFailure := errors.New("cleanup failed")
	for _, test := range []struct {
		name      string
		reader    io.Reader
		wantClean bool
	}{
		{name: "literal", reader: terminalReader{err: io.EOF}, wantClean: true},
		{name: "wrapped", reader: terminalReader{err: fmt.Errorf("wrapped EOF: %w", io.EOF)}},
		{name: "joined", reader: terminalReader{err: errors.Join(io.EOF)}},
		{name: "cleanup", reader: terminalReader{err: errors.Join(io.EOF, cleanupFailure)}},
		{name: "partial", reader: terminalReader{count: 1, err: io.EOF}},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := ReadFrame(test.reader, MaximumFrameBytes)
			if test.wantClean {
				if err != io.EOF {
					t.Fatalf("ReadFrame error = %T %v, want literal EOF", err, err)
				}
				return
			}
			if err == io.EOF || !errors.Is(err, ErrPartialFrame) || errors.Is(err, io.EOF) {
				t.Fatalf("ReadFrame error = %v, want non-EOF ErrPartialFrame", err)
			}
		})
	}
}

func TestFrameValidationRejectsInvalidHeaders(t *testing.T) {
	tests := []struct {
		name   string
		mutate func([]byte)
		target error
	}{
		{name: "magic", mutate: func(value []byte) { value[0] = 'X' }, target: ErrInvalidHeader},
		{name: "header length", mutate: func(value []byte) { binary.LittleEndian.PutUint16(value[4:6], 47) }, target: ErrInvalidHeader},
		{name: "major", mutate: func(value []byte) { binary.LittleEndian.PutUint16(value[6:8], 2) }, target: ErrInvalidHeader},
		{name: "minor", mutate: func(value []byte) { binary.LittleEndian.PutUint16(value[8:10], 1) }, target: ErrInvalidHeader},
		{name: "message zero", mutate: func(value []byte) { binary.LittleEndian.PutUint16(value[10:12], 0) }, target: ErrInvalidHeader},
		{name: "message unknown", mutate: func(value []byte) { binary.LittleEndian.PutUint16(value[10:12], 21) }, target: ErrInvalidHeader},
		{name: "flags", mutate: func(value []byte) { binary.LittleEndian.PutUint32(value[12:16], 1) }, target: ErrInvalidHeader},
		{name: "sequence", mutate: func(value []byte) { binary.LittleEndian.PutUint64(value[20:28], 0) }, target: ErrInvalidHeader},
		{name: "reserved", mutate: func(value []byte) { binary.LittleEndian.PutUint32(value[44:48], 1) }, target: ErrInvalidHeader},
		{name: "oversized payload", mutate: func(value []byte) { binary.LittleEndian.PutUint32(value[16:20], MaximumFrameBytes) }, target: ErrFrameTooLarge},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := testFrame(nil)
			test.mutate(value)
			_, err := ValidateFrame(value, MaximumFrameBytes)
			if !errors.Is(err, test.target) {
				t.Fatalf("expected %v, got %v", test.target, err)
			}
		})
	}
}

func TestFrameValidationAcceptsMaximumMessageType(t *testing.T) {
	value := testFrame([]byte(`{"message":{}}`))
	binary.LittleEndian.PutUint16(value[10:12], 19)
	header, err := ValidateFrame(value, MaximumFrameBytes)
	if err != nil {
		t.Fatal(err)
	}
	if header.MessageType != 19 {
		t.Fatalf("message type = %d, want 19", header.MessageType)
	}
}

func TestFrameValidationRejectsPartialTrailingAndInvalidMaximum(t *testing.T) {
	value := testFrame([]byte("payload"))
	if _, err := ValidateFrame(value[:len(value)-1], MaximumFrameBytes); !errors.Is(err, ErrPartialFrame) {
		t.Fatalf("expected partial frame error, got %v", err)
	}
	if _, err := ValidateFrame(append(value, 0), MaximumFrameBytes); !errors.Is(err, ErrTrailingBytes) {
		t.Fatalf("expected trailing bytes error, got %v", err)
	}
	if _, err := ValidateFrame(value, HeaderBytes-1); err == nil {
		t.Fatal("ValidateFrame accepted an invalid maximum")
	}
	if _, err := ReadFrame(bytes.NewReader(value[:HeaderBytes+1]), MaximumFrameBytes); !errors.Is(err, ErrPartialFrame) {
		t.Fatalf("expected partial payload error, got %v", err)
	}
}

func TestWriteFrameHandlesShortWrites(t *testing.T) {
	value := testFrame([]byte("payload"))
	writer := &boundedWriter{maximum: 3}
	if err := WriteFrame(writer, value, MaximumFrameBytes); err != nil {
		t.Fatalf("WriteFrame returned an error: %v", err)
	}
	if !bytes.Equal(writer.bytes, value) {
		t.Fatal("WriteFrame changed frame bytes")
	}
	if err := WriteFrame(zeroWriter{}, value, MaximumFrameBytes); !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("expected short write error, got %v", err)
	}
}

func testFrame(payload []byte) []byte {
	value := make([]byte, HeaderBytes+len(payload))
	copy(value[0:4], Magic)
	binary.LittleEndian.PutUint16(value[4:6], HeaderBytes)
	binary.LittleEndian.PutUint16(value[6:8], MajorVersion)
	binary.LittleEndian.PutUint16(value[8:10], MinorVersion)
	binary.LittleEndian.PutUint16(value[10:12], 1)
	binary.LittleEndian.PutUint32(value[16:20], uint32(len(payload)))
	binary.LittleEndian.PutUint64(value[20:28], 1)
	copy(value[HeaderBytes:], payload)
	return value
}

type oneByteReader struct {
	reader *bytes.Reader
}

func (r *oneByteReader) Read(value []byte) (int, error) {
	if len(value) > 1 {
		value = value[:1]
	}
	return r.reader.Read(value)
}

type terminalReader struct {
	count int
	err   error
}

func (r terminalReader) Read(value []byte) (int, error) {
	count := min(r.count, len(value))
	clear(value[:count])
	return count, r.err
}

type boundedWriter struct {
	maximum int
	bytes   []byte
}

func (w *boundedWriter) Write(value []byte) (int, error) {
	if len(value) > w.maximum {
		value = value[:w.maximum]
	}
	w.bytes = append(w.bytes, value...)
	return len(value), nil
}

type zeroWriter struct{}

func (zeroWriter) Write([]byte) (int, error) {
	return 0, nil
}
