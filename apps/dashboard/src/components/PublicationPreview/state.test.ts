import { describe, expect, it } from "vitest";
import { detailFixture, previewFixture } from "../../services/publications/fixtures.testing";
import {
  confirmationFromPreview,
  publicationActions,
  publicationControl,
  publicationFingerprint,
} from "./state";

describe("publication action bindings", () => {
  it("binds a selected historical comment independently of the current decision stream", () => {
    const request = confirmationFromPreview(previewFixture(), "change-a");
    expect(request.expectedSelectedDecisionId).toBe("comment-event-a");
    expect(request.expectedSelectedDecisionVersion).toBe(3);
    expect(request.expectedDecisionContextVersion).toBe(5);
    expect(request).toMatchObject({
      expectedPublisherGitHubUserId: 303,
      expectedPolicyVersion: 1,
      expectedPayloadSha256: "e".repeat(64),
    });
    expect(request).not.toHaveProperty("body");
    expect(request).not.toHaveProperty("actor");
  });
  it("rejects a blocked preview and resets the review fingerprint for a changed binding", () => {
    const preview = previewFixture();
    expect(() =>
      confirmationFromPreview(
        { ...preview, canConfirm: false, blockers: ["publication_disabled"] },
        "change-a",
      ),
    ).toThrow("confirmable");
    expect(publicationFingerprint({ ...preview, policyVersion: 2 })).not.toBe(
      publicationFingerprint(preview),
    );
    expect(publicationFingerprint({ ...preview, publisherGitHubUserId: 404 })).not.toBe(
      publicationFingerprint(preview),
    );
  });
  it("offers only read-only reconciliation for unknown delivery", () => {
    const detail = detailFixture();
    detail.delivery = {
      ...detail.delivery,
      status: "unknown",
      attemptCount: 1,
      failure: { code: "ambiguous_delivery", message: "The response was lost." },
    };
    expect(publicationActions(detail)).toEqual(["reconcile"]);
    expect(() => publicationControl(detail, "retry", "change-a")).toThrow("unavailable");
    expect(() => publicationControl(detail, "cancel", "change-a")).toThrow("unavailable");
    expect(publicationControl(detail, "reconcile", "change-a")).toEqual({
      changeId: "change-a",
      expectedVersion: 1,
      expectedPayloadSha256: detail.intent.payloadSha256,
    });
  });
  it.each(["pending", "delivering", "published", "cancelled"] as const)(
    "does not offer delivery retry for %s",
    (status) => {
      const detail = detailFixture();
      detail.delivery.status = status;
      expect(publicationActions(detail)).not.toContain("retry");
    },
  );
});
