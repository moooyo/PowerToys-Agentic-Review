import { readFileSync } from "node:fs";
import { createInvestigationPreview } from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import {
  defaultAutomaticReplyTemplates,
  renderAutomaticReplyIdentity,
  renderAutomaticReplyParts,
  renderAutomaticReplySummaryParts,
} from "../../dist/investigation/auto-reply-template.js";
import {
  defaultE2eProgressReplyTemplates,
  defaultProgressReplyTemplates,
  type InvestigationProgressTrigger,
  type ProgressReplyStage,
  progressReplyOptionalTemplateTokens,
  progressReplyTemplateTokens,
  type RenderProgressReplyInput,
  renderProgressReply as renderVerifiedProgressReply,
  validateProgressReplyTemplate,
} from "../../dist/investigation/progress-reply-template.js";

const stages = ["received", "started", "failed", "completed"] as const;
const timestamp = "2026-09-18T12:00:00.000Z";
const publisher = { githubUserId: 201, githubLogin: "verified-publisher" };
const reportContent = (content: string) => {
  const identity = renderAutomaticReplyIdentity(undefined, publisher);
  return { identity, content, body: `${identity}\n\n${content}` };
};
const renderProgressReply = (input: Omit<RenderProgressReplyInput, "identity">) =>
  renderVerifiedProgressReply({ ...input, identity: publisher });
const trigger: InvestigationProgressTrigger = {
  eventName: "pull_request",
  actorUserId: 101,
  assigneeUserId: 102,
  actorLogin: "maintainer",
  assigneeLogin: "review-bot[bot]",
};
const render = (stage: ProgressReplyStage) =>
  renderProgressReply({
    stage,
    template: defaultProgressReplyTemplates[stage],
    trigger,
    updatedAt: timestamp,
    failure: "The investigation could not finish. A maintainer can review its status and retry.",
    result: reportContent(
      "## Conclusion\n\nNo blocking findings.\n\n<details>Full report</details>",
    ),
  });

describe("assignment progress reply templates", () => {
  it("bounds and sanitizes partial E2E records without relaxing completed-report publication", () => {
    const report = createInvestigationPreview("pr", {
      findingCount: 0,
      outcome: "interrupted",
    }).result;
    report.context.task.kind = "pr-e2e";
    report.report.loop.completedRounds = 0;
    report.report.loop.stopReason = "budget_exhausted";
    report.report.summary = "Investigation has not started.";
    report.context.e2e = {
      headSha: "b".repeat(40),
      buildIdentity: "Synthetic pinned build",
      cleanup: { confirmed: true, recordedAt: timestamp, summary: "Owned processes exited." },
      features: Array.from({ length: 20 }, (_, index) => ({
        id: `feature-${index}`,
        title: `Preview ${index} <script> @everyone ghp_abcdefghijklmnopqrstuvwxyz ${"\u754c".repeat(16_000)}`,
        paths: [],
        scenario: "Operate preview.",
        userVisible: true,
        outcome: "passed" as const,
        artifactRefs: [],
        limitations: [
          "token=private-value C:\\private\\worker.log",
          "\u754c".repeat(16_000),
          "Additional limitation",
        ],
        assertions: [
          {
            id: `assertion-${index}`,
            expected: "Preview opens.",
            observed: "Preview opened.",
            outcome: "passed" as const,
            evidenceRefs: [],
          },
        ],
      })),
    };
    const before = structuredClone(report);
    const input = {
      stage: "failed" as const,
      template: defaultE2eProgressReplyTemplates.failed,
      trigger: { ...trigger, eventName: "issue_comment" as const, commandCommentId: 903 },
      updatedAt: timestamp,
      report,
      failure: "The task exhausted its budget.",
      context: { mode: "e2e" as const, status: "interrupted" as const },
    };
    const body = renderProgressReply(input);
    expect(body).toContain("Task interrupted; partial E2E report");
    expect(body).toContain("Final analysis was not adopted");
    expect(body).toContain("Recorded features: 20 passed, 0 failed, 0 blocked, 0 not run");
    expect(body).toContain("Summary only: showing 8 of 20 recorded features");
    expect(body).toContain("Full assertions and limitations remain in the Dashboard report");
    expect(body).toContain("&lt;script&gt;");
    expect(body).toContain("credential omitted");
    expect(body).not.toMatch(/@everyone|<script>|ghp_|private-value|worker\.log/u);
    expect(body).not.toContain("Investigation has not started");
    expect(body).not.toContain("E2E runtime verification: Passed");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(20_000);
    expect(() =>
      renderAutomaticReplyParts(report, defaultAutomaticReplyTemplates.pullRequest, publisher),
    ).toThrow("completed, final, complete root");
    expect(() => renderAutomaticReplySummaryParts(report, publisher)).toThrow(
      "completed, final, complete root",
    );
    report.context.task.kind = "pr-review";
    const staticBody = renderProgressReply({
      ...input,
      report,
      trigger,
      context: { mode: "static", status: "interrupted" },
    });
    expect(staticBody).not.toContain("Recorded E2E results");
    report.context.task.kind = "pr-e2e";
    expect(report).toEqual(before);
  });

  it.each(["blocked", "failed"] as const)(
    "requests a new E2E run for a recorded %s execution",
    (state) => {
      const report = createInvestigationPreview("pr", { findingCount: 0 }).result;
      report.context.task.kind = "pr-e2e";
      report.outcome = state;
      report.context.e2e = {
        headSha: "b".repeat(40),
        buildIdentity: "Synthetic pinned build",
        features: [
          {
            id: "feature-runtime",
            title: "Preview",
            paths: [],
            scenario: "Open preview",
            userVisible: true,
            outcome: state,
            artifactRefs: [],
            limitations: ["Runtime prerequisite or behavior requires repair."],
            assertions: [
              {
                id: "assertion-runtime",
                expected: "Preview opens",
                observed: "Preview could not be verified",
                outcome: state,
                evidenceRefs: [],
              },
            ],
          },
        ],
        cleanup: { confirmed: true, recordedAt: timestamp, summary: "Owned processes exited." },
      };
      const input = {
        stage: "failed" as const,
        template: defaultE2eProgressReplyTemplates.failed,
        trigger: { ...trigger, eventName: "issue_comment" as const, commandCommentId: 901 },
        updatedAt: timestamp,
        report,
        failure: "The E2E task stopped before verification succeeded.",
        context: {
          mode: "e2e" as const,
          status: state,
          nextStep: "Resolve prerequisites and explicitly resume the task.",
        },
      };
      const before = structuredClone(report);
      const body = renderProgressReply(input);
      expect(body).toContain("request a new E2E run in a new PR comment");
      expect(body).toContain("mentioning the configured reviewer followed by the e2e command");
      expect(body).toContain(
        "Resuming this task only recovers and republishes its recorded result",
      );
      expect(body).not.toContain("explicitly resume the task");
      expect(report).toEqual(before);
      delete report.context.e2e;
      const beforeExecution = renderProgressReply(input);
      expect(beforeExecution).toContain("Resolve prerequisites and explicitly resume the task.");
      expect(beforeExecution).not.toContain("request a new E2E run");
    },
  );

  it("keeps result-delivery recovery distinct from rerunning a failed E2E test", () => {
    const report = createInvestigationPreview("pr", { findingCount: 0 }).result;
    report.context.task.kind = "pr-e2e";
    report.outcome = "failed";
    report.context.e2e = {
      headSha: "b".repeat(40),
      buildIdentity: "Synthetic pinned build",
      features: [
        {
          id: "feature-runtime",
          title: "Preview",
          paths: [],
          scenario: "Open preview",
          userVisible: true,
          outcome: "passed",
          artifactRefs: [],
          limitations: [],
          assertions: [
            {
              id: "assertion-runtime",
              expected: "Preview opens",
              observed: "Preview opened",
              outcome: "passed",
              evidenceRefs: [],
            },
          ],
        },
      ],
      cleanup: { confirmed: true, recordedAt: timestamp, summary: "Owned processes exited." },
    };
    const recovery = "Explicitly resume the task to recover report delivery.";
    const body = renderProgressReply({
      stage: "failed",
      template: defaultE2eProgressReplyTemplates.failed,
      trigger: { ...trigger, eventName: "issue_comment", commandCommentId: 902 },
      updatedAt: timestamp,
      report,
      failure: "Report delivery needs recovery.",
      context: { mode: "e2e", status: "failed", nextStep: recovery },
    });
    expect(body).toContain(recovery);
    expect(body).not.toContain("request a new E2E run");
  });

  it.each([
    ["pull_request", "Static review"],
    ["issues", "Static investigation"],
    ["issue_comment", "E2E verification"],
  ] as const)(
    "uses the task activity for %s status and saved default headings",
    (eventName, activity) => {
      const savedTemplate = JSON.parse(
        JSON.stringify(defaultProgressReplyTemplates.completed),
      ) as string;
      const legacyTemplate =
        "## Investigation completed\n\n{{trigger}}\n\nLast updated: {{updated_at}}\n\n{{result}}\n";
      for (const template of [savedTemplate, legacyTemplate]) {
        const body = renderProgressReply({
          stage: "completed",
          template,
          trigger: {
            ...trigger,
            eventName,
            ...(eventName === "issue_comment" ? { commandCommentId: 123 } : {}),
          },
          updatedAt: timestamp,
          result: reportContent("The recorded task is complete."),
        });
        expect(body).toContain(`**Status:** ${activity} completed`);
        expect(body).toContain(`## ${activity} completed`);
        expect(body).not.toContain("## Investigation completed");
      }
      expect(savedTemplate).toBe(defaultProgressReplyTemplates.completed);
      expect(legacyTemplate).toContain("## Investigation completed");
    },
  );

  it("preserves custom narrative headings while naming the system status by task activity", () => {
    const custom =
      "## Investigation completed by our custom workflow\n\n{{trigger}}\n\nUpdated: {{updated_at}}\n\n{{result}}";
    expect(validateProgressReplyTemplate(custom, "completed")).toBe(custom);
    const body = renderProgressReply({
      stage: "completed",
      template: custom,
      trigger,
      updatedAt: timestamp,
      result: reportContent("The recorded task is complete."),
    });
    expect(body).toContain("**Status:** Static review completed");
    expect(body).toContain("## Investigation completed by our custom workflow");
  });

  it("provides four frozen English templates with the required placeholders in order", () => {
    expect(Object.isFrozen(defaultProgressReplyTemplates)).toBe(true);
    expect(progressReplyTemplateTokens).toEqual({
      received: ["trigger", "updated_at"],
      started: ["trigger", "updated_at"],
      failed: ["trigger", "updated_at", "failure"],
      completed: ["trigger", "updated_at", "result"],
    });
    expect(progressReplyOptionalTemplateTokens).toEqual(["status", "usage"]);
    for (const stage of stages) {
      const template = defaultProgressReplyTemplates[stage];
      expect(validateProgressReplyTemplate(template, stage)).toBe(template);
      expect(render(stage)).toContain(
        `## Static review ${stage === "received" ? "received — preparing" : stage === "started" ? "running" : stage}`,
      );
      expect(
        readFileSync(
          new URL(`../../../../docs/templates/progress-reply-${stage}.md`, import.meta.url),
          "utf8",
        ).replaceAll("\r\n", "\n"),
      ).toBe(template);
      expect(render(stage).startsWith(renderAutomaticReplyIdentity(undefined, publisher))).toBe(
        true,
      );
      expect(render(stage)).toContain("This PR review was triggered when GitHub user maintainer");
      expect(render(stage)).toContain("assigned the pull request to GitHub user review-bot");
      expect(render(stage)).toContain(`Last updated: ${timestamp}`);
      expect(render(stage)).not.toContain("{{");
      expect(render(stage)).not.toContain("agentic-review-progress:");
    }
    expect(render("received")).toContain("assignment has been received");
    expect(render("received")).not.toContain("task has been queued");
    expect(render("started")).toContain("Work has started");
    expect(render("failed")).toContain("could not finish");
  });

  it.each(stages)(
    "requires every %s placeholder exactly once and in the documented order",
    (stage) => {
      const template = defaultProgressReplyTemplates[stage];
      const tokens = progressReplyTemplateTokens[stage];
      for (const token of tokens) {
        expect(() =>
          validateProgressReplyTemplate(template.replace(`{{${token}}}`, ""), stage),
        ).toThrow("exactly once");
        expect(() => validateProgressReplyTemplate(`${template}{{${token}}}`, stage)).toThrow(
          "exactly once",
        );
      }
      const reversed = [...tokens]
        .reverse()
        .map((token) => `{{${token}}}`)
        .join("\n");
      expect(() => validateProgressReplyTemplate(reversed, stage)).toThrow("in the order");
      for (const value of ["{{unknown}}", "{{ trigger }}", "{{TRIGGER}}", "{{}}"])
        expect(() => validateProgressReplyTemplate(`${template}${value}`, stage)).toThrow(
          "Unknown progress reply token",
        );
      for (const value of ["{{broken", "broken}}", "{{{trigger}}}"])
        expect(() => validateProgressReplyTemplate(`${template}${value}`, stage)).toThrow(
          "exact {{token}} syntax",
        );
    },
  );

  it("limits UTF-8 bytes and does not accept missing or unsupported stages", () => {
    const template = defaultProgressReplyTemplates.received;
    expect(() =>
      validateProgressReplyTemplate(template.padEnd(12_000, " "), "received"),
    ).not.toThrow();
    expect(() => validateProgressReplyTemplate(template.padEnd(12_001, " "), "received")).toThrow(
      "12000 UTF-8 bytes",
    );
    expect(() =>
      validateProgressReplyTemplate(`${template}${"é".repeat(6_000)}`, "received"),
    ).toThrow("12000 UTF-8 bytes");
    for (const value of [null, undefined, 5, "", "  "])
      expect(() => validateProgressReplyTemplate(value, "received")).toThrow("non-empty string");
    expect(() => validateProgressReplyTemplate(template, "unknown" as ProgressReplyStage)).toThrow(
      "supported lifecycle stage",
    );
  });

  it("describes issue assignments and falls back to exact numeric identities without mentions", () => {
    const body = renderProgressReply({
      stage: "received",
      template: defaultProgressReplyTemplates.received,
      trigger: {
        ...trigger,
        eventName: "issues",
        actorLogin: "@everyone\n<script>alert(1)</script>",
        assigneeLogin: "[click](https://example.com)",
      },
      updatedAt: timestamp,
    });
    expect(body).toContain("This issue investigation was triggered when GitHub user ID 101");
    expect(body).toContain("assigned the issue to GitHub user ID 102");
    expect(body).not.toMatch(/@everyone|<script>|https:\/\//u);
    expect(body).toContain("`@verified-publisher`");
    expect(body).not.toContain("on behalf of GitHub user `@maintainer`");
    for (const invalid of [{ actorUserId: 0 }, { assigneeUserId: -1 }, { eventName: "comment" }]) {
      expect(() =>
        renderProgressReply({
          stage: "received",
          template: defaultProgressReplyTemplates.received,
          trigger: { ...trigger, ...invalid } as InvestigationProgressTrigger,
          updatedAt: timestamp,
        }),
      ).toThrow("exact assignment or E2E command trigger identity");
    }
  });

  it("renders a separate E2E command identity and pinned pull request scope", () => {
    const e2eTrigger: InvestigationProgressTrigger = {
      ...trigger,
      eventName: "issue_comment",
      commandCommentId: 987,
    };
    const body = renderProgressReply({
      stage: "received",
      template: defaultE2eProgressReplyTemplates.received,
      trigger: e2eTrigger,
      updatedAt: timestamp,
      context: {
        mode: "e2e",
        status: "preparing",
        scope: { kind: "pull_request", headSha: "a".repeat(40) },
      },
    });
    expect(body).toContain("E2E verification received — preparing");
    expect(body).toContain("pull request comment 987");
    expect(body).toContain("Requested pull request revision");
    expect(body).toContain("separate comment tracks runtime verification");
    expect(body).not.toContain("assigned the");
    expect(body).not.toContain("Issue text");
    expect(() =>
      renderProgressReply({
        stage: "received",
        template: defaultE2eProgressReplyTemplates.received,
        trigger: { ...e2eTrigger, commandCommentId: 0 },
        updatedAt: timestamp,
      }),
    ).toThrow("exact assignment or E2E command trigger identity");
  });

  it("allows an optional usage placeholder without duplicating server accounting", () => {
    const template = `${defaultProgressReplyTemplates.failed}\n{{usage}}`;
    const body = renderProgressReply({
      stage: "failed",
      template,
      trigger,
      updatedAt: timestamp,
      context: { status: "cancelled" },
      failure: "The investigation was cancelled.",
    });
    expect(body.match(/\*\*Token usage:\*\*/gu)).toHaveLength(1);
    expect(body).toContain("Unavailable");
    expect(() => validateProgressReplyTemplate(`${template}\n{{usage}}`, "failed")).toThrow(
      "only once",
    );
  });

  it("keeps identity, status, scope, and next action outside editable narrative templates", () => {
    const body = renderProgressReply({
      stage: "started",
      template: "Custom narrative.\n\n{{trigger}}\n\nUpdated: {{updated_at}}",
      trigger,
      updatedAt: timestamp,
      context: { status: "running", attemptNumber: 2, phase: "investigation" },
    });
    expect(body.startsWith(renderAutomaticReplyIdentity(undefined, publisher))).toBe(true);
    expect(body).toContain("**Status:** Static review running");
    expect(body).toContain("**Source scope:**");
    expect(body).toContain("**Next action:**");
    expect(body).toContain("**Attempt:** 2");
    expect(body).toContain("**Recorded phase:** investigation");
    expect(() =>
      renderVerifiedProgressReply({
        stage: "received",
        template: defaultProgressReplyTemplates.received,
        trigger,
        updatedAt: timestamp,
      } as RenderProgressReplyInput),
    ).toThrow("verified GitHub user ID");
  });

  it("allows one optional status token before the required placeholders", () => {
    const template = defaultProgressReplyTemplates.started;
    expect(() =>
      validateProgressReplyTemplate(template.replace("## {{status}}\n\n", ""), "started"),
    ).not.toThrow();
    expect(() => validateProgressReplyTemplate(`${template}\n{{status}}`, "started")).toThrow(
      "only once",
    );
    expect(() =>
      validateProgressReplyTemplate(
        template.replace("## {{status}}\n\n", "") + "{{status}}",
        "started",
      ),
    ).toThrow("before the trigger");
    expect(() => validateProgressReplyTemplate(`${template}\n{{identity}}`, "started")).toThrow(
      "Unknown progress reply token",
    );
  });

  it.each([
    ["blocked", "Static review waiting for action", "resolve its recorded prerequisite"],
    ["interrupted", "Static review interrupted", "will not resume automatically"],
    ["cancelled", "Static review cancelled", "No automatic continuation"],
    ["failed", "Static review failed", "No automatic task retry is promised"],
  ] as const)("renders the attention layout truthfully for %s", (status, heading, nextAction) => {
    const body = renderProgressReply({
      stage: "failed",
      template: defaultProgressReplyTemplates.failed,
      trigger,
      updatedAt: timestamp,
      failure: "The recorded task state requires operator attention.",
      context: { status },
    });
    expect(body).toContain(`## ${heading}`);
    expect(body).toContain(nextAction);
    if (status !== "failed") expect(body).not.toContain("Static review failed");
  });

  it("normalizes only exact legacy built-in wording before preparing a new body", () => {
    const oldReceived =
      "## Investigation received\n\n{{trigger}}\n\nThe task has been queued and will begin as soon as a worker is available.\n\nLast updated: {{updated_at}}\n";
    const oldFailed =
      "## Investigation failed\n\n{{trigger}}\n\nLast updated: {{updated_at}}\n\n{{failure}}\n";
    expect(validateProgressReplyTemplate(oldReceived, "received")).toBe(
      defaultProgressReplyTemplates.received,
    );
    expect(validateProgressReplyTemplate(oldFailed.replaceAll("\n", "\r\n"), "failed")).toBe(
      defaultProgressReplyTemplates.failed,
    );
    const body = renderProgressReply({
      stage: "failed",
      template: oldFailed,
      trigger,
      updatedAt: timestamp,
      failure: "The investigation was cancelled.",
      context: { status: "cancelled" },
    });
    expect(body).not.toContain("Investigation failed");
    expect(body).toContain("Static review cancelled");
    const custom = "Custom received wording\n\n{{trigger}}\n\n{{updated_at}}";
    expect(validateProgressReplyTemplate(custom, "received")).toBe(custom);
  });

  it("shows recorded scope, resume attempt, timestamps, and a changed PR head accurately", () => {
    const headSha = "a".repeat(40);
    const currentHeadSha = "b".repeat(40);
    const body = renderProgressReply({
      stage: "received",
      template: defaultProgressReplyTemplates.received,
      trigger,
      updatedAt: timestamp,
      context: {
        status: "queued",
        attemptNumber: 1,
        queuedForResume: true,
        receivedAt: "2026-09-18T10:00:00Z",
        startedAt: "2026-09-18T11:00:00Z",
        scope: { kind: "pull_request", headSha, currentHeadSha },
      },
    });
    expect(body).toContain("Static review queued for resume");
    expect(body).toContain("**Attempt:** 1");
    expect(body).not.toContain("**Attempt:** 2");
    expect(body).toContain(headSha);
    expect(body).toContain(currentHeadSha);
    expect(body).toContain("does not cover that newer head");
    expect(body).toContain("**Received:** 2026-09-18T10:00:00.000Z");
    expect(body).toContain("**First started:** 2026-09-18T11:00:00.000Z");
    expect(() =>
      renderProgressReply({
        stage: "started",
        template: defaultProgressReplyTemplates.started,
        trigger,
        updatedAt: timestamp,
        context: { status: "cancelled" },
      }),
    ).toThrow("does not match");
  });

  it("uses only accepted execution records for the model identity before a report exists", () => {
    const body = renderProgressReply({
      stage: "started",
      template: defaultProgressReplyTemplates.started,
      trigger,
      updatedAt: timestamp,
      context: {
        status: "running",
        trustedModels: {
          completedRounds: 1,
          adoptedAttemptIds: ["attempt-1"],
          modelExecutions: [
            { attemptId: "attempt-1", round: 1, engine: "codex", model: "gpt-6-astra" },
          ],
        },
      },
    });
    expect(body.startsWith("I'm GPT-6 Astra, an AI assistant running through Agentic Review")).toBe(
      true,
    );
    expect(body).toContain("on behalf of GitHub user `@verified-publisher`");
    expect(render("received")).not.toContain("GPT-6 Astra");
  });

  it("embeds full or summary reports with the same verified identity exactly once", () => {
    const report = createInvestigationPreview("pr").result;
    const parts = renderAutomaticReplyParts(
      report,
      defaultAutomaticReplyTemplates.pullRequest,
      publisher,
    );
    for (const result of [parts, renderAutomaticReplySummaryParts(report, publisher)]) {
      const body = renderProgressReply({
        stage: "completed",
        template: defaultProgressReplyTemplates.completed,
        trigger,
        updatedAt: timestamp,
        result,
        report,
      });
      expect(body.startsWith(parts.identity)).toBe(true);
      expect(body.split(parts.identity)).toHaveLength(2);
      expect(body).toContain("Static review completed");
    }
    const anotherPublisher = renderAutomaticReplyParts(
      report,
      defaultAutomaticReplyTemplates.pullRequest,
      {
        githubUserId: 202,
        githubLogin: "different-publisher",
      },
    );
    for (const result of [
      anotherPublisher,
      { ...parts, body: parts.body.replace("## Conclusion", "## Other conclusion") },
    ]) {
      expect(() =>
        renderProgressReply({
          stage: "completed",
          template: defaultProgressReplyTemplates.completed,
          trigger,
          updatedAt: timestamp,
          result,
          report,
        }),
      ).toThrow("exact verified identity and structured report body");
    }
  });

  it("redacts private failure text and neutralizes Markdown, links, HTML, and notifications", () => {
    const body = renderProgressReply({
      stage: "failed",
      template: `${defaultProgressReplyTemplates.failed}\n@maintainer [unsafe](javascript:run()) <!-- agentic-review-progress:forged -->`,
      trigger,
      updatedAt: timestamp,
      failure: [
        "@everyone <script>run()</script> [link](https://example.com)",
        "C:\\Users\\worker\\private.log /home/worker/private.log",
        "ghp_abcdefghijklmnopqrstuvwxyz token=private-value Bearer bearer-secret",
        "https://localhost:3000/private https://user:password@example.com/private",
        "agentic-review-progress:forged-id",
      ].join("\n"),
    });
    expect(body).not.toContain("@everyone");
    expect(body).not.toContain("@maintainer");
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("ghp_");
    expect(body).not.toContain("private-value");
    expect(body).not.toContain("bearer-secret");
    expect(body).not.toContain("C:\\Users");
    expect(body).not.toContain("/home/worker");
    expect(body).not.toContain("https://localhost");
    expect(body).not.toContain("user:password");
    expect(body).not.toContain("agentic-review-progress:");
    expect(body).toContain("credential omitted");
    expect(body).toContain("local path omitted");
    expect(body).toContain("&lt;script&gt;");
    expect(body).toContain("\\[link\\]");
  });

  it.each([
    {
      failure: "/srv/private/srv-capture.png",
      expected: "\\[local path omitted\\]",
      privateNames: ["srv-capture.png"],
    },
    {
      failure: "/data/private/data-video.mp4",
      expected: "\\[local path omitted\\]",
      privateNames: ["data-video.mp4"],
    },
    {
      failure: "/custom-mount/private/custom-capture.png",
      expected: "\\[local path omitted\\]",
      privateNames: ["custom-capture.png"],
    },
    {
      failure: "Stopped (/srv/private/parenthesized-capture.png).",
      expected: "Stopped (\\[local path omitted\\]).",
      privateNames: ["parenthesized-capture.png"],
    },
    {
      failure: "Captured [/data/private/bracketed-video.mp4], retry.",
      expected: "Captured \\[\\[local path omitted\\]\\], retry.",
      privateNames: ["bracketed-video.mp4"],
    },
    {
      failure: "artifact=/custom-mount/private/keyed-capture.png; retry.",
      expected: "artifact=\\[local path omitted\\]; retry.",
      privateNames: ["keyed-capture.png"],
    },
    {
      failure: "artifact:/custom-mount/private/colon-video.mp4, retry.",
      expected: "artifact:\\[local path omitted\\], retry.",
      privateNames: ["colon-video.mp4"],
    },
    {
      failure: "/srv/private/first-capture.png,/data/private/second-video.mp4",
      expected: "\\[local path omitted\\],\\[local path omitted\\]",
      privateNames: ["first-capture.png", "second-video.mp4"],
    },
    {
      failure: "**/home/private/emphasized-capture.png**",
      expected: "\\*\\*\\[local path omitted\\]\\*\\*",
      privateNames: ["emphasized-capture.png"],
    },
    {
      failure: "<code>/srv/private/html-capture.png</code>",
      expected: "&lt;code&gt;\\[local path omitted\\]&lt;/code&gt;",
      privateNames: ["html-capture.png"],
    },
  ])(
    "redacts complete absolute POSIX paths in failed replies: $failure",
    ({ failure, expected, privateNames }) => {
      const body = renderProgressReply({
        stage: "failed",
        template: defaultProgressReplyTemplates.failed,
        trigger,
        updatedAt: timestamp,
        failure,
      });
      expect(body.endsWith(expected)).toBe(true);
      for (const privateName of privateNames) expect(body).not.toContain(privateName);
    },
  );

  it.each([
    ['"', "/srv/private workspace/double quoted capture.png"],
    ["'", "/data/private workspace/single quoted video.mp4"],
    ["`", "/custom-mount/private workspace/backtick capture.png"],
  ])("redacts the complete space-containing POSIX path quoted with %s", (quote, path) => {
    const body = renderProgressReply({
      stage: "failed",
      template: defaultProgressReplyTemplates.failed,
      trigger,
      updatedAt: timestamp,
      failure: `Captured ${quote}${path}${quote}; review required.`,
    });
    expect(body.endsWith("Captured \\[local path omitted\\]; review required.")).toBe(true);
    expect(body).not.toContain("private workspace");
    expect(body).not.toContain(path.slice(path.lastIndexOf("/") + 1));
  });

  it.each([
    ['"', '"'],
    ["'", "'"],
    ["`", "\\`"],
  ])("redacts a bare POSIX path after an unclosed %s quote", (quote, renderedQuote) => {
    const body = renderProgressReply({
      stage: "failed",
      template: defaultProgressReplyTemplates.failed,
      trigger,
      updatedAt: timestamp,
      failure: `Captured ${quote}/srv/private/unclosed-capture.png`,
    });
    expect(body.endsWith(`Captured ${renderedQuote}\\[local path omitted\\]`)).toBe(true);
    expect(body).not.toContain("unclosed-capture.png");
  });

  it("preserves relative source references and public URL paths and queries in failed replies", () => {
    const body = renderProgressReply({
      stage: "failed",
      template: defaultProgressReplyTemplates.failed,
      trigger,
      updatedAt: timestamp,
      failure: [
        "Inspect src/review.ts, ./src/worker.ts, and ../shared/contracts.ts.",
        "Inspect src/_/file.cs and src/*/file.cs.",
        "https://example.com/srv/public-capture.png?next=/data/public-video.mp4&home=/home/shared",
        "https://example.com/data/public-video.mp4?next=/srv/public-capture.png&home=/home/shared",
        "https://example.com/home/shared?next=/srv/public-capture.png&data=/data/public-video.mp4",
        "https://example.com/docs?next='/data/public/file'&home='/home/public/file'",
      ].join("\n"),
    });
    expect(body).toContain("src/review.ts");
    expect(body).toContain("./src/worker.ts");
    expect(body).toContain("../shared/contracts.ts");
    expect(body).toContain("src/\\_/file.cs");
    expect(body).toContain("src/\\*/file.cs");
    expect(body).toContain(
      "https\u200b://example.com/srv/public-capture.png?next=/data/public-video.mp4&amp;home=/home/shared",
    );
    expect(body).toContain(
      "https\u200b://example.com/data/public-video.mp4?next=/srv/public-capture.png&amp;home=/home/shared",
    );
    expect(body).toContain(
      "https\u200b://example.com/home/shared?next=/srv/public-capture.png&amp;data=/data/public-video.mp4",
    );
    expect(body).toContain(
      "https\u200b://example.com/docs?next='/data/public/file'&amp;home='/home/public/file'",
    );
    expect(body).not.toContain("local path omitted");
    expect(body).not.toContain("https://");
  });

  it("preserves the complete trusted report without escaping, substituting, or truncating it", () => {
    const report = `## Conclusion\n\n${"Full finding. ".repeat(5_000)}\n<details><summary>Details</summary>\n\n[Source](https://github.com/fixture/project/blob/abc/file.ts#L1)\n{{trigger}}\n</details>`;
    const body = renderProgressReply({
      stage: "completed",
      template: defaultProgressReplyTemplates.completed,
      trigger,
      updatedAt: timestamp,
      result: reportContent(report),
    });
    expect(body.endsWith(report)).toBe(true);
    expect(body).toContain("<details><summary>Details</summary>");
    expect(body).toContain("[Source](https://github.com/");
    expect(body.length).toBeGreaterThan(60_000);
  });

  it("requires a timestamp and the appropriate terminal outcome", () => {
    for (const stage of ["failed", "completed"] as const) {
      expect(() =>
        renderProgressReply({
          stage,
          template: defaultProgressReplyTemplates[stage],
          trigger,
          updatedAt: timestamp,
        }),
      ).toThrow(stage === "failed" ? "public failure description" : "full rendered report");
    }
    expect(() =>
      renderProgressReply({
        stage: "started",
        template: defaultProgressReplyTemplates.started,
        trigger,
        updatedAt: "not-a-timestamp",
      }),
    ).toThrow("valid timestamp");
  });
});
