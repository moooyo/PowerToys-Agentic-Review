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
  it("provides four frozen English templates with the required placeholders in order", () => {
    expect(Object.isFrozen(defaultProgressReplyTemplates)).toBe(true);
    expect(progressReplyTemplateTokens).toEqual({
      received: ["trigger", "updated_at"],
      started: ["trigger", "updated_at"],
      failed: ["trigger", "updated_at", "failure"],
      completed: ["trigger", "updated_at", "result"],
    });
    expect(progressReplyOptionalTemplateTokens).toEqual(["status"]);
    for (const stage of stages) {
      const template = defaultProgressReplyTemplates[stage];
      expect(validateProgressReplyTemplate(template, stage)).toBe(template);
      expect(render(stage)).toContain(
        `## ${stage === "received" ? "Investigation received — preparing" : stage === "started" ? "Investigation running" : `Investigation ${stage}`}`,
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
      ).toThrow("exact assignment trigger identity");
    }
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
    expect(body).toContain("**Status:** Investigation running");
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
    ["blocked", "Investigation waiting for action", "resolve its recorded prerequisite"],
    ["interrupted", "Investigation interrupted", "will not resume automatically"],
    ["cancelled", "Investigation cancelled", "No automatic continuation"],
    ["failed", "Investigation failed", "No automatic task retry is promised"],
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
    if (status !== "failed") expect(body).not.toContain("Investigation failed");
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
    expect(body).toContain("Investigation cancelled");
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
    expect(body).toContain("Investigation queued for resume");
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
      expect(body).toContain("Investigation completed");
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
