import * as C from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewControlHttpError,
  ReviewControlNetworkError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
  ReviewControlResponseTooLargeError,
} from "../review-control/errors";
import {
  batchCancellationFixture,
  batchCancelRequestFixture,
  batchCreateRequestFixture,
  batchDetailFixture,
  batchListFixture,
  batchMatrixFixture,
  batchPromptOptionsFixture,
  batchSummaryFixture,
  batchWaitingMatrixFixture,
  evaluationBatchTestActor,
  evaluationBatchTestScope,
} from "./fixtures.testing";
import { createHttpEvaluationBatchAdapter, HttpEvaluationBatchAdapter } from "./index";

const repositoryId = evaluationBatchTestScope.repositoryId;
const root = `/api/v1/operator/repositories/${repositoryId}`;
const batchPath = `${root}/evaluations/${evaluationBatchTestScope.evaluationId}`;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const withResponse = (value: unknown) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => json(value));
  return { fetch, adapter: new HttpEvaluationBatchAdapter({ fetch }) };
};
const delayedResponse = () => {
  let resolveResponse: ((value: Response) => void) | undefined;
  const pending = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  const fetch = vi.fn<typeof globalThis.fetch>(() => pending);
  return {
    fetch,
    adapter: new HttpEvaluationBatchAdapter({ fetch }),
    complete(value: unknown) {
      if (resolveResponse === undefined)
        throw new Error("The response resolver was not initialized.");
      resolveResponse(json(value));
    },
  };
};

const reads = [
  {
    name: "batch list",
    read: (adapter: HttpEvaluationBatchAdapter, signal?: AbortSignal) =>
      adapter.listBatches(repositoryId, {}, signal),
    response: batchListFixture,
  },
  {
    name: "batch detail",
    read: (adapter: HttpEvaluationBatchAdapter, signal?: AbortSignal) =>
      adapter.getBatch(evaluationBatchTestScope, signal),
    response: batchDetailFixture,
  },
  {
    name: "batch matrix",
    read: (adapter: HttpEvaluationBatchAdapter, signal?: AbortSignal) =>
      adapter.getBatchMatrix(evaluationBatchTestScope, signal),
    response: batchMatrixFixture,
  },
  {
    name: "prompt options",
    read: (adapter: HttpEvaluationBatchAdapter, signal?: AbortSignal) =>
      adapter.listPromptOptions(repositoryId, { workflowKind: "pr_static_build" }, signal),
    response: batchPromptOptionsFixture,
  },
];

describe("evaluation batch HTTP adapter", () => {
  it("requires the response to retain the exact Prompt and profile selections in each arm", async () => {
    const request = batchCreateRequestFixture();
    const summary = batchSummaryFixture();
    await expect(
      withResponse(summary).adapter.createBatch(repositoryId, request, evaluationBatchTestActor),
    ).resolves.toEqual(summary);
    for (const arm of ["baseline", "candidate"] as const) {
      for (const field of ["profileVersionId", "promptVersionId"] as const) {
        const wrong = structuredClone(summary);
        wrong[arm][field] = "other-version";
        await expect(
          withResponse(wrong).adapter.createBatch(repositoryId, request, evaluationBatchTestActor),
        ).rejects.toBeInstanceOf(ReviewControlProtocolError);
      }
    }
  });
  it("uses six exact authenticated endpoints without transmitting the expected actor", async () => {
    const values = [
      batchSummaryFixture(),
      batchCancellationFixture(),
      batchListFixture(),
      batchDetailFixture(),
      batchMatrixFixture(),
      batchPromptOptionsFixture(),
    ];
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const value of values) fetch.mockResolvedValueOnce(json(value));
    const adapter = createHttpEvaluationBatchAdapter({ fetch });
    expect(adapter).toBeInstanceOf(HttpEvaluationBatchAdapter);
    expect(adapter.mode).toBe("connected");
    const create = batchCreateRequestFixture(),
      cancel = batchCancelRequestFixture();
    expect(await adapter.createBatch(repositoryId, create, evaluationBatchTestActor)).toEqual(
      values[0],
    );
    expect(
      await adapter.cancelBatch(evaluationBatchTestScope, cancel, evaluationBatchTestActor),
    ).toEqual(values[1]);
    expect(await adapter.listBatches(repositoryId)).toEqual(values[2]);
    expect(await adapter.getBatch(evaluationBatchTestScope)).toEqual(values[3]);
    expect(await adapter.getBatchMatrix(evaluationBatchTestScope)).toEqual(values[4]);
    expect(
      await adapter.listPromptOptions(repositoryId, { workflowKind: "pr_static_build" }),
    ).toEqual(values[5]);
    expect(fetch.mock.calls.map(([path, options]) => [path, options?.method])).toEqual([
      [`${root}/evaluations`, "POST"],
      [`${batchPath}/cancel`, "POST"],
      [`${root}/evaluations?page=1&pageSize=20`, "GET"],
      [batchPath, "GET"],
      [`${batchPath}/matrix`, "GET"],
      [`${root}/evaluation-prompt-options?page=1&pageSize=20&workflowKind=pr_static_build`, "GET"],
    ]);
    for (const [, options] of fetch.mock.calls) {
      expect(options).toMatchObject({
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      expect(options?.headers).not.toHaveProperty("Authorization");
      if (options?.method === "GET") expect(options).not.toHaveProperty("body");
    }
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(create));
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(cancel));
    expect(String(fetch.mock.calls[0]?.[1]?.body)).not.toContain(evaluationBatchTestActor.issuer);
  });

  it("serializes canonical pages and each supported filter combination", async () => {
    for (const filter of [
      {},
      { suiteId: "suite-a" },
      { workflowKind: "pr_static_build" as const },
      { suiteId: "suite-a", workflowKind: "pr_static_build" as const },
    ]) {
      const value = { ...batchListFixture(), page: 2, pageSize: 1, total: 2 };
      const f = withResponse(value);
      await expect(
        f.adapter.listBatches(repositoryId, { ...filter, pageSize: 1, page: 2 }),
      ).resolves.toEqual(value);
      const expected = `${root}/evaluations?page=2&pageSize=1${"suiteId" in filter ? "&suiteId=suite-a" : ""}${"workflowKind" in filter ? "&workflowKind=pr_static_build" : ""}`;
      expect(f.fetch.mock.calls[0]?.[0]).toBe(expected);
    }
    const options = withResponse({
      ...batchPromptOptionsFixture(),
      page: 2,
      pageSize: 1,
      total: 2,
    });
    await options.adapter.listPromptOptions(repositoryId, {
      workflowKind: "pr_static_build",
      pageSize: 1,
      page: 2,
    });
    expect(options.fetch.mock.calls[0]?.[0]).toBe(
      `${root}/evaluation-prompt-options?page=2&pageSize=1&workflowKind=pr_static_build`,
    );
  });

  it.each([
    "",
    "../repository",
    "repository/a",
    "repository%2Fa",
    "repository?x=1",
    "repository-a\n",
  ])("rejects unsafe repository scope %j before fetch", async (unsafe) => {
    const f = withResponse({});
    const scope = { ...evaluationBatchTestScope, repositoryId: unsafe };
    for (const operation of [
      () => f.adapter.createBatch(unsafe, batchCreateRequestFixture()),
      () => f.adapter.cancelBatch(scope, batchCancelRequestFixture()),
      () => f.adapter.listBatches(unsafe),
      () => f.adapter.getBatch(scope),
      () => f.adapter.getBatchMatrix(scope),
      () => f.adapter.listPromptOptions(unsafe, { workflowKind: "pr_static_build" }),
    ])
      await expect(operation()).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("rejects unsafe batch identity, unknown fields and invalid page/filter values before fetch", async () => {
    const f = withResponse({});
    for (const input of [
      { ...evaluationBatchTestScope, evaluationId: "evaluation-a\n" },
      { ...evaluationBatchTestScope, actor: evaluationBatchTestActor },
      { ...evaluationBatchTestScope, replayOnly: true },
    ]) {
      await expect(f.adapter.getBatch(input)).rejects.toBeInstanceOf(ReviewControlRequestError);
      await expect(f.adapter.getBatchMatrix(input)).rejects.toBeInstanceOf(
        ReviewControlRequestError,
      );
      await expect(
        f.adapter.cancelBatch(input, batchCancelRequestFixture()),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
    }
    for (const query of [
      { page: 0 },
      { page: 1.5 },
      { page: "1" },
      { pageSize: 51 },
      { page: Number.MAX_SAFE_INTEGER, pageSize: 50 },
      { suiteId: "suite-a\n" },
      { workflowKind: "unknown" },
      { actor: evaluationBatchTestActor },
      { page: undefined },
    ]) {
      await expect(f.adapter.listBatches(repositoryId, query as never)).rejects.toBeInstanceOf(
        ReviewControlRequestError,
      );
    }
    for (const query of [
      {},
      { workflowKind: "unknown" },
      { workflowKind: "pr_static_build", suiteId: "suite-a" },
      { workflowKind: "pr_static_build", pageSize: 51 },
    ]) {
      await expect(
        f.adapter.listPromptOptions(repositoryId, query as never),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
    }
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("rejects client execution authority, malformed mappings and invalid expected actors", async () => {
    const f = withResponse({});
    for (const extra of [
      { actor: evaluationBatchTestActor },
      { repositoryId },
      { readOnly: false },
      { replayOnly: true },
      { plan: {} },
      { resultId: "old-result" },
      { evaluationId: "caller-batch" },
      { authorization: {} },
    ]) {
      await expect(
        f.adapter.createBatch(repositoryId, { ...batchCreateRequestFixture(), ...extra }),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
      await expect(
        f.adapter.cancelBatch(evaluationBatchTestScope, {
          ...batchCancelRequestFixture(),
          ...extra,
        }),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
    }
    const original = batchCreateRequestFixture();
    for (const value of [
      { ...original, checkMappings: [...original.checkMappings, ...original.checkMappings] },
      {
        ...original,
        checkMappings: [
          {
            caseId: "case-1",
            criterionId: "criterion-1",
            baselineCheckId: "foreign:build",
            candidateCheckId: null,
          },
        ],
      },
      { ...original, suiteVersionId: "version-a\n" },
      { ...original, baseline: { ...original.baseline, profileVersionId: "profile-baseline\n" } },
    ]) {
      await expect(f.adapter.createBatch(repositoryId, value)).rejects.toBeInstanceOf(
        ReviewControlRequestError,
      );
    }
    for (const actor of [
      { ...evaluationBatchTestActor, subject: "changed\n" },
      { ...evaluationBatchTestActor, subject: "bad\ud800" },
      { ...evaluationBatchTestActor, administrator: true },
    ]) {
      await expect(f.adapter.createBatch(repositoryId, original, actor)).rejects.toBeInstanceOf(
        ReviewControlRequestError,
      );
      await expect(
        f.adapter.cancelBatch(evaluationBatchTestScope, batchCancelRequestFixture(), actor),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
    }
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("captures only plain enumerable JSON without invoking getters or coercing caller objects", async () => {
    const f = withResponse({});
    const getter = vi.fn(() => "suite-a");
    const accessor = batchCreateRequestFixture();
    Object.defineProperty(accessor, "suiteId", { enumerable: true, get: getter });
    const hidden = Object.defineProperty(batchCreateRequestFixture(), "hidden", { value: true });
    const symbol = Object.assign(batchCreateRequestFixture(), { [Symbol("authority")]: true });
    const sparse = batchCreateRequestFixture();
    sparse.checkMappings = new Array(1);
    const cycle = { ...batchCreateRequestFixture(), nested: {} };
    cycle.nested = cycle;
    for (const value of [
      accessor,
      hidden,
      symbol,
      sparse,
      cycle,
      Object.assign(Object.create({ inherited: true }), batchCreateRequestFixture()),
      { ...batchCreateRequestFixture(), suiteId: "bad\ud800" },
    ]) {
      await expect(f.adapter.createBatch(repositoryId, value)).rejects.toBeInstanceOf(
        ReviewControlRequestError,
      );
    }
    expect(getter).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("binds mutation responses to the original selections, cancellation and optional actor", async () => {
    for (const value of [
      { ...batchSummaryFixture(), repositoryId: "private-repository" },
      { ...batchSummaryFixture(), suiteVersionId: "other-version" },
      { ...batchSummaryFixture(), baseline: batchSummaryFixture().candidate },
      { ...batchSummaryFixture(), mode: "profile_only" },
      {
        ...batchSummaryFixture(),
        createdBy: { ...evaluationBatchTestActor, subject: "other-actor" },
      },
    ]) {
      const f = withResponse(value);
      await expect(
        f.adapter.createBatch(repositoryId, batchCreateRequestFixture(), evaluationBatchTestActor),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    }
    for (const value of [
      { ...batchCancellationFixture(), evaluationId: "other-batch" },
      { ...batchCancellationFixture(), reason: "Other reason." },
      { ...batchCancellationFixture(), version: 1 },
      {
        ...batchCancellationFixture(),
        cancelledBy: { ...evaluationBatchTestActor, subject: "other-actor" },
      },
    ]) {
      await expect(
        withResponse(value).adapter.cancelBatch(
          evaluationBatchTestScope,
          batchCancelRequestFixture(),
          evaluationBatchTestActor,
        ),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    }
    const noExpectedActor = {
      ...batchSummaryFixture(),
      createdBy: { ...evaluationBatchTestActor, subject: "current-session" },
    };
    await expect(
      withResponse(noExpectedActor).adapter.createBatch(repositoryId, batchCreateRequestFixture()),
    ).resolves.toEqual(noExpectedActor);
  });

  it("rejects foreign and inconsistent read responses, incomplete pages and ignored filters", async () => {
    for (const candidate of [
      {
        value: { ...batchListFixture(), repositoryId: "other-repository" },
        read: (a: HttpEvaluationBatchAdapter) => a.listBatches(repositoryId),
      },
      {
        value: {
          ...batchDetailFixture(),
          summary: { ...batchSummaryFixture(), id: "other-batch" },
        },
        read: (a: HttpEvaluationBatchAdapter) => a.getBatch(evaluationBatchTestScope),
      },
      {
        value: { ...batchMatrixFixture(), evaluationId: "other-batch" },
        read: (a: HttpEvaluationBatchAdapter) => a.getBatchMatrix(evaluationBatchTestScope),
      },
      {
        value: { ...batchPromptOptionsFixture(), repositoryId: "other-repository" },
        read: (a: HttpEvaluationBatchAdapter) =>
          a.listPromptOptions(repositoryId, { workflowKind: "pr_static_build" }),
      },
      {
        value: batchListFixture(),
        read: (a: HttpEvaluationBatchAdapter) =>
          a.listBatches(repositoryId, { suiteId: "another-suite" }),
      },
      {
        value: batchListFixture(),
        read: (a: HttpEvaluationBatchAdapter) =>
          a.listBatches(repositoryId, { workflowKind: "issue_triage" }),
      },
      {
        value: batchListFixture(),
        read: (a: HttpEvaluationBatchAdapter) => a.listBatches(repositoryId, { page: 2 }),
      },
      {
        value: { ...batchListFixture(), total: 2 },
        read: (a: HttpEvaluationBatchAdapter) => a.listBatches(repositoryId),
      },
      {
        value: {
          ...batchListFixture(),
          items: [batchListFixture().items[0], batchListFixture().items[0]],
          total: 2,
        },
        read: (a: HttpEvaluationBatchAdapter) => a.listBatches(repositoryId),
      },
      {
        value: { ...batchPromptOptionsFixture(), workflowKind: "issue_triage" },
        read: (a: HttpEvaluationBatchAdapter) =>
          a.listPromptOptions(repositoryId, { workflowKind: "pr_static_build" }),
      },
      {
        value: {
          ...batchPromptOptionsFixture(),
          items: [
            { ...batchPromptOptionsFixture().items[0], outputSchemaVersion: "IssueTriageV2" },
          ],
        },
        read: (a: HttpEvaluationBatchAdapter) =>
          a.listPromptOptions(repositoryId, { workflowKind: "pr_static_build" }),
      },
    ])
      await expect(candidate.read(withResponse(candidate.value).adapter)).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
  });

  it("keeps admission state truthful and excludes full prompts, sources and claimed result payloads", async () => {
    for (const state of ["pending", "admitted"] as const) {
      const matrix = batchWaitingMatrixFixture(state);
      await expect(
        withResponse(matrix).adapter.getBatchMatrix(evaluationBatchTestScope),
      ).resolves.toEqual(matrix);
    }
    const pending = batchWaitingMatrixFixture();
    const entry = pending.cases[0];
    if (entry === undefined || entry.baseline.job === null)
      throw new Error("A waiting fixture requires a Job.");
    entry.baseline.job.admission = null;
    const duplicate = batchMatrixFixture();
    const pair = duplicate.cases[0];
    if (pair === undefined) throw new Error("A matrix fixture requires a case.");
    pair.candidate.runId = pair.baseline.runId;
    for (const value of [
      pending,
      duplicate,
      { ...batchMatrixFixture(), progress: { ...batchMatrixFixture().progress, completed: 2 } },
      { ...batchMatrixFixture(), fullResult: { payload: "old baseline" } },
    ]) {
      await expect(
        withResponse(value).adapter.getBatchMatrix(evaluationBatchTestScope),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    }
    const detail = batchDetailFixture();
    const fullPrompt = {
      ...detail,
      configurations: {
        ...detail.configurations,
        baseline: {
          ...detail.configurations.baseline,
          prompt: { ...detail.configurations.baseline.prompt, content: "PRIVATE PROMPT" },
        },
      },
    };
    await expect(
      withResponse(fullPrompt).adapter.getBatch(evaluationBatchTestScope),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    const sourceMatrix = batchMatrixFixture();
    const leaked = {
      ...sourceMatrix,
      cases: sourceMatrix.cases.map((value) => ({
        ...value,
        source: { ...value.source, snapshot: { body: "PRIVATE SOURCE" } },
      })),
    };
    await expect(
      withResponse(leaked).adapter.getBatchMatrix(evaluationBatchTestScope),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("preserves valid empty collections without injecting samples or synthesized options", async () => {
    const batches = { ...batchListFixture(), total: 0, items: [] };
    await expect(withResponse(batches).adapter.listBatches(repositoryId)).resolves.toEqual(batches);
    const options = { ...batchPromptOptionsFixture(), total: 0, items: [] };
    await expect(
      withResponse(options).adapter.listPromptOptions(repositoryId, {
        workflowKind: "pr_static_build",
      }),
    ).resolves.toEqual(options);
  });

  it("captures mutation scope, selections and actor before an asynchronous response", async () => {
    const create = batchCreateRequestFixture(),
      original = structuredClone(create),
      actor = { ...evaluationBatchTestActor };
    const f = delayedResponse();
    const pending = f.adapter.createBatch(repositoryId, create, actor);
    create.changeId = "changed";
    create.baseline.profileVersionId = "changed-profile";
    create.checkMappings.splice(0);
    actor.subject = "changed-actor";
    f.complete(batchSummaryFixture());
    await expect(pending).resolves.toEqual(batchSummaryFixture());
    expect(f.fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(original));
    const scope = { ...evaluationBatchTestScope },
      cancellation = batchCancelRequestFixture();
    const cancelOriginal = structuredClone(cancellation),
      cancel = delayedResponse();
    const pendingCancel = cancel.adapter.cancelBatch(scope, cancellation, evaluationBatchTestActor);
    scope.repositoryId = "changed-repository";
    scope.evaluationId = "changed-batch";
    cancellation.reason = "Changed in flight.";
    cancel.complete(batchCancellationFixture());
    await expect(pendingCancel).resolves.toEqual(batchCancellationFixture());
    expect(cancel.fetch.mock.calls[0]?.[0]).toBe(`${batchPath}/cancel`);
    expect(cancel.fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(cancelOriginal));
  });

  it("captures read filters before awaiting the response", async () => {
    const query = {
      page: 1,
      pageSize: 20,
      suiteId: "suite-a",
      workflowKind: "pr_static_build" as const,
    };
    const f = delayedResponse();
    const pending = f.adapter.listBatches(repositoryId, query);
    query.page = 2;
    query.suiteId = "changed-suite";
    f.complete(batchListFixture());
    await expect(pending).resolves.toEqual(batchListFixture());
    expect(f.fetch.mock.calls[0]?.[0]).toBe(
      `${root}/evaluations?page=1&pageSize=20&suiteId=suite-a&workflowKind=pr_static_build`,
    );
  });

  it("allows caller retries with the same change ID and exact serialized payload without automatic retry", async () => {
    const operations = [
      {
        input: batchCreateRequestFixture(),
        response: batchSummaryFixture(),
        call: (a: HttpEvaluationBatchAdapter, input: never) =>
          a.createBatch(repositoryId, input, evaluationBatchTestActor),
      },
      {
        input: batchCancelRequestFixture(),
        response: batchCancellationFixture(),
        call: (a: HttpEvaluationBatchAdapter, input: never) =>
          a.cancelBatch(evaluationBatchTestScope, input, evaluationBatchTestActor),
      },
    ];
    for (const operation of operations) {
      const savedPayload = JSON.stringify(operation.input);
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValueOnce(new Error("The accepted response was lost."))
        .mockResolvedValueOnce(json(operation.response));
      const adapter = new HttpEvaluationBatchAdapter({ fetch });
      await expect(
        operation.call(adapter, JSON.parse(savedPayload) as never),
      ).rejects.toBeInstanceOf(ReviewControlNetworkError);
      expect(fetch).toHaveBeenCalledOnce();
      await expect(operation.call(adapter, JSON.parse(savedPayload) as never)).resolves.toEqual(
        operation.response,
      );
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[0]?.[1]?.body).toBe(savedPayload);
      expect(fetch.mock.calls[1]?.[1]?.body).toBe(savedPayload);
    }
  });

  it.each(reads)("aborts obsolete $name reads before fetch", async ({ read }) => {
    const controller = new AbortController(),
      reason = new Error("The selection changed.");
    controller.abort(reason);
    const f = withResponse({});
    await expect(read(f.adapter, controller.signal)).rejects.toBe(reason);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(reads)(
    "forwards in-flight cancellation for $name without empty fallback",
    async ({ read }) => {
      const controller = new AbortController();
      const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
      const pending = read(new HttpEvaluationBatchAdapter({ fetch }), controller.signal);
      const reason = new Error("The active scope changed."),
        rejected = expect(pending).rejects.toBe(reason);
      controller.abort(reason);
      await rejected;
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    },
  );

  it.each([401, 403, 404, 409, 503])(
    "preserves HTTP %s without retry or success fallback",
    async (status) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        json(
          {
            code: "evaluation_unavailable",
            message: "The operation was rejected.",
            retryable: false,
          },
          status,
        ),
      );
      const adapter = new HttpEvaluationBatchAdapter({ fetch });
      await expect(
        adapter.createBatch(repositoryId, batchCreateRequestFixture()),
      ).rejects.toMatchObject({
        code: "http_error",
        status,
        serverCode: "evaluation_unavailable",
        retryable: false,
      });
      expect(fetch).toHaveBeenCalledOnce();
      await expect(adapter.getBatch(evaluationBatchTestScope)).rejects.toBeInstanceOf(
        ReviewControlHttpError,
      );
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects oversized UTF-8 payloads and malformed wire JSON without a replacement response", async () => {
    const request = batchCreateRequestFixture();
    request.baseline.profileVersionId = "b".repeat(128);
    request.candidate.profileVersionId = "c".repeat(128);
    request.checkMappings = Array.from({ length: C.maximumEvaluationCaseCount }, (_, caseIndex) =>
      Array.from({ length: C.maximumEvaluationCriterionCount }, (_, criterionIndex) => ({
        caseId: `case-${caseIndex}-`.padEnd(128, "x"),
        criterionId: `criterion-${criterionIndex}-`.padEnd(128, "y"),
        baselineCheckId: `${request.baseline.profileVersionId}:${"z".repeat(128)}`,
        candidateCheckId: `${request.candidate.profileVersionId}:${"z".repeat(128)}`,
      })),
    ).flat();
    expect(new TextEncoder().encode(JSON.stringify(request)).byteLength).toBeGreaterThan(
      C.maximumEvaluationBatchRequestUtf8Bytes,
    );
    const f = withResponse({});
    await expect(f.adapter.createBatch(repositoryId, request)).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    expect(f.fetch).not.toHaveBeenCalled();
    const oversized = {
      ...batchMatrixFixture(),
      body: "\u20ac".repeat(Math.ceil(C.maximumEvaluationReadUtf8Bytes / 3)),
    };
    await expect(
      withResponse(oversized).adapter.getBatchMatrix(evaluationBatchTestScope),
    ).rejects.toBeInstanceOf(ReviewControlResponseTooLargeError);
    for (const response of [
      new Response("not JSON", { headers: { "content-type": "application/json" } }),
      new Response("{}", { headers: { "content-type": "text/plain" } }),
      new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
    ]) {
      const adapter = new HttpEvaluationBatchAdapter({ fetch: vi.fn(async () => response) });
      await expect(adapter.getBatch(evaluationBatchTestScope)).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
    }
  });
});
