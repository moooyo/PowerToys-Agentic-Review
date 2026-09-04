//go:build windows

package platform

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/controlrpc"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/hostcontrol"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peerverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/relay"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/servicebootstrap"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winpipe"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winprocess"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/workertransport"
)

type windowsComposition struct {
	options BootstrapOptions
	role    config.Role

	configuration    config.Config
	runtime          config.RuntimeConfig
	workerAuth       workertransport.WorkerAuth
	peerPipe         *winpipe.Endpoint
	peerSession      *peerverify.Session
	runtimeBootstrap localrpc.LaunchRuntimeBootstrap

	hostListener *hostcontrol.Listener
	node         winprocess.NodeProcess
	nodeOwner    *nodeShutdownOwner
	nodeIO       *winprocess.NodeStandardIO
	nodeEndpoint *nodeARWXEndpoint
	stderr       *nodeStderrDrain

	hostConnection *hostcontrol.Connection
	workerClient   *workertransport.Client
	dispatcher     *controlrpc.Dispatcher
	rpcServer      *localrpc.Server

	lifetime           context.Context
	serviceStop        context.Context
	supervisionStarted bool
}

func (composition *windowsComposition) selectRole(
	ctx context.Context,
	options BootstrapOptions,
) error {
	if ctx == nil {
		return errors.New("role selection context is required")
	}
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	role, err := config.RoleFromTrustedBootstrapPath(options.ActualBootstrapPath)
	if err != nil {
		return err
	}
	composition.options = options
	composition.role = role
	composition.serviceStop = ctx
	return nil
}

func (composition *windowsComposition) prepareServiceSecurity(ctx context.Context) error {
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	return servicebootstrap.Prepare(composition.role)
}

func (composition *windowsComposition) loadConfiguration(ctx context.Context) error {
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	configuration, err := config.Load(composition.options.ActualBootstrapPath)
	if err != nil {
		return err
	}
	if configuration.Role != composition.role {
		return errors.New("role configuration does not match the selected service role")
	}
	runtimeConfiguration, err := configuration.Runtime()
	if err != nil {
		return err
	}
	composition.configuration = configuration
	composition.runtime = runtimeConfiguration
	return nil
}

func (composition *windowsComposition) openRoleCredentials(ctx context.Context) error {
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	if composition.role != config.RoleControl {
		return nil
	}
	authentication, err := workertransport.LoadWorkerAuth()
	if err != nil {
		return err
	}
	if authentication.WorkerNodeID() != composition.configuration.WorkerNodeID {
		return errors.New("Worker authentication profile belongs to another Worker node")
	}
	composition.workerAuth = authentication
	return nil
}

func (composition *windowsComposition) connectPeer(ctx context.Context) error {
	configuration := composition.runtime
	var endpoint *winpipe.Endpoint
	var err error
	switch composition.role {
	case config.RoleControl:
		endpoint, err = winpipe.Accept(ctx, winpipe.ServerOptions{
			PipeName:          configuration.PipeName,
			OwnServiceSID:     configuration.OwnService.SID,
			PeerServiceSID:    configuration.PeerService.SID,
			MaximumFrameBytes: configuration.Limits.MaximumFrameBytes,
		})
	case config.RoleExecutor:
		endpoint, err = winpipe.Dial(ctx, winpipe.ClientOptions{
			PipeName:          configuration.PipeName,
			MaximumFrameBytes: configuration.Limits.MaximumFrameBytes,
		})
	default:
		return errors.New("unsupported inter-service pipe role")
	}
	composition.peerPipe = endpoint
	return err
}

func (composition *windowsComposition) verifyPeer(context.Context) error {
	session, err := peerverify.VerifyWindows(composition.role, composition.peerPipe)
	composition.peerSession = session
	return err
}

func (composition *windowsComposition) createRuntimeBootstrap(ctx context.Context) error {
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	role, _, err := runtimeRoles(composition.role)
	if err != nil {
		return err
	}
	options := localrpc.FoundationRuntimeBootstrapOptions{
		Role:                           role,
		WorkerNodeID:                   composition.configuration.WorkerNodeID,
		MaximumQueuedBytesPerDirection: int(composition.runtime.Limits.MaximumQueuedBytesPerDirection),
		TotalShutdownTimeoutMS:         int(composition.runtime.Limits.ShutdownTimeoutMilliseconds),
		ForceTerminationReserveMS:      int(composition.runtime.Limits.ForceTerminationReserveMilliseconds),
	}
	bootstrap, err := localrpc.NewFoundationRuntimeBootstrap(options)
	if err != nil {
		return err
	}
	bound, err := localrpc.BindRuntimeBootstrapToLaunch(bootstrap, options)
	composition.runtimeBootstrap = bound
	return err
}

func (composition *windowsComposition) prepareHostControl(ctx context.Context) error {
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	configuration := composition.runtime
	listener, err := hostcontrol.Prepare(hostcontrol.Options{
		OwnServiceSID:  configuration.OwnService.SID,
		ConnectTimeout: durationMilliseconds(configuration.Limits.ConnectTimeoutMilliseconds),
		IOTimeout:      productionRequestTimeout,
		CloseTimeout:   durationMilliseconds(configuration.Limits.ForceTerminationReserveMilliseconds),
	})
	composition.hostListener = listener
	return err
}

func (composition *windowsComposition) launchNode(ctx context.Context) error {
	if composition.hostListener == nil {
		return errors.New("Node launch dependencies are unavailable")
	}
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	memory, err := strconv.ParseUint(composition.runtime.Limits.RootJobMaximumMemoryBytes, 10, 64)
	if err != nil {
		return fmt.Errorf("parse root Job memory limit: %w", err)
	}
	role := winprocess.RoleControl
	if composition.role == config.RoleExecutor {
		role = winprocess.RoleExecutor
	}
	node, err := winprocess.LaunchNode(winprocess.NodeLaunchSpec{
		ExecutablePath:      composition.runtime.Node.ExecutablePath,
		BundlePath:          composition.runtime.Node.BundlePath,
		WorkingDirectory:    composition.runtime.Node.WorkingDirectory,
		HostControlPipeName: composition.hostListener.PipeName(),
		Role:                role,
		OwnServiceSID:       composition.runtime.OwnService.SID,
		PeerServiceSID:      composition.runtime.PeerService.SID,
		Environment:         cloneEnvironment(composition.runtime.Node.Environment),
		MaximumProcesses:    composition.runtime.Limits.RootJobMaximumProcesses,
		MaximumMemoryBytes:  memory,
		ShutdownTimeout: durationMilliseconds(
			composition.runtime.Limits.ForceTerminationReserveMilliseconds,
		),
	})
	composition.node = node
	if !isNilCompositionValue(node) {
		owner, ownerErr := newNodeShutdownOwner(node)
		composition.nodeOwner = owner
		err = errors.Join(err, ownerErr)
	}
	return err
}

func (composition *windowsComposition) takeNodeStandardIO(ctx context.Context) error {
	if composition.node == nil {
		return errors.New("Node process is unavailable")
	}
	owner, err := composition.node.TakeStandardIO()
	composition.lifetime = ctx
	composition.nodeIO = owner
	if err != nil {
		return err
	}
	configuration := composition.runtime
	endpoint, err := newNodeARWXEndpoint(owner, configuration.Limits.MaximumFrameBytes)
	if err != nil {
		return err
	}
	composition.nodeEndpoint = endpoint
	drain, err := endpoint.startStderrDrain(ctx)
	composition.stderr = drain
	return err
}

func (composition *windowsComposition) acceptHostControl(ctx context.Context) error {
	if composition.hostListener == nil || composition.node == nil {
		return errors.New("HostControl accept dependencies are unavailable")
	}
	connection, err := composition.hostListener.Accept(ctx, composition.node, composition.runtimeBootstrap)
	composition.hostConnection = connection
	if err != nil && composition.nodeOwner != nil {
		// HostControl rejects a claimed launch by terminating it internally.
		// Retain the exact owner rather than spending the reserve a second time.
		composition.nodeOwner.retainAfterExternalShutdownAttempt(err)
	}
	return err
}

func (composition *windowsComposition) buildRoleRuntime(ctx context.Context) error {
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	if composition.hostConnection == nil {
		return errors.New("committed HostControl connection is unavailable")
	}
	runtimeConfiguration := composition.runtime
	return buildRoleRuntimeComponents(composition.role, func() (localrpc.ControlDispatcher, error) {
		if composition.role != config.RoleControl || composition.configuration.ServerOrigin == "" {
			return nil, errors.New("Control runtime credentials are unavailable")
		}
		client, err := workertransport.NewClient(workertransport.Config{
			Origin:       composition.configuration.ServerOrigin,
			WorkerNodeID: composition.configuration.WorkerNodeID,
			WorkerAuth:   composition.workerAuth,
			Limits: workertransport.Limits{
				MaximumRequestBytes:       localrpc.MaximumRunCompletionRequestBodyBytes,
				MaximumResponseBytes:      localrpc.MaximumClaimResponseBodyBytes,
				RequestTimeout:            productionRequestTimeout,
				ClaimTimeout:              productionClaimTimeout,
				MaximumConcurrentRequests: productionMaximumConcurrency,
			},
		})
		composition.workerClient = client
		if err != nil {
			return nil, err
		}
		controlDispatcher, err := controlrpc.New(client)
		composition.dispatcher = controlDispatcher
		if err != nil {
			return nil, err
		}
		return controlDispatcher, nil
	}, func(localRole localrpc.Role, dispatcher localrpc.ControlDispatcher) error {
		if composition.role == config.RoleExecutor &&
			(composition.workerClient != nil || composition.dispatcher != nil) {
			return errors.New("Executor runtime received Control-only dependencies")
		}
		shutdownTimeout, err := gracefulShutdownTimeout(runtimeConfiguration)
		if err != nil {
			return err
		}
		server, err := localrpc.NewServer(localrpc.ServerOptions{
			Role:                      localRole,
			RuntimeBootstrap:          composition.hostConnection.CommittedRuntimeBootstrap(),
			MaximumConcurrentRequests: productionMaximumConcurrency,
			MaximumRequestsPerSession: productionMaximumRequestsPerSession,
			RequestTimeout:            productionRequestTimeout,
			ClaimTimeout:              productionClaimTimeout,
			IOTimeout:                 productionRequestTimeout,
			ShutdownTimeout:           shutdownTimeout,
		}, dispatcher)
		composition.rpcServer = server
		return err
	})
}

func (composition *windowsComposition) runtimeSupervision() (runtimeSupervision, error) {
	if composition.node == nil || composition.nodeOwner == nil ||
		composition.nodeEndpoint == nil || composition.stderr == nil ||
		composition.hostConnection == nil || composition.peerPipe == nil || composition.peerSession == nil ||
		composition.rpcServer == nil || composition.lifetime == nil || composition.serviceStop == nil {
		return runtimeSupervision{}, errInvalidComposition
	}
	configuration := composition.runtime
	_, relayRole, err := runtimeRoles(composition.role)
	if err != nil {
		return runtimeSupervision{}, err
	}
	shutdownTimeout, err := gracefulShutdownTimeout(configuration)
	if err != nil {
		return runtimeSupervision{}, err
	}
	composition.supervisionStarted = true
	runtime := runtimeSupervision{
		node:                 composition.nodeOwner,
		stopContext:          composition.serviceStop,
		shutdownTimeout:      shutdownTimeout,
		readShutdownDeadline: composition.rpcServer.ArmedShutdownDeadline,
		serveLocalRPC: func(ctx context.Context) error {
			return composition.rpcServer.Serve(ctx, composition.hostConnection, composition.hostConnection)
		},
		runRelay: func(ctx context.Context) error {
			return relay.RunRoleAware(
				ctx,
				relayRole,
				composition.nodeEndpoint,
				composition.peerPipe,
				composition.rpcServer,
				relay.Options{
					MaximumQueuedBytesPerDirection: int(configuration.Limits.MaximumQueuedBytesPerDirection),
					ShutdownTimeout:                shutdownTimeout,
				},
			)
		},
		waitPeerHost: composition.peerSession.WaitPeer,
		waitStderr:   func(context.Context) error { return composition.stderr.Wait() },
	}
	if composition.role == config.RoleControl {
		runtime.requestNodeShutdown = func(
			ctx context.Context,
			requestedAt time.Time,
			deadline time.Time,
		) error {
			if err := composition.rpcServer.WaitUntilShutdownNotificationReady(ctx); err != nil {
				return err
			}
			return composition.rpcServer.RequestShutdown(ctx, requestedAt, deadline)
		}
	}
	return runtime, nil
}

func (composition *windowsComposition) cleanup() error {
	var failures []error
	add := func(label string, err error) {
		if err != nil {
			failures = append(failures, fmt.Errorf("%s: %w", label, err))
		}
	}

	if !isNilCompositionValue(composition.node) && composition.nodeOwner == nil {
		add("retain unmanaged Node owner", errInvalidComposition)
	} else if composition.nodeOwner != nil {
		add("terminate Node root Job", composition.nodeOwner.Terminate())
	}
	if composition.dispatcher != nil {
		add("close Control dispatcher", composition.dispatcher.Close())
	}
	if composition.workerClient != nil {
		err := composition.workerClient.Close()
		add("close Worker API client", err)
	}
	if composition.hostConnection != nil {
		add("close HostControl connection", composition.hostConnection.Close())
	}
	if composition.stderr != nil && !composition.supervisionStarted {
		if err := composition.stderr.Wait(); !expectedLifetimeCancellation(composition.lifetime, err) {
			add("join Node stderr drain", err)
		}
	}
	if composition.nodeEndpoint != nil {
		add("close Node standard I/O", composition.nodeEndpoint.Close())
	} else if composition.nodeIO != nil {
		add("close unadapted Node standard I/O", composition.nodeIO.Close())
	}
	if composition.nodeOwner != nil {
		add("close Node process", composition.nodeOwner.Close())
	}
	if composition.hostListener != nil {
		add("close HostControl listener", composition.hostListener.Close())
	}
	peerPipeClosed := true
	if composition.peerPipe != nil {
		err := composition.peerPipe.Close()
		add("close inter-service pipe", err)
		peerPipeClosed = err == nil
	}
	if composition.peerSession != nil && peerPipeClosed {
		add("close peer verification session", composition.peerSession.Close())
	}
	return errors.Join(failures...)
}

func cloneEnvironment(source map[string]string) map[string]string {
	clone := make(map[string]string, len(source))
	for name, value := range source {
		clone[name] = value
	}
	return clone
}

var _ compositionBuilder = (*windowsComposition)(nil)
