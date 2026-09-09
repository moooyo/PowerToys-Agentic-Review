import { describe, expect, it, vi } from "vitest";
import {
  sourceSummaryFixture,
  suiteSaveRequestFixture,
} from "@/services/evaluations/fixtures.testing";
import {
  ReviewControlHttpError,
  ReviewControlNetworkError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
} from "@/services/review-control/errors";
import {
  accessDenied,
  changeAnnotation,
  collectCatalog,
  newCase,
  newCriterion,
  nextAccessBinding,
  OriginalMutation,
  permissionSignature,
  workflowKind,
} from "./state";

const httpError = (status: number) =>
  new ReviewControlHttpError("The request was rejected.", {
    operation: "fixture",
    retryable: status >= 500,
    status,
  });
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

describe("evaluation editor identity and expectations", () => {
  it("creates stable case and criterion identities with unlabeled finding expectations", () => {
    const source = sourceSummaryFixture();
    const entry = newCase(source, "stable-case");
    const criterion = newCriterion("stable-criterion");
    expect(entry.caseId).toBe("stable-case");
    expect(entry.sourceId).toBe(source.id);
    expect(entry.findings).toEqual({ annotation: "unlabeled", expected: [] });
    expect(criterion.criterionId).toBe("stable-criterion");
    expect({
      ...entry,
      title: "Edited title",
      criteria: [{ ...criterion, description: "Edited criterion" }],
    }).toMatchObject({
      caseId: "stable-case",
      sourceId: source.id,
      criteria: [{ criterionId: "stable-criterion" }],
    });
  });
  it("does not confuse a complete negative example with a partial or unlabeled one", () => {
    expect(changeAnnotation({ annotation: "unlabeled", expected: [] }, "complete")).toEqual({
      annotation: "complete",
      expected: [],
    });
    expect(changeAnnotation({ annotation: "complete", expected: [] }, "partial")).toEqual({
      annotation: "partial",
      expected: [],
    });
    const findings = {
      annotation: "partial" as const,
      expected: [{ expectedFindingId: "finding-1", description: "Known defect" }],
    };
    const complete = changeAnnotation(findings, "complete");
    expect(complete.expected).toEqual(findings.expected);
    expect(complete.expected).not.toBe(findings.expected);
    expect(() => changeAnnotation(findings, "unlabeled")).toThrow(/Remove expected findings/u);
    expect(findings.expected[0]?.expectedFindingId).toBe("finding-1");
  });
  it("keeps PR and Issue workflows in separate groups", () => {
    expect([workflowKind("pr_static_build"), workflowKind("pr_ui")]).toEqual([
      "pull_request",
      "pull_request",
    ]);
    expect([workflowKind("issue_triage"), workflowKind("issue_validation")]).toEqual([
      "issue",
      "issue",
    ]);
  });
  it("preserves a verified permission binding during checking and replaces it only on real changes", () => {
    const verified = { identity: "operator-a/repo-a", permissions: "configure" };
    expect(nextAccessBinding(verified, verified.identity, null)).toBe(verified);
    expect(nextAccessBinding(verified, verified.identity, "configure")).toBe(verified);
    expect(nextAccessBinding(verified, verified.identity, "read")).toEqual({
      ...verified,
      permissions: "read",
    });
    expect(nextAccessBinding(verified, "operator-b/repo-a", null)).toEqual({
      identity: "operator-b/repo-a",
      permissions: null,
    });
    expect(nextAccessBinding(verified, "operator-a/repo-b", "configure")).not.toBe(verified);
  });
  it("treats reordered permission sets as the same verified authority", () => {
    const context = {
      principal: { issuer: "https://fixture.example.test", subject: "operator-a" },
      platformAdministrator: false,
      repository: {
        repositoryId: "repository-a",
        role: "maintainer" as const,
        source: "repository" as const,
        permissions: ["read", "review", "configure"] as ("read" | "review" | "configure")[],
      },
    };
    const reordered = structuredClone(context);
    reordered.repository.permissions.reverse();
    expect(permissionSignature(context)).toBe(permissionSignature(reordered));
    reordered.repository.permissions.pop();
    expect(permissionSignature(context)).not.toBe(permissionSignature(reordered));
    expect(permissionSignature(undefined)).toBeNull();
  });
});

describe("original mutation retention", () => {
  it("retains the exact original payload after a lost response and never retries automatically", async () => {
    const owner = new OriginalMutation<ReturnType<typeof suiteSaveRequestFixture>>();
    const input = suiteSaveRequestFixture(),
      original = structuredClone(input),
      deferred = pending<string>();
    const execute = vi.fn((_request: typeof input) => deferred.promise),
      success = vi.fn(),
      denied = vi.fn();
    const first = owner.run(input, execute, success, denied);
    input.changeId = "changed-in-flight";
    input.draft.name = "Edited later";
    deferred.reject(new ReviewControlNetworkError("save draft"));
    await first;
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toEqual(original);
    expect(owner.snapshot()).toMatchObject({ request: original, busy: false, conflict: false });
    expect(Object.isFrozen(owner.snapshot().request?.draft.cases)).toBe(true);
    const retry = vi.fn(async () => "original receipt");
    await owner.run(input, retry, success, denied);
    expect(retry).toHaveBeenCalledExactlyOnceWith(original);
    expect(success).toHaveBeenCalledExactlyOnceWith("original receipt");
    expect(owner.snapshot().request).toBeNull();
  });
  it("does not lose an uncertain request during temporary permission checking", async () => {
    const owner = new OriginalMutation<{ changeId: string }>(),
      request = { changeId: "same-change" };
    await owner.run(
      request,
      async () => {
        throw httpError(503);
      },
      vi.fn(),
      vi.fn(),
    );
    const before = owner.snapshot(),
      binding = { identity: "same-scope", permissions: "configure" };
    expect(nextAccessBinding(binding, binding.identity, null)).toBe(binding);
    expect(owner.snapshot()).toBe(before);
    expect(nextAccessBinding(binding, binding.identity, "configure")).toBe(binding);
    const execute = vi.fn(async () => "receipt");
    await owner.run({ changeId: "replacement-must-not-be-used" }, execute, vi.fn(), vi.fn());
    expect(execute).toHaveBeenCalledExactlyOnceWith(request);
  });
  it("fences late completion after identity or repository disposal", async () => {
    const owner = new OriginalMutation<{ changeId: string }>(),
      response = pending<string>(),
      success = vi.fn();
    const running = owner.run({ changeId: "old-scope" }, () => response.promise, success, vi.fn());
    owner.dispose();
    response.resolve("late receipt");
    await running;
    expect(success).not.toHaveBeenCalled();
    expect(owner.snapshot()).toEqual({ request: null, busy: false, error: null, conflict: false });
  });
  it("does not run a second mutation while the first is in flight", async () => {
    const owner = new OriginalMutation<{ changeId: string }>(),
      response = pending<string>();
    const execute = vi.fn(() => response.promise);
    const first = owner.run({ changeId: "one" }, execute, vi.fn(), vi.fn());
    await owner.run({ changeId: "two" }, execute, vi.fn(), vi.fn());
    expect(execute).toHaveBeenCalledOnce();
    response.resolve("done");
    await first;
  });
  it.each([401, 403, 404])(
    "invalidates authority and clears the pending request on HTTP %s",
    async (status) => {
      const owner = new OriginalMutation<{ changeId: string }>(),
        denied = vi.fn();
      await owner.run(
        { changeId: "one" },
        async () => {
          throw httpError(status);
        },
        vi.fn(),
        denied,
      );
      expect(denied).toHaveBeenCalledOnce();
      expect(owner.snapshot().request).toBeNull();
      expect(accessDenied(httpError(status))).toBe(true);
    },
  );
  it("preserves the editor input and reports a CAS conflict without silently rebasing", async () => {
    const owner = new OriginalMutation<ReturnType<typeof suiteSaveRequestFixture>>(),
      input = suiteSaveRequestFixture(),
      original = structuredClone(input);
    await owner.run(
      input,
      async () => {
        throw httpError(409);
      },
      vi.fn(),
      vi.fn(),
    );
    expect(owner.snapshot()).toMatchObject({ request: null, busy: false, conflict: true });
    expect(input).toEqual(original);
    expect(input.expectedRevision).toBe(1);
  });
  it("distinguishes preflight rejection from an uncertain protocol response", async () => {
    const owner = new OriginalMutation<{ changeId: string }>();
    await owner.run(
      { changeId: "invalid" },
      async () => {
        throw new ReviewControlRequestError("save", "body", "Invalid draft");
      },
      vi.fn(),
      vi.fn(),
    );
    expect(owner.snapshot().request).toBeNull();
    await owner.run(
      { changeId: "uncertain" },
      async () => {
        throw new ReviewControlProtocolError("save", "Invalid receipt");
      },
      vi.fn(),
      vi.fn(),
    );
    expect(owner.snapshot().request).toEqual({ changeId: "uncertain" });
  });
});

describe("complete grouped catalog loading", () => {
  it("loads bounded pages before grouping and rejects inconsistent totals", async () => {
    const rows = Array.from({ length: 51 }, (_, id) => ({ id: `item-${id}` }));
    const load = vi.fn(async (page: number) => ({
      items: rows.slice((page - 1) * 50, page * 50),
      total: 51,
    }));
    expect(await collectCatalog(load)).toEqual(rows);
    expect(load.mock.calls.map(([page]) => page)).toEqual([1, 2]);
    await expect(
      collectCatalog(async (page) => ({
        items: page === 1 ? rows.slice(0, 50) : [rows[0] as { id: string }],
        total: page === 1 ? 51 : 52,
      })),
    ).rejects.toThrow(/catalog changed/u);
  });
  it("rejects repeated identities, truncated pages and excessive catalogs", async () => {
    const rows = Array.from({ length: 50 }, (_, id) => ({ id: `item-${id}` }));
    await expect(collectCatalog(async () => ({ items: rows, total: 51 }))).rejects.toThrow(
      /changed while loading/u,
    );
    await expect(collectCatalog(async () => ({ items: [], total: 1 }))).rejects.toThrow(
      /ended before/u,
    );
    await expect(collectCatalog(async () => ({ items: [], total: 10_001 }))).rejects.toThrow(
      /exceeds/u,
    );
    expect(await collectCatalog(async () => ({ items: [], total: 0 }))).toEqual([]);
  });
});
