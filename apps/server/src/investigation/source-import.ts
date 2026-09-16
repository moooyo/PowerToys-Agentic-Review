import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createCanonicalResult } from "@agentic-review/codex";
import {
  EntityIdSchema,
  GitObjectIdSchema,
  type InvestigationExecutablePlanStep,
  InvestigationExecutablePlanStepSchema,
  type InvestigationInputSnapshotV1,
  InvestigationInputSnapshotV1Schema,
  type InvestigationPlanExecutionBinding,
  InvestigationPlanExecutionBindingSchema,
  type InvestigationPlanV1,
  type InvestigationSubjectV1,
  type InvestigationTaskV1,
  InvestigationVersionRefSchema,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { FastifyInstance } from "fastify";
import { InvestigationRequestError, requireCondition } from "./errors.js";
import type { InvestigationStore } from "./store.js";
import type {
  InvestigationOperatorAuthenticator,
  InvestigationOperatorPrincipal,
  InvestigationPrerequisiteResolver,
  InvestigationRepositoryRecord,
  InvestigationWorkItemRecord,
} from "./types.js";

const planKinds = Type.Union([
  Type.Literal("verification"),
  Type.Literal("reproduction"),
  Type.Literal("fix"),
  Type.Literal("implementation"),
]);
const trustedBindingSchema = Type.Object(
  {
    repositoryId: EntityIdSchema,
    planRef: Type.Optional(InvestigationVersionRefSchema),
    profileRef: Type.Optional(InvestigationVersionRefSchema),
    planKind: planKinds,
    satisfiedPrerequisiteRefs: Type.Array(EntityIdSchema, { uniqueItems: true }),
    steps: Type.Array(Type.Omit(InvestigationExecutablePlanStepSchema, ["digest"]), {
      minItems: 1,
      maxItems: 128,
    }),
  },
  { additionalProperties: false },
);
export const InvestigationTrustedExecutionBindingsSchema = Type.Array(trustedBindingSchema, {
  maxItems: 1024,
});
export type InvestigationTrustedExecutionBinding = Static<typeof trustedBindingSchema>;

export function loadInvestigationExecutionBindings(
  path: string | undefined,
): readonly InvestigationTrustedExecutionBinding[] {
  if (path === undefined) return [];
  const bytes = readFileSync(path);
  if (bytes.byteLength > 2 * 1024 * 1024)
    throw new Error("The trusted execution registry exceeds its configuration size limit.");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("The trusted execution registry must contain JSON.");
  }
  if (!Value.Check(InvestigationTrustedExecutionBindingsSchema, value))
    throw new Error("The trusted execution registry does not match its schema.");
  for (const binding of value) {
    if (binding.planRef === undefined && binding.profileRef === undefined)
      throw new Error(
        "Every execution registry entry requires an exact saved plan or profile reference.",
      );
    if (new Set(binding.steps.map((step) => step.stepId)).size !== binding.steps.length)
      throw new Error("An execution registry entry contains duplicate step IDs.");
    for (const step of binding.steps) {
      if (step.operation.kind === "model-edit") {
        for (const path of step.operation.allowedPaths) {
          if (
            path.startsWith("/") ||
            path.includes("\0") ||
            /[\\:*?\[\]]/u.test(path) ||
            path
              .split("/")
              .some(
                (part) =>
                  part === ".." || part === "." || part === "" || part.toLowerCase() === ".git",
              )
          ) {
            throw new Error(
              "Trusted model edits require explicit repository-relative file paths without traversal or globs.",
            );
          }
        }
      }
      if (step.operation.kind !== "command") continue;
      const directory = step.operation.workingDirectory;
      if (
        directory !== "." &&
        (directory.startsWith("/") ||
          directory.includes("\\") ||
          directory.includes(":") ||
          directory.split("/").some((part) => part === ".." || part === "." || part === ""))
      ) {
        throw new Error(
          "Trusted command working directories must remain relative to the owned source workspace.",
        );
      }
      if (step.operation.arguments.some((argument) => argument.includes("\0")))
        throw new Error("Trusted command arguments must not contain NUL characters.");
    }
  }
  return value;
}

interface SourceBudget {
  bytes: number;
  pages: number;
}
interface SnapshotRecord {
  id: string;
  digest: string;
  inputSnapshot: InvestigationInputSnapshotV1;
}
interface SnapshotPointer {
  snapshotId: string;
}
type JsonObject = Record<string, unknown>;

export interface InvestigationSourceImportOptions {
  readonly store: InvestigationStore;
  readonly github?: { token: string; expectedGitHubUserId: number };
  readonly fetch?: typeof globalThis.fetch;
  readonly maximumBytes?: number;
  readonly maximumPages?: number;
  readonly requestTimeoutMs?: number;
  readonly executionBindings?: readonly InvestigationTrustedExecutionBinding[];
}

export interface InvestigationSourceImportExpectation {
  readonly githubWorkItemId: number;
  readonly assigneeUserId: number;
  readonly baseSha?: string;
  readonly headSha?: string;
}

const sourceImportExpectationSchema = Type.Object(
  {
    githubWorkItemId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    assigneeUserId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    baseSha: Type.Optional(GitObjectIdSchema),
    headSha: Type.Optional(GitObjectIdSchema),
  },
  { additionalProperties: false },
);

function object(value: unknown): JsonObject {
  requireCondition(
    typeof value === "object" && value !== null && !Array.isArray(value),
    502,
    "invalid_source_response",
    "GitHub returned an invalid source response.",
  );
  return value as JsonObject;
}
function text(value: unknown, name: string, allowEmpty = false): string {
  requireCondition(
    typeof value === "string" && (allowEmpty || value.length > 0),
    502,
    "invalid_source_response",
    `GitHub omitted ${name}.`,
  );
  return value;
}
function count(value: unknown, name: string): number {
  requireCondition(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    502,
    "invalid_source_response",
    `GitHub omitted a valid ${name}.`,
  );
  return value;
}
function digest(value: unknown): string {
  return investigationContentDigest(value);
}
function sourcePath(repository: InvestigationRepositoryRecord): string {
  const parts = repository.fullName.split("/");
  requireCondition(
    parts.length === 2 &&
      parts.every((part) => /^[A-Za-z0-9_.-]+$/u.test(part) && part !== "." && part !== ".."),
    400,
    "invalid_repository_name",
    "The configured repository name is invalid.",
  );
  return `/repos/${parts.map(encodeURIComponent).join("/")}`;
}
function pointerKey(repositoryId: string, workItemId: string, revisionKey: string): string {
  return `current:${digest({ repositoryId, workItemId, revisionKey })}`;
}
function referenceMatches(
  left: { id: string; version: number; digest: string },
  right: { id: string; version: number; digest: string },
): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest;
}

function matchingExecutionBindings(
  repositoryId: string,
  profileRef: InvestigationTaskV1["profileRef"],
  plan: InvestigationPlanV1,
  registry: readonly InvestigationTrustedExecutionBinding[],
): readonly InvestigationTrustedExecutionBinding[] {
  const planRef = { id: plan.id, version: plan.version, digest: plan.digest };
  return registry.filter(
    (entry) =>
      entry.repositoryId === repositoryId &&
      entry.planKind === plan.kind &&
      (entry.planRef === undefined || referenceMatches(entry.planRef, planRef)) &&
      (entry.profileRef === undefined || referenceMatches(entry.profileRef, profileRef)) &&
      (entry.planRef !== undefined || entry.profileRef !== undefined),
  );
}

export function bindInvestigationPlanExecution(
  task: InvestigationTaskV1,
  plan: InvestigationPlanV1 | null,
  actor: InvestigationOperatorPrincipal,
  registry: readonly InvestigationTrustedExecutionBinding[],
): InvestigationPlanExecutionBinding | null {
  if (plan === null) return null;
  const policy = task.executionPolicy;
  requireCondition(
    policy.mode === "execute" &&
      policy.allowRepositoryExecution &&
      actor.allowRepositoryExecution &&
      policy.authorizationRef === actor.id,
    403,
    "execution_not_authorized",
    "The selected plan requires explicit source-execution authority.",
  );
  const planRef = { id: plan.id, version: plan.version, digest: plan.digest };
  const matches = matchingExecutionBindings(task.repository.id, task.profileRef, plan, registry);
  requireCondition(
    matches.length === 1,
    409,
    matches.length === 0 ? "execution_binding_missing" : "execution_binding_ambiguous",
    matches.length === 0
      ? "Configure a trusted execution binding for the exact saved plan or profile before starting this task."
      : "Multiple trusted execution bindings match this plan; resolve the configuration before execution.",
  );
  const selected = matches[0]!;
  requireCondition(
    selected.steps.length === plan.steps.length &&
      selected.steps.every((step, index) => step.stepId === plan.steps[index]?.id),
    409,
    "execution_steps_mismatch",
    "The trusted operations must cover every saved plan step in the same order.",
  );
  const checkIds = plan.steps.flatMap((step) => step.checkIds);
  const mutationTask = task.kind === "issue-fix" || task.kind === "feature-implement";
  requireCondition(
    new Set(checkIds).size === checkIds.length && (mutationTask || checkIds.length > 0),
    409,
    "execution_checks_missing",
    "Validation plans require at least one check, and all check IDs must be distinct.",
  );
  requireCondition(
    mutationTask === selected.steps.some((step) => step.operation.kind === "model-edit"),
    409,
    "execution_edit_binding_mismatch",
    "Implementation tasks require an explicit model-edit operation; validation tasks must not contain model edits.",
  );
  const missing = plan.prerequisites.filter(
    (prerequisite) => !selected.satisfiedPrerequisiteRefs.includes(prerequisite.id),
  );
  requireCondition(
    missing.length === 0,
    409,
    "execution_prerequisites_missing",
    `The plan prerequisites are not satisfied: ${missing.map((entry) => entry.id).join(", ")}.`,
  );
  requireCondition(
    selected.satisfiedPrerequisiteRefs.every((id) =>
      plan.prerequisites.some((prerequisite) => prerequisite.id === id),
    ),
    409,
    "execution_prerequisites_mismatch",
    "The configured prerequisite acknowledgements do not belong to this saved plan.",
  );
  const subject = task.subjects.find((entry) => entry.id === task.subjectRef);
  requireCondition(
    subject !== undefined &&
      subject.kind !== "issue_snapshot" &&
      policy.allowedSubjectRefs.includes(subject.id),
    409,
    "execution_source_missing",
    "The plan needs an explicitly selected immutable source revision.",
  );
  const steps: InvestigationExecutablePlanStep[] = selected.steps.map((step) => ({
    ...structuredClone(step),
    digest: createCanonicalResult(step).sha256,
  }));
  const binding: InvestigationPlanExecutionBinding = {
    planRef,
    subjectRef: subject.id,
    subjectRevisionKey: subject.revisionKey,
    executionPolicyDigest: createCanonicalResult(policy).sha256,
    authorizationRef: actor.id,
    satisfiedPrerequisiteRefs: [...selected.satisfiedPrerequisiteRefs],
    steps,
  };
  requireCondition(
    Value.Check(InvestigationPlanExecutionBindingSchema, binding),
    500,
    "invalid_execution_binding",
    "The trusted execution binding is invalid.",
  );
  return binding;
}

/** Imports complete read-only upstream observations and prepares immutable task inputs. */
export class InvestigationSourceImporter {
  readonly #fetch: typeof globalThis.fetch;
  readonly #maximumBytes: number;
  readonly #maximumPages: number;
  readonly #timeout: number;
  readonly #registry: readonly InvestigationTrustedExecutionBinding[];

  constructor(private readonly options: InvestigationSourceImportOptions) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maximumBytes = options.maximumBytes ?? 16 * 1024 * 1024;
    this.#maximumPages = options.maximumPages ?? 1000;
    this.#timeout = options.requestTimeoutMs ?? 30_000;
    this.#registry = structuredClone(options.executionBindings ?? []);
  }

  readonly resolvePlanPrerequisites: InvestigationPrerequisiteResolver = (
    repository,
    workItem,
    report,
    plan,
    actor,
  ) => {
    this.#scope(actor, repository.id);
    if (
      workItem.repositoryId !== repository.id ||
      report.context.repository.id !== repository.id ||
      report.context.repository.githubRepositoryId !== repository.githubRepositoryId ||
      report.context.workItem.id !== workItem.id ||
      !report.plans.some((saved) => digest(saved) === digest(plan))
    )
      return [];
    const matches = matchingExecutionBindings(
      repository.id,
      report.context.profileRef,
      plan,
      this.#registry,
    );
    if (matches.length !== 1) return [];
    const selected = matches[0]!;
    if (
      selected.steps.length !== plan.steps.length ||
      selected.steps.some((step, index) => step.stepId !== plan.steps[index]?.id) ||
      selected.satisfiedPrerequisiteRefs.some(
        (id) => !plan.prerequisites.some((entry) => entry.id === id),
      )
    )
      return [];
    return [...selected.satisfiedPrerequisiteRefs];
  };

  registerRoutes(app: FastifyInstance, authenticate: InvestigationOperatorAuthenticator): void {
    app.post<{ Params: { id: string }; Body: { kind: "pull_request" | "issue"; number: number } }>(
      "/api/repositories/:id/import-work-item",
      {
        schema: {
          params: Type.Object({ id: EntityIdSchema }, { additionalProperties: false }),
          body: Type.Object(
            {
              kind: Type.Union([Type.Literal("pull_request"), Type.Literal("issue")]),
              number: Type.Integer({ minimum: 1 }),
            },
            { additionalProperties: false },
          ),
        },
      },
      async (request, reply) => {
        const actor = await authenticate(request);
        requireCondition(
          actor !== null,
          401,
          "operator_authentication_required",
          "Operator authentication is required.",
        );
        reply.header("cache-control", "no-store");
        return reply
          .code(201)
          .send(await this.importWorkItem(actor, request.params.id, request.body));
      },
    );
  }

  async importWorkItem(
    actor: InvestigationOperatorPrincipal,
    repositoryId: string,
    request: { kind: "pull_request" | "issue"; number: number },
    expectation?: InvestigationSourceImportExpectation,
  ) {
    this.#scope(actor, repositoryId);
    requireCondition(
      actor.permissions.includes("repository:manage"),
      403,
      "permission_denied",
      "Importing an upstream work item requires repository:manage.",
    );
    requireCondition(
      Number.isSafeInteger(request.number) &&
        request.number > 0 &&
        (request.kind === "issue" || request.kind === "pull_request"),
      400,
      "invalid_import_target",
      "A valid upstream work item kind and number are required.",
    );
    request = { ...request };
    if (expectation !== undefined) {
      this.#validateExpectation(request.kind, expectation);
      expectation = structuredClone(expectation);
    }
    const repository = this.options.store.get<InvestigationRepositoryRecord>(
      "repositories",
      repositoryId,
    );
    requireCondition(
      repository !== undefined,
      404,
      "repository_not_found",
      "The repository is not registered.",
    );
    const budget = { bytes: 0, pages: 0 };
    await this.#verifyRepository(repository, budget);
    const base = sourcePath(repository);
    const endpoint = `${base}/${request.kind === "pull_request" ? "pulls" : "issues"}/${request.number}`;
    const upstream = object((await this.#get(endpoint, budget)).value);
    requireCondition(
      count(upstream.number, "work item number") === request.number,
      502,
      "source_target_mismatch",
      "GitHub returned another work item.",
    );
    requireCondition(
      request.kind !== "issue" || upstream.pull_request === undefined,
      400,
      "source_kind_mismatch",
      "This number identifies a pull request, not an Issue.",
    );
    if (expectation !== undefined) this.#verifyAssignmentTarget(upstream, request, expectation);
    const conversation = await this.#comments(
      `${base}/issues/${request.number}/comments`,
      "issue-comment",
      budget,
    );
    requireCondition(
      conversation.length === count(upstream.comments, "comment count"),
      409,
      "source_changed_during_import",
      "The upstream conversation changed during import; retry the complete import.",
    );
    const comments = [...conversation];
    if (request.kind === "pull_request") {
      const reviewComments = await this.#comments(
        `${base}/pulls/${request.number}/comments`,
        "review-comment",
        budget,
      );
      requireCondition(
        reviewComments.length === count(upstream.review_comments, "review comment count"),
        409,
        "source_changed_during_import",
        "The upstream review comments changed during import; retry the complete import.",
      );
      comments.push(
        ...reviewComments,
        ...(await this.#comments(`${base}/pulls/${request.number}/reviews`, "review", budget)),
      );
    }
    const after = object((await this.#get(endpoint, budget)).value);
    if (expectation !== undefined) this.#verifyAssignmentTarget(after, request, expectation);
    requireCondition(
      digest(this.#targetState(after, request.kind)) ===
        digest(this.#targetState(upstream, request.kind)),
      409,
      "source_changed_during_import",
      "The upstream work item changed during import; no partial snapshot was saved.",
    );
    const existing = this.options.store.list<InvestigationWorkItemRecord>(
      "workItems",
      (item) =>
        item.repositoryId === repositoryId &&
        item.kind === request.kind &&
        item.number === request.number,
    );
    requireCondition(
      existing.length <= 1,
      409,
      "work_item_identity_conflict",
      "Multiple local records identify this upstream work item.",
    );
    const id = existing[0]?.id ?? `work-item:${digest({ repositoryId, ...request }).slice(0, 48)}`;
    const title = text(upstream.title, "title");
    const body = upstream.body === null ? "" : text(upstream.body, "body", true);
    const updatedAt = text(upstream.updated_at, "updated_at");
    requireCondition(
      Number.isFinite(Date.parse(updatedAt)),
      502,
      "invalid_source_response",
      "GitHub returned an invalid update timestamp.",
    );
    let subject: InvestigationSubjectV1;
    if (request.kind === "pull_request") {
      const baseSha = text(object(upstream.base).sha, "base SHA");
      const headSha = text(object(upstream.head).sha, "head SHA");
      requireCondition(
        Value.Check(GitObjectIdSchema, baseSha) && Value.Check(GitObjectIdSchema, headSha),
        502,
        "invalid_source_response",
        "GitHub returned an invalid PR revision.",
      );
      requireCondition(
        count(object(object(upstream.base).repo).id, "base repository ID") ===
          repository.githubRepositoryId,
        502,
        "source_repository_mismatch",
        "The PR base repository differs from the registered target.",
      );
      const revisionKey = createHash("sha256").update(`${baseSha}\0${headSha}`).digest("hex");
      subject = {
        id: `subject:${digest({ repositoryId, id, revisionKey }).slice(0, 48)}`,
        repositoryId,
        workItemId: id,
        kind: "original_pr",
        revisionKey,
        baseSha,
        headSha,
      };
    } else {
      const snapshotDigest = digest({ title, body, comments });
      const revisionKey = createHash("sha256")
        .update(
          JSON.stringify([upstream.title, upstream.body, upstream.state, upstream.updated_at]),
        )
        .digest("hex");
      subject = {
        id: `subject:${digest({ repositoryId, id, snapshotDigest, revisionKey }).slice(0, 48)}`,
        repositoryId,
        workItemId: id,
        kind: "issue_snapshot",
        revisionKey,
        snapshotDigest,
      };
    }
    const inputSnapshot: InvestigationInputSnapshotV1 = {
      schemaVersion: "InvestigationInputSnapshotV1",
      repositoryId,
      workItemId: id,
      subjectRef: subject.id,
      subjectRevisionKey: subject.revisionKey,
      title,
      body,
      comments,
      source: null,
    };
    requireCondition(
      Value.Check(InvestigationInputSnapshotV1Schema, inputSnapshot),
      502,
      "invalid_source_snapshot",
      "The complete source snapshot does not match the input contract.",
    );
    const state = upstream.state;
    requireCondition(
      state === "open" || state === "closed",
      502,
      "invalid_source_response",
      "GitHub returned an invalid work item state.",
    );
    const workItem: InvestigationWorkItemRecord = {
      id,
      repositoryId,
      kind: request.kind,
      number: request.number,
      title,
      body,
      state:
        request.kind === "pull_request" &&
        upstream.merged_at !== null &&
        upstream.merged_at !== undefined
          ? "merged"
          : state,
      subject,
      updatedAt,
    };
    const snapshotDigest = digest(inputSnapshot);
    const snapshot: SnapshotRecord = {
      id: `snapshot:${snapshotDigest}`,
      digest: snapshotDigest,
      inputSnapshot,
    };
    this.options.store.transaction(() => {
      const currentRepository = this.options.store.get("repositories", repositoryId);
      requireCondition(
        currentRepository !== undefined && digest(currentRepository) === digest(repository),
        409,
        "repository_changed",
        "The repository configuration changed during import.",
      );
      if (this.options.store.get("sourceSnapshots", snapshot.id) === undefined)
        this.options.store.insert("sourceSnapshots", snapshot.id, snapshot);
      this.options.store.put("sourceSnapshots", pointerKey(repositoryId, id, subject.revisionKey), {
        snapshotId: snapshot.id,
      } satisfies SnapshotPointer);
      this.options.store.put("workItems", id, workItem);
    });
    return {
      workItem,
      snapshotRef: { id: snapshot.id, digest: snapshot.digest },
      commentsCount: comments.length,
    };
  }

  async verifyAssignment(
    actor: InvestigationOperatorPrincipal,
    repositoryId: string,
    request: { kind: "pull_request" | "issue"; number: number },
    expectation: InvestigationSourceImportExpectation,
  ): Promise<void> {
    this.#scope(actor, repositoryId);
    requireCondition(
      Number.isSafeInteger(request.number) &&
        request.number > 0 &&
        (request.kind === "issue" || request.kind === "pull_request"),
      400,
      "invalid_import_target",
      "A valid upstream work item kind and number are required.",
    );
    this.#validateExpectation(request.kind, expectation);
    request = { ...request };
    expectation = structuredClone(expectation);
    const repository = this.options.store.get<InvestigationRepositoryRecord>(
      "repositories",
      repositoryId,
    );
    requireCondition(
      repository !== undefined,
      404,
      "repository_not_found",
      "The repository is not registered.",
    );
    const budget = { bytes: 0, pages: 0 };
    await this.#verifyRepository(repository, budget);
    const endpoint = `${sourcePath(repository)}/${request.kind === "pull_request" ? "pulls" : "issues"}/${request.number}`;
    this.#verifyAssignmentTarget(
      object((await this.#get(endpoint, budget)).value),
      request,
      expectation,
    );
    const currentRepository = this.options.store.get("repositories", repositoryId);
    requireCondition(
      currentRepository !== undefined && digest(currentRepository) === digest(repository),
      409,
      "repository_changed",
      "The repository configuration changed during assignment verification.",
    );
  }

  readonly resolveTaskSource = async (
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationWorkItemRecord,
    sourceCommit: string,
    actor: InvestigationOperatorPrincipal,
  ): Promise<Extract<InvestigationSubjectV1, { kind: "source_commit" }>> => {
    this.#scope(actor, repository.id);
    requireCondition(
      repository.id === workItem.repositoryId && Value.Check(GitObjectIdSchema, sourceCommit),
      400,
      "invalid_source_commit",
      "An exact commit SHA from the selected repository is required.",
    );
    const budget = { bytes: 0, pages: 0 };
    await this.#verifyRepository(repository, budget);
    const observed = object(
      (
        await this.#get(
          `${sourcePath(repository)}/commits/${encodeURIComponent(sourceCommit)}`,
          budget,
        )
      ).value,
    );
    requireCondition(
      observed.sha === sourceCommit,
      409,
      "source_commit_mismatch",
      "GitHub did not resolve the exact requested commit SHA.",
    );
    const revisionKey = digest({
      kind: "source_commit",
      repositoryId: repository.id,
      commitSha: sourceCommit,
    });
    return {
      id: `source:${digest({ repositoryId: repository.id, workItemId: workItem.id, sourceCommit }).slice(0, 48)}`,
      repositoryId: repository.id,
      workItemId: workItem.id,
      kind: "source_commit",
      revisionKey,
      commitSha: sourceCommit,
    };
  };

  readonly prepareTaskInput = async (
    task: InvestigationTaskV1,
    workItem: InvestigationWorkItemRecord,
    plan: InvestigationPlanV1 | null,
    actor: InvestigationOperatorPrincipal,
  ) => {
    this.#scope(actor, task.repository.id);
    const pointer = this.options.store.get<SnapshotPointer>(
      "sourceSnapshots",
      pointerKey(task.repository.id, workItem.id, workItem.subject.revisionKey),
    );
    const snapshot =
      pointer === undefined
        ? undefined
        : this.options.store.get<SnapshotRecord>("sourceSnapshots", pointer.snapshotId);
    requireCondition(
      snapshot !== undefined &&
        snapshot.id === pointer?.snapshotId &&
        Value.Check(InvestigationInputSnapshotV1Schema, snapshot.inputSnapshot) &&
        digest(snapshot.inputSnapshot) === snapshot.digest &&
        snapshot.inputSnapshot.repositoryId === task.repository.id &&
        snapshot.inputSnapshot.workItemId === workItem.id &&
        snapshot.inputSnapshot.subjectRef === workItem.subject.id &&
        snapshot.inputSnapshot.subjectRevisionKey === workItem.subject.revisionKey &&
        snapshot.inputSnapshot.title === workItem.title &&
        snapshot.inputSnapshot.body === workItem.body,
      409,
      "source_snapshot_missing",
      "Import the complete current upstream work item before starting this investigation.",
    );
    const subject = task.subjects.find((entry) => entry.id === task.subjectRef);
    requireCondition(
      subject !== undefined,
      409,
      "source_subject_missing",
      "The task has no frozen source subject.",
    );
    const inputSnapshot = {
      ...structuredClone(snapshot.inputSnapshot),
      subjectRef: subject.id,
      subjectRevisionKey: subject.revisionKey,
    };
    requireCondition(
      Buffer.byteLength(JSON.stringify(inputSnapshot), "utf8") <= this.#maximumBytes,
      413,
      "source_budget_exceeded",
      "The complete snapshot exceeds the configured source budget; no content was truncated.",
    );
    return {
      inputSnapshot,
      plan,
      execution: bindInvestigationPlanExecution(task, plan, actor, this.#registry),
    };
  };

  #scope(actor: InvestigationOperatorPrincipal, repositoryId: string): void {
    requireCondition(
      actor.repositoryIds.includes(repositoryId),
      403,
      "repository_forbidden",
      "This identity has no access to the repository.",
    );
  }

  #validateExpectation(
    kind: "pull_request" | "issue",
    expectation: InvestigationSourceImportExpectation,
  ): void {
    requireCondition(
      Value.Check(sourceImportExpectationSchema, expectation) &&
        (kind === "pull_request"
          ? expectation.baseSha !== undefined && expectation.headSha !== undefined
          : expectation.baseSha === undefined && expectation.headSha === undefined),
      400,
      "invalid_source_expectation",
      "Assignment imports require positive numeric identities and the exact PR base/head revision.",
    );
  }

  #verifyAssignmentTarget(
    upstream: JsonObject,
    request: { kind: "pull_request" | "issue"; number: number },
    expectation: InvestigationSourceImportExpectation,
  ): void {
    requireCondition(
      upstream.id === expectation.githubWorkItemId &&
        upstream.number === request.number &&
        (request.kind !== "issue" || upstream.pull_request === undefined),
      409,
      "source_assignment_target_changed",
      "The current upstream identity differs from the assigned work item.",
    );
    requireCondition(
      upstream.state === "open" &&
        (request.kind !== "pull_request" ||
          (upstream.merged_at == null && upstream.merged !== true)),
      409,
      "source_assignment_stale",
      "The assigned work item is no longer open.",
    );
    requireCondition(
      Array.isArray(upstream.assignees) &&
        upstream.assignees.some(
          (entry: unknown) =>
            typeof entry === "object" &&
            entry !== null &&
            "id" in entry &&
            entry.id === expectation.assigneeUserId,
        ),
      409,
      "source_assignment_missing",
      "The configured reviewer is no longer assigned to this work item.",
    );
    if (request.kind === "pull_request")
      requireCondition(
        object(upstream.base).sha === expectation.baseSha &&
          object(upstream.head).sha === expectation.headSha,
        409,
        "source_assignment_revision_changed",
        "The PR base/head revision changed after the assignment event.",
      );
  }

  async #verifyRepository(
    repository: InvestigationRepositoryRecord,
    budget: SourceBudget,
  ): Promise<void> {
    const credentials = this.options.github;
    requireCondition(
      credentials !== undefined,
      503,
      "source_import_unavailable",
      "Configure a GitHub read credential and expected account before importing source.",
    );
    const account = object((await this.#get("/user", budget)).value);
    requireCondition(
      account.id === credentials.expectedGitHubUserId,
      403,
      "source_account_mismatch",
      "The GitHub credential does not belong to the configured account.",
    );
    const upstream = object((await this.#get(sourcePath(repository), budget)).value);
    requireCondition(
      upstream.id === repository.githubRepositoryId &&
        text(upstream.full_name, "repository name").toLowerCase() ===
          repository.fullName.toLowerCase(),
      409,
      "source_repository_mismatch",
      "The upstream repository identity differs from its registered numeric ID and name.",
    );
  }

  #targetState(value: JsonObject, kind: "pull_request" | "issue") {
    return {
      number: count(value.number, "work item number"),
      title: text(value.title, "title"),
      body: value.body === null ? "" : text(value.body, "body", true),
      state: text(value.state, "state"),
      updatedAt: text(value.updated_at, "updated_at"),
      comments: count(value.comments, "comment count"),
      ...(kind === "pull_request"
        ? {
            base: text(object(value.base).sha, "base SHA"),
            head: text(object(value.head).sha, "head SHA"),
            reviewComments: count(value.review_comments, "review comment count"),
            mergedAt:
              value.merged_at === null || value.merged_at === undefined
                ? null
                : text(value.merged_at, "merged_at"),
          }
        : {}),
    };
  }

  async #comments(
    path: string,
    prefix: string,
    budget: SourceBudget,
  ): Promise<InvestigationInputSnapshotV1["comments"]> {
    const result: InvestigationInputSnapshotV1["comments"] = [];
    const seen = new Set<string>();
    for (let page = 1; ; page += 1) {
      requireCondition(
        ++budget.pages <= this.#maximumPages,
        413,
        "source_budget_exceeded",
        "The complete conversation exceeds the pagination budget; no partial snapshot was saved.",
      );
      const response = await this.#get(`${path}?per_page=100&page=${page}`, budget);
      requireCondition(
        Array.isArray(response.value),
        502,
        "invalid_source_response",
        "GitHub returned an invalid comment page.",
      );
      for (const raw of response.value) {
        const comment = object(raw);
        const numericId = count(comment.id, "comment ID");
        requireCondition(
          numericId > 0,
          502,
          "invalid_source_response",
          "GitHub returned an invalid comment ID.",
        );
        const id = `${prefix}:${numericId}`;
        requireCondition(
          !seen.has(id),
          409,
          "source_changed_during_import",
          "The conversation changed between pages; retry the complete import.",
        );
        seen.add(id);
        result.push({
          id,
          body: comment.body === null ? "" : text(comment.body, "comment body", true),
        });
      }
      const next = response.link?.split(",").find((part) => /;\s*rel="next"/u.test(part));
      if (next !== undefined) {
        const matched = /^\s*<([^>]+)>/u.exec(next);
        let url: URL;
        try {
          url = new URL(matched?.[1] ?? "");
        } catch {
          throw new InvestigationRequestError(
            502,
            "invalid_source_pagination",
            "GitHub returned an invalid pagination URL.",
          );
        }
        requireCondition(
          url.origin === "https://api.github.com" &&
            url.pathname === path &&
            url.searchParams.get("page") === String(page + 1) &&
            url.searchParams.get("per_page") === "100",
          502,
          "invalid_source_pagination",
          "GitHub pagination left the expected endpoint.",
        );
      }
      if (next === undefined && response.value.length < 100) return result;
      requireCondition(
        response.value.length > 0,
        502,
        "invalid_source_pagination",
        "GitHub pagination did not make progress.",
      );
    }
  }

  async #get(path: string, budget: SourceBudget): Promise<{ value: unknown; link: string | null }> {
    const credentials = this.options.github;
    requireCondition(
      credentials !== undefined,
      503,
      "source_import_unavailable",
      "A GitHub read credential is required.",
    );
    let response: Response;
    try {
      response = await this.#fetch(`https://api.github.com${path}`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeout),
        headers: {
          authorization: `Bearer ${credentials.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "Agentic-Review-Investigation/1.0",
        },
      });
    } catch {
      throw new InvestigationRequestError(
        503,
        "source_read_failed",
        "The complete upstream source could not be read; retry when GitHub is available.",
      );
    }
    requireCondition(
      response.ok,
      response.status === 404 ? 404 : 503,
      "source_read_failed",
      "GitHub could not provide the complete requested source.",
    );
    const reader = response.body?.getReader();
    requireCondition(
      reader !== undefined,
      502,
      "invalid_source_response",
      "GitHub returned an empty source response.",
    );
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        budget.bytes += chunk.value.byteLength;
        requireCondition(
          budget.bytes <= this.#maximumBytes,
          413,
          "source_budget_exceeded",
          "The complete source exceeds the configured byte budget; no partial snapshot was saved.",
        );
        chunks.push(chunk.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (error instanceof InvestigationRequestError) throw error;
      throw new InvestigationRequestError(
        503,
        "source_read_failed",
        "The upstream source response was interrupted; no partial snapshot was saved.",
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      ) as unknown;
    } catch {
      throw new InvestigationRequestError(
        502,
        "invalid_source_response",
        "GitHub returned invalid UTF-8 source JSON.",
      );
    }
    return { value, link: response.headers.get("link") };
  }
}
