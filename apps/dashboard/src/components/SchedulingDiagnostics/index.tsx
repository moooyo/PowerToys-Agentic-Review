import type { SchedulingDiagnostics as DiagnosticValue } from "@agentic-review/contracts";
import RefreshIcon from "@mui/icons-material/Refresh";
import { Alert, AlertTitle, Box, Button, Chip, Skeleton, Stack, Typography } from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { DetailsGrid } from "@/components/ui";
import {
  type SchedulingReadScope,
  scheduling,
  schedulingMatchesScope,
  schedulingScopeKey,
} from "@/services/scheduling";
import { useOperatorSession } from "@/state/session";
import {
  schedulingAccessDenied,
  schedulingDocumentVisible,
  schedulingEffectLabels,
  schedulingPollingInterval,
  schedulingReasonLabels,
  schedulingStageLabel,
} from "./state";

function Time({ value }: { value: string }) {
  return (
    <time dateTime={value} title={value}>
      {new Date(value).toLocaleString("en-US")}
    </time>
  );
}

function LimitUsage({ usage, limit }: { usage: number; limit: number | null }) {
  return (
    <span>
      {usage} / {limit === null ? "Unlimited" : limit}
    </span>
  );
}

function SchedulingSkeleton() {
  return (
    <Stack spacing={1} aria-label="Loading current scheduling">
      <Skeleton variant="text" width="40%" />
      <Skeleton variant="text" />
      <Skeleton variant="text" width="75%" />
    </Stack>
  );
}

export function SchedulingObservation({ value }: { value: DiagnosticValue }) {
  const repository = value.policy.repository;
  const platform = value.policy.platform;
  return (
    <Stack spacing={2} sx={{ width: "100%" }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <Chip
          color={value.stage === "waiting" ? "info" : "default"}
          label={schedulingStageLabel(value)}
        />
        <Typography variant="body2" color="text.secondary">
          Observed <Time value={value.observedAt} />
        </Typography>
      </Stack>
      <DetailsGrid
        columns={1}
        items={[
          ...(repository === null
            ? []
            : [
                {
                  key: "repository-policy",
                  label: "Repository policy",
                  value: `Version ${repository.version}${repository.enabled ? "" : " — paused"}`,
                },
                {
                  key: "repository-active",
                  label: "Repository active executions",
                  value: (
                    <LimitUsage
                      usage={repository.usage.activeLeases}
                      limit={repository.limits.maxActiveLeases}
                    />
                  ),
                },
                {
                  key: "repository-queue",
                  label: "Repository admitted queue",
                  value: (
                    <LimitUsage
                      usage={repository.usage.admittedQueuedJobs}
                      limit={repository.limits.maxQueuedJobs}
                    />
                  ),
                },
                {
                  key: "repository-pending",
                  label: "Repository awaiting admission",
                  value: repository.usage.awaitingAdmissionJobs,
                },
                {
                  key: "repository-no-job",
                  label: "Repository awaiting valid configuration",
                  value: repository.usage.awaitingConfigurationRequests,
                },
                ...(repository.overage.activeLeases > 0 || repository.overage.admittedQueuedJobs > 0
                  ? [
                      {
                        key: "repository-overage",
                        label: "Repository overage",
                        value: `${repository.overage.activeLeases} active; ${repository.overage.admittedQueuedJobs} admitted. Existing work is retained.`,
                      },
                    ]
                  : []),
              ]),
          {
            key: "platform-policy",
            label: "Platform policy",
            value: `Version ${platform.visibility === "full" ? platform.configuration.version : platform.version}`,
          },
          ...(platform.visibility === "restricted"
            ? [
                {
                  key: "platform-capacity",
                  label: "Platform quota capacity",
                  value: `Active: ${platform.activeCapacity}; queue: ${platform.queueCapacity}. Global usage details are restricted.`,
                },
              ]
            : [
                {
                  key: "platform-active",
                  label: "Platform active executions",
                  value: (
                    <LimitUsage
                      usage={platform.usage.activeLeases}
                      limit={platform.configuration.limits.maxActiveLeases}
                    />
                  ),
                },
                {
                  key: "platform-queue",
                  label: "Platform admitted queue",
                  value: (
                    <LimitUsage
                      usage={platform.usage.admittedQueuedJobs}
                      limit={platform.configuration.limits.maxQueuedJobs}
                    />
                  ),
                },
                {
                  key: "platform-pending",
                  label: "Platform awaiting admission",
                  value: platform.usage.awaitingAdmissionJobs,
                },
                {
                  key: "platform-no-job",
                  label: "Platform awaiting valid configuration",
                  value: platform.usage.awaitingConfigurationRequests,
                },
                ...(platform.overage.activeLeases > 0 || platform.overage.admittedQueuedJobs > 0
                  ? [
                      {
                        key: "platform-overage",
                        label: "Platform overage",
                        value: `${platform.overage.activeLeases} active; ${platform.overage.admittedQueuedJobs} admitted. Existing work is retained.`,
                      },
                    ]
                  : []),
              ]),
          {
            key: "inspection",
            label: "Inspection coverage",
            value:
              value.workerInspection.state === "complete"
                ? "Complete"
                : value.workerInspection.state === "partial"
                  ? "Partial — some current conditions were not checked"
                  : "Not applicable",
          },
          {
            key: "contact",
            label: "Latest matching worker contact",
            value: value.workerInspection.latestContactAt ? (
              <Time value={value.workerInspection.latestContactAt} />
            ) : (
              "Not recorded"
            ),
          },
        ]}
      />
      <Typography variant="body2" color="text.secondary">
        Quota capacity describes current limits only. It does not establish worker availability or
        reserve a slot.
      </Typography>
      {value.workerInspection.latestContactAt && (
        <Typography variant="body2" color="text.secondary">
          Contact time does not establish the age of reported local capacity.
        </Typography>
      )}
      {value.reasons.length > 0 ? (
        <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none", display: "grid", gap: 2 }}>
          {value.reasons.map((reason) => (
            <li key={JSON.stringify(reason)}>
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ alignItems: "center", flexWrap: "wrap" }}
              >
                <Chip label={schedulingEffectLabels[reason.effect]} />
                <Typography variant="body2">{schedulingReasonLabels[reason.code]}</Typography>
                {reason.code === "retry_backoff" && (
                  <Typography variant="body2">
                    Retry eligible after <Time value={reason.until} />; this is not an estimated
                    start.
                  </Typography>
                )}
                {reason.code === "plan_prerequisite_missing" && reason.requirement && (
                  <Chip label={reason.requirement} />
                )}
              </Stack>
            </li>
          ))}
        </Box>
      ) : value.stage === "waiting" ? (
        <Typography variant="body2">
          {value.job !== null && "Waiting for a Worker claim. "}
          No blocking cause was observed. This observation does not reserve capacity or predict a
          start time.
        </Typography>
      ) : null}
      {value.reasonsTruncated && (
        <Typography variant="body2" color="text.secondary">
          Additional reasons were omitted from this observation.
        </Typography>
      )}
      {value.requirements.names.length > 0 && (
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap" }}
        >
          <Typography variant="body2" color="text.secondary">
            Required capabilities
          </Typography>
          {value.requirements.names.map((name) => (
            <Chip key={name} label={name} />
          ))}
        </Stack>
      )}
      {value.requirements.truncated && (
        <Typography variant="body2" color="text.secondary">
          Some requirement names could not be included.
        </Typography>
      )}
      <Typography variant="body2" color="text.secondary">
        Current scheduling observations are separate from frozen plan readiness. Current request
        requirements do not necessarily prevent an already queued execution from starting.
      </Typography>
    </Stack>
  );
}

function SchedulingSession({
  scope,
  session,
  refreshAccess,
  platformAdministrator,
}: {
  scope: SchedulingReadScope;
  session: string;
  refreshAccess: () => Promise<void>;
  platformAdministrator: boolean;
}) {
  const client = useQueryClient();
  const [accessLost, setAccessLost] = useState(false);
  const key = JSON.stringify([...schedulingScopeKey(scope), scheduling.mode, session]);
  const queryKey = useMemo(() => JSON.parse(key) as readonly string[], [key]);
  useEffect(() => {
    const discard = () => {
      void client.cancelQueries({ queryKey, exact: true });
      client.removeQueries({ queryKey, exact: true });
    };
    if (accessLost) discard();
    return discard;
  }, [client, queryKey, accessLost]);
  const query = useQuery({
    queryKey,
    enabled: !accessLost,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      signal.throwIfAborted();
      const value = await scheduling.get(scope, signal);
      signal.throwIfAborted();
      if (
        !schedulingMatchesScope(value, scope) ||
        (value.policy.platform.visibility === "full" && !platformAdministrator)
      )
        throw new Error("The scheduling observation belongs to another scope.");
      return value;
    },
    refetchInterval: (current) =>
      schedulingPollingInterval({
        visible: schedulingDocumentVisible() && !accessLost,
        connected: scheduling.mode === "connected",
        error: current.state.status === "error",
        stage: current.state.data?.stage,
      }),
  });
  useEffect(() => {
    if (schedulingAccessDenied(query.error)) setAccessLost(true);
  }, [query.error]);
  const unavailable = accessLost || schedulingAccessDenied(query.error);
  if (unavailable)
    return (
      <Alert
        severity="info"
        action={
          <Button color="inherit" onClick={() => void refreshAccess()}>
            Refresh access
          </Button>
        }
      >
        <AlertTitle>Scheduling access is unavailable</AlertTitle>
        Verify access before loading this observation again.
      </Alert>
    );
  const value =
    !query.isError &&
    query.data &&
    schedulingMatchesScope(query.data, scope) &&
    (query.data.policy.platform.visibility !== "full" || platformAdministrator)
      ? query.data
      : null;
  return (
    <Box component="section" aria-label="Current scheduling" sx={{ width: "100%" }}>
      <Stack spacing={2} sx={{ width: "100%" }}>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap" }}
        >
          <Typography variant="subtitle1" component="h3" sx={{ mr: "auto" }}>
            Current scheduling
          </Typography>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Refresh scheduling
          </Button>
        </Stack>
        {query.isError || (query.isSuccess && !value) ? (
          <Alert severity="warning">
            <AlertTitle>Current scheduling could not be loaded</AlertTitle>
            Refresh to try again. No previous observation is shown.
          </Alert>
        ) : query.isPending ? (
          <SchedulingSkeleton />
        ) : value ? (
          <SchedulingObservation value={value} />
        ) : null}
        <Typography variant="body2" color="text.secondary">
          Visible waiting and active observations refresh every 5 seconds.
        </Typography>
      </Stack>
    </Box>
  );
}

export function SchedulingDiagnostics({
  scope,
  visible = true,
}: {
  scope: SchedulingReadScope;
  visible?: boolean;
}) {
  const access = useOperatorAccess(scope.kind === "platform_job" ? undefined : scope.repositoryId);
  const { initialState } = useOperatorSession();
  const [documentVisible, setDocumentVisible] = useState(schedulingDocumentVisible);
  useEffect(() => {
    const changed = () => setDocumentVisible(schedulingDocumentVisible());
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", changed);
    return () => {
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", changed);
    };
  }, []);
  if (!visible || !documentVisible) return null;
  if (scheduling.mode === "sample")
    return (
      <Alert severity="info">
        <AlertTitle>Live scheduling is unavailable in Sample mode</AlertTitle>
        Sample data does not contain real scheduling observations. Connect to a server to inspect
        current waiting reasons.
      </Alert>
    );
  if (access.pending || access.checking) return <SchedulingSkeleton />;
  const allowed =
    access.ready &&
    !access.error &&
    access.principal &&
    (scope.kind === "platform_job" ? access.platformAdministrator : access.can("read"));
  if (!allowed)
    return (
      <Alert
        severity="info"
        action={
          <Button color="inherit" onClick={() => void access.refresh()}>
            Refresh access
          </Button>
        }
      >
        <AlertTitle>Scheduling access is unavailable</AlertTitle>
        {scope.kind === "platform_job"
          ? "Platform administrator access is required for this job observation."
          : "Repository read access is required for this observation."}
      </Alert>
    );
  const session = JSON.stringify([
    initialState?.authenticationEpoch ?? 0,
    access.identityKey,
    access.principal,
    access.context?.platformAdministrator,
    access.context?.repository,
  ]);
  return (
    <SchedulingSession
      key={JSON.stringify([...schedulingScopeKey(scope), scheduling.mode, session])}
      scope={scope}
      session={session}
      refreshAccess={access.refresh}
      platformAdministrator={access.platformAdministrator}
    />
  );
}
