import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  investigationApi,
  type Repository,
  type RepositoryAutoReply,
  type RepositoryAutoReplySettings,
  type RepositoryProgressReply,
} from "./api";
import {
  type AutoReplyAuthorization,
  type AutoReplySettingsFormValues,
  type AutoReplyTemplateKey,
  autoReplyAuthorizationSnapshot,
  autoReplyProgressStages,
  autoReplyProgressTemplateTokens,
  autoReplySettingsFieldErrors,
  autoReplySettingsFormValues,
  autoReplySettingsPermissions,
  autoReplyTemplateTokens,
  autoReplyTemplateValue,
  issueAutoReplyTemplateTokens,
  submitAutoReplySettings,
} from "./auto-reply-settings-form";
import { useGuardedAction, useUnsavedChanges } from "./navigation-guard";
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

const templateLabels: Record<AutoReplyTemplateKey, string> = {
  pullRequest: "PR reply template",
  issue: "Issue reply template",
  received: "Received progress template",
  started: "Started progress template",
  failed: "Stopped progress template",
  completed: "Completed progress template",
};
const templateKeys = ["pullRequest", "issue", ...autoReplyProgressStages] as const;
const previewTokens: Record<string, string> = {
  identity: "[AI identity statement, recorded model, and verified GitHub publishing user]",
  conclusion: "[Investigation conclusion]",
  summary: "[Investigation summary]",
  findings: "[Reported findings]",
  details: "[Scope, evidence, validation, limitations, and full findings]",
  next_steps: "[Recommended next steps]",
  status: "[Current investigation status]",
  trigger: "[Assignment trigger and requester]",
  updated_at: "[Recorded update time]",
  failure: "[Reason the investigation stopped]",
  result: "[Full PR or Issue investigation reply]",
};

interface AutoReplyPreviewBlock {
  sourceOffset: number;
  kind: "text" | "details";
  value: string;
}

export function autoReplyPreviewBlocks(value: string): AutoReplyPreviewBlock[] {
  const blocks: AutoReplyPreviewBlock[] = [];
  const appendText = (text: string, sourceOffset: number) => {
    for (const paragraph of text.matchAll(/[^\r\n]+(?:\r?\n(?![ \t]*\r?\n)[^\r\n]+)*/gu)) {
      if (paragraph[0].trim()) {
        blocks.push({
          sourceOffset: sourceOffset + paragraph.index,
          kind: "text",
          value: paragraph[0],
        });
      }
    }
  };
  let cursor = 0;
  for (const token of value.matchAll(/\{\{details\}\}/gu)) {
    appendText(value.slice(cursor, token.index), cursor);
    blocks.push({ sourceOffset: token.index, kind: "details", value: token[0] });
    cursor = token.index + token[0].length;
  }
  appendText(value.slice(cursor), cursor);
  return blocks;
}

export function AutoReplyTemplatePreview({
  template,
  value,
}: {
  template: AutoReplyTemplateKey;
  value: string;
}) {
  return (
    <Box className="repository-template-preview">
      <Box sx={{ p: 2, bgcolor: "action.hover" }}>
        <Typography sx={{ fontWeight: 500 }}>Template preview</Typography>
        <Typography variant="caption" color="text.secondary">
          Illustrative placeholders only. Actual content comes from the investigation and publishing
          account.
        </Typography>
      </Box>
      <Box className="repository-template-preview-body">
        {autoReplyPreviewBlocks(value).map((block) => {
          if (block.kind === "details") {
            return (
              <Box component="details" key={block.sourceOffset}>
                <summary>{template === "issue" ? "Investigation details" : "Details"}</summary>
                <Typography variant="body2">{previewTokens.details}</Typography>
              </Box>
            );
          }
          const text = block.value.replace(
            /\{\{([^{}]*)\}\}/gu,
            (match, token: string) => previewTokens[token] ?? match,
          );
          const [first, ...rest] = text.split(/\r?\n/u);
          return first?.startsWith("## ") ? (
            <Box key={block.sourceOffset}>
              <Typography component="h3" variant="subtitle1" sx={{ mb: 1 }}>
                {first.slice(3)}
              </Typography>
              <Typography component="p" variant="body2">
                {rest.join("\n")}
              </Typography>
            </Box>
          ) : (
            <Typography component="p" variant="body2" key={block.sourceOffset}>
              {text}
            </Typography>
          );
        })}
      </Box>
    </Box>
  );
}

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
  const guardedAction = useGuardedAction();
  const [saved, setSaved] = useState(settings);
  const [form, setForm] = useState(() => autoReplySettingsFormValues(settings));
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [template, setTemplate] = useState<AutoReplyTemplateKey>("pullRequest");
  const [editingTemplates, setEditingTemplates] = useState(false);
  const [preview, setPreview] = useState(false);
  const [authorization, setAuthorization] = useState<AutoReplyAuthorization | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ReturnType<typeof autoReplySettingsFieldErrors>>(
    {},
  );
  const templateRef = useRef<HTMLInputElement>(null);
  const [pendingFocus, setPendingFocus] = useState<AutoReplyTemplateKey | null>(null);
  const alive = useRef(true);
  const dirty = JSON.stringify(form) !== JSON.stringify(autoReplySettingsFormValues(saved));
  useUnsavedChanges(dirty, { busy, description: "Automatic replies have unsaved changes." });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (pendingFocus === null || !editingTemplates || template !== pendingFocus) return;
    const input = templateRef.current;
    if (!input) return;
    input.focus();
    setPendingFocus(null);
  }, [pendingFocus, editingTemplates, template]);
  useEffect(() => {
    if (settings.version <= saved.version || busy) return;
    if (authorization) {
      setAuthorization(null);
      setError(
        "Saved settings changed while you were reviewing publishing authorization. Review the latest settings before authorizing again.",
      );
    }
    if (dirty) setConflict(true);
    else {
      setSaved(settings);
      setForm(autoReplySettingsFormValues(settings));
      setConflict(false);
    }
  }, [settings, saved.version, busy, dirty, authorization]);
  const patch = (values: Partial<AutoReplySettingsFormValues>) => {
    const next = { ...form, ...values };
    setForm(next);
    setMessage(undefined);
    if (Object.keys(fieldErrors).length) setFieldErrors(autoReplySettingsFieldErrors(next));
  };
  const acceptSettings = (value: RepositoryAutoReplySettings) => {
    if (!alive.current) return;
    setSaved(value);
    setForm(autoReplySettingsFormValues(value));
    setConflict(false);
    setFieldErrors({});
    queryClient.setQueryData(autoReplySettingsQueryKey(repository.id), value);
  };
  const save = async (reauthorize = false, submittedForm = form, submittedSettings = saved) => {
    if (!canManage || busy || conflict || (submittedForm.enabled && !canAuthorize)) return;
    setAuthorization(null);
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await queryClient.cancelQueries({ queryKey: autoReplySettingsQueryKey(repository.id) });
      if (!alive.current) return;
      const updated = await submitAutoReplySettings(
        repository.id,
        submittedForm,
        submittedSettings,
        conflict,
        { canManage, canAuthorize },
        investigationApi.updateRepositoryAutoReplySettings,
        reauthorize,
      );
      await queryClient.cancelQueries({ queryKey: autoReplySettingsQueryKey(repository.id) });
      if (!alive.current) return;
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
      if (!alive.current) return;
      if (cause instanceof InvestigationHttpError && cause.status === 409) setConflict(true);
      setError(
        cause instanceof Error ? cause.message : "Automatic reply settings could not be saved.",
      );
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const requestSave = (event?: FormEvent, renew = false) => {
    event?.preventDefault();
    if (!canManage || busy || conflict || (form.enabled && !canAuthorize)) return;
    const errors = autoReplySettingsFieldErrors(form);
    setFieldErrors(errors);
    const invalid = templateKeys.find((key) => errors[key]);
    if (invalid) {
      setEditingTemplates(true);
      setTemplate(invalid);
      setPendingFocus(invalid);
      return;
    }
    if (Object.keys(errors).length) return;
    if (form.enabled && (dirty || renew))
      setAuthorization(autoReplyAuthorizationSnapshot(form, saved, renew));
    else void save(renew);
  };
  const reload = async () => {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await queryClient.cancelQueries({ queryKey: autoReplySettingsQueryKey(repository.id) });
      if (!alive.current) return;
      const latest = await investigationApi.repositoryAutoReplySettings(repository.id);
      await queryClient.cancelQueries({ queryKey: autoReplySettingsQueryKey(repository.id) });
      if (!alive.current) return;
      if (latest.version < saved.version)
        throw new Error(
          "The server returned older settings. Your current settings and draft are kept. Try reloading again.",
        );
      acceptSettings(latest);
      setMessage("The latest saved settings have been loaded.");
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error ? cause.message : "Automatic reply settings could not be loaded.",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const reset = () => {
    setForm(autoReplySettingsFormValues(saved));
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
    link.download = "repository-replies-draft.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const currentTemplate = autoReplyTemplateValue(form, template);
  const tokens =
    template === "pullRequest"
      ? autoReplyTemplateTokens
      : template === "issue"
        ? issueAutoReplyTemplateTokens
        : autoReplyProgressTemplateTokens[template];
  const progressTemplate = template !== "pullRequest" && template !== "issue";
  return (
    <Box
      component="form"
      className="repository-form"
      onSubmit={(event) => requestSave(event)}
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
              Automatic investigation replies
            </Typography>
            <Chip
              size="small"
              variant="outlined"
              label={saved.enabled ? "Saved: Enabled" : "Saved: Disabled"}
            />
            {dirty && <Chip size="small" color="warning" label="Unsaved changes" />}
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Automatically comment on completed PR and Issue investigations. No per-report
            confirmation. Enabling automatic replies authorizes English conclusion comments in{" "}
            {repository.fullName} using these templates.
          </Typography>
        </Box>
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
        <Box className="repository-form-width">
          <FormControlLabel
            label="Automatically publish investigation conclusions"
            labelPlacement="start"
            control={
              <Switch
                checked={form.enabled}
                disabled={!canManage || busy || (!canAuthorize && !form.enabled)}
                onChange={(_, enabled) =>
                  patch({ enabled, progressEnabled: enabled && form.progressEnabled })
                }
              />
            }
            sx={{ width: "100%", justifyContent: "space-between" }}
          />
          <FormControlLabel
            label="Publish assignment task progress"
            labelPlacement="start"
            control={
              <Switch
                checked={form.progressEnabled}
                disabled={!form.enabled || !canManage || !canAuthorize || busy}
                onChange={(_, progressEnabled) => patch({ progressEnabled })}
              />
            }
            sx={{ width: "100%", justifyContent: "space-between" }}
          />
          <Typography variant="body2" color="text.secondary">
            Assignment progress creates one comment when an assignment is accepted, explains the
            trigger, and updates that same comment when work starts, stops, or completes. Enabling
            assignment progress also authorizes these comment updates in {repository.fullName}.
          </Typography>
          {fieldErrors.progressEnabled && (
            <Alert severity="error">{fieldErrors.progressEnabled}</Alert>
          )}
        </Box>
        <Box>
          <Typography variant="h6" component="h3">
            English reply templates
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Template changes apply to the next update, including active investigations. Saving does
            not rewrite existing comments or add comments to earlier tasks. Retries keep the
            original prepared body. Disabling replies pauses publication.
          </Typography>
        </Box>
        <Stack
          direction="row"
          useFlexGap
          spacing={3}
          sx={{ flexWrap: "wrap", alignItems: "center" }}
        >
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
              Conclusion templates
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Pull requests and Issues
            </Typography>
          </Box>
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
              Progress templates
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Received, started, stopped, completed
            </Typography>
          </Box>
          <Button
            onClick={() => setEditingTemplates(!editingTemplates)}
            aria-expanded={editingTemplates}
            aria-controls="repository-template-editor"
          >
            {editingTemplates
              ? "Close template editor"
              : canManage
                ? "Edit templates"
                : "View templates"}
          </Button>
        </Stack>
        {editingTemplates && (
          <Stack id="repository-template-editor" spacing={2.5}>
            <TextField
              select
              label="Template type and stage"
              value={template}
              onChange={(event) => setTemplate(event.target.value as AutoReplyTemplateKey)}
              sx={{ maxWidth: 360 }}
            >
              {templateKeys.map((key) => (
                <MenuItem key={key} value={key}>
                  {templateLabels[key]}
                </MenuItem>
              ))}
            </TextField>
            <Stack spacing={1}>
              <Typography variant="body2" color="text.secondary">
                Required placeholders, once each and in this order:
              </Typography>
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
                {tokens.map((token) => (
                  <Box
                    component="code"
                    key={token}
                    sx={{ px: 1, py: 0.5, bgcolor: "action.hover", borderRadius: 1, fontSize: 12 }}
                  >
                    {"{{" + token + "}}"}
                  </Box>
                ))}
              </Stack>
              <Typography variant="body2" color="text.secondary">
                {progressTemplate
                  ? "The optional {{status}} may appear once before {{trigger}}. The server adds the AI identity statement. The completed template inserts the full PR or Issue reply into {{result}}."
                  : "Begin with {{identity}} and end with {{details}}. The AI identity names the recorded model and verified GitHub publishing user, and explains that AI-generated content may contain errors. Details are collapsed by default."}
              </Typography>
              {template === "issue" && (
                <Typography variant="body2" color="text.secondary">
                  The summary is included in Triage result, without a separate Summary section. Bug
                  triage shows Runtime reproduction separately. Next steps appear before collapsed
                  Investigation details.
                </Typography>
              )}
            </Stack>
            <TextField
              label={templateLabels[template]}
              value={currentTemplate}
              inputRef={templateRef}
              onChange={(event) => {
                const value = event.target.value;
                patch(
                  template === "pullRequest"
                    ? { pullRequestTemplate: value }
                    : template === "issue"
                      ? { issueTemplate: value }
                      : { progressTemplates: { ...form.progressTemplates, [template]: value } },
                );
              }}
              disabled={!canManage || busy}
              fullWidth
              multiline
              minRows={8}
              maxRows={18}
              error={!!fieldErrors[template]}
              helperText={
                fieldErrors[template] ??
                "Custom wording should be English. Keep the exact placeholder syntax."
              }
              slotProps={{
                input: {
                  sx: { fontFamily: "var(--app-code-font)", fontSize: 13, lineHeight: 1.75 },
                },
              }}
            />
            <Stack
              direction="row"
              spacing={2}
              useFlexGap
              sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}
            >
              <Typography
                variant="caption"
                color={
                  new TextEncoder().encode(currentTemplate).byteLength > 12000
                    ? "error"
                    : "text.secondary"
                }
              >
                {new TextEncoder().encode(currentTemplate).byteLength.toLocaleString()} / 12,000
                UTF-8 bytes
              </Typography>
              <Button onClick={() => setPreview(true)} aria-haspopup="dialog">
                Preview template
              </Button>
            </Stack>
          </Stack>
        )}
        <Box>
          <Typography sx={{ fontWeight: 500 }}>Publishing authorization</Typography>
          <Typography variant="body2" color="text.secondary">
            {saved.authorizedById
              ? "Authorized by account " + saved.authorizedById + ". "
              : "No publishing authorization is recorded. "}
            Settings version {saved.version}; template format version {saved.templateVersion}.
            {saved.updatedById && " Last edited by " + saved.updatedById + "."}
            {saved.updatedAt && " Updated " + saved.updatedAt + "."}
          </Typography>
        </Box>
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
        <Stack
          className={dirty ? "repository-form-actions" : undefined}
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ flexWrap: "wrap", bgcolor: dirty ? "background.paper" : undefined }}
        >
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
              onClick={() => requestSave(undefined, true)}
            >
              Save and renew publishing authorization
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
      <Dialog
        open={preview}
        onClose={() => setPreview(false)}
        maxWidth="md"
        fullWidth
        aria-labelledby="reply-preview-title"
      >
        <DialogTitle id="reply-preview-title">{templateLabels[template]}</DialogTitle>
        <DialogContent>
          <AutoReplyTemplatePreview template={template} value={currentTemplate} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPreview(false)}>Back to editor</Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={authorization !== null}
        onClose={() => setAuthorization(null)}
        maxWidth="sm"
        fullWidth
        aria-labelledby="reply-authorization-title"
      >
        <DialogTitle id="reply-authorization-title">
          {authorization?.renew
            ? "Renew publishing authorization?"
            : "Authorize automatic comments?"}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            Save these templates and authorize future conclusion comments
            {authorization?.form.progressEnabled ? " and assignment progress comment updates" : ""}{" "}
            in {repository.fullName}. These publications do not ask for per-report confirmation.
            Existing comments are not rewritten by saving.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAuthorization(null)}>Keep editing</Button>
          <Button
            variant="contained"
            disabled={busy || conflict || !canManage || !canAuthorize}
            onClick={() => {
              if (authorization)
                void save(authorization.renew, authorization.form, authorization.saved);
            }}
          >
            Save and authorize
          </Button>
        </DialogActions>
      </Dialog>
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
  const deliveryListId = useId();
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
                  <AccordionSummary
                    id={`${deliveryListId}-${encodeURIComponent(reply.id)}-summary`}
                    aria-controls={`${deliveryListId}-${encodeURIComponent(reply.id)}-details`}
                    expandIcon={<span aria-hidden="true">+</span>}
                  >
                    <Typography variant="body2">View saved comment</Typography>
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
    <Stack spacing={3}>
      {settings.isPending && (
        <CircularProgress size={20} aria-label="Loading automatic reply settings" />
      )}
      {settings.isError && (
        <Alert severity="error">
          {settings.error.message}
          <Button onClick={() => void settings.refetch()}>Retry automatic reply settings</Button>
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
        <Button component={Link} to={`/comments?repositoryId=${encodeURIComponent(repository.id)}`}>
          View comment deliveries
        </Button>
      </Box>
    </Stack>
  );
}
