import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
  EvaluationBatchCancellationV1,
  EvaluationBatchCancelRequest,
  EvaluationBatchCreateRequest,
  EvaluationBatchDetailV1,
  EvaluationBatchListV1,
  EvaluationBatchMatrixV1,
  EvaluationBatchSummaryV1,
  EvaluationPromptOptionsV1,
  EvaluationSourceCaptureRequest,
  EvaluationSourceDetailV1,
  EvaluationSourceListResponse,
  EvaluationSourceSummaryV1,
  EvaluationSuiteCaseDetailV1,
  EvaluationSuiteCaseListV1,
  EvaluationSuiteCreateRequest,
  EvaluationSuiteDetailV1,
  EvaluationSuiteDraft,
  EvaluationSuiteListResponse,
  EvaluationSuitePublishRequest,
  EvaluationSuiteSaveRequest,
  EvaluationSuiteSummaryV1,
  EvaluationSuiteVersionListResponse,
  EvaluationSuiteVersionV1,
  GitHubRepository,
  NormalizedSchedulingEvent,
  OperatorPrincipal,
  OperatorRepositoryRole,
  SchedulingRequestOpenedEvent,
  SelfOrAllowlistPolicy,
} from "@agentic-review/contracts";
import { WorkflowOutputSchemaVersions } from "@agentic-review/contracts";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseClient } from "../../dist/database/database-client.js";
import { DatabaseOperatorAuthPersistence } from "../../dist/database/operator-auth-persistence.js";
import { bindOperatorDatabase } from "../../dist/database/operator-database.js";
import {
  DEVELOPMENT_OPERATOR_SESSION_COOKIE,
  OPERATOR_LOGIN_PATH,
  OPERATOR_SESSION_PATH,
  registerOperatorAuthRoutes,
} from "../../dist/routes/auth.js";
import { registerEvaluationBatchRoutes } from "../../dist/routes/evaluation-batches.js";
import { registerEvaluationManagementRoutes } from "../../dist/routes/evaluation-management.js";
import { canonicalJson } from "../../dist/scheduling/canonical-json.js";
import { OperatorAuthService } from "../../dist/security/operator-auth.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const publicOrigin = "http://127.0.0.1:8080";
const host = "127.0.0.1:8080";
const observedAt = "2026-09-08T00:00:00.000Z";
const revisedAt = "2026-09-08T01:00:00.000Z";
const operator = {
  issuer: "urn:agentic-review:development",
  subject: "evaluation-integration-operator",
  displayName: "Evaluation Integration Operator",
  email: null,
};
const secondOperator = {
  ...operator,
  subject: "evaluation-integration-second-operator",
  displayName: "Second Evaluation Integration Operator",
};
const administrator = { issuer: operator.issuer, subject: "evaluation-integration-administrator" };
const principal = ({ issuer, subject }: OperatorPrincipal): OperatorPrincipal => ({
  issuer,
  subject,
});
const reviewer = { githubUserId: 100, login: "synthetic-reviewer", accountType: "user" } as const;
const policy: SelfOrAllowlistPolicy = {
  kind: "self_or_allowlist",
  policyVersion: 1,
  schedulingTargetGithubUserId: reviewer.githubUserId,
  allowlistedActorGithubUserIds: [],
  unknownActorPolicy: "deny",
  newRevisionPolicy: "require_new_authorization",
};
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const repositories: GitHubRepository[] = [211, 212].map((id) => ({
  githubRepositoryId: id,
  githubNodeId: `R_evaluation_integration_${id}`,
  ownerLogin: "integration",
  name: `evaluation-${id}`,
  fullName: `integration/evaluation-${id}`,
  htmlUrl: `https://github.com/integration/evaluation-${id}`,
  defaultBranch: "main",
  isPrivate: false,
}));

interface RuntimeFixture {
  readonly directory: string;
  readonly databasePath: string;
  app: FastifyInstance | undefined;
  database: DatabaseClient | undefined;
}
interface RuntimeOptions {
  readonly recoveryMaintenance?: boolean;
  readonly identity?: typeof operator;
}
const fixtures: RuntimeFixture[] = [];

function owner(fixture: RuntimeFixture): DatabaseClient {
  if (!fixture.database) throw new Error("The real database owner is not running.");
  return fixture.database;
}

async function startRuntime(fixture: RuntimeFixture, options: RuntimeOptions = {}): Promise<void> {
  fixture.database = await DatabaseClient.create({
    databasePath: fixture.databasePath,
    migrationsDirectory,
    recoveryMaintenance: options.recoveryMaintenance === true,
    operatorAccess: { administrators: [administrator] },
  });
  expect(await owner(fixture).request("ping", {})).toMatchObject({ schemaVersion: 31 });
  const auth = new OperatorAuthService({
    config: {
      mode: "loopback",
      environment: "development",
      publicOrigin,
      loginTransactionTtlSeconds: 600,
      sessionTtlSeconds: 3_600,
      postLoginRedirectPath: "/evaluations",
      developmentIdentity: options.identity ?? operator,
    },
    persistence: new DatabaseOperatorAuthPersistence(owner(fixture)),
  });
  fixture.app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  registerOperatorAuthRoutes(fixture.app, auth);
  registerEvaluationManagementRoutes(fixture.app, {
    database: owner(fixture),
    operatorAuth: auth,
    readOnly: options.recoveryMaintenance === true,
  });
  registerEvaluationBatchRoutes(fixture.app, {
    database: owner(fixture),
    operatorAuth: auth,
    readOnly: options.recoveryMaintenance === true,
  });
  await fixture.app.ready();
}

async function closeRuntime(fixture: RuntimeFixture): Promise<void> {
  try {
    await fixture.app?.close();
  } finally {
    fixture.app = undefined;
    await fixture.database?.close();
    fixture.database = undefined;
  }
}

async function createFixture(): Promise<RuntimeFixture> {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-evaluation-management-"));
  const fixture: RuntimeFixture = {
    directory,
    databasePath: join(directory, "server.sqlite"),
    app: undefined,
    database: undefined,
  };
  fixtures.push(fixture);
  await startRuntime(fixture);
  return fixture;
}

async function inject(fixture: RuntimeFixture, options: InjectOptions, expectedStatus: number) {
  if (!fixture.app) throw new Error("The integration HTTP app is not running.");
  const response = await fixture.app.inject({
    ...options,
    remoteAddress: "127.0.0.1",
    headers: { host, ...options.headers },
  });
  expect(response.statusCode, response.body).toBe(expectedStatus);
  return response;
}

async function login(fixture: RuntimeFixture): Promise<string> {
  const response = await inject(
    fixture,
    {
      method: "POST",
      url: OPERATOR_LOGIN_PATH,
      headers: { origin: publicOrigin },
    },
    303,
  );
  const header = response.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : header === undefined ? [] : [header];
  const cookie = cookies.find((entry) =>
    entry.startsWith(`${DEVELOPMENT_OPERATOR_SESSION_COOKIE}=`),
  );
  if (!cookie) throw new Error("Real loopback login did not issue a session cookie.");
  return cookie.split(";", 1)[0] ?? "";
}

async function get(fixture: RuntimeFixture, cookie: string, url: string, status = 200) {
  return inject(fixture, { method: "GET", url, headers: { cookie } }, status);
}

async function mutate(
  fixture: RuntimeFixture,
  cookie: string,
  method: "POST" | "PUT",
  url: string,
  payload: string,
  status = 200,
) {
  return inject(
    fixture,
    {
      method,
      url,
      payload,
      headers: { cookie, origin: publicOrigin, "content-type": "application/json" },
    },
    status,
  );
}

function eventFor(
  repository: GitHubRepository,
  kind: "pull_request" | "issue",
): SchedulingRequestOpenedEvent {
  const githubWorkItemId = repository.githubRepositoryId * 1000 + 7;
  const common = {
    githubRepositoryId: repository.githubRepositoryId,
    githubWorkItemId,
    githubNodeId: `W_evaluation_${githubWorkItemId}`,
    number: 7,
    title: "Frozen evaluation sample number seven",
    body: "The original synthetic report body.",
    state: "open" as const,
    author: reviewer,
    htmlUrl: `${repository.htmlUrl}/${kind === "pull_request" ? "pull" : "issues"}/7`,
    createdAt: observedAt,
    updatedAt: observedAt,
    closedAt: null,
  };
  const workItem =
    kind === "pull_request" ? { ...common, kind, isDraft: false } : { ...common, kind };
  const baseSha = "a".repeat(40),
    headSha = "b".repeat(40);
  const revisionKey =
    kind === "pull_request"
      ? digest(`${baseSha}\0${headSha}`)
      : digest(JSON.stringify([workItem.title, workItem.body, workItem.state, workItem.updatedAt]));
  return {
    contractVersion: 1,
    eventId: `evaluation-event-${githubWorkItemId}`,
    source: "webhook",
    sourceEventId: `evaluation-delivery-${githubWorkItemId}`,
    occurredAt: observedAt,
    observedAt,
    repository,
    workItem,
    revision: {
      githubRepositoryId: repository.githubRepositoryId,
      githubWorkItemId,
      revisionKey,
      observedAt,
      sourceUpdatedAt: observedAt,
      ...(kind === "pull_request"
        ? { kind, baseSha, headSha }
        : { kind, contentDigest: revisionKey }),
    },
    author: reviewer,
    action: "request_opened",
    requestKind: kind === "pull_request" ? "review_request" : "assignment",
    actor: reviewer,
    target: reviewer,
  };
}

async function ingest(fixture: RuntimeFixture, event: NormalizedSchedulingEvent) {
  const result = await owner(fixture).request("ingestSchedulingEvent", {
    allowScheduling: false,
    event,
    policy,
    schedule: null,
    delivery: {
      deliveryId: event.sourceEventId,
      eventName: event.workItem.kind,
      payloadSha256: digest(canonicalJson(event)),
      receivedAt: event.observedAt,
    },
  });
  expect(result.jobCreated).toBe(false);
  expect(result.jobId).toBeNull();
  expect(result.openedRequestEpochId).toBeNull();
  return result;
}

async function setRole(
  fixture: RuntimeFixture,
  repositoryId: string,
  role: OperatorRepositoryRole | null,
  expectedVersion = 0,
  actor: OperatorPrincipal = principal(operator),
): Promise<void> {
  await bindOperatorDatabase(owner(fixture), administrator).request("changeRepositoryAccess", {
    repositoryId,
    actor: administrator,
    request: {
      principal: actor,
      role,
      expectedVersion,
      changeId: `access-${digest(canonicalJson({ repositoryId, actor, expectedVersion }))}`,
      reason: "Configure only the isolated evaluation integration fixture.",
    },
  });
}

async function seed(fixture: RuntimeFixture, kind: "pull_request" | "issue") {
  await owner(fixture).request("bootstrapManagedRepositories", {
    repositories: repositories.map(({ githubRepositoryId, fullName }) => ({
      githubRepositoryId,
      fullName,
    })),
    reviewer,
    authorizationPolicy: policy,
  });
  const entries: {
    event: SchedulingRequestOpenedEvent;
    repositoryId: string;
    workItemId: string;
  }[] = [];
  for (const repository of repositories) {
    const event = eventFor(repository, kind);
    const stored = await ingest(fixture, event);
    await setRole(fixture, stored.repositoryId, "maintainer");
    await setRole(fixture, stored.repositoryId, "maintainer", 0, principal(secondOperator));
    entries.push({ event, repositoryId: stored.repositoryId, workItemId: stored.workItemId });
  }
  const first = entries[0],
    second = entries[1];
  if (!first || !second) throw new Error("The integration fixture requires two repositories.");
  expect(first.event.workItem.number).toBe(second.event.workItem.number);
  expect(first.workItemId).not.toBe(second.workItemId);
  return { first, second };
}

async function revise(fixture: RuntimeFixture, event: SchedulingRequestOpenedEvent) {
  const workItem = {
    ...event.workItem,
    body: "A newer source body outside the frozen sample.",
    updatedAt: revisedAt,
  };
  const headSha = "d".repeat(40);
  const revisionKey =
    event.revision.kind === "pull_request"
      ? digest(`${event.revision.baseSha}\0${headSha}`)
      : digest(JSON.stringify([workItem.title, workItem.body, workItem.state, workItem.updatedAt]));
  await ingest(fixture, {
    ...event,
    eventId: `${event.eventId}-revised`,
    sourceEventId: `${event.sourceEventId}-revised`,
    action: "revision_observed",
    requestKind: null,
    actor: null,
    target: null,
    occurredAt: revisedAt,
    observedAt: revisedAt,
    workItem,
    revision: {
      ...event.revision,
      revisionKey,
      observedAt: revisedAt,
      sourceUpdatedAt: revisedAt,
      ...(event.revision.kind === "pull_request" ? { headSha } : { contentDigest: revisionKey }),
    },
  });
  return { revisionKey };
}

const base = (repositoryId: string) => `/api/v1/operator/repositories/${repositoryId}`;

async function publishThroughHttp(
  fixture: RuntimeFixture,
  cookie: string,
  source: Awaited<ReturnType<typeof seed>>["first"],
) {
  const root = base(source.repositoryId);
  const capture: EvaluationSourceCaptureRequest = {
    changeId: "capture-original",
    source: {
      kind: "current_work_item",
      workItemId: source.workItemId,
      expectedRevisionKey: source.event.revision.revisionKey,
      testedIssueCommit: source.event.workItem.kind === "issue" ? "c".repeat(40) : null,
    },
  };
  const capturePayload = JSON.stringify(capture);
  const captureResponse = await mutate(
    fixture,
    cookie,
    "POST",
    `${root}/evaluation-sources`,
    capturePayload,
  );
  const captured = captureResponse.json<EvaluationSourceSummaryV1>();
  expect(captured.createdBy).toEqual(principal(operator));
  const detail = (
    await get(fixture, cookie, `${root}/evaluation-sources/${captured.id}`)
  ).json<EvaluationSourceDetailV1>();
  expect(detail.snapshot.workItem).toEqual(source.event.workItem);
  const create: EvaluationSuiteCreateRequest = {
    changeId: "create-original",
    name: "HTTP frozen known examples",
    description: "Independent human labels and immutable captured sources.",
    workflowKind: source.event.workItem.kind === "issue" ? "issue_validation" : "pr_static_build",
    target: "headless",
  };
  const createPayload = JSON.stringify(create);
  const createResponse = await mutate(
    fixture,
    cookie,
    "POST",
    `${root}/evaluation-suites`,
    createPayload,
  );
  const suite = createResponse.json<EvaluationSuiteSummaryV1>();
  const draft: EvaluationSuiteDraft = {
    name: create.name,
    description: create.description,
    cases: [
      {
        caseId: "case-seven",
        title: "Known failure in the original snapshot",
        sourceId: captured.id,
        applicability: { state: "applicable" },
        criteria: [
          {
            criterionId: "criterion-build",
            description: "The known failing build is observed.",
            applicability: { state: "applicable" },
            expectedOutcome: "failed",
          },
        ],
        findings: { annotation: "complete", expected: [] },
      },
    ],
  };
  const save: EvaluationSuiteSaveRequest = {
    changeId: "save-original",
    expectedRevision: suite.draftRevision,
    draft,
  };
  const savePayload = JSON.stringify(save);
  const saveResponse = await mutate(
    fixture,
    cookie,
    "PUT",
    `${root}/evaluation-suites/${suite.id}/draft`,
    savePayload,
  );
  const saved = saveResponse.json<EvaluationSuiteSummaryV1>();
  const changed = await revise(fixture, source.event);
  const publish: EvaluationSuitePublishRequest = {
    changeId: "publish-original",
    expectedRevision: saved.draftRevision,
  };
  const publishPayload = JSON.stringify(publish);
  const publishResponse = await mutate(
    fixture,
    cookie,
    "POST",
    `${root}/evaluation-suites/${suite.id}/versions`,
    publishPayload,
  );
  const version = publishResponse.json<EvaluationSuiteVersionV1>();
  expect(version).toMatchObject({
    suiteId: suite.id,
    sourceDraftRevision: 2,
    version: 1,
    caseCount: 1,
    createdBy: principal(operator),
  });
  const replays = [
    {
      method: "POST",
      path: `${root}/evaluation-sources`,
      payload: capturePayload,
      response: canonicalJson(captureResponse.json()),
    },
    {
      method: "POST",
      path: `${root}/evaluation-suites`,
      payload: createPayload,
      response: canonicalJson(createResponse.json()),
    },
    {
      method: "PUT",
      path: `${root}/evaluation-suites/${suite.id}/draft`,
      payload: savePayload,
      response: canonicalJson(saveResponse.json()),
    },
    {
      method: "POST",
      path: `${root}/evaluation-suites/${suite.id}/versions`,
      payload: publishPayload,
      response: canonicalJson(publishResponse.json()),
    },
  ] as const;
  return { root, capture, captured, detail, suite, saved, draft, version, replays, changed };
}

function persisted(fixture: RuntimeFixture) {
  if (fixture.database !== undefined)
    throw new Error("Close the owner before inspecting its persisted rows.");
  const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
  try {
    expect(
      database
        .prepare("SELECT COUNT(*) AS count, MAX(version) AS latest FROM schema_migrations")
        .get(),
    ).toEqual({ count: 31, latest: 31 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const execution = database
      .prepare(`SELECT
      (SELECT COUNT(*) FROM jobs) AS jobs,
      (SELECT COUNT(*) FROM run_attempts) AS attempts,
      (SELECT COUNT(*) FROM workers) AS workers,
      (SELECT COUNT(*) FROM review_runs) AS reviewRuns,
      (SELECT COUNT(*) FROM evaluations) AS evaluations`)
      .get();
    expect(execution).toEqual({ jobs: 0, attempts: 0, workers: 0, reviewRuns: 0, evaluations: 0 });
    return {
      execution,
      sources: database.prepare("SELECT * FROM evaluation_sources ORDER BY id").all(),
      suites: database.prepare("SELECT * FROM evaluation_suites ORDER BY id").all(),
      sourceVersions: database
        .prepare("SELECT * FROM evaluation_source_versions ORDER BY id")
        .all(),
      expectationVersions: database
        .prepare("SELECT * FROM evaluation_expectation_versions ORDER BY id")
        .all(),
      suiteVersions: database.prepare("SELECT * FROM evaluation_suite_versions ORDER BY id").all(),
      receipts: database
        .prepare("SELECT * FROM evaluation_mutation_receipts ORDER BY repository_id, change_id")
        .all(),
    };
  } finally {
    database.close();
  }
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await closeRuntime(fixture);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== "linux")(
  "production evaluation management integration",
  () => {
    it("persists the authenticated PR suite across real owner restarts and binds every replay to its cookie identity", async () => {
      const fixture = await createFixture();
      const { first, second } = await seed(fixture, "pull_request");
      await inject(
        fixture,
        { method: "GET", url: `${base(first.repositoryId)}/evaluation-sources` },
        401,
      );
      const cookie = await login(fixture);
      expect((await get(fixture, cookie, OPERATOR_SESSION_PATH)).json()).toMatchObject({
        authenticated: true,
        operator,
      });
      const batch = await publishThroughHttp(fixture, cookie, first);
      const sourceList = (
        await get(fixture, cookie, `${batch.root}/evaluation-sources?page=1&pageSize=1`)
      ).json<EvaluationSourceListResponse>();
      expect(sourceList).toMatchObject({ total: 1, page: 1, pageSize: 1, items: [batch.captured] });
      expect(sourceList.items[0]).not.toHaveProperty("snapshot");
      const suiteDetail = (
        await get(fixture, cookie, `${batch.root}/evaluation-suites/${batch.suite.id}`)
      ).json<EvaluationSuiteDetailV1>();
      expect(suiteDetail).toMatchObject({
        draftRevision: 3,
        latestVersionId: batch.version.id,
        draft: batch.draft,
      });
      const suiteList = (
        await get(fixture, cookie, `${batch.root}/evaluation-suites`)
      ).json<EvaluationSuiteListResponse>();
      expect(suiteList.total).toBe(1);
      expect(suiteList.items[0]).not.toHaveProperty("draft");
      const versionPath = `${batch.root}/evaluation-suites/${batch.suite.id}/versions/${batch.version.id}`;
      expect((await get(fixture, cookie, versionPath)).json()).toEqual(batch.version);
      const versions = (
        await get(fixture, cookie, `${batch.root}/evaluation-suites/${batch.suite.id}/versions`)
      ).json<EvaluationSuiteVersionListResponse>();
      expect(versions.items).toEqual([batch.version]);
      expect(
        (
          await get(fixture, cookie, `${batch.root}/evaluation-sources/${batch.captured.id}`)
        ).json(),
      ).toEqual(batch.detail);
      const casesPath = `${versionPath}/cases`;
      const casePath = `${casesPath}/case-seven`;
      const frozenCases = (await get(fixture, cookie, casesPath)).json<EvaluationSuiteCaseListV1>();
      const frozenCase = (await get(fixture, cookie, casePath)).json<EvaluationSuiteCaseDetailV1>();
      expect(frozenCases).toMatchObject({
        versionId: batch.version.id,
        sourceVersionId: batch.version.sourceVersionId,
        expectationVersionId: batch.version.expectationVersionId,
        total: 1,
        items: [
          {
            caseId: "case-seven",
            sourceId: batch.captured.id,
            sourceDigest: batch.captured.sourceDigest,
          },
        ],
      });
      expect(frozenCase).toMatchObject({
        caseId: "case-seven",
        source: batch.captured,
        expectation: {
          criteria: [{ expectedOutcome: "failed" }],
          findings: { annotation: "complete", expected: [] },
        },
      });
      const updatedCapture = (
        await mutate(
          fixture,
          cookie,
          "POST",
          `${batch.root}/evaluation-sources`,
          JSON.stringify({
            changeId: "capture-updated-draft-source",
            source: {
              kind: "current_work_item",
              workItemId: first.workItemId,
              expectedRevisionKey: batch.changed.revisionKey,
              testedIssueCommit: null,
            },
          } satisfies EvaluationSourceCaptureRequest),
        )
      ).json<EvaluationSourceSummaryV1>();
      const replacementDraft: EvaluationSuiteDraft = {
        ...batch.draft,
        cases: [
          {
            caseId: "case-seven",
            title: "Different unpublished expectations",
            sourceId: updatedCapture.id,
            applicability: { state: "applicable" },
            criteria: [
              {
                criterionId: "criterion-build",
                description: "The later draft expects success.",
                applicability: { state: "applicable" },
                expectedOutcome: "passed",
              },
            ],
            findings: {
              annotation: "partial",
              expected: [
                {
                  expectedFindingId: "new-draft-finding",
                  description: "This expected finding exists only in the draft.",
                },
              ],
            },
          },
        ],
      };
      const changedDraft = (
        await mutate(
          fixture,
          cookie,
          "PUT",
          `${batch.root}/evaluation-suites/${batch.suite.id}/draft`,
          JSON.stringify({
            changeId: "save-after-publication",
            expectedRevision: suiteDetail.draftRevision,
            draft: replacementDraft,
          } satisfies EvaluationSuiteSaveRequest),
        )
      ).json<EvaluationSuiteSummaryV1>();
      expect(changedDraft.draftRevision).toBe(4);
      expect((await get(fixture, cookie, casesPath)).json()).toEqual(frozenCases);
      expect((await get(fixture, cookie, casePath)).json()).toEqual(frozenCase);
      for (const replay of batch.replays) {
        expect(
          canonicalJson(
            (await mutate(fixture, cookie, replay.method, replay.path, replay.payload)).json(),
          ),
        ).toBe(replay.response);
      }

      const secondRoot = base(second.repositoryId);
      for (const path of [
        `${secondRoot}/evaluation-sources/${batch.captured.id}`,
        `${secondRoot}/evaluation-suites/${batch.suite.id}`,
        `${secondRoot}/evaluation-suites/${batch.suite.id}/versions/${batch.version.id}`,
        `${secondRoot}/evaluation-suites/${batch.suite.id}/versions/${batch.version.id}/cases`,
        `${secondRoot}/evaluation-suites/${batch.suite.id}/versions/${batch.version.id}/cases/case-seven`,
      ])
        await get(fixture, cookie, path, 404);
      await mutate(
        fixture,
        cookie,
        "POST",
        `${secondRoot}/evaluation-sources`,
        batch.replays[0].payload,
        404,
      );
      const foreignCapture = await mutate(
        fixture,
        cookie,
        "POST",
        `${secondRoot}/evaluation-sources`,
        JSON.stringify({
          changeId: "capture-second-repository",
          source: {
            kind: "current_work_item",
            workItemId: second.workItemId,
            expectedRevisionKey: second.event.revision.revisionKey,
            testedIssueCommit: null,
          },
        } satisfies EvaluationSourceCaptureRequest),
      );
      expect(foreignCapture.json<EvaluationSourceSummaryV1>()).toMatchObject({
        repositoryId: second.repositoryId,
        number: 7,
      });

      for (const headers of [{ cookie }, { cookie, origin: "https://untrusted.example.test" }]) {
        const denied = await inject(
          fixture,
          {
            method: "POST",
            url: batch.replays[0].path,
            payload: batch.replays[0].payload,
            headers: { ...headers, "content-type": "application/json" },
          },
          403,
        );
        expect(denied.json()).toMatchObject({ code: "invalid_operator_auth_origin" });
      }
      await mutate(
        fixture,
        cookie,
        "POST",
        batch.replays[0].path,
        JSON.stringify({ ...batch.capture, actor: administrator }),
        400,
      );
      await expect(
        bindOperatorDatabase(owner(fixture), principal(operator)).request(
          "captureEvaluationSource",
          {
            repositoryId: first.repositoryId,
            actor: administrator,
            request: batch.capture,
          },
        ),
      ).rejects.toMatchObject({ code: "PLATFORM_FORBIDDEN" });

      await closeRuntime(fixture);
      const beforeRestart = persisted(fixture);
      expect(beforeRestart.sources).toHaveLength(3);
      expect(beforeRestart.suites).toHaveLength(1);
      expect(beforeRestart.sourceVersions).toHaveLength(1);
      expect(beforeRestart.expectationVersions).toHaveLength(1);
      expect(beforeRestart.suiteVersions).toHaveLength(1);
      expect(beforeRestart.receipts).toHaveLength(7);
      expect(
        beforeRestart.receipts.every(
          (row) => row.actor_issuer === operator.issuer && row.actor_subject === operator.subject,
        ),
      ).toBe(true);
      const sourceManifest = JSON.parse(String(beforeRestart.sourceVersions[0]?.manifest_json));
      expect(sourceManifest.cases).toEqual([
        {
          caseId: "case-seven",
          sourceId: batch.captured.id,
          sourceDigest: batch.captured.sourceDigest,
        },
      ]);
      expect(sourceManifest.cases[0]).not.toHaveProperty("findings");
      expect(digest(String(beforeRestart.sourceVersions[0]?.manifest_json))).toBe(
        batch.version.sourceManifestSha256,
      );
      expect(digest(String(beforeRestart.expectationVersions[0]?.manifest_json))).toBe(
        batch.version.expectationManifestSha256,
      );

      await startRuntime(fixture);
      expect((await get(fixture, cookie, OPERATOR_SESSION_PATH)).json()).toMatchObject({
        authenticated: true,
        operator,
      });
      expect((await get(fixture, cookie, versionPath)).json()).toEqual(batch.version);
      expect(
        (
          await get(fixture, cookie, `${batch.root}/evaluation-sources/${batch.captured.id}`)
        ).json(),
      ).toEqual(batch.detail);
      expect((await get(fixture, cookie, casePath)).json()).toEqual(frozenCase);
      for (const replay of batch.replays)
        expect(
          canonicalJson(
            (await mutate(fixture, cookie, replay.method, replay.path, replay.payload)).json(),
          ),
        ).toBe(replay.response);
      await closeRuntime(fixture);
      expect(persisted(fixture)).toEqual(beforeRestart);

      await startRuntime(fixture, { identity: secondOperator });
      const secondCookie = await login(fixture);
      expect((await get(fixture, secondCookie, OPERATOR_SESSION_PATH)).json()).toMatchObject({
        authenticated: true,
        operator: secondOperator,
      });
      await get(fixture, cookie, versionPath, 401);
      const actorMismatch = await mutate(
        fixture,
        secondCookie,
        "POST",
        batch.replays[0].path,
        batch.replays[0].payload,
        409,
      );
      expect(actorMismatch.json()).toMatchObject({ code: "platform_conflict" });
      await mutate(
        fixture,
        secondCookie,
        "POST",
        batch.replays[0].path,
        JSON.stringify({ ...batch.capture, actor: principal(operator) }),
        400,
      );
      await closeRuntime(fixture);
      expect(persisted(fixture)).toEqual(beforeRestart);
    }, 60_000);

    it("creates distinct Issue evaluation batches through authenticated HTTP and preserves scoped cancellation and recovery replays", async () => {
      const fixture = await createFixture();
      const { first, second } = await seed(fixture, "issue");
      const cookie = await login(fixture);
      const suite = await publishThroughHttp(fixture, cookie, first);
      const administrative = bindOperatorDatabase(owner(fixture), administrator);
      const promptContent = "Published batch fixture prompt body must not appear in summary APIs.";
      const template = await administrative.request("createPromptTemplate", {
        actor: administrator,
        request: {
          name: "HTTP evaluation Issue prompt",
          workflowKind: "issue_validation",
          content: promptContent,
          outputSchemaVersion: WorkflowOutputSchemaVersions.issue_validation,
        },
      });
      const prompt = await administrative.request("publishPromptDraft", {
        actor: administrator,
        templateId: template.id,
        request: { expectedVersion: template.version },
      });
      const profile = await administrative.request("publishValidationProfile", {
        actor: administrator,
        repositoryId: first.repositoryId,
        request: {
          name: "HTTP evaluation frozen build profile",
          workflowKind: "issue_validation",
          target: "headless",
          outputSchemaVersion: "ValidationReportV1",
          required: true,
          config: {
            schemaVersion: "ValidationProfileV1",
            setup: [],
            build: [
              {
                id: "compile",
                name: "Compile the frozen source",
                command: {
                  executable: "node",
                  args: ["compile.mjs"],
                  workingDirectory: ".",
                  environment: [],
                },
                timeoutMs: 30_000,
                required: true,
              },
            ],
            test: [],
            launch: [],
            cleanup: [],
            requiredCapabilities: [],
            hardTimeoutMs: 120_000,
            noProgressTimeoutMs: 60_000,
          },
        },
      });
      const promptOptionsPath = `${suite.root}/evaluation-prompt-options?workflowKind=issue_validation&page=1&pageSize=1`;
      expect(
        (await get(fixture, cookie, promptOptionsPath)).json<EvaluationPromptOptionsV1>(),
      ).toMatchObject({ total: 0, items: [] });
      await administrative.request("savePromptBinding", {
        actor: administrator,
        repositoryId: first.repositoryId,
        workflowKind: "issue_validation",
        request: { expectedVersion: 0, promptVersionId: prompt.id },
      });
      const optionsResponse = await get(fixture, cookie, promptOptionsPath);
      expect(optionsResponse.json<EvaluationPromptOptionsV1>()).toMatchObject({
        repositoryId: first.repositoryId,
        workflowKind: "issue_validation",
        total: 1,
        page: 1,
        pageSize: 1,
        items: [{ id: prompt.id, templateId: template.id, visibility: "binding" }],
      });
      expect(optionsResponse.body).not.toContain(promptContent);
      expect(optionsResponse.json<EvaluationPromptOptionsV1>().items[0]).not.toHaveProperty(
        "content",
      );
      expect(
        (
          await get(
            fixture,
            cookie,
            `${base(second.repositoryId)}/evaluation-prompt-options?workflowKind=issue_validation`,
          )
        ).json<EvaluationPromptOptionsV1>(),
      ).toMatchObject({ total: 0, items: [] });

      const batchesPath = `${suite.root}/evaluations`;
      const selection = { profileVersionId: profile.id, promptVersionId: prompt.id };
      const create: EvaluationBatchCreateRequest = {
        changeId: "batch-http-first",
        suiteId: suite.suite.id,
        suiteVersionId: suite.version.id,
        baseline: selection,
        candidate: selection,
        mode: "profile_only",
        checkMappings: [
          {
            caseId: "case-seven",
            criterionId: "criterion-build",
            baselineCheckId: `${profile.id}:compile`,
            candidateCheckId: `${profile.id}:compile`,
          },
        ],
      };
      const createPayload = JSON.stringify(create);
      const firstResponse = await mutate(fixture, cookie, "POST", batchesPath, createPayload);
      const firstBatch = firstResponse.json<EvaluationBatchSummaryV1>();
      expect(firstBatch).toMatchObject({
        repositoryId: first.repositoryId,
        suiteVersionId: suite.version.id,
        workflowKind: "issue_validation",
        target: "headless",
        mode: "profile_only",
        caseCount: 1,
        cellCount: 2,
        baseline: selection,
        candidate: selection,
        createdBy: principal(operator),
      });
      const nextPayload = JSON.stringify({ ...create, changeId: "batch-http-second" });
      const secondBatch = (
        await mutate(fixture, cookie, "POST", batchesPath, nextPayload)
      ).json<EvaluationBatchSummaryV1>();
      expect(secondBatch.id).not.toBe(firstBatch.id);
      const firstPath = `${batchesPath}/${firstBatch.id}`;
      const secondPath = `${batchesPath}/${secondBatch.id}`;
      const list = (
        await get(
          fixture,
          cookie,
          `${batchesPath}?suiteId=${suite.suite.id}&workflowKind=issue_validation&page=1&pageSize=1`,
        )
      ).json<EvaluationBatchListV1>();
      const nextPage = (
        await get(fixture, cookie, `${batchesPath}?page=2&pageSize=1`)
      ).json<EvaluationBatchListV1>();
      expect(list).toMatchObject({
        repositoryId: first.repositoryId,
        total: 2,
        page: 1,
        pageSize: 1,
      });
      expect(nextPage).toMatchObject({ total: 2, page: 2, pageSize: 1 });
      expect(new Set([...list.items, ...nextPage.items].map((item) => item.summary.id))).toEqual(
        new Set([firstBatch.id, secondBatch.id]),
      );
      expect(list.items[0]).toMatchObject({
        status: "pending",
        controlStatus: "active",
        controlVersion: 1,
        progress: { totalCells: 2, applicableCells: 2, not_run: 2, queued: 0, running: 0 },
      });
      const detailResponse = await get(fixture, cookie, firstPath);
      const detail = detailResponse.json<EvaluationBatchDetailV1>();
      expect(detail).toMatchObject({
        summary: firstBatch,
        suiteVersion: suite.version,
        status: "pending",
        control: { status: "active", version: 1 },
      });
      expect(detailResponse.body).not.toContain(promptContent);
      for (const arm of ["baseline", "candidate"] as const) {
        expect(detail.configurations[arm]).toMatchObject({
          profile: { id: profile.id },
          prompt: { id: prompt.id },
          modelRequirements: { required: false },
        });
        expect(detail.configurations[arm].profile).not.toHaveProperty("config");
        expect(detail.configurations[arm].prompt).not.toHaveProperty("content");
      }
      const matrix = (
        await get(fixture, cookie, `${firstPath}/matrix`)
      ).json<EvaluationBatchMatrixV1>();
      const nextMatrix = (
        await get(fixture, cookie, `${secondPath}/matrix`)
      ).json<EvaluationBatchMatrixV1>();
      expect(matrix).toMatchObject({
        repositoryId: first.repositoryId,
        evaluationId: firstBatch.id,
        suiteVersionId: suite.version.id,
        status: "pending",
        progress: { totalCells: 2, applicableCells: 2, not_run: 2 },
      });
      expect(matrix.cases).toHaveLength(1);
      expect(matrix.cases[0]).toMatchObject({
        caseId: "case-seven",
        source: suite.captured,
        applicability: { state: "applicable" },
      });
      const firstCells = matrix.cases.flatMap((entry) => [entry.baseline, entry.candidate]);
      const allCells = [
        ...firstCells,
        ...nextMatrix.cases.flatMap((entry) => [entry.baseline, entry.candidate]),
      ];
      expect(allCells).toHaveLength(4);
      for (const key of ["cellId", "runId", "requestId"] as const)
        expect(new Set(allCells.map((cell) => cell[key])).size).toBe(4);
      for (const cell of allCells)
        expect(cell).toMatchObject({
          trial: 1,
          profileVersionId: profile.id,
          promptVersionId: prompt.id,
          sourceId: suite.captured.id,
          sourceDigest: suite.captured.sourceDigest,
          state: "not_run",
          job: null,
          result: null,
          blockerCount: 0,
          blockers: [],
        });
      expect(firstCells.map((cell) => cell.arm)).toEqual(["baseline", "candidate"]);
      for (const suffix of ["", "/matrix"])
        await get(
          fixture,
          cookie,
          `${base(second.repositoryId)}/evaluations/${firstBatch.id}${suffix}`,
          404,
        );
      await mutate(
        fixture,
        cookie,
        "POST",
        `${base(second.repositoryId)}/evaluations`,
        createPayload,
        404,
      );

      const cancel: EvaluationBatchCancelRequest = {
        changeId: "batch-http-cancel-first",
        expectedVersion: 1,
        reason: "Cancel only this isolated synthetic evaluation batch.",
      };
      const cancelPayload = JSON.stringify(cancel);
      const cancelPath = `${firstPath}/cancel`;
      const cancellationResponse = await mutate(fixture, cookie, "POST", cancelPath, cancelPayload);
      const cancellation = cancellationResponse.json<EvaluationBatchCancellationV1>();
      expect(cancellation).toMatchObject({
        evaluationId: firstBatch.id,
        repositoryId: first.repositoryId,
        status: "cancelled",
        version: 2,
        reason: cancel.reason,
        cancelledBy: principal(operator),
        cancelledJobCount: 0,
        cancellationRequestedJobCount: 0,
      });
      const createReceipt = canonicalJson(firstResponse.json());
      const cancelReceipt = canonicalJson(cancellation);
      expect(
        canonicalJson((await mutate(fixture, cookie, "POST", cancelPath, cancelPayload)).json()),
      ).toBe(cancelReceipt);
      expect(
        canonicalJson((await mutate(fixture, cookie, "POST", batchesPath, createPayload)).json()),
      ).toBe(createReceipt);
      expect((await get(fixture, cookie, firstPath)).json<EvaluationBatchDetailV1>()).toMatchObject(
        {
          status: "cancelled",
          controlStatus: "cancelled",
          controlVersion: 2,
          progress: { totalCells: 2, cancelled: 2, not_run: 0, running: 0 },
        },
      );
      const cancelledMatrix = (
        await get(fixture, cookie, `${firstPath}/matrix`)
      ).json<EvaluationBatchMatrixV1>();
      for (const entry of cancelledMatrix.cases)
        for (const arm of ["baseline", "candidate"] as const)
          expect(entry[arm]).toMatchObject({ state: "cancelled", job: null, result: null });
      expect(
        (await get(fixture, cookie, secondPath)).json<EvaluationBatchDetailV1>(),
      ).toMatchObject({ status: "pending", controlStatus: "active", progress: { not_run: 2 } });

      // This owner is closed before any direct SQL read. Authentication and grants are excluded.
      const batchSnapshot = () => {
        if (fixture.database !== undefined)
          throw new Error("Close the owner before reading batch persistence.");
        const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
        try {
          expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
          expect(
            database
              .prepare(`SELECT (SELECT COUNT(*) FROM jobs) AS jobs,
            (SELECT COUNT(*) FROM run_attempts) AS attempts, (SELECT COUNT(*) FROM workers) AS workers,
            (SELECT COUNT(*) FROM validation_job_results) AS results, (SELECT COUNT(*) FROM request_epochs) AS epochs`)
              .get(),
          ).toEqual({ jobs: 0, attempts: 0, workers: 0, results: 0, epochs: 0 });
          const cells = database
            .prepare(
              "SELECT id, evaluation_id, run_id, request_id FROM evaluation_cells ORDER BY id",
            )
            .all();
          expect(cells).toHaveLength(4);
          expect(
            database
              .prepare("SELECT COUNT(*) AS count FROM review_runs WHERE purpose = 'evaluation'")
              .get(),
          ).toEqual({ count: 4 });
          return {
            evaluations: database.prepare("SELECT * FROM evaluations ORDER BY id").all(),
            authorizations: database
              .prepare("SELECT * FROM evaluation_authorizations ORDER BY id")
              .all(),
            controls: database
              .prepare("SELECT * FROM evaluation_controls ORDER BY evaluation_id")
              .all(),
            seals: database.prepare("SELECT * FROM evaluation_seals ORDER BY evaluation_id").all(),
            cells,
            runs: database.prepare("SELECT * FROM review_runs ORDER BY id").all(),
            requests: database
              .prepare("SELECT * FROM review_run_requests ORDER BY review_run_id, request_id")
              .all(),
            checks: database
              .prepare(
                "SELECT * FROM validation_dispatch_checks ORDER BY review_run_id, request_id",
              )
              .all(),
            receipts: database
              .prepare(
                "SELECT * FROM evaluation_mutation_receipts ORDER BY repository_id, change_id",
              )
              .all(),
          };
        } finally {
          database.close();
        }
      };
      await closeRuntime(fixture);
      const beforeRecovery = batchSnapshot();
      expect(beforeRecovery.evaluations).toHaveLength(2);
      expect(beforeRecovery.receipts).toHaveLength(7);
      await startRuntime(fixture, { recoveryMaintenance: true });
      const recoveryCookie = await login(fixture);
      expect(
        (await get(fixture, recoveryCookie, firstPath)).json<EvaluationBatchDetailV1>(),
      ).toMatchObject({ summary: firstBatch, status: "cancelled" });
      expect(
        canonicalJson(
          (await mutate(fixture, recoveryCookie, "POST", batchesPath, createPayload)).json(),
        ),
      ).toBe(createReceipt);
      expect(
        canonicalJson(
          (await mutate(fixture, recoveryCookie, "POST", cancelPath, cancelPayload)).json(),
        ),
      ).toBe(cancelReceipt);
      expect(
        (
          await mutate(
            fixture,
            recoveryCookie,
            "POST",
            batchesPath,
            JSON.stringify({ ...create, changeId: "batch-recovery-new" }),
            503,
          )
        ).json(),
      ).toMatchObject({ code: "configuration_read_only" });
      expect(
        (
          await mutate(
            fixture,
            recoveryCookie,
            "POST",
            `${secondPath}/cancel`,
            JSON.stringify({ ...cancel, changeId: "batch-recovery-new-cancel" }),
            503,
          )
        ).json(),
      ).toMatchObject({ code: "configuration_read_only" });
      expect(
        (await get(fixture, recoveryCookie, secondPath)).json<EvaluationBatchDetailV1>(),
      ).toMatchObject({ status: "pending", controlStatus: "active" });
      await closeRuntime(fixture);
      expect(batchSnapshot()).toEqual(beforeRecovery);
      await startRuntime(fixture, { recoveryMaintenance: true });
      const revokedCookie = await login(fixture);
      await setRole(fixture, first.repositoryId, "viewer", 1);
      for (const [path, payload] of [
        [batchesPath, createPayload],
        [cancelPath, cancelPayload],
      ] as const)
        expect(
          (await mutate(fixture, revokedCookie, "POST", path, payload, 403)).json(),
        ).toMatchObject({ code: "platform_forbidden" });
      await get(fixture, revokedCookie, promptOptionsPath, 403);
      await get(fixture, revokedCookie, firstPath);
      await setRole(fixture, first.repositoryId, null, 2);
      for (const [path, payload] of [
        [batchesPath, createPayload],
        [cancelPath, cancelPayload],
      ] as const)
        await mutate(fixture, revokedCookie, "POST", path, payload, 404);
      await get(fixture, revokedCookie, firstPath, 404);
      await closeRuntime(fixture);
      expect(batchSnapshot()).toEqual(beforeRecovery);
    }, 60_000);

    it("replays only the original authorized Issue mutations through a recovery owner and denies new writes or revoked access", async () => {
      const fixture = await createFixture();
      const { first } = await seed(fixture, "issue");
      const cookie = await login(fixture);
      const batch = await publishThroughHttp(fixture, cookie, first);
      expect(batch.detail.snapshot.testedSourceRevision).toEqual({
        kind: "commit",
        headSha: "c".repeat(40),
      });
      expect(batch.detail.snapshot.workItem.body).toBe("The original synthetic report body.");
      await closeRuntime(fixture);
      const beforeRecovery = persisted(fixture);
      expect(beforeRecovery.receipts).toHaveLength(4);

      await startRuntime(fixture, { recoveryMaintenance: true });
      const recoveryCookie = await login(fixture);
      expect((await get(fixture, recoveryCookie, OPERATOR_SESSION_PATH)).json()).toMatchObject({
        authenticated: true,
        operator,
      });
      const versionPath = `${batch.root}/evaluation-suites/${batch.suite.id}/versions/${batch.version.id}`;
      expect((await get(fixture, recoveryCookie, versionPath)).json()).toEqual(batch.version);
      const frozenCase = (
        await get(fixture, recoveryCookie, `${versionPath}/cases/case-seven`)
      ).json<EvaluationSuiteCaseDetailV1>();
      expect(frozenCase).toMatchObject({
        source: batch.captured,
        expectation: {
          criteria: [{ expectedOutcome: "failed" }],
          findings: { annotation: "complete", expected: [] },
        },
      });
      for (const replay of batch.replays) {
        expect(
          canonicalJson(
            (
              await mutate(fixture, recoveryCookie, replay.method, replay.path, replay.payload)
            ).json(),
          ),
        ).toBe(replay.response);
        const payload = JSON.stringify({
          ...JSON.parse(replay.payload),
          changeId: `recovery-new-${JSON.parse(replay.payload).changeId}`,
        });
        expect(
          (await mutate(fixture, recoveryCookie, replay.method, replay.path, payload, 503)).json(),
        ).toMatchObject({ code: "configuration_read_only" });
      }

      // Access administration remains a separate trusted RPC; evaluation business state is read-only.
      await setRole(fixture, first.repositoryId, "viewer", 1);
      const forbidden = await mutate(
        fixture,
        recoveryCookie,
        "POST",
        batch.replays[0].path,
        batch.replays[0].payload,
        403,
      );
      expect(forbidden.json()).toMatchObject({ code: "platform_forbidden" });
      expect((await get(fixture, recoveryCookie, versionPath)).json()).toEqual(batch.version);
      await setRole(fixture, first.repositoryId, null, 2);
      await mutate(
        fixture,
        recoveryCookie,
        "POST",
        batch.replays[0].path,
        batch.replays[0].payload,
        404,
      );
      await get(fixture, recoveryCookie, versionPath, 404);
      await closeRuntime(fixture);
      expect(persisted(fixture)).toEqual(beforeRecovery);
    }, 60_000);
  },
);
