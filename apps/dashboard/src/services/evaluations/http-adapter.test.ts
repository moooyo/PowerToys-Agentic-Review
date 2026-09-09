import {
  type EvaluationSuiteDraft,
  maximumEvaluationCaseCount,
  maximumEvaluationCriterionCount,
  maximumEvaluationSourceDetailUtf8Bytes,
  maximumEvaluationSourceSnapshotUtf8Bytes,
  maximumEvaluationSuiteUtf8Bytes,
} from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewControlHttpError,
  ReviewControlNetworkError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
  ReviewControlResponseTooLargeError,
} from "../review-control/errors";
import {
  evaluationTestActor,
  evaluationTestCaseScope,
  evaluationTestSourceScope,
  evaluationTestSuiteScope,
  evaluationTestVersionScope,
  sourceCaptureRequestFixture,
  sourceDetailFixture,
  sourceListFixture,
  sourceSnapshotFixture,
  sourceSummaryFixture,
  suiteCaseDetailFixture,
  suiteCaseListFixture,
  suiteCreateRequestFixture,
  suiteDetailFixture,
  suiteDraftCaseFixture,
  suiteDraftFixture,
  suiteListFixture,
  suitePublishRequestFixture,
  suiteSaveRequestFixture,
  suiteSummaryFixture,
  suiteVersionFixture,
  suiteVersionListFixture,
} from "./fixtures.testing";
import { HttpEvaluationAdapter } from "./http-adapter";
import { createHttpEvaluationAdapter } from "./index";

const repositoryId = evaluationTestSuiteScope.repositoryId;
const root = `/api/v1/operator/repositories/${repositoryId}`;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const withResponse = (value: unknown) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => json(value));
  return { fetch, adapter: new HttpEvaluationAdapter({ fetch }) };
};
const delayedResponse = () => {
  let resolveResponse: ((value: Response) => void) | undefined;
  const response = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  const fetch = vi.fn<typeof globalThis.fetch>(() => response);
  return {
    fetch,
    adapter: new HttpEvaluationAdapter({ fetch }),
    complete(value: unknown) {
      if (!resolveResponse) throw new Error("The response resolver was not initialized.");
      resolveResponse(json(value));
    },
  };
};
const createdSuite = () => ({ ...suiteSummaryFixture(), draftRevision: 1, caseCount: 0 });

const readOperations = [
  {
    name: "source list",
    read: (adapter: HttpEvaluationAdapter, signal?: AbortSignal) =>
      adapter.listSources(repositoryId, {}, signal),
    response: sourceListFixture,
  },
  {
    name: "source detail",
    read: (adapter: HttpEvaluationAdapter, signal?: AbortSignal) =>
      adapter.getSource(evaluationTestSourceScope, signal),
    response: sourceDetailFixture,
  },
  {
    name: "suite list",
    read: (adapter: HttpEvaluationAdapter, signal?: AbortSignal) =>
      adapter.listSuites(repositoryId, {}, signal),
    response: suiteListFixture,
  },
  {
    name: "suite detail",
    read: (adapter: HttpEvaluationAdapter, signal?: AbortSignal) =>
      adapter.getSuite(evaluationTestSuiteScope, signal),
    response: suiteDetailFixture,
  },
  {
    name: "version list",
    read: (adapter: HttpEvaluationAdapter, signal?: AbortSignal) =>
      adapter.listSuiteVersions(evaluationTestSuiteScope, {}, signal),
    response: suiteVersionListFixture,
  },
  {
    name: "version detail",
    read: (adapter: HttpEvaluationAdapter, signal?: AbortSignal) =>
      adapter.getSuiteVersion(evaluationTestVersionScope, signal),
    response: suiteVersionFixture,
  },
  {
    name: "case list",
    read: (adapter: HttpEvaluationAdapter, signal?: AbortSignal) =>
      adapter.listSuiteCases(evaluationTestVersionScope, signal),
    response: suiteCaseListFixture,
  },
  {
    name: "case detail",
    read: (adapter: HttpEvaluationAdapter, signal?: AbortSignal) =>
      adapter.getSuiteCase(evaluationTestCaseScope, signal),
    response: suiteCaseDetailFixture,
  },
];

function draftAtByteLimit(maximumBytes: number): EvaluationSuiteDraft {
  const draft = suiteDraftFixture();
  draft.cases = Array.from({ length: maximumEvaluationCaseCount }, (_, caseIndex) => ({
    ...suiteDraftCaseFixture(caseIndex + 1),
    criteria: Array.from({ length: maximumEvaluationCriterionCount }, (_, criterionIndex) => ({
      criterionId: `criterion-${criterionIndex + 1}`,
      description: "x",
      applicability: { state: "applicable" as const },
      expectedOutcome: "failed" as const,
    })),
  }));
  let remaining = maximumBytes - byteLength(draft);
  for (const entry of draft.cases) {
    for (const criterion of entry.criteria) {
      const added = Math.min(2_047, remaining);
      criterion.description += "x".repeat(added);
      remaining -= added;
    }
  }
  if (remaining !== 0) throw new Error("The fixture could not fill the draft byte budget.");
  return draft;
}

describe("scoped evaluation transport", () => {
  it("uses all twelve exact authenticated routes with canonical list defaults", async () => {
    const capture = sourceCaptureRequestFixture();
    const create = suiteCreateRequestFixture();
    const save = suiteSaveRequestFixture();
    const publish = suitePublishRequestFixture();
    const responses = [
      sourceSummaryFixture(),
      sourceListFixture(),
      sourceDetailFixture(),
      createdSuite(),
      suiteListFixture(),
      suiteDetailFixture(),
      suiteSummaryFixture(),
      suiteVersionFixture(),
      suiteVersionListFixture(),
      suiteVersionFixture(),
      suiteCaseListFixture(),
      suiteCaseDetailFixture(),
    ];
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const value of responses) fetch.mockResolvedValueOnce(json(value));
    const adapter = createHttpEvaluationAdapter({ fetch });
    expect(adapter).toBeInstanceOf(HttpEvaluationAdapter);
    expect(adapter.mode).toBe("connected");
    expect(await adapter.captureSource(repositoryId, capture, evaluationTestActor)).toEqual(
      responses[0],
    );
    expect(await adapter.listSources(repositoryId)).toEqual(responses[1]);
    expect(await adapter.getSource(evaluationTestSourceScope)).toEqual(responses[2]);
    expect(await adapter.createSuite(repositoryId, create, evaluationTestActor)).toEqual(
      responses[3],
    );
    expect(await adapter.listSuites(repositoryId)).toEqual(responses[4]);
    expect(await adapter.getSuite(evaluationTestSuiteScope)).toEqual(responses[5]);
    expect(
      await adapter.saveSuiteDraft(evaluationTestSuiteScope, save, evaluationTestActor),
    ).toEqual(responses[6]);
    expect(
      await adapter.publishSuite(evaluationTestSuiteScope, publish, evaluationTestActor),
    ).toEqual(responses[7]);
    expect(await adapter.listSuiteVersions(evaluationTestSuiteScope)).toEqual(responses[8]);
    expect(await adapter.getSuiteVersion(evaluationTestVersionScope)).toEqual(responses[9]);
    expect(await adapter.listSuiteCases(evaluationTestVersionScope)).toEqual(responses[10]);
    expect(await adapter.getSuiteCase(evaluationTestCaseScope)).toEqual(responses[11]);
    expect(fetch.mock.calls.map(([path, options]) => [path, options?.method])).toEqual([
      [`${root}/evaluation-sources`, "POST"],
      [`${root}/evaluation-sources?page=1&pageSize=20`, "GET"],
      [`${root}/evaluation-sources/source-a`, "GET"],
      [`${root}/evaluation-suites`, "POST"],
      [`${root}/evaluation-suites?page=1&pageSize=20`, "GET"],
      [`${root}/evaluation-suites/suite-a`, "GET"],
      [`${root}/evaluation-suites/suite-a/draft`, "PUT"],
      [`${root}/evaluation-suites/suite-a/versions`, "POST"],
      [`${root}/evaluation-suites/suite-a/versions?page=1&pageSize=20`, "GET"],
      [`${root}/evaluation-suites/suite-a/versions/version-a`, "GET"],
      [`${root}/evaluation-suites/suite-a/versions/version-a/cases`, "GET"],
      [`${root}/evaluation-suites/suite-a/versions/version-a/cases/case-1`, "GET"],
    ]);
    for (const [, options] of fetch.mock.calls) {
      expect(options).toMatchObject({
        credentials: "include",
        cache: "no-store",
        redirect: "error",
      });
      if (options?.method === "GET") expect(options).not.toHaveProperty("body");
    }
    for (const [index, body] of [
      [0, capture],
      [3, create],
      [6, save],
      [7, publish],
    ] as const) {
      expect(JSON.parse(String(fetch.mock.calls[index]?.[1]?.body))).toEqual(body);
    }
  });

  it("uses explicit pages in canonical order for each paginated collection", async () => {
    const query = { pageSize: 1, page: 2 };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ ...sourceListFixture(), ...query, total: 2 }))
      .mockResolvedValueOnce(json({ ...suiteListFixture(), ...query, total: 2 }))
      .mockResolvedValueOnce(json({ ...suiteVersionListFixture(), ...query, total: 2 }));
    const adapter = new HttpEvaluationAdapter({ fetch });
    await adapter.listSources(repositoryId, query);
    await adapter.listSuites(repositoryId, query);
    await adapter.listSuiteVersions(evaluationTestSuiteScope, query);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      `${root}/evaluation-sources?page=2&pageSize=1`,
      `${root}/evaluation-suites?page=2&pageSize=1`,
      `${root}/evaluation-suites/suite-a/versions?page=2&pageSize=1`,
    ]);
  });

  it.each(["", "../repository", "repository/a", "repository%2Fa", "repository?x=1", "repo\n"])(
    "rejects unsafe repository scope %j before any request",
    async (unsafeRepositoryId) => {
      const { adapter, fetch } = withResponse({});
      const suiteScope = { ...evaluationTestSuiteScope, repositoryId: unsafeRepositoryId };
      const versionScope = { ...evaluationTestVersionScope, repositoryId: unsafeRepositoryId };
      const operations = [
        () => adapter.captureSource(unsafeRepositoryId, sourceCaptureRequestFixture()),
        () => adapter.listSources(unsafeRepositoryId),
        () => adapter.getSource({ ...evaluationTestSourceScope, repositoryId: unsafeRepositoryId }),
        () => adapter.createSuite(unsafeRepositoryId, suiteCreateRequestFixture()),
        () => adapter.listSuites(unsafeRepositoryId),
        () => adapter.getSuite(suiteScope),
        () => adapter.saveSuiteDraft(suiteScope, suiteSaveRequestFixture()),
        () => adapter.publishSuite(suiteScope, suitePublishRequestFixture()),
        () => adapter.listSuiteVersions(suiteScope),
        () => adapter.getSuiteVersion(versionScope),
        () => adapter.listSuiteCases(versionScope),
        () =>
          adapter.getSuiteCase({ ...evaluationTestCaseScope, repositoryId: unsafeRepositoryId }),
      ];
      for (const operation of operations)
        await expect(operation()).rejects.toBeInstanceOf(ReviewControlRequestError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["../other", "other/child", "id%3Avalue", "id#fragment", "id\n", ""])(
    "rejects unsafe source, suite, version and case identity %j",
    async (id) => {
      const { adapter, fetch } = withResponse({});
      const suiteScope = { ...evaluationTestSuiteScope, suiteId: id };
      for (const operation of [
        () => adapter.getSource({ ...evaluationTestSourceScope, sourceId: id }),
        () => adapter.getSuite(suiteScope),
        () => adapter.saveSuiteDraft(suiteScope, suiteSaveRequestFixture()),
        () => adapter.publishSuite(suiteScope, suitePublishRequestFixture()),
        () => adapter.listSuiteVersions(suiteScope),
        () => adapter.getSuiteVersion({ ...evaluationTestVersionScope, versionId: id }),
        () => adapter.listSuiteCases({ ...evaluationTestVersionScope, versionId: id }),
        () => adapter.getSuiteCase({ ...evaluationTestCaseScope, caseId: id }),
      ])
        await expect(operation()).rejects.toBeInstanceOf(ReviewControlRequestError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects extra scope fields instead of silently dropping them", async () => {
    const { adapter, fetch } = withResponse({});
    await expect(
      adapter.getSource({ ...evaluationTestSourceScope, sourceDigest: "a".repeat(64) } as never),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(
      adapter.getSuite({ ...evaluationTestSuiteScope, versionId: "latest" } as never),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(
      adapter.listSuiteCases({ ...evaluationTestVersionScope, page: 1 } as never),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(
      adapter.getSuiteCase({ ...evaluationTestCaseScope, actor: evaluationTestActor } as never),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { page: 0 },
    { page: 1.5 },
    { pageSize: 0 },
    { pageSize: 51 },
    { page: Number.MAX_SAFE_INTEGER, pageSize: 50 },
    { page: "1" },
    { repositoryId: "repository-b" },
    { cursor: "latest" },
  ])("rejects invalid or unbounded list query %j", async (query) => {
    const { adapter, fetch } = withResponse({});
    await expect(adapter.listSources(repositoryId, query as never)).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    await expect(adapter.listSuites(repositoryId, query as never)).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    await expect(
      adapter.listSuiteVersions(evaluationTestSuiteScope, query as never),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([{ actor: evaluationTestActor }, { replayOnly: true }, { changeId: "../change" }])(
    "rejects injected identity, replay authority or invalid change IDs %j",
    async (extra) => {
      const { adapter, fetch } = withResponse({});
      for (const operation of [
        () =>
          adapter.captureSource(repositoryId, {
            ...sourceCaptureRequestFixture(),
            ...extra,
          } as never),
        () =>
          adapter.createSuite(repositoryId, { ...suiteCreateRequestFixture(), ...extra } as never),
        () =>
          adapter.saveSuiteDraft(evaluationTestSuiteScope, {
            ...suiteSaveRequestFixture(),
            ...extra,
          } as never),
        () =>
          adapter.publishSuite(evaluationTestSuiteScope, {
            ...suitePublishRequestFixture(),
            ...extra,
          } as never),
      ])
        await expect(operation()).rejects.toBeInstanceOf(ReviewControlRequestError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects snapshots, execution mappings and invalid CAS in mutation bodies", async () => {
    const { adapter, fetch } = withResponse({});
    const save = suiteSaveRequestFixture();
    const entry = suiteDraftCaseFixture();
    for (const operation of [
      () =>
        adapter.captureSource(repositoryId, {
          ...sourceCaptureRequestFixture(),
          snapshot: sourceSnapshotFixture(),
        } as never),
      () => adapter.saveSuiteDraft(evaluationTestSuiteScope, { ...save, expectedRevision: 0 }),
      () =>
        adapter.publishSuite(evaluationTestSuiteScope, {
          ...suitePublishRequestFixture(),
          expectedRevision: 0,
        }),
      () =>
        adapter.saveSuiteDraft(evaluationTestSuiteScope, {
          ...save,
          draft: {
            ...save.draft,
            cases: [{ ...entry, criteria: [{ ...entry.criteria[0], baselineCheckId: "build" }] }],
          },
        } as never),
    ])
      await expect(operation()).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(readOperations)(
    "rejects malformed or foreign repository data for $name",
    async ({ read, response }) => {
      for (const value of [null, {}, { ...response(), repositoryId: "repository-b" }]) {
        await expect(read(withResponse(value).adapter)).rejects.toBeInstanceOf(
          ReviewControlProtocolError,
        );
      }
    },
  );

  it("rejects substituted source identity, snapshot digest and revision bindings", async () => {
    const detail = sourceDetailFixture();
    for (const value of [
      { ...detail, id: "source-b" },
      { ...detail, sourceDigest: "e".repeat(64) },
      { ...detail, revisionKey: "b".repeat(64) },
      { ...detail, snapshot: { ...detail.snapshot, workItemId: "work-item-b" } },
      {
        ...detail,
        snapshot: {
          ...detail.snapshot,
          repository: { ...detail.snapshot.repository, githubRepositoryId: 999 },
        },
      },
    ])
      await expect(
        withResponse(value).adapter.getSource(evaluationTestSourceScope),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("rejects foreign suite, version and case identities and malformed manifest digests", async () => {
    for (const field of ["suiteId", "versionId"] as const) {
      const list = { ...suiteCaseListFixture(), [field]: "foreign" };
      const detail = { ...suiteCaseDetailFixture(), [field]: "foreign" };
      await expect(
        withResponse(list).adapter.listSuiteCases(evaluationTestVersionScope),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
      await expect(
        withResponse(detail).adapter.getSuiteCase(evaluationTestCaseScope),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    }
    for (const field of ["sourceManifestSha256", "expectationManifestSha256"] as const) {
      await expect(
        withResponse({ ...suiteVersionFixture(), [field]: "A".repeat(64) }).adapter.getSuiteVersion(
          evaluationTestVersionScope,
        ),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
      await expect(
        withResponse({ ...suiteCaseDetailFixture(), [field]: "short" }).adapter.getSuiteCase(
          evaluationTestCaseScope,
        ),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    }
    await expect(
      withResponse({ ...suiteDetailFixture(), id: "suite-b" }).adapter.getSuite(
        evaluationTestSuiteScope,
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(
      withResponse({ ...suiteVersionFixture(), id: "version-b" }).adapter.getSuiteVersion(
        evaluationTestVersionScope,
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(
      withResponse({ ...suiteVersionFixture(), suiteId: "suite-b" }).adapter.getSuiteVersion(
        evaluationTestVersionScope,
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    const detail = suiteCaseDetailFixture();
    for (const value of [
      { ...detail, caseId: "case-2" },
      { ...detail, expectation: { ...detail.expectation, caseId: "case-2" } },
      { ...detail, source: { ...detail.source, repositoryId: "repository-b" } },
      { ...detail, source: { ...detail.source, snapshot: sourceSnapshotFixture() } },
    ])
      await expect(
        withResponse(value).adapter.getSuiteCase(evaluationTestCaseScope),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("rejects page drift, duplicate records and detail data smuggled into summary lists", async () => {
    for (const read of [readOperations[0], readOperations[2], readOperations[4]]) {
      if (!read) throw new Error("The paginated read fixture is missing.");
      for (const patch of [{ page: 2, items: [] }, { pageSize: 1 }, { total: 0 }, { items: [] }])
        await expect(
          read.read(withResponse({ ...read.response(), ...patch }).adapter),
        ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    }
    await expect(
      withResponse({ ...sourceListFixture(), items: [sourceDetailFixture()] }).adapter.listSources(
        repositoryId,
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(
      withResponse({ ...suiteListFixture(), items: [suiteDetailFixture()] }).adapter.listSuites(
        repositoryId,
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(
      withResponse({ ...suiteVersionListFixture(), suiteId: "suite-b" }).adapter.listSuiteVersions(
        evaluationTestSuiteScope,
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    const cases = suiteCaseListFixture();
    for (const value of [
      { ...cases, total: 2 },
      { ...cases, items: [...cases.items, ...cases.items], total: 2 },
      { ...cases, items: [{ ...cases.items[0], versionId: "version-b" }] },
      {
        ...cases,
        items: [{ ...cases.items[0], annotation: "unlabeled", expectedFindingCount: 1 }],
      },
    ])
      await expect(
        withResponse(value).adapter.listSuiteCases(evaluationTestVersionScope),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("binds capture receipts to the selected work item, revision and supplied operator", async () => {
    for (const patch of [
      { workItemId: "work-item-b" },
      { revisionKey: "b".repeat(64) },
      { createdBy: { ...evaluationTestActor, subject: "other" } },
    ])
      await expect(
        withResponse({ ...sourceSummaryFixture(), ...patch }).adapter.captureSource(
          repositoryId,
          sourceCaptureRequestFixture(),
          evaluationTestActor,
        ),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("binds create, save and publish receipts to submitted fields, CAS and operators", async () => {
    for (const patch of [
      { name: "Substituted name" },
      { description: "Substituted description" },
      { workflowKind: "pr_ui", target: "desktop" },
      { draftRevision: 2 },
      { caseCount: 1 },
      { createdBy: { ...evaluationTestActor, subject: "other" } },
    ])
      await expect(
        withResponse({ ...createdSuite(), ...patch }).adapter.createSuite(
          repositoryId,
          suiteCreateRequestFixture(),
          evaluationTestActor,
        ),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    for (const patch of [
      { id: "suite-b" },
      { draftRevision: 1 },
      { draftRevision: 3 },
      { name: "Substituted name" },
      { description: "Substituted description" },
      { caseCount: 0 },
      { updatedBy: { ...evaluationTestActor, subject: "other" } },
    ])
      await expect(
        withResponse({ ...suiteSummaryFixture(), ...patch }).adapter.saveSuiteDraft(
          evaluationTestSuiteScope,
          suiteSaveRequestFixture(),
          evaluationTestActor,
        ),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    for (const patch of [
      { suiteId: "suite-b" },
      { sourceDraftRevision: 1 },
      { sourceDraftRevision: 3 },
      { createdBy: { ...evaluationTestActor, subject: "other" } },
    ])
      await expect(
        withResponse({ ...suiteVersionFixture(), ...patch }).adapter.publishSuite(
          evaluationTestSuiteScope,
          suitePublishRequestFixture(),
          evaluationTestActor,
        ),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("accepts server-owned mutation actors when no expected operator is supplied", async () => {
    const serverActor = { ...evaluationTestActor, subject: "server-authenticated-operator" };
    await expect(
      withResponse({ ...sourceSummaryFixture(), createdBy: serverActor }).adapter.captureSource(
        repositoryId,
        sourceCaptureRequestFixture(),
      ),
    ).resolves.toMatchObject({ createdBy: serverActor });
    await expect(
      withResponse({
        ...createdSuite(),
        createdBy: serverActor,
        updatedBy: serverActor,
      }).adapter.createSuite(repositoryId, suiteCreateRequestFixture()),
    ).resolves.toMatchObject({ createdBy: serverActor });
    await expect(
      withResponse({ ...suiteSummaryFixture(), updatedBy: serverActor }).adapter.saveSuiteDraft(
        evaluationTestSuiteScope,
        suiteSaveRequestFixture(),
      ),
    ).resolves.toMatchObject({ updatedBy: serverActor });
    await expect(
      withResponse({ ...suiteVersionFixture(), createdBy: serverActor }).adapter.publishSuite(
        evaluationTestSuiteScope,
        suitePublishRequestFixture(),
      ),
    ).resolves.toMatchObject({ createdBy: serverActor });
  });

  it("captures mutation inputs before awaiting and never reads changed caller objects", async () => {
    const actor = { ...evaluationTestActor };
    const scope = { ...evaluationTestSuiteScope };
    const request = suiteSaveRequestFixture();
    const original = structuredClone(request);
    const { adapter, fetch, complete } = delayedResponse();
    const pending = adapter.saveSuiteDraft(scope, request, actor);
    request.changeId = "changed-in-flight";
    request.expectedRevision = 99;
    request.draft.name = "Changed in flight";
    request.draft.cases[0]?.criteria.splice(0);
    actor.subject = "changed-operator";
    scope.repositoryId = "repository-b";
    scope.suiteId = "suite-b";
    complete(suiteSummaryFixture());
    await expect(pending).resolves.toEqual(suiteSummaryFixture());
    expect(fetch.mock.calls[0]?.[0]).toBe(`${root}/evaluation-suites/suite-a/draft`);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(original);
  });

  it("captures read scope and pagination before awaiting the response", async () => {
    const scope = { ...evaluationTestSuiteScope };
    const query = { page: 1, pageSize: 20 };
    const { adapter, fetch, complete } = delayedResponse();
    const pending = adapter.listSuiteVersions(scope, query);
    scope.repositoryId = "repository-b";
    scope.suiteId = "suite-b";
    query.page = 2;
    query.pageSize = 1;
    complete(suiteVersionListFixture());
    await expect(pending).resolves.toEqual(suiteVersionListFixture());
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `${root}/evaluation-suites/suite-a/versions?page=1&pageSize=20`,
    );
  });

  it("never mutates frozen caller inputs and preserves labels and negative expectations", async () => {
    const draft = suiteDraftFixture();
    draft.cases.push(
      { ...suiteDraftCaseFixture(2), findings: { annotation: "unlabeled", expected: [] } },
      {
        ...suiteDraftCaseFixture(3),
        findings: {
          annotation: "partial",
          expected: [
            { expectedFindingId: "finding-1", description: "Only this known defect is labeled." },
          ],
        },
      },
      {
        ...suiteDraftCaseFixture(4),
        applicability: {
          state: "not_applicable",
          reason: "This platform does not execute the check.",
        },
      },
    );
    const request = { ...suiteSaveRequestFixture(), draft };
    const original = structuredClone(request);
    const freeze = (value: object) => {
      for (const child of Object.values(value))
        if (child !== null && typeof child === "object") freeze(child);
      Object.freeze(value);
    };
    freeze(request);
    const { adapter, fetch } = withResponse(suiteSummaryFixture(draft));
    await adapter.saveSuiteDraft(
      Object.freeze({ ...evaluationTestSuiteScope }),
      request,
      Object.freeze({ ...evaluationTestActor }),
    );
    expect(request).toEqual(original);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(original);
    await expect(
      withResponse(suiteDetailFixture(draft)).adapter.getSuite(evaluationTestSuiteScope),
    ).resolves.toEqual(suiteDetailFixture(draft));
    await expect(
      withResponse(suiteCaseListFixture(draft.cases)).adapter.listSuiteCases(
        evaluationTestVersionScope,
      ),
    ).resolves.toEqual(suiteCaseListFixture(draft.cases));
    for (const entry of draft.cases) {
      const detail = suiteCaseDetailFixture(entry);
      await expect(
        withResponse(detail).adapter.getSuiteCase({
          ...evaluationTestCaseScope,
          caseId: entry.caseId,
        }),
      ).resolves.toEqual(detail);
    }
  });

  it("manually retries every mutation with the identical change ID and body after a lost response", async () => {
    const operations = [
      {
        request: sourceCaptureRequestFixture(),
        response: sourceSummaryFixture(),
        mutate: (adapter: HttpEvaluationAdapter, request: never) =>
          adapter.captureSource(repositoryId, request, evaluationTestActor),
      },
      {
        request: suiteCreateRequestFixture(),
        response: createdSuite(),
        mutate: (adapter: HttpEvaluationAdapter, request: never) =>
          adapter.createSuite(repositoryId, request, evaluationTestActor),
      },
      {
        request: suiteSaveRequestFixture(),
        response: suiteSummaryFixture(),
        mutate: (adapter: HttpEvaluationAdapter, request: never) =>
          adapter.saveSuiteDraft(evaluationTestSuiteScope, request, evaluationTestActor),
      },
      {
        request: suitePublishRequestFixture(),
        response: suiteVersionFixture(),
        mutate: (adapter: HttpEvaluationAdapter, request: never) =>
          adapter.publishSuite(evaluationTestSuiteScope, request, evaluationTestActor),
      },
    ];
    for (const operation of operations) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValueOnce(new Error("Lost response after the server accepted the change."))
        .mockResolvedValueOnce(json(operation.response));
      const adapter = new HttpEvaluationAdapter({ fetch });
      await expect(operation.mutate(adapter, operation.request as never)).rejects.toBeInstanceOf(
        ReviewControlNetworkError,
      );
      expect(fetch).toHaveBeenCalledOnce();
      await expect(operation.mutate(adapter, operation.request as never)).resolves.toEqual(
        operation.response,
      );
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[0]?.[1]?.body).toBe(fetch.mock.calls[1]?.[1]?.body);
      expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual(operation.request);
    }
  });

  it.each(readOperations)("aborts obsolete $name reads before fetching", async ({ read }) => {
    const controller = new AbortController();
    const reason = new Error("The selected evaluation scope changed.");
    controller.abort(reason);
    const { adapter, fetch } = withResponse({});
    await expect(read(adapter, controller.signal)).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards in-flight read cancellation without presenting an empty result", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    const pending = new HttpEvaluationAdapter({ fetch }).getSource(
      evaluationTestSourceScope,
      controller.signal,
    );
    const reason = new Error("The source selection changed.");
    const rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(readOperations)(
    "propagates authorization and network failures for $name",
    async ({ read }) => {
      const forbidden = new HttpEvaluationAdapter({
        fetch: vi.fn(async () => json({ code: "forbidden", message: "Access was revoked." }, 403)),
      });
      await expect(read(forbidden)).rejects.toBeInstanceOf(ReviewControlHttpError);
      const unavailable = new HttpEvaluationAdapter({
        fetch: vi.fn(async () => {
          throw new Error("offline");
        }),
      });
      await expect(read(unavailable)).rejects.toBeInstanceOf(ReviewControlNetworkError);
    },
  );

  it("retains a maximum-size source snapshot plus its separate detail metadata", async () => {
    const snapshot = sourceSnapshotFixture();
    snapshot.workItem.body = "";
    const remaining = maximumEvaluationSourceSnapshotUtf8Bytes - byteLength(snapshot);
    snapshot.workItem.body = "\u20ac".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
    const detail = sourceDetailFixture(snapshot);
    expect(byteLength(snapshot)).toBe(maximumEvaluationSourceSnapshotUtf8Bytes);
    expect(byteLength(detail)).toBeGreaterThan(maximumEvaluationSourceSnapshotUtf8Bytes);
    expect(byteLength(detail)).toBeLessThan(maximumEvaluationSourceDetailUtf8Bytes);
    await expect(
      withResponse(detail).adapter.getSource(evaluationTestSourceScope),
    ).resolves.toEqual(detail);
  });

  it("accepts a maximum-size draft request and a larger valid suite detail envelope", async () => {
    const request = suiteSaveRequestFixture();
    const envelopeBytes = byteLength(request) - byteLength(request.draft);
    request.draft = draftAtByteLimit(maximumEvaluationSuiteUtf8Bytes - envelopeBytes);
    expect(byteLength(request)).toBe(maximumEvaluationSuiteUtf8Bytes);
    const { adapter, fetch } = withResponse(suiteSummaryFixture(request.draft));
    await expect(adapter.saveSuiteDraft(evaluationTestSuiteScope, request)).resolves.toEqual(
      suiteSummaryFixture(request.draft),
    );
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(request));
    const detail = suiteDetailFixture(draftAtByteLimit(maximumEvaluationSuiteUtf8Bytes));
    expect(byteLength(detail)).toBeGreaterThan(maximumEvaluationSuiteUtf8Bytes);
    await expect(withResponse(detail).adapter.getSuite(evaluationTestSuiteScope)).resolves.toEqual(
      detail,
    );
  });

  it("rejects oversized requests before fetch and oversized source detail responses", async () => {
    const request = suiteSaveRequestFixture();
    request.draft = draftAtByteLimit(maximumEvaluationSuiteUtf8Bytes);
    const { adapter, fetch } = withResponse({});
    await expect(adapter.saveSuiteDraft(evaluationTestSuiteScope, request)).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    expect(fetch).not.toHaveBeenCalled();
    const source = sourceDetailFixture();
    source.snapshot.workItem.body = "x".repeat(maximumEvaluationSourceDetailUtf8Bytes);
    await expect(
      withResponse(source).adapter.getSource(evaluationTestSourceScope),
    ).rejects.toBeInstanceOf(ReviewControlResponseTooLargeError);
  });
});
