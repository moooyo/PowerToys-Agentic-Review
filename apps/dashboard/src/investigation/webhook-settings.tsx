import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { investigationApi, type Repository, type RepositoryWebhookSettings } from "./api";
import { useInvestigationSession } from "./session";
import { InvestigationHttpError } from "./transport";
import { submitWebhookSettings, webhookSettingsFormValues } from "./webhook-settings-form";

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
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(settings);
  const [form, setForm] = useState(() => webhookSettingsFormValues(settings));
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const acceptSettings = (value: RepositoryWebhookSettings) => {
    setSaved(value);
    setForm(webhookSettingsFormValues(value));
    setConflict(false);
    queryClient.setQueryData(webhookSettingsQueryKey(repository.id), value);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!canManage || busy || conflict) return;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      acceptSettings(
        await submitWebhookSettings(
          repository.id,
          form,
          saved,
          conflict,
          investigationApi.updateRepositoryWebhookSettings,
        ),
      );
      setMessage("Assignment webhook settings saved.");
    } catch (cause) {
      if (cause instanceof InvestigationHttpError && cause.status === 409) setConflict(true);
      setError(cause instanceof Error ? cause.message : "Webhook settings could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      acceptSettings(await investigationApi.repositoryWebhookSettings(repository.id));
      setMessage("The latest saved settings have been loaded.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Webhook settings could not be loaded.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Box component="form" onSubmit={(event) => void save(event)}>
      <Stack spacing={2}>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap" }}
        >
          <Typography variant="subtitle1">Assignment webhook</Typography>
          <Chip
            size="small"
            variant="outlined"
            label={saved.enabled ? "Saved: Enabled" : "Saved: Disabled"}
          />
        </Stack>
        <Typography variant="body2" color="text.secondary">
          Create a PR review or Issue investigation when a trusted user assigns an item in{" "}
          {repository.fullName} to the configured GitHub account. Each task keeps its own source and
          discussion snapshot.
        </Typography>
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
        <TextField
          label="Webhook endpoint"
          value="/api/github/webhook"
          fullWidth
          slotProps={{ input: { readOnly: true } }}
          helperText="Use this path on the public server URL and select Pull requests and Issues events in GitHub."
        />
        <FormControlLabel
          control={
            <Switch
              checked={form.enabled}
              disabled={!canManage || busy}
              onChange={(_, enabled) => {
                setForm({ ...form, enabled });
                setMessage(undefined);
              }}
            />
          }
          label="Listen for assignments"
        />
        <TextField
          label="Assignment recipient GitHub user ID"
          value={form.reviewerUserIdText}
          onChange={(event) => {
            setForm({ ...form, reviewerUserIdText: event.target.value });
            setMessage(undefined);
          }}
          disabled={!canManage || busy}
          fullWidth
          slotProps={{ htmlInput: { inputMode: "numeric" } }}
          helperText="Enter the account's numeric GitHub user ID. IDs stay stable when usernames change."
        />
        <TextField
          label="Trusted assigning GitHub user IDs"
          value={form.allowedActorUserIdsText}
          onChange={(event) => {
            setForm({ ...form, allowedActorUserIdsText: event.target.value });
            setMessage(undefined);
          }}
          disabled={!canManage || busy}
          fullWidth
          multiline
          minRows={2}
          maxRows={6}
          helperText="Enter numeric IDs separated by commas or new lines. Only assignments made by these users can start a task."
        />
        {!canManage && (
          <Alert severity="info">
            Repository management permission is required to change these settings.
          </Alert>
        )}
        {conflict && <WebhookSettingsConflictNotice />}
        {error && <Alert severity="error">{error}</Alert>}
        {message && <Alert severity="success">{message}</Alert>}
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
          {canManage && (
            <Button type="submit" variant="contained" disabled={busy || conflict}>
              {busy ? "Working…" : "Save webhook settings"}
            </Button>
          )}
          <Button disabled={busy} onClick={() => void reload()}>
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
    <Stack spacing={2} sx={{ mt: 2 }}>
      <Divider />
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
