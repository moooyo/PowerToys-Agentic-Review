import {
  InvestigationCurrentCommentSchema,
  InvestigationFindingSourceSchema,
  InvestigationGitHubUserSchema,
  InvestigationIntakeDetailsSchema,
  InvestigationNativePromptBindingSchema,
  InvestigationNativePromptCatalogSchema,
  type InvestigationNativePromptKind,
  type InvestigationNativePromptPublishRequest,
  InvestigationNativePromptVersionSchema,
  type InvestigationPublicationRecoveryRequest,
  type InvestigationPublicationRecoveryStatus,
  InvestigationPublicationRecoveryStatusSchema,
  type InvestigationSession,
  type InvestigationSessionUser,
  InvestigationWorkItemAuthorSchema,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvestigationApi } from "./api";
import { createSampleInvestigationApi } from "./sample-adapter";
import { createSampleConsoleCapabilities } from "./sample-console-capabilities";
import { createSessionScopedSampleApi } from "./sample-workspace-access";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const repositoryId = "repo-powertoys-fork";
const reportId = "sample-pr-p1-report";
const findingId = "sample-pr-p1-finding-1";
const commentId = "sample-pr-p1-comment";
const methods = [
  "nativePrompts",
  "publishNativePrompt",
  "bindNativePrompt",
  "repositoryIntakeDetails",
  "repositoryGitHubUser",
  "currentComment",
  "findingSource",
] as const;
type CapabilityMethod = (typeof methods)[number];
const readMethods = [
  "nativePrompts",
  "repositoryIntakeDetails",
  "repositoryGitHubUser",
  "currentComment",
  "findingSource",
] as const;
const mutationMethods = ["publishNativePrompt", "bindNativePrompt"] as const;
const signalMethods = ["nativePrompts", "currentComment", "findingSource"] as const;
const fetcher = vi.fn<typeof fetch>();

function signedIn(
  overrides: Partial<InvestigationSessionUser> = {},
): Extract<InvestigationSession, { authenticated: true }> {
  return {
    authenticated: true,
    authMode: "password",
    loginPath: "/api/auth/login",
    expiresAt: "2099-01-01T00:00:00.000Z",
    user: {
      id: "sample-reader",
      username: "reader",
      displayName: "Sample reader",
      email: null,
      isAdmin: false,
      repositoryIds: [repositoryId],
      permissions: [],
      actionCapabilities: [],
      allowRepositoryExecution: false,
      ...overrides,
    },
  };
}

function signedOut(): InvestigationSession {
  return { authenticated: false, authMode: "password", loginPath: "/api/auth/login", user: null };
}

function publishInput(): InvestigationNativePromptPublishRequest {
  return {
    expectedVersion: 1,
    name: "Saved sample review instructions",
    content: {
      localCheckout: "Inspect the retained sample checkout and explain concrete findings.",
      snapshot: "Inspect the retained sample snapshot and explain concrete findings.",
    },
  };
}

function promptRef() {
  return { id: "sample-test-prompt", version: 1, digest: "a".repeat(64) };
}

function call(
  api: InvestigationApi,
  method: CapabilityMethod,
  signal?: AbortSignal,
): Promise<unknown> {
  switch (method) {
    case "nativePrompts":
      return api.nativePrompts(repositoryId, signal);
    case "publishNativePrompt":
      return api.publishNativePrompt(repositoryId, "pr-review", publishInput());
    case "bindNativePrompt":
      return api.bindNativePrompt(repositoryId, "pr-review", {
        expectedVersion: 0,
        promptRef: promptRef(),
      });
    case "repositoryIntakeDetails":
      return api.repositoryIntakeDetails(repositoryId);
    case "repositoryGitHubUser":
      return api.repositoryGitHubUser(repositoryId, "sample-reviewer");
    case "currentComment":
      return api.currentComment(commentId, signal);
    case "findingSource":
      return api.findingSource(reportId, findingId, {}, signal);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeEach(() => {
  fetcher.mockReset();
  fetcher.mockRejectedValue(
    new Error("Sample console capabilities must never call a network service."),
  );
  vi.stubGlobal("fetch", fetcher);
});

afterEach(() => {
  try {
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe("sample console read contracts", () => {
  it("returns contract-shaped isolated data for every added reader", async () => {
    const api = createSampleInvestigationApi();
    for (const [schema, value] of [
      [InvestigationNativePromptCatalogSchema, await api.nativePrompts(repositoryId)],
      [InvestigationIntakeDetailsSchema, await api.repositoryIntakeDetails(repositoryId)],
      [
        InvestigationGitHubUserSchema,
        await api.repositoryGitHubUser(repositoryId, "sample-reviewer"),
      ],
      [InvestigationCurrentCommentSchema, await api.currentComment(commentId)],
      [InvestigationFindingSourceSchema, await api.findingSource(reportId, findingId)],
    ] as const)
      expect(Value.Check(schema, value)).toBe(true);
  });

  it("retains independent built-in prompt versions for both task kinds", async () => {
    const api = createSampleInvestigationApi();
    const catalog = await api.nativePrompts(repositoryId);
    expect(catalog.repositoryId).toBe(repositoryId);
    expect(new Set(catalog.items.map((item) => item.kind))).toEqual(
      new Set(["pr-review", "issue-investigate"]),
    );
    for (const item of catalog.items) {
      expect(item.versions).toHaveLength(1);
      expect(item.versions[0]).toMatchObject({ repositoryId, kind: item.kind, version: 1 });
      expect(item.binding).toMatchObject({
        version: 0,
        promptRef: {
          id: item.versions[0]!.id,
          version: 1,
          digest: item.versions[0]!.digest,
        },
      });
      expect(item.runtimeConstraints.localCheckout).not.toBe("");
      expect(item.runtimeConstraints.snapshot).not.toBe("");
    }
    const retained = structuredClone(catalog);
    catalog.items[0]!.versions[0]!.content.snapshot = "Caller changed the returned instructions.";
    catalog.items[0]!.binding.promptRef.digest = "b".repeat(64);
    catalog.items.pop();
    expect(await api.nativePrompts(repositoryId)).toEqual(retained);
    expect(await createSampleInvestigationApi().nativePrompts(repositoryId)).toEqual(retained);
  });

  it("labels webhook details as an unconfigured synthetic receiver", async () => {
    const api = createSampleInvestigationApi();
    const first = await api.repositoryIntakeDetails(repositoryId);
    expect(first).toMatchObject({
      repositoryId,
      canonicalWebhookUrl: "https://sample.invalid/api/github/webhook",
      receiverConfigured: false,
      lastDelivery: null,
    });
    first.canonicalWebhookUrl = "https://caller.invalid/webhook";
    expect((await api.repositoryIntakeDetails(repositoryId)).canonicalWebhookUrl).toBe(
      "https://sample.invalid/api/github/webhook",
    );
  });

  it.each([
    [910001, "sample-reviewer"],
    [910002, "sample-requester"],
    [910003, "sample-author"],
  ] as const)("resolves only the retained profile %s / %s", async (githubUserId, login) => {
    const api = createSampleInvestigationApi();
    const profile = { githubUserId, login, avatarUrl: null, htmlUrl: null };
    expect(await api.repositoryGitHubUser(repositoryId, login)).toEqual(profile);
    expect(await api.repositoryGitHubUser(repositoryId, String(githubUserId))).toEqual(profile);
    const returned = await api.repositoryGitHubUser(repositoryId, login);
    returned.login = "Caller changed the profile.";
    expect(await api.repositoryGitHubUser(repositoryId, login)).toEqual(profile);
  });

  it.each(["unknown-user", "910004", "910001x", "sample-review"])(
    "does not invent a profile for %s",
    async (lookup) => {
      await expect(
        createSampleInvestigationApi().repositoryGitHubUser(repositoryId, lookup),
      ).rejects.toMatchObject({ status: 404 });
    },
  );

  it.each([
    ["sample-pr-p1-comment", "present", "matches_confirmation"],
    ["sample-assignment-preparing-comment", "present", "matches_confirmation"],
    ["sample-pr-p0-comment", "unavailable", "unknown"],
    ["sample-pr-partial-comment", "unavailable", "unknown"],
    ["sample-bug-comment", "not_published", "unknown"],
    ["sample-feature-comment", "not_published", "unknown"],
    ["sample-assignment-intake-comment", "not_published", "unknown"],
  ] as const)(
    "uses retained confirmations for %s without pretending to observe upstream changes",
    async (id, state, comparison) => {
      const api = createSampleInvestigationApi();
      const publication = await api.comment(id);
      const deliveries = await api.commentAttempts(id);
      const confirmation = deliveries.items.find(
        (item) => item.state === "succeeded" && item.effect === "applied",
      );
      const current = await api.currentComment(id);
      expect(Value.Check(InvestigationCurrentCommentSchema, current)).toBe(true);
      expect(current).toMatchObject({
        commentId: id,
        repositoryId: publication.repositoryId,
        repositoryFullName: publication.repositoryFullName,
        workItemId: publication.workItemId,
        workItemNumber: publication.workItemNumber,
        externalId: publication.externalId,
        state,
        comparison,
        lastConfirmedAt: publication.lastConfirmedAt,
        lastConfirmedBody: state === "present" ? confirmation?.body : null,
      });
      expect(current.body).toBe(state === "present" ? confirmation?.body : null);
      expect(current.upstreamUpdatedAt).toBeNull();
      expect(current.reasonCode).toBe(
        state === "present"
          ? "sample_retained_confirmation"
          : state === "unavailable"
            ? "sample_current_comment_unavailable"
            : "sample_not_published",
      );
      const retained = structuredClone(current);
      current.lastConfirmedBody = "Caller changed the confirmation.";
      expect(await api.currentComment(id)).toEqual(retained);
    },
  );

  it.each([
    [reportId, findingId],
    ["sample-bug-report", "sample-bug-finding-1"],
  ])(
    "preserves saved source coordinates while reporting %s source unavailable",
    async (id, finding) => {
      const api = createSampleInvestigationApi();
      const report = await api.exportReport(id);
      const savedFinding = report.findings.find((item) => item.id === finding)!;
      const location = savedFinding.locations[0]!;
      const subject = report.context.subjects.find((item) => item.id === location.subjectRef)!;
      const source = await api.findingSource(id, finding);
      expect(source).toMatchObject({
        reportRef: {
          id: report.id,
          version: report.version,
          digest: report.report.logicalContentDigest,
        },
        findingId: finding,
        findingVersion: savedFinding.version,
        locationIndex: 0,
        repositoryId: report.context.repository.id,
        repositoryFullName: report.context.repository.fullName,
        workItemId: report.context.workItem.id,
        subjectRef: location.subjectRef,
        revisionKey: subject.revisionKey,
        path: location.kind === "source" ? location.path : null,
        startLine: location.kind === "source" ? location.startLine : null,
        endLine: location.kind === "source" ? location.endLine : null,
        availability: "unavailable",
        blobSha: null,
        contentDigest: null,
        contextStartLine: null,
        contextEndLine: null,
        truncated: false,
        lines: [],
      });
      expect(source.reasonCode).toBe("sample_source_unavailable");
      expect(source.sourceUrl).toBeNull();
      expect(source.sourcePath).toBeNull();
      expect(source.sourceRepositoryFullName).toBeNull();
      expect(Value.Check(InvestigationFindingSourceSchema, source)).toBe(true);
      const retained = structuredClone(source);
      source.lines.push({ number: 42, text: "Caller invented source content.", inFinding: true });
      expect(await api.findingSource(id, finding)).toEqual(retained);
    },
  );

  it("rejects missing repositories, publications, reports, findings, and locations", async () => {
    const api = createSampleInvestigationApi();
    for (const operation of [
      () => api.nativePrompts("missing-repository"),
      () => api.repositoryIntakeDetails("missing-repository"),
      () => api.repositoryGitHubUser("missing-repository", "sample-reviewer"),
      () => api.currentComment("missing-comment"),
      () => api.findingSource("missing-report", findingId),
      () => api.findingSource(reportId, "missing-finding"),
      () => api.findingSource(reportId, "sample-bug-finding-1"),
      () => api.findingSource(reportId, findingId, { locationIndex: 100 }),
    ])
      await expect(operation()).rejects.toMatchObject({ status: 404 });
  });

  it.each([-1, 0.5, Number.NaN])(
    "rejects invalid source location index %s",
    async (locationIndex) => {
      await expect(
        createSampleInvestigationApi().findingSource(reportId, findingId, { locationIndex }),
      ).rejects.toMatchObject({ status: 400 });
    },
  );

  it.each(signalMethods)(
    "aborts the raw %s reader before returning sample data",
    async (method) => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        call(createSampleInvestigationApi(), method, controller.signal),
      ).rejects.toMatchObject({
        name: "AbortError",
      });
    },
  );

  it("aborts a catalog read while its built-in prompt digests are being prepared", async () => {
    const controller = new AbortController();
    const pending = createSampleInvestigationApi().nativePrompts(repositoryId, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("sample prompt version mutations", () => {
  it("uses content alone for its digest regardless of template property order", async () => {
    const api = createSampleInvestigationApi();
    const first = await api.publishNativePrompt(repositoryId, "pr-review", publishInput());
    const reordered = await api.publishNativePrompt(repositoryId, "pr-review", {
      expectedVersion: 2,
      name: "The same content with a new version name",
      content: {
        snapshot: publishInput().content.snapshot,
        localCheckout: publishInput().content.localCheckout,
      },
    });
    expect(reordered.digest).toBe(first.digest);
    expect(reordered.id).not.toBe(first.id);
    expect(reordered.version).toBe(3);
    expect(
      (await api.nativePrompts(repositoryId)).items
        .find((item) => item.kind === "pr-review")
        ?.versions.map((item) => item.version),
    ).toEqual([3, 2, 1]);
  });

  it("allows only one concurrent publication against the same expected version", async () => {
    const api = createSampleInvestigationApi();
    const outcomes = await Promise.allSettled([
      api.publishNativePrompt(repositoryId, "pr-review", publishInput()),
      api.publishNativePrompt(repositoryId, "pr-review", publishInput()),
    ]);
    const succeeded = outcomes.filter((item) => item.status === "fulfilled");
    const failed = outcomes.filter((item) => item.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ reason: { status: 409 } });
    const item = (await api.nativePrompts(repositoryId)).items.find(
      (entry) => entry.kind === "pr-review",
    )!;
    expect(item.versions.map((entry) => entry.version)).toEqual([2, 1]);
    expect(item.binding.version).toBe(0);
    expect(item.binding.promptRef.version).toBe(1);
  });

  it.each(["pr-review", "issue-investigate"] as const)(
    "publishes %s versions separately from its optimistic binding version",
    async (kind) => {
      const api = createSampleInvestigationApi();
      const catalog = await api.nativePrompts(repositoryId);
      const original = catalog.items.find((item) => item.kind === kind)!;
      const sibling = catalog.items.find((item) => item.kind !== kind)!;
      const input = publishInput();
      const published = await api.publishNativePrompt(repositoryId, kind, input);
      expect(Value.Check(InvestigationNativePromptVersionSchema, published)).toBe(true);
      expect(published).toMatchObject({
        repositoryId,
        kind,
        version: 2,
        name: input.name,
        content: input.content,
      });
      expect(published.digest).not.toBe(original.versions[0]!.digest);
      const afterPublish = (await api.nativePrompts(repositoryId)).items.find(
        (item) => item.kind === kind,
      )!;
      expect(afterPublish.binding).toEqual(original.binding);
      expect(afterPublish.versions).toHaveLength(2);
      expect(afterPublish.versions).toContainEqual(published);
      expect(
        (await api.nativePrompts(repositoryId)).items.find((item) => item.kind !== kind),
      ).toEqual(sibling);
      await expect(api.publishNativePrompt(repositoryId, kind, input)).rejects.toMatchObject({
        status: 409,
      });
      const ref = { id: published.id, version: published.version, digest: published.digest };
      const binding = await api.bindNativePrompt(repositoryId, kind, {
        expectedVersion: 0,
        promptRef: ref,
      });
      expect(Value.Check(InvestigationNativePromptBindingSchema, binding)).toBe(true);
      expect(binding).toMatchObject({ version: 1, promptRef: ref });
      await expect(
        api.bindNativePrompt(repositoryId, kind, { expectedVersion: 0, promptRef: ref }),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (await api.nativePrompts(repositoryId)).items.find((item) => item.kind === kind)?.binding,
      ).toEqual(binding);
      input.content.snapshot = "Caller changed the publish request.";
      published.content.localCheckout = "Caller changed the returned version.";
      binding.promptRef.digest = "c".repeat(64);
      const retained = (await api.nativePrompts(repositoryId)).items.find(
        (item) => item.kind === kind,
      )!;
      expect(retained.versions.find((item) => item.version === 2)?.content).toEqual(
        publishInput().content,
      );
      expect(retained.binding.promptRef).toEqual(ref);
    },
  );

  it("rejects binding references from another kind or with mismatched version and digest", async () => {
    const api = createSampleInvestigationApi();
    const catalog = await api.nativePrompts(repositoryId);
    const review = catalog.items.find((item) => item.kind === "pr-review")!.versions[0]!;
    const issue = catalog.items.find((item) => item.kind === "issue-investigate")!.versions[0]!;
    for (const ref of [
      { id: "missing-prompt", version: review.version, digest: review.digest },
      { id: review.id, version: review.version + 1, digest: review.digest },
      { id: review.id, version: review.version, digest: "a".repeat(64) },
      { id: issue.id, version: issue.version, digest: issue.digest },
    ])
      await expect(
        api.bindNativePrompt(repositoryId, "pr-review", { expectedVersion: 0, promptRef: ref }),
      ).rejects.toMatchObject({ status: 409 });
    expect(await api.nativePrompts(repositoryId)).toEqual(catalog);
  });

  it("validates prompt requests before storing versions or bindings", async () => {
    const api = createSampleInvestigationApi();
    const catalog = await api.nativePrompts(repositoryId);
    for (const input of [
      { ...publishInput(), expectedVersion: 0 },
      { ...publishInput(), name: "" },
      { ...publishInput(), name: "   " },
      { ...publishInput(), content: { localCheckout: "", snapshot: "Sample snapshot." } },
      { ...publishInput(), content: { localCheckout: "Sample checkout.", snapshot: "   " } },
      {
        ...publishInput(),
        content: { localCheckout: "x".repeat(64 * 1024), snapshot: "x".repeat(64 * 1024) },
      },
      { ...publishInput(), unexpected: true },
    ])
      await expect(api.publishNativePrompt(repositoryId, "pr-review", input)).rejects.toMatchObject(
        { status: 400 },
      );
    const version = catalog.items[0]!.versions[0]!;
    for (const input of [
      { expectedVersion: -1, promptRef: { id: version.id, version: 1, digest: version.digest } },
      { expectedVersion: 0, promptRef: { id: version.id, version: 0, digest: version.digest } },
      { expectedVersion: 0, promptRef: { id: version.id, version: 1, digest: "invalid" } },
    ])
      await expect(
        api.bindNativePrompt(repositoryId, catalog.items[0]!.kind, input),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      api.publishNativePrompt(
        repositoryId,
        "invalid" as InvestigationNativePromptKind,
        publishInput(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      api.bindNativePrompt(repositoryId, "invalid" as InvestigationNativePromptKind, {
        expectedVersion: 0,
        promptRef: { id: version.id, version: 1, digest: version.digest },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(api.repositoryGitHubUser(repositoryId, "")).rejects.toMatchObject({ status: 400 });
    expect(await api.nativePrompts(repositoryId)).toEqual(catalog);
  });

  it.each(mutationMethods)("rejects a missing repository for %s", async (method) => {
    const api = createSampleInvestigationApi();
    const operation =
      method === "publishNativePrompt"
        ? api.publishNativePrompt("missing-repository", "pr-review", publishInput())
        : api.bindNativePrompt("missing-repository", "pr-review", {
            expectedVersion: 0,
            promptRef: promptRef(),
          });
    await expect(operation).rejects.toMatchObject({ status: 404 });
  });
});

describe("sample console capability session grants", () => {
  it.each(methods)("rejects signed-out %s before accessing sample data", async (method) => {
    const raw = createSampleInvestigationApi();
    for (const key of Object.keys(raw) as (keyof InvestigationApi)[]) vi.spyOn(raw, key);
    const api = createSessionScopedSampleApi(raw, async () => signedOut());
    await expect(call(api, method)).rejects.toMatchObject({ status: 401 });
    for (const implementation of Object.values(raw)) expect(implementation).not.toHaveBeenCalled();
  });

  it.each(methods)(
    "requires an exact repository grant for %s even for administrators",
    async (method) => {
      const raw = createSampleInvestigationApi();
      const capability = vi.spyOn(raw, method);
      const api = createSessionScopedSampleApi(raw, async () =>
        signedIn({
          isAdmin: true,
          repositoryIds: ["moooyo/PowerToys"],
          permissions: ["repository:manage"],
        }),
      );
      await expect(call(api, method)).rejects.toMatchObject({ status: 403 });
      expect(capability).not.toHaveBeenCalled();
    },
  );

  it.each(readMethods)(
    "allows repository readers to use %s without management permission",
    async (method) => {
      const raw = createSampleInvestigationApi();
      const capability = vi.spyOn(raw, method);
      const api = createSessionScopedSampleApi(raw, async () => signedIn());
      await expect(call(api, method)).resolves.toBeDefined();
      expect(capability).toHaveBeenCalledOnce();
    },
  );

  it.each(mutationMethods)("requires repository management permission for %s", async (method) => {
    const raw = createSampleInvestigationApi();
    const capability = vi.spyOn(raw, method);
    const api = createSessionScopedSampleApi(raw, async () => signedIn({ isAdmin: true }));
    await expect(call(api, method)).rejects.toMatchObject({ status: 403 });
    expect(capability).not.toHaveBeenCalled();
  });

  it("allows a repository manager to publish and bind a version without execution grants", async () => {
    const raw = createSampleInvestigationApi();
    const api = createSessionScopedSampleApi(raw, async () =>
      signedIn({ permissions: ["repository:manage"] }),
    );
    const published = await api.publishNativePrompt(repositoryId, "pr-review", publishInput());
    expect(published.createdBy).toBe("sample-reader");
    const ref = { id: published.id, version: published.version, digest: published.digest };
    expect(
      await api.bindNativePrompt(repositoryId, "pr-review", { expectedVersion: 0, promptRef: ref }),
    ).toMatchObject({ version: 1, promptRef: ref, updatedBy: "sample-reader" });
    const item = (await api.nativePrompts(repositoryId)).items.find(
      (entry) => entry.kind === "pr-review",
    )!;
    expect(item.versions[0]?.createdBy).toBe("sample-reader");
    expect(item.binding.updatedBy).toBe("sample-reader");
    expect(
      (await raw.nativePrompts(repositoryId)).items.find((entry) => entry.kind === "pr-review")
        ?.versions[0]?.createdBy,
    ).toBe("sample-operator");
  });

  it("freezes a prompt publish request before waiting for the session", async () => {
    const raw = createSampleInvestigationApi();
    const session = deferred<InvestigationSession>();
    const api = createSessionScopedSampleApi(raw, () => session.promise);
    const input = publishInput();
    const expected = structuredClone(input);
    const pending = api.publishNativePrompt(repositoryId, "pr-review", input);
    input.expectedVersion = 100;
    input.name = "Caller replaced the pending name.";
    input.content.snapshot = "Caller replaced the pending instructions.";
    session.resolve(signedIn({ permissions: ["repository:manage"] }));
    expect(await pending).toMatchObject({
      version: 2,
      name: expected.name,
      content: expected.content,
    });
  });

  it("freezes an exact binding reference before waiting for the session", async () => {
    const raw = createSampleInvestigationApi();
    const version = (await raw.nativePrompts(repositoryId)).items[0]!.versions[0]!;
    const input = {
      expectedVersion: 0,
      promptRef: { id: version.id, version: version.version, digest: version.digest },
    };
    const expected = structuredClone(input.promptRef);
    const session = deferred<InvestigationSession>();
    const api = createSessionScopedSampleApi(raw, () => session.promise);
    const pending = api.bindNativePrompt(repositoryId, "pr-review", input);
    input.expectedVersion = 100;
    input.promptRef.digest = "d".repeat(64);
    session.resolve(signedIn({ permissions: ["repository:manage"] }));
    expect(await pending).toMatchObject({ version: 1, promptRef: expected });
  });

  it.each(methods)(
    "discards a late %s response after the signed-in identity changes",
    async (method) => {
      const raw = createSampleInvestigationApi();
      const saved =
        method === "bindNativePrompt"
          ? (await raw.nativePrompts(repositoryId)).items[0]!.binding
          : await call(raw, method);
      const waiting = deferred<typeof saved>();
      const response = vi
        .spyOn(raw, method)
        .mockImplementation(async () => waiting.promise as never);
      let current = signedIn({ permissions: ["repository:manage"] });
      const api = createSessionScopedSampleApi(raw, async () => current);
      const pending = call(api, method);
      await vi.waitFor(() => expect(response).toHaveBeenCalled());
      current = signedIn({ id: "different-reader", permissions: ["repository:manage"] });
      waiting.resolve(saved);
      await expect(pending).rejects.toMatchObject({ status: 401 });
    },
  );

  it.each(methods)(
    "discards a late %s response after repository access is revoked",
    async (method) => {
      const raw = createSampleInvestigationApi();
      const saved =
        method === "bindNativePrompt"
          ? (await raw.nativePrompts(repositoryId)).items[0]!.binding
          : await call(raw, method);
      const waiting = deferred<typeof saved>();
      const response = vi
        .spyOn(raw, method)
        .mockImplementation(async () => waiting.promise as never);
      let current = signedIn({ permissions: ["repository:manage"] });
      const api = createSessionScopedSampleApi(raw, async () => current);
      const pending = call(api, method);
      await vi.waitFor(() => expect(response).toHaveBeenCalled());
      current = signedIn({ repositoryIds: [], permissions: ["repository:manage"] });
      waiting.resolve(saved);
      await expect(pending).rejects.toMatchObject({ status: 403 });
    },
  );

  it.each(mutationMethods)(
    "discards a late %s result after management permission is revoked",
    async (method) => {
      const raw = createSampleInvestigationApi();
      const saved =
        method === "bindNativePrompt"
          ? (await raw.nativePrompts(repositoryId)).items[0]!.binding
          : await call(raw, method);
      const waiting = deferred<typeof saved>();
      const response = vi
        .spyOn(raw, method)
        .mockImplementation(async () => waiting.promise as never);
      let current = signedIn({ permissions: ["repository:manage"] });
      const api = createSessionScopedSampleApi(raw, async () => current);
      const pending = call(api, method);
      await vi.waitFor(() => expect(response).toHaveBeenCalled());
      current = signedIn();
      waiting.resolve(saved);
      await expect(pending).rejects.toMatchObject({ status: 403 });
    },
  );

  it.each(signalMethods)(
    "rejects already-aborted scoped %s reads before checking the session",
    async (method) => {
      const raw = createSampleInvestigationApi();
      const response = vi.spyOn(raw, method);
      const session = vi.fn(async () => signedIn());
      const api = createSessionScopedSampleApi(raw, session);
      const controller = new AbortController();
      controller.abort();
      await expect(call(api, method, controller.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(session).not.toHaveBeenCalled();
      expect(response).not.toHaveBeenCalled();
    },
  );

  it.each(signalMethods)("aborts scoped %s after its raw response arrives", async (method) => {
    const raw = createSampleInvestigationApi();
    const saved = await call(raw, method);
    const controller = new AbortController();
    vi.spyOn(raw, method).mockImplementation(async () => {
      controller.abort();
      return saved as never;
    });
    const api = createSessionScopedSampleApi(raw, async () => signedIn());
    await expect(call(api, method, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("sample author and publication recovery", () => {
  const workItemId = "sample-pr-p1-work-item";
  const taskId = "sample-pr-p1-task";
  const addedMethods = ["workItemAuthor", "publicationRecovery", "recoverPublication"] as const;
  const addedReaders = ["workItemAuthor", "publicationRecovery"] as const;

  function recoveryInput(): InvestigationPublicationRecoveryRequest {
    return { version: "a".repeat(64), reportId, idempotencyKey: "sample-recovery-command" };
  }

  function recoveryOperator(overrides: Partial<InvestigationSessionUser> = {}) {
    return signedIn({
      permissions: ["action:prepare", "action:execute"],
      actionCapabilities: ["comment"],
      ...overrides,
    });
  }

  function callAdded(
    api: InvestigationApi,
    method: (typeof addedMethods)[number],
    signal?: AbortSignal,
  ): Promise<unknown> {
    switch (method) {
      case "workItemAuthor":
        return api.workItemAuthor(workItemId, signal);
      case "publicationRecovery":
        return api.publicationRecovery(taskId, signal);
      case "recoverPublication":
        return api.recoverPublication(taskId, recoveryInput());
    }
  }

  it("returns cloned stored author metadata without resolving a live profile", async () => {
    const api = createSampleInvestigationApi();
    const item = await api.workItem(workItemId);
    const lookup = vi.spyOn(api, "repositoryGitHubUser");
    const author = await api.workItemAuthor(workItemId);
    expect(Value.Check(InvestigationWorkItemAuthorSchema, author)).toBe(true);
    expect(author).toEqual({ workItemId, repositoryId, author: item.author, source: "stored" });
    expect(author.author).toEqual({
      githubUserId: 910003,
      login: "sample-author",
      avatarUrl: null,
      htmlUrl: null,
    });
    author.author!.login = "Caller changed the author.";
    expect((await api.workItemAuthor(workItemId)).author).toEqual(item.author);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("reports unavailable author metadata when no synthetic author was saved", async () => {
    const raw = createSampleInvestigationApi();
    const repository = (await raw.repositories()).items[0]!;
    const { author: _author, ...item } = await raw.workItem(workItemId);
    const api = createSampleConsoleCapabilities({
      repository: () => repository,
      workItems: () => [item],
      tasks: () => [],
      reports: () => [],
      comments: () => [],
      commentBodies: () => new Map(),
    });
    const author = await api.workItemAuthor(workItemId);
    expect(Value.Check(InvestigationWorkItemAuthorSchema, author)).toBe(true);
    expect(author).toEqual({
      workItemId,
      repositoryId,
      author: null,
      source: "unavailable",
      reason: "sample_author_unavailable",
    });
  });

  it("retains a stable blocked recovery status and the task's existing publication", async () => {
    const api = createSampleInvestigationApi();
    const detail = await api.task(taskId);
    const status = await api.publicationRecovery(taskId);
    expect(Value.Check(InvestigationPublicationRecoveryStatusSchema, status)).toBe(true);
    expect(status).toMatchObject({
      taskId,
      reportId: detail.task.latestReportRef?.id ?? null,
      state: "blocked",
      blocker: "publisher_unavailable",
      publication: { id: commentId, taskId, repositoryId },
      availableActions: [],
    });
    expect(status.version).toMatch(/^[a-f0-9]{64}$/u);
    const retained = structuredClone(status);
    status.publication!.state = "pending";
    status.availableActions.push("enqueue");
    expect(await api.publicationRecovery(taskId)).toEqual(retained);
  });

  it("keeps recovery blocked when a queued synthetic task has no report or publication", async () => {
    const api = createSampleInvestigationApi();
    const task = await api.createTask({
      idempotencyKey: "sample-recovery-without-report",
      workItemId: "sample-feature-work-item",
      kind: "issue-investigate",
    });
    const status = await api.publicationRecovery(task.id);
    expect(Value.Check(InvestigationPublicationRecoveryStatusSchema, status)).toBe(true);
    expect(status).toMatchObject({
      taskId: task.id,
      reportId: null,
      state: "blocked",
      blocker: "publisher_unavailable",
      publication: null,
      availableActions: [],
    });
  });

  it("rejects invalid and blocked recovery commands without changing retained state", async () => {
    const api = createSampleInvestigationApi();
    const status = await api.publicationRecovery(taskId);
    const retained = {
      task: await api.task(taskId),
      comments: await api.comments(),
      deliveries: await api.commentAttempts(commentId),
    };
    for (const input of [
      { ...recoveryInput(), version: "invalid" },
      { ...recoveryInput(), reportId: "" },
      { ...recoveryInput(), idempotencyKey: "   " },
      { ...recoveryInput(), unexpected: true },
    ])
      await expect(api.recoverPublication(taskId, input)).rejects.toMatchObject({ status: 400 });
    for (const input of [
      { ...recoveryInput(), version: status.version, reportId: status.reportId! },
      { ...recoveryInput(), version: "b".repeat(64), reportId: status.reportId! },
      { ...recoveryInput(), version: status.version, reportId: "another-sample-report" },
    ])
      await expect(api.recoverPublication(taskId, input)).rejects.toMatchObject({ status: 409 });
    expect(await api.publicationRecovery(taskId)).toEqual(status);
    expect(await api.task(taskId)).toEqual(retained.task);
    expect(await api.comments()).toEqual(retained.comments);
    expect(await api.commentAttempts(commentId)).toEqual(retained.deliveries);
  });

  it("rejects missing author sources and recovery tasks", async () => {
    const api = createSampleInvestigationApi();
    await expect(api.workItemAuthor("missing-work-item")).rejects.toMatchObject({ status: 404 });
    await expect(api.publicationRecovery("missing-task")).rejects.toMatchObject({ status: 404 });
    await expect(api.recoverPublication("missing-task", recoveryInput())).rejects.toMatchObject({
      status: 404,
    });
  });

  it.each(addedReaders)("aborts raw %s reads before returning retained data", async (method) => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      callAdded(createSampleInvestigationApi(), method, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each(addedMethods)("rejects signed-out %s before accessing its source", async (method) => {
    const raw = createSampleInvestigationApi();
    const source = vi.spyOn(raw, method === "workItemAuthor" ? "workItem" : "task");
    const capability = vi.spyOn(raw, method);
    const api = createSessionScopedSampleApi(raw, async () => signedOut());
    await expect(callAdded(api, method)).rejects.toMatchObject({ status: 401 });
    expect(source).not.toHaveBeenCalled();
    expect(capability).not.toHaveBeenCalled();
  });

  it.each(addedMethods)("requires an exact repository grant for scoped %s", async (method) => {
    const raw = createSampleInvestigationApi();
    const capability = vi.spyOn(raw, method);
    const api = createSessionScopedSampleApi(raw, async () =>
      recoveryOperator({
        isAdmin: true,
        repositoryIds: ["moooyo/PowerToys"],
      }),
    );
    await expect(callAdded(api, method)).rejects.toMatchObject({ status: 403 });
    expect(capability).not.toHaveBeenCalled();
  });

  it.each(addedReaders)("allows repository readers to use scoped %s", async (method) => {
    const raw = createSampleInvestigationApi();
    const api = createSessionScopedSampleApi(raw, async () => signedIn());
    await expect(callAdded(api, method)).resolves.toBeDefined();
  });

  it.each(addedMethods)(
    "discards late %s results after identity or repository access changes",
    async (method) => {
      for (const change of ["identity", "repository"] as const) {
        const raw = createSampleInvestigationApi();
        const saved =
          method === "workItemAuthor"
            ? await raw.workItemAuthor(workItemId)
            : await raw.publicationRecovery(taskId);
        const waiting = deferred<typeof saved>();
        const response = vi
          .spyOn(raw, method)
          .mockImplementation(async () => waiting.promise as never);
        let current = recoveryOperator();
        const api = createSessionScopedSampleApi(raw, async () => current);
        const pending = callAdded(api, method);
        await vi.waitFor(() => expect(response).toHaveBeenCalled());
        current =
          change === "identity"
            ? recoveryOperator({ id: "another-reader" })
            : recoveryOperator({ repositoryIds: [] });
        waiting.resolve(saved);
        await expect(pending).rejects.toMatchObject({ status: change === "identity" ? 401 : 403 });
      }
    },
  );

  it.each([
    { permissions: [], actionCapabilities: ["comment"] },
    { permissions: ["action:prepare"], actionCapabilities: ["comment"] },
    { permissions: ["action:execute"], actionCapabilities: ["comment"] },
    { permissions: ["action:prepare", "action:execute"], actionCapabilities: [] },
  ] satisfies Partial<InvestigationSessionUser>[])(
    "requires both comment action grants for recovery: %j",
    async (grants) => {
      const raw = createSampleInvestigationApi();
      const recover = vi.spyOn(raw, "recoverPublication");
      const api = createSessionScopedSampleApi(raw, async () =>
        recoveryOperator({ isAdmin: true, ...grants }),
      );
      await expect(api.recoverPublication(taskId, recoveryInput())).rejects.toMatchObject({
        status: 403,
      });
      expect(recover).not.toHaveBeenCalled();
    },
  );

  it("scopes both recovery and embedded comment actions to the reader's grants", async () => {
    const raw = createSampleInvestigationApi();
    const recoveringTaskId = "sample-pr-p0-task";
    const saved: InvestigationPublicationRecoveryStatus = {
      ...(await raw.publicationRecovery(recoveringTaskId)),
      state: "missing",
      blocker: null,
      publication: await raw.comment("sample-pr-p0-comment"),
      availableActions: ["enqueue"],
    };
    vi.spyOn(raw, "publicationRecovery").mockResolvedValue(saved);
    const reader = createSessionScopedSampleApi(raw, async () => signedIn());
    expect(await reader.publicationRecovery(recoveringTaskId)).toMatchObject({
      availableActions: [],
      publication: { availableActions: [] },
    });
    const operator = createSessionScopedSampleApi(raw, async () => recoveryOperator());
    expect(await operator.publicationRecovery(recoveringTaskId)).toMatchObject({
      availableActions: ["enqueue"],
      publication: { availableActions: ["sync"] },
    });
    expect(saved.availableActions).toEqual(["enqueue"]);
    expect(saved.publication?.availableActions).toEqual(["sync"]);
  });

  it("authorizes recovery using comment grants and scopes its idempotency key to the actor", async () => {
    const raw = createSampleInvestigationApi();
    const saved = await raw.publicationRecovery(taskId);
    const recover = vi.spyOn(raw, "recoverPublication").mockResolvedValue(saved);
    const input = { ...recoveryInput(), idempotencyKey: "x".repeat(128) };
    const operator = createSessionScopedSampleApi(raw, async () => recoveryOperator());
    await expect(operator.recoverPublication(taskId, input)).resolves.toMatchObject({ taskId });
    const first = recover.mock.calls[0]![1];
    expect(first).toMatchObject({ version: input.version, reportId: input.reportId });
    expect(first.idempotencyKey.length).toBeLessThanOrEqual(128);
    expect(first.idempotencyKey).not.toBe(input.idempotencyKey);
    const other = createSessionScopedSampleApi(raw, async () =>
      recoveryOperator({ id: "another-operator" }),
    );
    await other.recoverPublication(taskId, input);
    expect(recover.mock.calls[1]![1].idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("freezes the recovery request before waiting for a password session", async () => {
    const raw = createSampleInvestigationApi();
    const saved = await raw.publicationRecovery(taskId);
    const recover = vi.spyOn(raw, "recoverPublication").mockResolvedValue(saved);
    const session = deferred<InvestigationSession>();
    const api = createSessionScopedSampleApi(raw, () => session.promise);
    const input = recoveryInput();
    const retained = structuredClone(input);
    const pending = api.recoverPublication(taskId, input);
    input.version = "c".repeat(64);
    input.reportId = "caller-changed-report";
    input.idempotencyKey = "caller-changed-key";
    session.resolve(recoveryOperator());
    await pending;
    expect(recover.mock.calls[0]![1]).toMatchObject({
      version: retained.version,
      reportId: retained.reportId,
    });
    expect(recover.mock.calls[0]![1].idempotencyKey).not.toBe(input.idempotencyKey);
  });

  it("rechecks recovery grants after resolving its task and before calling the publisher", async () => {
    const raw = createSampleInvestigationApi();
    const detail = await raw.task(taskId);
    const waiting = deferred<typeof detail>();
    const source = vi.spyOn(raw, "task").mockReturnValue(waiting.promise);
    const recover = vi.spyOn(raw, "recoverPublication");
    let current = recoveryOperator();
    const api = createSessionScopedSampleApi(raw, async () => current);
    const pending = api.recoverPublication(taskId, recoveryInput());
    await vi.waitFor(() => expect(source).toHaveBeenCalled());
    current = recoveryOperator({ permissions: ["action:prepare"] });
    waiting.resolve(detail);
    await expect(pending).rejects.toMatchObject({ status: 403 });
    expect(recover).not.toHaveBeenCalled();
  });

  it.each(["prepare", "execute", "capability"] as const)(
    "discards recovery results after the %s grant is revoked",
    async (grant) => {
      const raw = createSampleInvestigationApi();
      const saved = await raw.publicationRecovery(taskId);
      const waiting = deferred<typeof saved>();
      const recover = vi.spyOn(raw, "recoverPublication").mockReturnValue(waiting.promise);
      let current = recoveryOperator();
      const api = createSessionScopedSampleApi(raw, async () => current);
      const pending = api.recoverPublication(taskId, recoveryInput());
      await vi.waitFor(() => expect(recover).toHaveBeenCalled());
      current =
        grant === "capability"
          ? recoveryOperator({ actionCapabilities: [] })
          : recoveryOperator({
              permissions: grant === "prepare" ? ["action:execute"] : ["action:prepare"],
            });
      waiting.resolve(saved);
      await expect(pending).rejects.toMatchObject({ status: 403 });
    },
  );

  it.each(addedReaders)(
    "aborts scoped %s before session access and after the response",
    async (method) => {
      const raw = createSampleInvestigationApi();
      const saved = await callAdded(raw, method);
      const session = vi.fn(async () => signedIn());
      const api = createSessionScopedSampleApi(raw, session);
      const controller = new AbortController();
      controller.abort();
      await expect(callAdded(api, method, controller.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(session).not.toHaveBeenCalled();
      const late = new AbortController();
      vi.spyOn(raw, method).mockImplementation(async () => {
        late.abort();
        return saved as never;
      });
      await expect(callAdded(api, method, late.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
    },
  );
});
