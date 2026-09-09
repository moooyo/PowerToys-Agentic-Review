import {
  type DashboardReviewRunDetail,
  type DashboardReviewRunJobListResponse,
  type DashboardReviewRunListResponse,
  type DashboardReviewRunReproductionCaseQuery,
  DashboardReviewRunReproductionCaseQuerySchema,
  type DashboardReviewRunReproductionCaseResponse,
  type DashboardReviewRunRequest,
  type DashboardReviewRunResult,
  type DashboardReviewRunSummary,
  maximumDashboardReviewRunPolicyReasonCount,
  type OperatorReviewRunCancelResponse,
  type OperatorReviewRunCreateRequest,
  OperatorReviewRunCreateRequestSchema,
  type OperatorReviewRunRerunRequest,
  type OperatorReviewRunRerunResponse,
  type PromptBinding,
  type ValidationProfileVersion,
  ValidationProfileVersionSchema,
  type WorkflowKind,
} from "@agentic-review/contracts";
import type {
  ConfigurationAdapter,
  ConfigurationPage,
  ConfigurationPageQuery,
} from "../configuration/adapter";
import { MockConfigurationAdapter } from "../configuration/mock-adapter";
import { sampleRepositories } from "../repositories/mock-adapter";
import { ReviewControlHttpError } from "../review-control/errors";
import { workItems } from "../review-control/mock/fixtures";
import type { WorkItem } from "../review-control/types";
import type { ReviewRunAdapter, ReviewRunJobListQuery, ReviewRunListQuery } from "./adapter";
import { sampleReviewRunResults, sampleReviewRuns } from "./fixtures";
import {
  normalizeRunJobQuery,
  normalizeRunPageQuery,
  validateRunDetail,
  validateRunEntityId,
  validateRunJobs,
  validateRunList,
  validateRunRequest,
  validateRunResult,
} from "./validation";

export interface MockReviewRunAdapterOptions {
  readonly empty?: boolean;
  readonly now?: () => Date;
  readonly configuration?: ConfigurationAdapter;
}

interface Activation {
  readonly intent: string;
  readonly reviewRunId: string;
}

function httpError(operation: string, status: 400 | 404 | 409, message: string) {
  return new ReviewControlHttpError(message, {
    operation,
    status,
    retryable: false,
    serverCode:
      status === 404
        ? "review_run_not_found"
        : status === 409
          ? "platform_conflict"
          : "platform_invalid",
  });
}

function scopeKey(...parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function creationIntent(input: OperatorReviewRunCreateRequest): string {
  return JSON.stringify({
    activationId: input.activationId,
    expectedRevisionKey: input.expectedRevisionKey,
    profileIds: input.profileIds === undefined ? null : [...input.profileIds].sort(),
    testedSourceCommit: input.testedSourceCommit ?? null,
  });
}

async function sha256(content: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function summary(run: DashboardReviewRunDetail): DashboardReviewRunSummary {
  const {
    requestEpochId: _epoch,
    testedSourceRevision: _source,
    requiredCheckIds: _checks,
    requests: _requests,
    policy: _policy,
    reproduction: _reproduction,
    ...result
  } = run;
  return result;
}

function paginate<T>(items: readonly T[], page: number, pageSize: number) {
  return {
    items: structuredClone(items.slice((page - 1) * pageSize, page * pageSize)),
    total: items.length,
    page,
    pageSize,
  };
}

export class MockReviewRunAdapter implements ReviewRunAdapter {
  readonly mode = "sample";

  async rerun(
    _repositoryId: string,
    _reviewRunId: string,
    _requestId: string,
    _input: OperatorReviewRunRerunRequest,
  ): Promise<OperatorReviewRunRerunResponse> {
    throw httpError(
      "rerun validation profile",
      409,
      "Sample mode does not execute reruns. Connect to a server to run this profile.",
    );
  }

  async cancel(
    _repositoryId: string,
    _reviewRunId: string,
    _requestId: string,
    _jobId: string,
  ): Promise<OperatorReviewRunCancelResponse> {
    throw httpError(
      "cancel validation job",
      409,
      "Sample mode does not cancel real jobs. Connect to a server to manage execution.",
    );
  }
  private readonly runs = new Map<string, DashboardReviewRunDetail>();
  private readonly results = new Map<string, DashboardReviewRunResult>();
  private readonly activations = new Map<string, Activation>();
  private readonly now: () => Date;
  private readonly configuration: ConfigurationAdapter;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: MockReviewRunAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.configuration = options.configuration ?? new MockConfigurationAdapter({ now: this.now });
    if (options.empty) return;
    for (const sample of sampleReviewRuns) {
      const run = structuredClone(validateRunDetail(sample, "initialize sample review runs"));
      this.runs.set(run.id, run);
      this.activations.set(scopeKey(run.repositoryId, run.workItemId, run.activationId), {
        intent: creationIntent({
          activationId: run.activationId,
          expectedRevisionKey: run.revisionKey,
          ...(run.testedSourceRevision?.kind === "commit"
            ? { testedSourceCommit: run.testedSourceRevision.headSha }
            : {}),
        }),
        reviewRunId: run.id,
      });
    }
    for (const sample of sampleReviewRunResults) {
      const run = this.requireRun(
        sample.repositoryId,
        sample.reviewRunId,
        "initialize sample results",
      );
      const result = validateRunResult(
        sample,
        run,
        sample.requestId,
        sample.jobId,
        "initialize sample results",
      );
      this.results.set(
        scopeKey(result.repositoryId, result.reviewRunId, result.requestId, result.jobId),
        structuredClone(result),
      );
    }
  }

  async list(
    repositoryId: string,
    query?: ReviewRunListQuery,
  ): Promise<DashboardReviewRunListResponse> {
    const operation = "list review runs";
    this.requireRepository(repositoryId, operation);
    const pagination = normalizeRunPageQuery(query, true);
    if (pagination.workItemId !== undefined)
      this.requireWorkItem(repositoryId, pagination.workItemId, operation);
    const items = [...this.runs.values()]
      .filter(
        (run) =>
          run.repositoryId === repositoryId &&
          (pagination.workItemId === undefined || run.workItemId === pagination.workItemId),
      )
      .map((run) => summary(this.currentRun(run, operation)))
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
      );
    return validateRunList(
      paginate(items, pagination.page, pagination.pageSize),
      repositoryId,
      pagination,
      operation,
    );
  }

  async get(repositoryId: string, reviewRunId: string): Promise<DashboardReviewRunDetail> {
    return structuredClone(this.requireRun(repositoryId, reviewRunId, "get review run"));
  }

  async getReproductionCase(
    query: DashboardReviewRunReproductionCaseQuery,
  ): Promise<DashboardReviewRunReproductionCaseResponse> {
    const operation = "get review run reproduction case";
    validateRunRequest(DashboardReviewRunReproductionCaseQuerySchema, query, operation);
    throw httpError(
      operation,
      409,
      "Sample mode does not provide mapped reproduction evidence. Connect to a server to inspect a frozen case.",
    );
  }

  async create(
    repositoryId: string,
    workItemId: string,
    input: OperatorReviewRunCreateRequest,
  ): Promise<DashboardReviewRunDetail> {
    const operation = "create review run";
    this.requireRepository(repositoryId, operation);
    this.requireWorkItem(repositoryId, workItemId, operation);
    const request = structuredClone(
      validateRunRequest(OperatorReviewRunCreateRequestSchema, input, operation),
    );
    if (request.reproduction !== undefined)
      throw httpError(
        operation,
        409,
        "Sample mode does not create mapped reproduction runs. Connect to a server to freeze and execute these cases.",
      );
    const result = this.pending.then(() => this.createSnapshot(repositoryId, workItemId, request));
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async createSnapshot(
    repositoryId: string,
    workItemId: string,
    request: OperatorReviewRunCreateRequest,
  ): Promise<DashboardReviewRunDetail> {
    const operation = "create review run";
    const intent = creationIntent(request);
    const activationKey = scopeKey(repositoryId, workItemId, request.activationId);
    const previous = this.activations.get(activationKey);
    if (previous !== undefined) {
      if (previous.intent !== intent)
        throw httpError(operation, 409, "This activation belongs to a different creation request.");
      return this.get(repositoryId, previous.reviewRunId);
    }

    const item = this.requireCreationAuthority(repositoryId, workItemId, request, operation);
    const profiles = await this.enabledProfiles(repositoryId, item.kind, operation);
    const selected = request.profileIds === undefined ? null : new Set(request.profileIds);
    if (
      selected !== null &&
      [...selected].some((id) => !profiles.some((profile) => profile.profileId === id))
    )
      throw httpError(
        operation,
        400,
        "Selected sample profiles must belong to this repository and work item kind.",
      );
    const selectedProfiles = profiles.filter(
      (profile) => profile.required || selected === null || selected.has(profile.profileId),
    );
    if (selectedProfiles.length === 0 || selectedProfiles.length > 32)
      throw httpError(
        operation,
        409,
        "A sample review run must include between 1 and 32 enabled profiles.",
      );
    const [repositoryBindings, globalBindings] = await Promise.all([
      this.configuration.listPromptBindings(repositoryId),
      this.configuration.listPromptBindings(null),
    ]);
    if (
      repositoryBindings.items.some((binding) => binding.repositoryId !== repositoryId) ||
      globalBindings.items.some((binding) => binding.repositoryId !== null)
    )
      throw httpError(
        operation,
        409,
        "The configured prompt binding belongs to another repository.",
      );
    const prompts = new Map<WorkflowKind, DashboardReviewRunRequest["prompt"]>();
    for (const profile of selectedProfiles) {
      if (!prompts.has(profile.workflowKind)) {
        const binding =
          repositoryBindings.items.find((entry) => entry.workflowKind === profile.workflowKind) ??
          globalBindings.items.find((entry) => entry.workflowKind === profile.workflowKind);
        prompts.set(
          profile.workflowKind,
          await this.resolvePrompt(binding, profile.workflowKind, operation),
        );
      }
    }
    const requests: DashboardReviewRunRequest[] = selectedProfiles.map((profile) => {
      const prompt = prompts.get(profile.workflowKind) ?? null;
      const validationSteps = [
        ...profile.config.build,
        ...profile.config.test,
        ...(profile.config.ui?.scenarios ?? []),
      ];
      return {
        requestId: profile.profileId,
        workflowKind: profile.workflowKind,
        target: profile.target,
        required: profile.required,
        profile: {
          id: profile.id,
          profileId: profile.profileId,
          name: profile.name,
          version: profile.version,
          configSha256: profile.configSha256,
        },
        prompt,
        requiredCheckIds: profile.required
          ? validationSteps
              .filter((step) => step.required)
              .map((step) => `${profile.id}:${step.id}`)
              .sort()
          : [],
        readiness: "blocked",
        blockers: [
          "Sample preview only: execution creation is disabled, so this plan has no job or result.",
          ...(prompt === null ? ["No published prompt is bound to this workflow."] : []),
        ],
        blockersTruncated: false,
        latestJob: null,
        latestResult: null,
      };
    });
    if (
      request.testedSourceCommit !== undefined &&
      (item.kind !== "issue" ||
        !requests.some((entry) => entry.workflowKind === "issue_validation"))
    )
      throw httpError(
        operation,
        400,
        "A tested source commit is accepted only for an issue validation review run.",
      );
    if (item.kind === "issue" && request.testedSourceCommit === undefined) {
      for (const entry of requests) {
        if (entry.workflowKind === "issue_validation")
          entry.blockers.push("An exact source commit must be authorized for issue reproduction.");
      }
    }

    const required = requests.filter((entry) => entry.required);
    const requiredCheckIds = required.flatMap((entry) => entry.requiredCheckIds);
    const reasons = required.flatMap((entry) => [
      {
        code: "required_request_blocked",
        requestId: entry.requestId,
        reason: entry.blockers[0],
      },
      ...entry.requiredCheckIds.map((checkId) => ({ code: "missing_required_check", checkId })),
    ]);
    const template = sampleReviewRuns.find(
      (run) =>
        run.repositoryId === repositoryId &&
        run.workItemId === workItemId &&
        run.revisionKey === item.revisionKey,
    );
    const testedSourceRevision =
      item.kind === "issue"
        ? request.testedSourceCommit === undefined
          ? null
          : { kind: "commit" as const, headSha: request.testedSourceCommit }
        : structuredClone(template?.testedSourceRevision ?? null);
    const planDigest = await sha256(
      JSON.stringify({
        schemaVersion: "SampleReviewRunPlanV1",
        repositoryId,
        workItemId,
        revisionKey: item.revisionKey,
        requestEpochId: item.activeRequestEpoch?.requestEpochId,
        activationId: request.activationId,
        testedSourceRevision,
        requests,
      }),
    );
    // Configuration resolution and hashing yield. Recheck work-item authority before storing the frozen plan.
    const current = this.requireCreationAuthority(repositoryId, workItemId, request, operation);
    if (current.activeRequestEpoch?.requestEpochId !== item.activeRequestEpoch?.requestEpochId)
      throw httpError(
        operation,
        409,
        "The authorized request changed while the sample plan was being prepared.",
      );
    const base = {
      id: `sample-run-${globalThis.crypto.randomUUID()}`,
      repositoryId,
      repository: item.repository,
      workItemId,
      number: item.number,
      title: item.title,
      revisionKey: item.revisionKey,
      currentRevisionKey: item.revisionKey,
      freshness: "current" as const,
      planDigest,
      activationId: request.activationId,
      createdAt: this.now().toISOString(),
      requestCount: requests.length,
      requiredRequestCount: required.length,
      execution: {
        missing: requests.length,
        awaitingAdmission: 0,
        queued: 0,
        active: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
      },
      requestEpochId: current.activeRequestEpoch?.requestEpochId ?? "",
      testedSourceRevision,
      requiredCheckIds,
      requests,
    };
    const run: DashboardReviewRunDetail =
      item.kind === "pull_request"
        ? {
            ...base,
            workItemKind: "pull_request",
            policy: {
              policyVersion: "required-checks-and-p0-p1-v1",
              applicable: true,
              eligible: false,
              reasons: reasons.slice(0, maximumDashboardReviewRunPolicyReasonCount),
              reasonCount: reasons.length,
              reasonsTruncated: reasons.length > maximumDashboardReviewRunPolicyReasonCount,
              blockingFindingCount: 0,
            },
          }
        : {
            ...base,
            workItemKind: "issue",
            policy: {
              policyVersion: "required-checks-and-p0-p1-v1",
              applicable: false,
              eligible: null,
              reasons: [],
              reasonCount: 0,
              reasonsTruncated: false,
              blockingFindingCount: 0,
            },
          };
    validateRunDetail(run, operation, {
      repositoryId,
      workItemId,
      activationId: request.activationId,
    });
    this.runs.set(run.id, structuredClone(run));
    this.activations.set(activationKey, { intent, reviewRunId: run.id });
    return structuredClone(run);
  }

  async listJobs(
    repositoryId: string,
    reviewRunId: string,
    requestId: string,
    query?: ReviewRunJobListQuery,
  ): Promise<DashboardReviewRunJobListResponse> {
    const operation = "list review run jobs";
    const pagination = normalizeRunJobQuery(query);
    const run = this.requireRun(repositoryId, reviewRunId, operation);
    const request = this.requireRequest(run, requestId, operation);
    return validateRunJobs(
      {
        repositoryId,
        reviewRunId,
        requestId,
        ...paginate(
          request.latestJob === null ||
            (pagination.jobId !== undefined && request.latestJob.jobId !== pagination.jobId)
            ? []
            : [request.latestJob],
          pagination.page,
          pagination.pageSize,
        ),
      },
      repositoryId,
      reviewRunId,
      requestId,
      pagination,
      operation,
    );
  }

  async getResult(
    repositoryId: string,
    reviewRunId: string,
    requestId: string,
    jobId: string,
  ): Promise<DashboardReviewRunResult | null> {
    const operation = "get review run result";
    validateRunEntityId(jobId, operation, "jobId");
    const run = this.requireRun(repositoryId, reviewRunId, operation);
    const request = this.requireRequest(run, requestId, operation);
    if (request.latestJob?.jobId !== jobId)
      throw httpError(
        operation,
        404,
        "The selected job was not found in this repository, run, and request.",
      );
    const result = this.results.get(scopeKey(repositoryId, reviewRunId, requestId, jobId));
    if (result === undefined) return null;
    return structuredClone(validateRunResult(result, run, requestId, jobId, operation));
  }

  private async configurationPages<T>(
    fetchPage: (query: ConfigurationPageQuery) => Promise<ConfigurationPage<T>>,
    operation: string,
  ): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= 21; page += 1) {
      const response = await fetchPage({ page, pageSize: 50 });
      if (response.total > 1_024 || response.page !== page || response.pageSize !== 50)
        throw httpError(
          operation,
          409,
          "The sample configuration exceeds the supported scope or pagination limit.",
        );
      items.push(...response.items);
      if (items.length === response.total) return items;
      if (items.length > response.total || response.items.length === 0)
        throw httpError(
          operation,
          409,
          "The sample configuration changed while the plan was being prepared.",
        );
    }
    throw httpError(
      operation,
      409,
      "The sample configuration exceeds the supported pagination limit.",
    );
  }

  private async enabledProfiles(
    repositoryId: string,
    kind: WorkItem["kind"],
    operation: string,
  ): Promise<ValidationProfileVersion[]> {
    const bindings = await this.configurationPages(
      (query) => this.configuration.listProfileBindings(repositoryId, query),
      operation,
    );
    if (
      bindings.some((binding) => binding.repositoryId !== repositoryId) ||
      new Set(bindings.map((binding) => binding.profileId)).size !== bindings.length
    )
      throw httpError(
        operation,
        409,
        "The profile bindings have inconsistent repository identities.",
      );
    const profiles: ValidationProfileVersion[] = [];
    for (const binding of bindings.filter((entry) => entry.enabled)) {
      const profile = validateRunRequest(
        ValidationProfileVersionSchema,
        await this.configuration.getProfileVersion(
          repositoryId,
          binding.profileId,
          binding.profileVersionId,
        ),
        operation,
      );
      if (
        profile.repositoryId !== repositoryId ||
        profile.profileId !== binding.profileId ||
        profile.id !== binding.profileVersionId
      )
        throw httpError(
          operation,
          409,
          "The enabled validation profile does not match its repository binding.",
        );
      if ((kind === "pull_request") === profile.workflowKind.startsWith("pr_"))
        profiles.push(profile);
    }
    if (profiles.length === 0)
      throw httpError(
        operation,
        409,
        "Configure at least one enabled validation profile for this work item before creating a sample review run.",
      );
    return profiles.sort((left, right) => left.profileId.localeCompare(right.profileId));
  }

  private async resolvePrompt(
    binding: PromptBinding | undefined,
    workflowKind: WorkflowKind,
    operation: string,
  ): Promise<DashboardReviewRunRequest["prompt"]> {
    if (binding === undefined) return null;
    const templates = await this.configurationPages(
      (query) => this.configuration.listPrompts({ ...query, workflowKind }),
      operation,
    );
    for (const template of templates) {
      if (template.workflowKind !== workflowKind)
        throw httpError(operation, 409, "The bound prompt does not match the requested workflow.");
      const versions = await this.configurationPages(
        (query) => this.configuration.listPromptVersions(template.id, query),
        operation,
      );
      const version = versions.find((entry) => entry.id === binding.promptVersionId);
      if (version !== undefined) {
        if (version.templateId !== template.id)
          throw httpError(
            operation,
            409,
            "The bound prompt does not match its published template.",
          );
        return {
          id: version.id,
          templateId: version.templateId,
          version: version.version,
          contentSha256: version.contentSha256,
        };
      }
    }
    throw httpError(
      operation,
      409,
      "The selected prompt binding has no published version for this workflow.",
    );
  }

  private requireCreationAuthority(
    repositoryId: string,
    workItemId: string,
    request: OperatorReviewRunCreateRequest,
    operation: string,
  ): WorkItem {
    const repository = this.requireRepository(repositoryId, operation);
    const item = this.requireWorkItem(repositoryId, workItemId, operation);
    if (!repository.enabled)
      throw httpError(operation, 409, "Enable the sample repository before creating a review run.");
    if (item.revisionKey !== request.expectedRevisionKey || item.state === "closed")
      throw httpError(
        operation,
        409,
        "The work item is closed or its revision changed. Refresh it before creating a review run.",
      );
    if (
      item.authorization === "pending" ||
      item.authorization === "denied" ||
      item.trigger === "not_requested" ||
      item.activeRequestEpoch === null ||
      item.activeRequestEpoch.status !== "active" ||
      (item.kind === "issue" && item.activeRequestEpoch.requestKind !== "assignment")
    )
      throw httpError(
        operation,
        409,
        "This revision requires an authorized GitHub review request or assignment.",
      );
    return structuredClone(item);
  }

  private requireRepository(repositoryId: string, operation: string) {
    validateRunEntityId(repositoryId, operation, "repositoryId");
    const repository = sampleRepositories.find((entry) => entry.id === repositoryId);
    if (repository === undefined)
      throw httpError(operation, 404, "The selected sample repository was not found.");
    return repository;
  }

  private requireWorkItem(repositoryId: string, workItemId: string, operation: string): WorkItem {
    validateRunEntityId(workItemId, operation, "workItemId");
    const item = workItems.find(
      (entry) => entry.id === workItemId && entry.repositoryId === repositoryId,
    );
    if (item === undefined)
      throw httpError(
        operation,
        404,
        "The selected work item was not found in this sample repository.",
      );
    return item;
  }

  private currentRun(run: DashboardReviewRunDetail, operation: string): DashboardReviewRunDetail {
    const item = this.requireWorkItem(run.repositoryId, run.workItemId, operation);
    const current = structuredClone(run);
    current.currentRevisionKey = item.revisionKey;
    current.freshness = current.revisionKey === item.revisionKey ? "current" : "superseded";
    if (current.policy.applicable && current.freshness === "superseded") {
      current.policy.eligible = false;
      if (!current.policy.reasons.some((reason) => reason.code === "stale_revision")) {
        current.policy.reasons = [...current.policy.reasons, { code: "stale_revision" }].slice(
          0,
          maximumDashboardReviewRunPolicyReasonCount,
        );
        current.policy.reasonCount += 1;
      }
      current.policy.reasonsTruncated = current.policy.reasonCount > current.policy.reasons.length;
    }
    return validateRunDetail(current, operation, {
      repositoryId: item.repositoryId,
      workItemId: item.id,
    });
  }

  private requireRun(
    repositoryId: string,
    reviewRunId: string,
    operation: string,
  ): DashboardReviewRunDetail {
    this.requireRepository(repositoryId, operation);
    validateRunEntityId(reviewRunId, operation, "reviewRunId");
    const run = this.runs.get(reviewRunId);
    if (run === undefined || run.repositoryId !== repositoryId)
      throw httpError(
        operation,
        404,
        "The selected review run was not found in this sample repository.",
      );
    return this.currentRun(run, operation);
  }

  private requireRequest(
    run: DashboardReviewRunDetail,
    requestId: string,
    operation: string,
  ): DashboardReviewRunRequest {
    validateRunEntityId(requestId, operation, "requestId");
    const request = run.requests.find((entry) => entry.requestId === requestId);
    if (request === undefined)
      throw httpError(
        operation,
        404,
        "The selected request was not found in this sample review run.",
      );
    return request;
  }
}
