import {
  ReviewControlError,
  ReviewControlHttpError,
  ReviewControlNetworkError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
  ReviewControlResponseTooLargeError,
  ReviewControlTimeoutError,
} from "./errors";

export const DASHBOARD_API_PREFIX = "/api/v1/dashboard/";
export const OPERATOR_WORKER_NODES_PATH = "/api/v1/operator/worker-nodes";
export const OPERATOR_REPOSITORIES_PATH = "/api/v1/operator/repositories";
export const OPERATOR_ACCESS_PATH = "/api/v1/operator/access";
export const OPERATOR_ACCESS_DENIED_EVENT = "operator-access-denied";
export const DEFAULT_DASHBOARD_REQUEST_TIMEOUT_MS = 15_000;
export const MAX_DASHBOARD_RESPONSE_BYTES = 2 * 1_024 * 1_024;
export const MAX_DASHBOARD_REQUEST_BYTES = 2 * 1_024 * 1_024;

const workerCredentialMutationPathPattern =
  /^\/api\/v1\/operator\/worker-nodes\/worker:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:token\/rotate|revoke)$/u;
const workerTokenExposurePattern = /arw1_[A-Za-z0-9_-]{43}/u;
const canonicalDiagnosticPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const canonicalRawPathPattern = /^[\x21-\x7e]+$/u;
const dashboardReadPathnames = new Set([
  "/api/v1/dashboard/jobs",
  "/api/v1/dashboard/system",
  "/api/v1/dashboard/work-items",
  "/api/v1/dashboard/workers",
]);
const dashboardJobByIdPathPattern =
  /^\/api\/v1\/dashboard\/jobs\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const repositoryByIdPathPattern =
  /^\/api\/v1\/operator\/repositories\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const repositoryConnectionPathPattern =
  /^\/api\/v1\/operator\/repositories\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/check-connection$/u;

type DashboardHttpMethod = "GET" | "POST" | "PATCH" | "PUT";

const configurationIdSegment = "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}";
const configurationWorkflowSegment = "(?:pr_static_build|pr_ui|issue_triage|issue_validation)";
const configurationPromptPrefix = "/api/v1/operator/prompts";
const configurationRepositoryPrefix = `/api/v1/operator/repositories/${configurationIdSegment}`;
const modelRuntimePrefix = "/api/v1/operator/model-runtimes";
const modelRuntimeDetailPattern = new RegExp(
  `^${modelRuntimePrefix}/${configurationIdSegment}$`,
  "u",
);
const modelRuntimeHistoryPattern = new RegExp(
  `^${modelRuntimePrefix}/${configurationIdSegment}/history$`,
  "u",
);
const evaluationModelRuntimeOptionsPattern = new RegExp(
  `^${configurationRepositoryPrefix}/evaluation-model-runtime-options$`,
  "u",
);
const evaluationSourcePath = `${configurationRepositoryPrefix}/evaluation-sources`;
const evaluationSuitePath = `${configurationRepositoryPrefix}/evaluation-suites`;
const evaluationVersionPath = `${evaluationSuitePath}/${configurationIdSegment}/versions`;
const evaluationPagedPathPattern = new RegExp(
  `^(?:${evaluationSourcePath}|${evaluationSuitePath}|${evaluationVersionPath})$`,
  "u",
);
const evaluationDetailPathPattern = new RegExp(
  `^(?:${evaluationSourcePath}/${configurationIdSegment}|${evaluationSuitePath}/${configurationIdSegment}|${evaluationVersionPath}/${configurationIdSegment}/cases/${configurationIdSegment})$`,
  "u",
);
const evaluationDirectReadPathPattern = new RegExp(
  `^(?:${evaluationVersionPath}/${configurationIdSegment}(?:/cases)?)$`,
  "u",
);
const evaluationPostPathPattern = new RegExp(
  `^(?:${evaluationSourcePath}|${evaluationSuitePath}|${evaluationVersionPath})$`,
  "u",
);
const evaluationDraftPathPattern = new RegExp(
  `^${evaluationSuitePath}/${configurationIdSegment}/draft$`,
  "u",
);
const evaluationBatchPath = `${configurationRepositoryPrefix}/evaluations`;
const evaluationBatchListPathPattern = new RegExp(`^${evaluationBatchPath}$`, "u");
const evaluationBatchReadPathPattern = new RegExp(
  `^${evaluationBatchPath}/${configurationIdSegment}(?:/matrix)?$`,
  "u",
);
const evaluationCellResultPathPattern = new RegExp(
  `^${evaluationBatchPath}/${configurationIdSegment}/cells/${configurationIdSegment}/results/${configurationIdSegment}$`,
  "u",
);
const evaluationReproductionDocumentPathPattern = new RegExp(
  `^(?:${evaluationSourcePath}/${configurationIdSegment}/reproduction|${evaluationBatchPath}/${configurationIdSegment}/cells/${configurationIdSegment}/reproduction)$`,
  "u",
);
const evaluationReproductionPlanPathPattern = new RegExp(
  `^${evaluationBatchPath}/${configurationIdSegment}/reproduction$`,
  "u",
);
const evaluationReproductionPreviewPathPattern = new RegExp(
  `^${configurationRepositoryPrefix}/evaluation-reproduction/preview$`,
  "u",
);
const evaluationModelInvocationListPathPattern = new RegExp(
  `^${evaluationBatchPath}/${configurationIdSegment}/cells/${configurationIdSegment}/model-invocations$`,
  "u",
);
const evaluationEvidenceJsonPathPattern = new RegExp(
  `^${evaluationBatchPath}/${configurationIdSegment}/cells/${configurationIdSegment}/results/${configurationIdSegment}/evidence(?:/${configurationIdSegment})?$`,
  "u",
);
const evaluationAdjudicationPath = `${evaluationBatchPath}/${configurationIdSegment}/cells/${configurationIdSegment}/results/${configurationIdSegment}/adjudications`;
const evaluationAdjudicationContextPathPattern = new RegExp(`^${evaluationAdjudicationPath}$`, "u");
const evaluationAdjudicationChangePathPattern = new RegExp(
  `^${evaluationAdjudicationPath}/[a-f0-9]{64}$`,
  "u",
);
const evaluationAdjudicationHistoryPathPattern = new RegExp(
  `^${evaluationAdjudicationPath}/[a-f0-9]{64}/history$`,
  "u",
);
const evaluationAssessmentPath = `${evaluationBatchPath}/${configurationIdSegment}/assessments`;
const evaluationAssessmentListPathPattern = new RegExp(`^${evaluationAssessmentPath}$`, "u");
const evaluationAssessmentReadPathPattern = new RegExp(
  `^(?:${evaluationBatchPath}/${configurationIdSegment}/score-preview|${evaluationAssessmentPath}/${configurationIdSegment}(?:/cases/${configurationIdSegment})?)$`,
  "u",
);
const evaluationBatchPostPathPattern = new RegExp(
  `^(?:${evaluationBatchPath}|${evaluationBatchPath}/${configurationIdSegment}/cancel)$`,
  "u",
);
const evaluationPromptOptionsPathPattern = new RegExp(
  `^${configurationRepositoryPrefix}/evaluation-prompt-options$`,
  "u",
);
const evaluationWorkflowPattern = new RegExp(`^${configurationWorkflowSegment}$`, "u");
const globalConfigurationAuditPrefix = "/api/v1/operator/configuration-audit";
const repositoryConfigurationAuditPagePattern = new RegExp(
  `^${configurationRepositoryPrefix}/configuration-audit$`,
  "u",
);
const configurationAuditDetailPattern = new RegExp(
  `^(?:${globalConfigurationAuditPrefix}/${configurationIdSegment}|${configurationRepositoryPrefix}/configuration-audit/(?:repository|prompt)/${configurationIdSegment})$`,
  "u",
);
const repositoryAccessPathPattern = new RegExp(`^${configurationRepositoryPrefix}/access$`, "u");
const repositoryAccessListPathPattern = new RegExp(
  `^${configurationRepositoryPrefix}/access(?:/history)?$`,
  "u",
);
const configurationBindingPrefix = `(?:/api/v1/operator|${configurationRepositoryPrefix})/prompt-bindings`;
const configurationDirectReadPattern = new RegExp(
  `^(?:${configurationPromptPrefix}/${configurationIdSegment}(?:/versions/${configurationIdSegment})?|${configurationBindingPrefix}|${configurationRepositoryPrefix}/validation-profiles/${configurationIdSegment}/versions/${configurationIdSegment})$`,
  "u",
);
const configurationPagePathPattern = new RegExp(
  `^(?:${configurationPromptPrefix}/${configurationIdSegment}/versions|${configurationBindingPrefix}/${configurationWorkflowSegment}/history|${configurationRepositoryPrefix}/validation-profiles(?:/${configurationIdSegment}/versions)?|${configurationRepositoryPrefix}/validation-profile-bindings(?:/${configurationIdSegment}/history)?)$`,
  "u",
);
const configurationPostPathPattern = new RegExp(
  `^(?:${configurationPromptPrefix}(?:/preview|/${configurationIdSegment}/publish)?|${configurationRepositoryPrefix}/validation-profiles)$`,
  "u",
);
const configurationDraftPathPattern = new RegExp(
  `^${configurationPromptPrefix}/${configurationIdSegment}/draft$`,
  "u",
);
const configurationBindingPathPattern = new RegExp(
  `^(?:${configurationBindingPrefix}/${configurationWorkflowSegment}|${configurationRepositoryPrefix}/validation-profile-bindings/${configurationIdSegment})$`,
  "u",
);
const reviewRunPrefix = `${configurationRepositoryPrefix}/review-runs`;
const reviewRunPath = `${reviewRunPrefix}/${configurationIdSegment}`;
const reviewRunDecisionPathPattern = new RegExp(`^${reviewRunPath}/decisions$`, "u");
const reviewRunDecisionHistoryPathPattern = new RegExp(`^${reviewRunPath}/decisions/history$`, "u");
const reviewRunRequestPath = `${reviewRunPath}/requests/${configurationIdSegment}`;
const reviewRunReproductionCasePathPattern = new RegExp(
  `^${reviewRunRequestPath}/reproduction-cases/${configurationIdSegment}$`,
  "u",
);
const findingPath = `${reviewRunRequestPath}/jobs/${configurationIdSegment}/findings`;
const findingReadPathPattern = new RegExp(`^${findingPath}(?:/[a-f0-9]{64}/history)?$`, "u");
const findingComparisonPathPattern = new RegExp(`^${findingPath}/comparison$`, "u");
const findingChangePathPattern = new RegExp(`^${findingPath}/[a-f0-9]{64}/disposition$`, "u");
const reviewRunListPathPattern = new RegExp(`^${reviewRunPrefix}$`, "u");
const reviewRunJobListPathPattern = new RegExp(`^${reviewRunRequestPath}/jobs$`, "u");
const reviewRunDirectReadPattern = new RegExp(
  `^(?:${reviewRunPath}|${reviewRunRequestPath}/jobs/${configurationIdSegment}/result)$`,
  "u",
);
const reviewRunCreatePathPattern = new RegExp(
  `^${configurationRepositoryPrefix}/work-items/${configurationIdSegment}/review-runs$`,
  "u",
);
const reviewRunActionPathPattern = new RegExp(
  `^${reviewRunRequestPath}/(?:reruns|jobs/${configurationIdSegment}/cancel)$`,
  "u",
);
const reviewRunEvidenceReadPattern = new RegExp(
  `^${reviewRunPath}/jobs/${configurationIdSegment}/attempts/${configurationIdSegment}/evidence(?:/${configurationIdSegment})?$`,
  "u",
);
const schedulingReadPathPattern = new RegExp(
  `^(?:${configurationRepositoryPrefix}/jobs/${configurationIdSegment}/scheduling|${reviewRunRequestPath}/scheduling|/api/v1/operator/scheduling/jobs/${configurationIdSegment})$`,
  "u",
);
const reviewRunFilterIdPattern = new RegExp(`^${configurationIdSegment}$`, "u");
const schedulingPolicyDirectReadPattern = new RegExp(
  `^(?:/api/v1/operator/scheduling(?:/activity/${configurationIdSegment})?|${configurationRepositoryPrefix}/scheduling)$`,
  "u",
);
const publicationPolicyPathPattern = new RegExp(
  `^${configurationRepositoryPrefix}/publication-policy$`,
  "u",
);
const publicationPreviewPathPattern = new RegExp(`^${reviewRunPath}/publications/preview$`, "u");
const publicationListPathPattern = new RegExp(
  `^${configurationRepositoryPrefix}/publications$`,
  "u",
);
const publicationPagePathPattern = new RegExp(
  `^${configurationRepositoryPrefix}/(?:publication-policy/activity|publications/${configurationIdSegment}/attempts)$`,
  "u",
);
const publicationDirectReadPattern = new RegExp(
  `^${configurationRepositoryPrefix}/(?:publication-policy(?:/activity/${configurationIdSegment})?|publications/${configurationIdSegment})$`,
  "u",
);
const publicationPostPathPattern = new RegExp(
  `^(?:${reviewRunPath}/publications|${configurationRepositoryPrefix}/publications/${configurationIdSegment}/(?:cancel|retry|reconcile))$`,
  "u",
);
const notificationListPathPattern = new RegExp(
  `^${configurationRepositoryPrefix}/notifications$`,
  "u",
);
const notificationStatePathPattern = new RegExp(
  `^${configurationRepositoryPrefix}/notifications/state$`,
  "u",
);
const isCanonicalNotificationRead = (path: string): boolean => {
  if (path === "/api/v1/operator/notifications/summary") return true;
  const queryIndex = path.indexOf("?");
  if (queryIndex === -1) return false;
  const pathname = path.slice(0, queryIndex),
    query = path.slice(queryIndex + 1);
  const parameters = new URLSearchParams(query);
  if (parameters.toString() !== query) return false;
  const keys = [...parameters.keys()].join(",");
  const validNumber = (key: string, maximum: number) => {
    const value = parameters.get(key);
    return (
      Number.isSafeInteger(Number(value)) &&
      Number(value) >= 1 &&
      Number(value) <= maximum &&
      String(Number(value)) === value
    );
  };
  if (pathname === "/api/v1/operator/notifications/summary")
    return (
      keys === "repositoryId" &&
      reviewRunFilterIdPattern.test(parameters.get("repositoryId") ?? "") &&
      !/[\r\n]/u.test(parameters.get("repositoryId") ?? "")
    );
  if (pathname === "/api/v1/operator/notifications/overview")
    return (
      keys === "page,pageSize" && validNumber("page", 10_000_000) && validNumber("pageSize", 50)
    );
  if (
    !notificationListPathPattern.test(pathname) ||
    !["limit,state,workItemKind", "limit,state,workItemKind,cursor"].includes(keys)
  )
    return false;
  return (
    validNumber("limit", 50) &&
    ["all", "unread", "read", "archived"].includes(parameters.get("state") ?? "") &&
    ["all", "pull_request", "issue"].includes(parameters.get("workItemKind") ?? "") &&
    (!parameters.has("cursor") || validNumber("cursor", Number.MAX_SAFE_INTEGER))
  );
};

const isCanonicalPublicationRead = (path: string): boolean => {
  const queryIndex = path.indexOf("?");
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  if (queryIndex === -1)
    return (
      publicationDirectReadPattern.test(pathname) ||
      publicationListPathPattern.test(pathname) ||
      publicationPagePathPattern.test(pathname)
    );
  const query = path.slice(queryIndex + 1);
  const parameters = new URLSearchParams(query);
  if (parameters.toString() !== query) return false;
  const keys = [...parameters.keys()].join(",");
  if (publicationPreviewPathPattern.test(pathname))
    return (
      keys === "decisionId" && reviewRunFilterIdPattern.test(parameters.get("decisionId") ?? "")
    );
  const listing = publicationListPathPattern.test(pathname);
  if (!listing && !publicationPagePathPattern.test(pathname)) return false;
  if (
    !(
      listing
        ? [
            "page,pageSize",
            "page,pageSize,reviewRunId",
            "page,pageSize,status",
            "page,pageSize,reviewRunId,status",
          ]
        : ["page,pageSize"]
    ).includes(keys)
  )
    return false;
  for (const [name, maximum] of [
    ["page", 10_000_000],
    ["pageSize", 50],
  ] as const) {
    const value = parameters.get(name);
    if (
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < 1 ||
      Number(value) > maximum ||
      String(Number(value)) !== value
    )
      return false;
  }
  const run = parameters.get("reviewRunId"),
    status = parameters.get("status");
  return (
    (run === null || reviewRunFilterIdPattern.test(run)) &&
    (status === null ||
      ["pending", "delivering", "published", "failed", "blocked", "unknown", "cancelled"].includes(
        status,
      ))
  );
};

const isCanonicalSchedulingPolicyRead = (path: string): boolean => {
  if (schedulingPolicyDirectReadPattern.test(path)) return true;
  const queryIndex = path.indexOf("?");
  if (queryIndex === -1 || path.slice(0, queryIndex) !== "/api/v1/operator/scheduling/activity")
    return false;
  const query = path.slice(queryIndex + 1);
  const parameters = new URLSearchParams(query);
  if (parameters.toString() !== query || [...parameters.keys()].join(",") !== "page,pageSize")
    return false;
  const page = parameters.get("page");
  const size = parameters.get("pageSize");
  return (
    Number.isSafeInteger(Number(page)) &&
    Number(page) >= 1 &&
    Number(page) <= 10_000_000 &&
    String(Number(page)) === page &&
    Number.isSafeInteger(Number(size)) &&
    Number(size) >= 1 &&
    Number(size) <= 20 &&
    String(Number(size)) === size
  );
};

export type DashboardFetch = typeof globalThis.fetch;

export interface DashboardHttpClientOptions {
  readonly fetch?: DashboardFetch;
  readonly timeoutMs?: number;
}

export interface DashboardGetOptions {
  readonly signal?: AbortSignal;
  readonly maxResponseBytes?: number;
}

interface ServerErrorBody {
  readonly code?: string;
  readonly message?: string;
  readonly retryable?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeDiagnostic = (value: unknown): string | undefined =>
  typeof value === "string" &&
  canonicalDiagnosticPattern.test(value) &&
  !workerTokenExposurePattern.test(value)
    ? value
    : undefined;

const safeServerMessage = (value: unknown): string | undefined =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 2_048 &&
  ![...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  }) &&
  !workerTokenExposurePattern.test(value)
    ? value
    : undefined;

const parseServerError = (body: string): ServerErrorBody => {
  if (body === "") {
    return {};
  }

  try {
    const value: unknown = JSON.parse(body);
    if (!isRecord(value)) {
      return {};
    }
    const code = safeDiagnostic(value.code);
    const message = safeServerMessage(value.message);
    return {
      ...(code === undefined ? {} : { code }),
      ...(message === undefined ? {} : { message }),
      ...(typeof value.retryable === "boolean" ? { retryable: value.retryable } : {}),
    };
  } catch {
    return {};
  }
};

const isCanonicalDashboardRead = (path: string): boolean => {
  const queryIndex = path.indexOf("?");
  if (queryIndex !== -1 && path.indexOf("?", queryIndex + 1) !== -1) {
    return false;
  }
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  if (dashboardJobByIdPathPattern.test(pathname)) {
    return queryIndex === -1;
  }
  if (!dashboardReadPathnames.has(pathname)) {
    return false;
  }
  if (queryIndex === -1) {
    return true;
  }
  const query = path.slice(queryIndex + 1);
  return query.length > 0 && new URLSearchParams(query).toString() === query;
};

const isCanonicalWorkerCredentialList = (path: string): boolean => {
  const prefix = `${OPERATOR_WORKER_NODES_PATH}?`;
  if (!path.startsWith(prefix)) {
    return false;
  }
  const query = path.slice(prefix.length);
  const parameters = new URLSearchParams(query);
  if (
    parameters.toString() !== query ||
    [...parameters.keys()].join(",") !== "page,pageSize,sort"
  ) {
    return false;
  }
  const page = parameters.get("page");
  const pageSize = parameters.get("pageSize");
  const sort = parameters.get("sort");
  if (page === null || pageSize === null || sort !== "identity" || !/^[1-9][0-9]*$/u.test(page)) {
    return false;
  }
  const pageNumber = Number(page);
  const pageSizeNumber = Number(pageSize);
  return (
    Number.isSafeInteger(pageNumber) &&
    pageNumber >= 1 &&
    Number.isSafeInteger(pageSizeNumber) &&
    pageSizeNumber >= 1 &&
    pageSizeNumber <= 200 &&
    String(pageNumber) === page &&
    String(pageSizeNumber) === pageSize
  );
};

const isCanonicalRepositoryList = (path: string): boolean => {
  const prefix = `${OPERATOR_REPOSITORIES_PATH}?`;
  if (!path.startsWith(prefix)) return false;
  const query = path.slice(prefix.length);
  const parameters = new URLSearchParams(query);
  if (
    parameters.toString() !== query ||
    [...parameters.keys()].join(",") !== "page,pageSize,search"
  )
    return false;
  const page = parameters.get("page");
  const pageSize = parameters.get("pageSize");
  const search = parameters.get("search");
  const pageNumber = Number(page);
  const pageSizeNumber = Number(pageSize);
  return (
    Number.isSafeInteger(pageNumber) &&
    pageNumber >= 1 &&
    String(pageNumber) === page &&
    Number.isSafeInteger(pageSizeNumber) &&
    pageSizeNumber >= 1 &&
    pageSizeNumber <= 50 &&
    String(pageSizeNumber) === pageSize &&
    Number.isSafeInteger((pageNumber - 1) * pageSizeNumber) &&
    search !== null &&
    search.length <= 512
  );
};

const isCanonicalConfigurationRead = (path: string): boolean => {
  if (configurationDirectReadPattern.test(path)) return true;
  const queryIndex = path.indexOf("?");
  if (queryIndex === -1) return false;
  const pathname = path.slice(0, queryIndex);
  const isPromptList = pathname === configurationPromptPrefix;
  if (!isPromptList && !configurationPagePathPattern.test(pathname)) return false;
  const query = path.slice(queryIndex + 1);
  const parameters = new URLSearchParams(query);
  const keys = [...parameters.keys()].join(",");
  if (
    parameters.toString() !== query ||
    (keys !== "page,pageSize" && !(isPromptList && keys === "page,pageSize,workflowKind"))
  )
    return false;
  const page = parameters.get("page");
  const pageSize = parameters.get("pageSize");
  const workflow = parameters.get("workflowKind");
  const pageNumber = Number(page);
  const pageSizeNumber = Number(pageSize);
  return (
    Number.isSafeInteger(pageNumber) &&
    pageNumber >= 1 &&
    String(pageNumber) === page &&
    Number.isSafeInteger(pageSizeNumber) &&
    pageSizeNumber >= 1 &&
    pageSizeNumber <= 50 &&
    String(pageSizeNumber) === pageSize &&
    Number.isSafeInteger((pageNumber - 1) * pageSizeNumber) &&
    (workflow === null ||
      ["pr_static_build", "pr_ui", "issue_triage", "issue_validation"].includes(workflow))
  );
};

const isCanonicalAccessRead = (path: string): boolean => {
  if (path === OPERATOR_ACCESS_PATH) return true;
  const queryIndex = path.indexOf("?");
  if (queryIndex === -1) return false;
  const pathname = path.slice(0, queryIndex);
  const query = path.slice(queryIndex + 1);
  const parameters = new URLSearchParams(query);
  if (parameters.toString() !== query) return false;
  const keys = [...parameters.keys()].join(",");
  if (pathname === OPERATOR_ACCESS_PATH) {
    return (
      keys === "repositoryId" && reviewRunFilterIdPattern.test(parameters.get("repositoryId") ?? "")
    );
  }
  if (!repositoryAccessListPathPattern.test(pathname) || keys !== "page,pageSize") return false;
  const page = parameters.get("page");
  const pageSize = parameters.get("pageSize");
  const pageNumber = Number(page);
  const pageSizeNumber = Number(pageSize);
  return (
    Number.isSafeInteger(pageNumber) &&
    pageNumber >= 1 &&
    String(pageNumber) === page &&
    Number.isSafeInteger(pageSizeNumber) &&
    pageSizeNumber >= 1 &&
    pageSizeNumber <= 50 &&
    String(pageSizeNumber) === pageSize &&
    Number.isSafeInteger((pageNumber - 1) * pageSizeNumber)
  );
};

const isCanonicalConfigurationAuditRead = (path: string): boolean => {
  if (configurationAuditDetailPattern.test(path)) return true;
  const queryIndex = path.indexOf("?");
  if (queryIndex === -1) return false;
  const pathname = path.slice(0, queryIndex);
  const global = pathname === globalConfigurationAuditPrefix;
  if (!global && !repositoryConfigurationAuditPagePattern.test(pathname)) return false;
  const query = path.slice(queryIndex + 1);
  const parameters = new URLSearchParams(query);
  const keys = [...parameters.keys()].join(",");
  if (
    parameters.toString() !== query ||
    (keys !== "page,pageSize" && !(global && keys === "page,pageSize,templateId"))
  )
    return false;
  const page = parameters.get("page");
  const size = parameters.get("pageSize");
  const templateId = parameters.get("templateId");
  return (
    Number.isSafeInteger(Number(page)) &&
    Number(page) >= 1 &&
    Number(page) <= 10_000_000 &&
    String(Number(page)) === page &&
    Number.isSafeInteger(Number(size)) &&
    Number(size) >= 1 &&
    Number(size) <= 20 &&
    String(Number(size)) === size &&
    (templateId === null ||
      (reviewRunFilterIdPattern.test(templateId) && !/[\r\n]/u.test(templateId)))
  );
};

const isCanonicalReviewRunRead = (path: string): boolean => {
  if (reviewRunDirectReadPattern.test(path) || reviewRunReproductionCasePathPattern.test(path))
    return true;
  const queryIndex = path.indexOf("?");
  if (queryIndex === -1) return false;
  const pathname = path.slice(0, queryIndex);
  if (reviewRunReproductionCasePathPattern.test(pathname)) {
    const query = path.slice(queryIndex + 1);
    const parameters = new URLSearchParams(query);
    return (
      parameters.toString() === query &&
      [...parameters.keys()].join(",") === "jobId" &&
      reviewRunFilterIdPattern.test(parameters.get("jobId") ?? "") &&
      !/[\r\n]/u.test(parameters.get("jobId") ?? "")
    );
  }
  const isRunList = reviewRunListPathPattern.test(pathname);
  if (!isRunList && !reviewRunJobListPathPattern.test(pathname)) return false;
  const query = path.slice(queryIndex + 1);
  const parameters = new URLSearchParams(query);
  const keys = [...parameters.keys()].join(",");
  if (
    parameters.toString() !== query ||
    (keys !== "page,pageSize" &&
      !(isRunList && keys === "page,pageSize,workItemId") &&
      !(!isRunList && keys === "page,pageSize,jobId"))
  )
    return false;
  const page = parameters.get("page");
  const pageSize = parameters.get("pageSize");
  const pageNumber = Number(page);
  const pageSizeNumber = Number(pageSize);
  const workItemId = parameters.get("workItemId");
  const jobId = parameters.get("jobId");
  return (
    Number.isSafeInteger(pageNumber) &&
    pageNumber >= 1 &&
    String(pageNumber) === page &&
    Number.isSafeInteger(pageSizeNumber) &&
    pageSizeNumber >= 1 &&
    pageSizeNumber <= 50 &&
    String(pageSizeNumber) === pageSize &&
    Number.isSafeInteger((pageNumber - 1) * pageSizeNumber) &&
    (workItemId === null ||
      (reviewRunFilterIdPattern.test(workItemId) && !/[\r\n]/u.test(workItemId))) &&
    (jobId === null || (reviewRunFilterIdPattern.test(jobId) && !/[\r\n]/u.test(jobId)))
  );
};

const isCanonicalDecisionRead = (path: string): boolean => {
  if (reviewRunDecisionPathPattern.test(path)) return true;
  const queryIndex = path.indexOf("?");
  if (queryIndex === -1 || !reviewRunDecisionHistoryPathPattern.test(path.slice(0, queryIndex)))
    return false;
  const query = path.slice(queryIndex + 1);
  const parameters = new URLSearchParams(query);
  if (parameters.toString() !== query || [...parameters.keys()].join(",") !== "page,pageSize")
    return false;
  const page = parameters.get("page");
  const pageSize = parameters.get("pageSize");
  const pageNumber = Number(page);
  const pageSizeNumber = Number(pageSize);
  return (
    Number.isSafeInteger(pageNumber) &&
    pageNumber >= 1 &&
    String(pageNumber) === page &&
    Number.isSafeInteger(pageSizeNumber) &&
    pageSizeNumber >= 1 &&
    pageSizeNumber <= 20 &&
    String(pageSizeNumber) === pageSize &&
    Number.isSafeInteger((pageNumber - 1) * pageSizeNumber)
  );
};

const isCanonicalFindingRead = (path: string): boolean => {
  const queryIndex = path.indexOf("?");
  if (queryIndex === -1) return false;
  const pathname = path.slice(0, queryIndex);
  const comparison = findingComparisonPathPattern.test(pathname);
  if (!comparison && !findingReadPathPattern.test(pathname)) return false;
  const query = path.slice(queryIndex + 1);
  const parameters = new URLSearchParams(query);
  const expectedKeys = comparison
    ? "beforeReviewRunId,beforeRequestId,beforeJobId,page,pageSize"
    : "page,pageSize";
  if (parameters.toString() !== query || [...parameters.keys()].join(",") !== expectedKeys)
    return false;
  if (
    comparison &&
    ["beforeReviewRunId", "beforeRequestId", "beforeJobId"].some(
      (key) =>
        !reviewRunFilterIdPattern.test(parameters.get(key) ?? "") ||
        /[\r\n]/u.test(parameters.get(key) ?? ""),
    )
  )
    return false;
  const page = parameters.get("page");
  const size = parameters.get("pageSize");
  return (
    Number.isSafeInteger(Number(page)) &&
    Number(page) >= 1 &&
    String(Number(page)) === page &&
    Number.isSafeInteger(Number(size)) &&
    Number(size) >= 1 &&
    Number(size) <= 20 &&
    String(Number(size)) === size &&
    Number.isSafeInteger((Number(page) - 1) * Number(size))
  );
};

const isCanonicalModelRuntimeRead = (path: string): boolean => {
  if (modelRuntimeDetailPattern.test(path)) return true;
  const index = path.indexOf("?");
  if (index === -1) return false;
  const pathname = path.slice(0, index);
  const listing = pathname === modelRuntimePrefix;
  if (
    !listing &&
    !modelRuntimeHistoryPattern.test(pathname) &&
    !evaluationModelRuntimeOptionsPattern.test(pathname)
  )
    return false;
  const query = path.slice(index + 1),
    parameters = new URLSearchParams(query);
  const keys = [...parameters.keys()].join(",");
  if (
    parameters.toString() !== query ||
    (keys !== "page,pageSize" && !(listing && keys === "page,pageSize,enabled"))
  )
    return false;
  const page = Number(parameters.get("page")),
    size = Number(parameters.get("pageSize"));
  return (
    Number.isSafeInteger(page) &&
    page >= 1 &&
    String(page) === parameters.get("page") &&
    Number.isSafeInteger(size) &&
    size >= 1 &&
    size <= 50 &&
    String(size) === parameters.get("pageSize") &&
    Number.isSafeInteger((page - 1) * size) &&
    (!parameters.has("enabled") || ["true", "false"].includes(parameters.get("enabled") ?? ""))
  );
};

const isCanonicalEvaluationBatchRead = (path: string): boolean => {
  if (
    evaluationBatchReadPathPattern.test(path) ||
    evaluationBatchListPathPattern.test(path) ||
    evaluationCellResultPathPattern.test(path) ||
    evaluationReproductionDocumentPathPattern.test(path) ||
    evaluationReproductionPlanPathPattern.test(path) ||
    evaluationEvidenceJsonPathPattern.test(path)
  )
    return true;
  const index = path.indexOf("?");
  if (index === -1) return false;
  const pathname = path.slice(0, index);
  const options = evaluationPromptOptionsPathPattern.test(pathname);
  if (!options && !evaluationBatchListPathPattern.test(pathname)) return false;
  const query = path.slice(index + 1),
    parameters = new URLSearchParams(query);
  const keys = [...parameters.keys()].join(",");
  if (
    parameters.toString() !== query ||
    (options
      ? keys !== "page,pageSize,workflowKind"
      : ![
          "page,pageSize",
          "page,pageSize,suiteId",
          "page,pageSize,workflowKind",
          "page,pageSize,suiteId,workflowKind",
        ].includes(keys))
  )
    return false;
  const page = Number(parameters.get("page")),
    pageSize = Number(parameters.get("pageSize"));
  const suiteId = parameters.get("suiteId"),
    workflow = parameters.get("workflowKind");
  return (
    Number.isSafeInteger(page) &&
    page >= 1 &&
    String(page) === parameters.get("page") &&
    Number.isSafeInteger(pageSize) &&
    pageSize >= 1 &&
    pageSize <= 50 &&
    String(pageSize) === parameters.get("pageSize") &&
    Number.isSafeInteger((page - 1) * pageSize) &&
    (suiteId === null || (reviewRunFilterIdPattern.test(suiteId) && !/[\r\n]/u.test(suiteId))) &&
    (workflow === null || (evaluationWorkflowPattern.test(workflow) && !/[\r\n]/u.test(workflow)))
  );
};

const isCanonicalEvaluationModelInvocationRead = (path: string): boolean => {
  const index = path.indexOf("?");
  if (index === -1 || !evaluationModelInvocationListPathPattern.test(path.slice(0, index)))
    return false;
  const query = path.slice(index + 1);
  const parameters = new URLSearchParams(query);
  if (parameters.toString() !== query || [...parameters.keys()].join(",") !== "page,pageSize")
    return false;
  const page = Number(parameters.get("page"));
  const pageSize = Number(parameters.get("pageSize"));
  return (
    Number.isSafeInteger(page) &&
    page >= 1 &&
    String(page) === parameters.get("page") &&
    Number.isSafeInteger(pageSize) &&
    pageSize >= 1 &&
    pageSize <= 10 &&
    String(pageSize) === parameters.get("pageSize") &&
    Number.isSafeInteger((page - 1) * pageSize)
  );
};

const isCanonicalEvaluationAdjudicationRead = (path: string): boolean => {
  if (evaluationAdjudicationContextPathPattern.test(path)) return true;
  const index = path.indexOf("?");
  if (index === -1 || !evaluationAdjudicationHistoryPathPattern.test(path.slice(0, index)))
    return false;
  const query = path.slice(index + 1);
  const parameters = new URLSearchParams(query);
  if (parameters.toString() !== query || [...parameters.keys()].join(",") !== "page,pageSize")
    return false;
  const page = Number(parameters.get("page"));
  const pageSize = Number(parameters.get("pageSize"));
  return (
    Number.isSafeInteger(page) &&
    page >= 1 &&
    String(page) === parameters.get("page") &&
    Number.isSafeInteger(pageSize) &&
    pageSize >= 1 &&
    pageSize <= 50 &&
    String(pageSize) === parameters.get("pageSize") &&
    Number.isSafeInteger((page - 1) * pageSize)
  );
};

const isCanonicalEvaluationAssessmentRead = (path: string): boolean => {
  if (
    evaluationAssessmentReadPathPattern.test(path) ||
    evaluationAssessmentListPathPattern.test(path)
  )
    return true;
  const index = path.indexOf("?");
  if (index === -1 || !evaluationAssessmentListPathPattern.test(path.slice(0, index))) return false;
  const query = path.slice(index + 1);
  const parameters = new URLSearchParams(query);
  if (parameters.toString() !== query || [...parameters.keys()].join(",") !== "page,pageSize")
    return false;
  const page = Number(parameters.get("page"));
  const pageSize = Number(parameters.get("pageSize"));
  return (
    Number.isSafeInteger(page) &&
    page >= 1 &&
    String(page) === parameters.get("page") &&
    Number.isSafeInteger(pageSize) &&
    pageSize >= 1 &&
    pageSize <= 50 &&
    String(pageSize) === parameters.get("pageSize") &&
    Number.isSafeInteger((page - 1) * pageSize)
  );
};

const isCanonicalEvaluationRead = (path: string): boolean => {
  const index = path.indexOf("?");
  const pathname = index === -1 ? path : path.slice(0, index);
  if (index === -1)
    return (
      evaluationPagedPathPattern.test(pathname) ||
      evaluationDetailPathPattern.test(pathname) ||
      evaluationDirectReadPathPattern.test(pathname)
    );
  if (!evaluationPagedPathPattern.test(pathname)) return false;
  const query = path.slice(index + 1),
    parameters = new URLSearchParams(query);
  if (parameters.toString() !== query || [...parameters.keys()].join(",") !== "page,pageSize")
    return false;
  const page = Number(parameters.get("page")),
    pageSize = Number(parameters.get("pageSize"));
  return (
    Number.isSafeInteger(page) &&
    page >= 1 &&
    String(page) === parameters.get("page") &&
    Number.isSafeInteger(pageSize) &&
    pageSize >= 1 &&
    pageSize <= 50 &&
    String(pageSize) === parameters.get("pageSize") &&
    Number.isSafeInteger((page - 1) * pageSize)
  );
};

const ensureControlPath = (path: string, method: DashboardHttpMethod): void => {
  const queryIndex = path.indexOf("?");
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const hasUnsafeSyntax =
    !canonicalRawPathPattern.test(path) ||
    path.includes("\\") ||
    path.includes("#") ||
    pathname.includes("%") ||
    pathname.split("/").some((segment) => segment === "." || segment === "..");
  if (hasUnsafeSyntax) {
    throw new Error("The dashboard request path is outside its allowlisted control-plane API.");
  }

  const isDashboardRead = method === "GET" && isCanonicalDashboardRead(path);
  const isWorkerCredentialList = method === "GET" && isCanonicalWorkerCredentialList(path);
  const isWorkerCredentialCreate = method === "POST" && path === OPERATOR_WORKER_NODES_PATH;
  const isWorkerCredentialMutation =
    method === "POST" && workerCredentialMutationPathPattern.test(path);
  const isRepositoryRead =
    method === "GET" && (isCanonicalRepositoryList(path) || repositoryByIdPathPattern.test(path));
  const isRepositoryCreateOrResolve =
    method === "POST" &&
    (path === OPERATOR_REPOSITORIES_PATH || path === `${OPERATOR_REPOSITORIES_PATH}/resolve`);
  const isRepositoryUpdate = method === "PATCH" && repositoryByIdPathPattern.test(path);
  const isRepositoryConnectionCheck =
    method === "POST" && repositoryConnectionPathPattern.test(path);
  const isConfigurationOperation =
    (method === "GET" &&
      (isCanonicalConfigurationRead(path) || isCanonicalConfigurationAuditRead(path))) ||
    (method === "POST" && configurationPostPathPattern.test(path)) ||
    (method === "PATCH" && configurationDraftPathPattern.test(path)) ||
    (method === "PUT" && configurationBindingPathPattern.test(path));
  const isReviewRunOperation =
    (method === "GET" &&
      (isCanonicalReviewRunRead(path) || reviewRunEvidenceReadPattern.test(path))) ||
    (method === "POST" &&
      (reviewRunCreatePathPattern.test(path) || reviewRunActionPathPattern.test(path)));
  const isAccessOperation =
    (method === "GET" && isCanonicalAccessRead(path)) ||
    (method === "POST" && repositoryAccessPathPattern.test(path));
  const isDecisionOperation =
    (method === "GET" && isCanonicalDecisionRead(path)) ||
    (method === "POST" && reviewRunDecisionPathPattern.test(path));
  const isFindingOperation =
    (method === "GET" && isCanonicalFindingRead(path)) ||
    (method === "POST" && findingChangePathPattern.test(path));
  const isSchedulingRead = method === "GET" && schedulingReadPathPattern.test(path);
  const isSchedulingPolicyOperation =
    (method === "GET" && isCanonicalSchedulingPolicyRead(path)) ||
    (method === "PATCH" && path === "/api/v1/operator/scheduling");
  const isPublicationOperation =
    (method === "GET" && isCanonicalPublicationRead(path)) ||
    (method === "PATCH" && publicationPolicyPathPattern.test(path)) ||
    (method === "POST" && publicationPostPathPattern.test(path));
  const isNotificationOperation =
    (method === "GET" && isCanonicalNotificationRead(path)) ||
    (method === "GET" && isCanonicalModelRuntimeRead(path)) ||
    (method === "POST" && path === modelRuntimePrefix) ||
    (method === "PATCH" && modelRuntimeDetailPattern.test(path)) ||
    (method === "POST" && notificationStatePathPattern.test(path));
  const isEvaluationOperation =
    (method === "GET" &&
      (isCanonicalEvaluationRead(path) ||
        isCanonicalEvaluationBatchRead(path) ||
        isCanonicalEvaluationModelInvocationRead(path) ||
        isCanonicalEvaluationAdjudicationRead(path) ||
        isCanonicalEvaluationAssessmentRead(path))) ||
    (method === "POST" &&
      (evaluationPostPathPattern.test(path) ||
        evaluationBatchPostPathPattern.test(path) ||
        evaluationReproductionPreviewPathPattern.test(path) ||
        evaluationAssessmentListPathPattern.test(path))) ||
    (method === "PUT" &&
      (evaluationDraftPathPattern.test(path) ||
        evaluationAdjudicationChangePathPattern.test(path)));

  if (
    !isDashboardRead &&
    !isWorkerCredentialList &&
    !isWorkerCredentialCreate &&
    !isWorkerCredentialMutation &&
    !isRepositoryRead &&
    !isRepositoryCreateOrResolve &&
    !isRepositoryUpdate &&
    !isRepositoryConnectionCheck &&
    !isConfigurationOperation &&
    !isReviewRunOperation &&
    !isAccessOperation &&
    !isDecisionOperation &&
    !isFindingOperation &&
    !isSchedulingRead &&
    !isSchedulingPolicyOperation &&
    !isPublicationOperation &&
    !isNotificationOperation &&
    !isEvaluationOperation
  ) {
    throw new Error("The dashboard request path is outside its allowlisted control-plane API.");
  }
};

const decodeUtf8 = (value: ArrayBuffer | Uint8Array, operation: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new ReviewControlProtocolError(
      operation,
      `The ${operation} response was not valid UTF-8.`,
    );
  }
};

const encodeRequestBody = (body: Readonly<Record<string, unknown>>, operation: string): string => {
  let encoded: string;
  try {
    encoded = JSON.stringify(body);
  } catch {
    throw new ReviewControlRequestError(operation, "body", "The request body must be valid JSON.");
  }
  if (
    typeof encoded !== "string" ||
    new TextEncoder().encode(encoded).byteLength > MAX_DASHBOARD_REQUEST_BYTES
  ) {
    throw new ReviewControlRequestError(
      operation,
      "body",
      "The request body exceeds the 2 MiB UTF-8 limit.",
    );
  }
  return encoded;
};

const readBody = async (
  response: Response,
  operation: string,
  controller: AbortController,
  maximumBytes: number,
): Promise<string> => {
  controller.signal.throwIfAborted();
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(length) && length > maximumBytes) {
      controller.abort();
      throw new ReviewControlResponseTooLargeError(operation, maximumBytes);
    }
  }

  if (response.body === null) {
    const buffer = await response.arrayBuffer();
    controller.signal.throwIfAborted();
    if (buffer.byteLength > maximumBytes) {
      controller.abort();
      throw new ReviewControlResponseTooLargeError(operation, maximumBytes);
    }
    return decodeUtf8(buffer, operation);
  }

  const reader = response.body.getReader();
  const cancelReader = () => void reader.cancel(controller.signal.reason).catch(() => undefined);
  controller.signal.addEventListener("abort", cancelReader, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      controller.signal.throwIfAborted();
      const chunk = await reader.read();
      controller.signal.throwIfAborted();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > maximumBytes) {
        controller.abort();
        throw new ReviewControlResponseTooLargeError(operation, maximumBytes);
      }
      chunks.push(chunk.value);
    }
  } finally {
    controller.signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return decodeUtf8(body, operation);
};

export class DashboardHttpClient {
  private readonly fetchImplementation: DashboardFetch;
  private readonly timeoutMs: number;

  constructor(options: DashboardHttpClientOptions = {}) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DASHBOARD_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Dashboard request timeout must be a positive integer.");
    }
  }

  async get(path: string, operation: string, options: DashboardGetOptions = {}): Promise<unknown> {
    return this.request(path, operation, "GET", undefined, options);
  }

  async post(
    path: string,
    operation: string,
    body: Readonly<Record<string, unknown>>,
    options: DashboardGetOptions = {},
  ): Promise<unknown> {
    return this.request(path, operation, "POST", encodeRequestBody(body, operation), options);
  }

  async patch(
    path: string,
    operation: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    return this.request(path, operation, "PATCH", encodeRequestBody(body, operation));
  }

  async put(
    path: string,
    operation: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    return this.request(path, operation, "PUT", encodeRequestBody(body, operation));
  }

  private async request(
    path: string,
    operation: string,
    method: DashboardHttpMethod,
    body?: string,
    options: DashboardGetOptions = {},
  ): Promise<unknown> {
    ensureControlPath(path, method);
    const externalSignal = options.signal;
    externalSignal?.throwIfAborted();
    const endpointLimit =
      method === "GET" && evaluationDetailPathPattern.test(path)
        ? MAX_DASHBOARD_RESPONSE_BYTES + 65_536
        : method === "GET" && evaluationReproductionDocumentPathPattern.test(path)
          ? MAX_DASHBOARD_RESPONSE_BYTES + 40 * 1024
          : MAX_DASHBOARD_RESPONSE_BYTES;
    const maximumBytes = options.maxResponseBytes ?? endpointLimit;
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > endpointLimit)
      throw new ReviewControlRequestError(
        operation,
        "maxResponseBytes",
        "The response byte limit must be a positive integer no greater than the dashboard limit.",
      );
    const controller = new AbortController();
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let externalAbort: (() => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      if (externalSignal === undefined) return;
      externalAbort = () => {
        controller.abort(externalSignal.reason);
        reject(externalSignal.reason);
      };
      externalSignal.addEventListener("abort", externalAbort, { once: true });
    });

    const deadline = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new ReviewControlTimeoutError(operation, this.timeoutMs));
      }, this.timeoutMs);
    });

    const request = this.performRequest(path, operation, method, controller, body, maximumBytes);
    try {
      const value = await Promise.race([request, deadline, cancellation]);
      externalSignal?.throwIfAborted();
      return value;
    } catch (error) {
      if (externalSignal?.aborted) throw externalSignal.reason;
      if (error instanceof ReviewControlError) {
        throw error;
      }
      if (timedOut || controller.signal.aborted) {
        throw new ReviewControlTimeoutError(operation, this.timeoutMs);
      }
      throw new ReviewControlNetworkError(operation);
    } finally {
      if (externalAbort !== undefined) externalSignal?.removeEventListener("abort", externalAbort);
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async performRequest(
    path: string,
    operation: string,
    method: DashboardHttpMethod,
    controller: AbortController,
    requestBody?: string,
    maximumBytes = MAX_DASHBOARD_RESPONSE_BYTES,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImplementation(path, {
        ...(requestBody === undefined ? {} : { body: requestBody }),
        cache: "no-store",
        credentials: "include",
        headers: {
          Accept: "application/json",
          ...(requestBody === undefined ? {} : { "Content-Type": "application/json" }),
        },
        method,
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw error;
      }
      throw new ReviewControlNetworkError(operation);
    }

    controller.signal.throwIfAborted();
    const body = await readBody(response, operation, controller, maximumBytes);
    controller.signal.throwIfAborted();
    if (!response.ok) {
      if (
        response.status === 403 &&
        !path.startsWith(OPERATOR_ACCESS_PATH) &&
        typeof globalThis.dispatchEvent === "function"
      ) {
        globalThis.dispatchEvent(new Event(OPERATOR_ACCESS_DENIED_EVENT));
      }
      const serverError = parseServerError(body);
      const requestId = safeDiagnostic(response.headers.get("x-request-id"));
      const suffix = requestId === undefined ? "" : ` Request ID: ${requestId}.`;
      throw new ReviewControlHttpError(
        `${serverError.message ?? `The control plane returned HTTP ${response.status}.`}${suffix}`,
        {
          operation,
          requestId,
          retryable: serverError.retryable ?? (response.status >= 500 || response.status === 429),
          serverCode: serverError.code,
          status: response.status,
        },
      );
    }

    const contentType = response.headers.get("content-type")?.toLowerCase();
    if (contentType === undefined || !contentType.includes("application/json")) {
      throw new ReviewControlProtocolError(
        operation,
        `The ${operation} response did not declare an application/json content type.`,
      );
    }

    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new ReviewControlProtocolError(
        operation,
        `The ${operation} response did not contain valid JSON.`,
      );
    }
  }
}
