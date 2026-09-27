import type {
  DashboardRequestEpochSummary,
  IssueReproductionRequestV1,
  RepositoryValidationProfileBinding,
  ValidationProfileVersion,
  WorkflowKind,
} from "@agentic-review/contracts";
import { maximumIssueReproductionRequestUtf8Bytes } from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import { defaultProfileConfig } from "../../pages/ValidationProfiles/forms";
import type { ConfigurationAdapter, ConfigurationPage } from "../../services/configuration/adapter";
import {
  ReviewControlHttpError,
  ReviewControlNetworkError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
  ReviewControlTimeoutError,
} from "../../services/review-control/errors";
import type { WorkItemKind } from "../../services/review-control/types";
import {
  createRunIntentRegistry,
  exactCommitPattern,
  initialRunProfileSelection,
  loadRunProfiles,
  maximumRunProfileCount,
  needsTestedSourceCommit,
  type RunCreationDraft,
  type RunProfileOption,
  type RunWorkItem,
  runCreationError,
  runCreationPrerequisite,
  selectRunProfiles,
} from "./helpers";

const repositoryId = "repository-1";
const timestamp = "2026-09-07T00:00:00.000Z";
const revisionKey = "a".repeat(64);
const commit = "b".repeat(40);
const profileShapes = {
  pr_static_build: {
    workflowKind: "pr_static_build",
    target: "headless",
    outputSchemaVersion: "PrReviewPlanV2",
  },
  pr_ui: { workflowKind: "pr_ui", target: "web", outputSchemaVersion: "ValidationReportV1" },
  issue_triage: {
    workflowKind: "issue_triage",
    target: "headless",
    outputSchemaVersion: "IssueTriageV2",
  },
  issue_validation: {
    workflowKind: "issue_validation",
    target: "headless",
    outputSchemaVersion: "ValidationReportV1",
  },
} as const;

function option(
  index = 1,
  changes: {
    workflow?: WorkflowKind;
    required?: boolean;
    enabled?: boolean;
    repositoryId?: string;
  } = {},
): RunProfileOption {
  const profileId = `profile-${index}`;
  const versionId = `profile-${index}-version-1`;
  const scope = changes.repositoryId ?? repositoryId;
  return {
    binding: {
      repositoryId: scope,
      profileId,
      profileVersionId: versionId,
      version: 1,
      enabled: changes.enabled ?? true,
    },
    version: {
      id: versionId,
      profileId,
      repositoryId: scope,
      name: `Validation profile ${index}`,
      required: changes.required ?? false,
      config: defaultProfileConfig(),
      version: 1,
      configSha256: "c".repeat(64),
      createdAt: timestamp,
      publishedAt: timestamp,
      createdBy: "operator-1",
      ...profileShapes[changes.workflow ?? "pr_static_build"],
    },
  };
}

function epoch(kind: WorkItemKind = "pull_request"): DashboardRequestEpochSummary {
  return {
    requestEpochId: "epoch-1",
    requestKind: kind === "issue" ? "assignment" : "review_request",
    sequence: 1,
    status: "active",
    authorization: "allowlisted",
    openedAt: timestamp,
    closedAt: null,
  };
}

function workItem(kind: WorkItemKind = "pull_request"): RunWorkItem {
  return {
    id: "work-item-1",
    repositoryId,
    repository: "microsoft/PowerToys",
    kind,
    number: 41982,
    title: "Review the accessibility changes",
    author: "contributor-1",
    githubUrl: `https://github.com/microsoft/PowerToys/${kind === "issue" ? "issues" : "pull"}/41982`,
    trigger: kind === "issue" ? "assigned" : "review_requested",
    scheduledBy: "maintainer-1",
    authorization: "allowlisted",
    priority: "normal",
    state: "open",
    stage: "not_scheduled",
    latestJobAttemptCount: null,
    latestJobAdmission: null,
    freshness: "current",
    revisionKey,
    activeRequestEpoch: epoch(kind),
    ...(kind === "pull_request" ? { headSha: commit } : {}),
    updatedAt: timestamp,
  };
}

function draft(changes: Partial<RunCreationDraft> = {}): RunCreationDraft {
  return {
    workItem: workItem(),
    profiles: [option()],
    selectedProfileIds: ["profile-1"],
    testedSourceCommit: "",
    sourceExecutionAuthorized: false,
    ...changes,
  };
}

function issueDraft(changes: Partial<RunCreationDraft> = {}): RunCreationDraft {
  return draft({
    workItem: workItem("issue"),
    profiles: [option(1, { workflow: "issue_validation" })],
    testedSourceCommit: commit,
    sourceExecutionAuthorized: true,
    ...changes,
  });
}

function reproductionDraft(): RunCreationDraft & { reproduction: IssueReproductionRequestV1 } {
  const input = issueDraft();
  const profile = structuredClone(input.profiles[0]!);
  profile.version.config.test = [
    {
      id: "probe",
      name: "Public fixture probe",
      required: true,
      timeoutMs: 60_000,
      command: { executable: "node", args: [], workingDirectory: ".", environment: [] },
      probeOutput: {
        schemaVersion: "TestProbeOutputDeclarationV1",
        fields: [
          { id: "observed", description: "Observed fixture state", type: "boolean" },
          { id: "count", description: "Fixture count", type: "number" },
        ],
      },
    },
  ];
  return {
    ...input,
    profiles: [profile],
    reproduction: {
      schemaVersion: "IssueReproductionRequestV1",
      claim: "The public fixture reproduces the reported behavior.",
      cases: [
        {
          id: "case-1",
          context: "A clean public fixture.",
          profileId: profile.version.profileId,
          expectedProfileVersionId: profile.version.id,
          preconditions: [],
          presentWhen: {
            allOf: [
              {
                observation: {
                  kind: "probe_value",
                  testStepId: "probe",
                  observationId: "observed",
                },
                equals: { type: "boolean", value: true },
              },
            ],
          },
          absentWhen: {
            allOf: [
              {
                observation: {
                  kind: "probe_value",
                  testStepId: "probe",
                  observationId: "observed",
                },
                equals: { type: "boolean", value: false },
              },
            ],
          },
        },
      ],
    },
  };
}

function reproductionDraftWithWireSize(
  bytes: number,
): RunCreationDraft & { reproduction: IssueReproductionRequestV1 } {
  const input = reproductionDraft();
  const profile = input.profiles[0]!;
  const fields = Array.from({ length: 16 }, (_, index) => ({
    id: `field-${index}`,
    description: "Public string observation",
    type: "string" as const,
  }));
  profile.version.config.test[0]!.probeOutput!.fields = fields;
  const template = input.reproduction.cases[0]!;
  input.reproduction.cases = Array.from({ length: 32 }, (_, index) => ({
    ...structuredClone(template),
    id: `case-${index}`,
    presentWhen: {
      allOf: fields.map((field) => ({
        observation: { kind: "probe_value" as const, testStepId: "probe", observationId: field.id },
        equals: { type: "string" as const, value: "é".repeat(2048) },
      })),
    },
    absentWhen: {
      allOf: fields.map((field) => ({
        observation: { kind: "probe_value" as const, testStepId: "probe", observationId: field.id },
        equals: { type: "string" as const, value: "ø".repeat(2048) },
      })),
    },
  }));
  let excess =
    new TextEncoder().encode(
      JSON.stringify({
        activationId: "activation-1",
        expectedRevisionKey: revisionKey,
        profileIds: ["profile-1"],
        testedSourceCommit: commit,
        reproduction: input.reproduction,
      }),
    ).byteLength - bytes;
  for (const entry of input.reproduction.cases) {
    for (const predicate of [...entry.presentWhen.allOf, ...entry.absentWhen!.allOf]) {
      if (predicate.equals.type !== "string") continue;
      const remove = Math.min(Math.floor(excess / 2), predicate.equals.value.length - 1);
      predicate.equals.value = predicate.equals.value.slice(remove);
      excess -= remove * 2;
      if (excess === 1) {
        predicate.equals.value = `x${predicate.equals.value.slice(1)}`;
        excess = 0;
      }
      if (excess === 0) return input;
    }
  }
  throw new Error("The requested fixture size is outside its supported range.");
}

function page(
  items: RepositoryValidationProfileBinding[],
  total = items.length,
  currentPage = 1,
): ConfigurationPage<RepositoryValidationProfileBinding> {
  return { items, total, page: currentPage, pageSize: 50 };
}

function adapterFor(options: readonly RunProfileOption[]) {
  return {
    listProfileBindings: vi
      .fn<ConfigurationAdapter["listProfileBindings"]>()
      .mockImplementation(async (_id, query) => {
        const currentPage = query?.page ?? 1;
        return page(
          options.slice((currentPage - 1) * 50, currentPage * 50).map((entry) => entry.binding),
          options.length,
          currentPage,
        );
      }),
    getProfileVersion: vi
      .fn<ConfigurationAdapter["getProfileVersion"]>()
      .mockImplementation(async (_id, profileId, versionId) => {
        const entry = options.find(
          (candidate) =>
            candidate.version.profileId === profileId && candidate.version.id === versionId,
        );
        if (!entry) throw new Error("The bound published profile was not found.");
        return entry.version;
      }),
  };
}

function registry() {
  let sequence = 0;
  const generateId = vi.fn(() => `activation-${++sequence}`);
  return { intents: createRunIntentRegistry(generateId), generateId };
}

describe("loadRunProfiles", () => {
  it("loads every binding page before resolving profiles and retains required profiles on the last page", async () => {
    const options = Array.from({ length: 103 }, (_, index) =>
      option(index + 1, { required: index === 102 }),
    );
    const adapter = adapterFor(options);
    const loaded = await loadRunProfiles(adapter, repositoryId, "pull_request");
    expect(loaded).toEqual(options);
    expect(adapter.listProfileBindings.mock.calls).toEqual([
      [repositoryId, { page: 1, pageSize: 50 }],
      [repositoryId, { page: 2, pageSize: 50 }],
      [repositoryId, { page: 3, pageSize: 50 }],
    ]);
    expect(adapter.getProfileVersion).toHaveBeenCalledTimes(103);
    expect(initialRunProfileSelection(loaded)).toEqual(["profile-103"]);
  });

  it.each([0, 50])("stops at the exact reported total of %i", async (total) => {
    const options = Array.from({ length: total }, (_, index) => option(index));
    const adapter = adapterFor(options);
    await expect(loadRunProfiles(adapter, repositoryId, "pull_request")).resolves.toEqual(options);
    expect(adapter.listProfileBindings).toHaveBeenCalledTimes(1);
  });

  it("skips disabled bindings without resolving even an unavailable published version", async () => {
    const disabled = option(2, { required: true, enabled: false });
    const adapter = adapterFor([option(), disabled]);
    await expect(loadRunProfiles(adapter, repositoryId, "pull_request")).resolves.toEqual([
      option(),
    ]);
    expect(adapter.getProfileVersion.mock.calls).toEqual([
      [repositoryId, "profile-1", "profile-1-version-1"],
    ]);
  });

  it.each([true, false])(
    "uses the bound published required=%s value instead of an unbound newer version",
    async (required) => {
      const bound = option(1, { required });
      const latest = {
        ...bound.version,
        id: "profile-1-version-2",
        version: 2,
        required: !required,
      };
      const adapter = adapterFor([bound]);
      adapter.getProfileVersion.mockImplementation(async (_id, _profileId, versionId) =>
        versionId === bound.version.id ? bound.version : latest,
      );
      const loaded = await loadRunProfiles(adapter, repositoryId, "pull_request");
      expect(loaded).toEqual([bound]);
      expect(selectRunProfiles(loaded, [])).toEqual(required ? ["profile-1"] : []);
      expect(adapter.getProfileVersion).toHaveBeenCalledWith(
        repositoryId,
        "profile-1",
        bound.version.id,
      );
    },
  );

  it.each<WorkItemKind>(["pull_request", "issue"])("isolates %s workflows", async (kind) => {
    const options = (Object.keys(profileShapes) as WorkflowKind[]).map((workflow, index) =>
      option(index, { workflow }),
    );
    const loaded = await loadRunProfiles(adapterFor(options), repositoryId, kind);
    expect(loaded.map((entry) => entry.version.workflowKind)).toEqual(
      kind === "issue" ? ["issue_triage", "issue_validation"] : ["pr_static_build", "pr_ui"],
    );
  });

  it.each([
    ["a changed total", { total: 52 }],
    ["a wrong page", { page: 1 }],
    ["a wrong page size", { pageSize: 20 }],
    ["an early empty page", { items: [] }],
    ["an oversized total", { total: 10_001 }],
  ])("rejects %s instead of using a partial binding inventory", async (_label, changes) => {
    const options = Array.from({ length: 51 }, (_, index) => option(index));
    const adapter = adapterFor(options);
    adapter.listProfileBindings
      .mockResolvedValueOnce(
        page(
          options.slice(0, 50).map((entry) => entry.binding),
          51,
        ),
      )
      .mockResolvedValueOnce({ ...page([options[50]!.binding], 51, 2), ...changes });
    await expect(loadRunProfiles(adapter, repositoryId, "pull_request")).rejects.toThrow();
    expect(adapter.getProfileVersion).not.toHaveBeenCalled();
  });

  it("rejects a repeated profile across pages", async () => {
    const options = Array.from({ length: 50 }, (_, index) => option(index));
    const adapter = adapterFor(options);
    adapter.listProfileBindings
      .mockResolvedValueOnce(
        page(
          options.map((entry) => entry.binding),
          51,
        ),
      )
      .mockResolvedValueOnce(page([options[0]!.binding], 51, 2));
    await expect(loadRunProfiles(adapter, repositoryId, "pull_request")).rejects.toThrow(
      "repeated profile",
    );
    expect(adapter.getProfileVersion).not.toHaveBeenCalled();
  });

  it.each([
    { repositoryId: "other-repository" },
    { enabled: "true" },
    { profileVersionId: "invalid version" },
    { unexpected: true },
  ])("rejects invalid binding metadata %j", async (changes) => {
    const adapter = adapterFor([option()]);
    adapter.listProfileBindings.mockResolvedValue(
      page([{ ...option().binding, ...changes } as RepositoryValidationProfileBinding]),
    );
    await expect(loadRunProfiles(adapter, repositoryId, "pull_request")).rejects.toThrow();
    expect(adapter.getProfileVersion).not.toHaveBeenCalled();
  });

  it.each([
    { repositoryId: "other-repository" },
    { profileId: "other-profile" },
    { id: "unbound-version" },
    { required: undefined },
    { workflowKind: "unknown_workflow" },
    { config: { ...defaultProfileConfig(), noProgressTimeoutMs: 1_800_001 } },
    { unexpected: true },
  ])("rejects a missing, mismatched, or invalid bound version field %j", async (changes) => {
    const adapter = adapterFor([option()]);
    adapter.getProfileVersion.mockResolvedValue({
      ...option().version,
      ...changes,
    } as unknown as ValidationProfileVersion);
    await expect(loadRunProfiles(adapter, repositoryId, "pull_request")).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it.each(["list", "version"] as const)(
    "preserves %s failures instead of omitting profiles",
    async (stage) => {
      const failure = new ReviewControlNetworkError("load bindings");
      const adapter = adapterFor([option()]);
      if (stage === "list") adapter.listProfileBindings.mockRejectedValue(failure);
      else adapter.getProfileVersion.mockRejectedValue(failure);
      await expect(loadRunProfiles(adapter, repositoryId, "pull_request")).rejects.toBe(failure);
    },
  );

  it("rejects more than 32 applicable required profiles without truncation", async () => {
    const options = Array.from({ length: 33 }, (_, index) => option(index, { required: true }));
    await expect(
      loadRunProfiles(adapterFor(options), repositoryId, "pull_request"),
    ).rejects.toThrow("More than 32 required profiles");
  });
});

describe("review run profile selection", () => {
  it("includes required profiles even when unchecked and canonicalizes optional selections", () => {
    const profiles = [option(3, { required: true }), option(2), option(1)];
    expect(selectRunProfiles(profiles, ["profile-2", "profile-1", "profile-2"])).toEqual([
      "profile-1",
      "profile-2",
      "profile-3",
    ]);
    expect(initialRunProfileSelection(profiles)).toEqual(["profile-1", "profile-2", "profile-3"]);
  });

  it("accepts 32 combined profiles and rejects a required profile added to 32 optional selections", () => {
    const profiles = Array.from({ length: maximumRunProfileCount + 1 }, (_, index) =>
      option(index, { required: index === 32 }),
    );
    expect(
      selectRunProfiles(
        profiles,
        profiles.slice(0, 31).map((entry) => entry.version.profileId),
      ),
    ).toHaveLength(32);
    expect(() =>
      selectRunProfiles(
        profiles,
        profiles.slice(0, 32).map((entry) => entry.version.profileId),
      ),
    ).toThrow("at most 32");
    expect(initialRunProfileSelection(profiles)).toEqual(["profile-32"]);
  });

  it("requires a deliberate selection when more than 32 optional profiles exist", () => {
    const profiles = Array.from({ length: 33 }, (_, index) => option(index));
    expect(initialRunProfileSelection(profiles)).toEqual([]);
    expect(() => registry().intents.prepare(draft({ profiles, selectedProfileIds: [] }))).toThrow(
      "Select at least one enabled profile",
    );
  });

  it("requires known enabled profiles at submission instead of silently filtering stale selections", () => {
    expect(() =>
      registry().intents.prepare(draft({ selectedProfileIds: ["unknown-profile"] })),
    ).toThrow("no longer available");
    expect(() =>
      registry().intents.prepare(draft({ profiles: [option(1, { enabled: false })] })),
    ).toThrow();
  });

  it.each([
    ["duplicate profiles", [option(), option()]],
    ["a foreign repository", [option(1, { repositoryId: "other-repository" })]],
    ["an issue workflow in a pull request", [option(1, { workflow: "issue_triage" })]],
    [
      "an unbound published version",
      [{ ...option(), version: { ...option().version, id: "other-version" } }],
    ],
  ] as const)("rejects %s before allocating an activation", (_label, profiles) => {
    const { intents, generateId } = registry();
    expect(() => intents.prepare(draft({ profiles }))).toThrow();
    expect(generateId).not.toHaveBeenCalled();
  });
});

describe("review run prerequisites", () => {
  it.each<WorkItemKind>(["pull_request", "issue"])(
    "accepts an open %s with an active request and current revision",
    (kind) => {
      expect(runCreationPrerequisite(workItem(kind))).toBeNull();
    },
  );

  it.each<WorkItemKind>(["pull_request", "issue"])(
    "explains the GitHub authorization needed for %s",
    (kind) => {
      const notice = runCreationPrerequisite({ ...workItem(kind), activeRequestEpoch: null });
      expect(notice?.title).toBe("An authorized GitHub request is required");
      expect(notice?.description).toContain(
        kind === "issue" ? "assign this issue" : "request a review",
      );
    },
  );

  it.each([
    { state: "closed" },
    { activeRequestEpoch: { ...epoch(), status: "closed", closedAt: timestamp } },
    { activeRequestEpoch: { ...epoch(), closedAt: timestamp } },
    { revisionKey: "" },
    { revisionKey: commit },
    { revisionKey: `${revisionKey}\n` },
    { revisionKey: revisionKey.toUpperCase() },
    { headSha: undefined },
    { headSha: `${commit}\n` },
  ])("blocks incomplete or stale creation prerequisites %j", (changes) => {
    const item = { ...workItem(), ...changes } as RunWorkItem;
    expect(runCreationPrerequisite(item)).not.toBeNull();
    expect(() => registry().intents.prepare(draft({ workItem: item }))).toThrow();
  });
});

describe("Issue tested source authorization", () => {
  it.each([40, 64])(
    "accepts an explicitly authorized exact %i-character commit independently of the issue revision",
    (length) => {
      const testedSourceCommit = "d".repeat(length);
      const request = registry().intents.prepare(issueDraft({ testedSourceCommit }));
      expect(request).toEqual({
        activationId: "activation-1",
        expectedRevisionKey: revisionKey,
        profileIds: ["profile-1"],
        testedSourceCommit,
      });
      expect(request.expectedRevisionKey).not.toBe(testedSourceCommit);
    },
  );

  it.each([
    "",
    "main",
    "abc123",
    "b".repeat(39),
    "b".repeat(41),
    "b".repeat(63),
    "b".repeat(65),
    "B".repeat(40),
    `${commit}\n`,
    `${commit}\r\n`,
    ` ${commit}`,
    `${commit} `,
    `${commit}\u0000`,
  ])(
    "rejects a non-exact commit %j without normalization or ID allocation",
    (testedSourceCommit) => {
      const { intents, generateId } = registry();
      expect(exactCommitPattern.test(testedSourceCommit)).toBe(false);
      expect(() => intents.prepare(issueDraft({ testedSourceCommit }))).toThrow(
        "exact 40- or 64-character lowercase commit SHA",
      );
      expect(generateId).not.toHaveBeenCalled();
    },
  );

  it("requires explicit execution authorization for a valid Issue validation commit", () => {
    expect(() =>
      registry().intents.prepare(issueDraft({ sourceExecutionAuthorized: false })),
    ).toThrow("authorizes execution of code");
  });

  it("requires source authorization for a required validation profile even when only triage was selected", () => {
    const profiles = [
      option(1, { workflow: "issue_triage" }),
      option(2, { workflow: "issue_validation", required: true }),
    ];
    const input = issueDraft({
      profiles,
      selectedProfileIds: ["profile-1"],
      testedSourceCommit: "",
      sourceExecutionAuthorized: false,
    });
    expect(() => registry().intents.prepare(input)).toThrow("exact 40- or 64-character");
    const request = registry().intents.prepare({
      ...input,
      testedSourceCommit: commit,
      sourceExecutionAuthorized: true,
    });
    expect(request.profileIds).toEqual(["profile-1", "profile-2"]);
    expect(request.testedSourceCommit).toBe(commit);
  });

  it.each(["pull_request", "issue_triage"] as const)(
    "omits residual source fields for %s",
    (kind) => {
      const input =
        kind === "pull_request"
          ? draft()
          : issueDraft({ profiles: [option(1, { workflow: "issue_triage" })] });
      const request = registry().intents.prepare({
        ...input,
        testedSourceCommit: "not-a-commit",
        sourceExecutionAuthorized: false,
      });
      expect(request).not.toHaveProperty("testedSourceCommit");
      expect(request).not.toHaveProperty("sourceExecutionAuthorized");
    },
  );

  it("does not require a commit for an unselected optional validation profile", () => {
    const profiles = [
      option(1, { workflow: "issue_triage" }),
      option(2, { workflow: "issue_validation" }),
    ];
    expect(needsTestedSourceCommit("issue", profiles, ["profile-1"])).toBe(false);
    expect(needsTestedSourceCommit("issue", profiles, ["profile-2"])).toBe(true);
    expect(needsTestedSourceCommit("pull_request", profiles, ["profile-2"])).toBe(false);
    const request = registry().intents.prepare(
      issueDraft({
        profiles,
        selectedProfileIds: ["profile-1"],
        testedSourceCommit: "",
        sourceExecutionAuthorized: false,
      }),
    );
    expect(request).not.toHaveProperty("testedSourceCommit");
  });
});

describe("review run activation intent registry", () => {
  it("reuses one immutable wire intent for duplicate clicks and retries", () => {
    const { intents, generateId } = registry();
    const input = draft({
      profiles: [option(2), option(1)],
      selectedProfileIds: ["profile-2", "profile-1"],
    });
    const original = intents.prepare(input);
    expect(intents.prepare(structuredClone(input))).toBe(original);
    expect(
      intents.prepare({
        ...input,
        profiles: [...input.profiles].reverse(),
        selectedProfileIds: ["profile-1", "profile-2", "profile-1"],
      }),
    ).toBe(original);
    expect(generateId).toHaveBeenCalledTimes(1);
    expect(original).toEqual({
      activationId: "activation-1",
      expectedRevisionKey: revisionKey,
      profileIds: ["profile-1", "profile-2"],
    });
  });

  it("reuses the original token after changing the selection and then switching back", () => {
    const { intents, generateId } = registry();
    const input = draft({ profiles: [option(1), option(2)] });
    const first = intents.prepare(input);
    const changed = intents.prepare({ ...input, selectedProfileIds: ["profile-2"] });
    expect(changed.activationId).not.toBe(first.activationId);
    expect(intents.prepare(input)).toBe(first);
    expect(generateId).toHaveBeenCalledTimes(2);
  });

  it.each(["binding", "epoch"] as const)(
    "keeps the original token when %s metadata changes but the wire body does not",
    (change) => {
      const { intents, generateId } = registry();
      const input = draft();
      const first = intents.prepare(input);
      const updated =
        change === "binding"
          ? {
              ...input,
              profiles: [
                {
                  binding: {
                    ...option().binding,
                    profileVersionId: "profile-1-version-2",
                    version: 2,
                  },
                  version: { ...option().version, id: "profile-1-version-2", version: 2 },
                },
              ],
            }
          : {
              ...input,
              workItem: {
                ...input.workItem,
                activeRequestEpoch: { ...epoch(), requestEpochId: "epoch-2", sequence: 2 },
              },
            };
      expect(intents.prepare(updated)).toBe(first);
      expect(generateId).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["revision", "source", "repository", "workItem"] as const)(
    "allocates a new token when the submitted %s scope changes",
    (change) => {
      const { intents, generateId } = registry();
      const input = issueDraft();
      const first = intents.prepare(input);
      let updated: RunCreationDraft = input;
      if (change === "revision")
        updated = { ...input, workItem: { ...input.workItem, revisionKey: "e".repeat(64) } };
      if (change === "source") updated = { ...input, testedSourceCommit: "e".repeat(40) };
      if (change === "workItem")
        updated = { ...input, workItem: { ...input.workItem, id: "work-item-2" } };
      if (change === "repository")
        updated = {
          ...input,
          workItem: { ...input.workItem, repositoryId: "repository-2" },
          profiles: [option(1, { workflow: "issue_validation", repositoryId: "repository-2" })],
        };
      expect(intents.prepare(updated).activationId).not.toBe(first.activationId);
      expect(intents.prepare(input)).toBe(first);
      expect(generateId).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps irrelevant triage commit edits out of the wire intent", () => {
    const { intents, generateId } = registry();
    const input = issueDraft({ profiles: [option(1, { workflow: "issue_triage" })] });
    const first = intents.prepare(input);
    expect(
      intents.prepare({
        ...input,
        testedSourceCommit: "another unused value",
        sourceExecutionAuthorized: false,
      }),
    ).toBe(first);
    expect(generateId).toHaveBeenCalledTimes(1);
  });

  it("does not retain invalid generated IDs", () => {
    const generateId = vi
      .fn()
      .mockReturnValueOnce("invalid activation")
      .mockReturnValueOnce("valid-activation");
    const intents = createRunIntentRegistry(generateId);
    expect(() => intents.prepare(draft())).toThrow(ReviewControlRequestError);
    expect(intents.prepare(draft()).activationId).toBe("valid-activation");
  });
});

describe("reproduction review run creation intent", () => {
  it("preserves legacy wire bytes when the optional reproduction definition is absent", () => {
    const { intents } = registry();
    const input = issueDraft();
    const original = intents.prepare(input);
    expect(JSON.stringify(original)).toBe(
      JSON.stringify({
        activationId: "activation-1",
        expectedRevisionKey: revisionKey,
        profileIds: ["profile-1"],
        testedSourceCommit: commit,
      }),
    );
    expect(intents.prepare({ ...input, reproduction: undefined })).toBe(original);
    expect(original).not.toHaveProperty("reproduction");
  });

  it("includes a canonical reproduction snapshot and reuses semantic retries", () => {
    const { intents, generateId } = registry();
    const input = reproductionDraft();
    input.reproduction.cases[0]!.presentWhen.allOf.push({
      observation: { kind: "probe_value", testStepId: "probe", observationId: "count" },
      equals: { type: "number", value: -0 },
    });
    input.reproduction.cases.push({
      ...structuredClone(input.reproduction.cases[0]!),
      id: "case-2",
    });
    const original = intents.prepare(input);
    const reordered = structuredClone(input);
    reordered.reproduction.cases.reverse();
    for (const entry of reordered.reproduction.cases) entry.presentWhen.allOf.reverse();
    expect(intents.prepare(reordered)).toBe(original);
    expect(generateId).toHaveBeenCalledTimes(1);
    expect(original.reproduction?.cases[0]?.presentWhen.allOf[0]?.equals).toEqual({
      type: "number",
      value: 0,
    });
  });

  it("freezes nested wire values without freezing or retaining the editable draft", () => {
    const { intents } = registry();
    const input = reproductionDraft();
    const pristine = structuredClone(input);
    const original = intents.prepare(input);
    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(original.reproduction?.cases[0]?.presentWhen.allOf[0]?.equals)).toBe(
      true,
    );
    expect(() => original.profileIds!.push("profile-2")).toThrow();
    expect(() => {
      original.reproduction!.cases[0]!.presentWhen.allOf[0]!.equals.value = false;
    }).toThrow();
    input.reproduction.cases[0]!.context = "Edited fixture context.";
    expect(original.reproduction?.cases[0]?.context).toBe("A clean public fixture.");
    expect(intents.prepare(input).activationId).not.toBe(original.activationId);
    expect(intents.prepare(pristine)).toBe(original);
  });

  it.each(["pull_request", "issue_triage"] as const)(
    "rejects reproduction on %s without allocating an intent",
    (kind) => {
      const { intents, generateId } = registry();
      const input =
        kind === "pull_request"
          ? draft()
          : issueDraft({ profiles: [option(1, { workflow: "issue_triage" })] });
      expect(() =>
        intents.prepare({ ...input, reproduction: reproductionDraft().reproduction }),
      ).toThrow("Issue validation run");
      expect(generateId).not.toHaveBeenCalled();
    },
  );

  it("requires exact source authorization and a still-selected frozen profile", () => {
    const { intents } = registry();
    const input = reproductionDraft();
    expect(() => intents.prepare({ ...input, sourceExecutionAuthorized: false })).toThrow(
      "authorizes execution",
    );
    expect(() => intents.prepare({ ...input, testedSourceCommit: "main" })).toThrow(
      "exact 40- or 64-character",
    );
    const changed = structuredClone(input);
    changed.profiles[0]!.version.id = "version-new";
    changed.profiles[0]!.binding.profileVersionId = "version-new";
    expect(() => intents.prepare(changed)).toThrow("Reload the repository bindings, then reselect");
    expect(() =>
      intents.prepare({
        ...input,
        profiles: [...input.profiles, option(2, { workflow: "issue_validation" })],
        selectedProfileIds: ["profile-2"],
      }),
    ).toThrow("deselected profile");
  });

  it("accepts a qualified check ID made from two maximum-length entity IDs", () => {
    const input = reproductionDraft();
    const profile = input.profiles[0]!;
    profile.version.id = "v".repeat(128);
    profile.binding.profileVersionId = profile.version.id;
    const setupId = "s".repeat(128);
    profile.version.config.setup = [
      {
        id: setupId,
        name: "Fixture setup",
        command: { executable: "node", args: [], workingDirectory: ".", environment: [] },
        timeoutMs: 60_000,
        required: true,
      },
    ];
    const entry = input.reproduction.cases[0]!;
    entry.expectedProfileVersionId = profile.version.id;
    entry.preconditions = [{ kind: "check_passed", checkId: `${profile.version.id}:${setupId}` }];
    expect(registry().intents.prepare(input).reproduction?.cases[0]?.preconditions).toEqual(
      entry.preconditions,
    );
  });

  // This validates the complete large request, not a five-second serialization benchmark.
  it("accepts an exact 2 MiB UTF-8 body and rejects one additional byte including the outer request", {
    timeout: 30_000,
  }, () => {
    const accepted = registry().intents.prepare(
      reproductionDraftWithWireSize(maximumIssueReproductionRequestUtf8Bytes),
    );
    expect(new TextEncoder().encode(JSON.stringify(accepted)).byteLength).toBe(
      maximumIssueReproductionRequestUtf8Bytes,
    );
    const oversized = reproductionDraftWithWireSize(maximumIssueReproductionRequestUtf8Bytes + 1);
    expect(
      new TextEncoder().encode(JSON.stringify(oversized.reproduction)).byteLength,
    ).toBeLessThan(maximumIssueReproductionRequestUtf8Bytes);
    expect(() => registry().intents.prepare(oversized)).toThrow(
      "complete review run request exceeds the 2 MiB",
    );
  });
});

describe("review run creation error details", () => {
  it.each([
    [403, "Permission required", "Check your operator permissions"],
    [
      409,
      "The request conflicts with current state",
      "Refresh the work item and its profile bindings",
    ],
    [500, "Could not create review run", "Retrying unchanged keeps the same creation intent"],
  ])("retains the full server message and diagnostics for HTTP %i", (status, title, advice) => {
    const message =
      "The selected revision cannot be authorized. Request a new GitHub assignment for the configured reviewer.";
    const error = new ReviewControlHttpError(message, {
      operation: "create review run",
      retryable: false,
      status,
      serverCode: "platform_conflict",
      requestId: "request-123",
    });
    const notice = runCreationError(error);
    expect(notice.title).toBe(title);
    expect(notice.description).toContain(message);
    expect(notice.description).toContain(advice);
    expect(notice.description).toContain("platform_conflict");
    expect(notice.description).toContain("Request ID: request-123");
  });

  it.each([
    new ReviewControlNetworkError("create review run"),
    new ReviewControlTimeoutError("create review run", 30_000),
    new Error("The binding version could not be loaded."),
  ])("preserves actionable transport or validation errors: %s", (error) => {
    expect(runCreationError(error)).toEqual({
      title: "Could not create review run",
      description: error.message,
    });
  });

  it("uses a stable fallback for unknown errors without inventing HTTP diagnostics", () => {
    expect(runCreationError(null)).toEqual({
      title: "Could not create review run",
      description: "The request could not be completed. Try again.",
    });
  });
});
