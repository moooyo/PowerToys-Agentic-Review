import type * as C from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  batchCancelRequestFixture,
  batchCreateRequestFixture,
  batchDetailFixture,
  batchMatrixFixture,
  batchPromptOptionsFixture,
} from "@/services/evaluation-batches/fixtures.testing";
import type { EvaluationAdapter } from "@/services/evaluations";
import {
  suiteCaseDetailFixture,
  suiteCaseListFixture,
  suiteVersionFixture,
} from "@/services/evaluations/fixtures.testing";
import {
  ReviewControlHttpError,
  ReviewControlNetworkError,
} from "@/services/review-control/errors";
import {
  assertBatchReadScope,
  clearArmChoices,
  createBatchRequest,
  criterionKey,
  loadFrozenCases,
  permitsProfileOnly,
  profileChecks,
} from "./batch-state";
import {
  bindingAllowsConfigure,
  nextAccessBinding,
  OriginalMutation,
  permissionSignature,
} from "./state";

function profile(arm: "baseline" | "candidate"): C.ValidationProfileVersion {
  return {
    ...batchDetailFixture().configurations[arm].profile,
    config: {
      schemaVersion: "ValidationProfileV1",
      setup: [],
      build: [
        {
          id: "build:main",
          name: "Build",
          required: true,
          timeoutMs: 1000,
          command: { executable: "fixture", args: [], workingDirectory: ".", environment: [] },
        },
      ],
      test: [],
      launch: [],
      cleanup: [],
      requiredCapabilities: [],
      hardTimeoutMs: 5000,
      noProgressTimeoutMs: 1000,
    },
  };
}
function input() {
  const version = suiteVersionFixture(),
    entry = suiteCaseDetailFixture(),
    prompt = batchPromptOptionsFixture().items[0];
  if (!prompt) throw new Error("Prompt fixture required.");
  return {
    changeId: "stable-create",
    version,
    cases: [entry],
    profiles: { baseline: profile("baseline"), candidate: profile("candidate") },
    prompts: { baseline: prompt, candidate: { ...prompt, id: "prompt-candidate" } },
    mode: "prompt_and_profile" as C.EvaluationBatchMode,
    choices: {
      [criterionKey(entry.caseId, entry.expectation.criteria[0]?.criterionId ?? "")]: {
        baseline: "profile-baseline:build:main",
        candidate: null,
      },
    },
  };
}

describe("evaluation batch configuration", () => {
  it("submits the exact Prompt and profile selections for each arm", () => {
    const request = createBatchRequest(input());
    expect(request.baseline).toEqual({
      profileVersionId: "profile-baseline",
      promptVersionId: "prompt-baseline",
    });
    expect(request.candidate).toEqual({
      profileVersionId: "profile-candidate",
      promptVersionId: "prompt-candidate",
    });
  });
  it("uses the full profile version prefix and only assessable frozen checks", () => {
    const value = profile("baseline");
    value.id = "version:with:colons";
    const step = value.config.build[0];
    if (!step) throw new Error("Build fixture required.");
    value.config.setup = [{ ...step, id: "setup" }];
    value.config.cleanup = [{ ...step, id: "cleanup" }];
    value.config.test = [{ ...step, id: "test:result" }];
    expect(profileChecks(value).map((check) => check.value)).toEqual([
      "version:with:colons:build:main",
      "version:with:colons:test:result",
    ]);
  });
  it("requires every arm mapping to be explicitly chosen and preserves null without declaring success", () => {
    const value = input(),
      before = structuredClone(value.cases);
    const request = createBatchRequest(value);
    expect(request.checkMappings).toEqual([
      {
        caseId: "case-1",
        criterionId: "criterion-1",
        baselineCheckId: "profile-baseline:build:main",
        candidateCheckId: null,
      },
    ]);
    expect(request.changeId).toBe("stable-create");
    expect(value.cases).toEqual(before);
    expect(value.cases[0]?.expectation.criteria[0]?.expectedOutcome).toBe("failed");
    expect(() => createBatchRequest({ ...value, choices: {} })).toThrow(/every criterion/u);
    expect(() =>
      createBatchRequest({
        ...value,
        choices: {
          [criterionKey("case-1", "criterion-1")]: {
            baseline: "profile-baseline:setup",
            candidate: null,
          },
        },
      }),
    ).toThrow(/absent/u);
  });
  it("does not collide tuple identities and clears only the arm whose profile changed", () => {
    const a = criterionKey("case:a", "criterion"),
      b = criterionKey("case", "a:criterion");
    expect(a).not.toBe(b);
    const choices = {
      [a]: { baseline: "old:check", candidate: null },
      [b]: { candidate: "candidate:check" },
    };
    expect(clearArmChoices(choices, "baseline")).toEqual({
      [a]: { candidate: null },
      [b]: { candidate: "candidate:check" },
    });
    expect(choices[a]?.baseline).toBe("old:check");
  });
  it("keeps static review and triage in model-required mode", () => {
    expect(permitsProfileOnly("pr_static_build")).toBe(false);
    expect(permitsProfileOnly("issue_triage")).toBe(false);
    expect(permitsProfileOnly("pr_ui")).toBe(true);
    expect(permitsProfileOnly("issue_validation")).toBe(true);
    expect(() => createBatchRequest({ ...input(), mode: "profile_only" })).toThrow(
      /require Prompt/u,
    );
  });
  it("rejects a different repository, workflow, Prompt schema or suite version", () => {
    const value = input();
    value.profiles.baseline.repositoryId = "another-repository";
    expect(() => createBatchRequest(value)).toThrow(/repository, workflow and target/u);
    const wrongPrompt = input();
    wrongPrompt.prompts.baseline.outputSchemaVersion = "IssueTriageV2";
    expect(() => createBatchRequest(wrongPrompt)).toThrow(/Prompt for this workflow/u);
    const wrongCase = input();
    const entry = wrongCase.cases[0];
    if (!entry) throw new Error("Case fixture required.");
    entry.versionId = "another-version";
    expect(() => createBatchRequest(wrongCase)).toThrow(/another published version/u);
  });
});

describe("complete frozen case reads", () => {
  function adapter(detail = suiteCaseDetailFixture()) {
    return {
      listSuiteCases: vi.fn(async () => suiteCaseListFixture()),
      getSuiteCase: vi.fn(async () => detail),
    } as unknown as EvaluationAdapter;
  }
  it("reads exact case scopes and rejects manifest or source identity mismatches", async () => {
    const api = adapter(),
      version = suiteVersionFixture();
    expect(await loadFrozenCases(api, version)).toEqual([suiteCaseDetailFixture()]);
    expect(api.getSuiteCase).toHaveBeenCalledWith(
      {
        repositoryId: version.repositoryId,
        suiteId: version.suiteId,
        versionId: version.id,
        caseId: "case-1",
      },
      undefined,
    );
    const changed = suiteCaseDetailFixture();
    changed.sourceManifestSha256 = "0".repeat(64);
    await expect(loadFrozenCases(adapter(changed), version)).rejects.toThrow(/published manifest/u);
    changed.sourceManifestSha256 = version.sourceManifestSha256;
    changed.source.id = "other-source";
    await expect(loadFrozenCases(adapter(changed), version)).rejects.toThrow(/published manifest/u);
  });
  it("stops at the aggregate expectation budget and aborts before loading further cases", async () => {
    const large = suiteCaseDetailFixture();
    large.expectation.title = "x".repeat(2 * 1024 * 1024);
    await expect(loadFrozenCases(adapter(large), suiteVersionFixture())).rejects.toThrow(
      /aggregate suite byte limit/u,
    );
    const controller = new AbortController(),
      api = adapter();
    controller.abort();
    await expect(loadFrozenCases(api, suiteVersionFixture(), controller.signal)).rejects.toThrow(
      /aborted/u,
    );
    expect(api.getSuiteCase).not.toHaveBeenCalled();
  });
  it("rejects cross-suite matrices without treating concurrent status updates as identity changes", () => {
    const detail = batchDetailFixture(),
      matrix = batchMatrixFixture();
    const scope = {
      suiteId: detail.summary.suiteId,
      workflowKind: detail.summary.workflowKind,
      target: detail.summary.target,
    };
    matrix.status = "running";
    expect(() => assertBatchReadScope(detail, matrix, scope)).not.toThrow();
    matrix.suiteVersionId = "wrong-version";
    expect(() => assertBatchReadScope(detail, matrix, scope)).toThrow(/exact suite/u);
    matrix.suiteVersionId = detail.summary.suiteVersionId;
    const entry = matrix.cases[0];
    if (!entry) throw new Error("Case fixture required.");
    entry.baseline.promptVersionId = "other-prompt";
    expect(() => assertBatchReadScope(detail, matrix, scope)).toThrow(/arm configuration/u);
    entry.baseline.promptVersionId = detail.summary.baseline.promptVersionId;
    entry.source.workItemKind = "issue";
    expect(() => assertBatchReadScope(detail, matrix, scope)).toThrow(/matrix source/u);
  });
});

describe("batch intent retention", () => {
  it("collapses creation only after a confirmed receipt, including an original-request retry", async () => {
    const owner = new OriginalMutation<C.EvaluationBatchCreateRequest>();
    let configurationOpen = true;
    const confirmed = vi.fn(() => {
      configurationOpen = false;
    });
    await owner.run(
      batchCreateRequestFixture(),
      async () => {
        throw new ReviewControlNetworkError("create batch");
      },
      confirmed,
      vi.fn(),
    );
    expect(configurationOpen).toBe(true);
    expect(confirmed).not.toHaveBeenCalled();
    expect(owner.snapshot().request).toEqual(batchCreateRequestFixture());
    await owner.run(
      batchCreateRequestFixture(),
      async () => batchDetailFixture().summary,
      confirmed,
      vi.fn(),
    );
    expect(confirmed).toHaveBeenCalledOnce();
    expect(configurationOpen).toBe(false);
  });
  it.each([batchCreateRequestFixture(), batchCancelRequestFixture()])(
    "retains the exact create or cancel body after response loss across access checking",
    async (request) => {
      const owner = new OriginalMutation<typeof request>(),
        initial = structuredClone(request);
      const context: C.OperatorAccessContext = {
        principal: { issuer: "fixture", subject: "operator" },
        platformAdministrator: false,
        repository: {
          repositoryId: "repository-a",
          role: "maintainer",
          source: "repository",
          permissions: ["read", "review", "configure"],
        },
      };
      const binding = { identity: "same-scope", permissions: permissionSignature(context) };
      await owner.run(
        request,
        async () => {
          throw new ReviewControlNetworkError("batch mutation");
        },
        vi.fn(),
        vi.fn(),
      );
      const pendingBinding = nextAccessBinding(binding, binding.identity, null);
      expect(pendingBinding).toBe(binding);
      expect(bindingAllowsConfigure(pendingBinding)).toBe(true);
      request.changeId = "replacement";
      const retry = vi.fn(async () => "original receipt");
      await owner.run(request, retry, vi.fn(), vi.fn());
      expect(retry).toHaveBeenCalledExactlyOnceWith(initial);
    },
  );
  it("does not replay cancellation automatically or change its CAS version on conflict", async () => {
    const owner = new OriginalMutation<C.EvaluationBatchCancelRequest>(),
      request = batchCancelRequestFixture();
    const execute = vi.fn(async () => {
      throw new ReviewControlHttpError("Control changed", {
        operation: "cancel batch",
        status: 409,
        retryable: false,
      });
    });
    await owner.run(request, execute, vi.fn(), vi.fn());
    expect(execute).toHaveBeenCalledOnce();
    expect(owner.snapshot()).toMatchObject({ conflict: true, request: null });
    expect(request.expectedVersion).toBe(1);
    expect(request.reason).toBe("Cancel this comparison.");
  });
});
