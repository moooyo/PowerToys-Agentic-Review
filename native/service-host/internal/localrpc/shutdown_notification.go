package localrpc

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

const (
	ShutdownRequestedNotification = "ShutdownRequested"
	ShutdownRequestedReason       = "SERVICE_STOP"
)

var (
	ErrShutdownNotificationUnavailable = errors.New("shutdown notification is unavailable")
	ErrShutdownNotificationRepeated    = errors.New("shutdown notification was already requested")
	ErrShutdownNotificationInvalid     = errors.New("shutdown notification deadline is invalid")
)

// ShutdownRequestedV1 is a ServiceHost-to-Node control-plane notification bound to one
// committed RuntimeBootstrapV1. Unix millisecond fields let both Node payloads derive the
// same monotonic deadline without placing an ARWX business frame in native code.
type ShutdownRequestedV1 struct {
	ProtocolVersion        string `json:"protocolVersion"`
	Type                   string `json:"type"`
	Notification           string `json:"notification"`
	BootstrapID            string `json:"bootstrapId"`
	Role                   Role   `json:"role"`
	ReasonCode             string `json:"reasonCode"`
	RequestedAtUnixMS      int64  `json:"requestedAtUnixMs"`
	ShutdownDeadlineUnixMS int64  `json:"shutdownDeadlineUnixMs"`
}

type shutdownNotificationSession struct {
	writer *responseWriter
	state  *sessionState
}

type shutdownNotificationController struct {
	mu        sync.Mutex
	binding   committedRuntimeBootstrapBinding
	shutdown  *arwxShutdownGate
	ready     chan struct{}
	session   *shutdownNotificationSession
	ended     bool
	attempted bool
}

func newShutdownNotificationController(
	binding committedRuntimeBootstrapBinding,
	shutdown *arwxShutdownGate,
) *shutdownNotificationController {
	return &shutdownNotificationController{
		binding:  binding,
		shutdown: shutdown,
		ready:    make(chan struct{}),
	}
}

func (controller *shutdownNotificationController) bind(
	writer *responseWriter,
	state *sessionState,
) error {
	if controller == nil || writer == nil || state == nil {
		return ErrShutdownNotificationUnavailable
	}
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if controller.ended || controller.session != nil {
		return ErrShutdownNotificationUnavailable
	}
	controller.session = &shutdownNotificationSession{writer: writer, state: state}
	close(controller.ready)
	return nil
}

func (controller *shutdownNotificationController) waitUntilBound(ctx context.Context) error {
	if controller == nil || ctx == nil {
		return ErrShutdownNotificationUnavailable
	}
	controller.mu.Lock()
	if controller.ended {
		controller.mu.Unlock()
		return ErrShutdownNotificationUnavailable
	}
	if controller.session != nil {
		controller.mu.Unlock()
		return nil
	}
	ready := controller.ready
	controller.mu.Unlock()
	select {
	case <-ready:
	case <-ctx.Done():
		return context.Cause(ctx)
	}
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if controller.ended || controller.session == nil {
		return ErrShutdownNotificationUnavailable
	}
	return nil
}

func (controller *shutdownNotificationController) end() {
	if controller == nil {
		return
	}
	controller.mu.Lock()
	defer controller.mu.Unlock()
	controller.ended = true
	controller.session = nil
}

func (controller *shutdownNotificationController) request(
	ctx context.Context,
	requestedAt time.Time,
	deadline time.Time,
) error {
	if controller == nil || ctx == nil {
		return ErrShutdownNotificationUnavailable
	}
	request, err := controller.build(requestedAt, deadline)
	if err != nil {
		return err
	}

	controller.mu.Lock()
	session := controller.session
	if controller.ended || session == nil {
		controller.mu.Unlock()
		return ErrShutdownNotificationUnavailable
	}
	if controller.attempted {
		controller.mu.Unlock()
		return ErrShutdownNotificationRepeated
	}
	controller.attempted = true
	document, err := marshalShutdownRequested(request)
	if err != nil {
		controller.mu.Unlock()
		return err
	}
	err = session.writer.writeShutdownNotification(
		ctx,
		document,
		deadline,
		func() error {
			if err := controller.setRequestedDeadline(deadline); err != nil {
				return err
			}
			session.state.markShutdownRequested()
			return nil
		},
	)
	controller.mu.Unlock()
	return err
}

func (controller *shutdownNotificationController) build(
	requestedAt time.Time,
	deadline time.Time,
) (ShutdownRequestedV1, error) {
	if controller == nil {
		return ShutdownRequestedV1{}, ErrShutdownNotificationUnavailable
	}
	if controller.binding.role != RoleControl {
		return ShutdownRequestedV1{}, ErrOperationNotAllowed
	}
	maximum := time.Duration(controller.binding.maximumRemainingShutdownMS) * time.Millisecond
	if requestedAt.IsZero() || deadline.IsZero() || maximum <= 0 ||
		requestedAt.Nanosecond()%int(time.Millisecond) != 0 ||
		deadline.Nanosecond()%int(time.Millisecond) != 0 ||
		!requestedAt.Before(deadline) || deadline.Sub(requestedAt) != maximum ||
		!time.Now().Before(deadline) {
		return ShutdownRequestedV1{}, ErrShutdownNotificationInvalid
	}
	return ShutdownRequestedV1{
		ProtocolVersion:        ProtocolVersion,
		Type:                   "notification",
		Notification:           ShutdownRequestedNotification,
		BootstrapID:            controller.binding.bootstrapID,
		Role:                   controller.binding.role,
		ReasonCode:             ShutdownRequestedReason,
		RequestedAtUnixMS:      requestedAt.UnixMilli(),
		ShutdownDeadlineUnixMS: deadline.UnixMilli(),
	}, nil
}

func (controller *shutdownNotificationController) setRequestedDeadline(deadline time.Time) error {
	if controller == nil || controller.shutdown == nil {
		return ErrShutdownNotificationUnavailable
	}
	return controller.shutdown.setRequestedDeadline(deadline)
}

func marshalShutdownRequested(value ShutdownRequestedV1) ([]byte, error) {
	if value.ProtocolVersion != ProtocolVersion || value.Type != "notification" ||
		value.Notification != ShutdownRequestedNotification ||
		!runtimeBootstrapUUIDV4.MatchString(value.BootstrapID) ||
		!validRuntimeBootstrapRole(value.Role) || value.ReasonCode != ShutdownRequestedReason ||
		value.RequestedAtUnixMS <= 0 || value.ShutdownDeadlineUnixMS <= value.RequestedAtUnixMS {
		return nil, ErrShutdownNotificationInvalid
	}
	document, err := MarshalCanonicalJSON(map[string]any{
		"bootstrapId":            value.BootstrapID,
		"notification":           value.Notification,
		"protocolVersion":        value.ProtocolVersion,
		"reasonCode":             value.ReasonCode,
		"requestedAtUnixMs":      value.RequestedAtUnixMS,
		"role":                   string(value.Role),
		"shutdownDeadlineUnixMs": value.ShutdownDeadlineUnixMS,
		"type":                   value.Type,
	}, MaximumCanonicalControlFrameBytes)
	if err != nil {
		return nil, fmt.Errorf("%w: encode canonical document", ErrShutdownNotificationInvalid)
	}
	return document, nil
}
