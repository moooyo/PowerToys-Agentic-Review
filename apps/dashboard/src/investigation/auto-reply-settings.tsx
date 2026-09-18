import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
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
import { Link } from "react-router-dom";
import {
  investigationApi,
  type Repository,
  type RepositoryAutoReply,
  type RepositoryAutoReplySettings,
  type RepositoryProgressReply,
} from "./api";
import {
  autoReplyProgressStages,
  autoReplyProgressTemplateTokens,
  autoReplySettingsFormValues,
  autoReplySettingsPermissions,
  autoReplyTemplateTokens,
  issueAutoReplyTemplateTokens,
  submitAutoReplySettings,
} from "./auto-reply-settings-form";
import { useInvestigationSession } from "./session";
import { InvestigationHttpError } from "./transport";

export const autoReplySettingsQueryKey = (repositoryId: string) => [
  "investigation-auto-reply-settings",
  repositoryId,
];
export const autoRepliesQueryKey = (repositoryId: string) => [
  "investigation-auto-replies",
  repositoryId,
];
export const progressRepliesQueryKey = (repositoryId: string) => [
  "investigation-progress-replies",
  repositoryId,
];

const progressTemplateLabels = {
  received: "Received progress template",
  started: "Started progress template",
  failed: "Stopped progress template",
  completed: "Completed progress template",
} as const;

export function AutoReplySettingsConflictNotice() {
  return (
    <Alert severity="warning">
      These settings changed elsewhere. Your draft is still in this form. Reload saved settings to
      replace the draft with the latest version, then make your changes again.
    </Alert>
  );
}

export function AutoReplySettingsForm({
  repository,
  settings,
  canManage,
  canAuthorize,
}: {
  repository: Repository;
  settings: RepositoryAutoReplySettings;
  canManage: boolean;
  canAuthorize: boolean;
}) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(settings);
  const [form, setForm] = useState(() => autoReplySettingsFormValues(settings));
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const acceptSettings = (value: RepositoryAutoReplySettings) => {
    setSaved(value);
    setForm(autoReplySettingsFormValues(value));
    setConflict(false);
    queryClient.setQueryData(autoReplySettingsQueryKey(repository.id), value);
  };
  const save = async (event?: FormEvent, reauthorize = false) => {
    event?.preventDefault();
    if (!canManage || busy || conflict || (form.enabled && !canAuthorize)) return;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const updated = await submitAutoReplySettings(
        repository.id,
        form,
        saved,
        conflict,
        { canManage, canAuthorize },
        investigationApi.updateRepositoryAutoReplySettings,
        reauthorize,
      );
      acceptSettings(updated);
      setMessage(
        updated.enabled
          ? updated.progressEnabled
            ? "Settings saved. New progress updates use the latest templates, including updates to active investigations."
            : "Settings saved. New conclusion comments use the latest templates."
          : "Automatic replies are disabled. Settings saved.",
      );
      void queryClient.invalidateQueries({ queryKey: ["investigation-comments"] });
      void queryClient.invalidateQueries({ queryKey: ["investigation-comment"] });
    } catch (cause) {
      if (cause instanceof InvestigationHttpError && cause.status === 409) setConflict(true);
      setError(
        cause instanceof Error ? cause.message : "Automatic reply settings could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      acceptSettings(await investigationApi.repositoryAutoReplySettings(repository.id));
      setMessage("The latest saved settings have been loaded.");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Automatic reply settings could not be loaded.",
      );
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
          <Typography variant="subtitle1">Automatic investigation replies</Typography>
          <Chip
            size="small"
            variant="outlined"
            label={saved.enabled ? "Saved: Enabled" : "Saved: Disabled"}
          />
        </Stack>
        <Typography variant="body2" color="text.secondary">
          Automatically comment on completed PR and Issue investigations. No per-report
          confirmation. Enabling automatic replies authorizes English conclusion comments in{" "}
          {repository.fullName} using these templates.
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Assignment progress creates one comment when an assignment is accepted, explains the
          trigger, and updates that same comment when work starts, stops, or completes. Enabling
          assignment progress also authorizes these comment updates in {repository.fullName}.
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Template changes apply to the next update, including active investigations. Saving does
          not rewrite existing comments or add comments to earlier tasks. Retries keep the original
          prepared body. Disabling replies pauses publication.
        </Typography>
        {!saved.publisherConfigured && (
          <Alert severity="info">
            The server comment publisher is not configured yet. You can save settings now; an
            administrator must configure publishing before automatic comments can be sent.
          </Alert>
        )}
        {process.env.NODE_ENV === "development" && (
          <Alert severity="info">
            Sample mode: these settings and delivery records use isolated synthetic data. No
            comments are published to GitHub.
          </Alert>
        )}
        <FormControlLabel
          control={
            <Switch
              checked={form.enabled}
              disabled={!canManage || busy || (!canAuthorize && !form.enabled)}
              onChange={(_, enabled) => {
                setForm({ ...form, enabled, progressEnabled: enabled && form.progressEnabled });
                setMessage(undefined);
              }}
            />
          }
          label="Automatically publish investigation conclusions"
        />
        <FormControlLabel
          control={
            <Switch
              checked={form.progressEnabled}
              disabled={!form.enabled || !canManage || !canAuthorize || busy}
              onChange={(_, progressEnabled) => {
                setForm({ ...form, progressEnabled });
                setMessage(undefined);
              }}
            />
          }
          label="Publish assignment task progress"
        />
        <Accordion variant="outlined" disableGutters>
          <AccordionSummary expandIcon={<span aria-hidden="true">+</span>}>
            <Typography>English reply templates</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Stack spacing={2}>
              <Typography variant="body2" color="text.secondary">
                Keep each placeholder exactly once in the listed order. Start with the AI identity
                statement. PR replies show the conclusion, summary, and findings; Issue replies show
                the triage result and next steps. PR replies end with Details; Issue replies end
                with Investigation details. Both are collapsed by default. Templates may contain up
                to 12,000 UTF-8 bytes; custom wording should be English.
              </Typography>
              <Typography variant="body2" color="text.secondary">
                The identity statement names the recorded model and verified GitHub publishing user,
                and explains that AI-generated content may contain errors. Details includes scope,
                limitations, validation, supporting evidence, and full findings.
              </Typography>
              <Typography variant="body2">PR placeholders</Typography>
              <Box component="code" sx={{ typography: "body2", overflowWrap: "anywhere" }}>
                {autoReplyTemplateTokens.map((token) => `{{${token}}}`).join(" · ")}
              </Box>
              <TextField
                label="PR reply template"
                value={form.pullRequestTemplate}
                onChange={(event) => {
                  setForm({ ...form, pullRequestTemplate: event.target.value });
                  setMessage(undefined);
                }}
                disabled={!canManage || busy}
                fullWidth
                multiline
                minRows={8}
                maxRows={18}
                helperText="Used for completed PR reviews. The server generates the identity statement and collapsed Details section."
              />
              <Typography variant="body2">Issue placeholders</Typography>
              <Box component="code" sx={{ typography: "body2", overflowWrap: "anywhere" }}>
                {issueAutoReplyTemplateTokens.map((token) => `{{${token}}}`).join(" · ")}
              </Box>
              <TextField
                label="Issue reply template"
                value={form.issueTemplate}
                onChange={(event) => {
                  setForm({ ...form, issueTemplate: event.target.value });
                  setMessage(undefined);
                }}
                disabled={!canManage || busy}
                fullWidth
                multiline
                minRows={8}
                maxRows={18}
                helperText="Used for Issue triage. The summary is included in Triage result, without a separate Summary section. Bug triage shows Runtime reproduction separately. Next steps appear before collapsed Investigation details and cover missing information, validation, or relevant duplicate and fix references."
              />
              <Divider />
              <Typography variant="subtitle2">Assignment progress templates</Typography>
              <Typography variant="body2" color="text.secondary">
                Keep each listed placeholder exactly once and in order. The optional {"{{status}}"}{" "}
                may appear once before {"{{trigger}}"}; it distinguishes waiting, interruption,
                cancellation, and failure. The trigger explains the assignment, updated_at shows the
                update time, and failure describes why work stopped. The completed template inserts
                the full PR or Issue reply into result. The server adds the AI identity statement
                and verified publishing account to every progress comment; do not add an identity
                placeholder here. Each template may contain up to 12,000 UTF-8 bytes.
              </Typography>
              {autoReplyProgressStages.map((stage) => (
                <Box key={stage}>
                  <Box component="code" sx={{ typography: "body2", overflowWrap: "anywhere" }}>
                    {autoReplyProgressTemplateTokens[stage]
                      .map((token) => `{{${token}}}`)
                      .join(" · ")}
                  </Box>
                  <TextField
                    label={progressTemplateLabels[stage]}
                    value={form.progressTemplates[stage]}
                    onChange={(event) => {
                      setForm({
                        ...form,
                        progressTemplates: {
                          ...form.progressTemplates,
                          [stage]: event.target.value,
                        },
                      });
                      setMessage(undefined);
                    }}
                    disabled={!canManage || busy}
                    fullWidth
                    multiline
                    minRows={5}
                    maxRows={14}
                    sx={{ mt: 1 }}
                  />
                </Box>
              ))}
            </Stack>
          </AccordionDetails>
        </Accordion>
        {saved.authorizedById && (
          <Typography variant="caption" color="text.secondary">
            Authorized by account {saved.authorizedById}. Settings version {saved.version}; template
            format version {saved.templateVersion}. Last edited by{" "}
            {saved.updatedById ?? "an unavailable account"}.
          </Typography>
        )}
        {!canManage && (
          <Alert severity="info">
            Repository management permission is required to change these settings.
          </Alert>
        )}
        {canManage && !canAuthorize && (
          <Alert severity="info">
            Enabling automatic comments requires action preparation, action execution, and comment
            permissions. You can save disabled settings or turn off existing automatic replies.
          </Alert>
        )}
        {conflict && <AutoReplySettingsConflictNotice />}
        {error && <Alert severity="error">{error}</Alert>}
        {message && <Alert severity="success">{message}</Alert>}
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
          {canManage && (
            <Button
              type="submit"
              variant="contained"
              disabled={busy || conflict || (form.enabled && !canAuthorize)}
            >
              {busy
                ? "Working…"
                : form.enabled && (!saved.enabled || form.progressEnabled !== saved.progressEnabled)
                  ? form.progressEnabled
                    ? "Save and authorize comments and progress updates"
                    : "Save and authorize automatic comments"
                  : "Save automatic reply settings"}
            </Button>
          )}
          {saved.enabled && canAuthorize && (
            <Button
              disabled={busy || conflict || !form.enabled}
              onClick={() => void save(undefined, true)}
            >
              Save and renew publishing authorization
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

const stateColors = {
  pending: "default",
  prepared: "info",
  sending: "info",
  sent: "success",
  blocked: "warning",
  failed: "error",
  unknown: "warning",
} as const;

export function autoReplyCommentUrl(
  repository: Repository,
  reply: RepositoryAutoReply | RepositoryProgressReply,
): string | null {
  if (
    (!("stage" in reply) && reply.state !== "sent") ||
    !reply.externalId ||
    !/^[1-9][0-9]*$/u.test(reply.externalId)
  )
    return null;
  if (
    !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u.test(repository.fullName) ||
    repository.fullName.split("/").some((part) => part === "." || part === "..")
  )
    return null;
  const kind = reply.workItemKind === "pull_request" ? "pull" : "issues";
  return `https://github.com/${repository.fullName}/${kind}/${reply.workItemNumber}#issuecomment-${reply.externalId}`;
}

export function AutoReplyDeliveryList({
  repository,
  items,
}: {
  repository: Repository;
  items: RepositoryAutoReply[];
}) {
  return <ReplyDeliveryList repository={repository} items={items} progress={false} />;
}

export function ProgressReplyDeliveryList({
  repository,
  items,
}: {
  repository: Repository;
  items: RepositoryProgressReply[];
}) {
  return <ReplyDeliveryList repository={repository} items={items} progress />;
}

function ReplyDeliveryList({
  repository,
  items,
  progress,
}: {
  repository: Repository;
  items: (RepositoryAutoReply | RepositoryProgressReply)[];
  progress: boolean;
}) {
  const latest = [...items]
    .sort(
      (left, right) =>
        (progress
          ? right.updatedAt.localeCompare(left.updatedAt)
          : right.createdAt.localeCompare(left.createdAt)) || right.id.localeCompare(left.id),
    )
    .slice(0, 20);
  if (latest.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        {progress
          ? "No assignment progress deliveries recorded."
          : "No automatic reply deliveries recorded."}
      </Typography>
    );
  }
  return (
    <Stack spacing={2}>
      {latest.map((reply) => {
        const commentUrl = autoReplyCommentUrl(repository, reply);
        return (
          <Box key={reply.id} sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 2 }}>
            <Stack spacing={1}>
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ alignItems: "center", flexWrap: "wrap" }}
              >
                <Typography variant="subtitle2">
                  {reply.workItemKind === "pull_request" ? "PR" : "Issue"} #{reply.workItemNumber}
                </Typography>
                {"stage" in reply && <Chip size="small" variant="outlined" label={reply.stage} />}
                <Chip size="small" label={reply.state} color={stateColors[reply.state]} />
                {reply.reportId !== null && (
                  <Button
                    size="small"
                    component={Link}
                    to={`/reports?reportId=${encodeURIComponent(reply.reportId)}&repositoryId=${encodeURIComponent(repository.id)}`}
                  >
                    Open report
                  </Button>
                )}
                {commentUrl && (
                  <Button
                    size="small"
                    component="a"
                    href={commentUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View GitHub comment
                  </Button>
                )}
              </Stack>
              <Typography variant="caption" color="text.secondary">
                Updated {reply.updatedAt} · Settings version {reply.settingsVersion} · Template
                format version {reply.templateVersion}
              </Typography>
              {reply.reason && <Typography variant="body2">{reply.reason}</Typography>}
              {reply.state === "unknown" && (
                <Alert severity="warning">
                  {progress
                    ? "Progress delivery is uncertain and needs reconciliation. The server does not automatically resend an uncertain comment update."
                    : "Delivery is uncertain and needs reconciliation. The server does not automatically send the comment again."}
                </Alert>
              )}
              {reply.body !== null && (
                <Accordion variant="outlined" disableGutters>
                  <AccordionSummary expandIcon={<span aria-hidden="true">+</span>}>
                    <Typography variant="body2">View frozen comment</Typography>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Typography variant="caption" color="text.secondary">
                      {progress
                        ? "This is the saved progress comment body for the recorded stage."
                        : "This is the saved delivery body. Publication does not require per-report confirmation."}
                    </Typography>
                    <Box
                      component="pre"
                      sx={{
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                        typography: "body2",
                        maxHeight: 480,
                        overflowY: "auto",
                      }}
                    >
                      {reply.body}
                    </Box>
                  </AccordionDetails>
                </Accordion>
              )}
            </Stack>
          </Box>
        );
      })}
      {items.length > latest.length && (
        <Typography variant="caption" color="text.secondary">
          Showing the 20 most recent deliveries.
        </Typography>
      )}
    </Stack>
  );
}

export function RepositoryAutoReplySettingsPanel({ repository }: { repository: Repository }) {
  const { session } = useInvestigationSession();
  const permissions = autoReplySettingsPermissions(repository.id, session.user);
  if (!permissions.canRead) return null;
  return <ScopedAutoReplySettingsPanel repository={repository} {...permissions} />;
}

function ScopedAutoReplySettingsPanel({
  repository,
  canManage,
  canAuthorize,
}: {
  repository: Repository;
  canManage: boolean;
  canAuthorize: boolean;
}) {
  const settings = useQuery({
    queryKey: autoReplySettingsQueryKey(repository.id),
    queryFn: () => investigationApi.repositoryAutoReplySettings(repository.id),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return (
    <Accordion variant="outlined" disableGutters sx={{ mt: 2 }}>
      <AccordionSummary expandIcon={<span aria-hidden="true">+</span>}>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap" }}
        >
          <Typography>Automatic investigation replies</Typography>
          {settings.data && (
            <Chip size="small" label={settings.data.enabled ? "Enabled" : "Disabled"} />
          )}
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2}>
          {settings.isPending && (
            <CircularProgress size={20} aria-label="Loading automatic reply settings" />
          )}
          {settings.isError && (
            <Alert severity="error">
              {settings.error.message}
              <Button onClick={() => void settings.refetch()}>
                Retry automatic reply settings
              </Button>
            </Alert>
          )}
          {settings.data && (
            <AutoReplySettingsForm
              key={repository.id}
              repository={repository}
              settings={settings.data}
              canManage={canManage}
              canAuthorize={canAuthorize}
            />
          )}
          <Divider />
          <Typography variant="body2" color="text.secondary">
            Review saved comment bodies, delivery outcomes, and recovery actions in Comments.
          </Typography>
          <Box>
            <Button
              component={Link}
              to={`/comments?repositoryId=${encodeURIComponent(repository.id)}`}
            >
              View comment deliveries
            </Button>
          </Box>
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
