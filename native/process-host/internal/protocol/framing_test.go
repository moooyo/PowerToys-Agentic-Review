package protocol

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestFrameReaderReadsLFCRLFAndFinalFrame(t *testing.T) {
	reader := NewFrameReader(strings.NewReader("{\"a\":1}\n{\"b\":2}\r\n{\"c\":3}"), MaxFrameBytes)

	for index, expected := range []string{`{"a":1}`, `{"b":2}`, `{"c":3}`} {
		frame, err := reader.ReadFrame()
		if err != nil {
			t.Fatalf("frame %d: %v", index, err)
		}
		if string(frame) != expected {
			t.Fatalf("frame %d = %q, want %q", index, frame, expected)
		}
	}
	if _, err := reader.ReadFrame(); !errors.Is(err, io.EOF) {
		t.Fatalf("final read error = %v, want EOF", err)
	}
}

func TestFrameReaderRejectsEmptyOversizedAndInvalidUTF8(t *testing.T) {
	tests := []struct {
		name  string
		input []byte
		limit int
		want  error
	}{
		{name: "empty", input: []byte("\n"), limit: 16, want: ErrEmptyFrame},
		{name: "oversized", input: []byte("12345\n"), limit: 4, want: ErrFrameTooLarge},
		{name: "invalid UTF-8", input: []byte{0xff, '\n'}, limit: 16, want: ErrInvalidUTF8},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := NewFrameReader(bytes.NewReader(test.input), test.limit).ReadFrame()
			if !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestFrameWriterAppendsOneNewline(t *testing.T) {
	var output bytes.Buffer
	writer := NewFrameWriter(&output, MaxFrameBytes)
	if err := writer.WriteFrame(map[string]string{"type": "ready"}); err != nil {
		t.Fatal(err)
	}
	if got, want := output.String(), "{\"type\":\"ready\"}\n"; got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
}

func TestRejectDuplicateKeysRecursively(t *testing.T) {
	if err := rejectDuplicateKeys([]byte(`{"a":{"b":1,"b":2}}`)); err == nil {
		t.Fatal("expected duplicate property error")
	}
	if err := rejectDuplicateKeys([]byte(`{"a":[{"b":1},{"b":2}]}`)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
