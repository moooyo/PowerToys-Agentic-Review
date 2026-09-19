import { describe, expect, it, vi } from "vitest";
import type { WorkItem } from "./api";
import { createSampleInvestigationApi } from "./sample-adapter";
import {
  clearInvestigationRequest,
  initialInvestigationInputs,
  investigationInputErrors,
  investigationRequest,
  investigationRequestScope,
  type RetainedInvestigationRequest,
  retainedInvestigationRequest,
  retainInvestigationRequest,
  submitInvestigationRequest,
  subscribeInvestigationRequest,
} from "./start-investigation-state";
import { InvestigationHttpError } from "./transport";

async function fixture() {
  const api = createSampleInvestigationApi();
  const { task } = await api.task("sample-pr-p1-task");
  const source = await api.workItem(task.workItem.id);
  const inputs = initialInvestigationInputs(source, task.budget);
  const request: RetainedInvestigationRequest = {
    input: investigationRequest(source, inputs, "stable-create-key"),
    inputs,
    source,
    state: "pending",
  };
  const returned = { ...task, executionPolicy: { ...task.executionPolicy, mode: inputs.mode } };
  return { source, task: returned, request };
}

describe("investigation submission recovery", () => {
  it.each(["pending", "unknown"] as const)(
    "does not submit a retained illegal PR snapshot-only request in %s state",
    async (state) => {
      const { request } = await fixture();
      const scope = investigationRequestScope(`legacy-pr-${state}`, request.source.id);
      const illegal: RetainedInvestigationRequest = {
        ...request,
        state,
        inputs: { ...request.inputs, mode: "snapshot_only" },
        input: { ...request.input, executionMode: "snapshot_only" },
      };
      retainInvestigationRequest(scope, illegal);
      const send = vi.fn();
      await expect(submitInvestigationRequest(scope, request, send)).rejects.toThrow(
        "Snapshot-only investigation is reserved for Issue analysis",
      );
      expect(send).not.toHaveBeenCalled();
      expect(retainedInvestigationRequest(scope)).toBe(illegal);
      clearInvestigationRequest(scope);
    },
  );

  it("coalesces duplicate clicks while the first create request is pending", async () => {
    const { request, task } = await fixture();
    const scope = investigationRequestScope("double-click-account", request.source.id);
    let resolve!: (result: typeof task) => void;
    const send = vi.fn(
      () =>
        new Promise<typeof task>((done) => {
          resolve = done;
        }),
    );
    const first = submitInvestigationRequest(scope, request, send);
    const second = submitInvestigationRequest(scope, request, send);
    expect(first).toBe(second);
    expect(retainedInvestigationRequest(scope)?.state).toBe("pending");
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    resolve(task);
    await expect(first).resolves.toEqual(task);
    expect(retainedInvestigationRequest(scope)?.state).toBe("confirmed");
    clearInvestigationRequest(scope);
  });

  it("replays the original request after a lost response and a new dialog draft", async () => {
    const { request, task } = await fixture();
    const scope = investigationRequestScope("lost-response-account", request.source.id);
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce(task);
    await expect(submitInvestigationRequest(scope, request, send)).rejects.toThrow(
      "Connection lost",
    );
    expect(retainedInvestigationRequest(scope)?.state).toBe("unknown");
    const newDraft = {
      ...request,
      input: {
        ...request.input,
        idempotencyKey: "must-not-be-used",
        executionMode: "snapshot_only" as const,
      },
    };
    await expect(submitInvestigationRequest(scope, newDraft, send)).resolves.toEqual(task);
    expect(send.mock.calls[0]?.[0]).toEqual(request.input);
    expect(send.mock.calls[1]?.[0]).toEqual(request.input);
    clearInvestigationRequest(scope);
  });

  it("does not repeat a confirmed create when a remounted dialog opens the saved request", async () => {
    const { request, task } = await fixture();
    const scope = investigationRequestScope("confirmed-account", request.source.id);
    const send = vi.fn().mockResolvedValue(task);
    await submitInvestigationRequest(scope, request, send);
    await submitInvestigationRequest(scope, request, send);
    expect(send).toHaveBeenCalledTimes(1);
    clearInvestigationRequest(scope);
  });

  it("clears an initial definite rejection but retains an uncertain retry rejection", async () => {
    const { request } = await fixture();
    const scope = investigationRequestScope("conflict-account", request.source.id);
    const rejected = vi.fn().mockRejectedValue(new InvestigationHttpError(409, "Source changed"));
    await expect(submitInvestigationRequest(scope, request, rejected)).rejects.toThrow(
      "Source changed",
    );
    expect(retainedInvestigationRequest(scope)).toBeUndefined();
    await expect(
      submitInvestigationRequest(
        scope,
        request,
        vi.fn().mockRejectedValue(new Error("Response lost")),
      ),
    ).rejects.toThrow();
    await expect(submitInvestigationRequest(scope, request, rejected)).rejects.toThrow();
    expect(retainedInvestigationRequest(scope)?.state).toBe("unknown");
    expect(retainedInvestigationRequest(scope)?.input.idempotencyKey).toBe("stable-create-key");
    clearInvestigationRequest(scope);
  });

  it("retains mismatched task receipts without repeating creation and isolates account identities", async () => {
    const { request, task } = await fixture();
    const scope = investigationRequestScope("first-account", request.source.id);
    const other = investigationRequestScope("second-account", request.source.id);
    const mismatched = { ...task, workItem: { ...task.workItem, id: "other-work-item" } };
    const send = vi.fn().mockResolvedValue(mismatched);
    await expect(submitInvestigationRequest(scope, request, send)).rejects.toThrow(
      "does not match",
    );
    expect(retainedInvestigationRequest(scope)).toMatchObject({
      state: "mismatch",
      task: mismatched,
    });
    await expect(submitInvestigationRequest(scope, request, send)).rejects.toThrow(
      "does not match",
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(retainedInvestigationRequest(other)).toBeUndefined();
    clearInvestigationRequest(scope);
  });

  it("notifies a remounted dialog when an in-flight request becomes confirmed", async () => {
    const { request, task } = await fixture();
    const scope = investigationRequestScope("remounted-account", request.source.id);
    let resolve!: (result: typeof task) => void;
    const pending = submitInvestigationRequest(
      scope,
      request,
      () =>
        new Promise<typeof task>((done) => {
          resolve = done;
        }),
    );
    const states: string[] = [];
    const unsubscribe = subscribeInvestigationRequest(scope, () =>
      states.push(retainedInvestigationRequest(scope)?.state ?? "cleared"),
    );
    await Promise.resolve();
    resolve(task);
    await pending;
    expect(states).toEqual(["confirmed"]);
    unsubscribe();
    clearInvestigationRequest(scope);
  });
});

describe("investigation access and budget", () => {
  it("rejects snapshot-only PR access before constructing a request", async () => {
    const { source, request } = await fixture();
    const inputs = { ...request.inputs, mode: "snapshot_only" as const };
    expect(investigationInputErrors(source, inputs).mode).toContain(
      "Pull request reviews require exact source access",
    );
    expect(() => investigationRequest(source, inputs, "illegal-pr-mode")).toThrow(
      "Snapshot-only investigation is reserved for Issue analysis",
    );
  });

  it("uses server defaults when no custom budget is selected", async () => {
    const { source, task } = await fixture();
    const request = investigationRequest(
      source,
      initialInvestigationInputs(source, task.budget),
      "default-budget",
    );
    expect(request.budget).toBeUndefined();
    expect(request.executionMode).toBe("source_read");
    expect(request.expectedSubjectRevisionKey).toBe(source.subject.revisionKey);
  });

  it("preserves the configured report size when custom limits change", async () => {
    const { source, task } = await fixture();
    const defaults = { ...task.budget, maxReportBytes: 27_456_789 };
    const request = investigationRequest(
      source,
      {
        ...initialInvestigationInputs(source, defaults),
        customBudget: true,
        tokens: "8000000",
        rounds: "6",
        minutes: "60",
      },
      "custom-budget",
      defaults,
    );
    expect(request.budget).toEqual({
      maxTokens: 8_000_000,
      maxRounds: 6,
      maxDurationMs: 3_600_000,
      maxReportBytes: 27_456_789,
    });
  });

  it("requires an exact issue commit only for source access", async () => {
    const { source } = await fixture();
    const issue: WorkItem = { ...source, kind: "issue" };
    const inputs = {
      ...initialInvestigationInputs(issue),
      mode: "source_read" as const,
      sourceCommit: "main",
    };
    expect(investigationInputErrors(issue, inputs)).toHaveProperty("sourceCommit");
    expect(
      investigationRequest(issue, { ...inputs, sourceCommit: "A".repeat(40) }, "issue-source")
        .sourceCommit,
    ).toBe("a".repeat(40));
    expect(
      investigationRequest(issue, { ...inputs, mode: "snapshot_only" }, "issue-snapshot")
        .sourceCommit,
    ).toBeUndefined();
  });

  it("rejects invalid custom limits before any submission", async () => {
    const { source, task } = await fixture();
    const inputs = {
      ...initialInvestigationInputs(source, task.budget),
      customBudget: true,
      tokens: "0",
      rounds: "1.5",
      minutes: "Infinity",
    };
    expect(Object.keys(investigationInputErrors(source, inputs, task.budget)).sort()).toEqual([
      "minutes",
      "rounds",
      "tokens",
    ]);
    expect(() => investigationRequest(source, inputs, "invalid", task.budget)).toThrow();
  });
});
