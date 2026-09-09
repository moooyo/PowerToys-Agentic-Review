import type { CliModelExecutionV1 } from "@agentic-review/contracts";
import { Descriptions, Typography } from "antd";

export function CliExecutionDetails({ execution }: { execution: CliModelExecutionV1 | null }) {
  if (execution === null)
    return (
      <Typography.Text type="secondary">No CLI execution metadata was recorded.</Typography.Text>
    );
  return (
    <Descriptions
      size="small"
      column={{ xs: 1, sm: 3 }}
      items={[
        {
          key: "cli",
          label: "CLI",
          children: execution.cli.kind === "codex" ? "Codex CLI" : "Copilot CLI",
        },
        { key: "version", label: "CLI version", children: execution.cli.version },
        {
          key: "model",
          label: "Requested model",
          children: execution.cli.requestedModel ?? "CLI default",
        },
      ]}
    />
  );
}
