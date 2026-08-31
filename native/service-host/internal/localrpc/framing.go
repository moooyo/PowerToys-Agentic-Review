package localrpc

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

const (
	MaximumFrameBytes              = 1_048_576
	MaximumClaimResponseFrameBytes = 16 * 1024 * 1024
	framePrefixBytes               = 4
)

var (
	ErrEmptyFrame    = errors.New("local RPC frame is empty")
	ErrFrameTooLarge = errors.New("local RPC frame exceeds its byte limit")
	ErrPartialFrame  = errors.New("local RPC stream ended with a partial frame")
)

// ReadFrame reads one unsigned little-endian length-prefixed frame. The byte limit is checked
// before allocation.
func ReadFrame(reader io.Reader, maximumBytes int) ([]byte, error) {
	if reader == nil {
		return nil, errors.New("local RPC frame reader is required")
	}
	if err := validateFrameMaximum(maximumBytes); err != nil {
		return nil, err
	}
	prefix := make([]byte, framePrefixBytes)
	read, err := io.ReadFull(reader, prefix)
	if err != nil {
		if errors.Is(err, io.EOF) && read == 0 {
			return nil, io.EOF
		}
		return nil, fmt.Errorf("%w: length prefix", ErrPartialFrame)
	}
	length := binary.LittleEndian.Uint32(prefix)
	if length == 0 {
		return nil, ErrEmptyFrame
	}
	if uint64(length) > uint64(maximumBytes) {
		return nil, ErrFrameTooLarge
	}
	payload := make([]byte, int(length))
	if _, err := io.ReadFull(reader, payload); err != nil {
		return nil, fmt.Errorf("%w: payload", ErrPartialFrame)
	}
	return payload, nil
}

// WriteFrame writes one complete length-prefixed frame and rejects short writes.
func WriteFrame(writer io.Writer, payload []byte, maximumBytes int) error {
	if writer == nil {
		return errors.New("local RPC frame writer is required")
	}
	if err := validateFrameMaximum(maximumBytes); err != nil {
		return err
	}
	if len(payload) == 0 {
		return ErrEmptyFrame
	}
	if len(payload) > maximumBytes {
		return ErrFrameTooLarge
	}
	prefix := make([]byte, framePrefixBytes)
	binary.LittleEndian.PutUint32(prefix, uint32(len(payload)))
	if err := writeAll(writer, prefix); err != nil {
		return fmt.Errorf("write local RPC frame length: %w", err)
	}
	if err := writeAll(writer, payload); err != nil {
		return fmt.Errorf("write local RPC frame payload: %w", err)
	}
	return nil
}

func validateFrameMaximum(maximumBytes int) error {
	if maximumBytes <= 0 || maximumBytes > MaximumClaimResponseFrameBytes {
		return fmt.Errorf(
			"local RPC maximum frame bytes must be from 1 through %d",
			MaximumClaimResponseFrameBytes,
		)
	}
	return nil
}

func writeAll(writer io.Writer, value []byte) error {
	for len(value) > 0 {
		written, err := writer.Write(value)
		if written < 0 || written > len(value) {
			return errors.New("local RPC writer returned an invalid byte count")
		}
		value = value[written:]
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}
