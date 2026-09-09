import { describe, expect, it, vi } from "vitest";
import { confirmationFromPreview } from "../../components/PublicationPreview/state";
import {
  ReviewControlHttpError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
} from "../review-control/errors";
import {
  detailFixture,
  policyEventFixture,
  previewFixture,
  publicationTestActor,
  publicationTestScope,
  publicationTestTime,
  summaryFixture,
} from "./fixtures.testing";
import { HttpPublicationAdapter } from "./http-adapter";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const withResponse = (value: unknown) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => json(value));
  return { fetch, adapter: new HttpPublicationAdapter({ fetch }) };
};
describe("scoped publication transport", () => {
  it("uses the exact authenticated preview, confirmation, outbox and policy routes", async () => {
    const preview = previewFixture(),
      detail = detailFixture(),
      policy = policyEventFixture();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(preview))
      .mockResolvedValueOnce(json({ intent: detail.intent, replayed: false }))
      .mockResolvedValueOnce(
        json({
          repositoryId: "repository-a",
          items: [summaryFixture()],
          total: 1,
          page: 1,
          pageSize: 20,
        }),
      )
      .mockResolvedValueOnce(json(detail))
      .mockResolvedValueOnce(
        json({
          repositoryId: "repository-a",
          publicationId: "publication-a",
          items: [],
          total: 0,
          page: 1,
          pageSize: 20,
        }),
      )
      .mockResolvedValueOnce(json(policy.previousSnapshot))
      .mockResolvedValueOnce(json({ change: policy, replayed: false }))
      .mockResolvedValueOnce(
        json({ repositoryId: "repository-a", items: [policy], total: 1, page: 1, pageSize: 20 }),
      )
      .mockResolvedValueOnce(json(policy));
    const adapter = new HttpPublicationAdapter({ fetch }),
      scope = { repositoryId: "repository-a", publicationId: "publication-a" };
    await adapter.preview(publicationTestScope);
    await adapter.confirm(publicationTestScope, confirmationFromPreview(preview, "confirm-a"));
    await adapter.list({ repositoryId: "repository-a", status: "pending", reviewRunId: "run-a" });
    await adapter.get(scope);
    await adapter.attempts(scope);
    await adapter.policy("repository-a");
    await adapter.updatePolicy("repository-a", {
      changeId: "policy-change-a",
      expectedVersion: 0,
      enabled: true,
    });
    await adapter.policyActivity({ repositoryId: "repository-a" });
    await adapter.policyEvent("repository-a", policy.id);
    const paths = fetch.mock.calls.map(([path, options]) => [path, options?.method]);
    expect(paths).toEqual([
      [
        "/api/v1/operator/repositories/repository-a/review-runs/run-a/publications/preview?decisionId=comment-event-a",
        "GET",
      ],
      ["/api/v1/operator/repositories/repository-a/review-runs/run-a/publications", "POST"],
      [
        "/api/v1/operator/repositories/repository-a/publications?page=1&pageSize=20&reviewRunId=run-a&status=pending",
        "GET",
      ],
      ["/api/v1/operator/repositories/repository-a/publications/publication-a", "GET"],
      [
        "/api/v1/operator/repositories/repository-a/publications/publication-a/attempts?page=1&pageSize=20",
        "GET",
      ],
      ["/api/v1/operator/repositories/repository-a/publication-policy", "GET"],
      ["/api/v1/operator/repositories/repository-a/publication-policy", "PATCH"],
      [
        "/api/v1/operator/repositories/repository-a/publication-policy/activity?page=1&pageSize=20",
        "GET",
      ],
      [
        "/api/v1/operator/repositories/repository-a/publication-policy/activity/policy-event-a",
        "GET",
      ],
    ]);
    for (const [, options] of fetch.mock.calls)
      expect(options).toMatchObject({
        credentials: "include",
        cache: "no-store",
        redirect: "error",
      });
  });
  it.each(["../another", "repository/a", "repository%2Fa", "repository\n", ""])(
    "rejects unsafe exact scopes %j before fetching",
    async (repositoryId) => {
      const fetch = vi.fn(),
        adapter = new HttpPublicationAdapter({ fetch });
      await expect(
        adapter.preview({ ...publicationTestScope, repositoryId }),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
      await expect(adapter.policy(repositoryId)).rejects.toBeInstanceOf(ReviewControlRequestError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    { binding: { ...previewFixture().binding, repositoryId: "repository-b" } },
    {
      binding: {
        ...previewFixture().binding,
        selectedDecisionId: "latest-decision-instead-of-selected-comment",
      },
    },
    { publisherGitHubUserId: null },
    { canConfirm: true, blockers: ["publication_disabled"] },
    { target: { ...previewFixture().target, kind: "issue" } },
    { observedAt: "2026-09-07T12:00:00Z" },
  ])("rejects preview scope and semantic corruption %j", async (changes) => {
    await expect(
      withResponse({ ...previewFixture(), ...changes }).adapter.preview(publicationTestScope),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });
  it("preserves the complete publication body as plain text", async () => {
    const preview = previewFixture();
    if (!preview.payload) throw new Error("Expected a payload.");
    preview.payload.body = `${"Evidence line\n".repeat(2000)}Required failure retained.\n<!-- exact-marker -->`;
    const received = await withResponse(preview).adapter.preview(publicationTestScope);
    expect(received.payload?.body).toBe(preview.payload.body);
  });
  it.each(["policyVersion", "publisherGitHubUserId", "confirmationChangeId"])(
    "rejects confirmation receipt drift in %s",
    async (field) => {
      const detail = detailFixture();
      const value = {
        intent: {
          ...detail.intent,
          [field]: field === "confirmationChangeId" ? "another-change" : 42,
        },
        replayed: false,
      };
      await expect(
        withResponse(value).adapter.confirm(
          publicationTestScope,
          confirmationFromPreview(previewFixture(), "confirm-a"),
        ),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    },
  );
  it("sends reconciliation only to its control route without an action field", async () => {
    const delivery = {
      ...detailFixture().delivery,
      version: 3,
      status: "unknown",
      attemptCount: 1,
      failure: {
        code: "reconciliation_no_match",
        message: "No exact match; no resend is authorized.",
      },
    };
    const change = {
      schemaVersion: "PublicationControlReceiptV1",
      id: "control-a",
      changeId: "reconcile-a",
      publicationId: "publication-a",
      repositoryId: "repository-a",
      action: "reconcile",
      actor: publicationTestActor,
      previousVersion: 2,
      version: 3,
      payloadSha256: "e".repeat(64),
      createdAt: publicationTestTime,
      delivery,
    };
    const { adapter, fetch } = withResponse({ change, replayed: false });
    await adapter.control(
      { repositoryId: "repository-a", publicationId: "publication-a" },
      "reconcile",
      { changeId: "reconcile-a", expectedVersion: 2, expectedPayloadSha256: "e".repeat(64) },
    );
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "/api/v1/operator/repositories/repository-a/publications/publication-a/reconcile",
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).not.toHaveProperty("action");
  });
  it("never falls back to sample content after authorization or network failure", async () => {
    const adapter = new HttpPublicationAdapter({
      fetch: vi.fn(async () => json({ code: "forbidden" }, 403)),
    });
    await expect(adapter.preview(publicationTestScope)).rejects.toBeInstanceOf(
      ReviewControlHttpError,
    );
  });
  it("aborts obsolete scope reads without issuing a request", async () => {
    const fetch = vi.fn(),
      controller = new AbortController();
    controller.abort(new Error("Scope changed"));
    await expect(
      new HttpPublicationAdapter({ fetch }).preview(publicationTestScope, controller.signal),
    ).rejects.toThrow("Scope changed");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects foreign outbox entries and invalid policy pagination", async () => {
    const { adapter } = withResponse({
      repositoryId: "repository-a",
      items: [{ ...summaryFixture(), repositoryId: "repository-b" }],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    await expect(adapter.list({ repositoryId: "repository-a" })).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
    await expect(
      adapter.policyActivity({ repositoryId: "repository-a", pageSize: 51 }),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
  });
});
