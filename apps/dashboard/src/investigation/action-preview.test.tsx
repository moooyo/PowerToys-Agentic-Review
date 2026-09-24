import type {
  InvestigationActionIntentV1,
  InvestigationActionPayload,
} from "@agentic-review/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  actionExecutionAccess,
  actionGroupLabel,
  actionIntentMatchesContext,
  assertActionPreparationBindings,
  ExactActionPreview,
  PublicationMarkdown,
  publicationActionLabel,
} from "./action-panel";
import { createSampleInvestigationApi } from "./sample-adapter";

function preview(payload: InvestigationActionPayload): InvestigationActionIntentV1 {
  return {
    schemaVersion: "InvestigationActionIntentV1",
    id: "saved-intent",
    version: 4,
    idempotencyKey: "exact-request-key",
    action: "comment",
    repositoryId: "saved-repository",
    workItemId: "saved-work-item",
    actorId: "saved-actor",
    subjectRef: "saved-subject",
    expectedRevisionKey: "a".repeat(64),
    expectedHeadSha: "b".repeat(40),
    reportRef: { id: "saved-report", version: 3, digest: "c".repeat(64) },
    payload,
    payloadDigest: "d".repeat(64),
    state: "prepared",
    guards: [{ code: "live_write", satisfied: false, message: "Live writes are disabled." }],
    createdAt: "2026-09-20T00:00:00Z",
    confirmedAt: null,
    result: null,
  };
}

function readablePreview(payload: InvestigationActionPayload): string {
  // Check the readable view separately so a raw JSON disclosure cannot satisfy assertions.
  return renderToStaticMarkup(<ExactActionPreview intent={preview(payload)} />).split(
    "Raw server intent",
  )[0]!;
}

describe("exact saved action preview", () => {
  it("groups feedback, follow-up, and source management with direct final action names", () => {
    expect(actionGroupLabel("request-changes", false)).toBe("Review feedback");
    expect(actionGroupLabel("trigger-ci", false)).toBe("Follow-up");
    expect(actionGroupLabel("merge", false)).toBe("PR management");
    expect(actionGroupLabel("close", true)).toBe("Issue management");
    expect(publicationActionLabel("request-changes")).toBe("Request changes");
    expect(publicationActionLabel("comment")).toBe("Post comment");
  });

  it("renders review prose and numbered steps safely, including unfinished Markdown", () => {
    const text =
      "### Review\n\n**Keep settings** and `SaveAsync`.\n\n3. Preserve existing settings\n4. Verify cancellation\n\n- \n## \n<script>unsafe()</script>\n\n[unsafe](javascript:alert(1))";
    const html = renderToStaticMarkup(<PublicationMarkdown>{text}</PublicationMarkdown>);
    expect(html).toContain("<h4>Review</h4>");
    expect(html).toContain("<strong>Keep settings</strong>");
    expect(html).toContain("<code>SaveAsync</code>");
    expect(html).toContain('<ol start="3">');
    expect(html).toContain("<p>- </p>");
    expect(html).toContain("<p>## </p>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
  });

  it("formats feedback without altering the frozen submission payload", () => {
    const payload = {
      kind: "feedback" as const,
      body: "### Review\n\n- Keep the saved values",
      findingIds: [],
      drafts: [],
    };
    const original = structuredClone(payload);
    const intent = preview(payload);
    const html = renderToStaticMarkup(<ExactActionPreview intent={intent} />);
    expect(html).toContain("<h4>Review</h4>");
    expect(html).toContain("<li>Keep the saved values</li>");
    expect(html).toContain("Raw server intent");
    expect(intent.payload).toEqual(original);
  });

  it("requires task creation and repository execution for follow-up confirm and reconcile", () => {
    for (const action of ["start-task", "reviews.verify"] as const) {
      const user = {
        permissions: ["action:execute", "task:create"],
        actionCapabilities: [action],
        allowRepositoryExecution: true,
      };
      expect(actionExecutionAccess(user, action).allowed).toBe(true);
      const noCreate = actionExecutionAccess({ ...user, permissions: ["action:execute"] }, action);
      expect(noCreate.allowed).toBe(false);
      expect(noCreate.reason).toContain("Create investigations");
      const noExecution = actionExecutionAccess(
        { ...user, allowRepositoryExecution: false },
        action,
      );
      expect(noExecution.allowed).toBe(false);
      expect(noExecution.reason).toContain("repository execution");
      expect(actionExecutionAccess({ ...user, actionCapabilities: [] }, action).allowed).toBe(
        false,
      );
    }
    expect(
      actionExecutionAccess(
        {
          permissions: ["action:execute"],
          actionCapabilities: ["comment"],
          allowRepositoryExecution: false,
        },
        "comment",
      ).allowed,
    ).toBe(true);
  });
  it("shows text drafts once in the summary and suggestion text once inline", () => {
    const html = readablePreview({
      kind: "feedback",
      body: "Intro only once",
      findingIds: ["finding-text", "finding-code"],
      drafts: [
        { id: "text-draft", body: "Plain finding only once", suggestion: null },
        {
          id: "code-draft",
          body: "Inline finding only once",
          suggestion: {
            subjectRef: "source",
            path: "src/file.ts",
            startLine: 1,
            endLine: 1,
            headSha: "a".repeat(40),
            originalContentDigest: "b".repeat(64),
            replacement: "replacement();",
          },
        },
      ],
    });
    for (const text of ["Intro only once", "Plain finding only once", "Inline finding only once"])
      expect(html.split(text)).toHaveLength(2);
    expect(html).toContain("text-draft");
    expect(html).toContain("Inline comment 1");
    expect(html).toContain("replacement();");
  });
  it("renders the server feedback and complete suggestion binding without executing markup", () => {
    const html = readablePreview({
      kind: "feedback",
      body: "Server summary\n<script>unsafe()</script>",
      findingIds: ["finding-a", "finding-b"],
      drafts: [
        {
          id: "draft-a",
          body: "Full saved finding comment",
          suggestion: {
            subjectRef: "suggestion-subject",
            path: "src/example.ts",
            startLine: 12,
            endLine: 14,
            headSha: "e".repeat(40),
            originalContentDigest: "f".repeat(64),
            replacement: "first exact line\n  second exact line",
          },
        },
      ],
    });
    for (const value of [
      "Server summary",
      "finding-a",
      "finding-b",
      "draft-a",
      "Full saved finding comment",
      "suggestion-subject",
      "src/example.ts",
      "12–14",
      "e".repeat(40),
      "f".repeat(64),
      "first exact line\n  second exact line",
      "saved-repository",
      "saved-work-item",
      "exact-request-key",
      "Live writes are disabled.",
    ])
      expect(html).toContain(value);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("shows task, close, merge, workflow, pull request, and navigation payload fields", () => {
    const cases: [InvestigationActionPayload, string[]][] = [
      [
        {
          kind: "task",
          taskKind: "pr-verify",
          planRef: { id: "plan-a", version: 7, digest: "e".repeat(64) },
          sourceCommit: "f".repeat(40),
        },
        ["pr-verify", "plan-a", "Plan version", "e".repeat(64), "f".repeat(40)],
      ],
      [{ kind: "close", reason: "duplicate", duplicateNumber: 42 }, ["duplicate", "#42"]],
      [
        { kind: "close", reason: "not_planned", duplicateNumber: null },
        ["not_planned", "Original issue number", "None"],
      ],
      [
        { kind: "merge", method: "rebase", commitTitle: "Exact merge title\nwith second line" },
        ["rebase", "Exact merge title\nwith second line"],
      ],
      [
        {
          kind: "trigger-ci",
          workflowId: "checks.yml",
          ref: "refs/heads/verified",
          inputs: { first: "value one", second: "value two" },
        },
        ["checks.yml", "refs/heads/verified", "first", "value one", "second", "value two"],
      ],
      [
        {
          kind: "create-pr",
          branchSubjectRef: "remote-branch",
          title: "Saved title",
          body: "Saved body\nexact second line",
          baseBranch: "main",
          draft: false,
        },
        ["remote-branch", "Saved title", "Saved body\nexact second line", "main", "Open"],
      ],
      [
        {
          kind: "navigate",
          reportRef: { id: "linked-report", version: 5, digest: "e".repeat(64) },
          artifactRef: "artifact-a",
        },
        ["linked-report", "Version 5", "e".repeat(64), "artifact-a"],
      ],
    ];
    for (const [payload, expected] of cases) {
      const html = readablePreview(payload);
      for (const value of expected) expect(html).toContain(value);
    }
  });

  it("makes empty values explicit without substituting current form content", () => {
    expect(readablePreview({ kind: "merge", method: "squash", commitTitle: "" })).toContain(
      "No custom commit title.",
    );
    expect(readablePreview({ kind: "feedback", body: "", findingIds: [], drafts: [] })).toContain(
      "No additional comment.",
    );
    expect(
      readablePreview({ kind: "trigger-ci", workflowId: "checks.yml", ref: "main", inputs: {} }),
    ).toContain("No workflow inputs.");
    expect(readablePreview({ kind: "navigate", reportRef: null, artifactRef: null })).toContain(
      "None",
    );
  });

  it("invalidates confirmation when any frozen source or report binding changes", async () => {
    const api = createSampleInvestigationApi();
    const report = await api.exportReport("sample-pr-p1-report");
    const context = await api.actionContext(report.context.workItem.id, report.id);
    const intent = {
      ...preview({ kind: "feedback", body: "Saved body", findingIds: [], drafts: [] }),
      repositoryId: context.repositoryId,
      workItemId: context.workItemId,
      actorId: context.actor.id,
      expectedRevisionKey: context.target.revisionKey,
      expectedHeadSha: context.target.headSha,
      reportRef: context.reportRef,
    };
    expect(actionIntentMatchesContext(intent, context)).toBe(true);
    expect(actionIntentMatchesContext({ ...intent, actorId: "another-actor" }, context)).toBe(
      false,
    );
    expect(
      actionIntentMatchesContext({ ...intent, expectedRevisionKey: "e".repeat(64) }, context),
    ).toBe(false);
    expect(
      actionIntentMatchesContext({ ...intent, expectedHeadSha: "f".repeat(40) }, context),
    ).toBe(false);
    expect(
      actionIntentMatchesContext(
        { ...intent, reportRef: { ...context.reportRef!, digest: "e".repeat(64) } },
        context,
      ),
    ).toBe(false);
  });

  it("requires a source refresh before a fresh preparation and keeps immutable destination checks", async () => {
    const api = createSampleInvestigationApi();
    const report = await api.exportReport("sample-pr-p1-report");
    const item = await api.workItem(report.context.workItem.id);
    const context = await api.actionContext(item.id, report.id);
    expect(() => assertActionPreparationBindings(item, context, item, context)).not.toThrow();
    const changedItem = { ...item, subject: { ...item.subject, revisionKey: "e".repeat(64) } };
    const changedContext = {
      ...context,
      target: { ...context.target, revisionKey: "e".repeat(64) },
    };
    expect(() =>
      assertActionPreparationBindings(item, context, changedItem, changedContext),
    ).toThrow("source changed");
    expect(() =>
      assertActionPreparationBindings(item, context, changedItem, changedContext, true),
    ).not.toThrow();
    expect(() =>
      assertActionPreparationBindings(
        item,
        context,
        item,
        { ...context, actor: { ...context.actor, id: "another-actor" } },
        true,
      ),
    ).toThrow("destination and actor");
    expect(() =>
      assertActionPreparationBindings(
        item,
        context,
        item,
        { ...context, reportRef: { ...context.reportRef!, digest: "f".repeat(64) } },
        true,
      ),
    ).toThrow("destination and actor");
  });
});
