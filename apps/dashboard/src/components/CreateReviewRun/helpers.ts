import {
  type IssueReproductionRequestV1,
  maximumIssueReproductionRequestUtf8Bytes,
  type OperatorReviewRunCreateRequest,
  OperatorReviewRunCreateRequestSchema,
  type RepositoryValidationProfileBinding,
  RepositoryValidationProfileBindingSchema,
  type ValidationProfileVersion,
  ValidationProfileVersionSchema,
  type WorkflowKind,
} from "@agentic-review/contracts";
import { collectProfileBindings } from "../../pages/ValidationProfiles/forms";
import type { ConfigurationAdapter } from "../../services/configuration/adapter";
import { validateRequest, validateResponse } from "../../services/configuration/validation";
import { ReviewControlHttpError } from "../../services/review-control/errors";
import type { WorkItem, WorkItemKind } from "../../services/review-control/types";
import { validateAndCanonicalizeReproduction } from "./reproduction";

export const maximumRunProfileCount = 32;
export const exactCommitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})(?![\s\S])/u;
const revisionKeyPattern = /^[a-f0-9]{64}(?![\s\S])/u;

export type RunWorkItem = WorkItem;

export interface RunProfileOption {
  readonly binding: RepositoryValidationProfileBinding;
  readonly version: ValidationProfileVersion;
}

const workflows: Record<WorkItemKind, readonly WorkflowKind[]> = {
  pull_request: ["pr_static_build", "pr_ui"],
  issue: ["issue_triage", "issue_validation"],
};

export interface RunCreationNotice {
  readonly title: string;
  readonly description: string;
}

export function runCreationPrerequisite(item: RunWorkItem): RunCreationNotice | null {
  const instruction =
    item.kind === "pull_request"
      ? "Ask an authorized maintainer to request a review from the configured reviewer on GitHub, then refresh this pull request."
      : "Ask an authorized maintainer to assign this issue to the configured reviewer on GitHub, then refresh this issue.";
  if (item.state === "closed") {
    return {
      title: "This work item is closed",
      description: `Reopen it on GitHub before creating a review run. ${instruction}`,
    };
  }
  if (
    !item.activeRequestEpoch ||
    item.activeRequestEpoch.status !== "active" ||
    item.activeRequestEpoch.closedAt !== null
  ) {
    return { title: "An authorized GitHub request is required", description: instruction };
  }
  if (!item.revisionKey || !revisionKeyPattern.test(item.revisionKey)) {
    return {
      title: "The current revision is unavailable",
      description:
        "Refresh this work item before creating a review run. A commit SHA cannot replace its review revision key.",
    };
  }
  if (item.kind === "pull_request" && (!item.headSha || !exactCommitPattern.test(item.headSha))) {
    return {
      title: "The pull request head commit is unavailable",
      description:
        "Refresh this pull request to inspect the exact head commit before creating a review run.",
    };
  }
  return null;
}

export async function loadRunProfiles(
  adapter: Pick<ConfigurationAdapter, "listProfileBindings" | "getProfileVersion">,
  repositoryId: string,
  kind: WorkItemKind,
): Promise<RunProfileOption[]> {
  const bindings = await collectProfileBindings(repositoryId, (id, query) =>
    adapter.listProfileBindings(id, query),
  );
  const enabled = bindings.filter((binding) => {
    validateResponse(
      RepositoryValidationProfileBindingSchema,
      binding,
      "load review run profile binding",
      { repositoryId },
    );
    return binding.enabled;
  });
  const options: RunProfileOption[] = [];
  for (let offset = 0; offset < enabled.length; offset += 8) {
    const batch = await Promise.all(
      enabled.slice(offset, offset + 8).map(async (binding): Promise<RunProfileOption> => {
        const version = validateResponse(
          ValidationProfileVersionSchema,
          await adapter.getProfileVersion(
            repositoryId,
            binding.profileId,
            binding.profileVersionId,
          ),
          "load bound review run profile version",
          { repositoryId, profileId: binding.profileId, id: binding.profileVersionId },
        );
        return { binding, version };
      }),
    );
    options.push(
      ...batch.filter((option) => workflows[kind].includes(option.version.workflowKind)),
    );
  }
  if (options.filter((option) => option.version.required).length > maximumRunProfileCount) {
    throw new Error(
      "More than 32 required profiles are enabled for this workflow. Update the repository bindings before creating a run.",
    );
  }
  return options;
}

export function selectRunProfiles(
  profiles: readonly RunProfileOption[],
  requested: readonly string[],
): string[] {
  const known = new Set(profiles.map((option) => option.version.profileId));
  const required = profiles
    .filter((option) => option.version.required)
    .map((option) => option.version.profileId);
  const selected = [...new Set([...required, ...requested.filter((id) => known.has(id))])];
  if (selected.length > maximumRunProfileCount) {
    throw new Error("Select at most 32 profiles for one review run.");
  }
  return selected.sort();
}

export function initialRunProfileSelection(profiles: readonly RunProfileOption[]): string[] {
  return selectRunProfiles(
    profiles,
    profiles.length <= maximumRunProfileCount
      ? profiles.map((option) => option.version.profileId)
      : [],
  );
}

export function needsTestedSourceCommit(
  kind: WorkItemKind,
  profiles: readonly RunProfileOption[],
  selected: readonly string[],
): boolean {
  return (
    kind === "issue" &&
    profiles.some(
      (option) =>
        selected.includes(option.version.profileId) &&
        option.version.workflowKind === "issue_validation",
    )
  );
}

export interface RunCreationDraft {
  readonly workItem: RunWorkItem;
  readonly profiles: readonly RunProfileOption[];
  readonly selectedProfileIds: readonly string[];
  readonly testedSourceCommit: string;
  readonly sourceExecutionAuthorized: boolean;
  readonly reproduction?: IssueReproductionRequestV1;
}

function checkedRunInput(
  draft: RunCreationDraft,
): Omit<OperatorReviewRunCreateRequest, "activationId"> {
  const { workItem, profiles, selectedProfileIds, testedSourceCommit, sourceExecutionAuthorized } =
    draft;
  const prerequisite = runCreationPrerequisite(workItem);
  if (prerequisite) throw new Error(`${prerequisite.title}. ${prerequisite.description}`);
  const identifiers = new Set<string>();
  for (const option of profiles) {
    validateResponse(
      RepositoryValidationProfileBindingSchema,
      option.binding,
      "review run binding",
      {
        repositoryId: workItem.repositoryId,
        enabled: true,
      },
    );
    validateResponse(ValidationProfileVersionSchema, option.version, "review run profile", {
      repositoryId: workItem.repositoryId,
      profileId: option.binding.profileId,
      id: option.binding.profileVersionId,
    });
    if (
      identifiers.has(option.version.profileId) ||
      !workflows[workItem.kind].includes(option.version.workflowKind)
    ) {
      throw new Error("The selected profile list is inconsistent. Reload the repository bindings.");
    }
    identifiers.add(option.version.profileId);
  }
  if (selectedProfileIds.some((id) => !identifiers.has(id))) {
    throw new Error("A selected profile is no longer available. Reload the repository bindings.");
  }
  const selected = selectRunProfiles(profiles, selectedProfileIds);
  if (selected.length === 0) throw new Error("Select at least one enabled profile.");
  const needsSource = needsTestedSourceCommit(workItem.kind, profiles, selected);
  if (needsSource && !exactCommitPattern.test(testedSourceCommit)) {
    throw new Error(
      "Enter the exact 40- or 64-character lowercase commit SHA for issue validation.",
    );
  }
  if (needsSource && !sourceExecutionAuthorized) {
    throw new Error(
      "Confirm that this operation authorizes execution of code at the specified commit.",
    );
  }
  if (draft.reproduction !== undefined && (workItem.kind !== "issue" || !needsSource)) {
    throw new Error(
      "Reproduction definitions require an Issue validation run with an authorized source commit.",
    );
  }
  return {
    expectedRevisionKey: workItem.revisionKey,
    profileIds: selected,
    ...(needsSource ? { testedSourceCommit } : {}),
    ...(draft.reproduction === undefined
      ? {}
      : {
          reproduction: validateAndCanonicalizeReproduction(draft.reproduction, profiles, selected),
        }),
  };
}

export function createRunIntentRegistry(generateId: () => string = () => crypto.randomUUID()) {
  const intents = new Map<string, OperatorReviewRunCreateRequest>();
  return {
    prepare(draft: RunCreationDraft): OperatorReviewRunCreateRequest {
      const input = checkedRunInput(draft);
      const key = JSON.stringify([draft.workItem.repositoryId, draft.workItem.id, input]);
      const existing = intents.get(key);
      if (existing) return existing;
      const request = validateRequest(
        OperatorReviewRunCreateRequestSchema,
        { activationId: generateId(), ...input },
        "create review run",
      );
      if (
        new TextEncoder().encode(JSON.stringify(request)).byteLength >
        maximumIssueReproductionRequestUtf8Bytes
      ) {
        throw new Error(
          "The complete review run request exceeds the 2 MiB UTF-8 limit. Reduce the reproduction cases or observation text.",
        );
      }
      freezeRequestSnapshot(request);
      intents.set(key, request);
      return request;
    },
  };
}

function freezeRequestSnapshot(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const entry of Object.values(value)) freezeRequestSnapshot(entry);
  Object.freeze(value);
}

export function runCreationError(error: unknown): RunCreationNotice {
  const message =
    error instanceof Error ? error.message : "The request could not be completed. Try again.";
  if (error instanceof ReviewControlHttpError) {
    const context = [
      error.serverCode,
      error.requestId ? `Request ID: ${error.requestId}` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    const advice =
      error.status === 403
        ? "Check your operator permissions and the authorized GitHub request."
        : error.status === 409
          ? "Refresh the work item and its profile bindings before changing this request. Retrying unchanged keeps the same creation intent."
          : "Retrying unchanged keeps the same creation intent.";
    return {
      title:
        error.status === 403
          ? "Permission required"
          : error.status === 409
            ? "The request conflicts with current state"
            : "Could not create review run",
      description: `${message} ${advice}${context ? ` ${context}` : ""}`,
    };
  }
  return { title: "Could not create review run", description: message };
}
