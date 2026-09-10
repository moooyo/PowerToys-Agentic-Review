import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AlertTitle,
  Box,
  Button,
  Divider,
  List,
  ListItem,
  ListItemText,
  Skeleton,
  Stack,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { OperatorAccessGate, useOperatorAccess } from "@/components/OperatorAccess";
import { PageHeader } from "@/components/PageHeader";
import { PlatformSchedulingPolicy } from "@/components/SchedulingPolicy";
import { StatusTag } from "@/components/StatusTag";
import { DataTable, DetailsGrid } from "@/components/ui";
import {
  type HealthComponent,
  reviewControl,
  type SystemSnapshot,
} from "@/services/review-control";
import { useOperatorSession } from "@/state/session";
import "./index.css";

function ComponentHealth({ health }: { health: HealthComponent[] }) {
  const needsAttention = health.some((component) => component.status !== "healthy");

  return (
    <Box component="section" className="system-panel" aria-label="Component health">
      <Typography component="h2" variant="h6" sx={{ mb: 0.5 }}>
        Component health
      </Typography>
      <Typography color="text.secondary" variant="body2" sx={{ mb: 2 }}>
        The latest check from each control plane component.
      </Typography>
      {needsAttention && (
        <Alert className="system-health__notice" severity="warning">
          One or more components require attention. Review the details below.
        </Alert>
      )}
      <DataTable<HealthComponent>
        columns={[
          {
            id: "component",
            label: "Component",
            width: 176,
            render: (component) => component.name,
          },
          {
            id: "status",
            label: "Status",
            width: 112,
            render: (component) => <StatusTag status={component.status} />,
          },
          {
            id: "details",
            label: "Details",
            minWidth: 240,
            render: (component) => (
              <div>
                <span className="system-health__summary">{component.summary}</span>
                <Typography
                  className="system-health__checked"
                  color="text.secondary"
                  variant="body2"
                >
                  Last checked{" "}
                  <time dateTime={component.checkedAt}>
                    {new Date(component.checkedAt).toLocaleString()}
                  </time>
                </Typography>
              </div>
            ),
          },
        ]}
        rows={health}
        emptyTitle="No component health checks were returned."
        getRowId={(component) => component.id}
        ariaLabel="Component health"
      />
    </Box>
  );
}

function ProcessingActivity({ snapshot }: { snapshot: SystemSnapshot }) {
  const activity = [
    {
      label: "Active workers",
      value: snapshot.activeWorkers,
      description: "Online or draining",
    },
    {
      label: "Active leases",
      value: snapshot.activeLeases,
      description: "Leased or running attempts",
    },
    {
      label: "Awaiting admission",
      value: snapshot.awaitingAdmissionJobs,
      description: "Saved jobs waiting to enter the queue",
    },
    {
      label: "Queued jobs",
      value: snapshot.queuedJobs,
      description: "Admitted jobs waiting to start or retry",
    },
    {
      label: "Requests awaiting prerequisites",
      value: snapshot.pendingValidationRequests,
      description: "Pending validation requests with no job",
    },
  ];

  return (
    <Box component="section" className="system-panel" aria-label="Processing activity">
      <Typography component="h2" variant="h6" sx={{ mb: 0.5 }}>
        Processing activity
      </Typography>
      <Typography color="text.secondary" variant="body2" sx={{ mb: 2 }}>
        Current execution capacity.
      </Typography>
      <List disablePadding aria-label="Current execution capacity">
        {activity.map((item) => (
          <ListItem key={item.label} disableGutters divider>
            <ListItemText
              primary={item.label}
              secondary={item.description}
              slotProps={{
                primary: { variant: "body1", sx: { fontWeight: 500 } },
                secondary: { variant: "body2" },
              }}
            />
            <Typography variant="h6" sx={{ ml: 3, fontVariantNumeric: "tabular-nums" }}>
              {item.value}
            </Typography>
          </ListItem>
        ))}
      </List>
      <Divider sx={{ my: 2 }} />
      <DetailsGrid
        columns={1}
        items={[
          {
            key: "oldest-pending",
            label: "Oldest job awaiting admission",
            value: snapshot.oldestAwaitingAdmissionAt ? (
              <time dateTime={snapshot.oldestAwaitingAdmissionAt}>
                {new Date(snapshot.oldestAwaitingAdmissionAt).toLocaleString()}
              </time>
            ) : (
              "No jobs awaiting admission"
            ),
          },
          {
            key: "oldest-queued",
            label: "Oldest queued job",
            value: snapshot.oldestQueuedAt ? (
              <time dateTime={snapshot.oldestQueuedAt}>
                {new Date(snapshot.oldestQueuedAt).toLocaleString()}
              </time>
            ) : (
              "No queued jobs"
            ),
          },
        ]}
      />
      <Typography color="text.secondary" variant="body2" component="p" sx={{ mb: 0, mt: 2 }}>
        Creation time of the oldest job in each waiting group. Active and completed jobs are
        excluded.
      </Typography>
    </Box>
  );
}

function RuntimeDetails({ snapshot }: { snapshot: SystemSnapshot }) {
  return (
    <Accordion elevation={0} disableGutters sx={{ bgcolor: "background.paper" }}>
      <AccordionSummary
        expandIcon={<ExpandMoreIcon />}
        id="system-runtime-summary"
        aria-controls="system-runtime-details"
      >
        <Typography component="h2" variant="subtitle1" sx={{ fontWeight: 500 }}>
          Runtime details
        </Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Typography color="text.secondary" variant="body2" sx={{ mb: 2 }}>
          Versions and database storage
        </Typography>
        <DetailsGrid
          columns={3}
          items={[
            {
              key: "server-version",
              label: "Server version",
              value: <code>{snapshot.serverVersion}</code>,
            },
            {
              key: "protocol-version",
              label: "Protocol version",
              value: <code>{snapshot.protocolVersion}</code>,
            },
            {
              key: "node-version",
              label: "Node.js",
              value: <code>{snapshot.nodeVersion}</code>,
            },
            {
              key: "sqlite-version",
              label: "SQLite",
              value: <code>{snapshot.sqliteVersion}</code>,
            },
            {
              key: "database-size",
              label: "Database size",
              value: `${snapshot.databaseSizeMb.toFixed(1)} MiB`,
            },
          ]}
        />
      </AccordionDetails>
    </Accordion>
  );
}

export default function SystemPage() {
  return (
    <OperatorAccessGate platformOnly>
      <SystemContent />
    </OperatorAccessGate>
  );
}

function SystemContent() {
  const access = useOperatorAccess();
  const { initialState } = useOperatorSession();
  const snapshotQuery = useQuery({
    queryKey: ["system-snapshot", ...access.identityKey, initialState?.authenticationEpoch ?? 0],
    queryFn: async ({ signal }) => {
      signal.throwIfAborted();
      const result = await reviewControl.getSystemSnapshot();
      signal.throwIfAborted();
      return result;
    },
    enabled: access.platformAdministrator && !access.checking,
    gcTime: 0,
    refetchInterval: 30_000,
  });
  const snapshot =
    !snapshotQuery.isError && access.platformAdministrator && !access.checking
      ? snapshotQuery.data
      : undefined;

  return (
    <section aria-labelledby="system-page-title" className="system-page">
      <PageHeader
        eyebrow="Operations"
        title="System"
        titleId="system-page-title"
        description="Monitor component health and processing activity."
        actions={
          <div className="system-page__actions">
            <span className="system-page__refresh-note">Updates every 30 seconds</span>
            <Button
              startIcon={<RefreshIcon />}
              loading={snapshotQuery.isFetching}
              variant="outlined"
              onClick={() => snapshotQuery.refetch()}
            >
              Refresh
            </Button>
          </div>
        }
      />

      {snapshotQuery.isLoading && (
        <Stack className="system-panel" role="status" spacing={2}>
          <Typography color="text.secondary" variant="body1">
            Loading system snapshot...
          </Typography>
          <Stack spacing={1}>
            {["components", "status", "details", "activity", "runtime"].map((section) => (
              <Skeleton key={section} variant="rounded" height={48} />
            ))}
          </Stack>
        </Stack>
      )}
      {snapshotQuery.isError && (
        <Alert className="system-page__error" severity="error">
          <AlertTitle>System data is unavailable</AlertTitle>
          The control plane did not return a current system snapshot. Use Refresh to try again.
        </Alert>
      )}
      {snapshot && (
        <div className="system-page__content">
          <div className="system-page__overview">
            <ComponentHealth health={snapshot.health} />
            <ProcessingActivity snapshot={snapshot} />
          </div>
          <RuntimeDetails snapshot={snapshot} />
          {snapshotQuery.dataUpdatedAt > 0 && (
            <p className="system-page__last-refreshed">
              Last refreshed{" "}
              <time dateTime={new Date(snapshotQuery.dataUpdatedAt).toISOString()}>
                {new Date(snapshotQuery.dataUpdatedAt).toLocaleString()}
              </time>
            </p>
          )}
        </div>
      )}
      <div style={{ marginTop: 24 }}>
        <PlatformSchedulingPolicy />
      </div>
    </section>
  );
}
