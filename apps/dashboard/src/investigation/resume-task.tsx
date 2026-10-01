import {
  getInvestigationExecutionDurationLimitMs,
  type InvestigationBudget,
  type InvestigationLoopCheckpointV1,
  type InvestigationTaskV1,
  normalizeInvestigationBudget,
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

type BudgetInputs = Record<"maxReportBytes", string>;
type BudgetErrors = Partial<Record<"maxReportBytes" | "execution", string>>;
const fields: {
  key: "maxReportBytes";
  consumed: "reportBytes";
  label: string;
  unit: number;
}[] = [
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
  deliveryOnly = false,
): InvestigationBudget {
  if (
    !deliveryOnly &&
    consumed &&
    consumed.durationMs >= getInvestigationExecutionDurationLimitMs()
  )
    throw new Error(
      "The 2-hour total execution limit is exhausted. It cannot be reset or extended.",
    );
  const value = {
    ...normalizeInvestigationBudget(previous),
    maxReportBytes: Number(inputs.maxReportBytes) * 1024 * 1024,
  };
  for (const field of fields) {
    if (
      !Number.isSafeInteger(value[field.key]) ||
      value[field.key] < previous[field.key] ||
      value[field.key] <= 0
    )
      throw new Error("The report size limit must be positive and cannot reduce the saved limit.");
    if (consumed && consumed[field.consumed] > value[field.key])
      throw new Error(
        "Increase the report size limit to cover its recorded usage before resuming.",
      );
  }
  return value;
}

export function resumeBudgetRevision(
  inputs: BudgetInputs,
  previous: InvestigationBudget,
  consumed?: InvestigationLoopCheckpointV1["consumed"],
  deliveryOnly = false,
): InvestigationBudget | undefined {
  const prepared = resumeBudget(inputs, previous, consumed, deliveryOnly);
  return prepared.maxReportBytes === previous.maxReportBytes ? undefined : prepared;
}

export function resumeBudgetErrors(
  inputs: BudgetInputs,
  previous: InvestigationBudget,
  consumed?: InvestigationLoopCheckpointV1["consumed"],
  deliveryOnly = false,
): BudgetErrors {
  const errors: BudgetErrors = {};
  if (
    !deliveryOnly &&
    consumed &&
    consumed.durationMs >= getInvestigationExecutionDurationLimitMs()
  )
    errors.execution =
      "The 2-hour total execution limit is exhausted. It cannot be reset or extended.";
  for (const field of fields) {
    const value = Number(inputs[field.key]) * field.unit;
    if (!inputs[field.key].trim() || !Number.isSafeInteger(value) || value <= 0)
      errors[field.key] = "Enter a positive limit that resolves to a whole number of base units.";
    else if (value < previous[field.key])
      errors[field.key] = `Keep at least the saved limit of ${previous[field.key] / field.unit}.`;
    else if (consumed && value < consumed[field.consumed])
      errors[field.key] =
        `Increase this limit to cover the recorded usage of ${consumed[field.consumed] / field.unit}.`;
  }
  return errors;
}

function budgetInputs(budget: InvestigationBudget): BudgetInputs {
  return {
    maxReportBytes: String(budget.maxReportBytes / (1024 * 1024)),
  };
}

export function investigationExecutionDurationExhausted(
  checkpoint: Pick<InvestigationLoopCheckpointV1, "consumed" | "stopReason"> | null,
): boolean {
  return (
    checkpoint !== null &&
    checkpoint.stopReason !== "complete" &&
    checkpoint.consumed.durationMs >= getInvestigationExecutionDurationLimitMs()
  );
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
  const inputRefs = useRef<Partial<Record<"maxReportBytes", HTMLInputElement | null>>>({});
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
  const durationExhausted = investigationExecutionDurationExhausted(checkpoint);
  const unavailable = disabled || durationExhausted;
  const exhausted = fields.filter(
    (field) => consumed && consumed[field.consumed] > task.budget[field.key],
  );
  const resume = async (event: FormEvent) => {
    event.preventDefault();
    if (unavailable || busy) return;
    setError(undefined);
    const errors = resumeBudgetErrors(
      inputs,
      task.budget,
      consumed,
      checkpoint?.stopReason === "complete",
    );
    setFieldErrors(errors);
    const invalid = fields.find((field) => errors[field.key]);
    if (invalid) {
      inputRefs.current[invalid.key]?.focus();
      return;
    }
    if (errors.execution) return;
    setBusy(true);
    try {
      const budget = resumeBudgetRevision(
        inputs,
        task.budget,
        consumed,
        checkpoint?.stopReason === "complete",
      );
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
        disabled={unavailable}
        title={
          durationExhausted
            ? "The 2-hour total execution limit is exhausted. It cannot be reset or extended."
            : disabledReason
        }
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
              {unavailable && (
                <Alert severity="warning">
                  {durationExhausted
                    ? "The 2-hour total execution limit is exhausted. It cannot be reset or extended."
                    : (disabledReason ??
                      "Recovery is currently unavailable. Review this task's current permissions and resource ownership before continuing.")}
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
              {fieldErrors.execution && <Alert severity="error">{fieldErrors.execution}</Alert>}
              {task.state === "blocked" && (
                <Alert severity="warning">
                  Resolve the recorded prerequisite before restarting. A new attempt uses the saved
                  source; it does not repair the dependency.
                </Alert>
              )}
              <Typography variant="body2">
                Execution has a fixed 2-hour total limit across all attempts. Resuming keeps the
                time already used. You can increase the report size limit when needed.
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
                  The saved report size limit has been exceeded. Increase it before resuming.
                  <Button
                    disabled={busy || unavailable}
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
                    Increase report size limit
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
                  disabled={busy || unavailable}
                  error={!!fieldErrors[field.key]}
                  label={field.label}
                  value={inputs[field.key]}
                  slotProps={{
                    htmlInput: { min: task.budget[field.key] / field.unit, step: "any" },
                  }}
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
                Tokens and rounds are recorded without limiting execution. The server checks the
                report size and records any increase before creating a new attempt.
              </Typography>
              {error && <Alert severity="error">{error}</Alert>}
            </Stack>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="contained" disabled={busy || unavailable}>
            {busy ? "Resuming…" : "Resume investigation"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
