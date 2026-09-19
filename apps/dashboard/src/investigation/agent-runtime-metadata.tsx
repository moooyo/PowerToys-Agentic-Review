import type {
  InvestigationModelInvocationReceipt,
  InvestigationUsageSummary,
} from "@agentic-review/contracts";
import InfoOutlined from "@mui/icons-material/InfoOutlined";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { latestAttemptInvocation } from "./task-output-state";
import { TokenUsagePanel, tokenCount, usageTotal } from "./usage-panel";

export function invocationUsageLabel(
  call: InvestigationModelInvocationReceipt | undefined,
): string {
  if (!call) return "No call in this attempt";
  if (call.usage.totalTokens !== null) {
    return `${tokenCount(call.usage.totalTokens)}${call.completeness === "partial" ? "+" : ""} tokens`;
  }
  return ["registered", "running"].includes(call.state) ? "Awaiting usage" : "Usage unavailable";
}

export function AgentRuntimeMetadata({
  taskId,
  attemptId,
  summary,
  invocations,
}: {
  taskId: string;
  attemptId?: string;
  summary?: InvestigationUsageSummary;
  invocations?: InvestigationModelInvocationReceipt[];
}) {
  const [open, setOpen] = useState(false);
  const call = latestAttemptInvocation(invocations, attemptId);
  const fields = [
    ["Task tokens", usageTotal(summary)],
    ["Requested model", call ? (call.model ?? "CLI default") : "Not started"],
    ["Reasoning effort", "Not recorded"],
  ];
  return (
    <>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: { xs: 2, sm: 3 },
          py: 1.5,
          borderBottom: 1,
          borderColor: "divider",
          bgcolor: "action.hover",
        }}
      >
        <Box
          component="dl"
          sx={{
            display: "grid",
            gridTemplateColumns: {
              xs: "repeat(2, minmax(0, 1fr))",
              sm: "repeat(3, minmax(0, 1fr))",
            },
            "@media (max-width: 359px)": { gridTemplateColumns: "minmax(0, 1fr)" },
            flex: 1,
            gap: { xs: 2, sm: 4 },
            m: 0,
            minWidth: 0,
          }}
        >
          {fields.map(([label, value]) => (
            <Box key={label} sx={{ minWidth: 0 }}>
              <Typography component="dt" variant="caption" color="text.secondary">
                {label}
              </Typography>
              <Typography
                component="dd"
                variant="body2"
                sx={{ m: 0, fontWeight: 500, overflowWrap: "anywhere" }}
              >
                {value}
              </Typography>
            </Box>
          ))}
        </Box>
        <Tooltip title="Usage and model settings">
          <IconButton
            aria-label="Inspect token usage and model settings"
            onClick={() => setOpen(true)}
            sx={{ alignSelf: "flex-start", flexShrink: 0, mt: 0.5 }}
          >
            <InfoOutlined fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
      {call && invocationUsageLabel(call) === "Awaiting usage" && (
        <Typography
          component="p"
          variant="caption"
          color="text.secondary"
          sx={{ m: 0, px: { xs: 2, sm: 3 }, py: 1 }}
        >
          Latest call: awaiting usage. The task total may increase when its receipt arrives.
        </Typography>
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        fullWidth
        maxWidth="md"
        aria-labelledby="task-usage-title"
      >
        <DialogTitle id="task-usage-title">Usage and model settings</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              Task totals include all attempts in {taskId}. The selected call belongs to{" "}
              {attemptId ?? "no started attempt"}.
            </Typography>
            <Box
              component="dl"
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr", sm: "180px minmax(0, 1fr)" },
                gap: 1,
                m: 0,
                "& dd": { m: 0, overflowWrap: "anywhere" },
                "& dt": { color: "text.secondary" },
              }}
            >
              <Typography component="dt" variant="body2">
                Latest selected call
              </Typography>
              <Typography component="dd" variant="body2">
                {invocationUsageLabel(call)}
              </Typography>
              <Typography component="dt" variant="body2">
                CLI
              </Typography>
              <Typography component="dd" variant="body2">
                {call ? (call.engine === "copilot" ? "Copilot CLI" : "Codex CLI") : "Not started"}
              </Typography>
              <Typography component="dt" variant="body2">
                Requested model
              </Typography>
              <Typography component="dd" variant="body2">
                {call ? (call.model ?? "CLI default") : "Not started"}
              </Typography>
              <Typography component="dt" variant="body2">
                Confirmed model
              </Typography>
              <Typography component="dd" variant="body2">
                Not recorded
              </Typography>
              <Typography component="dt" variant="body2">
                Requested effort
              </Typography>
              <Typography component="dd" variant="body2">
                Not recorded
              </Typography>
              <Typography component="dt" variant="body2">
                Confirmed effort
              </Typography>
              <Typography component="dd" variant="body2">
                Not recorded
              </Typography>
            </Box>
            <Typography variant="caption" color="text.secondary">
              A requested setting does not confirm what the CLI used. Missing counters are unknown;
              a + marks incomplete usage.
            </Typography>
            <TokenUsagePanel summary={summary} invocations={invocations} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
