import { describe, expect, it, vi } from "vitest";
import { bindOperatorDatabase } from "./operator-database.js";
import type { OperatorRequestInput } from "./operator-request.js";

const actor = { issuer: "https://identity.example.test", subject: "operator" };
function transport(output: unknown = { found: true }) {
  return {
    request: vi.fn(
      async (_operation: "operatorRequest", _input: OperatorRequestInput): Promise<unknown> =>
        output,
    ),
  };
}

describe("actor-bound operator database", () => {
  it("forwards an evaluation result selection only through the immutable operator envelope", async () => {
    const session = { ...actor };
    const database = transport({ resultId: "result-a" });
    const bound = bindOperatorDatabase(database, session);
    const payload = {
      repositoryId: "repo-a",
      evaluationId: "evaluation-a",
      cellId: "cell-a",
      resultId: "result-a",
      actor: { ...actor },
    };
    const result = bound.request("getEvaluationCellResult", payload);
    session.subject = "forged-after-binding";
    payload.repositoryId = "repo-b";
    payload.resultId = "other-result";
    payload.actor.subject = "forged-after-request";
    expect(await result).toEqual({ resultId: "result-a" });
    expect(database.request).toHaveBeenCalledExactlyOnceWith("operatorRequest", {
      context: { kind: "operator", actor },
      operation: "getEvaluationCellResult",
      input: {
        repositoryId: "repo-a",
        evaluationId: "evaluation-a",
        cellId: "cell-a",
        resultId: "result-a",
        actor,
      },
    });
    const frame = database.request.mock.calls[0]?.[1];
    expect(Object.isFrozen(frame?.context.actor)).toBe(true);
    expect(Object.isFrozen(frame?.input)).toBe(true);
  });

  it("preserves an evaluation result permission failure without falling back to the ordinary result operation", async () => {
    const denied = Object.assign(new Error("The evaluation result is not readable."), {
      code: "PLATFORM_NOT_FOUND",
    });
    const database = transport();
    database.request.mockRejectedValue(denied);
    await expect(
      bindOperatorDatabase(database, actor).request("getEvaluationCellResult", {
        repositoryId: "repo-a",
        evaluationId: "evaluation-a",
        cellId: "cell-a",
        resultId: "result-a",
        actor,
      }),
    ).rejects.toBe(denied);
    expect(database.request).toHaveBeenCalledOnce();
    expect(database.request.mock.calls[0]?.[1].operation).toBe("getEvaluationCellResult");
  });

  it("wraps every call and captures immutable actor and payload copies", async () => {
    const session = { ...actor };
    const database = transport();
    const bound = bindOperatorDatabase(database, session);
    session.subject = "changed-after-binding";
    const payload = { repositoryId: "repo-a" };
    const request = bound.request("getManagedRepository", payload);
    payload.repositoryId = "repo-b";
    expect(await request).toEqual({ found: true });
    expect(database.request).toHaveBeenCalledOnce();
    expect(database.request.mock.calls[0]).toEqual([
      "operatorRequest",
      {
        context: { kind: "operator", actor },
        operation: "getManagedRepository",
        input: { repositoryId: "repo-a" },
      },
    ]);
    const envelope = database.request.mock.calls[0]?.[1];
    expect(Object.isFrozen(envelope?.context)).toBe(true);
    expect(Object.isFrozen(envelope?.context.actor)).toBe(true);
    expect(Object.isFrozen(envelope?.input)).toBe(true);
    expect(Object.isFrozen(bound)).toBe(true);
  });

  it("wraps each streaming chunk as a new authorization request", async () => {
    const database = transport();
    const bound = bindOperatorDatabase(database, actor);
    const scope = {
      repositoryId: "repo-a",
      runId: "run",
      jobId: "job",
      runAttemptId: "attempt",
      assetId: "asset",
    };
    await bound.request("readEvidenceAssetChunk", { ...scope, offset: 0 });
    await bound.request("readEvidenceAssetChunk", { ...scope, offset: 1024 });
    expect(
      database.request.mock.calls.map(([operation, input]) => [
        operation,
        input.operation,
        input.context.actor,
        input.input,
      ]),
    ).toEqual([
      ["operatorRequest", "readEvidenceAssetChunk", actor, { ...scope, offset: 0 }],
      ["operatorRequest", "readEvidenceAssetChunk", actor, { ...scope, offset: 1024 }],
    ]);
  });

  it.each([
    "operatorRequest",
    "shutdown",
    "completeLease",
    "claimLease",
    "beginEvidenceUpload",
    "authenticateWorkerToken",
    "bootstrapManagedRepositories",
    "ingestSchedulingEvent",
    "createOperatorSession",
    "getReviewRun",
    "resolveWorkflowPrompt",
    "dispatchEvaluationRequest",
    "dispatchEvaluationRequestInTransaction",
    "cancelEvaluationJob",
    "cancelEvaluationJobInTransaction",
    "rawSQL",
    "constructor",
  ])("never forwards forbidden operation %s", async (operation) => {
    const database = transport();
    const bound = bindOperatorDatabase(database, actor);
    const invoke = bound.request as (operation: string, input: unknown) => Promise<unknown>;
    await expect(invoke(operation, {})).rejects.toMatchObject({ code: "PLATFORM_FORBIDDEN" });
    expect(database.request).not.toHaveBeenCalled();
  });

  it("preserves permission failures without retrying through the raw operation", async () => {
    const denied = Object.assign(new Error("Permission denied."), { code: "PLATFORM_FORBIDDEN" });
    const database = transport();
    database.request.mockRejectedValue(denied);
    const bound = bindOperatorDatabase(database, actor);
    await expect(bound.request("getManagedRepository", { repositoryId: "repo-a" })).rejects.toBe(
      denied,
    );
    expect(database.request).toHaveBeenCalledOnce();
    expect(database.request.mock.calls[0]?.[0]).toBe("operatorRequest");
  });

  it("rejects uncopyable inputs and invalid principals before sending", async () => {
    const database = transport();
    const bound = bindOperatorDatabase(database, actor);
    const invoke = bound.request as (operation: string, input: unknown) => Promise<unknown>;
    await expect(
      invoke("getManagedRepository", { repositoryId: "repo-a", hidden: () => true }),
    ).rejects.toMatchObject({ code: "PLATFORM_INVALID" });
    expect(() => bindOperatorDatabase(database, { ...actor, subject: " padded " })).toThrow(
      expect.objectContaining({ code: "PLATFORM_INVALID" }),
    );
    expect(database.request).not.toHaveBeenCalled();
  });
});
