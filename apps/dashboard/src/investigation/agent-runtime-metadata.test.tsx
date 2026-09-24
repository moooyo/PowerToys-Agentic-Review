import {
  type InvestigationModelInvocationReceipt,
  type InvestigationUsageSummary,
  unavailableInvestigationTokenUsage,
} from "@agentic-review/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentRuntimeMetadata, invocationUsageLabel } from "./agent-runtime-metadata";

const call: InvestigationModelInvocationReceipt = {
  invocationId: "call-one",
  taskId: "task-one",
  attemptId: "attempt-one",
  engine: "copilot",
  model: null,
  purpose: "analysis",
  startedAt: "2026-09-20T00:00:00Z",
  updatedAt: "2026-09-20T00:00:00Z",
  state: "registered",
  completeness: "unavailable",
  revision: 1,
  disposition: "pending",
  usage: unavailableInvestigationTokenUsage(),
};
const summary: InvestigationUsageSummary = {
  usage: unavailableInvestigationTokenUsage(),
  reportedTokens: 700,
  completeness: "partial",
  invocationCount: 2,
  activeInvocationCount: 1,
  unknownInvocationCount: 1,
  legacyTokens: 0,
};

describe("recorded runtime metadata", () => {
  it("distinguishes pending, unavailable, partial, and explicitly complete zero counters", () => {
    expect(invocationUsageLabel(undefined)).toBe("No call in this attempt");
    expect(invocationUsageLabel(call)).toBe("Awaiting usage");
    expect(invocationUsageLabel({ ...call, state: "cancelled" })).toBe("Usage unavailable");
    expect(
      invocationUsageLabel({
        ...call,
        state: "completed",
        completeness: "complete",
        usage: { ...call.usage, totalTokens: 0 },
      }),
    ).toBe("0 tokens");
    expect(
      invocationUsageLabel({
        ...call,
        completeness: "partial",
        usage: { ...call.usage, totalTokens: 100 },
      }),
    ).toBe("100+ tokens");
  });
  it("uses task reported totals and CLI defaults without inventing requested effort", () => {
    const html = renderToStaticMarkup(
      <AgentRuntimeMetadata
        taskId="task-one"
        attemptId="attempt-one"
        summary={summary}
        invocations={[call]}
      />,
    );
    expect(html).toContain("700+");
    expect(html).toContain("CLI default");
    expect(html).toContain("Not recorded");
    expect(html).toContain("awaiting usage");
    expect(html).not.toContain("High");
  });
  it("does not show another attempt's model in a selected attempt without a call", () => {
    const html = renderToStaticMarkup(
      <AgentRuntimeMetadata
        taskId="task-one"
        attemptId="attempt-two"
        summary={summary}
        invocations={[{ ...call, model: "only-attempt-one" }]}
      />,
    );
    expect(html).toContain("Not started");
    expect(html).toContain("700+");
    expect(html).not.toContain("only-attempt-one");
    expect(html).not.toContain("awaiting usage");
  });
  it("keeps compact task totals separate from the selected attempt's model and pending usage", () => {
    const html = renderToStaticMarkup(
      <AgentRuntimeMetadata
        taskId="task-one"
        attemptId="attempt-two"
        summary={summary}
        invocations={[{ ...call, model: "other-attempt-model" }]}
        compact
        actions={<button type="button">History</button>}
      />,
    );
    expect(html).toContain("700+");
    expect(html).toContain("History");
    expect(html).toContain("Inspect token usage and model settings");
    expect(html).not.toContain("other-attempt-model");
    expect(html).not.toContain("awaiting usage");
    expect(html).not.toContain("Reasoning effort");
  });
});
