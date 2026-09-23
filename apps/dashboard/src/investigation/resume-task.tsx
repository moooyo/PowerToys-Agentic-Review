import type {
  InvestigationBudget,
  InvestigationLoopCheckpointV1,
  InvestigationTaskV1,
} from "@agentic-review/contracts";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { type FormEvent, useId, useRef, useState } from "react";
import { investigationApi } from "./api";
import { useGuardedAction, useUnsavedChanges } from "./navigation-guard";

type BudgetInputs = Record<keyof InvestigationBudget, string>;
type BudgetErrors = Partial<Record<keyof InvestigationBudget, string>>;
const fields: {
  key: keyof InvestigationBudget;
  consumed: "rounds" | "durationMs" | "tokens" | "reportBytes";
  label: string;
  unit: number;
}[] = [
  { key: "maxRounds", consumed: "rounds", label: "Loop rounds", unit: 1 },
  { key: "maxDurationMs", consumed: "durationMs", label: "Duration limit (seconds)", unit: 1000 },
  { key: "maxTokens", consumed: "tokens", label: "Token limit", unit: 1 },
  {
    key: "maxReportBytes",
    consumed: "reportBytes",
    label: "Report size limit (MiB)",
    unit: 1024 * 1024,
  },
];

export function resumeBudget(
  inputs: BudgetInputs,
  previous: InvestigationBudget,
  consumed?: InvestigationLoopCheckpointV1["consumed"],
): InvestigationBudget {
  const value = {
    maxRounds: Number(inputs.maxRounds),
    maxDurationMs: Number(inputs.maxDurationMs) * 1000,
    maxTokens: Number(inputs.maxTokens),
    maxReportBytes: Number(inputs.maxReportBytes) * 1024 * 1024,
  };
  for (const field of fields) {
    if (
      !Number.isSafeInteger(value[field.key]) ||
      value[field.key] < previous[field.key] ||
      value[field.key] <= 0
    )
      throw new Error("Resume limits must be positive and cannot reduce the saved task budget.");
    if (consumed && consumed[field.consumed] >= value[field.key])
      throw new Error("Increase each exhausted limit beyond its recorded usage before resuming.");
  }
  return value;
}

export function resumeBudgetErrors(
  inputs: BudgetInputs,
  previous: InvestigationBudget,
  consumed?: InvestigationLoopCheckpointV1["consumed"],
): BudgetErrors {
  const errors: BudgetErrors = {};
  for (const field of fields) {
    const value = Number(inputs[field.key]) * field.unit;
    if (!inputs[field.key].trim() || !Number.isSafeInteger(value) || value <= 0)
      errors[field.key] = "Enter a positive limit that resolves to a whole number of base units.";
    else if (value < previous[field.key])
      errors[field.key] = `Keep at least the saved limit of ${previous[field.key] / field.unit}.`;
    else if (consumed && value <= consumed[field.consumed])
      errors[field.key] =
        `Increase this limit beyond the recorded usage of ${consumed[field.consumed] / field.unit}.`;
  }
  return errors;
}

function budgetInputs(budget: InvestigationBudget): BudgetInputs {
  return {
    maxRounds: String(budget.maxRounds),
    maxDurationMs: String(budget.maxDurationMs / 1000),
    maxTokens: String(budget.maxTokens),
    maxReportBytes: String(budget.maxReportBytes / (1024 * 1024)),
  };
}

export function ResumeTaskButton({
  task,
  checkpoint,
  disabled,
  disabledReason,
  onResumed,
}: {
  task: InvestigationTaskV1;
  checkpoint: InvestigationLoopCheckpointV1 | null;
  disabled: boolean;
  disabledReason?: string;
  onResumed: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [inputs, setInputs] = useState(() => budgetInputs(task.budget));
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<BudgetErrors>({});
  const formId = useId();
  const inputRefs = useRef<Partial<Record<keyof InvestigationBudget, HTMLInputElement | null>>>({});
  const guard = useGuardedAction();
  const dirty = open && JSON.stringify(inputs) !== JSON.stringify(budgetInputs(task.budget));
  useUnsavedChanges(dirty, {
    busy: open && busy,
    description:
      "Your unsaved resume budget will be discarded. The saved task budget remains available.",
    onDiscard: () => setOpen(false),
  });
  const close = () => {
    if (!busy) guard(() => setOpen(false));
  };
  const consumed = checkpoint?.consumed;
  const exhausted = fields.filter(
    (field) => consumed && consumed[field.consumed] >= task.budget[field.key],
  );
  const resume = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled || busy) return;
    setError(undefined);
    const errors = resumeBudgetErrors(inputs, task.budget, consumed);
    setFieldErrors(errors);
    const invalid = fields.find((field) => errors[field.key]);
    if (invalid) {
      inputRefs.current[invalid.key]?.focus();
      return;
    }
    setBusy(true);
    try {
      const budget = resumeBudget(inputs, task.budget, consumed);
      await investigationApi.resumeTask(task.id, idempotencyKey, budget);
      await onResumed();
      setOpen(false);
      setIdempotencyKey(crypto.randomUUID());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The investigation could not be resumed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        variant="outlined"
        disabled={disabled}
        onClick={() => {
          setInputs(budgetInputs(task.budget));
          setIdempotencyKey(crypto.randomUUID());
          setError(undefined);
          setFieldErrors({});
          setOpen(true);
        }}
      >
        {checkpoint ? "Resume investigation" : "Restart task"}
      </Button>
      <Dialog open={open} onClose={close} fullWidth maxWidth="sm">
        <DialogTitle>
          {checkpoint ? "Resume from the saved checkpoint" : "Restart this task"}
        </DialogTitle>
        <DialogContent dividers>
          <Box component="form" id={formId} onSubmit={(event) => void resume(event)} noValidate>
            <Stack spacing={2}>
              {disabled && (
                <Alert severity="warning">
                  {disabledReason ??
                    "Recovery is currently unavailable. Review this task's current permissions and resource ownership before continuing."}
                </Alert>
              )}
              {fields.some((field) => fieldErrors[field.key]) && (
                <Alert severity="error">
                  Check the budget fields before resuming.
                  <Stack sx={{ alignItems: "flex-start" }}>
                    {fields
                      .filter((field) => fieldErrors[field.key])
                      .map((field) => (
                        <Button
                          key={field.key}
                          size="small"
                          onClick={() => inputRefs.current[field.key]?.focus()}
                        >
                          {field.label}: {fieldErrors[field.key]}
                        </Button>
                      ))}
                  </Stack>
                </Alert>
              )}
              {task.state === "blocked" && (
                <Alert severity="warning">
                  Resolve the recorded prerequisite before restarting. A new attempt uses the saved
                  source; it does not repair the dependency.
                </Alert>
              )}
              <Typography variant="body2">
                The source, scope, profile, and prompt remain unchanged. You can increase the budget
                to continue unfinished work.
              </Typography>
              <Box component="dl" className="production-task-frozen-inputs">
                <Typography component="dt" variant="caption">
                  Frozen source
                </Typography>
                <Typography component="dd" variant="body2">
                  {task.subjectRef}
                </Typography>
                <Typography component="dt" variant="caption">
                  Profile / prompt
                </Typography>
                <Typography component="dd" variant="body2">
                  {task.profileRef.id} v{task.profileRef.version} / {task.promptRef.id} v
                  {task.promptRef.version}
                </Typography>
                {task.planRef && (
                  <>
                    <Typography component="dt" variant="caption">
                      Saved plan
                    </Typography>
                    <Typography component="dd" variant="body2">
                      {task.planRef.id} v{task.planRef.version}
                    </Typography>
                  </>
                )}
              </Box>
              {exhausted.length > 0 && (
                <Alert severity="warning">
                  A saved budget limit has been reached. Increase the exhausted limit before
                  resuming.
                  <Button
                    disabled={busy || disabled}
                    onClick={() => {
                      setInputs((previous) => {
                        const next = { ...previous };
                        for (const field of exhausted) {
                          const entered = Number(previous[field.key]) * field.unit;
                          next[field.key] = String(
                            Math.max(
                              Number.isFinite(entered) ? entered : 0,
                              task.budget[field.key] * 2,
                              (consumed?.[field.consumed] ?? 0) + field.unit,
                            ) / field.unit,
                          );
                        }
                        return next;
                      });
                      setIdempotencyKey(crypto.randomUUID());
                      setFieldErrors({});
                    }}
                  >
                    Increase exhausted limits
                  </Button>
                </Alert>
              )}
              {fields.map((field) => (
                <TextField
                  key={field.key}
                  id={`${formId}-${field.key}`}
                  inputRef={(input: HTMLInputElement | null) => {
                    inputRefs.current[field.key] = input;
                  }}
                  type="number"
                  disabled={busy || disabled}
                  error={!!fieldErrors[field.key]}
                  label={field.label}
                  value={inputs[field.key]}
                  slotProps={{ htmlInput: { min: task.budget[field.key] / field.unit } }}
                  onChange={(event) => {
                    setInputs((previous) => ({ ...previous, [field.key]: event.target.value }));
                    setIdempotencyKey(crypto.randomUUID());
                    setFieldErrors((previous) => ({ ...previous, [field.key]: undefined }));
                    setError(undefined);
                  }}
                  helperText={
                    fieldErrors[field.key] ??
                    `Saved limit: ${task.budget[field.key] / field.unit}${consumed ? ` · Already used: ${consumed[field.consumed] / field.unit}` : ""}`
                  }
                />
              ))}
              <Typography variant="caption" color="text.secondary">
                The server checks resource limits and records any budget increase before creating a
                new attempt.
              </Typography>
              {error && <Alert severity="error">{error}</Alert>}
            </Stack>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="contained" disabled={busy || disabled}>
            {busy ? "Resuming…" : "Resume with this budget"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
