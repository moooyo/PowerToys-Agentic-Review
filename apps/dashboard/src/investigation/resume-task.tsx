import type {
  InvestigationBudget,
  InvestigationLoopCheckpointV1,
  InvestigationTaskV1,
} from "@agentic-review/contracts";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { investigationApi } from "./api";
import { useGuardedAction, useUnsavedChanges } from "./navigation-guard";

type BudgetInputs = Record<keyof InvestigationBudget, string>;
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
  }
  return value;
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
  onResumed,
}: {
  task: InvestigationTaskV1;
  checkpoint: InvestigationLoopCheckpointV1 | null;
  disabled: boolean;
  onResumed: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [inputs, setInputs] = useState(() => budgetInputs(task.budget));
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
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
  const resume = async () => {
    if (disabled || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const budget = resumeBudget(inputs, task.budget);
      if (fields.some((field) => consumed && consumed[field.consumed] >= budget[field.key])) {
        throw new Error("Increase each exhausted limit beyond its recorded usage before resuming.");
      }
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
          <Stack spacing={2}>
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
            {exhausted.length > 0 && (
              <Alert severity="warning">
                A saved budget limit has been reached. Increase the exhausted limit before resuming.
                <Button
                  disabled={busy}
                  onClick={() => {
                    setInputs((previous) => {
                      const next = { ...previous };
                      for (const field of exhausted) {
                        const entered = Number(previous[field.key]) * field.unit;
                        next[field.key] = String(
                          Math.max(
                            Number.isFinite(entered) ? entered : 0,
                            task.budget[field.key] * 2,
                          ) / field.unit,
                        );
                      }
                      return next;
                    });
                    setIdempotencyKey(crypto.randomUUID());
                  }}
                >
                  Double exhausted limits
                </Button>
              </Alert>
            )}
            {fields.map((field) => (
              <TextField
                key={field.key}
                type="number"
                disabled={busy}
                label={field.label}
                value={inputs[field.key]}
                slotProps={{ htmlInput: { min: task.budget[field.key] / field.unit } }}
                onChange={(event) => {
                  setInputs((previous) => ({ ...previous, [field.key]: event.target.value }));
                  setIdempotencyKey(crypto.randomUUID());
                }}
                helperText={`Saved limit: ${task.budget[field.key] / field.unit}${consumed ? ` · Already used: ${consumed[field.consumed] / field.unit}` : ""}`}
              />
            ))}
            <Typography variant="caption" color="text.secondary">
              The server checks resource limits and records any budget increase before creating a
              new attempt.
            </Typography>
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button variant="contained" disabled={busy || disabled} onClick={() => void resume()}>
            {busy ? "Resuming…" : "Resume with this budget"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
