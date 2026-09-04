package controlrpc

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sync"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/workertransport"
)

const maximumStatusBodyBytes = 64 * 1024

var (
	ErrInvalidDependencies = errors.New("invalid control RPC dispatcher dependencies")
	errDispatcherClosed    = errors.New("control RPC dispatcher is closed")
)

type workerClient interface {
	Register(context.Context, workertransport.RegisterRequest) (workertransport.RegisterResponse, error)
	Claim(context.Context, workertransport.ClaimRequest) (workertransport.ClaimResponse, error)
	HeartbeatInstance(
		context.Context,
		workertransport.InstanceHeartbeatRequest,
	) (workertransport.InstanceHeartbeatResponse, error)
	CompleteRun(context.Context, workertransport.RunCompleteRequest) (workertransport.RunCompleteResponse, error)
	FailRun(context.Context, workertransport.RunFailRequest) (workertransport.RunFailResponse, error)
}

// Dispatcher is safe for concurrent operation calls and Close calls. New borrows the Worker API
// client. Close cancels and waits for active operations without closing that client or its
// process-scoped HTTP transport.
type Dispatcher struct {
	client workerClient

	mu         sync.Mutex
	closed     bool
	operations map[uint64]context.CancelCauseFunc
	nextID     uint64
	active     sync.WaitGroup
	closeOnce  sync.Once
}

var _ localrpc.ControlDispatcher = (*Dispatcher)(nil)

// New constructs the production adapter around one fixed-origin Worker API client.
func New(client *workertransport.Client) (*Dispatcher, error) {
	return newDispatcher(client)
}

func newDispatcher(client workerClient) (*Dispatcher, error) {
	if isNilDependency(client) {
		return nil, ErrInvalidDependencies
	}
	return &Dispatcher{
		client:     client,
		operations: make(map[uint64]context.CancelCauseFunc),
	}, nil
}

func (d *Dispatcher) Register(ctx context.Context, body json.RawMessage) (json.RawMessage, error) {
	operationContext, finish, err := d.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer finish()

	requestBody, err := copyWorkerAPIBody(body, localrpc.MaximumWorkerAPIBodyBytes)
	if err != nil {
		return nil, internalError()
	}
	response, err := d.client.Register(operationContext, workertransport.RegisterRequest{Body: requestBody})
	if err != nil {
		return nil, classifyWorkerError(operationContext, localrpc.OperationRegister, err)
	}
	if err := contextError(operationContext); err != nil {
		return nil, err
	}
	return copyWorkerAPIResponse(response.Body, localrpc.MaximumWorkerAPIBodyBytes)
}

func (d *Dispatcher) Claim(ctx context.Context, body json.RawMessage) (json.RawMessage, error) {
	operationContext, finish, err := d.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer finish()

	requestBody, err := copyWorkerAPIBody(body, localrpc.MaximumWorkerAPIBodyBytes)
	if err != nil {
		return nil, internalError()
	}
	response, err := d.client.Claim(operationContext, workertransport.ClaimRequest{Body: requestBody})
	if err != nil {
		return nil, classifyWorkerError(operationContext, localrpc.OperationClaim, err)
	}
	if err := contextError(operationContext); err != nil {
		return nil, err
	}
	return copyWorkerAPIResponse(response.Body, localrpc.MaximumClaimResponseBodyBytes)
}

func (d *Dispatcher) InstanceHeartbeat(
	ctx context.Context,
	workerInstanceID string,
	body json.RawMessage,
) (json.RawMessage, error) {
	operationContext, finish, err := d.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer finish()

	requestBody, err := copyWorkerAPIBody(body, localrpc.MaximumWorkerAPIBodyBytes)
	if err != nil {
		return nil, internalError()
	}
	response, err := d.client.HeartbeatInstance(
		operationContext,
		workertransport.InstanceHeartbeatRequest{
			WorkerInstanceID: workerInstanceID,
			Body:             requestBody,
		},
	)
	if err != nil {
		return nil, classifyWorkerError(operationContext, localrpc.OperationInstanceHeartbeat, err)
	}
	if err := contextError(operationContext); err != nil {
		return nil, err
	}
	return copyWorkerAPIResponse(response.Body, localrpc.MaximumWorkerAPIBodyBytes)
}

func (d *Dispatcher) CompleteRun(
	ctx context.Context,
	runAttemptID string,
	body json.RawMessage,
) (json.RawMessage, error) {
	operationContext, finish, err := d.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer finish()

	requestBody, err := copyWorkerAPIBody(body, localrpc.MaximumRunCompletionRequestBodyBytes)
	if err != nil {
		return nil, internalError()
	}
	response, err := d.client.CompleteRun(operationContext, workertransport.RunCompleteRequest{
		RunAttemptID: runAttemptID,
		Body:         requestBody,
	})
	if err != nil {
		return nil, classifyWorkerError(operationContext, localrpc.OperationCompleteRun, err)
	}
	if err := contextError(operationContext); err != nil {
		return nil, err
	}
	return copyWorkerAPIResponse(response.Body, localrpc.MaximumWorkerAPIBodyBytes)
}

func (d *Dispatcher) FailRun(
	ctx context.Context,
	runAttemptID string,
	body json.RawMessage,
) (json.RawMessage, error) {
	operationContext, finish, err := d.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer finish()

	requestBody, err := copyWorkerAPIBody(body, localrpc.MaximumWorkerAPIBodyBytes)
	if err != nil {
		return nil, internalError()
	}
	response, err := d.client.FailRun(operationContext, workertransport.RunFailRequest{
		RunAttemptID: runAttemptID,
		Body:         requestBody,
	})
	if err != nil {
		return nil, classifyWorkerError(operationContext, localrpc.OperationFailRun, err)
	}
	if err := contextError(operationContext); err != nil {
		return nil, err
	}
	return copyWorkerAPIResponse(response.Body, localrpc.MaximumWorkerAPIBodyBytes)
}

// Close cancels active calls and waits for them to leave the adapter. It never closes the borrowed
// Worker API client or its HTTP transport.
func (d *Dispatcher) Close() error {
	if d == nil {
		return nil
	}
	d.closeOnce.Do(func() {
		d.mu.Lock()
		d.closed = true
		cancellations := make([]context.CancelCauseFunc, 0, len(d.operations))
		for _, cancel := range d.operations {
			cancellations = append(cancellations, cancel)
		}
		d.mu.Unlock()

		for _, cancel := range cancellations {
			cancel(errDispatcherClosed)
		}
		d.active.Wait()
	})
	return nil
}

func (d *Dispatcher) begin(ctx context.Context) (context.Context, func(), error) {
	if ctx == nil {
		return nil, nil, internalError()
	}
	if err := contextError(ctx); err != nil {
		return nil, nil, err
	}
	operationContext, cancel := context.WithCancelCause(ctx)

	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		cancel(errDispatcherClosed)
		return nil, nil, internalError()
	}
	d.nextID++
	operationID := d.nextID
	d.operations[operationID] = cancel
	d.active.Add(1)
	d.mu.Unlock()

	var once sync.Once
	finish := func() {
		once.Do(func() {
			d.mu.Lock()
			delete(d.operations, operationID)
			d.mu.Unlock()
			cancel(nil)
			d.active.Done()
		})
	}
	return operationContext, finish, nil
}

func copyWorkerAPIBody(body json.RawMessage, maximumBytes int) (json.RawMessage, error) {
	snapshot, err := localrpc.CopyWorkerAPIBody(body, maximumBytes)
	return json.RawMessage(snapshot), err
}

func copyWorkerAPIResponse(body json.RawMessage, maximumBytes int) (json.RawMessage, error) {
	snapshot, err := copyWorkerAPIBody(body, maximumBytes)
	if err != nil {
		return nil, upstreamProtocolError()
	}
	return snapshot, nil
}

func isNilDependency(value any) bool {
	if value == nil {
		return true
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return reflected.IsNil()
	default:
		return false
	}
}
