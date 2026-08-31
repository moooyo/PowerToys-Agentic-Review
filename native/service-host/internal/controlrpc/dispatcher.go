package controlrpc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"reflect"
	"sync"
	"unicode/utf8"

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

	requestBody, err := copyCanonicalObject(body, localrpc.MaximumFrameBytes)
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
	return canonicalizeWorkerResponse(response.Body, localrpc.MaximumFrameBytes)
}

func (d *Dispatcher) Claim(ctx context.Context, body json.RawMessage) (json.RawMessage, error) {
	operationContext, finish, err := d.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer finish()

	requestBody, err := copyCanonicalObject(body, localrpc.MaximumFrameBytes)
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
	return canonicalizeWorkerResponse(response.Body, localrpc.MaximumClaimResponseBodyBytes)
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

	requestBody, err := copyCanonicalObject(body, localrpc.MaximumFrameBytes)
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
	return canonicalizeWorkerResponse(response.Body, localrpc.MaximumFrameBytes)
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

	requestBody, err := copyCanonicalObject(body, localrpc.MaximumRunCompletionRequestBodyBytes)
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
	return canonicalizeWorkerResponse(response.Body, localrpc.MaximumFrameBytes)
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

	requestBody, err := copyCanonicalObject(body, localrpc.MaximumFrameBytes)
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
	return canonicalizeWorkerResponse(response.Body, localrpc.MaximumFrameBytes)
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

func copyCanonicalObject(body json.RawMessage, maximumBytes int) (json.RawMessage, error) {
	value, err := localrpc.ParseCanonicalJSON(body, maximumBytes)
	if err != nil {
		return nil, err
	}
	if _, ok := value.(map[string]any); !ok {
		return nil, localrpc.ErrInvalidCanonicalJSON
	}
	return json.RawMessage(bytes.Clone(body)), nil
}

func canonicalizeWorkerResponse(body json.RawMessage, maximumBytes int) (json.RawMessage, error) {
	if len(body) == 0 || len(body) > maximumBytes || !validJSONUnicode(body) {
		return nil, upstreamProtocolError()
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	value, err := decodeUniqueJSONValue(decoder, 0)
	if err != nil {
		return nil, upstreamProtocolError()
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return nil, upstreamProtocolError()
	}
	if _, ok := value.(map[string]any); !ok {
		return nil, upstreamProtocolError()
	}
	canonical, err := localrpc.MarshalCanonicalJSON(value, maximumBytes)
	if err != nil {
		return nil, upstreamProtocolError()
	}
	return json.RawMessage(bytes.Clone(canonical)), nil
}

func validJSONUnicode(document []byte) bool {
	if !utf8.Valid(document) {
		return false
	}
	inString := false
	for index := 0; index < len(document); index++ {
		switch document[index] {
		case '"':
			inString = !inString
		case '\\':
			if !inString || index+1 >= len(document) {
				continue
			}
			if document[index+1] != 'u' {
				index++
				continue
			}
			codeUnit, ok := decodeHexCodeUnit(document, index+2)
			if !ok {
				return false
			}
			if codeUnit >= 0xdc00 && codeUnit <= 0xdfff {
				return false
			}
			if codeUnit >= 0xd800 && codeUnit <= 0xdbff {
				if index+11 >= len(document) || document[index+6] != '\\' || document[index+7] != 'u' {
					return false
				}
				low, lowOK := decodeHexCodeUnit(document, index+8)
				if !lowOK || low < 0xdc00 || low > 0xdfff {
					return false
				}
				index += 11
				continue
			}
			index += 5
		}
	}
	return true
}

func decodeHexCodeUnit(document []byte, offset int) (uint16, bool) {
	if offset < 0 || offset+4 > len(document) {
		return 0, false
	}
	var value uint16
	for _, character := range document[offset : offset+4] {
		value <<= 4
		switch {
		case character >= '0' && character <= '9':
			value |= uint16(character - '0')
		case character >= 'a' && character <= 'f':
			value |= uint16(character-'a') + 10
		case character >= 'A' && character <= 'F':
			value |= uint16(character-'A') + 10
		default:
			return 0, false
		}
	}
	return value, true
}

func decodeUniqueJSONValue(decoder *json.Decoder, depth int) (any, error) {
	if depth > 64 {
		return nil, localrpc.ErrCanonicalJSONLimit
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
		return token, nil
	}

	switch delimiter {
	case '{':
		object := make(map[string]any)
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, localrpc.ErrInvalidCanonicalJSON
			}
			if _, exists := object[key]; exists {
				return nil, localrpc.ErrInvalidCanonicalJSON
			}
			value, err := decodeUniqueJSONValue(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			object[key] = value
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return nil, localrpc.ErrInvalidCanonicalJSON
		}
		return object, nil
	case '[':
		array := make([]any, 0)
		for decoder.More() {
			value, err := decodeUniqueJSONValue(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			array = append(array, value)
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return nil, localrpc.ErrInvalidCanonicalJSON
		}
		return array, nil
	default:
		return nil, localrpc.ErrInvalidCanonicalJSON
	}
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
