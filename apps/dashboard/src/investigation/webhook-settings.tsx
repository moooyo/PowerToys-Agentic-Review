import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { investigationApi, type Repository, type RepositoryWebhookSettings } from "./api";
import { useGuardedAction, useUnsavedChanges } from "./navigation-guard";
import { useInvestigationSession } from "./session";
import { InvestigationHttpError } from "./transport";
import {
  submitWebhookSettings,
  type WebhookSettingsFormValues,
  webhookSettingsFieldErrors,
  webhookSettingsFormValues,
} from "./webhook-settings-form";

export const webhookSettingsQueryKey = (repositoryId: string) => [
  "investigation-webhook-settings",
  repositoryId,
];

export function WebhookSettingsConflictNotice() {
  return (
    <Alert severity="warning">
      These settings changed elsewhere. Your draft is still in this form. Reload saved settings to
      replace the draft with the latest version, then make your changes again.
    </Alert>
  );
}

export function WebhookSettingsForm({
  repository,
  settings,
  canManage,
}: {
  repository: Repository;
  settings: RepositoryWebhookSettings;
  canManage: boolean;
}) {
  const receiverDetailsId = useId();
  const queryClient = useQueryClient();
  const guardedAction = useGuardedAction();
  const [saved, setSaved] = useState(settings);
  const [form, setForm] = useState(() => webhookSettingsFormValues(settings));
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<ReturnType<typeof webhookSettingsFieldErrors>>({});
  const reviewerRef = useRef<HTMLInputElement>(null);
  const actorsRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const dirty = JSON.stringify(form) !== JSON.stringify(webhookSettingsFormValues(saved));
  useUnsavedChanges(dirty, { busy, description: "Event intake has unsaved changes." });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (settings.version <= saved.version || busy) return;
    if (dirty) setConflict(true);
    else {
      setSaved(settings);
      setForm(webhookSettingsFormValues(settings));
      setConflict(false);
    }
  }, [settings, saved.version, busy, dirty]);
  const patch = (values: Partial<WebhookSettingsFormValues>) => {
    const next = { ...form, ...values };
    setForm(next);
    setMessage(undefined);
    if (Object.keys(fieldErrors).length) setFieldErrors(webhookSettingsFieldErrors(next));
  };
  const acceptSettings = (value: RepositoryWebhookSettings) => {
    if (!alive.current) return;
    setSaved(value);
    setForm(webhookSettingsFormValues(value));
    setConflict(false);
    setFieldErrors({});
    queryClient.setQueryData(webhookSettingsQueryKey(repository.id), value);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!canManage || busy || conflict) return;
    const errors = webhookSettingsFieldErrors(form);
    setFieldErrors(errors);
    if (Object.keys(errors).length) {
      (errors.reviewerUserIdText ? reviewerRef : actorsRef).current?.focus();
      return;
    }
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await queryClient.cancelQueries({ queryKey: webhookSettingsQueryKey(repository.id) });
      if (!alive.current) return;
      const updated = await submitWebhookSettings(
        repository.id,
        form,
        saved,
        conflict,
        investigationApi.updateRepositoryWebhookSettings,
      );
      await queryClient.cancelQueries({ queryKey: webhookSettingsQueryKey(repository.id) });
      if (!alive.current) return;
      acceptSettings(updated);
      setMessage("Assignment webhook settings saved.");
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof InvestigationHttpError && cause.status === 409) setConflict(true);
      setError(cause instanceof Error ? cause.message : "Webhook settings could not be saved.");
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const reload = async () => {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await queryClient.cancelQueries({ queryKey: webhookSettingsQueryKey(repository.id) });
      if (!alive.current) return;
      const latest = await investigationApi.repositoryWebhookSettings(repository.id);
      await queryClient.cancelQueries({ queryKey: webhookSettingsQueryKey(repository.id) });
      if (!alive.current) return;
      if (latest.version < saved.version)
        throw new Error(
          "The server returned older settings. Your current settings and draft are kept. Try reloading again.",
        );
      acceptSettings(latest);
      setMessage("The latest saved settings have been loaded.");
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : "Webhook settings could not be loaded.");
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const reset = () => {
    setForm(webhookSettingsFormValues(saved));
    setFieldErrors({});
    setError(undefined);
    setMessage(undefined);
  };
  const downloadDraft = () => {
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            { repositoryId: repository.id, baseVersion: saved.version, draft: form },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "repository-intake-draft.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Box
      component="form"
      className="repository-form"
      onSubmit={(event) => void save(event)}
      noValidate
    >
      <Stack spacing={3}>
        <Box>
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ alignItems: "center", flexWrap: "wrap" }}
          >
            <Typography variant="h6" component="h2">
              Event intake
            </Typography>
            <Chip
              size="small"
              variant="outlined"
              label={saved.enabled ? "Saved: Enabled" : "Saved: Disabled"}
            />
            {dirty && <Chip size="small" color="warning" label="Unsaved changes" />}
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Create a PR review or Issue investigation when a trusted user assigns an item in{" "}
            {repository.fullName} to the configured GitHub account. Each task keeps its own source
            and discussion snapshot.
          </Typography>
        </Box>
        {!saved.receiverConfigured && (
          <Alert severity="info">
            The server webhook receiver is not configured yet. You can save this repository's
            settings now; an administrator must configure the receiver before events can be
            accepted.
          </Alert>
        )}
        {process.env.NODE_ENV === "development" && (
          <Alert severity="info">
            Sample mode: these settings only change isolated sample data.
          </Alert>
        )}
        <Box className="repository-form-width">
          <Typography variant="subtitle1" component="h3">
            Assignment intake
          </Typography>
          <FormControlLabel
            label="Listen for assignments"
            labelPlacement="start"
            control={
              <Switch
                checked={form.enabled}
                disabled={!canManage || busy || conflict}
                onChange={(_, enabled) => patch({ enabled })}
              />
            }
            sx={{ width: "100%", justifyContent: "space-between" }}
          />
          <Typography variant="body2" color="text.secondary">
            Trusted assignments start static PR reviews and Issue investigations.
          </Typography>
        </Box>
        <Box className="repository-form-width">
          <Typography variant="subtitle1" component="h3">
            Trusted E2E commands
          </Typography>
          <FormControlLabel
            label="Allow trusted @account e2e commands on pull requests"
            labelPlacement="start"
            control={
              <Switch
                checked={form.e2eEnabled === true}
                disabled={!canManage || busy || conflict}
                onChange={(_, e2eEnabled) => patch({ e2eEnabled })}
              />
            }
            sx={{ width: "100%", justifyContent: "space-between" }}
          />
          <Typography variant="body2" color="text.secondary">
            E2E uses the same recipient and trusted users below. It may build and run repository
            code, operate the desktop, and publish screenshots or videos in a separate comment. Only
            one E2E task can use the desktop at a time; static tasks can run alongside it.
          </Typography>
        </Box>
        <Stack spacing={3} className="repository-form-width">
          <TextField
            label="Assignment recipient GitHub user ID"
            value={form.reviewerUserIdText}
            onChange={(event) => patch({ reviewerUserIdText: event.target.value })}
            inputRef={reviewerRef}
            disabled={!canManage || busy || conflict}
            fullWidth
            error={!!fieldErrors.reviewerUserIdText}
            slotProps={{ htmlInput: { inputMode: "numeric" } }}
            helperText={
              fieldErrors.reviewerUserIdText ??
              "Enter the account's numeric GitHub user ID. IDs stay stable when usernames change."
            }
          />
          <TextField
            label="Trusted assigning GitHub user IDs"
            value={form.allowedActorUserIdsText}
            onChange={(event) => patch({ allowedActorUserIdsText: event.target.value })}
            inputRef={actorsRef}
            disabled={!canManage || busy || conflict}
            fullWidth
            multiline
            minRows={2}
            maxRows={6}
            error={!!fieldErrors.allowedActorUserIdsText}
            helperText={
              fieldErrors.allowedActorUserIdsText ??
              "Enter numeric IDs separated by commas or new lines. Only these trusted users can start a task."
            }
          />
        </Stack>
        <Accordion variant="outlined" disableGutters>
          <AccordionSummary
            id={`${receiverDetailsId}-summary`}
            aria-controls={`${receiverDetailsId}-details`}
            expandIcon={<span aria-hidden="true">+</span>}
          >
            <Typography>Receiver details</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Stack spacing={2}>
              <TextField
                label="Webhook endpoint"
                value="/api/github/webhook"
                fullWidth
                slotProps={{ input: { readOnly: true } }}
                helperText="Use this path on the public server URL and select Pull requests, Issues, and Issue comments events in GitHub."
              />
              <Typography variant="body2" color="text.secondary">
                Saved settings version {saved.version}. The event history remains available when
                intake is off.
              </Typography>
              <Box>
                <Button
                  component={Link}
                  to={"/webhooks?repositoryId=" + encodeURIComponent(repository.id)}
                >
                  View webhook events
                </Button>
              </Box>
            </Stack>
          </AccordionDetails>
        </Accordion>
        {!canManage && (
          <Alert severity="info">
            Repository management permission is required to change these settings.
          </Alert>
        )}
        {conflict && <WebhookSettingsConflictNotice />}
        {error && <Alert severity="error">{error}</Alert>}
        {message && <Alert severity="success">{message}</Alert>}
        <Stack
          className={dirty ? "repository-form-actions" : undefined}
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ flexWrap: "wrap", bgcolor: dirty ? "background.paper" : undefined }}
        >
          {canManage && (
            <Button type="submit" variant="contained" disabled={busy || conflict}>
              {busy ? "Working…" : "Save webhook settings"}
            </Button>
          )}
          {dirty && (
            <Button disabled={busy} onClick={() => guardedAction(reset)}>
              Discard changes
            </Button>
          )}
          {(dirty || conflict) && <Button onClick={downloadDraft}>Download draft</Button>}
          <Button disabled={busy} onClick={() => guardedAction(() => void reload())}>
            Reload saved settings
          </Button>
        </Stack>
      </Stack>
    </Box>
  );
}

export function RepositoryWebhookSettingsPanel({ repository }: { repository: Repository }) {
  const { session } = useInvestigationSession();
  const canRead = !!session.user?.repositoryIds.includes(repository.id);
  const canManage = canRead && !!session.user?.permissions.includes("repository:manage");
  if (!canRead) return null;
  return <ScopedWebhookSettingsPanel repository={repository} canManage={canManage} />;
}

function ScopedWebhookSettingsPanel({
  repository,
  canManage,
}: {
  repository: Repository;
  canManage: boolean;
}) {
  const query = useQuery({
    queryKey: webhookSettingsQueryKey(repository.id),
    queryFn: () => investigationApi.repositoryWebhookSettings(repository.id),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return (
    <Stack spacing={2}>
      {query.isPending && (
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <CircularProgress size={20} />
          <Typography variant="body2">Loading webhook settings…</Typography>
        </Stack>
      )}
      {query.isError && (
        <Alert severity="error">
          {query.error.message}
          <Button onClick={() => void query.refetch()}>Retry webhook settings</Button>
        </Alert>
      )}
      {query.data && (
        <WebhookSettingsForm
          key={repository.id}
          repository={repository}
          settings={query.data}
          canManage={canManage}
        />
      )}
    </Stack>
  );
}
