import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  defaultPublicationPageSize,
  getPublicationAttemptIssues,
  getPublicationAttemptListIssues,
  getPublicationConfirmRequestIssues,
  getPublicationConfirmResponseIssues,
  getPublicationControlReceiptIssues,
  getPublicationControlRequestIssues,
  getPublicationControlResponseIssues,
  getPublicationDeliveryIssues,
  getPublicationDetailIssues,
  getPublicationIntentIssues,
  getPublicationListIssues,
  getPublicationPayloadIssues,
  getPublicationPreviewIssues,
  getPublicationRemoteReceiptIssues,
  getRepositoryPublicationPolicyAuditEventIssues,
  getRepositoryPublicationPolicyAuditListIssues,
  getRepositoryPublicationPolicyIssues,
  maximumPublicationBodyUtf8Bytes,
  maximumPublicationPageSize,
  type PublicationAttempt,
  PublicationAttemptListQuerySchema,
  PublicationAttemptListResponseSchema,
  PublicationAttemptSchema,
  type PublicationConfirmRequest,
  PublicationConfirmRequestSchema,
  type PublicationControlReceipt,
  PublicationControlRequestSchema,
  type PublicationDelivery,
  PublicationDeliverySchema,
  type PublicationDetail,
  PublicationDetailSchema,
  type PublicationIntent,
  PublicationIntentSchema,
  PublicationListQuerySchema,
  PublicationListResponseSchema,
  type PublicationPayload,
  PublicationPayloadSchema,
  type PublicationPreview,
  PublicationPreviewQuerySchema,
  PublicationPreviewSchema,
  PublicationReadQuerySchema,
  type PublicationRemoteReceipt,
  PublicationRemoteReceiptSchema,
  type PublicationSummary,
  type RepositoryPublicationPolicy,
  type RepositoryPublicationPolicyAuditEvent,
  RepositoryPublicationPolicyAuditEventSchema,
  RepositoryPublicationPolicyAuditListQuerySchema,
  RepositoryPublicationPolicyAuditReadQuerySchema,
  RepositoryPublicationPolicySchema,
  RepositoryPublicationPolicyUpdateRequestSchema,
} from "./publication.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
const timestamp = "2026-09-07T12:00:00.000Z";
const actor = { issuer: "local", subject: "operator-1" };
const absent: RepositoryPublicationPolicy = {
  schemaVersion: "RepositoryPublicationPolicyV1",
  repositoryId: "repository-1",
  version: 0,
  enabled: false,
  updatedAt: null,
  updatedBy: null,
};
const policy: RepositoryPublicationPolicy = {
  ...absent,
  version: 1,
  enabled: true,
  updatedAt: timestamp,
  updatedBy: actor,
};
const audit: RepositoryPublicationPolicyAuditEvent = {
  schemaVersion: "RepositoryPublicationPolicyAuditEventV1",
  id: "audit-1",
  repositoryId: "repository-1",
  changeId: "policy-change-1",
  actor,
  previousVersion: 0,
  version: 1,
  previousSnapshot: absent,
  snapshot: policy,
  createdAt: timestamp,
};
const binding = {
  repositoryId: "repository-1",
  reviewRunId: "run-1",
  workItemId: "work-item-1",
  selectedDecisionId: "decision-3",
  selectedDecisionVersion: 3,
  decisionContextVersion: 5,
  revisionKey: "a".repeat(64),
  planDigest: "b".repeat(64),
  resultSetDigest: "c".repeat(64),
};
const target = {
  githubRepositoryId: 123,
  githubWorkItemId: 456,
  fullName: "example/project",
  number: 7,
  kind: "pull_request",
} as const;
const payload: PublicationPayload = {
  kind: "pull_request_review",
  commitId: "d".repeat(40),
  event: "COMMENT",
  body: "Exact review report.\n\n<!-- publication marker -->",
};
const preview: PublicationPreview = {
  schemaVersion: "PublicationPreviewV1",
  publicationId: "publication-1",
  rendererVersion: "publication-renderer-v1",
  binding,
  target,
  payload,
  payloadSha256: "e".repeat(64),
  semanticSha256: "f".repeat(64),
  observedAt: timestamp,
  policyVersion: 1,
  publisherAvailability: "available",
  publisherGitHubUserId: 22,
  blockers: [],
  canConfirm: true,
  existingIntent: null,
};
const intent: PublicationIntent = {
  schemaVersion: "PublicationIntentV1",
  publicationId: preview.publicationId,
  rendererVersion: preview.rendererVersion,
  binding,
  target,
  payload,
  payloadSha256: "e".repeat(64),
  semanticSha256: "f".repeat(64),
  publisherGitHubUserId: 22,
  policyVersion: 1,
  actor,
  createdAt: timestamp,
  confirmationChangeId: "confirm-1",
  decision: {
    id: binding.selectedDecisionId,
    repositoryId: binding.repositoryId,
    reviewRunId: binding.reviewRunId,
    workItemId: binding.workItemId,
    workItemKind: "pull_request",
    changeId: "decision-change-3",
    actor,
    previousVersion: 2,
    version: 3,
    createdAt: timestamp,
    reason: "Record an exact comment.",
    revisionKey: binding.revisionKey,
    planDigest: binding.planDigest,
    resultSetDigest: binding.resultSetDigest,
    supersedesDecisionId: null,
    targetDecisionId: null,
    action: "comment",
    policyAtDecision: {
      policyVersion: "required-checks-and-p0-p1-v1",
      applicable: true,
      eligible: true,
      blockingFindingCount: 0,
      reasonCount: 0,
      reasonCodes: [],
      reasonCodesTruncated: false,
    },
  },
};
const confirmation: PublicationConfirmRequest = {
  changeId: intent.confirmationChangeId,
  publicationId: intent.publicationId,
  rendererVersion: intent.rendererVersion,
  expectedSelectedDecisionId: binding.selectedDecisionId,
  expectedSelectedDecisionVersion: 3,
  expectedDecisionContextVersion: 5,
  expectedPolicyVersion: 1,
  expectedPublisherGitHubUserId: 22,
  expectedRevisionKey: binding.revisionKey,
  expectedPlanDigest: binding.planDigest,
  expectedResultSetDigest: binding.resultSetDigest,
  expectedPayloadSha256: intent.payloadSha256,
};
const delivery: PublicationDelivery = {
  schemaVersion: "PublicationDeliveryV1",
  publicationId: intent.publicationId,
  version: 1,
  status: "pending",
  attemptCount: 0,
  failure: null,
  remoteReceipt: null,
  updatedAt: timestamp,
};
const detail: PublicationDetail = { schemaVersion: "PublicationDetailV1", intent, delivery };
const receipt: PublicationRemoteReceipt = {
  kind: "pull_request_review",
  githubId: 33,
  htmlUrl: "https://github.com/example/project/pull/7#pullrequestreview-33",
  createdAt: timestamp,
  publisherGitHubUserId: 22,
  commitId: "d".repeat(40),
  event: "COMMENT",
};
const attempt: PublicationAttempt = {
  schemaVersion: "PublicationAttemptV1",
  id: "attempt-event-1",
  publicationId: intent.publicationId,
  attemptNumber: 1,
  kind: "delivery",
  phase: "preflight",
  publisherGitHubUserId: 22,
  createdAt: timestamp,
  outcome: null,
  failure: null,
  remoteReceipt: null,
};
const summary: PublicationSummary = {
  schemaVersion: "PublicationSummaryV1",
  publicationId: intent.publicationId,
  repositoryId: binding.repositoryId,
  reviewRunId: binding.reviewRunId,
  workItemId: binding.workItemId,
  selectedDecisionId: binding.selectedDecisionId,
  selectedDecisionVersion: binding.selectedDecisionVersion,
  rendererVersion: intent.rendererVersion,
  target,
  payloadSha256: intent.payloadSha256,
  publisherGitHubUserId: 22,
  actor,
  createdAt: timestamp,
  delivery,
};

describe("separate publication policy and immutable history", () => {
  it("represents an absent policy only as disabled version zero without invented attribution", () => {
    expect(Value.Check(RepositoryPublicationPolicySchema, absent)).toBe(true);
    expect(Value.Check(RepositoryPublicationPolicySchema, policy)).toBe(true);
    expect(getRepositoryPublicationPolicyIssues(absent)).toEqual([]);
    for (const invalid of [
      { ...absent, enabled: true },
      { ...absent, updatedAt: timestamp },
      { ...absent, updatedBy: actor },
      { ...policy, updatedBy: null },
      { ...policy, updatedAt: null },
      { ...policy, token: "private" },
    ])
      expect(Value.Check(RepositoryPublicationPolicySchema, invalid)).toBe(false);
  });
  it("requires actor-bound change identity and CAS without accepting server-owned fields", () => {
    const request = { changeId: "change-1", expectedVersion: 0, enabled: true };
    expect(Value.Check(RepositoryPublicationPolicyUpdateRequestSchema, request)).toBe(true);
    for (const key of Object.keys(request)) {
      const incomplete: Record<string, unknown> = { ...request };
      delete incomplete[key];
      expect(Value.Check(RepositoryPublicationPolicyUpdateRequestSchema, incomplete)).toBe(false);
    }
    for (const extra of [
      { actor },
      { repositoryId: "repository-1" },
      { updatedAt: timestamp },
      { token: "private" },
    ])
      expect(
        Value.Check(RepositoryPublicationPolicyUpdateRequestSchema, { ...request, ...extra }),
      ).toBe(false);
  });
  it("binds old and new audit snapshots to exact repository, versions, time and actor", () => {
    expect(Value.Check(RepositoryPublicationPolicyAuditEventSchema, audit)).toBe(true);
    expect(getRepositoryPublicationPolicyAuditEventIssues(audit)).toEqual([]);
    expect(
      getRepositoryPublicationPolicyAuditEventIssues({ ...audit, repositoryId: "foreign" }),
    ).toContain("policy_scope_mismatch");
    expect(
      getRepositoryPublicationPolicyAuditEventIssues({ ...audit, previousVersion: 1 }),
    ).toContain("policy_version_mismatch");
    expect(
      getRepositoryPublicationPolicyAuditEventIssues({
        ...audit,
        actor: { ...actor, subject: "foreign" },
      }),
    ).toContain("policy_attribution_mismatch");
    expect(
      getRepositoryPublicationPolicyAuditEventIssues({
        ...audit,
        createdAt: "2026-09-07T12:00:00Z",
      }),
    ).toContain("invalid_audit_time");
  });
});

describe("exact publication previews and frozen confirmation", () => {
  it("keeps selected immutable decision version separate from confirmation context CAS", () => {
    expect(Value.Check(PublicationPreviewSchema, preview)).toBe(true);
    expect(
      getPublicationPreviewIssues(preview, {
        repositoryId: binding.repositoryId,
        reviewRunId: binding.reviewRunId,
        decisionId: binding.selectedDecisionId,
      }),
    ).toEqual([]);
    expect(Value.Check(PublicationConfirmRequestSchema, confirmation)).toBe(true);
    expect(getPublicationConfirmRequestIssues(confirmation, preview)).toEqual([]);
    expect(getPublicationConfirmResponseIssues({ intent, replayed: true }, confirmation)).toEqual(
      [],
    );
    expect(
      getPublicationConfirmResponseIssues(
        { intent: { ...intent, policyVersion: 2 }, replayed: true },
        confirmation,
      ),
    ).toContain("confirmation_receipt_mismatch");
    expect(
      getPublicationConfirmResponseIssues(
        { intent: { ...intent, confirmationChangeId: "foreign" }, replayed: false },
        confirmation,
      ),
    ).toContain("confirmation_receipt_mismatch");
    expect(
      getPublicationConfirmRequestIssues(
        { ...confirmation, expectedDecisionContextVersion: 3 },
        preview,
      ),
    ).toContain("confirmation_binding_mismatch");
    expect(
      getPublicationPreviewIssues({
        ...preview,
        binding: { ...binding, decisionContextVersion: 2 },
      }),
    ).toContain("decision_version_mismatch");
    expect(
      getPublicationPreviewIssues(preview, {
        repositoryId: "foreign",
        reviewRunId: binding.reviewRunId,
        decisionId: binding.selectedDecisionId,
      }),
    ).toContain("preview_scope_mismatch");
  });
  it.each([
    "body",
    "payload",
    "actor",
    "kind",
    "event",
    "commitId",
    "publisherGitHubUserId",
    "action",
  ])("rejects caller-controlled confirmation field %s", (field) => {
    expect(
      Value.Check(PublicationConfirmRequestSchema, { ...confirmation, [field]: "replacement" }),
    ).toBe(false);
  });
  it("freezes the numeric publisher identity and never confirms unavailable publishing", () => {
    expect(getPublicationPreviewIssues({ ...preview, publisherGitHubUserId: null })).toContain(
      "missing_publisher_identity",
    );
    expect(
      getPublicationConfirmRequestIssues(
        { ...confirmation, expectedPublisherGitHubUserId: 23 },
        preview,
      ),
    ).toContain("confirmation_binding_mismatch");
    const unavailable: PublicationPreview = {
      ...preview,
      publisherAvailability: "unavailable",
      publisherGitHubUserId: null,
      blockers: ["publisher_unavailable"],
      canConfirm: false,
    };
    expect(getPublicationPreviewIssues(unavailable)).toEqual([]);
    expect(getPublicationPreviewIssues({ ...unavailable, canConfirm: true })).toContain(
      "preview_confirmation_mismatch",
    );
    expect(getPublicationPreviewIssues({ ...unavailable, blockers: [] })).toContain(
      "publisher_availability_mismatch",
    );
  });
  it("requires all payload digests or an explicit render blocker and preserves existing intent identity", () => {
    const unavailable: PublicationPreview = {
      ...preview,
      payload: null,
      payloadSha256: null,
      semanticSha256: null,
      blockers: ["payload_oversized"],
      canConfirm: false,
    };
    expect(getPublicationPreviewIssues(unavailable)).toEqual([]);
    expect(
      getPublicationPreviewIssues({ ...unavailable, semanticSha256: intent.semanticSha256 }),
    ).toContain("preview_payload_nullability_mismatch");
    expect(getPublicationPreviewIssues({ ...unavailable, blockers: [] })).toContain(
      "missing_payload_blocker",
    );
    const existing: PublicationPreview = {
      ...preview,
      canConfirm: false,
      blockers: ["existing_publication"],
      existingIntent: {
        publicationId: intent.publicationId,
        deliveryVersion: 1,
        status: "pending",
        payloadSha256: intent.payloadSha256,
      },
    };
    expect(getPublicationPreviewIssues(existing)).toEqual([]);
    expect(
      getPublicationPreviewIssues({
        ...existing,
        existingIntent: {
          ...(existing.existingIntent as NonNullable<PublicationPreview["existingIntent"]>),
          publicationId: "foreign",
        },
      }),
    ).toContain("existing_publication_identity_mismatch");
  });
  it("keeps opaque digests and preview data out of arbitrary extra fields", () => {
    for (const extra of [
      { token: "private" },
      { fence: 1 },
      { rawCapabilities: {} },
      { reserved: true },
    ])
      expect(Value.Check(PublicationPreviewSchema, { ...preview, ...extra })).toBe(false);
    for (const field of [
      "binding",
      "publisherAvailability",
      "publisherGitHubUserId",
      "semanticSha256",
      "existingIntent",
    ]) {
      const incomplete: Record<string, unknown> = { ...preview };
      delete incomplete[field];
      expect(Value.Check(PublicationPreviewSchema, incomplete)).toBe(false);
    }
  });
});

describe("safe exact outgoing payloads", () => {
  it("separates PR review commit/event from Issue comment bodies", () => {
    const issue: PublicationPayload = { kind: "issue_comment", body: "Issue report." };
    expect(Value.Check(PublicationPayloadSchema, payload)).toBe(true);
    expect(Value.Check(PublicationPayloadSchema, issue)).toBe(true);
    for (const extra of [{ event: "APPROVE" }, { commitId: "d".repeat(40) }, { kind: "check_run" }])
      expect(Value.Check(PublicationPayloadSchema, { ...issue, ...extra })).toBe(false);
    expect(getPublicationPayloadIssues(issue, target)).toEqual(["payload_target_mismatch"]);
    expect(getPublicationPayloadIssues(payload, { ...target, kind: "issue" })).toEqual([
      "payload_target_mismatch",
    ]);
  });
  it("measures body bytes rather than UTF-16 length and permits explicit paragraphs", () => {
    expect(
      getPublicationPayloadIssues({
        ...payload,
        body: "x".repeat(maximumPublicationBodyUtf8Bytes),
      }),
    ).toEqual([]);
    expect(getPublicationPayloadIssues({ ...payload, body: "\u754c".repeat(20_000) })).toEqual([]);
    expect(getPublicationPayloadIssues({ ...payload, body: "\u754c".repeat(20_001) })).toContain(
      "publication_body_too_large",
    );
    expect(getPublicationPayloadIssues({ ...payload, body: "Heading\r\n\tDetails" })).toEqual([]);
  });
  it.each(["\u0000", "\u0001", "\u007f", "\u0085", "\u202e", "\u2066", "\ud800"])(
    "rejects unsupported controls or malformed Unicode %j",
    (part) => {
      expect(getPublicationPayloadIssues({ ...payload, body: `Report ${part} end.` })).toContain(
        "invalid_publication_body",
      );
      expect(
        getPublicationIntentIssues({ ...intent, actor: { ...actor, subject: `operator${part}` } }),
      ).toContain("invalid_actor");
    },
  );
  it("retains the selected decision's full immutable binding", () => {
    expect(Value.Check(PublicationIntentSchema, intent)).toBe(true);
    expect(getPublicationIntentIssues(intent)).toEqual([]);
    for (const changes of [
      { id: "foreign" },
      { version: 4 },
      { repositoryId: "foreign" },
      { workItemId: "foreign" },
      { resultSetDigest: "0".repeat(64) },
    ])
      expect(
        getPublicationIntentIssues({ ...intent, decision: { ...intent.decision, ...changes } }),
      ).toContain("decision_binding_mismatch");
    expect(
      getPublicationIntentIssues({
        ...intent,
        decision: { ...intent.decision, action: "withdraw", targetDecisionId: "decision-1" },
      }),
    ).toContain("withdrawal_not_publishable");
    expect(
      getPublicationIntentIssues({
        ...intent,
        decision: { ...intent.decision, reason: "Hidden\u0000text" },
      }),
    ).toContain("invalid_decision_text");
  });
  it("maps ordinary decisions to explicit review events and labels qualified exceptions", () => {
    if (
      intent.payload.kind !== "pull_request_review" ||
      intent.decision.workItemKind !== "pull_request"
    )
      throw new Error("A PR fixture is required.");
    for (const [action, event] of [
      ["approve", "APPROVE"],
      ["request_changes", "REQUEST_CHANGES"],
      ["comment", "COMMENT"],
    ] as const) {
      const value: PublicationIntent = {
        ...intent,
        decision: { ...intent.decision, action, targetDecisionId: null },
        payload: { ...intent.payload, event },
      };
      expect(getPublicationIntentIssues(value)).toEqual([]);
      expect(
        getPublicationIntentIssues({
          ...value,
          payload: { ...intent.payload, event: event === "COMMENT" ? "APPROVE" : "COMMENT" },
        }),
      ).toContain("decision_review_event_mismatch");
    }
    const override: PublicationIntent = {
      ...intent,
      decision: { ...intent.decision, action: "override_approve", targetDecisionId: null },
      payload: {
        ...intent.payload,
        event: "COMMENT",
        body: "Qualified approval exception: required checks remain blocked.",
      },
    };
    expect(getPublicationIntentIssues(override)).toEqual([]);
    expect(getPublicationIntentIssues({ ...override, payload: intent.payload })).toContain(
      "missing_qualified_approval_notice",
    );
    expect(
      getPublicationIntentIssues({ ...override, payload: { ...intent.payload, event: "APPROVE" } }),
    ).toContain("decision_review_event_mismatch");
    expect(
      getPublicationIntentIssues({
        ...override,
        payload: { ...intent.payload, body: "Unqualified exception." },
      }),
    ).toContain("missing_qualified_approval_notice");
    expect(
      getPublicationIntentIssues({
        ...intent,
        decision: {
          ...intent.decision,
          action: "approve",
          targetDecisionId: null,
          policyAtDecision: {
            ...intent.decision.policyAtDecision,
            applicable: true,
            eligible: false,
          },
        },
        payload: { ...intent.payload, event: "APPROVE" },
      }),
    ).toContain("approval_policy_not_satisfied");
  });
  it("retains Issue comment semantics without permitting approval", () => {
    const issue: PublicationIntent = {
      ...intent,
      target: { ...target, kind: "issue" },
      payload: { kind: "issue_comment", body: "Issue investigation report." },
      decision: {
        ...intent.decision,
        workItemKind: "issue",
        action: "comment",
        targetDecisionId: null,
        policyAtDecision: {
          ...intent.decision.policyAtDecision,
          applicable: false,
          eligible: null,
        },
      },
    };
    expect(Value.Check(PublicationIntentSchema, issue)).toBe(true);
    expect(getPublicationIntentIssues(issue)).toEqual([]);
    expect(
      Value.Check(PublicationIntentSchema, {
        ...issue,
        decision: { ...issue.decision, action: "approve" },
      }),
    ).toBe(false);
  });
});

describe("delivery certainty, receipts and append-only attempt phases", () => {
  it.each([
    "pending",
    "delivering",
    "published",
    "failed",
    "blocked",
    "unknown",
    "cancelled",
  ] as const)("checks %s outcome nullability", (status) => {
    const value: PublicationDelivery = {
      ...delivery,
      status,
      attemptCount: status === "pending" ? 0 : 1,
      failure: ["failed", "blocked", "unknown"].includes(status)
        ? {
            code: status === "unknown" ? "ambiguous_delivery" : "preflight_failed",
            message: "The recorded attempt did not complete.",
          }
        : null,
      remoteReceipt: status === "published" ? receipt : null,
    };
    expect(Value.Check(PublicationDeliverySchema, value)).toBe(true);
    expect(getPublicationDeliveryIssues(value)).toEqual([]);
    expect(
      getPublicationDeliveryIssues({
        ...value,
        remoteReceipt: status === "published" ? null : receipt,
      }),
    ).toContain("receipt_status_mismatch");
  });
  it("never turns an unknown send into a definite failure or an automatic retry", () => {
    const unknown: PublicationDelivery = {
      ...delivery,
      version: 4,
      status: "unknown",
      attemptCount: 1,
      failure: { code: "ambiguous_delivery", message: "The request outcome is unknown." },
    };
    expect(getPublicationDeliveryIssues({ ...unknown, status: "failed" })).toContain(
      "failure_certainty_mismatch",
    );
    expect(getPublicationDeliveryIssues({ ...unknown, attemptCount: 0 })).toContain(
      "missing_delivery_attempt",
    );
    const control = {
      changeId: "change-1",
      expectedVersion: 4,
      expectedPayloadSha256: intent.payloadSha256,
    };
    expect(
      getPublicationControlRequestIssues(control, { ...detail, delivery: unknown }, "reconcile"),
    ).toEqual([]);
    for (const action of ["retry", "cancel"] as const)
      expect(
        getPublicationControlRequestIssues(control, { ...detail, delivery: unknown }, action),
      ).toContain("control_state_not_allowed");
    const failed: PublicationDetail = {
      ...detail,
      delivery: {
        ...unknown,
        status: "failed",
        failure: { code: "github_rejected", message: "The upstream rejected creation." },
      },
    };
    expect(getPublicationControlRequestIssues(control, failed, "retry")).toEqual([]);
  });
  it("pins remote receipts to exact target, account, revision and event", () => {
    expect(Value.Check(PublicationRemoteReceiptSchema, receipt)).toBe(true);
    expect(getPublicationRemoteReceiptIssues(receipt, target, 22, payload)).toEqual([]);
    expect(
      getPublicationRemoteReceiptIssues(
        { ...receipt, publisherGitHubUserId: 23 },
        target,
        22,
        payload,
      ),
    ).toContain("remote_publisher_mismatch");
    expect(
      getPublicationRemoteReceiptIssues(
        { ...receipt, htmlUrl: "https://github.com/foreign/project/pull/7#pullrequestreview-33" },
        target,
        22,
        payload,
      ),
    ).toContain("remote_target_url_mismatch");
    if (receipt.kind !== "pull_request_review") throw new Error("A PR receipt is required.");
    expect(
      getPublicationRemoteReceiptIssues(
        { ...receipt, commitId: "0".repeat(40) },
        target,
        22,
        payload,
      ),
    ).toContain("remote_payload_mismatch");
    expect(
      Value.Check(PublicationRemoteReceiptSchema, {
        ...receipt,
        htmlUrl: "https://example.com/steal",
      }),
    ).toBe(false);
    expect(
      getPublicationDetailIssues({
        ...detail,
        delivery: { ...delivery, status: "published", attemptCount: 1, remoteReceipt: receipt },
      }),
    ).toEqual([]);
    expect(
      getPublicationDetailIssues({
        ...detail,
        delivery: { ...delivery, publicationId: "foreign" },
      }),
    ).toContain("delivery_scope_mismatch");
    expect(Value.Check(PublicationDetailSchema, detail)).toBe(true);
  });
  it("distinguishes GET reconciliation history and forbids a reconciliation send phase", () => {
    expect(Value.Check(PublicationAttemptSchema, attempt)).toBe(true);
    expect(getPublicationAttemptIssues(attempt, intent.publicationId, 22)).toEqual([]);
    expect(Value.Check(PublicationAttemptSchema, { ...attempt, kind: "reconciliation" })).toBe(
      true,
    );
    expect(
      Value.Check(PublicationAttemptSchema, {
        ...attempt,
        kind: "reconciliation",
        phase: "sending",
      }),
    ).toBe(false);
    const reconciled: PublicationAttempt = {
      ...attempt,
      kind: "reconciliation",
      phase: "outcome",
      outcome: "unknown",
      failure: {
        code: "reconciliation_no_match",
        message: "A complete read found no matching publication.",
      },
      remoteReceipt: null,
    };
    expect(getPublicationAttemptIssues(reconciled)).toEqual([]);
    expect(getPublicationAttemptIssues({ ...reconciled, outcome: "failed" })).toContain(
      "reconciliation_outcome_mismatch",
    );
    for (const extra of [
      { token: "private" },
      { fence: 4 },
      { leaseToken: "private" },
      { workerId: "private" },
    ])
      expect(Value.Check(PublicationAttemptSchema, { ...attempt, ...extra })).toBe(false);
  });
  it("binds action receipts to exact CAS versions and immutable payload identity", () => {
    const change: PublicationControlReceipt = {
      schemaVersion: "PublicationControlReceiptV1",
      id: "control-1",
      changeId: "cancel-1",
      publicationId: intent.publicationId,
      repositoryId: binding.repositoryId,
      action: "cancel",
      actor,
      previousVersion: 1,
      version: 2,
      payloadSha256: intent.payloadSha256,
      createdAt: timestamp,
      delivery: { ...delivery, version: 2, status: "cancelled" },
    };
    expect(getPublicationControlReceiptIssues(change)).toEqual([]);
    const originalRequest = {
      changeId: change.changeId,
      expectedVersion: change.previousVersion,
      expectedPayloadSha256: change.payloadSha256,
    };
    expect(
      getPublicationControlResponseIssues(
        { change, replayed: true },
        undefined,
        originalRequest,
        "cancel",
      ),
    ).toEqual([]);
    expect(
      getPublicationControlResponseIssues(
        { change, replayed: true },
        undefined,
        { ...originalRequest, expectedPayloadSha256: "0".repeat(64) },
        "cancel",
      ),
    ).toContain("control_receipt_mismatch");
    expect(getPublicationControlReceiptIssues({ ...change, action: "retry" })).toContain(
      "control_outcome_mismatch",
    );
    expect(getPublicationControlReceiptIssues({ ...change, version: 3 })).toContain(
      "control_version_mismatch",
    );
    for (const extra of [
      { action: "retry" },
      { body: "replacement" },
      { actor },
      { force: true },
      { resendUnknown: true },
    ])
      expect(
        Value.Check(PublicationControlRequestSchema, {
          changeId: "change-1",
          expectedVersion: 1,
          expectedPayloadSha256: intent.payloadSha256,
          ...extra,
        }),
      ).toBe(false);
  });
});

describe("bounded repository-scoped publication reads", () => {
  it("requires exact scope and defaults to twenty with a hard maximum of fifty", () => {
    expect(defaultPublicationPageSize).toBe(20);
    expect(maximumPublicationPageSize).toBe(50);
    for (const schema of [
      PublicationListQuerySchema,
      RepositoryPublicationPolicyAuditListQuerySchema,
    ]) {
      expect(Value.Check(schema, { repositoryId: binding.repositoryId })).toBe(true);
      for (const pageSize of [0, 1.5, 51, "20"])
        expect(Value.Check(schema, { repositoryId: binding.repositoryId, pageSize })).toBe(false);
      expect(Value.Check(schema, { repositoryId: binding.repositoryId, pageSize: 50 })).toBe(true);
      expect(Value.Check(schema, {})).toBe(false);
    }
    expect(
      Value.Check(PublicationPreviewQuerySchema, {
        repositoryId: binding.repositoryId,
        reviewRunId: binding.reviewRunId,
        decisionId: binding.selectedDecisionId,
      }),
    ).toBe(true);
    expect(Value.Check(PublicationReadQuerySchema, { publicationId: intent.publicationId })).toBe(
      false,
    );
    expect(
      Value.Check(PublicationAttemptListQuerySchema, {
        repositoryId: binding.repositoryId,
        publicationId: intent.publicationId,
      }),
    ).toBe(true);
    expect(
      Value.Check(RepositoryPublicationPolicyAuditReadQuerySchema, {
        repositoryId: binding.repositoryId,
        eventId: audit.id,
      }),
    ).toBe(true);
    for (const repositoryId of ["repository-1\n", "repository-1\u0000", "../repository-1"])
      expect(
        Value.Check(PublicationReadQuerySchema, {
          repositoryId,
          publicationId: intent.publicationId,
        }),
      ).toBe(false);
  });
  it("validates complete scoped pages while keeping outgoing bodies out of summaries", () => {
    const page = {
      repositoryId: binding.repositoryId,
      items: [summary],
      total: 1,
      page: 1,
      pageSize: 20,
    };
    expect(Value.Check(PublicationListResponseSchema, page)).toBe(true);
    expect(getPublicationListIssues(page, { repositoryId: binding.repositoryId })).toEqual([]);
    expect(getPublicationListIssues({ ...page, items: [] })).toContain("invalid_page_count");
    expect(
      getPublicationListIssues({ ...page, items: [{ ...summary, repositoryId: "foreign" }] }),
    ).toContain("summary_scope_mismatch");
    expect(
      getPublicationListIssues(page, {
        repositoryId: binding.repositoryId,
        reviewRunId: "foreign",
      }),
    ).toContain("list_run_mismatch");
    expect(
      Value.Check(PublicationListResponseSchema, {
        ...page,
        items: [{ ...summary, body: payload.body }],
      }),
    ).toBe(false);
    expect(
      Value.Check(PublicationListResponseSchema, {
        ...page,
        items: Array.from({ length: 51 }, () => summary),
      }),
    ).toBe(false);
    const attempts = {
      repositoryId: binding.repositoryId,
      publicationId: intent.publicationId,
      items: [attempt],
      total: 1,
      page: 1,
      pageSize: 20,
    };
    expect(Value.Check(PublicationAttemptListResponseSchema, attempts)).toBe(true);
    expect(getPublicationAttemptListIssues(attempts, undefined, 22)).toEqual([]);
    expect(
      getPublicationAttemptListIssues({
        ...attempts,
        items: [{ ...attempt, publicationId: "foreign" }],
      }),
    ).toContain("attempt_scope_mismatch");
    expect(
      getPublicationAttemptListIssues({ ...attempts, total: 2, items: [attempt, attempt] }),
    ).toContain("duplicate_page_entry");
    const audits = {
      repositoryId: binding.repositoryId,
      items: [audit],
      total: 1,
      page: 1,
      pageSize: 20,
    };
    expect(getRepositoryPublicationPolicyAuditListIssues(audits)).toEqual([]);
    expect(
      getRepositoryPublicationPolicyAuditListIssues({ ...audits, repositoryId: "foreign" }),
    ).toContain("policy_audit_scope_mismatch");
  });
  it("bounds encoded response bytes even when individual audit fields fit their schemas", () => {
    const largeActor = { issuer: "\u754c".repeat(2_048), subject: "\u754c".repeat(512) };
    const items = Array.from(
      { length: 50 },
      (_, index): RepositoryPublicationPolicyAuditEvent => ({
        ...audit,
        id: `audit-${index}`,
        actor: largeActor,
        previousVersion: index + 1,
        version: index + 2,
        previousSnapshot: { ...policy, version: index + 1, updatedBy: largeActor },
        snapshot: { ...policy, version: index + 2, updatedBy: largeActor },
      }),
    );
    expect(
      items.every((item) => Value.Check(RepositoryPublicationPolicyAuditEventSchema, item)),
    ).toBe(true);
    expect(
      getRepositoryPublicationPolicyAuditListIssues({
        repositoryId: binding.repositoryId,
        items,
        total: 50,
        page: 1,
        pageSize: 50,
      }),
    ).toContain("response_too_large");
  });
});
