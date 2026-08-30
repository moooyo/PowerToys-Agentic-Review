package framing

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

const (
	Magic             = "ARWX"
	HeaderBytes       = 48
	MajorVersion      = 1
	MinorVersion      = 0
	MaximumFrameBytes = 1_048_576
	minimumMessageID  = 1
	maximumMessageID  = 19
)

var (
	ErrInvalidHeader = errors.New("invalid ARWX frame header")
	ErrFrameTooLarge = errors.New("ARWX frame exceeds its byte limit")
	ErrPartialFrame  = errors.New("ARWX stream ended with a partial frame")
	ErrTrailingBytes = errors.New("ARWX frame contains trailing bytes")
)

type Header struct {
	MinorVersion  uint16
	MessageType   uint16
	PayloadLength uint32
	Sequence      uint64
	CorrelationID [16]byte
}

type Frame struct {
	Header Header
	Bytes  []byte
}

func ParseHeader(value []byte, maximumFrameBytes uint32) (Header, error) {
	maximum, err := validateMaximum(maximumFrameBytes)
	if err != nil {
		return Header{}, err
	}
	if len(value) < HeaderBytes {
		return Header{}, fmt.Errorf("%w: header requires %d bytes", ErrPartialFrame, HeaderBytes)
	}
	if string(value[0:4]) != Magic || binary.LittleEndian.Uint16(value[4:6]) != HeaderBytes {
		return Header{}, fmt.Errorf("%w: magic or header length", ErrInvalidHeader)
	}
	if binary.LittleEndian.Uint16(value[6:8]) != MajorVersion {
		return Header{}, fmt.Errorf("%w: unsupported major version", ErrInvalidHeader)
	}
	minor := binary.LittleEndian.Uint16(value[8:10])
	if minor != MinorVersion {
		return Header{}, fmt.Errorf("%w: unsupported minor version", ErrInvalidHeader)
	}
	messageType := binary.LittleEndian.Uint16(value[10:12])
	if messageType < minimumMessageID || messageType > maximumMessageID {
		return Header{}, fmt.Errorf("%w: unknown message type", ErrInvalidHeader)
	}
	if binary.LittleEndian.Uint32(value[12:16]) != 0 {
		return Header{}, fmt.Errorf("%w: flags must be zero", ErrInvalidHeader)
	}
	payloadLength := binary.LittleEndian.Uint32(value[16:20])
	if uint64(payloadLength)+HeaderBytes > uint64(maximum) {
		return Header{}, ErrFrameTooLarge
	}
	sequence := binary.LittleEndian.Uint64(value[20:28])
	if sequence == 0 {
		return Header{}, fmt.Errorf("%w: sequence must be positive", ErrInvalidHeader)
	}
	if binary.LittleEndian.Uint32(value[44:48]) != 0 {
		return Header{}, fmt.Errorf("%w: reserved field must be zero", ErrInvalidHeader)
	}
	var correlationID [16]byte
	copy(correlationID[:], value[28:44])
	return Header{
		MinorVersion:  minor,
		MessageType:   messageType,
		PayloadLength: payloadLength,
		Sequence:      sequence,
		CorrelationID: correlationID,
	}, nil
}

func ValidateFrame(value []byte, maximumFrameBytes uint32) (Header, error) {
	header, err := ParseHeader(value, maximumFrameBytes)
	if err != nil {
		return Header{}, err
	}
	expected := HeaderBytes + int(header.PayloadLength)
	if len(value) < expected {
		return Header{}, fmt.Errorf("%w: expected %d bytes, received %d", ErrPartialFrame, expected, len(value))
	}
	if len(value) > expected {
		return Header{}, fmt.Errorf("%w: expected %d bytes, received %d", ErrTrailingBytes, expected, len(value))
	}
	return header, nil
}

func ReadFrame(reader io.Reader, maximumFrameBytes uint32) (Frame, error) {
	if _, err := validateMaximum(maximumFrameBytes); err != nil {
		return Frame{}, err
	}
	headerBytes := make([]byte, HeaderBytes)
	read, err := io.ReadFull(reader, headerBytes)
	if err != nil {
		if errors.Is(err, io.EOF) && read == 0 {
			return Frame{}, io.EOF
		}
		return Frame{}, fmt.Errorf("%w: read header: %v", ErrPartialFrame, err)
	}
	header, err := ParseHeader(headerBytes, maximumFrameBytes)
	if err != nil {
		return Frame{}, err
	}
	value := make([]byte, HeaderBytes+int(header.PayloadLength))
	copy(value, headerBytes)
	if header.PayloadLength > 0 {
		if _, err := io.ReadFull(reader, value[HeaderBytes:]); err != nil {
			return Frame{}, fmt.Errorf("%w: read payload: %v", ErrPartialFrame, err)
		}
	}
	return Frame{Header: header, Bytes: value}, nil
}

func WriteFrame(writer io.Writer, value []byte, maximumFrameBytes uint32) error {
	if _, err := ValidateFrame(value, maximumFrameBytes); err != nil {
		return err
	}
	for written := 0; written < len(value); {
		count, err := writer.Write(value[written:])
		if count < 0 || count > len(value)-written {
			return errors.New("frame writer returned an invalid byte count")
		}
		written += count
		if err != nil {
			return err
		}
		if count == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

func validateMaximum(value uint32) (uint32, error) {
	if value < HeaderBytes || value > MaximumFrameBytes {
		return 0, fmt.Errorf("maximum frame bytes must be from %d through %d", HeaderBytes, MaximumFrameBytes)
	}
	return value, nil
}
