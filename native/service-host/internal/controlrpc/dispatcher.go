package controlrpc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math/big"
	"reflect"
	"sync"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/cng"
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

type localAuthoritySigner interface {
	SignDigest([]byte) ([]byte, error)
	Close() error
}

type productionLocalAuthoritySigner interface {
	localAuthoritySigner
	Identity() cng.KeyIdentity
	IsOpen() bool
}

// Dispatcher is safe for concurrent operation calls and Close calls.
//
// New borrows the Worker API client and takes ownership of the local-authority signer. Close
// cancels and waits for this dispatcher's active operations, then releases the signer. A failed
// signer release may be retried by calling Close again; a successful release is final. The caller
// retains ownership of the Worker API client and its process-scoped HTTP transport.
type Dispatcher struct {
	client workerClient
	signer localAuthoritySigner

	mu         sync.Mutex
	closed     bool
	operations map[uint64]context.CancelCauseFunc
	nextID     uint64
	active     sync.WaitGroup
	closeOnce  sync.Once
	closeMu    sync.Mutex
	signerGone bool
}

var _ localrpc.ControlDispatcher = (*Dispatcher)(nil)

// New constructs the production adapter around one fixed-origin Worker API client and one
// validated local-authority CNG signer. Ownership of the signer transfers only on success.
func New(client *workertransport.Client, localAuthority *cng.Signer) (*Dispatcher, error) {
	return newProductionDispatcher(client, localAuthority)
}

func newProductionDispatcher(client workerClient, localAuthority productionLocalAuthoritySigner) (*Dispatcher, error) {
	if isNilDependency(client) || isNilDependency(localAuthority) || !localAuthority.IsOpen() {
		return nil, ErrInvalidDependencies
	}
	identity := localAuthority.Identity()
	if !identity.MachineKey || identity.ProviderName == "" || identity.UniqueName == "" {
		return nil, ErrInvalidDependencies
	}
	return newDispatcher(client, localAuthority)
}

func newDispatcher(client workerClient, signer localAuthoritySigner) (*Dispatcher, error) {
	if isNilDependency(client) || isNilDependency(signer) {
		return nil, ErrInvalidDependencies
	}
	return &Dispatcher{
		client:     client,
		signer:     signer,
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

func (d *Dispatcher) SignLocalDigest(ctx context.Context, digest [cng.DigestSize]byte) ([]byte, error) {
	operationContext, finish, err := d.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer finish()

	if err := contextError(operationContext); err != nil {
		return nil, err
	}
	digestSnapshot := make([]byte, cng.DigestSize)
	copy(digestSnapshot, digest[:])
	signature, signErr := d.signer.SignDigest(digestSnapshot)
	if err := contextError(operationContext); err != nil {
		return nil, err
	}
	if signErr != nil || !validP256LowSSignature(signature) {
		return nil, internalError()
	}
	return bytes.Clone(signature), nil
}

// Close cancels active calls, waits for them to leave the adapter, and releases the owned signer.
// It never closes the borrowed Worker API client or its HTTP transport.
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

	d.closeMu.Lock()
	defer d.closeMu.Unlock()
	if d.signerGone {
		return nil
	}
	if err := d.signer.Close(); err != nil {
		return internalError()
	}
	d.signerGone = true
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

func validP256LowSSignature(signature []byte) bool {
	if len(signature) != cng.SignatureSize {
		return false
	}
	order := new(big.Int).SetBytes([]byte{
		0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00,
		0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
		0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84,
		0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
	})
	r := new(big.Int).SetBytes(signature[:cng.DigestSize])
	s := new(big.Int).SetBytes(signature[cng.DigestSize:])
	halfOrder := new(big.Int).Rsh(new(big.Int).Set(order), 1)
	return r.Sign() > 0 && r.Cmp(order) < 0 && s.Sign() > 0 && s.Cmp(halfOrder) <= 0
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
