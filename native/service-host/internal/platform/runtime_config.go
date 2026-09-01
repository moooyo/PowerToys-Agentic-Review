package platform

import (
	"context"
	"errors"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/relay"
)

const (
	productionRequestTimeout            = 60 * time.Second
	productionClaimTimeout              = 90 * time.Second
	productionMaximumConcurrency        = 16
	productionMaximumRequestsPerSession = 1_000_000
)

func buildRoleRuntimeComponents(
	role config.Role,
	buildControl func() (localrpc.ControlDispatcher, error),
	buildServer func(localrpc.Role, localrpc.ControlDispatcher) error,
) error {
	if buildServer == nil {
		return errors.New("local RPC server factory is required")
	}
	localRole, _, err := runtimeRoles(role)
	if err != nil {
		return err
	}
	var dispatcher localrpc.ControlDispatcher
	if role == config.RoleControl {
		if buildControl == nil {
			return errors.New("Control runtime factory is required")
		}
		dispatcher, err = buildControl()
		if err != nil {
			return err
		}
	}
	return buildServer(localRole, dispatcher)
}

func runtimeRoles(role config.Role) (localrpc.Role, relay.Role, error) {
	switch role {
	case config.RoleControl:
		return localrpc.RoleControl, relay.RoleControl, nil
	case config.RoleExecutor:
		return localrpc.RoleExecutor, relay.RoleExecutor, nil
	default:
		return "", "", errors.New("unsupported runtime role")
	}
}

func gracefulShutdownTimeout(configuration config.Config) (time.Duration, error) {
	total := configuration.Limits.ShutdownTimeoutMilliseconds
	reserve := configuration.Limits.ForceTerminationReserveMilliseconds
	if total == 0 || reserve == 0 || reserve >= total {
		return 0, errors.New("invalid shutdown timeout or force-termination reserve")
	}
	return durationMilliseconds(total - reserve), nil
}

func durationMilliseconds(value uint32) time.Duration {
	return time.Duration(value) * time.Millisecond
}

func expectedLifetimeCancellation(ctx context.Context, err error) bool {
	if err == nil {
		return true
	}
	if ctx == nil {
		return false
	}
	cause := context.Cause(ctx)
	return cause != nil && (errors.Is(err, cause) || errors.Is(err, context.Canceled))
}
