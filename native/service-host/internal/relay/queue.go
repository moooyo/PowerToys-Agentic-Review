package relay

import (
	"context"
	"errors"
	"sync"
)

var (
	ErrQueueClosed  = errors.New("byte queue is closed")
	ErrItemTooLarge = errors.New("item exceeds the byte queue capacity")
	ErrEmptyItem    = errors.New("byte queue items must not be empty")
	ErrInvalidQueue = errors.New("byte queue capacity must be positive")
)

type QueueStats struct {
	CapacityBytes int
	ReservedBytes int
	QueuedItems   int
	InFlightItems int
	Closed        bool
}

type ByteQueue struct {
	mu       sync.Mutex
	capacity int
	reserved int
	queued   [][]byte
	inFlight int
	closed   bool
	cause    error
	changed  chan struct{}
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
		if q.closed {
			err := q.closeCauseLocked()
			q.mu.Unlock()
			return err
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
		if q.closed {
			err := q.closeCauseLocked()
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

func (q *ByteQueue) Close(cause error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return
	}
	q.closed = true
	if cause == nil {
		cause = ErrQueueClosed
	}
	q.cause = cause
	for _, value := range q.queued {
		q.reserved -= len(value)
	}
	q.queued = nil
	q.signalLocked()
}

func (q *ByteQueue) Stats() QueueStats {
	q.mu.Lock()
	defer q.mu.Unlock()
	return QueueStats{
		CapacityBytes: q.capacity,
		ReservedBytes: q.reserved,
		QueuedItems:   len(q.queued),
		InFlightItems: q.inFlight,
		Closed:        q.closed,
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

func (q *ByteQueue) closeCauseLocked() error {
	if q.cause != nil {
		return q.cause
	}
	return ErrQueueClosed
}

func (q *ByteQueue) signalLocked() {
	close(q.changed)
	q.changed = make(chan struct{})
}
