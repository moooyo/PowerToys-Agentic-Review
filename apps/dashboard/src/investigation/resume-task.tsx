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
  const consumed = checkpoint?.consumed;
  const exhausted = fields.filter(
    (field) => consumed && consumed[field.consumed] >= task.budget[field.key],
  );
  const resume = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const budget = resumeBudget(inputs, task.budget);
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
        Resume investigation
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Resume from the saved checkpoint</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Typography variant="body2">
              The source, scope, profile, and prompt remain unchanged. You can increase the budget
              to continue unfinished work.
            </Typography>
            {exhausted.length > 0 && (
              <Alert severity="warning">
                A saved budget limit has been reached. Increase the exhausted limit before resuming.
                <Button
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
                label={field.label}
                value={inputs[field.key]}
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
          <Button disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="contained" disabled={busy} onClick={() => void resume()}>
            {busy ? "Resuming…" : "Resume with this budget"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
