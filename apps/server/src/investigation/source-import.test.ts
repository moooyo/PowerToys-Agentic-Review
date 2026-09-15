import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanonicalResult } from "@agentic-review/codex";
import {
  createInvestigationPreview as createInvestigationFixture,
  type InvestigationTaskV1,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindInvestigationPlanExecution,
  InvestigationSourceImporter,
  type InvestigationTrustedExecutionBinding,
  loadInvestigationExecutionBindings,
} from "../../dist/investigation/source-import.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type { InvestigationOperatorPrincipal } from "../../dist/investigation/types.js";

const stores: InvestigationStore[] = [];
const directories: string[] = [];
const repository = { id: "repo-1", fullName: "fixture/repository", githubRepositoryId: 123 };
const operator: InvestigationOperatorPrincipal = {
  id: "operator-1",
  displayName: "Operator",
  repositoryIds: [repository.id],
  permissions: ["repository:manage", "task:create"],
  actionCapabilities: [],
  allowRepositoryExecution: true,
};
const sha = "a".repeat(40);

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function harness(
  options: {
    kind?: "issue" | "pull_request";
    comments?: number;
    maximumBytes?: number;
    maximumPages?: number;
    override?: (path: string, ordinal: number) => Response | undefined;
  } = {},
) {
  const store = new InvestigationStore();
  stores.push(store);
  store.insert("repositories", repository.id, repository);
  const count = options.comments ?? 101;
  const calls: { path: string; method: string | undefined }[] = [];
  const upstream = {
    number: 7,
    title: "Complete reported behavior",
    body: "Full original body\nincluding every reproduction detail.",
    state: "open",
    comments: count,
    updated_at: "2026-09-15T10:00:00.000Z",
    ...(options.kind === "pull_request"
      ? {
          base: { sha: "b".repeat(40), repo: { id: 123 } },
          head: { sha },
          review_comments: 1,
          merged_at: null,
        }
      : {}),
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.github.com");
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    const path = `${url.pathname}${url.search}`;
    calls.push({ path, method: init?.method });
    const overridden = options.override?.(path, calls.filter((call) => call.path === path).length);
    if (overridden !== undefined) return overridden;
    if (path === "/user") return Response.json({ id: 55 });
    if (path === "/repos/fixture/repository")
      return Response.json({ id: 123, full_name: repository.fullName });
    if (
      url.pathname === "/repos/fixture/repository/issues/7" ||
      url.pathname === "/repos/fixture/repository/pulls/7"
    )
      return Response.json(upstream);
    if (url.pathname === `/repos/fixture/repository/commits/${sha}`) return Response.json({ sha });
    if (url.pathname === "/repos/fixture/repository/issues/7/comments") {
      const page = Number(url.searchParams.get("page"));
      const start = (page - 1) * 100;
      const comments = Array.from(
        { length: Math.max(0, Math.min(100, count - start)) },
        (_, index) => ({ id: start + index + 1, body: `Complete comment ${start + index + 1}` }),
      );
      return Response.json(
        comments,
        start + comments.length < count
          ? {
              headers: {
                link: `<https://api.github.com/repos/fixture/repository/issues/7/comments?per_page=100&page=${page + 1}>; rel="next"`,
              },
            }
          : {},
      );
    }
    if (url.pathname === "/repos/fixture/repository/pulls/7/comments")
      return Response.json([{ id: 301, body: "Full inline review feedback" }]);
    if (url.pathname === "/repos/fixture/repository/pulls/7/reviews")
      return Response.json([{ id: 401, body: "Full overall review feedback" }]);
    throw new Error(`Unexpected fake request: ${path}`);
  };
  const importer = new InvestigationSourceImporter({
    store,
    github: { token: "synthetic-read-token", expectedGitHubUserId: 55 },
    fetch,
    ...(options.maximumBytes === undefined ? {} : { maximumBytes: options.maximumBytes }),
    ...(options.maximumPages === undefined ? {} : { maximumPages: options.maximumPages }),
  });
  return { store, importer, calls, upstream };
}

describe("read-only GitHub source import", () => {
  it("imports every Issue comment page and preserves the complete frozen task input", async () => {
    const { store, importer, calls, upstream } = harness();
    const imported = await importer.importWorkItem(operator, repository.id, {
      kind: "issue",
      number: 7,
    });
    expect(imported.commentsCount).toBe(101);
    expect(imported.workItem.body).toBe(upstream.body);
    expect(imported.workItem.subject.revisionKey).toBe(
      createHash("sha256")
        .update(
          JSON.stringify([upstream.title, upstream.body, upstream.state, upstream.updated_at]),
        )
        .digest("hex"),
    );
    expect(calls.filter((call) => call.path.includes("/comments?"))).toHaveLength(2);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    const { task: baseTask } = createInvestigationFixture("bug");
    const task: InvestigationTaskV1 = {
      ...baseTask,
      repository,
      workItem: imported.workItem,
      subjectRef: imported.workItem.subject.id,
      subjects: [imported.workItem.subject],
    };
    const prepared = await importer.prepareTaskInput(task, imported.workItem, null, operator);
    expect(prepared.inputSnapshot.body).toBe(upstream.body);
    expect(prepared.inputSnapshot.comments.at(-1)).toEqual({
      id: "issue-comment:101",
      body: "Complete comment 101",
    });
    expect(prepared.inputSnapshot.comments).toHaveLength(101);
    expect(prepared.inputSnapshot.source).toBeNull();
    expect(prepared.execution).toBeNull();
    prepared.inputSnapshot.comments[0]!.body = "Modified caller copy";
    const again = await importer.prepareTaskInput(task, imported.workItem, null, operator);
    expect(again.inputSnapshot.comments[0]?.body).toBe("Complete comment 1");
    expect(store.get("sourceSnapshots", imported.snapshotRef.id)).toMatchObject({
      digest: imported.snapshotRef.digest,
    });
  });

  it("imports PR conversation, inline reviews, and review summaries with an exact base/head revision", async () => {
    const { importer } = harness({ kind: "pull_request", comments: 1 });
    const result = await importer.importWorkItem(operator, repository.id, {
      kind: "pull_request",
      number: 7,
    });
    expect(result.commentsCount).toBe(3);
    expect(result.workItem.subject).toMatchObject({
      kind: "original_pr",
      baseSha: "b".repeat(40),
      headSha: sha,
      revisionKey: createHash("sha256")
        .update(`${"b".repeat(40)}\0${sha}`)
        .digest("hex"),
    });
  });

  it("checks repository identity and operator scope before saving source", async () => {
    const scoped = harness();
    await expect(
      scoped.importer.importWorkItem({ ...operator, repositoryIds: [] }, repository.id, {
        kind: "issue",
        number: 7,
      }),
    ).rejects.toMatchObject({ code: "repository_forbidden" });
    expect(scoped.calls).toHaveLength(0);
    const wrongRepository = harness({
      override: (path) =>
        path === "/repos/fixture/repository"
          ? Response.json({ id: 999, full_name: repository.fullName })
          : undefined,
    });
    await expect(
      wrongRepository.importer.importWorkItem(operator, repository.id, {
        kind: "issue",
        number: 7,
      }),
    ).rejects.toMatchObject({ code: "source_repository_mismatch" });
    expect(wrongRepository.store.list("workItems")).toEqual([]);
  });

  it("fails budget exhaustion or a changing target without storing truncated observations", async () => {
    for (const options of [{ maximumBytes: 10 }, { maximumPages: 1 }]) {
      const { importer, store } = harness(options);
      await expect(
        importer.importWorkItem(operator, repository.id, { kind: "issue", number: 7 }),
      ).rejects.toMatchObject({ code: "source_budget_exceeded" });
      expect(store.list("workItems")).toEqual([]);
      expect(store.list("sourceSnapshots")).toEqual([]);
    }
    const changed = harness({
      override: (path, ordinal) =>
        path === "/repos/fixture/repository/issues/7" && ordinal === 2
          ? Response.json({
              number: 7,
              title: "Changed",
              body: "Changed",
              state: "open",
              comments: 101,
              updated_at: "2026-09-15T10:01:00.000Z",
            })
          : undefined,
    });
    await expect(
      changed.importer.importWorkItem(operator, repository.id, { kind: "issue", number: 7 }),
    ).rejects.toMatchObject({ code: "source_changed_during_import" });
    expect(changed.store.list("sourceSnapshots")).toEqual([]);
  });

  it("rejects unexpected pagination origins without following their links", async () => {
    const { importer, calls } = harness({
      override: (path) =>
        path.includes("/comments?")
          ? Response.json([{ id: 1, body: "One comment" }], {
              headers: { link: '<https://attacker.example/steal?per_page=100&page=2>; rel="next"' },
            })
          : undefined,
    });
    await expect(
      importer.importWorkItem(operator, repository.id, { kind: "issue", number: 7 }),
    ).rejects.toMatchObject({ code: "invalid_source_pagination" });
    expect(calls.some((call) => call.path.includes("steal"))).toBe(false);
  });

  it("resolves only the explicit exact Issue source commit and preserves Issue context", async () => {
    const { importer } = harness({ comments: 1 });
    const { workItem } = await importer.importWorkItem(operator, repository.id, {
      kind: "issue",
      number: 7,
    });
    const subject = await importer.resolveTaskSource(repository, workItem, sha, operator);
    expect(subject).toMatchObject({
      kind: "source_commit",
      commitSha: sha,
      repositoryId: repository.id,
      workItemId: workItem.id,
    });
    const { task: baseTask } = createInvestigationFixture("bug");
    const task: InvestigationTaskV1 = {
      ...baseTask,
      repository,
      workItem,
      subjectRef: subject.id,
      subjects: [workItem.subject, subject],
    };
    const prepared = await importer.prepareTaskInput(task, workItem, null, operator);
    expect(prepared.inputSnapshot).toMatchObject({
      subjectRef: subject.id,
      subjectRevisionKey: subject.revisionKey,
      body: workItem.body,
      comments: [{ id: "issue-comment:1", body: "Complete comment 1" }],
    });
    const wrong = harness({
      comments: 1,
      override: (path) =>
        path.includes("/commits/") ? Response.json({ sha: "f".repeat(40) }) : undefined,
    });
    await expect(
      wrong.importer.resolveTaskSource(repository, workItem, sha, operator),
    ).rejects.toMatchObject({ code: "source_commit_mismatch" });
  });
});

function planFixture() {
  const fixture = createInvestigationFixture("pr");
  const plan = fixture.result.plans[0]!;
  const actor = { ...operator, repositoryIds: [fixture.task.repository.id] };
  const task: InvestigationTaskV1 = {
    ...fixture.task,
    kind: "pr-verify",
    planRef: { id: plan.id, version: plan.version, digest: plan.digest },
    executionPolicy: {
      mode: "execute",
      allowRepositoryExecution: true,
      authorizationRef: actor.id,
      allowedSubjectRefs: [fixture.task.subjectRef],
    },
  };
  const binding: InvestigationTrustedExecutionBinding = {
    repositoryId: task.repository.id,
    planRef: { id: plan.id, version: plan.version, digest: plan.digest },
    planKind: "verification",
    satisfiedPrerequisiteRefs: plan.prerequisites.map((entry) => entry.id),
    steps: plan.steps.map((step) => ({
      stepId: step.id,
      operation: {
        kind: "command",
        executableId: "trusted-test-runner",
        arguments: ["--fixed-scenario"],
        workingDirectory: ".",
        expectedExitCode: 0,
      },
    })),
  };
  return { task, plan, actor, binding, result: fixture.result };
}

describe("trusted plan execution registry", () => {
  it("reads saved prerequisite acknowledgements without invoking execution or upstream requests", async () => {
    const { task, plan, actor, binding, result } = planFixture();
    plan.prerequisites = ["authorization", "information", "decision"].map((kind) => ({
      id: `trusted-${kind}`,
      kind: kind as "authorization" | "information" | "decision",
      description: `The operator confirmed this ${kind} prerequisite for this saved plan.`,
    }));
    const {
      digest: _digest,
      state: _state,
      sourceReportRef: _sourceReportRef,
      ...planContent
    } = plan;
    plan.digest = createCanonicalResult(planContent).sha256;
    const exactBinding = {
      ...binding,
      planRef: { id: plan.id, version: plan.version, digest: plan.digest },
      satisfiedPrerequisiteRefs: plan.prerequisites.map((entry) => entry.id),
    };
    const store = new InvestigationStore();
    stores.push(store);
    const item = {
      ...task.workItem,
      repositoryId: task.repository.id,
      body: "Synthetic complete source",
      state: "open" as const,
      subject: task.subjects[0]!,
      updatedAt: task.updatedAt,
    };
    let requests = 0;
    const importer = new InvestigationSourceImporter({
      store,
      executionBindings: [exactBinding],
      fetch: async () => {
        requests += 1;
        throw new Error("No upstream request is authorized in this fixture.");
      },
    });
    expect(
      await importer.resolvePlanPrerequisites(task.repository, item, result, plan, actor),
    ).toEqual(exactBinding.satisfiedPrerequisiteRefs);
    expect(requests).toBe(0);
    expect(store.list("tasks")).toEqual([]);
    const { planRef: _planRef, ...profileBinding } = exactBinding;
    const byProfile = new InvestigationSourceImporter({
      store,
      executionBindings: [{ ...profileBinding, profileRef: result.context.profileRef }],
    });
    expect(
      await byProfile.resolvePlanPrerequisites(task.repository, item, result, plan, actor),
    ).toEqual(exactBinding.satisfiedPrerequisiteRefs);
  });

  it("does not acknowledge a mismatched, ambiguous, or unrelated saved plan configuration", async () => {
    const { task, plan, actor, binding, result } = planFixture();
    const store = new InvestigationStore();
    stores.push(store);
    const item = {
      ...task.workItem,
      repositoryId: task.repository.id,
      body: "Synthetic complete source",
      state: "open" as const,
      subject: task.subjects[0]!,
      updatedAt: task.updatedAt,
    };
    const { planRef: _planRef, ...profileBinding } = binding;
    const registrations: InvestigationTrustedExecutionBinding[][] = [
      [],
      [binding, binding],
      [{ ...binding, repositoryId: "another-repository" }],
      [{ ...binding, planRef: { ...binding.planRef!, digest: "0".repeat(64) } }],
      [{ ...profileBinding, profileRef: { ...result.context.profileRef, digest: "0".repeat(64) } }],
      [{ ...binding, satisfiedPrerequisiteRefs: ["not-a-prerequisite-of-this-plan"] }],
      [{ ...binding, steps: [{ ...binding.steps[0]!, stepId: "unrelated-step" }] }],
    ];
    for (const executionBindings of registrations) {
      const importer = new InvestigationSourceImporter({ store, executionBindings });
      expect(
        await importer.resolvePlanPrerequisites(task.repository, item, result, plan, actor),
      ).toEqual([]);
    }
    const importer = new InvestigationSourceImporter({ store, executionBindings: [binding] });
    expect(
      await importer.resolvePlanPrerequisites(
        task.repository,
        { ...item, id: "another-item" },
        result,
        plan,
        actor,
      ),
    ).toEqual([]);
    expect(
      await importer.resolvePlanPrerequisites(
        task.repository,
        item,
        result,
        { ...plan, title: "Altered plan content" },
        actor,
      ),
    ).toEqual([]);
  });

  it("binds fixed operations to the exact plan, source, policy, and actor", () => {
    const { task, plan, actor, binding } = planFixture();
    const result = bindInvestigationPlanExecution(task, plan, actor, [binding]);
    expect(result).toMatchObject({
      planRef: task.planRef,
      subjectRef: task.subjectRef,
      subjectRevisionKey: task.subjects[0]?.revisionKey,
      authorizationRef: actor.id,
      executionPolicyDigest: createCanonicalResult(task.executionPolicy).sha256,
    });
    expect(result?.steps[0]?.digest).toBe(createCanonicalResult(binding.steps[0]).sha256);
    expect(result?.steps[0]?.operation).toEqual(binding.steps[0]?.operation);
  });

  it("rejects missing or ambiguous bindings, missing prerequisites, reordered steps, and denied execution", () => {
    const { task, plan, actor, binding } = planFixture();
    expect(() => bindInvestigationPlanExecution(task, plan, actor, [])).toThrow(
      expect.objectContaining({ code: "execution_binding_missing" }),
    );
    expect(() => bindInvestigationPlanExecution(task, plan, actor, [binding, binding])).toThrow(
      expect.objectContaining({ code: "execution_binding_ambiguous" }),
    );
    expect(() =>
      bindInvestigationPlanExecution(task, plan, actor, [
        { ...binding, satisfiedPrerequisiteRefs: [] },
      ]),
    ).toThrow(expect.objectContaining({ code: "execution_prerequisites_missing" }));
    expect(() =>
      bindInvestigationPlanExecution(task, plan, actor, [
        { ...binding, steps: [{ ...binding.steps[0]!, stepId: "different-step" }] },
      ]),
    ).toThrow(expect.objectContaining({ code: "execution_steps_mismatch" }));
    expect(() =>
      bindInvestigationPlanExecution(task, plan, { ...actor, allowRepositoryExecution: false }, [
        binding,
      ]),
    ).toThrow(expect.objectContaining({ code: "execution_not_authorized" }));
  });

  it("matches a complete trusted profile reference without accepting model-provided command arguments", () => {
    const { task, plan, actor, binding } = planFixture();
    const { planRef: _planRef, ...profileBinding } = binding;
    const result = bindInvestigationPlanExecution(task, plan, actor, [
      { ...profileBinding, profileRef: task.profileRef },
    ]);
    expect(result?.steps[0]?.operation).toEqual(binding.steps[0]?.operation);
    expect(() =>
      bindInvestigationPlanExecution(
        { ...task, profileRef: { ...task.profileRef, digest: "0".repeat(64) } },
        plan,
        actor,
        [{ ...profileBinding, profileRef: task.profileRef }],
      ),
    ).toThrow(expect.objectContaining({ code: "execution_binding_missing" }));
  });

  it("allows an explicit implementation edit without claiming validation and rejects edits in verification", () => {
    const { task, plan, actor, binding } = planFixture();
    const implementationPlan = {
      ...plan,
      kind: "fix" as const,
      steps: plan.steps.map((step) => ({ ...step, checkIds: [] })),
    };
    const implementationTask = { ...task, kind: "issue-fix" as const };
    const editBinding: InvestigationTrustedExecutionBinding = {
      ...binding,
      planKind: "fix",
      steps: [
        {
          stepId: plan.steps[0]!.id,
          operation: { kind: "model-edit", allowedPaths: ["src/fix.ts"] },
        },
      ],
    };
    const result = bindInvestigationPlanExecution(implementationTask, implementationPlan, actor, [
      editBinding,
    ]);
    expect(result?.steps[0]?.operation).toEqual({
      kind: "model-edit",
      allowedPaths: ["src/fix.ts"],
    });
    expect(result).not.toHaveProperty("validation");
    expect(() =>
      bindInvestigationPlanExecution(task, plan, actor, [
        { ...editBinding, planKind: "verification" },
      ]),
    ).toThrow(expect.objectContaining({ code: "execution_edit_binding_mismatch" }));
  });

  it("loads only an explicit trusted registry and rejects path traversal or an unbound entry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "investigation-execution-registry-"));
    directories.push(directory);
    const path = join(directory, "bindings.json");
    const { binding } = planFixture();
    await writeFile(path, JSON.stringify([binding]));
    expect(loadInvestigationExecutionBindings(path)).toEqual([binding]);
    expect(loadInvestigationExecutionBindings(undefined)).toEqual([]);
    await writeFile(
      path,
      JSON.stringify([
        {
          ...binding,
          steps: [
            {
              stepId: binding.steps[0]!.stepId,
              operation: { ...binding.steps[0]!.operation, workingDirectory: "../outside" },
            },
          ],
        },
      ]),
    );
    expect(() => loadInvestigationExecutionBindings(path)).toThrow(
      "relative to the owned source workspace",
    );
    const { planRef: _planRef, ...unbound } = binding;
    await writeFile(path, JSON.stringify([unbound]));
    expect(() => loadInvestigationExecutionBindings(path)).toThrow(
      "exact saved plan or profile reference",
    );
    await writeFile(
      path,
      JSON.stringify([
        {
          ...binding,
          planKind: "fix",
          steps: [
            {
              stepId: binding.steps[0]!.stepId,
              operation: { kind: "model-edit", allowedPaths: ["src/*.ts"] },
            },
          ],
        },
      ]),
    );
    expect(() => loadInvestigationExecutionBindings(path)).toThrow("without traversal or globs");
  });
});
