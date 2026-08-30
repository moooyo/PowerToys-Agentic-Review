package host

import (
	"sync"

	"github.com/moooyo/PowerToys-Agentic-Review/native/process-host/internal/protocol"
)

type protocolEmitter struct {
	writer *protocol.FrameWriter
	failed chan error
	once   sync.Once
}

func newProtocolEmitter(writer *protocol.FrameWriter) *protocolEmitter {
	return &protocolEmitter{
		writer: writer,
		failed: make(chan error, 1),
	}
}

func (e *protocolEmitter) Emit(event any) error {
	err := e.writer.WriteFrame(event)
	if err != nil {
		e.once.Do(func() {
			e.failed <- err
			close(e.failed)
		})
	}
	return err
}

func (e *protocolEmitter) Failed() <-chan error {
	return e.failed
}
