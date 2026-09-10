import type { CliModelExecutionV1 } from "@agentic-review/contracts";
import { Typography } from "@mui/material";
import { DetailsGrid } from "@/components/ui";

export function CliExecutionDetails({ execution }: { execution: CliModelExecutionV1 | null }) {
  if (execution === null)
    return (
      <Typography variant="body2" color="text.secondary">
        No CLI execution metadata was recorded.
      </Typography>
    );
  return (
    <DetailsGrid
      columns={3}
      items={[
        {
          key: "cli",
          label: "CLI",
          value: execution.cli.kind === "codex" ? "Codex CLI" : "Copilot CLI",
        },
        { key: "version", label: "CLI version", value: execution.cli.version },
        {
          key: "model",
          label: "Requested model",
          value: execution.cli.requestedModel ?? "CLI default",
        },
      ]}
    />
  );
}
