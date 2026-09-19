import type {
  InvestigationModelInvocationReceipt,
  InvestigationUsageSummary,
} from "@agentic-review/contracts";
import ExpandMoreRounded from "@mui/icons-material/ExpandMoreRounded";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Chip,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { Section } from "./report-sections";

export function tokenCount(value: number | null | undefined): string {
  return value === null || value === undefined ? "Unknown" : value.toLocaleString("en-US");
}

export function usageTotal(
  summary: InvestigationUsageSummary | undefined,
  legacyTokens?: number,
): string {
  if (!summary)
    return legacyTokens === undefined || legacyTokens === 0 ? "Unknown" : tokenCount(legacyTokens);
  if (summary.completeness === "unavailable" && summary.reportedTokens === 0) return "Unknown";
  return `${tokenCount(summary.reportedTokens)}${summary.completeness === "partial" ? "+" : ""}`;
}

export function UsageSummaryLabel({ summary }: { summary?: InvestigationUsageSummary }) {
  return (
    <Box>
      <Typography variant="body2">{usageTotal(summary)} tokens</Typography>
      <Typography variant="caption" color="text.secondary">
        {summary?.completeness === "complete"
          ? "Reported usage"
          : summary?.completeness === "partial"
            ? "Partial usage"
            : "Breakdown unavailable"}
      </Typography>
    </Box>
  );
}

export function TokenUsagePanel({
  summary,
  invocations,
  legacyTokens,
  scope = "task",
  active = false,
}: {
  summary?: InvestigationUsageSummary;
  invocations?: InvestigationModelInvocationReceipt[];
  legacyTokens?: number;
  scope?: "task" | "report";
  active?: boolean;
}) {
  const usage = summary?.usage;
  const breakdown =
    usage &&
    [
      usage.inputTokens,
      usage.cachedReadTokens,
      usage.outputTokens,
      usage.reasoningTokens,
      usage.cacheWriteTokens,
    ].some((count) => count !== null);
  const fields = [
    ["Input", usage?.inputTokens],
    ["Cached read · included in input", usage?.cachedReadTokens],
    ["Output", usage?.outputTokens],
    ["Reasoning · included in output", usage?.reasoningTokens],
    ["Cache write · provider reported", usage?.cacheWriteTokens],
  ] as const;
  return (
    <Section title={scope === "task" ? "Task token usage" : "Token usage at report sealing"}>
      <Stack spacing={2}>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap" }}
        >
          <Typography variant="h5">{usageTotal(summary, legacyTokens)} tokens</Typography>
          <Chip
            size="small"
            variant="outlined"
            label={
              summary?.completeness === "complete"
                ? "Complete reported usage"
                : summary?.completeness === "partial"
                  ? "Partial usage"
                  : "Breakdown unavailable"
            }
          />
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {scope === "task"
            ? "Includes reported consumption across all attempts, including rejected, failed, and cancelled calls."
            : "This is the immutable usage recorded when this report was sealed. Later receipts and attempts appear in the task total."}
        </Typography>
        {breakdown ? (
          <Box
            component="dl"
            sx={{
              display: "grid",
              gridTemplateColumns: {
                xs: "1fr",
                sm: "repeat(2, minmax(0, 1fr))",
                lg: "repeat(3, minmax(0, 1fr))",
              },
              gap: 2,
              m: 0,
            }}
          >
            {fields.map(([label, count]) => (
              <Box key={label}>
                <Typography component="dt" variant="caption" color="text.secondary">
                  {label}
                </Typography>
                <Typography component="dd" sx={{ m: 0 }}>
                  {tokenCount(count)}
                </Typography>
              </Box>
            ))}
          </Box>
        ) : (
          <Typography variant="body2">
            Breakdown unavailable. Missing counters are unknown, not zero.
          </Typography>
        )}
        {breakdown && (
          <Typography variant="caption" color="text.secondary">
            Total is input plus output. Cached read and reasoning are subsets and are not added
            again. Unknown counters were not reported.
          </Typography>
        )}
        {(summary?.activeInvocationCount ?? 0) > 0 ? (
          <Alert severity="info">
            {summary!.activeInvocationCount} model call(s) are still active. Their final usage has
            not yet been reported; this total may increase.
          </Alert>
        ) : active ? (
          <Typography variant="caption" color="text.secondary">
            Usage updates when model receipts arrive. Worker activity alone does not establish token
            consumption.
          </Typography>
        ) : null}
        {(summary?.unknownInvocationCount ?? 0) > 0 && (
          <Alert severity="warning">
            {summary!.unknownInvocationCount} call(s) have incomplete usage. The reported total is
            not a complete consumption total.
          </Alert>
        )}
        {(summary?.legacyTokens ?? 0) > 0 && (
          <Typography variant="caption" color="text.secondary">
            Includes {tokenCount(summary!.legacyTokens)} previously recorded tokens with no
            invocation breakdown.
          </Typography>
        )}
        {summary && (
          <Typography variant="body2">{summary.invocationCount} model calls recorded</Typography>
        )}
        {invocations && invocations.length > 0 && (
          <Accordion disableGutters elevation={0}>
            <AccordionSummary expandIcon={<ExpandMoreRounded />}>
              <Typography>Model call details ({invocations.length})</Typography>
            </AccordionSummary>
            <AccordionDetails>
              <TableContainer>
                <Table size="small" aria-label="Model invocation token usage">
                  <TableHead>
                    <TableRow>
                      {[
                        "Call / attempt",
                        "State",
                        "Input",
                        "Cached read",
                        "Output",
                        "Reasoning",
                        "Cache write",
                        "Total",
                      ].map((heading) => (
                        <TableCell key={heading}>{heading}</TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {invocations.map((call) => (
                      <TableRow key={call.invocationId}>
                        <TableCell sx={{ maxWidth: 300, overflowWrap: "anywhere" }}>
                          <Typography variant="body2">
                            {call.purpose} · {call.model ?? call.engine}
                          </Typography>
                          <Typography variant="caption" component="div">
                            Call {call.invocationId}
                          </Typography>
                          <Typography variant="caption" component="div">
                            Attempt {call.attemptId}
                          </Typography>
                          <Typography variant="caption" component="div">
                            {new Date(call.startedAt).toLocaleString()}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          {call.state}
                          <Typography variant="caption" component="div">
                            {call.disposition} · {call.completeness}
                          </Typography>
                        </TableCell>
                        <TableCell>{tokenCount(call.usage.inputTokens)}</TableCell>
                        <TableCell>{tokenCount(call.usage.cachedReadTokens)}</TableCell>
                        <TableCell>{tokenCount(call.usage.outputTokens)}</TableCell>
                        <TableCell>{tokenCount(call.usage.reasoningTokens)}</TableCell>
                        <TableCell>{tokenCount(call.usage.cacheWriteTokens)}</TableCell>
                        <TableCell>{tokenCount(call.usage.totalTokens)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </AccordionDetails>
          </Accordion>
        )}
      </Stack>
    </Section>
  );
}
