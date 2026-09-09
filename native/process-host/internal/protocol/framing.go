package protocol

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"unicode/utf8"
)

const MaxFrameBytes = 1_048_576

var (
	ErrEmptyFrame    = errors.New("protocol frame is empty")
	ErrFrameTooLarge = errors.New("protocol frame exceeds the maximum size")
	ErrInvalidUTF8   = errors.New("protocol frame is not valid UTF-8")
)

// FrameReader reads newline-delimited UTF-8 JSON without buffering an unbounded line.
type FrameReader struct {
	reader   *bufio.Reader
	maxBytes int
}

func NewFrameReader(reader io.Reader, maxBytes int) *FrameReader {
	if maxBytes <= 0 {
		maxBytes = MaxFrameBytes
	}
	return &FrameReader{
		reader:   bufio.NewReaderSize(reader, 64*1024),
		maxBytes: maxBytes,
	}
}

func (r *FrameReader) ReadFrame() ([]byte, error) {
	frame := make([]byte, 0, 4096)

	for {
		fragment, err := r.reader.ReadSlice('\n')
		hasNewline := len(fragment) > 0 && fragment[len(fragment)-1] == '\n'
		if hasNewline {
			fragment = fragment[:len(fragment)-1]
		}

		if len(frame)+len(fragment) > r.maxBytes {
			return nil, ErrFrameTooLarge
		}
		frame = append(frame, fragment...)

		switch {
		case hasNewline:
			if len(frame) > 0 && frame[len(frame)-1] == '\r' {
				frame = frame[:len(frame)-1]
			}
			return validateFrame(frame)
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		case errors.Is(err, io.EOF):
			if len(frame) == 0 {
				return nil, io.EOF
			}
			return validateFrame(frame)
		case err != nil:
			return nil, err
		default:
			return nil, errors.New("protocol reader returned no delimiter and no error")
		}
	}
}

func validateFrame(frame []byte) ([]byte, error) {
	if len(frame) == 0 {
		return nil, ErrEmptyFrame
	}
	if !utf8.Valid(frame) {
		return nil, ErrInvalidUTF8
	}
	return frame, nil
}

// FrameWriter serializes protocol output so concurrent processes cannot interleave frames.
type FrameWriter struct {
	writer   io.Writer
	maxBytes int
	mu       sync.Mutex
}

func NewFrameWriter(writer io.Writer, maxBytes int) *FrameWriter {
	if maxBytes <= 0 {
		maxBytes = MaxFrameBytes
	}
	return &FrameWriter{writer: writer, maxBytes: maxBytes}
}

func (w *FrameWriter) WriteFrame(value any) error {
	switch event := value.(type) {
	case StdinResultEvent:
		if err := ValidateStdinResultEvent(event); err != nil {
			return fmt.Errorf("validate stdin result: %w", err)
		}
	case *StdinResultEvent:
		if event == nil {
			return errors.New("stdin result must not be nil")
		}
		if err := ValidateStdinResultEvent(*event); err != nil {
			return fmt.Errorf("validate stdin result: %w", err)
		}
	}
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("marshal protocol frame: %w", err)
	}
	if len(data) > w.maxBytes {
		return ErrFrameTooLarge
	}

	w.mu.Lock()
	defer w.mu.Unlock()

	return writeAll(w.writer, append(data, '\n'))
}

func writeAll(writer io.Writer, data []byte) error {
	for len(data) > 0 {
		written, err := writer.Write(data)
		if err != nil {
			return err
		}
		if written <= 0 {
			return io.ErrShortWrite
		}
		data = data[written:]
	}
	return nil
}

func rejectDuplicateKeys(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := walkJSONValue(decoder); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values in one protocol frame")
		}
		return fmt.Errorf("read trailing JSON token: %w", err)
	}
	return nil
}

func walkJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return fmt.Errorf("read JSON token: %w", err)
	}

	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}

	switch delimiter {
	case '{':
		keys := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return fmt.Errorf("read JSON object key: %w", err)
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("JSON object key is not a string")
			}
			if _, exists := keys[key]; exists {
				return fmt.Errorf("duplicate JSON property %q", key)
			}
			keys[key] = struct{}{}
			if err := walkJSONValue(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("read JSON object terminator: %w", err)
		}
		if closing != json.Delim('}') {
			return errors.New("invalid JSON object terminator")
		}
	case '[':
		for decoder.More() {
			if err := walkJSONValue(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("read JSON array terminator: %w", err)
		}
		if closing != json.Delim(']') {
			return errors.New("invalid JSON array terminator")
		}
	default:
		return fmt.Errorf("unexpected JSON delimiter %q", delimiter)
	}

	return nil
}
