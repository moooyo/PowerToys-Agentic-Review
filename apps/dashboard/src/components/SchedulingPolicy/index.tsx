import type {
  PlatformSchedulingStatus,
  SchedulingConfiguration,
  SchedulingConfigurationAuditSummary,
  SchedulingLimits,
  SchedulingOverage,
  SchedulingUsage,
} from "@agentic-review/contracts";
import { Close, ExpandMore, Refresh } from "@mui/icons-material";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  Divider,
  Drawer,
  IconButton,
  Pagination,
  Skeleton,
  Stack,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { DataTable, DetailsGrid } from "@/components/ui";
import { schedulingPolicy, schedulingPolicyQueryRoot } from "@/services/scheduling-policy";
import { useOperatorSession } from "@/state/session";
import { isConfigurationConflict } from "../../pages/Repositories/form";
import {
  buildSchedulingLimits,
  type SchedulingLimitValues,
  schedulingLimitsLabel,
  schedulingLimitValues,
} from "./form";
import { SchedulingLimitFields, SchedulingLimitFieldsProvider } from "./LimitFields";

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The scheduling request could not be completed. Try again.";
}

function Time({ value }: { value: string }) {
  return (
    <time dateTime={value} title={value}>
      {new Date(value).toLocaleString("en-US")}
    </time>
  );
}

function LoadingScheduling() {
  return (
    <Stack spacing={1} role="status" aria-label="Loading scheduling">
      <Typography variant="body2" color="text.secondary">
        Loading scheduling
      </Typography>
      <Skeleton variant="rounded" height={72} />
      <Skeleton />
    </Stack>
  );
}

export function SchedulingUsageSummary({
  usage,
  overage,
}: {
  usage: SchedulingUsage;
  overage?: SchedulingOverage;
}) {
  const counters = [
    { label: "Active leases", value: usage.activeLeases },
    { label: "Admitted queued jobs", value: usage.admittedQueuedJobs },
    { label: "Awaiting admission", value: usage.awaitingAdmissionJobs },
    { label: "Awaiting valid configuration", value: usage.awaitingConfigurationRequests },
  ];
  return (
    <Stack spacing={2}>
      <Box
        component="dl"
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", md: "repeat(4, minmax(0, 1fr))" },
          gap: 2,
          m: 0,
          p: 3,
          borderRadius: 3,
          bgcolor: "background.default",
        }}
      >
        {counters.map(({ label, value }) => (
          <Box key={label} aria-label={`${label}: ${value}`}>
            <Typography component="dt" variant="body2" color="text.secondary">
              {label}
            </Typography>
            <Typography
              component="dd"
              variant="h6"
              sx={{ m: 0, fontWeight: 400, fontVariantNumeric: "tabular-nums" }}
            >
              {value.toLocaleString("en-US")}
            </Typography>
          </Box>
        ))}
      </Box>
      <Typography variant="body2" color="text.secondary">
        Active leases count leased and running attempts. The admitted queue includes jobs waiting to
        start or retry. Jobs awaiting admission have a saved Job ID. Requests awaiting valid
        configuration have no job yet.
      </Typography>
      {overage && (overage.activeLeases > 0 || overage.admittedQueuedJobs > 0) && (
        <Alert severity="warning">
          <AlertTitle>Usage exceeds a configured limit</AlertTitle>
          {overage.activeLeases.toLocaleString("en-US")} active leases and{" "}
          {overage.admittedQueuedJobs.toLocaleString("en-US")} admitted queued jobs above their
          limits. Existing work is retained; new grants or admission wait for capacity.
        </Alert>
      )}
    </Stack>
  );
}

function Limits({ limits }: { limits: SchedulingLimits }) {
  return (
    <DetailsGrid
      columns={2}
      items={[
        {
          key: "active",
          label: "Active lease limit",
          value: schedulingLimitsLabel(limits.maxActiveLeases),
        },
        {
          key: "queue",
          label: "Admitted queue limit",
          value: schedulingLimitsLabel(limits.maxQueuedJobs),
        },
      ]}
    />
  );
}

function useClearSchedulingSession(session: string) {
  const client = useQueryClient();
  useEffect(
    () => () => {
      const queryKey = [...schedulingPolicyQueryRoot, session];
      void client.cancelQueries({ queryKey });
      client.removeQueries({ queryKey });
    },
    [client, session],
  );
}

function SchedulingAccess({
  repositoryId,
  children,
}: {
  repositoryId?: string;
  children: (session: string, checking: boolean) => ReactNode;
}) {
  const access = useOperatorAccess(repositoryId);
  const { initialState } = useOperatorSession();
  const allowed =
    access.ready &&
    !access.error &&
    (repositoryId ? access.allows("read") : access.platformAdministrator);
  const session = JSON.stringify([
    schedulingPolicy.mode,
    repositoryId ?? "platform",
    access.identityKey,
    initialState?.authenticationEpoch ?? 0,
    access.context?.platformAdministrator,
    access.context?.repository,
  ]);
  if (access.pending) return <LoadingScheduling />;
  if (!allowed)
    return (
      <Alert
        severity="info"
        action={<Button onClick={() => void access.refresh()}>Refresh access</Button>}
      >
        <AlertTitle>Scheduling information is unavailable</AlertTitle>
        {repositoryId
          ? "Verify repository read access to inspect current scheduling."
          : "Platform administrator access is required to inspect global scheduling policy and history."}
      </Alert>
    );
  return <div key={session}>{children(session, access.checking)}</div>;
}

function RepositorySchedulingSession({
  repositoryId,
  session,
  checking,
}: {
  repositoryId: string;
  session: string;
  checking: boolean;
}) {
  useClearSchedulingSession(session);
  const access = useOperatorAccess(repositoryId);
  const query = useQuery({
    queryKey: [...schedulingPolicyQueryRoot, session, "repository", repositoryId],
    queryFn: async ({ signal }) => {
      const result = await schedulingPolicy.repository(repositoryId, signal);
      if (!access.platformAdministrator && result.platform.visibility !== "restricted")
        throw new Error("Global scheduling details exceeded the current operator's scope.");
      return result;
    },
    enabled: !checking,
    refetchInterval: 5_000,
    retry: false,
    gcTime: 0,
  });
  const value = !checking && !query.isError ? query.data : undefined;
  return (
    <Card elevation={0}>
      <CardHeader
        title="Current scheduling"
        action={
          <Button
            size="medium"
            startIcon={<Refresh />}
            loading={query.isFetching || checking}
            disabled={checking}
            onClick={() => void query.refetch()}
          >
            Refresh
          </Button>
        }
      />
      <CardContent>
        {query.isError ? (
          <Alert severity="error">
            <AlertTitle>Could not load current scheduling</AlertTitle>
            {errorMessage(query.error)}
          </Alert>
        ) : !value ? (
          <LoadingScheduling />
        ) : (
          <Stack spacing={2}>
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{ flexWrap: "wrap", alignItems: "center" }}
            >
              <Chip
                size="medium"
                color={value.enabled ? "success" : "warning"}
                label={value.enabled ? "Repository enabled" : "Repository paused"}
              />
              <Typography variant="body2" color="text.secondary">
                Observed <Time value={value.observedAt} /> · Updates every 5 seconds
              </Typography>
            </Stack>
            <Limits limits={value.limits} />
            <SchedulingUsageSummary usage={value.usage} overage={value.overage} />
            {value.platform.visibility === "restricted" ? (
              <Alert severity="info">
                <AlertTitle>Global capacity details are restricted</AlertTitle>
                Global active capacity:{" "}
                {value.platform.activeCapacity === "limited"
                  ? "at its limit"
                  : "quota headroom available"}
                . Global queue capacity:{" "}
                {value.platform.queueCapacity === "limited"
                  ? "at its limit"
                  : "quota headroom available"}
                . Global counts and limits require platform administrator access. Restricted details
                do not mean unlimited capacity.
              </Alert>
            ) : (
              <Stack spacing={1}>
                <Typography variant="subtitle1">Global limits</Typography>
                <Limits limits={value.platform.configuration.limits} />
              </Stack>
            )}
            <Typography variant="body2" color="text.secondary">
              Unlimited removes only this scope's additional limit. Global limits and Worker
              constraints still apply. Capacity observations do not reserve a slot or estimate a
              start time.
            </Typography>
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

export function RepositorySchedulingPolicy({ repositoryId }: { repositoryId: string }) {
  return (
    <SchedulingAccess repositoryId={repositoryId}>
      {(session, checking) => (
        <RepositorySchedulingSession
          key={session}
          repositoryId={repositoryId}
          session={session}
          checking={checking}
        />
      )}
    </SchedulingAccess>
  );
}

function SchedulingEvent({
  summary,
  session,
  onClose,
}: {
  summary: SchedulingConfigurationAuditSummary;
  session: string;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: [...schedulingPolicyQueryRoot, session, "event", summary.id],
    queryFn: async ({ signal }) => {
      const event = await schedulingPolicy.event(summary.id, signal);
      if (
        event.version !== summary.version ||
        event.previousVersion !== summary.previousVersion ||
        event.createdAt !== summary.createdAt ||
        event.actor.issuer !== summary.actor.issuer ||
        event.actor.subject !== summary.actor.subject
      )
        throw new Error("The scheduling event does not match the selected audit summary.");
      return event;
    },
    retry: false,
    gcTime: 0,
  });
  const event = !query.isError ? query.data : undefined;
  return (
    <Drawer
      open
      anchor="right"
      onClose={onClose}
      slotProps={{ paper: { sx: { width: { xs: "100%", sm: 680 }, maxWidth: "100%" } } }}
    >
      <Stack direction="row" sx={{ p: 2.5, alignItems: "center", justifyContent: "space-between" }}>
        <Typography variant="h6">Scheduling configuration event</Typography>
        <IconButton aria-label="Close scheduling event" onClick={onClose}>
          <Close />
        </IconButton>
      </Stack>
      <Divider />
      <Box sx={{ p: { xs: 2, sm: 3 } }}>
        {query.isError ? (
          <Alert
            severity="error"
            action={<Button onClick={() => void query.refetch()}>Try again</Button>}
          >
            <AlertTitle>Could not load scheduling event</AlertTitle>
            {errorMessage(query.error)}
          </Alert>
        ) : !event ? (
          <LoadingScheduling />
        ) : (
          <Stack spacing={2}>
            <DetailsGrid
              columns={1}
              items={[
                { key: "time", label: "Recorded at", value: <Time value={event.createdAt} /> },
                {
                  key: "actor",
                  label: "Actor",
                  value: (
                    <>
                      <Typography variant="body2">{event.actor.subject}</Typography>
                      <Typography variant="body2" color="text.secondary">
                        {event.actor.issuer}
                      </Typography>
                    </>
                  ),
                },
                {
                  key: "revision",
                  label: "Version",
                  value: `${event.previousVersion} → ${event.version}`,
                },
                { key: "policy", label: "Service policy", value: event.snapshot.policyId },
              ]}
            />
            <Divider />
            <Typography variant="subtitle1">Previous recorded limits</Typography>
            <Limits limits={event.previousSnapshot.limits} />
            <Typography variant="subtitle1">Saved limits</Typography>
            <Limits limits={event.snapshot.limits} />
            <Typography variant="body2" color="text.secondary">
              These are immutable configuration snapshots from this operation. Current usage is not
              historical usage.
            </Typography>
          </Stack>
        )}
      </Box>
    </Drawer>
  );
}

function SchedulingActivity({ session, checking }: { session: string; checking: boolean }) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<SchedulingConfigurationAuditSummary | null>(null);
  const query = useQuery({
    queryKey: [...schedulingPolicyQueryRoot, session, "activity", page],
    queryFn: ({ signal }) => schedulingPolicy.activity({ page, pageSize: 20 }, signal),
    enabled: !checking,
    retry: false,
    gcTime: 0,
  });
  const result = !query.isError && !checking ? query.data : undefined;
  return (
    <Card elevation={0}>
      <CardHeader
        title="Scheduling configuration activity"
        action={
          <Button
            size="medium"
            startIcon={<Refresh />}
            disabled={checking}
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Refresh
          </Button>
        }
      />
      <CardContent>
        {query.isError ? (
          <Alert severity="error">
            <AlertTitle>Could not load scheduling activity</AlertTitle>
            {errorMessage(query.error)}
          </Alert>
        ) : !result ? (
          <LoadingScheduling />
        ) : (
          <Stack spacing={2}>
            <DataTable<SchedulingConfigurationAuditSummary>
              getRowId={(item) => item.id}
              rows={result.items}
              ariaLabel="Scheduling configuration activity"
              emptyTitle="No scheduling configuration changes have been recorded."
              columns={[
                {
                  id: "time",
                  label: "Recorded at",
                  render: (item) => <Time value={item.createdAt} />,
                },
                { id: "actor", label: "Actor", render: (item) => item.actor.subject },
                {
                  id: "version",
                  label: "Version",
                  render: (item) => `${item.previousVersion} → ${item.version}`,
                },
                {
                  id: "details",
                  label: "Details",
                  render: (item) => (
                    <Button size="medium" onClick={() => setSelected(item)}>
                      View event
                    </Button>
                  ),
                },
              ]}
            />
            {result.total > 20 && (
              <Pagination
                page={page}
                count={Math.ceil(result.total / 20)}
                onChange={(_, value) => setPage(value)}
              />
            )}
          </Stack>
        )}
        {selected && !checking && (
          <SchedulingEvent
            key={selected.id}
            summary={selected}
            session={session}
            onClose={() => setSelected(null)}
          />
        )}
      </CardContent>
    </Card>
  );
}

function PlatformSchedulingSession({ session, checking }: { session: string; checking: boolean }) {
  useClearSchedulingSession(session);
  const client = useQueryClient();
  const [values, setValues] = useState<SchedulingLimitValues>(() =>
    schedulingLimitValues({ maxActiveLeases: null, maxQueuedJobs: null }),
  );
  const [baseline, setBaseline] = useState<SchedulingConfiguration | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const query = useQuery({
    queryKey: [...schedulingPolicyQueryRoot, session, "platform"],
    queryFn: ({ signal }) => schedulingPolicy.platform(signal),
    enabled: !checking,
    refetchInterval: 5_000,
    retry: false,
    gcTime: 0,
  });
  useEffect(() => {
    if (!baseline && query.data) {
      setBaseline(query.data.configuration);
      setValues(schedulingLimitValues(query.data.configuration.limits));
    }
  }, [baseline, query.data]);
  const reload = async () => {
    try {
      const result = await query.refetch({ throwOnError: true });
      if (!result.data) return;
      setBaseline(result.data.configuration);
      setValues(schedulingLimitValues(result.data.configuration.limits));
      setDirty(false);
      setConflict(false);
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };
  const save = async () => {
    if (!baseline || !dirty || saving || checking || conflict) return;
    setSaving(true);
    setError(null);
    try {
      const configuration = await schedulingPolicy.update({
        expectedVersion: baseline.version,
        limits: buildSchedulingLimits(values),
      });
      setBaseline(configuration);
      setValues(schedulingLimitValues(configuration.limits));
      setDirty(false);
      await client.invalidateQueries({ queryKey: schedulingPolicyQueryRoot });
      await client.invalidateQueries({ queryKey: ["scheduling-diagnostics"] });
    } catch (failure) {
      setError(errorMessage(failure));
      setConflict(isConfigurationConflict(failure));
    } finally {
      setSaving(false);
    }
  };
  const value: PlatformSchedulingStatus | undefined =
    !checking && !query.isError ? query.data : undefined;
  return (
    <Stack spacing={3}>
      <Card elevation={0}>
        <CardHeader
          title="Global scheduling"
          action={
            <Button
              startIcon={<Refresh />}
              loading={query.isFetching}
              disabled={checking || saving}
              onClick={() => void query.refetch()}
            >
              Refresh usage
            </Button>
          }
        />
        <CardContent>
          <Stack spacing={2.5}>
            {schedulingPolicy.mode === "sample" && (
              <Alert severity="info">
                <AlertTitle>Sample scheduling data</AlertTitle>
                This preview has fixed usage and isolated configuration history. Changes affect the
                preview only.
              </Alert>
            )}
            {query.isError ? (
              <Alert severity="error">
                <AlertTitle>Could not load global scheduling</AlertTitle>
                {errorMessage(query.error)}
              </Alert>
            ) : !value ? (
              <LoadingScheduling />
            ) : (
              <>
                <Typography variant="body2" color="text.secondary">
                  Observed <Time value={value.observedAt} /> · Updates every 5 seconds
                </Typography>
                <Limits limits={value.configuration.limits} />
                <SchedulingUsageSummary usage={value.usage} overage={value.overage} />
                <Divider />
                <Typography variant="subtitle1">Unscoped usage</Typography>
                <Typography variant="body2" color="text.secondary">
                  Work whose repository identity is unresolved still consumes global capacity.
                </Typography>
                <SchedulingUsageSummary usage={value.unscopedUsage} />
              </>
            )}
            <Divider />
            <Typography variant="h6">Global limits</Typography>
            {baseline && (
              <Stack
                component="form"
                spacing={3}
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                <SchedulingLimitFieldsProvider
                  values={values}
                  disabled={saving || checking}
                  onChange={(next) => {
                    setValues(next);
                    setDirty(true);
                  }}
                >
                  <SchedulingLimitFields />
                </SchedulingLimitFieldsProvider>
                {error && (
                  <Alert severity="error">
                    <AlertTitle>
                      {conflict
                        ? "Scheduling configuration changed"
                        : "Could not save scheduling configuration"}
                    </AlertTitle>
                    {conflict
                      ? "Your edits are retained. Reload the latest settings before applying your changes again."
                      : error}
                  </Alert>
                )}
                {baseline.version !== query.data?.configuration.version && query.data && (
                  <Alert severity="warning">
                    <AlertTitle>Newer settings are available</AlertTitle>
                    The current limits changed after this form was opened. Your edits have been
                    retained.
                  </Alert>
                )}
                <Stack
                  direction="row"
                  spacing={1}
                  useFlexGap
                  sx={{
                    p: 2,
                    bgcolor: "background.default",
                    borderRadius: 3,
                    flexWrap: "wrap",
                    alignItems: "center",
                    justifyContent: "flex-end",
                  }}
                >
                  {dirty && (
                    <Typography variant="body2" color="text.secondary" sx={{ mr: "auto" }}>
                      Unsaved changes
                    </Typography>
                  )}
                  <Button disabled={saving || checking} onClick={() => void reload()}>
                    Reload latest settings
                  </Button>
                  <Button
                    variant="contained"
                    type="submit"
                    loading={saving}
                    disabled={!dirty || conflict || checking}
                  >
                    Save global limits
                  </Button>
                </Stack>
              </Stack>
            )}
            <Divider />
            <Accordion
              disableGutters
              elevation={0}
              sx={{ bgcolor: "transparent", "&:before": { display: "none" } }}
            >
              <AccordionSummary
                expandIcon={<ExpandMore />}
                aria-controls="scheduling-service-policy-content"
                id="scheduling-service-policy-heading"
                sx={{ px: 0 }}
              >
                <Typography variant="subtitle1">Service policy</Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ px: 0 }}>
                <Stack spacing={2}>
                  <Typography variant="body2">
                    Repositories share admission and Worker claims by successful service. Pull
                    request and Issue work use a 2:1 service ratio when both are eligible. Priority
                    gives a bounded preference; older eligible work continues to progress. Admission
                    and claim ordering are independent.
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Policy: repository-service-v1. Eligibility depends on current authorization,
                    repository state, compatible Workers, backoff and capacity. These settings do
                    not reserve capacity or predict an execution start.
                  </Typography>
                </Stack>
              </AccordionDetails>
            </Accordion>
          </Stack>
        </CardContent>
      </Card>
      <SchedulingActivity session={session} checking={checking} />
    </Stack>
  );
}

export function PlatformSchedulingPolicy() {
  return (
    <SchedulingAccess>
      {(session, checking) => (
        <PlatformSchedulingSession key={session} session={session} checking={checking} />
      )}
    </SchedulingAccess>
  );
}
