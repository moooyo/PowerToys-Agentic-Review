import type {
  RepositoryPublicationPolicy as Policy,
  RepositoryPublicationPolicyAuditEvent,
  RepositoryPublicationPolicyUpdateRequest,
} from "@agentic-review/contracts";
import {
  Alert,
  AlertTitle,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Pagination,
  Skeleton,
  Stack,
  Switch,
  Tab,
  Tabs,
  Typography,
} from "@mui/material";
import { Value } from "@sinclair/typebox/value";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { useOperatorAccess } from "@/components/OperatorAccess";
import {
  PublicationAccess,
  publicationAccessDenied,
  publicationError,
  usePublicationReadGuard,
} from "@/components/PublicationPreview/access";
import { DataTable, DetailsGrid } from "@/components/ui";
import { publicationQueryRoot, publications } from "@/services/publications";

function PolicyEvent({
  repositoryId,
  selected,
  session,
  refreshAccess,
  onClose,
  onAccessDenied,
}: {
  repositoryId: string;
  selected: RepositoryPublicationPolicyAuditEvent;
  session: string;
  refreshAccess: () => Promise<void>;
  onClose: () => void;
  onAccessDenied: (error: unknown) => void;
}) {
  const query = useQuery({
    queryKey: [...publicationQueryRoot, session, "policy-event", selected.id],
    queryFn: async ({ signal }) => {
      const event = await publications.policyEvent(repositoryId, selected.id, signal);
      if (!Value.Equal(event, selected))
        throw new Error("The policy event differs from the selected immutable record.");
      return event;
    },
    retry: false,
    gcTime: 0,
  });
  useEffect(() => {
    if (publicationAccessDenied(query.error)) onAccessDenied(query.error);
  }, [query.error, onAccessDenied]);
  const event = !query.isError ? query.data : undefined;
  return (
    <Dialog
      open
      fullWidth
      maxWidth="sm"
      onClose={onClose}
      aria-labelledby="publication-policy-event-title"
    >
      <DialogTitle id="publication-policy-event-title">Publication policy event</DialogTitle>
      <DialogContent>
        {query.isError ? (
          <Alert severity="error">
            <AlertTitle>Could not load policy event</AlertTitle>
            {publicationError(query.error)}
          </Alert>
        ) : !event ? (
          <Skeleton variant="rounded" height={180} />
        ) : (
          <DetailsGrid
            columns={1}
            items={[
              { key: "id", label: "Event ID", value: <code>{event.id}</code> },
              { key: "time", label: "Recorded at", value: event.createdAt },
              {
                key: "actor",
                label: "Actor",
                value: `${event.actor.subject} · ${event.actor.issuer}`,
              },
              {
                key: "versions",
                label: "Version",
                value: `${event.previousVersion} → ${event.version}`,
              },
              {
                key: "previous",
                label: "Previous policy",
                value: event.previousSnapshot.enabled ? "Enabled" : "Disabled",
              },
              {
                key: "new",
                label: "Saved policy",
                value: event.snapshot.enabled ? "Enabled" : "Disabled",
              },
            ]}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => void refreshAccess()}>Refresh access</Button>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
function PolicySession({
  repositoryId,
  session,
  access,
}: {
  repositoryId: string;
  session: string;
  access: ReturnType<typeof useOperatorAccess>;
}) {
  const client = useQueryClient();
  const [baseline, setBaseline] = useState<Policy | null>(null),
    [enabled, setEnabled] = useState(false),
    [saving, setSaving] = useState(false),
    [failure, setFailure] = useState<unknown>(null),
    [request, setRequest] = useState<RepositoryPublicationPolicyUpdateRequest | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<RepositoryPublicationPolicyAuditEvent | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const policyKey = [...publicationQueryRoot, session, "policy", repositoryId];
  const historyKey = [...publicationQueryRoot, session, "policy-history", repositoryId];
  const eventKey = [...publicationQueryRoot, session, "policy-event"];
  const read = usePublicationReadGuard([policyKey, historyKey, eventKey]);
  const query = useQuery({
    queryKey: policyKey,
    queryFn: ({ signal }) => read.guard.read(() => publications.policy(repositoryId, signal)),
    enabled: !read.denied && !access.checking,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const history = useQuery({
    queryKey: [...historyKey, page],
    queryFn: ({ signal }) =>
      read.guard.read(() =>
        publications.policyActivity({ repositoryId, page, pageSize: 20 }, signal),
      ),
    enabled: historyOpen && !read.denied && !access.checking,
    retry: false,
    gcTime: 0,
  });
  const denied =
    read.denied ||
    publicationAccessDenied(query.error) ||
    publicationAccessDenied(history.error) ||
    publicationAccessDenied(failure);
  useEffect(() => {
    if (!denied && !baseline && query.data) {
      setBaseline(query.data);
      setEnabled(query.data.enabled);
    }
  }, [baseline, query.data, denied]);
  const dirty = baseline !== null && enabled !== baseline.enabled;
  const conflict =
    typeof failure === "object" &&
    failure !== null &&
    "status" in failure &&
    failure.status === 409;
  const reload = async () => {
    if (inFlight.current || denied) return;
    setFailure(null);
    setRequest(null);
    setNotice(null);
    const result = await query.refetch();
    if (result.data && !result.isError) {
      setBaseline(result.data);
      setEnabled(result.data.enabled);
    }
  };
  const save = async () => {
    if (
      !baseline ||
      read.guard.snapshot() ||
      !dirty ||
      conflict ||
      !access.can("configure") ||
      inFlight.current
    )
      return;
    inFlight.current = true;
    setSaving(true);
    setFailure(null);
    try {
      const input = request ?? {
        changeId: crypto.randomUUID(),
        expectedVersion: baseline.version,
        enabled,
      };
      setRequest(input);
      const result = await publications.updatePolicy(repositoryId, input);
      if (!mounted.current || read.guard.snapshot()) return;
      if (
        result.change.actor.issuer !== access.principal?.issuer ||
        result.change.actor.subject !== access.principal?.subject
      )
        throw new Error("The policy receipt does not match this operator.");
      setBaseline(result.change.snapshot);
      setEnabled(result.change.snapshot.enabled);
      setRequest(null);
      setNotice(
        result.replayed ? "Original policy change recovered." : "Publication policy saved.",
      );
      await client.invalidateQueries({ queryKey: publicationQueryRoot });
    } catch (error) {
      if (!mounted.current) return;
      read.guard.deny(error);
      setFailure(error);
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  if (access.checking) return <Skeleton variant="rounded" height={120} />;
  if (denied)
    return (
      <Alert
        severity="info"
        action={<Button onClick={() => void access.refresh()}>Refresh access</Button>}
      >
        <AlertTitle>Publication policy access is unavailable</AlertTitle>
        Previous policy content has been cleared.
      </Alert>
    );
  return (
    <Stack component="section" spacing={3} aria-label="Publication policy">
      <Stack
        direction="row"
        sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 2 }}
      >
        <Typography variant="h6" component="h2">
          Publication policy
        </Typography>
        <Button disabled={saving} onClick={() => void access.refresh()}>
          Refresh access
        </Button>
      </Stack>
      <Tabs
        value={historyOpen ? "history" : "settings"}
        onChange={(_event, value) => setHistoryOpen(value === "history")}
        aria-label="Publication policy sections"
        sx={{ borderBottom: 1, borderColor: "divider" }}
      >
        <Tab
          value="settings"
          label="Policy settings"
          id="publication-policy-settings-tab"
          aria-controls="publication-policy-settings"
        />
        <Tab
          value="history"
          label="Change history"
          id="publication-policy-history-tab"
          aria-controls="publication-policy-history"
        />
      </Tabs>
      <div
        role="tabpanel"
        id="publication-policy-settings"
        aria-labelledby="publication-policy-settings-tab"
        hidden={historyOpen}
      >
        {query.isError ? (
          <Alert severity="error" action={<Button onClick={() => void reload()}>Try again</Button>}>
            <AlertTitle>Could not load publication policy</AlertTitle>
            {publicationError(query.error)}
          </Alert>
        ) : !baseline ? (
          <Skeleton variant="rounded" height={120} />
        ) : (
          <Stack spacing={2}>
            <Stack
              direction="row"
              useFlexGap
              sx={{ flexWrap: "wrap", alignItems: "center", gap: 2 }}
            >
              <Chip
                size="medium"
                color={baseline.enabled ? "success" : "default"}
                label={baseline.enabled ? "Publication enabled" : "Publication disabled"}
              />
              <Typography variant="body2" color="text.secondary">
                Policy version {baseline.version}
                {baseline.version === 0 ? " · Not configured" : ""}
              </Typography>
            </Stack>
            <Typography>
              Publication is disabled by default. Enabling this policy permits separately confirmed
              PR reviews and Issue comments. Recording a decision never sends to GitHub. A separate
              runtime publisher credential is also required; the ingestion credential is not used.
            </Typography>
            <FormControlLabel
              label="Enable repository publication"
              control={
                <Switch
                  checked={enabled}
                  disabled={saving || !access.can("configure")}
                  onChange={(_event, value) => {
                    setEnabled(value);
                    setRequest(null);
                    setFailure(null);
                    setNotice(null);
                  }}
                />
              }
            />
            {!access.allows("configure") && (
              <Typography color="text.secondary">
                Maintainer access or higher is required to change this policy.
              </Typography>
            )}
            {!!failure && (
              <Alert severity="error">
                <AlertTitle>
                  {conflict ? "Publication policy changed" : "Could not save publication policy"}
                </AlertTitle>
                {conflict
                  ? "Your selection is retained. Reload the latest policy before applying it again."
                  : publicationError(failure)}
              </Alert>
            )}
            {notice && <Alert severity="success">{notice}</Alert>}
            <Stack
              direction="row"
              useFlexGap
              sx={{ flexWrap: "wrap", alignItems: "center", gap: 1 }}
            >
              <Button
                variant="contained"
                loading={saving}
                disabled={!dirty || conflict || !access.can("configure")}
                onClick={() => void save()}
              >
                {request && failure && !conflict
                  ? "Retry original policy save"
                  : "Save publication policy"}
              </Button>
              <Button disabled={saving} onClick={() => void reload()}>
                Reload latest policy
              </Button>
              {dirty && <Typography color="text.secondary">Unsaved changes</Typography>}
            </Stack>
          </Stack>
        )}
      </div>
      <div
        role="tabpanel"
        id="publication-policy-history"
        aria-labelledby="publication-policy-history-tab"
        hidden={!historyOpen}
      >
        {history.isError ? (
          <Alert severity="error">
            <AlertTitle>Could not load policy history</AlertTitle>
            {publicationError(history.error)}
          </Alert>
        ) : !history.data ? (
          <Skeleton variant="rounded" height={100} />
        ) : (
          <>
            <DataTable<RepositoryPublicationPolicyAuditEvent>
              ariaLabel="Publication policy history"
              rows={history.data.items}
              getRowId={(event) => event.id}
              emptyTitle="No publication policy changes have been recorded."
              columns={[
                { id: "time", label: "Recorded at", render: (event) => event.createdAt },
                {
                  id: "version",
                  label: "Version",
                  render: (event) => `${event.previousVersion} → ${event.version}`,
                },
                {
                  id: "policy",
                  label: "Saved policy",
                  render: (event) => (event.snapshot.enabled ? "Enabled" : "Disabled"),
                },
                {
                  id: "action",
                  label: "Details",
                  render: (event) => (
                    <Button
                      aria-label={`Inspect publication policy event ${event.id}`}
                      onClick={() => setSelected(event)}
                    >
                      Inspect
                    </Button>
                  ),
                },
              ]}
            />
            {history.data.total > 20 && (
              <Pagination
                aria-label="Policy history pages"
                page={page}
                count={Math.ceil(history.data.total / 20)}
                onChange={(_event, value) => {
                  setPage(value);
                  setSelected(null);
                }}
                sx={{ mt: 2 }}
              />
            )}
          </>
        )}
      </div>
      {selected && (
        <PolicyEvent
          key={selected.id}
          repositoryId={repositoryId}
          selected={selected}
          session={session}
          refreshAccess={access.refresh}
          onClose={() => setSelected(null)}
          onAccessDenied={(error) => {
            read.guard.deny(error);
            setFailure(error);
          }}
        />
      )}
    </Stack>
  );
}
export function PublicationPolicy({ repositoryId }: { repositoryId: string }) {
  return (
    <PublicationAccess repositoryId={repositoryId}>
      {(session, access) => (
        <PolicySession
          key={session}
          repositoryId={repositoryId}
          session={session}
          access={access}
        />
      )}
    </PublicationAccess>
  );
}
