package relay

import (
	"context"
	"errors"
	"io"
	"sync"
)

var (
	ErrQueueClosed  = errors.New("byte queue is closed")
	ErrQueueSealed  = errors.New("byte queue is sealed")
	ErrItemTooLarge = errors.New("item exceeds the byte queue capacity")
	ErrEmptyItem    = errors.New("byte queue items must not be empty")
	ErrInvalidQueue = errors.New("byte queue capacity must be positive")
)

type QueueStats struct {
	CapacityBytes int
	ReservedBytes int
	QueuedItems   int
	InFlightItems int
	Sealed        bool
	Aborted       bool
	Closed        bool
}

type byteQueueState uint8

const (
	byteQueueOpen byteQueueState = iota
	byteQueueSealed
	byteQueueAborted
)

type ByteQueue struct {
	mu         sync.Mutex
	capacity   int
	reserved   int
	queued     [][]byte
	inFlight   int
	state      byteQueueState
	abortCause error
	changed    chan struct{}
}

type Item struct {
	Bytes []byte

	queue *ByteQueue
	size  int
	once  sync.Once
}

func NewByteQueue(capacityBytes int) (*ByteQueue, error) {
	if capacityBytes <= 0 {
		return nil, ErrInvalidQueue
	}
	return &ByteQueue{
		capacity: capacityBytes,
		changed:  make(chan struct{}),
	}, nil
}

func (q *ByteQueue) Enqueue(ctx context.Context, value []byte) error {
	if ctx == nil {
		return errors.New("enqueue context is required")
	}
	if len(value) == 0 {
		return ErrEmptyItem
	}
	if len(value) > q.capacity {
		return ErrItemTooLarge
	}
	for {
		q.mu.Lock()
		if cause := context.Cause(ctx); cause != nil {
			q.mu.Unlock()
			return cause
		}
		if q.state == byteQueueAborted {
			err := q.abortCauseLocked()
			q.mu.Unlock()
			return err
		}
		if q.state == byteQueueSealed {
			q.mu.Unlock()
			return ErrQueueSealed
		}
		if q.reserved+len(value) <= q.capacity {
			// Ownership transfers to the queue after a successful enqueue. Relay readers
			// return a fresh frame and never retain or mutate it after this point.
			q.queued = append(q.queued, value)
			q.reserved += len(value)
			q.signalLocked()
			q.mu.Unlock()
			return nil
		}
		changed := q.changed
		q.mu.Unlock()

		select {
		case <-ctx.Done():
			return context.Cause(ctx)
		case <-changed:
		}
	}
}

func (q *ByteQueue) Dequeue(ctx context.Context) (*Item, error) {
	if ctx == nil {
		return nil, errors.New("dequeue context is required")
	}
	for {
		q.mu.Lock()
		if cause := context.Cause(ctx); cause != nil {
			q.mu.Unlock()
			return nil, cause
		}
		if q.state == byteQueueAborted {
			err := q.abortCauseLocked()
			q.mu.Unlock()
			return nil, err
		}
		if len(q.queued) > 0 {
			value := q.queued[0]
			q.queued[0] = nil
			q.queued = q.queued[1:]
			q.inFlight++
			q.signalLocked()
			q.mu.Unlock()
			return &Item{Bytes: value, queue: q, size: len(value)}, nil
		}
		if q.state == byteQueueSealed && q.inFlight == 0 {
			q.mu.Unlock()
			return nil, io.EOF
		}
		changed := q.changed
		q.mu.Unlock()

		select {
		case <-ctx.Done():
			return nil, context.Cause(ctx)
		case <-changed:
		}
	}
}

func (item *Item) Release() {
	if item == nil || item.queue == nil {
		return
	}
	item.once.Do(func() {
		item.queue.release(item.size)
		item.Bytes = nil
	})
}

// Seal atomically prevents future enqueue operations while retaining every
// queued and in-flight item for ordered delivery.
func (q *ByteQueue) Seal() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.state != byteQueueOpen {
		return false
	}
	q.state = byteQueueSealed
	q.signalLocked()
	return true
}

// Abort atomically stops the queue and drops items that have not transferred
// to a consumer. In-flight reservations remain until their owners release them.
func (q *ByteQueue) Abort(cause error) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.state == byteQueueAborted {
		return false
	}
	if cause == nil {
		cause = ErrQueueClosed
	}
	q.state = byteQueueAborted
	q.abortCause = cause
	for _, value := range q.queued {
		q.reserved -= len(value)
	}
	q.queued = nil
	q.signalLocked()
	return true
}

// Close is the compatibility name for the abortive queue operation. Graceful
// producers must call Seal instead.
func (q *ByteQueue) Close(cause error) {
	q.Abort(cause)
}

// WaitDrained waits until a terminal queue has released all queued and
// in-flight byte ownership. A sealed queue drains successfully; an aborted
// queue returns its first abort cause after ownership is released.
func (q *ByteQueue) WaitDrained(ctx context.Context) error {
	if ctx == nil {
		return errors.New("queue drain context is required")
	}
	for {
		q.mu.Lock()
		if cause := context.Cause(ctx); cause != nil {
			q.mu.Unlock()
			return cause
		}
		if q.state != byteQueueOpen && q.reserved == 0 {
			state := q.state
			err := q.abortCauseLocked()
			q.mu.Unlock()
			if state == byteQueueAborted {
				return err
			}
			return nil
		}
		changed := q.changed
		q.mu.Unlock()

		select {
		case <-ctx.Done():
			return context.Cause(ctx)
		case <-changed:
		}
	}
}

func (q *ByteQueue) Stats() QueueStats {
	q.mu.Lock()
	defer q.mu.Unlock()
	return QueueStats{
		CapacityBytes: q.capacity,
		ReservedBytes: q.reserved,
		QueuedItems:   len(q.queued),
		InFlightItems: q.inFlight,
		Sealed:        q.state == byteQueueSealed,
		Aborted:       q.state == byteQueueAborted,
		Closed:        q.state != byteQueueOpen,
	}
}

func (q *ByteQueue) release(size int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.reserved -= size
	q.inFlight--
	if q.reserved < 0 || q.inFlight < 0 {
		panic("byte queue reservation accounting underflow")
	}
	q.signalLocked()
}

func (q *ByteQueue) abortCauseLocked() error {
	if q.abortCause != nil {
		return q.abortCause
	}
	return ErrQueueClosed
}

func (q *ByteQueue) sealedAndDrained() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.state == byteQueueSealed && q.reserved == 0
}

func (q *ByteQueue) signalLocked() {
	close(q.changed)
	q.changed = make(chan struct{})
}
