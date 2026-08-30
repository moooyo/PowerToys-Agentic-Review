package host

import (
	"encoding/base64"
	"errors"
	"io"
	"sync"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/protocol"
)

const outputReadBufferBytes = 32 * 1024

type eventEmitter interface {
	Emit(event any) error
}

type outputCollector struct {
	requestID string
	limit     uint64
	emitter   eventEmitter

	mu              sync.Mutex
	sequence        uint64
	emittedBytes    uint64
	discardedBytes  uint64
	discardedStdout bool
	discardedStderr bool
	firstReadError  error
}

func newOutputCollector(requestID string, limit uint64, emitter eventEmitter) *outputCollector {
	return &outputCollector{requestID: requestID, limit: limit, emitter: emitter}
}

func (c *outputCollector) Drain(stream string, reader io.Reader) {
	buffer := make([]byte, outputReadBufferBytes)
	for {
		count, err := reader.Read(buffer)
		if count > 0 {
			c.accept(stream, buffer[:count])
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				c.mu.Lock()
				if c.firstReadError == nil {
					c.firstReadError = err
				}
				c.mu.Unlock()
			}
			return
		}
	}
}

func (c *outputCollector) Finish() (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.discardedBytes > 0 {
		stream := "combined"
		if c.discardedStdout && !c.discardedStderr {
			stream = "stdout"
		} else if c.discardedStderr && !c.discardedStdout {
			stream = "stderr"
		}
		if err := c.emitLocked(protocol.OutputTruncatedEvent{
			ProtocolVersion: protocol.Version,
			Type:            "output_truncated",
			RequestID:       c.requestID,
			Sequence:        c.sequence,
			Stream:          stream,
			DiscardedBytes:  c.discardedBytes,
		}); err != nil {
			return true, err
		}
		c.sequence++
	}
	return c.discardedBytes > 0, c.firstReadError
}

func (c *outputCollector) accept(stream string, data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()

	remaining := uint64(0)
	if c.emittedBytes < c.limit {
		remaining = c.limit - c.emittedBytes
	}
	emitCount := uint64(len(data))
	if emitCount > remaining {
		emitCount = remaining
	}

	if emitCount > 0 && c.sequence <= protocol.MaxSafeInteger {
		chunk := data[:int(emitCount)]
		if err := c.emitLocked(protocol.OutputEvent{
			ProtocolVersion: protocol.Version,
			Type:            stream,
			RequestID:       c.requestID,
			Sequence:        c.sequence,
			DataBase64:      base64.StdEncoding.EncodeToString(chunk),
		}); err == nil {
			c.sequence++
		}
	}
	c.emittedBytes += emitCount

	discarded := uint64(len(data)) - emitCount
	if discarded == 0 {
		return
	}
	c.discardedBytes = saturatingAdd(c.discardedBytes, discarded)
	if stream == "stdout" {
		c.discardedStdout = true
	} else {
		c.discardedStderr = true
	}
}

func (c *outputCollector) emitLocked(event any) error {
	if c.sequence > protocol.MaxSafeInteger {
		return errors.New("output sequence exceeds the protocol safe-integer limit")
	}
	return c.emitter.Emit(event)
}

func saturatingAdd(left, right uint64) uint64 {
	if left >= protocol.MaxSafeInteger || right >= protocol.MaxSafeInteger-left {
		return protocol.MaxSafeInteger
	}
	return left + right
}
