import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OutputEventRow, outputAccessDenied, taskOutputQueryKey } from "./task-output";
import type { OutputItem } from "./task-output-state";
import { InvestigationHttpError } from "./transport";

const item: OutputItem = {
  schemaVersion: "InvestigationOutputEventV1",
  taskId: "task-one",
  attemptId: "attempt-one",
  invocationId: "call-one",
  producerSequence: 1,
  firstSequence: 1,
  updates: 1,
  cursor: "cursor-one",
  itemId: "tool-one",
  kind: "tool",
  operation: "replace",
  text: "Read visible file",
  command: "rg <unsafe>",
  result: "<script>alert(1)</script>",
  status: "completed",
  observedAt: "2026-09-20T00:00:00Z",
  receivedAt: "2026-09-20T00:00:00Z",
};
describe("shared visible output renderer", () => {
  it("renders tool commands and results as text without executing markup", () => {
    const html = renderToStaticMarkup(<OutputEventRow item={item} />);
    expect(html).toContain("rg &lt;unsafe&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("completed");
    expect(html).not.toContain("<script>");
  });
  it("keeps normal messages visible and expands only a long payload", () => {
    const html = renderToStaticMarkup(
      <OutputEventRow
        item={{
          ...item,
          kind: "assistant",
          text: "Visible assistant reply",
          command: undefined,
          result: undefined,
        }}
      />,
    );
    expect(html).toContain("Visible assistant reply");
    expect(html).not.toContain("Expand content");
    const long = renderToStaticMarkup(
      <OutputEventRow item={{ ...item, result: "x".repeat(5_000) }} />,
    );
    expect(long).toContain("Expand content");
    expect(long).not.toContain("x".repeat(5_000));
  });
  it("isolates output caches by session, task, and attempt and identifies revoked reads", () => {
    const key = taskOutputQueryKey("session-one", "task-one", "attempt-one");
    expect(key).not.toEqual(taskOutputQueryKey("session-two", "task-one", "attempt-one"));
    expect(key).not.toEqual(taskOutputQueryKey("session-one", "task-two", "attempt-one"));
    expect(key).not.toEqual(taskOutputQueryKey("session-one", "task-one", "attempt-two"));
    expect(outputAccessDenied(new InvestigationHttpError(403, "Revoked"))).toBe(true);
    expect(outputAccessDenied(new InvestigationHttpError(401, "Expired"))).toBe(true);
    expect(outputAccessDenied(new InvestigationHttpError(500, "Disconnected"))).toBe(false);
  });
});
