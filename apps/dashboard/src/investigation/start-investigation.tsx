import type { InvestigationTaskV1 } from "@agentic-review/contracts";
import ExpandMoreRounded from "@mui/icons-material/ExpandMoreRounded";
import LockRounded from "@mui/icons-material/LockRounded";
import PlayArrowRounded from "@mui/icons-material/PlayArrowRounded";
import ShieldRounded from "@mui/icons-material/ShieldRounded";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Radio,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { investigationApi, type WorkItem } from "./api";
import { useGuardedAction, useUnsavedChanges } from "./navigation-guard";
import { sessionIdentity, useInvestigationSession } from "./session";
import {
  clearInvestigationRequest,
  type InvestigationInputErrors,
  type InvestigationInputs,
  initialInvestigationInputs,
  investigationInputErrors,
  investigationRequest,
  investigationRequestScope,
  retainedInvestigationRequest,
  submitInvestigationRequest,
  subscribeInvestigationRequest,
} from "./start-investigation-state";
import { InvestigationHttpError } from "./transport";
import { taskUrl } from "./work-item-state";

export function InvestigationAccessOptions({
  workItem,
  mode,
  disabled,
  onChange,
}: {
  workItem: WorkItem;
  mode: InvestigationInputs["mode"];
  disabled: boolean;
  onChange: (mode: InvestigationInputs["mode"]) => void;
}) {
  const options: { value: InvestigationInputs["mode"]; title: string; description: string }[] = [
    {
      value: "source_read",
      title: "Read exact source",
      description: "Review the registered code and its behavior using static analysis.",
    },
    ...(workItem.kind === "issue"
      ? [
          {
            value: "snapshot_only" as const,
            title: "Snapshot only",
            description:
              "Use the saved description and discussion without reading repository code.",
          },
        ]
      : []),
  ];
  return (
    <Box component="fieldset" sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}>
      <Typography component="legend" variant="subtitle2" sx={{ mb: 1.5 }}>
        Investigation access
      </Typography>
      <Stack spacing={1.5}>
        {options.map((option) => (
          <Box
            component={workItem.kind === "issue" ? "label" : "div"}
            key={option.value}
            sx={{
              display: "flex",
              gap: 1.5,
              alignItems: "flex-start",
              p: 2,
              border: 1,
              borderColor: mode === option.value ? "primary.main" : "divider",
              bgcolor: mode === option.value ? "action.selected" : "transparent",
              borderRadius: 4,
              cursor: disabled || workItem.kind === "pull_request" ? "default" : "pointer",
            }}
          >
            {workItem.kind === "issue" && (
              <Radio
                checked={mode === option.value}
                onChange={() => onChange(option.value)}
                value={option.value}
                name="investigation-access"
                disabled={disabled}
                sx={{ p: 0.25 }}
              />
            )}
            <Box>
              <Typography variant="subtitle2">{option.title}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {option.description}
              </Typography>
            </Box>
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

export function StartInvestigationButton({
  workItem,
  variant = "contained",
  disabled = false,
  initialOpen = false,
  hideTrigger = false,
  onDismiss,
  onCompleted,
}: {
  workItem: WorkItem;
  variant?: "contained" | "outlined" | "text";
  disabled?: boolean;
  /** Mount the existing form in a stable page-level host for list shortcuts. */
  initialOpen?: boolean;
  hideTrigger?: boolean;
  onDismiss?: () => void;
  /** Return true when a list host has handled navigation to the completed creation. */
  onCompleted?: (task: InvestigationTaskV1) => boolean;
}) {
  const budgetId = useId();
  const { session } = useInvestigationSession();
  const identity = sessionIdentity(session);
  const scope = investigationRequestScope(identity, workItem.id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const guarded = useGuardedAction();
  const [open, setOpen] = useState(initialOpen);
  const [source, setSource] = useState(() =>
    initialOpen ? (retainedInvestigationRequest(scope)?.source ?? workItem) : workItem,
  );
  const [inputs, setInputs] = useState<InvestigationInputs>(
    () => retainedInvestigationRequest(scope)?.inputs ?? initialInvestigationInputs(workItem),
  );
  const [errors, setErrors] = useState<InvestigationInputErrors>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [sourceReloaded, setSourceReloaded] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const receipt = useSyncExternalStore(
    (listener) => subscribeInvestigationRequest(scope, listener),
    () => retainedInvestigationRequest(scope),
    () => undefined,
  );
  const [completed, setCompleted] = useState<InvestigationTaskV1>();
  const submitting = useRef(false);
  const alive = useRef(true);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const form = useRef<HTMLFormElement>(null);
  const key = useRef(crypto.randomUUID());
  const defaults = useQuery({
    queryKey: ["investigation-task-defaults", identity],
    queryFn: ({ signal }) => investigationApi.taskDefaults(signal),
    enabled: open,
  });
  const canCreate =
    !!session.user?.permissions.includes("task:create") &&
    !!session.user.repositoryIds.includes(workItem.repositoryId);
  const unresolved = receipt?.state === "unknown" || receipt?.state === "pending";
  const locked =
    busy || unresolved || receipt?.state === "confirmed" || receipt?.state === "mismatch";
  const initial = initialInvestigationInputs(source, defaults.data?.budget);
  const dirty =
    open &&
    !receipt &&
    (inputs.mode !== initial.mode || !!inputs.sourceCommit || inputs.customBudget);
  const reset = () => {
    setInputs(initialInvestigationInputs(source, defaults.data?.budget));
    setErrors({});
    setError(undefined);
    setConflict(false);
  };
  useUnsavedChanges(dirty, {
    busy: open && (busy || receipt?.state === "pending"),
    description: "Your investigation access and budget choices have not been submitted.",
    onDiscard: reset,
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (defaults.data && !inputs.customBudget && !receipt)
      setInputs((current) => ({
        ...current,
        reportBytes: String(defaults.data.budget.maxReportBytes),
      }));
  }, [defaults.data, inputs.customBudget, receipt]);
  useEffect(() => {
    if (completed && !open && !busy) {
      if (retainedInvestigationRequest(scope)?.state === "confirmed")
        clearInvestigationRequest(scope);
      if (!onCompleted?.(completed)) navigate(taskUrl(completed));
    }
  }, [completed, open, busy, scope, navigate, onCompleted]);
  const focusErrors = () =>
    requestAnimationFrame(() =>
      (
        form.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
        form.current?.querySelector<HTMLElement>('[role="alert"]')
      )?.focus(),
    );
  const update = (values: Partial<InvestigationInputs>) => {
    if (locked) return;
    setInputs((current) => ({ ...current, ...values }));
    setErrors({});
    setError(undefined);
    key.current = crypto.randomUUID();
  };
  const close = () => {
    if (!busy && receipt?.state !== "pending")
      guarded(() => {
        setOpen(false);
        onDismiss?.();
      });
  };
  const openDialog = () => {
    const saved = retainedInvestigationRequest(scope);
    setSource(saved?.source ?? workItem);
    setInputs(saved?.inputs ?? initialInvestigationInputs(workItem, defaults.data?.budget));
    setErrors({});
    setError(undefined);
    setConflict(false);
    setSourceReloaded(false);
    setOpen(true);
    if (!saved) key.current = crypto.randomUUID();
  };
  const reloadSource = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      const latest = await investigationApi.workItem(workItem.id);
      if (!alive.current || currentIdentity.current !== identity) return;
      if (latest.repositoryId !== workItem.repositoryId || latest.kind !== workItem.kind)
        throw new Error("The current source no longer matches this repository and work item.");
      setSource(latest);
      queryClient.setQueryData(["investigation-work-item", latest.id], latest);
      setConflict(false);
      setSourceReloaded(true);
      setError(undefined);
      key.current = crypto.randomUUID();
    } catch (cause) {
      if (alive.current && currentIdentity.current === identity)
        setError(
          cause instanceof Error ? cause.message : "The current source could not be loaded.",
        );
    } finally {
      submitting.current = false;
      if (alive.current && currentIdentity.current === identity) setBusy(false);
    }
  };
  const create = async () => {
    if (
      submitting.current ||
      !canCreate ||
      conflict ||
      retainedInvestigationRequest(scope)?.state === "pending"
    )
      return;
    const saved = retainedInvestigationRequest(scope);
    if ((saved?.state === "confirmed" || saved?.state === "mismatch") && saved.task) {
      setOpen(false);
      setCompleted(saved.task);
      return;
    }
    const validation: InvestigationInputErrors = saved
      ? {}
      : investigationInputErrors(source, inputs, defaults.data?.budget);
    setErrors(validation);
    if (Object.keys(validation).length) {
      if (validation.reportBytes || validation.budget) setBudgetOpen(true);
      focusErrors();
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    let request = saved;
    try {
      if (!request) {
        const latest = await investigationApi.workItem(source.id);
        if (!alive.current || currentIdentity.current !== identity) return;
        if (
          latest.repositoryId !== source.repositoryId ||
          latest.subject.id !== source.subject.id ||
          latest.subject.revisionKey !== source.subject.revisionKey
        ) {
          setConflict(true);
          return;
        }
        request = {
          input: investigationRequest(source, inputs, key.current, defaults.data?.budget),
          inputs: { ...inputs },
          source,
          state: "pending",
        };
      } else request = { ...request, state: "pending" };
      const pendingTask = submitInvestigationRequest(scope, request, investigationApi.createTask);
      const task = await pendingTask;
      if (!alive.current || currentIdentity.current !== identity) return;
      await queryClient.invalidateQueries({ queryKey: ["investigation-tasks"] });
      if (!alive.current || currentIdentity.current !== identity) return;
      setOpen(false);
      setCompleted(task);
    } catch (cause) {
      if (!alive.current || currentIdentity.current !== identity) return;
      if (cause instanceof InvestigationHttpError && cause.status === 409 && !saved)
        setConflict(true);
      setError(cause instanceof Error ? cause.message : "The task request could not be confirmed.");
      focusErrors();
    } finally {
      submitting.current = false;
      if (alive.current && currentIdentity.current === identity) setBusy(false);
    }
  };
  return (
    <>
      {!hideTrigger && (
        <Button
          variant={variant}
          startIcon={<PlayArrowRounded />}
          disabled={!canCreate || disabled}
          onClick={openDialog}
        >
          {receipt
            ? "Check investigation request"
            : workItem.kind === "pull_request"
              ? "Start review"
              : "Investigate issue"}
        </Button>
      )}
      <Dialog
        open={open}
        onClose={close}
        fullWidth
        maxWidth="sm"
        aria-labelledby="start-investigation-title"
      >
        <DialogTitle id="start-investigation-title">Start investigation</DialogTitle>
        <DialogContent>
          <Box
            component="form"
            ref={form}
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
            noValidate
          >
            <Stack spacing={3} sx={{ pt: 1 }}>
              <Box sx={{ pb: 2.5, borderBottom: 1, borderColor: "divider" }}>
                <Typography variant="caption" color="text.secondary">
                  {source.kind === "pull_request" ? "Pull request" : "Issue"} #{source.number}
                </Typography>
                <Typography variant="subtitle1" sx={{ mt: 0.5, overflowWrap: "anywhere" }}>
                  {source.title}
                </Typography>
              </Box>
              {unresolved && (
                <Alert severity="warning" role="status">
                  The submitted request has no confirmed outcome. Its access, budget, and request
                  identity are retained while you move between workspace pages in this browser
                  session. Check the same request before reloading this page or starting another
                  investigation.
                </Alert>
              )}
              {receipt?.state === "confirmed" && (
                <Alert severity="success">
                  This request created an investigation. Open the existing task to continue.
                </Alert>
              )}
              {receipt?.state === "mismatch" && (
                <Alert severity="error">
                  The returned task has a different source or request binding. Its receipt is
                  retained. Review the returned task; this request will not create another
                  investigation.
                </Alert>
              )}
              <InvestigationAccessOptions
                workItem={source}
                mode={inputs.mode}
                disabled={locked}
                onChange={(mode) => update({ mode })}
              />
              {errors.mode && (
                <Alert severity="error" tabIndex={-1}>
                  {errors.mode}
                </Alert>
              )}
              {inputs.mode === "source_read" && source.kind === "issue" && (
                <TextField
                  label="Exact source commit SHA"
                  value={inputs.sourceCommit}
                  onChange={(event) => update({ sourceCommit: event.target.value })}
                  disabled={locked}
                  error={!!errors.sourceCommit}
                  helperText={
                    errors.sourceCommit ??
                    "An issue does not pin code. Enter a full 40–64 character hexadecimal SHA."
                  }
                  fullWidth
                />
              )}
              {inputs.mode === "source_read" && source.subject.kind === "original_pr" && (
                <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
                  <LockRounded sx={{ fontSize: 16, color: "text.secondary" }} />
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ overflowWrap: "anywhere" }}
                  >
                    Pinned source <code>{source.subject.headSha}</code>
                  </Typography>
                </Stack>
              )}
              <Accordion
                expanded={budgetOpen}
                onChange={(_event, expanded) => setBudgetOpen(expanded)}
                disableGutters
                elevation={0}
                sx={{
                  bgcolor: "transparent",
                  borderBlock: 1,
                  borderColor: "divider",
                  "&:before": { display: "none" },
                }}
              >
                <AccordionSummary
                  id={`${budgetId}-summary`}
                  aria-controls={`${budgetId}-region`}
                  expandIcon={<ExpandMoreRounded />}
                >
                  <Box>
                    <Typography variant="subtitle2">Investigation budget</Typography>
                    <Typography variant="caption" color="text.secondary">
                      2 hours total execution
                      {inputs.customBudget
                        ? ` · ${Number(inputs.reportBytes).toLocaleString()} report bytes`
                        : defaults.data
                          ? ` · ${defaults.data.budget.maxReportBytes.toLocaleString()} report bytes`
                          : " · Use configured report size"}
                    </Typography>
                  </Box>
                </AccordionSummary>
                <AccordionDetails>
                  <Stack spacing={2}>
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={inputs.customBudget}
                          disabled={locked || !defaults.data}
                          onChange={(event) => update({ customBudget: event.target.checked })}
                        />
                      }
                      label="Choose custom report size"
                    />
                    {defaults.isError && (
                      <Alert severity="warning">
                        Configured report size could not be loaded. You can still use the server
                        defaults. <Button onClick={() => void defaults.refetch()}>Retry</Button>
                      </Alert>
                    )}
                    <TextField
                      type="number"
                      label="Report size limit (bytes)"
                      value={inputs.reportBytes}
                      onChange={(event) => update({ reportBytes: event.target.value })}
                      disabled={locked || !inputs.customBudget}
                      error={!!errors.reportBytes}
                      helperText={errors.reportBytes}
                      slotProps={{ htmlInput: { min: 1, step: 1 } }}
                    />
                    <Typography variant="caption" color="text.secondary">
                      Execution stops after 2 hours across all attempts. Resuming keeps the time
                      already used. Tokens and rounds are recorded without limiting execution.
                    </Typography>
                    {errors.budget && (
                      <Alert severity="error" tabIndex={-1}>
                        {errors.budget}
                      </Alert>
                    )}
                  </Stack>
                </AccordionDetails>
              </Accordion>
              <Stack
                direction="row"
                spacing={1.5}
                sx={{ p: 2, borderRadius: 4, bgcolor: "action.hover", color: "text.secondary" }}
              >
                <ShieldRounded />
                <Typography variant="body2">
                  Static analysis reads the chosen source. Builds, tests, and desktop execution
                  belong to a separate verification task.
                </Typography>
              </Stack>
              <Typography variant="caption" color="text.secondary">
                The server checks that the registered source still matches the revision reviewed
                here before creating the task.
              </Typography>
              {conflict && (
                <Alert
                  severity="warning"
                  action={
                    <Button disabled={busy} onClick={() => void reloadSource()}>
                      Load current snapshot
                    </Button>
                  }
                >
                  The source snapshot changed or could not be accepted. Your access and budget
                  choices are kept. Load the current snapshot, then review and confirm again.
                </Alert>
              )}
              {sourceReloaded && (
                <Alert severity="success">
                  Current snapshot loaded. Review the source above before creating the
                  investigation.
                </Alert>
              )}
              {!canCreate && (
                <Alert severity="info">
                  Creating investigations requires the Create tasks permission and access to this
                  repository. Your entered values are kept.
                </Alert>
              )}
              {error && (
                <Alert severity="error" tabIndex={-1}>
                  {error}
                </Alert>
              )}
            </Stack>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy || receipt?.state === "pending"} onClick={close}>
            {unresolved || receipt?.state === "mismatch" ? "Keep request and close" : "Cancel"}
          </Button>
          <Button
            variant="contained"
            disabled={busy || !canCreate || conflict || receipt?.state === "pending"}
            onClick={() => void create()}
          >
            {busy
              ? "Creating…"
              : receipt?.state === "confirmed"
                ? "Open created task"
                : receipt?.state === "mismatch"
                  ? "Review returned task"
                  : unresolved
                    ? "Check same request"
                    : "Create task"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
