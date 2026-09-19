import {
  type InvestigationModelInvocationReceipt,
  type InvestigationUsageSummary,
  unavailableInvestigationTokenUsage,
} from "@agentic-review/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TokenUsagePanel, tokenCount, UsageSummaryLabel, usageTotal } from "./usage-panel";

function summary(overrides: Partial<InvestigationUsageSummary> = {}): InvestigationUsageSummary {
  return {
    usage: {
      inputTokens: 1200,
      cachedReadTokens: 1000,
      outputTokens: 200,
      reasoningTokens: 100,
      cacheWriteTokens: null,
      totalTokens: 1400,
      providerCounters: {},
    },
    reportedTokens: 1400,
    completeness: "complete",
    invocationCount: 1,
    activeInvocationCount: 0,
    unknownInvocationCount: 0,
    legacyTokens: 0,
    ...overrides,
  };
}

describe("model token usage presentation", () => {
  it("uses the reported total without adding cache or reasoning subsets", () => {
    const value = summary();
    const html = renderToStaticMarkup(<TokenUsagePanel summary={value} />);
    expect(html).toContain("1,400 tokens");
    expect(html).toContain("Cached read · included in input");
    expect(html).toContain("Reasoning · included in output");
    expect(html).toContain("Unknown");
    expect(html).not.toContain("2,500 tokens");
  });

  it("does not turn missing usage into zero", () => {
    expect(tokenCount(null)).toBe("Unknown");
    expect(tokenCount(0)).toBe("0");
    expect(usageTotal(undefined)).toBe("Unknown");
    expect(usageTotal(summary({ completeness: "unavailable", reportedTokens: 0 }))).toBe("Unknown");
    const html = renderToStaticMarkup(<TokenUsagePanel />);
    expect(html).toContain("Unknown tokens");
    expect(html).toContain("Breakdown unavailable");
    expect(html).not.toContain("0 tokens");
    expect(usageTotal(summary({ reportedTokens: 0 }))).toBe("0");
  });

  it("keeps compact list usage truthful without repeating the breakdown label", () => {
    const unavailable = renderToStaticMarkup(<UsageSummaryLabel compact />);
    expect(unavailable).toContain("Usage unavailable");
    expect(unavailable).not.toContain("0 tokens");
    expect(unavailable).not.toContain("Breakdown unavailable");
    const partial = renderToStaticMarkup(
      <UsageSummaryLabel compact summary={summary({ completeness: "partial" })} />,
    );
    expect(partial).toContain("1,400+ tokens");
    const zero = renderToStaticMarkup(
      <UsageSummaryLabel compact summary={summary({ reportedTokens: 0 })} />,
    );
    expect(zero).toContain("0 tokens");
    expect(zero).not.toContain("Usage unavailable");
  });

  it("retains historical totals without inventing their breakdown", () => {
    const html = renderToStaticMarkup(<TokenUsagePanel legacyTokens={77004} scope="report" />);
    expect(html).toContain("77,004 tokens");
    expect(html).toContain("Breakdown unavailable");
    expect(html).toContain("immutable usage recorded when this report was sealed");
    expect(html).toContain("Later receipts and attempts appear in the task total");
  });

  it("distinguishes active calls and incomplete receipts from a complete total", () => {
    const value = summary({
      completeness: "partial",
      activeInvocationCount: 1,
      unknownInvocationCount: 2,
    });
    const html = renderToStaticMarkup(<TokenUsagePanel summary={value} active />);
    expect(html).toContain("1,400+ tokens");
    expect(html).toContain("final usage has not yet been reported");
    expect(html).toContain("not a complete consumption total");
    expect(renderToStaticMarkup(<UsageSummaryLabel summary={value} />)).toContain("Partial usage");
  });

  it("shows rejected and cancelled invocation usage with their exact attempt identity", () => {
    const call: InvestigationModelInvocationReceipt = {
      invocationId: "call-rejected",
      taskId: "task-1",
      attemptId: "attempt-cancelled",
      purpose: "analysis",
      engine: "codex",
      model: null,
      startedAt: "2026-09-19T01:00:00.000Z",
      updatedAt: "2026-09-19T01:01:00.000Z",
      revision: 2,
      state: "cancelled",
      disposition: "rejected",
      completeness: "unavailable",
      usage: unavailableInvestigationTokenUsage(),
    };
    const html = renderToStaticMarkup(<TokenUsagePanel summary={summary()} invocations={[call]} />);
    expect(html).toContain("call-rejected");
    expect(html).toContain("attempt-cancelled");
    expect(html).toContain("rejected");
    expect(html).toContain("Unknown");
    expect(html).toContain("cancelled calls");
    expect(html).toContain("CLI default");
    expect(html).toContain("(requested)");
  });
});
