import { Divider, FormControlLabel, Stack, Switch, TextField, Typography } from "@mui/material";
import { createContext, type ReactNode, useContext } from "react";
import type { SchedulingLimitValues } from "./form";

interface SchedulingLimitFieldState {
  values: SchedulingLimitValues;
  onChange: (values: SchedulingLimitValues) => void;
  disabled?: boolean;
}

const SchedulingLimitContext = createContext<SchedulingLimitFieldState | null>(null);

export function SchedulingLimitFieldsProvider({
  children,
  ...value
}: SchedulingLimitFieldState & { children: ReactNode }) {
  return (
    <SchedulingLimitContext.Provider value={value}>{children}</SchedulingLimitContext.Provider>
  );
}

export function SchedulingLimitFields() {
  const state = useContext(SchedulingLimitContext);
  if (!state) throw new Error("Scheduling limit fields require a draft provider.");
  const { values, onChange, disabled } = state;
  const update = <K extends keyof SchedulingLimitValues>(key: K, value: SchedulingLimitValues[K]) =>
    onChange({ ...values, [key]: value });
  return (
    <Stack spacing={3}>
      <Stack spacing={2}>
        <FormControlLabel
          label="Active leases: unlimited at this scope"
          control={
            <Switch
              checked={values.activeUnlimited}
              disabled={disabled}
              onChange={(_, checked) => update("activeUnlimited", checked)}
            />
          }
        />
        {!values.activeUnlimited && (
          <TextField
            label="Maximum active leases"
            required
            fullWidth
            value={values.activeLimit}
            disabled={disabled}
            onChange={(event) => update("activeLimit", event.target.value)}
            slotProps={{ htmlInput: { inputMode: "numeric", maxLength: 5 } }}
            helperText="Counts leased and running attempts, including cancellation requests and expired leases that have not been reaped."
          />
        )}
      </Stack>
      <Divider />
      <Stack spacing={2}>
        <FormControlLabel
          label="Admitted queue: unlimited at this scope"
          control={
            <Switch
              checked={values.queueUnlimited}
              disabled={disabled}
              onChange={(_, checked) => update("queueUnlimited", checked)}
            />
          }
        />
        {!values.queueUnlimited && (
          <TextField
            label="Maximum admitted queued jobs"
            required
            fullWidth
            value={values.queueLimit}
            disabled={disabled}
            onChange={(event) => update("queueLimit", event.target.value)}
            slotProps={{ htmlInput: { inputMode: "numeric", maxLength: 7 } }}
            helperText="Counts admitted jobs waiting to start or retry. Accepted jobs awaiting admission remain saved and cancellable."
          />
        )}
      </Stack>
      <Typography variant="body2" color="text.secondary">
        Lowering a limit below current usage is allowed. Existing work continues; new admission or
        lease grants wait for capacity. Queue limits do not cap accepted job records, storage, or
        spending.
      </Typography>
    </Stack>
  );
}
