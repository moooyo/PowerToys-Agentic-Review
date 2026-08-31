//go:build !windows

package hostcontrol

import (
	"context"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winprocess"
)

// Listener is an unavailable placeholder outside Windows.
type Listener struct{}

// Connection is an unavailable, copy-safe placeholder outside Windows.
type Connection struct{}

// Prepare fails closed outside Windows.
func Prepare(Options) (*Listener, error) {
	return nil, ErrUnsupportedPlatform
}

func (*Listener) PipeName() string {
	return ""
}

// Accept fails before transferring any connection ownership outside Windows.
func (*Listener) Accept(
	context.Context,
	winprocess.NodeProcess,
	localrpc.RuntimeBootstrapV1,
) (*Connection, error) {
	return nil, ErrUnsupportedPlatform
}

func (*Listener) Close() error {
	return ErrUnsupportedPlatform
}

func (*Connection) Evidence() VerificationEvidence {
	return VerificationEvidence{}
}

func (*Connection) CommittedRuntimeBootstrap() localrpc.CommittedRuntimeBootstrap {
	return localrpc.CommittedRuntimeBootstrap{}
}

func (*Connection) Read([]byte) (int, error) {
	return 0, ErrUnsupportedPlatform
}

func (*Connection) ReadContext(context.Context, []byte) (int, error) {
	return 0, ErrUnsupportedPlatform
}

func (*Connection) Write([]byte) (int, error) {
	return 0, ErrUnsupportedPlatform
}

func (*Connection) WriteContext(context.Context, []byte) (int, error) {
	return 0, ErrUnsupportedPlatform
}

// Close reports that HostControl connection cleanup is unavailable outside Windows.
func (*Connection) Close() error {
	return ErrUnsupportedPlatform
}
