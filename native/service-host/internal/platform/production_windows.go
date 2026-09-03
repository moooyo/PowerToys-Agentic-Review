//go:build windows

package platform

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/cng"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/config"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/controlrpc"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/dataroot"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/hostcontrol"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/installverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/launchguard"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/localrpc"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/peerverify"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/preflight"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/relay"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releasemanifest"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/releaseprofile"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/rootcert"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/servicebootstrap"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winpipe"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/winprocess"
	"github.com/moooyo/PowerToys-Agentic-Review/native/service-host/internal/workertransport"
)

type windowsComposition struct {
	options BootstrapOptions
	role    config.Role

	releaseAuthority releaseprofile.Evidence
	serviceBootstrap servicebootstrap.Session
	currentImage     servicebootstrap.CurrentImageEvidence
	installation     installverify.Evidence
	dataRoot         dataroot.Evidence

	localAuthority *cng.Signer

	preflightEvidence preflight.Evidence
	peerPlan          preflight.PeerVerificationPlan
	peerPipe          *winpipe.Endpoint
	peerSession       *peerverify.Session
	runtimePlan       preflight.RuntimePlan
	runtimeBootstrap  localrpc.RuntimeBootstrapV1

	launchGuard  *launchguard.Guard
	hostListener *hostcontrol.Listener
	node         *launchguard.GuardedNodeProcess
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
	role, err := installverify.RoleFromBootstrapPath(options.ActualBootstrapPath)
	if err != nil {
		return err
	}
	composition.options = options
	composition.role = role
	composition.serviceStop = ctx
	return nil
}

func (composition *windowsComposition) loadReleaseAuthority(ctx context.Context) error {
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	authority, err := releaseprofile.Production()
	composition.releaseAuthority = authority
	return err
}

func (composition *windowsComposition) openServiceBootstrap(ctx context.Context) error {
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	session, err := servicebootstrap.Open(servicebootstrap.Options{Role: composition.role})
	composition.serviceBootstrap = session
	return err
}

func (composition *windowsComposition) measureCurrentImage(ctx context.Context) error {
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	if composition.serviceBootstrap == nil {
		return errors.New("service bootstrap session is unavailable")
	}
	image, err := composition.serviceBootstrap.MeasureCurrentImage()
	composition.currentImage = image
	return err
}

func (composition *windowsComposition) verifyInstallation(ctx context.Context) error {
	evidence, err := installverify.Verify(ctx, installverify.Options{
		Role:                composition.role,
		ActualBootstrapPath: composition.options.ActualBootstrapPath,
		Limits:              installverify.ProductionLimits(),
	}, composition.releaseAuthority)
	composition.installation = evidence
	return err
}

func (composition *windowsComposition) verifyDataRoot(ctx context.Context) error {
	evidence, err := dataroot.VerifyRuntime(ctx, composition.installation)
	composition.dataRoot = evidence
	return err
}

func (composition *windowsComposition) openRoleCredentials(ctx context.Context) error {
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	configuration := composition.installation.ControlConfiguration()
	if err := requireProductionBearerProfile(configuration); err != nil {
		return err
	}
	if composition.role == config.RoleExecutor {
		return nil
	}
	if composition.role != config.RoleControl {
		return errors.New("unsupported credential role")
	}
	control := configuration.Control
	localAuthority, err := cng.Open(cng.Options{
		KeyName:                          control.LocalAuthorityCNGKeyName,
		ExpectedSecurityDescriptorSHA256: control.LocalAuthorityKeySecurityDescriptorSHA256,
		ControlServiceSID:                configuration.OwnService.SID,
		ExecutorServiceSID:               configuration.PeerService.SID,
	})
	composition.localAuthority = localAuthority
	return err
}

func (composition *windowsComposition) composePreflight(context.Context) error {
	if composition.serviceBootstrap == nil {
		return errors.New("service bootstrap session is unavailable")
	}
	evidence, err := preflight.Compose(preflight.Input{
		Role:                 composition.role,
		ActualBootstrapPath:  composition.options.ActualBootstrapPath,
		Bootstrap:            composition.serviceBootstrap.Evidence(),
		CurrentImage:         composition.currentImage,
		Installation:         composition.installation,
		DataRoot:             composition.dataRoot,
		LocalAuthoritySigner: composition.localAuthority,
	})
	composition.preflightEvidence = evidence
	if err != nil {
		return err
	}
	plan, err := evidence.PeerVerificationPlan()
	composition.peerPlan = plan
	return err
}

func (composition *windowsComposition) connectPeer(ctx context.Context) error {
	configuration := composition.preflightEvidence.Configuration()
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
	session, err := composition.peerPlan.VerifyWindows(composition.peerPipe)
	composition.peerSession = session
	return err
}

func (composition *windowsComposition) finalizeRuntimePlan(ctx context.Context) error {
	plan, err := composition.preflightEvidence.FinalizeRuntimePlan(ctx, composition.dataRoot)
	composition.runtimePlan = plan
	return err
}

func (composition *windowsComposition) createRuntimeBootstrap(ctx context.Context) error {
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	bootstrap, err := composition.runtimePlan.NewRuntimeBootstrapV1()
	composition.runtimeBootstrap = bootstrap
	return err
}

func (composition *windowsComposition) openLaunchGuard(ctx context.Context) error {
	guard, err := launchguard.Open(ctx, composition.preflightEvidence, composition.runtimePlan)
	composition.launchGuard = guard
	return err
}

func (composition *windowsComposition) prepareHostControl(ctx context.Context) error {
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	configuration := composition.runtimePlan.Configuration()
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
	if composition.launchGuard == nil || composition.hostListener == nil {
		return errors.New("Node launch dependencies are unavailable")
	}
	node, err := composition.launchGuard.LaunchNode(
		ctx,
		composition.hostListener.PipeName(),
		composition.runtimeBootstrap,
	)
	composition.node = node
	if node != nil {
		owner, ownerErr := newNodeShutdownOwner(node)
		composition.nodeOwner = owner
		err = errors.Join(err, ownerErr)
	}
	return err
}

func (composition *windowsComposition) takeNodeStandardIO(ctx context.Context) error {
	if composition.node == nil {
		return errors.New("guarded Node process is unavailable")
	}
	owner, err := composition.node.TakeStandardIO()
	composition.lifetime = ctx
	composition.nodeIO = owner
	if err != nil {
		return err
	}
	configuration := composition.runtimePlan.Configuration()
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
	connection, err := composition.hostListener.Accept(ctx, composition.node)
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
	configuration := composition.runtimePlan.Configuration()
	return buildRoleRuntimeComponents(composition.role, func() (localrpc.ControlDispatcher, error) {
		roots, err := controlRootCertificates(composition.runtimePlan)
		if err != nil {
			return nil, err
		}
		if composition.localAuthority == nil || requireProductionBearerProfile(configuration) != nil ||
			configuration.Control.WorkerAuthenticationProfile != workertransport.WorkerAuthProfileID {
			return nil, errors.New("Control runtime credentials are unavailable")
		}
		authentication, err := workertransport.LoadWorkerAuth()
		if err != nil {
			return nil, err
		}
		client, err := workertransport.NewClient(workertransport.Config{
			Origin:             configuration.Control.ServerOrigin,
			ServerName:         configuration.Control.ServerName,
			RootCertificateDER: roots,
			WorkerNodeID:       configuration.WorkerNodeID,
			WorkerAuth:         authentication,
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
		controlDispatcher, err := controlrpc.New(client, composition.localAuthority)
		composition.dispatcher = controlDispatcher
		if err != nil {
			return nil, err
		}
		composition.localAuthority = nil
		return controlDispatcher, nil
	}, func(localRole localrpc.Role, dispatcher localrpc.ControlDispatcher) error {
		if composition.role == config.RoleExecutor &&
			(composition.workerClient != nil || composition.dispatcher != nil ||
				composition.localAuthority != nil) {
			return errors.New("Executor runtime received Control-only dependencies")
		}
		shutdownTimeout, err := gracefulShutdownTimeout(configuration)
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
		composition.serviceBootstrap == nil || composition.rpcServer == nil ||
		composition.lifetime == nil || composition.serviceStop == nil {
		return runtimeSupervision{}, errInvalidComposition
	}
	configuration := composition.runtimePlan.Configuration()
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
		waitOwnWrapper:  composition.serviceBootstrap.Wait,
		waitPeerWrapper: composition.peerSession.WaitWrapper,
		waitPeerHost:    composition.peerSession.WaitPeer,
		waitStderr:      func(context.Context) error { return composition.stderr.Wait() },
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

	if composition.node != nil && composition.nodeOwner == nil {
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
		add("close guarded Node process", composition.nodeOwner.Close())
	}
	if composition.hostListener != nil {
		add("close HostControl listener", composition.hostListener.Close())
	}
	if composition.node == nil && composition.launchGuard != nil {
		add("close unconsumed launch guard", composition.launchGuard.Close())
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
	if composition.localAuthority != nil {
		add("close local-authority signer", composition.localAuthority.Close())
	}
	// FinalizeRuntimePlan closes this evidence on every path, but a native close
	// failure deliberately retains the exact handles for this cleanup retry.
	add("close retained data-root evidence", composition.dataRoot.Close())
	if composition.serviceBootstrap != nil {
		add("close service bootstrap session", composition.serviceBootstrap.Close())
	}
	return errors.Join(failures...)
}

func controlRootCertificates(plan preflight.RuntimePlan) ([][]byte, error) {
	configuration := plan.Configuration()
	if configuration.Role != config.RoleControl || configuration.Control == nil {
		return nil, errors.New("Control runtime plan is required for root certificates")
	}
	var content []byte
	matches := 0
	for _, candidate := range plan.RuntimeContents() {
		if candidate.Role() != releasemanifest.RoleCABundle ||
			candidate.AbsolutePath() != configuration.Control.RootCertificatePath ||
			candidate.SHA256() != configuration.Control.RootCertificateSHA256 {
			continue
		}
		content = candidate.Bytes()
		matches++
	}
	if matches != 1 || len(content) == 0 {
		return nil, errors.New("runtime plan does not contain one exact Control root CA bundle")
	}
	roots, err := rootcert.Parse(content)
	clear(content)
	return roots, err
}

var _ compositionBuilder = (*windowsComposition)(nil)
