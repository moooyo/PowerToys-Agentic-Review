import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
  OperatorPrincipal,
  OperatorRepositoryPermission,
  OperatorRepositoryRole,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migrations.js";
import { handleOperatorAccessRequest, repositoryReadSql } from "./operator-access.js";
import {
  authorizeOperatorRequest,
  type OperatorRequestInput,
  type OperatorRequestOperation,
} from "./operator-request.js";

const at = "2026-09-07T00:00:00.000Z";
const administrator: OperatorPrincipal = {
  issuer: "https://identity.example.test",
  subject: "platform-admin",
};
const member: OperatorPrincipal = { issuer: administrator.issuer, subject: "member" };
const stranger: OperatorPrincipal = { issuer: administrator.issuer, subject: "stranger" };
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function insert(database: DatabaseSync, table: string, row: Record<string, SQLInputValue>) {
  database
    .prepare(
      `INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
        .map(() => "?")
        .join(",")})`,
    )
    .run(...Object.values(row));
}
function fixture() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  runMigrations(database, fileURLToPath(new URL("../../../../migrations", import.meta.url)));
  for (const [index, id] of ["repo-a", "repo-b"].entries()) {
    const common = {
      id,
      github_repository_id: index + 1,
      full_name: `example/project-${index + 1}`,
      created_at: at,
      updated_at: at,
    };
    insert(database, "managed_repositories", {
      ...common,
      enabled: 1,
      version: 1,
      connection_status: "unknown",
      configuration_source: "operator",
    });
    insert(database, "repositories", {
      ...common,
      github_node_id: `REPO_${index + 1}`,
      owner_login: "example",
      name: `project-${index + 1}`,
      html_url: `https://github.com/${common.full_name}`,
      default_branch: "main",
      is_private: 0,
      snapshot_json: "{}",
      observed_at: at,
    });
    insert(database, "work_items", {
      id: `item-${index + 1}`,
      repository_id: id,
      resource_kind: "issue",
      github_work_item_id: index + 1,
      github_node_id: `ITEM_${index + 1}`,
      github_number: index + 1,
      state: "open",
      title: "Permission fixture",
      html_url: `https://github.com/${common.full_name}/issues/1`,
      author_github_user_id: 1,
      author_login: "author",
      author_account_type: "user",
      current_revision_key: "a".repeat(64),
      source_created_at: at,
      source_updated_at: at,
      snapshot_json: "{}",
      projection_source: "webhook",
      observed_at: at,
      created_at: at,
      updated_at: at,
    });
    insert(database, "jobs", {
      id: `job-${index + 1}`,
      work_item_id: `item-${index + 1}`,
      job_kind: "issue_triage",
      semantic_key: `job-${index + 1}`,
      concurrency_key: `job-${index + 1}`,
      status: "queued",
      execution_json: "{}",
      resource_revision: "a".repeat(64),
      next_attempt_at: at,
      created_at: at,
      updated_at: at,
    });
  }
  insert(database, "jobs", {
    id: "legacy-job",
    work_item_id: null,
    job_kind: "issue_triage",
    semantic_key: "legacy-job",
    concurrency_key: "legacy-job",
    status: "queued",
    execution_json: "{}",
    resource_revision: "legacy",
    next_attempt_at: at,
    created_at: at,
    updated_at: at,
  });
  return database;
}
function grant(
  database: DatabaseSync,
  role: OperatorRepositoryRole | null,
  repositoryId = "repo-a",
  principal = member,
) {
  const current = database
    .prepare(
      "SELECT version FROM repository_operator_grants WHERE repository_id = ? AND principal_issuer = ? AND principal_subject = ?",
    )
    .get(repositoryId, principal.issuer, principal.subject) as { version: number } | undefined;
  const expectedVersion = current?.version ?? 0;
  return handleOperatorAccessRequest(
    database,
    {
      operation: "changeRepositoryAccess",
      input: {
        repositoryId,
        actor: administrator,
        request: {
          changeId: `grant-${repositoryId}-${principal.subject}-${expectedVersion + 1}`,
          principal,
          role,
          expectedVersion,
          reason: "Exercise the operator boundary.",
        },
      },
    },
    at,
    [administrator],
  );
}
function authorize(
  database: DatabaseSync,
  operation: string,
  input: unknown = { repositoryId: "repo-a" },
  actor = member,
) {
  return authorizeOperatorRequest(
    database,
    { context: { kind: "operator", actor }, operation, input },
    [administrator],
  );
}
function failure(
  action: () => unknown,
  code: "PLATFORM_FORBIDDEN" | "PLATFORM_NOT_FOUND" | "PLATFORM_INVALID",
) {
  expect(action).toThrow(expect.objectContaining({ code }));
}
const repositoryOperations: Record<string, OperatorRepositoryPermission> = {
  getEvaluationSourceReproduction: "read",
  getEvaluationReproductionPlan: "read",
  getEvaluationReproductionCell: "read",
  previewEvaluationReproduction: "configure",
  createEvaluationBatch: "configure",
  cancelEvaluationBatch: "configure",
  listEvaluationBatches: "read",
  getEvaluationBatch: "read",
  getEvaluationBatchMatrix: "read",
  getEvaluationCellResult: "read",
  getEvaluationAdjudicationContext: "read",
  listEvaluationAdjudicationHistory: "read",
  changeEvaluationAdjudication: "review",
  getEvaluationScorePreview: "read",
  publishEvaluationAssessment: "review",
  listEvaluationAssessments: "read",
  getEvaluationAssessment: "read",
  getEvaluationAssessmentCase: "read",
  listEvaluationPromptOptions: "configure",
  getManagedRepository: "read",
  listRepositoryConfigurationAudit: "read",
  getRepositoryConfigurationAudit: "read",
  getRepositoryJobScheduling: "read",
  getValidationRequestScheduling: "read",
  listPromptBindings: "read",
  listPromptBindingHistory: "read",
  listValidationProfiles: "read",
  listValidationProfileVersions: "read",
  getValidationProfileVersion: "read",
  listValidationProfileBindings: "read",
  listValidationProfileBindingHistory: "read",
  listDashboardReviewRuns: "read",
  getDashboardReviewRun: "read",
  listDashboardReviewRunJobs: "read",
  getDashboardReviewRunJobResult: "read",
  getDashboardReviewRunReproductionCase: "read",
  getReviewRunDecisionContext: "read",
  listReviewRunDecisionHistory: "read",
  changeReviewRunDecision: "review",
  listFindingOccurrences: "read",
  getFindingDispositionHistory: "read",
  compareFindingResults: "read",
  changeFindingDisposition: "review",
  listEvidenceAssets: "read",
  getEvidenceAsset: "read",
  readEvidenceAssetChunk: "read",
  createOperatorReviewRun: "review",
  rerunValidationRequest: "review",
  cancelValidationJob: "review",
  updateManagedRepository: "configure",
  updateRepositoryConnection: "configure",
  publishValidationProfile: "configure",
  savePromptBinding: "configure",
  saveValidationProfileBinding: "configure",
  listRepositoryAccessGrants: "manage_access",
  listRepositoryAccessAudit: "manage_access",
  changeRepositoryAccess: "manage_access",
};
const platformOperations: OperatorRequestOperation[] = [
  "createManagedRepository",
  "listGlobalConfigurationAudit",
  "getGlobalConfigurationAudit",
  "getPlatformJobScheduling",
  "listPromptTemplates",
  "getPromptTemplate",
  "createPromptTemplate",
  "savePromptDraft",
  "publishPromptDraft",
  "listPromptVersions",
  "getPromptVersion",
  "listWorkers",
  "getSystemSnapshot",
  "listWorkerNodeCredentials",
  "createWorkerNodeCredential",
  "rotateWorkerToken",
  "revokeWorkerToken",
];

describe("authenticated operator request boundary", () => {
  it.each([
    "createEvaluationBatch",
    "cancelEvaluationBatch",
    "listEvaluationBatches",
    "getEvaluationBatch",
    "getEvaluationBatchMatrix",
    "getEvaluationCellResult",
    "getEvaluationSourceReproduction",
    "getEvaluationReproductionPlan",
    "getEvaluationReproductionCell",
    "previewEvaluationReproduction",
    "getEvaluationAdjudicationContext",
    "listEvaluationAdjudicationHistory",
    "changeEvaluationAdjudication",
    "getEvaluationScorePreview",
    "publishEvaluationAssessment",
    "listEvaluationAssessments",
    "getEvaluationAssessment",
    "getEvaluationAssessmentCase",
    "listEvaluationPromptOptions",
  ] as const)(
    "stamps the trusted actor for %s and rejects a conflicting input actor",
    (operation) => {
      const database = fixture();
      grant(database, "maintainer");
      const accepted = authorize(database, operation, {
        repositoryId: "repo-a",
        request: { changeId: "evaluation-change" },
      });
      expect(accepted.request.input.actor).toEqual(member);
      expect(Object.isFrozen(accepted.request.input.actor)).toBe(true);
      failure(
        () => authorize(database, operation, { repositoryId: "repo-a", actor: administrator }),
        "PLATFORM_FORBIDDEN",
      );
      grant(database, null);
      failure(() => accepted.revalidate(), "PLATFORM_NOT_FOUND");
    },
  );
  it("authorizes an exact evaluation result scope for a viewer and revalidates current access", () => {
    const database = fixture();
    const payload = {
      repositoryId: "repo-a",
      evaluationId: "evaluation-a",
      cellId: "cell-a",
      resultId: "result-a",
      actor: { ...member },
    };
    failure(() => authorize(database, "getEvaluationCellResult", payload), "PLATFORM_NOT_FOUND");
    grant(database, "viewer");
    const accepted = authorize(database, "getEvaluationCellResult", payload);
    expect(accepted.request).toEqual({
      operation: "getEvaluationCellResult",
      input: payload,
    });
    expect(accepted.readContext.actor).toEqual(member);
    payload.resultId = "other-result";
    payload.cellId = "other-cell";
    payload.actor.subject = "forged";
    expect(accepted.request.input).toEqual({
      repositoryId: "repo-a",
      evaluationId: "evaluation-a",
      cellId: "cell-a",
      resultId: "result-a",
      actor: member,
    });
    for (const forged of [administrator, { ...member, issuer: "https://other-issuer.example" }])
      failure(
        () => authorize(database, "getEvaluationCellResult", { ...payload, actor: forged }),
        "PLATFORM_FORBIDDEN",
      );
    accepted.revalidate();
    grant(database, null);
    failure(() => accepted.revalidate(), "PLATFORM_NOT_FOUND");
  });

  it.each(["viewer", "reviewer", "maintainer", "admin"] as const)(
    "applies the complete repository permission matrix to %s",
    (role) => {
      const database = fixture();
      grant(database, role);
      const allowed = {
        viewer: ["read"],
        reviewer: ["read", "review"],
        maintainer: ["read", "review", "configure"],
        admin: ["read", "review", "configure", "manage_access"],
      }[role];
      // Handler-specific schemas are tested by those handlers; this matrix checks only the boundary.
      for (const [operation, permission] of Object.entries(repositoryOperations)) {
        if (allowed.includes(permission))
          expect(authorize(database, operation).request.operation).toBe(operation);
        else failure(() => authorize(database, operation), "PLATFORM_FORBIDDEN");
        failure(
          () => authorize(database, operation, { repositoryId: "repo-b" }),
          "PLATFORM_NOT_FOUND",
        );
      }
    },
  );

  it("requires platform authority for the global catalog, fleet, credentials and repository creation", () => {
    const database = fixture();
    grant(database, "admin");
    for (const operation of platformOperations) {
      failure(() => authorize(database, operation, {}), "PLATFORM_FORBIDDEN");
      expect(authorize(database, operation, {}, administrator).request.operation).toBe(operation);
    }
    for (const operation of [
      "listPromptBindings",
      "savePromptBinding",
      "listPromptBindingHistory",
    ]) {
      failure(() => authorize(database, operation, { repositoryId: null }), "PLATFORM_FORBIDDEN");
      expect(
        authorize(database, operation, { repositoryId: null }, administrator).request.operation,
      ).toBe(operation);
      failure(() => authorize(database, operation, {}, administrator), "PLATFORM_INVALID");
    }
  });

  it("returns the same not-found boundary for unknown or unreadable repositories", () => {
    const database = fixture();
    for (const repositoryId of ["repo-a", "missing"])
      failure(
        () => authorize(database, "getManagedRepository", { repositoryId }, stranger),
        "PLATFORM_NOT_FOUND",
      );
    failure(
      () => authorize(database, "getManagedRepository", { repositoryId: "missing" }, administrator),
      "PLATFORM_NOT_FOUND",
    );
    grant(database, "viewer");
    failure(() => authorize(database, "updateManagedRepository"), "PLATFORM_FORBIDDEN");
  });

  it("injects only the authenticated actor and rejects a conflicting body actor", () => {
    const database = fixture();
    grant(database, "reviewer");
    const accepted = authorize(database, "createOperatorReviewRun", {
      repositoryId: "repo-a",
      request: { activationId: "one" },
    });
    expect(accepted.request.input.actor).toEqual(member);
    for (const operation of [
      "getReviewRunDecisionContext",
      "listReviewRunDecisionHistory",
      "changeReviewRunDecision",
      "listFindingOccurrences",
      "getFindingDispositionHistory",
      "compareFindingResults",
      "changeFindingDisposition",
    ]) {
      expect(authorize(database, operation).request.input.actor).toEqual(member);
      failure(
        () => authorize(database, operation, { repositoryId: "repo-a", actor: administrator }),
        "PLATFORM_FORBIDDEN",
      );
    }
    expect(
      authorize(database, "rerunValidationRequest", {
        repositoryId: "repo-a",
        actor: { ...member },
      }).request.input.actor,
    ).toEqual(member);
    failure(
      () =>
        authorize(database, "cancelValidationJob", {
          repositoryId: "repo-a",
          actor: administrator,
        }),
      "PLATFORM_FORBIDDEN",
    );
    failure(
      () =>
        authorize(database, "getManagedRepository", {
          repositoryId: "repo-a",
          actor: administrator,
        }),
      "PLATFORM_FORBIDDEN",
    );
    failure(
      () =>
        authorize(database, "createOperatorReviewRun", {
          repositoryId: "repo-a",
          actor: { ...member, role: "admin" },
        }),
      "PLATFORM_INVALID",
    );
  });

  it.each([
    ["createWorkerNodeCredential", "createdByIssuer", "createdBySubject"],
    ["rotateWorkerToken", "rotatedByIssuer", "rotatedBySubject"],
    ["revokeWorkerToken", "revokedByIssuer", "revokedBySubject"],
  ])(
    "binds %s audit fields to the authenticated principal",
    (operation, issuerField, subjectField) => {
      const database = fixture();
      const accepted = authorize(database, operation as string, {}, administrator);
      expect(accepted.request.input[issuerField as string]).toBe(administrator.issuer);
      expect(accepted.request.input[subjectField as string]).toBe(administrator.subject);
      failure(
        () =>
          authorize(
            database,
            operation as string,
            { [subjectField as string]: member.subject },
            administrator,
          ),
        "PLATFORM_FORBIDDEN",
      );
    },
  );

  it("derives work-item and job visibility from actual stored relations", () => {
    const database = fixture();
    grant(database, "viewer");
    expect(
      authorize(database, "getPromptWorkItemContext", { workItemId: "item-1" }).request.operation,
    ).toBe("getPromptWorkItemContext");
    expect(authorize(database, "getJob", { jobId: "job-1" }).request.operation).toBe("getJob");
    for (const [operation, input] of [
      ["getPromptWorkItemContext", { workItemId: "item-2", repositoryId: "repo-a" }],
      ["getJob", { jobId: "job-2", repositoryId: "repo-a" }],
    ] as const)
      failure(() => authorize(database, operation, input), "PLATFORM_NOT_FOUND");
    failure(
      () => authorize(database, "getJob", { jobId: "missing" }, administrator),
      "PLATFORM_NOT_FOUND",
    );
    failure(
      () => authorize(database, "getJob", { jobId: "legacy-job", repositoryId: "repo-a" }),
      "PLATFORM_FORBIDDEN",
    );
    expect(
      authorize(database, "getJob", { jobId: "legacy-job" }, administrator).request.input,
    ).toEqual({ jobId: "legacy-job" });
  });

  it("rechecks grants and exact resource relations after an asynchronous boundary", async () => {
    const database = fixture();
    grant(database, "reviewer");
    const review = authorize(database, "createOperatorReviewRun");
    grant(database, "viewer");
    await Promise.resolve();
    failure(() => review.revalidate(), "PLATFORM_FORBIDDEN");
    const read = authorize(database, "getManagedRepository");
    grant(database, null);
    await Promise.resolve();
    failure(() => read.revalidate(), "PLATFORM_NOT_FOUND");
    grant(database, "viewer");
    grant(database, "viewer", "repo-b");
    const workItem = authorize(database, "getPromptWorkItemContext", { workItemId: "item-1" });
    const job = authorize(database, "getJob", { jobId: "job-1" });
    database.prepare("UPDATE work_items SET repository_id = 'repo-b' WHERE id = 'item-1'").run();
    await Promise.resolve();
    failure(() => workItem.revalidate(), "PLATFORM_NOT_FOUND");
    failure(() => job.revalidate(), "PLATFORM_NOT_FOUND");
  });

  it("permits unscoped lists only with a frozen actor context for SQL visibility filtering", () => {
    const database = fixture();
    grant(database, "viewer");
    for (const operation of ["listManagedRepositories", "listWorkItems", "listJobs"]) {
      const authorized = authorize(database, operation, {});
      const filter = repositoryReadSql(
        "managed_repositories.id",
        authorized.readContext.actor,
        authorized.readContext.administrators,
      );
      expect(
        database
          .prepare(`SELECT id FROM managed_repositories WHERE ${filter.sql}`)
          .all(...filter.parameters),
      ).toEqual([{ id: "repo-a" }]);
      failure(
        () => authorize(database, operation, { repositoryId: "repo-b" }),
        "PLATFORM_NOT_FOUND",
      );
    }
    const empty = authorize(database, "listJobs", {}, stranger);
    const filter = repositoryReadSql(
      "managed_repositories.id",
      empty.readContext.actor,
      empty.readContext.administrators,
    );
    expect(
      database
        .prepare(`SELECT id FROM managed_repositories WHERE ${filter.sql}`)
        .all(...filter.parameters),
    ).toEqual([]);
  });

  it("checks permission RPC scopes explicitly and allows an unscoped identity context", () => {
    const database = fixture();
    grant(database, "reviewer");
    expect(
      authorize(database, "operatorCheckPermission", { repositoryId: "repo-a" }).request.operation,
    ).toBe("operatorCheckPermission");
    expect(
      authorize(database, "operatorCheckPermission", {
        repositoryId: "repo-a",
        permission: "review",
      }).request.operation,
    ).toBe("operatorCheckPermission");
    failure(
      () =>
        authorize(database, "operatorCheckPermission", {
          repositoryId: "repo-a",
          permission: "configure",
        }),
      "PLATFORM_FORBIDDEN",
    );
    failure(() => authorize(database, "operatorCheckPermission", {}), "PLATFORM_FORBIDDEN");
    expect(
      authorize(database, "operatorCheckPermission", {}, administrator).request.operation,
    ).toBe("operatorCheckPermission");
    failure(
      () => authorize(database, "operatorCheckPermission", { permission: "owner" }, administrator),
      "PLATFORM_INVALID",
    );
    expect(
      authorize(database, "getOperatorAccessContext", {}, stranger).request.input.actor,
    ).toEqual(stranger);
  });

  it("captures payload and identity while noticing a trusted administrator revocation", () => {
    const database = fixture();
    grant(database, "viewer");
    const actor = { ...member };
    const payload = { repositoryId: "repo-a", nested: { value: "original" } };
    const authorized = authorizeOperatorRequest(
      database,
      { context: { kind: "operator", actor }, operation: "getManagedRepository", input: payload },
      [administrator],
    );
    actor.subject = "forged";
    payload.repositoryId = "repo-b";
    payload.nested.value = "changed";
    expect(authorized.readContext.actor).toEqual(member);
    expect(authorized.request.input).toEqual({
      repositoryId: "repo-a",
      nested: { value: "original" },
    });
    expect(Object.isFrozen(authorized.readContext.actor)).toBe(true);
    expect(Object.isFrozen(authorized.readContext.administrators)).toBe(true);
    expect(Object.isFrozen(authorized.request.input.nested)).toBe(true);
    authorized.revalidate();
    const administrators = [{ ...administrator }];
    const platform = authorizeOperatorRequest(
      database,
      { context: { kind: "operator", actor: administrator }, operation: "listJobs", input: {} },
      administrators,
    );
    administrators.splice(0);
    failure(() => platform.revalidate(), "PLATFORM_FORBIDDEN");
  });

  it.each([
    "operatorRequest",
    "bootstrapManagedRepositories",
    "bootstrapPromptTemplates",
    "createReviewRun",
    "getReviewRun",
    "associateReviewRunJob",
    "dispatchReviewRun",
    "dispatchPendingReviewRuns",
    "dispatchEvaluationRequest",
    "dispatchEvaluationRequestInTransaction",
    "cancelEvaluationJob",
    "cancelEvaluationJobInTransaction",
    "admitPendingJobs",
    "resolveWorkflowPrompt",
    "getManagedRepositoryByGitHubId",
    "ingestSchedulingEvent",
    "commitGitHubPollingReconciliation",
    "claimLease",
    "completeLease",
    "beginEvidenceUpload",
    "appendEvidenceChunk",
    "finalizeEvidenceUpload",
    "cleanupEvidenceAssets",
    "registerWorker",
    "authenticateWorkerToken",
    "createOperatorSession",
    "findOperatorSession",
    "beginOperatorLogin",
    "rawSQL",
    "shutdown",
    "ping",
    "constructor",
  ])("rejects internal operation %s even for a platform administrator", (operation) => {
    const database = fixture();
    failure(() => authorize(database, operation, {}, administrator), "PLATFORM_FORBIDDEN");
  });

  it.each([
    null,
    {},
    { context: { kind: "worker", actor: member }, operation: "listJobs", input: {} },
    {
      context: { kind: "operator", actor: { ...member, administrator: true } },
      operation: "listJobs",
      input: {},
    },
    { context: { kind: "operator", actor: member }, operation: "listJobs", input: {}, extra: true },
    { context: { kind: "operator", actor: member }, operation: "listJobs", input: [] },
    {
      context: { kind: "operator", actor: { issuer: member.issuer, subject: " member " } },
      operation: "listJobs",
      input: {},
    },
  ])("rejects malformed authenticated request %j", (input) => {
    const database = fixture();
    failure(
      () => authorizeOperatorRequest(database, input as OperatorRequestInput, [administrator]),
      "PLATFORM_INVALID",
    );
  });
});
