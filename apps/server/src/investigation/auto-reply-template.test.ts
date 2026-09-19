import { readFileSync } from "node:fs";
import {
  createInvestigationPreview,
  type InvestigationResultV1,
  type InvestigationUsageSummary,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import {
  type AutomaticReplyModelContext,
  automaticReplyResultWithoutIdentity,
  automaticReplyTemplateTokens,
  automaticReplyTemplateVersion,
  defaultAutomaticReplyTemplates,
  defaultE2eAutomaticReplyTemplate,
  renderAutomaticReply,
  renderAutomaticReplyIdentity,
  renderAutomaticReplyParts,
  renderAutomaticReplySummary,
  renderAutomaticReplySummaryParts,
  renderReplyTokenUsage,
  validateAutomaticReplyTemplate,
} from "../../dist/investigation/auto-reply-template.js";
import { InvestigationRequestError } from "../../dist/investigation/errors.js";

const tokenNames = ["identity", "conclusion", "summary", "findings", "details"];
const tokenTemplate = tokenNames.map((token) => `{{${token}}}`).join("\n\n");
const issueTokenNames = ["identity", "conclusion", "next_steps", "details"];
const issueTokenTemplate = issueTokenNames.map((token) => `{{${token}}}`).join("\n\n");
const verifiedIdentity = { githubUserId: 100, githubLogin: "moooyo" };
const preview = (kind: "pr" | "bug" | "feature" = "pr", findingCount?: number) =>
  createInvestigationPreview(kind, findingCount === undefined ? {} : { findingCount }).result;
const render = (report: InvestigationResultV1) =>
  renderAutomaticReply(
    report,
    report.context.workItem.kind === "pull_request"
      ? defaultAutomaticReplyTemplates.pullRequest
      : defaultAutomaticReplyTemplates.issue,
    verifiedIdentity,
  );
const renderParts = (report: InvestigationResultV1) =>
  renderAutomaticReplyParts(
    report,
    report.context.workItem.kind === "pull_request"
      ? defaultAutomaticReplyTemplates.pullRequest
      : defaultAutomaticReplyTemplates.issue,
    verifiedIdentity,
  );

function triageFixture(kind: "bug" | "feature" | "other", reason: string): InvestigationResultV1 {
  const report = preview(kind === "bug" ? "bug" : "feature");
  if (kind === "other") {
    report.assessment = {
      kind: "other_issue",
      subjectRef: report.context.task.subjectRef,
      summary: "A documentation question.",
      classification: "Documentation question",
      explanation: reason,
      evidenceRefs: [],
    };
  } else if (report.assessment.kind === "bug") {
    report.assessment.bugAssessment.rationale = reason;
  } else if (report.assessment.kind === "feature") {
    report.assessment.featureAssessment.feasibility = reason;
  }
  return report;
}

function recordModels(report: InvestigationResultV1, models: Array<string | null>): void {
  report.report.loop.completedRounds = models.length;
  report.context.modelExecutions = models.map((model, index) => ({
    attemptId: report.context.attempt.id,
    round: index + 1,
    engine: "codex",
    model,
  }));
}

function expectCode(operation: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(InvestigationRequestError);
  expect(thrown).toMatchObject({ statusCode: 400, code });
}

describe("automatic reply templates", () => {
  it.each([
    [
      "pr",
      "full_diff",
      "Inspect the entire frozen diff and all affected behavior, callers, and tests.",
      "Review the pinned PR changes and affected behavior, including relevant callers and test source.",
    ],
    [
      "bug",
      "issue_snapshot",
      "Investigate the entire frozen issue snapshot, every supplied fact, and all supported hypotheses.",
      "Statically investigate the recorded issue snapshot, supplied facts, and supported hypotheses.",
    ],
  ] as const)(
    "projects only the canonical historical %s scope without mutating the report",
    (kind, unitKind, legacy, wording) => {
      const report = preview(kind);
      const unit = report.report.coverage.includedUnits[0]!;
      unit.kind = unitKind;
      unit.requiredWork = legacy;
      report.report.summary = "A frozen collection is intentional in this implementation.";
      const before = structuredClone(report);
      const body = render(report);
      expect(body).toContain(wording);
      expect(body).not.toContain(legacy);
      expect(body).toContain("A frozen collection is intentional");
      expect(report).toEqual(before);
      unit.requiredWork = `${legacy} Custom investigation requirement.`;
      expect(render(report)).toContain(legacy);
      unit.requiredWork = legacy;
      unit.kind = "source_file";
      expect(render(report)).toContain(legacy);
    },
  );

  it("keeps E2E conclusions, runtime identity, and verified media separate from static review", () => {
    const report = preview();
    report.context.task.kind = "pr-e2e";
    report.context.e2e = {
      headSha: "a".repeat(40),
      buildIdentity: "Synthetic pinned build",
      features: [
        {
          id: "feature-preview",
          title: "Preview lifecycle",
          paths: ["src/Preview.cs"],
          scenario: "Open and close the preview",
          userVisible: true,
          outcome: "passed",
          artifactRefs: ["artifact-preview"],
          limitations: [],
          assertions: [
            {
              id: "assertion-preview",
              expected: "The preview closes",
              observed: "The preview closed",
              outcome: "passed",
              evidenceRefs: ["evidence-preview"],
            },
          ],
        },
      ],
      cleanup: {
        confirmed: true,
        recordedAt: "2026-09-19T01:00:00.000Z",
        summary: "Owned processes exited.",
      },
    };
    const media = "## E2E evidence\n\nhttps://github.com/user-attachments/assets/synthetic-video";
    const body = renderAutomaticReply(report, defaultE2eAutomaticReplyTemplate, verifiedIdentity, {
      trustedMediaMarkdown: media,
    });
    expect(body).toContain("automated E2E runtime verification");
    expect(body).toContain("## E2E result");
    expect(body).toContain("## Runtime verification summary");
    expect(body).toContain("E2E runtime verification: Passed");
    expect(body).toContain("Preview lifecycle");
    expect(body).toContain("**Expected:** The preview closes");
    expect(body).toContain("**Observed:** The preview closed");
    expect(body).toContain("**Build identity:** Synthetic pinned build");
    expect(body).toContain(media);
    expect(body).not.toContain("request a new E2E run");
    expect(body).not.toContain("**Review conclusion:**");
    expect(body).not.toContain("conducting this automated issue triage");
    expect(
      renderAutomaticReplySummaryParts(report, verifiedIdentity, { trustedMediaMarkdown: media })
        .body,
    ).toContain(media);
    report.context.e2e.cleanup.confirmed = false;
    const blocked = renderAutomaticReplySummaryParts(report, verifiedIdentity).body;
    expect(blocked).toContain("E2E runtime verification: Blocked");
    expect(blocked).toContain(
      "**Next action:** Resolve the recorded failures or blockers, then request a new E2E run",
    );
    expect(blocked).toContain(
      "Resuming this task only recovers and republishes its recorded result",
    );
    report.context.e2e.cleanup.confirmed = true;
    report.context.e2e.features[0]!.outcome = "failed";
    report.context.e2e.features[0]!.assertions[0]!.outcome = "failed";
    const before = structuredClone(report);
    const failed = renderAutomaticReplySummaryParts(report, verifiedIdentity).body;
    expect(failed).toContain("E2E runtime verification: Failed");
    expect(failed).toContain("request a new E2E run in a new PR comment");
    expect(
      renderAutomaticReply(report, defaultE2eAutomaticReplyTemplate, verifiedIdentity),
    ).toContain("Resuming this task only recovers and republishes its recorded result");
    expect(report).toEqual(before);
    delete report.context.e2e;
    expect(renderAutomaticReplySummaryParts(report, verifiedIdentity).body).not.toContain(
      "request a new E2E run",
    );
  });

  it("renders partial usage and nullable provider breakdowns without double counting", () => {
    const usage: InvestigationUsageSummary = {
      usage: {
        inputTokens: 100,
        cachedReadTokens: 60,
        outputTokens: 20,
        reasoningTokens: 10,
        cacheWriteTokens: null,
        totalTokens: 120,
        providerCounters: {},
      },
      reportedTokens: 120,
      completeness: "partial",
      invocationCount: 3,
      activeInvocationCount: 1,
      unknownInvocationCount: 1,
      legacyTokens: 0,
    };
    const block = renderReplyTokenUsage(usage);
    expect(block).toContain("120 tokens (partial usage)");
    expect(block).toContain("Cached read: 60");
    expect(block).toContain("Cache write: Unavailable");
    expect(block).toContain("unreported usage is not included yet");
    expect(block).toContain("missing or incomplete usage");
    const report = preview();
    const template = defaultAutomaticReplyTemplates.pullRequest.replace(
      "{{details}}",
      "{{usage}}\n\n{{details}}",
    );
    const body = renderAutomaticReply(report, template, verifiedIdentity, { usage });
    expect(body.match(/\*\*Reported token usage:\*\*/gu)).toHaveLength(1);
    expect(renderAutomaticReplySummaryParts(report, verifiedIdentity, { usage }).body).toContain(
      block,
    );
    expect(() =>
      validateAutomaticReplyTemplate(template.replace("{{usage}}", "{{usage}}\n{{usage}}")),
    ).toThrow("only once");
  });

  it("provides the documented English templates with each required section exactly once", () => {
    expect(automaticReplyTemplateVersion).toBe(4);
    expect(automaticReplyTemplateTokens).toEqual({
      pullRequest: tokenNames,
      issue: issueTokenNames,
    });
    for (const kind of ["pullRequest", "issue"] as const) {
      const template = defaultAutomaticReplyTemplates[kind];
      expect(validateAutomaticReplyTemplate(template, kind)).toBe(template);
      const filename = kind === "pullRequest" ? "auto-reply-pr.md" : "auto-reply-issue.md";
      expect(
        readFileSync(
          new URL(`../../../../docs/templates/${filename}`, import.meta.url),
          "utf8",
        ).replaceAll("\r\n", "\n"),
      ).toBe(template);
    }
    expect(Object.isFrozen(defaultAutomaticReplyTemplates)).toBe(true);
    expect(render(preview())).toContain("performing this automated review");
    expect(render(preview("bug"))).toContain("conducting this automated bug triage");
  });

  it.each([null, undefined, 12, {}, [], "", "   "])("rejects a non-template value", (template) => {
    expectCode(() => validateAutomaticReplyTemplate(template), "automatic_reply_template_invalid");
  });

  it.each(tokenNames)("rejects a missing or repeated %s token", (token) => {
    expectCode(
      () => validateAutomaticReplyTemplate(tokenTemplate.replace(`{{${token}}}`, "")),
      "automatic_reply_template_invalid",
    );
    expectCode(
      () => validateAutomaticReplyTemplate(`${tokenTemplate}\n{{${token}}}`),
      "automatic_reply_template_invalid",
    );
  });

  it.each(issueTokenNames)("rejects a missing or repeated issue %s token", (token) => {
    expectCode(
      () => validateAutomaticReplyTemplate(issueTokenTemplate.replace(`{{${token}}}`, ""), "issue"),
      "automatic_reply_template_invalid",
    );
    expectCode(
      () => validateAutomaticReplyTemplate(`${issueTokenTemplate}\n{{${token}}}`, "issue"),
      "automatic_reply_template_invalid",
    );
  });

  it("keeps PR findings and issue next steps as distinct template contracts", () => {
    expect(validateAutomaticReplyTemplate(tokenTemplate)).toBe(tokenTemplate);
    expect(validateAutomaticReplyTemplate(issueTokenTemplate, "issue")).toBe(issueTokenTemplate);
    expectCode(
      () => validateAutomaticReplyTemplate(tokenTemplate, "issue"),
      "automatic_reply_template_invalid",
    );
    expectCode(
      () => validateAutomaticReplyTemplate(issueTokenTemplate, "pullRequest"),
      "automatic_reply_template_invalid",
    );
    expectCode(
      () => renderAutomaticReply(preview("bug"), tokenTemplate, verifiedIdentity),
      "automatic_reply_template_invalid",
    );
    expectCode(
      () => renderAutomaticReply(preview("pr"), issueTokenTemplate, verifiedIdentity),
      "automatic_reply_template_invalid",
    );
    expectCode(
      () =>
        validateAutomaticReplyTemplate(
          issueTokenTemplate.replace("{{next_steps}}", "{{summary}}\n\n{{next_steps}}"),
          "issue",
        ),
      "automatic_reply_template_invalid",
    );
  });

  it.each([
    "{{unknown}}",
    "{{summary.toUpperCase()}}",
    "{{ summary }}",
    "{{SUMMARY}}",
    "{{",
    "}}",
    "{{{summary}}}",
  ])("rejects unknown, executable, and malformed placeholders", (extra) => {
    expectCode(
      () => validateAutomaticReplyTemplate(`${tokenTemplate}\n${extra}`),
      "automatic_reply_template_invalid",
    );
  });

  it("bounds templates in UTF-8 bytes while preserving an exact accepted template", () => {
    const remaining = 12_000 - Buffer.byteLength(tokenTemplate, "utf8");
    const padding = "漢".repeat(Math.floor(remaining / 3)) + "a".repeat(remaining % 3);
    const template = tokenTemplate.replace("{{details}}", `${padding}{{details}}`);
    expect(Buffer.byteLength(template, "utf8")).toBe(12_000);
    expect(validateAutomaticReplyTemplate(template)).toBe(template);
    expectCode(
      () => validateAutomaticReplyTemplate(`${template}é`),
      "automatic_reply_template_invalid",
    );
  });

  it("rejects extra braces around an otherwise valid placeholder", () => {
    expectCode(
      () => validateAutomaticReplyTemplate(tokenTemplate.replace("{{summary}}", "{{{summary}}}")),
      "automatic_reply_template_invalid",
    );
  });

  it.each([
    `Header before identity\n${tokenTemplate}`,
    `${tokenTemplate}\nFooter after details`,
    tokenTemplate
      .replace("{{conclusion}}", "{{temporary}}")
      .replace("{{summary}}", "{{conclusion}}")
      .replace("{{temporary}}", "{{summary}}"),
    tokenTemplate
      .replace("{{findings}}", "{{temporary}}")
      .replace("{{details}}", "{{findings}}")
      .replace("{{temporary}}", "{{details}}"),
  ])("requires identity first, details last, and the exact section order", (template) => {
    expectCode(() => validateAutomaticReplyTemplate(template), "automatic_reply_template_invalid");
  });

  it.each([
    `Header before identity\n${issueTokenTemplate}`,
    `${issueTokenTemplate}\nFooter after details`,
    issueTokenTemplate
      .replace("{{conclusion}}", "{{temporary}}")
      .replace("{{next_steps}}", "{{conclusion}}")
      .replace("{{temporary}}", "{{next_steps}}"),
    issueTokenTemplate
      .replace("{{next_steps}}", "{{temporary}}")
      .replace("{{details}}", "{{next_steps}}")
      .replace("{{temporary}}", "{{details}}"),
  ])("keeps issue identity first, next steps after the result, and details last", (template) => {
    expectCode(
      () => validateAutomaticReplyTemplate(template, "issue"),
      "automatic_reply_template_invalid",
    );
  });
});

describe("verified automatic reply identity", () => {
  it("discloses the verified publisher and AI operation before any model has been recorded", () => {
    expect(renderAutomaticReplyIdentity(undefined, verifiedIdentity)).toBe(
      "I'm an AI assistant running through Agentic Review on behalf of GitHub user `@moooyo`. This update was generated by AI and may contain errors.",
    );
  });

  it("uses complete trusted pre-report execution records across adopted attempts in round order", () => {
    const identity = renderAutomaticReplyIdentity(undefined, verifiedIdentity, {
      completedRounds: 3,
      adoptedAttemptIds: ["first-attempt", "resumed-attempt"],
      modelExecutions: [
        { attemptId: "resumed-attempt", round: 3, engine: "codex", model: "gpt-6-astra" },
        { attemptId: "resumed-attempt", round: 2, engine: "codex", model: "provider/second-model" },
        { attemptId: "first-attempt", round: 1, engine: "codex", model: "gpt-6-astra" },
      ],
    });
    expect(identity).toBe(
      "I'm an AI assistant using GPT-6 Astra and provider/second-model running through Agentic Review on behalf of GitHub user `@moooyo`. This update was generated by AI and may contain errors.",
    );
    expect(identity.match(/GPT-6 Astra/gu)).toHaveLength(1);
    expect(identity).not.toContain("codex");
    expect(identity).not.toContain("attempt");
  });

  it.each([
    (report: InvestigationResultV1) => {
      report.context.modelExecutions = [];
    },
    (report: InvestigationResultV1) => {
      report.report.loop.completedRounds = 0;
    },
    (report: InvestigationResultV1) => {
      report.report.loop.completedRounds = 1.5;
    },
    (report: InvestigationResultV1) => {
      report.context.modelExecutions!.pop();
    },
    (report: InvestigationResultV1) => {
      report.context.modelExecutions![0]!.round = 2;
    },
    (report: InvestigationResultV1) => {
      report.context.modelExecutions![0]!.round = 0;
    },
    (report: InvestigationResultV1) => {
      report.context.modelExecutions![0]!.attemptId = "unadopted-attempt";
    },
    (report: InvestigationResultV1) => {
      report.context.modelExecutions![0]!.model = null;
    },
    (report: InvestigationResultV1) => {
      report.context.modelExecutions![0]!.model = "";
    },
    (report: InvestigationResultV1) => {
      report.context.modelExecutions![0]!.model = " inferred-model ";
    },
    (report: InvestigationResultV1) => {
      report.context.modelExecutions![0]!.model = "model\u202ename";
    },
    (report: InvestigationResultV1) => {
      report.context.modelExecutions![0]!.model = "model\nsecond-line";
    },
    (report: InvestigationResultV1) => {
      report.context.modelExecutions![0]!.model = "a".repeat(257);
    },
    (report: InvestigationResultV1) => {
      report.context.modelExecutions![0]!.model = "ghp_abcdefghijklmnopqrstuvwxyz012345";
    },
  ])(
    "falls back to generic AI identity for incomplete or unsafe trusted pre-report records",
    (mutate) => {
      const report = preview();
      recordModels(report, ["gpt-6-astra", "gpt-6-astra"]);
      mutate(report);
      expect(
        renderAutomaticReplyIdentity(undefined, verifiedIdentity, {
          completedRounds: report.report.loop.completedRounds,
          modelExecutions: report.context.modelExecutions ?? [],
          adoptedAttemptIds: report.context.adoptedAttemptIds,
        }),
      ).toBe(renderAutomaticReplyIdentity(undefined, verifiedIdentity));
    },
  );

  it("uses report execution identity rather than a supplied pre-report context or generated prose", () => {
    const report = preview();
    recordModels(report, ["gpt-6-astra"]);
    report.report.summary = "I am generated-prose-model.";
    const identity = renderAutomaticReplyIdentity(report, verifiedIdentity, {
      completedRounds: 1,
      adoptedAttemptIds: ["other-attempt"],
      modelExecutions: [
        { attemptId: "other-attempt", round: 1, engine: "codex", model: "other-model" },
      ],
    });
    expect(identity).toContain("I'm GPT-6 Astra, an AI assistant");
    expect(identity).not.toContain("other-model");
    expect(identity).not.toContain("generated-prose-model");
  });

  it.each([
    null,
    [],
    {},
    { completedRounds: 1, adoptedAttemptIds: ["attempt-1"], modelExecutions: null },
    { completedRounds: 1, adoptedAttemptIds: ["attempt-1"], modelExecutions: [null] },
    {
      completedRounds: 1,
      modelExecutions: [
        { attemptId: "attempt-1", round: 1, engine: "codex", model: "gpt-6-astra" },
      ],
    },
    {
      completedRounds: 1,
      adoptedAttemptIds: "unadopted-attempt-1-suffix",
      modelExecutions: [
        { attemptId: "attempt-1", round: 1, engine: "codex", model: "gpt-6-astra" },
      ],
    },
    {
      completedRounds: 1,
      adoptedAttemptIds: [undefined],
      modelExecutions: [{ round: 1, engine: "codex", model: "gpt-6-astra" }],
    },
    {
      completedRounds: "1",
      adoptedAttemptIds: ["attempt-1"],
      modelExecutions: [
        { attemptId: "attempt-1", round: 1, engine: "codex", model: "gpt-6-astra" },
      ],
    },
    {
      completedRounds: 1,
      adoptedAttemptIds: ["attempt-1"],
      modelExecutions: [{ attemptId: "attempt-1", round: 1, model: "gpt-6-astra" }],
    },
    {
      completedRounds: 1,
      adoptedAttemptIds: ["attempt-1"],
      modelExecutions: [
        { attemptId: "attempt-1", round: 1, engine: "other", model: "gpt-6-astra" },
      ],
    },
  ])("does not infer a model or throw from malformed pre-report context containers", (context) => {
    expect(
      renderAutomaticReplyIdentity(
        undefined,
        verifiedIdentity,
        context as unknown as AutomaticReplyModelContext,
      ),
    ).toBe(renderAutomaticReplyIdentity(undefined, verifiedIdentity));
  });

  it("uses the explicitly recorded model and the verified GitHub login", () => {
    const report = preview();
    recordModels(report, ["gpt-6-astra", "gpt-6-astra", "gpt-6-astra"]);
    expect(
      render(report).startsWith(
        "I'm GPT-6 Astra, an AI assistant running through Agentic Review on behalf of GitHub user `@moooyo`. I'm performing this automated review. This review was generated by AI and may contain errors.",
      ),
    ).toBe(true);
  });

  it("uses issue wording and preserves other real model identifiers without guessing a display name", () => {
    const report = preview("bug");
    recordModels(report, ["gpt-5.3-codex"]);
    expect(render(report)).toContain(
      "I'm gpt-5.3-codex, an AI assistant running through Agentic Review on behalf of GitHub user `@moooyo`. I'm conducting this automated bug triage. This triage was generated by AI and may contain errors.",
    );
  });

  it("names every model used across recorded rounds and attempts, not only the latest one", () => {
    const report = preview();
    recordModels(report, ["gpt-6-astra", "provider/second-model", "gpt-6-astra"]);
    report.context.adoptedAttemptIds.push("earlier-model-attempt");
    report.context.modelExecutions![0]!.attemptId = "earlier-model-attempt";
    expect(render(report)).toContain(
      "I'm an AI assistant using GPT-6 Astra and provider/second-model running through Agentic Review on behalf of GitHub user `@moooyo`. I'm performing this automated review.",
    );
  });

  it.each([
    (report: InvestigationResultV1) => {
      delete report.context.modelExecutions;
    },
    (report: InvestigationResultV1) => {
      report.context.modelExecutions!.pop();
    },
    (report: InvestigationResultV1) => {
      report.context.modelExecutions![0]!.model = null;
    },
    (report: InvestigationResultV1) => {
      report.context.modelExecutions![0]!.round = 2;
    },
    (report: InvestigationResultV1) => {
      report.context.modelExecutions![0]!.attemptId = "unadopted-attempt";
    },
    (report: InvestigationResultV1) => {
      report.context.modelExecutions![0]!.model = "model\nnot-a-model";
    },
    (report: InvestigationResultV1) => {
      report.context.modelExecutions![0]!.model = "a".repeat(257);
    },
  ])("honestly discloses unavailable, incomplete, or unsafe model identity", (mutate) => {
    const report = preview();
    recordModels(report, ["gpt-6-astra", "gpt-6-astra", "gpt-6-astra"]);
    mutate(report);
    const body = render(report);
    expect(
      body.startsWith(
        "I'm an AI assistant running through Agentic Review on behalf of GitHub user `@moooyo`. The model identity was not fully recorded.",
      ),
    ).toBe(true);
    expect(body).not.toContain("I'm codex");
    expect(body).not.toContain("<details open>");
  });

  it("does not use the engine as an inferred model", () => {
    const report = preview();
    recordModels(report, [null]);
    report.context.modelExecutions![0]!.engine = "copilot";
    expect(render(report)).toContain("model identity was not fully recorded");
    expect(render(report)).not.toContain("I'm copilot");
  });

  it.each(["provider:model", "a".repeat(200)])(
    "preserves complete model names supported by the execution contract",
    (model) => {
      const report = preview();
      recordModels(report, [model]);
      expect(render(report)).toContain(
        `I'm ${model}, an AI assistant running through Agentic Review`,
      );
    },
  );

  it("escapes special characters in explicitly recorded model names", () => {
    const report = preview();
    recordModels(report, ["provider/<model>@variant"]);
    const body = render(report);
    expect(body).toContain("I'm provider/&lt;model&gt;@\u200bvariant, an AI assistant");
    expect(body).not.toContain("<model>");
    expect(body).not.toContain("@variant");
  });

  it.each([
    "@moooyo",
    "moooyo` injected",
    "user_name",
    "</details>",
    "moooyo\n@someone",
    "moooyo\n",
    "moooyo\r",
    "moooyo\u2028",
  ])("rejects an unsafe GitHub login instead of creating a misleading identity", (githubLogin) => {
    expectCode(
      () =>
        renderAutomaticReply(preview(), defaultAutomaticReplyTemplates.pullRequest, {
          githubUserId: 100,
          githubLogin,
        }),
      "automatic_reply_identity_invalid",
    );
    expectCode(
      () => renderAutomaticReplyIdentity(undefined, { githubUserId: 100, githubLogin }),
      "automatic_reply_identity_invalid",
    );
  });

  it.each(["automation[bot]", "a".repeat(100)])(
    "safely formats a verified bot or long login as code",
    (githubLogin) => {
      const body = renderAutomaticReply(preview(), defaultAutomaticReplyTemplates.pullRequest, {
        githubUserId: 100,
        githubLogin,
      });
      expect(body).toContain(`GitHub user \`@${githubLogin}\``);
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "requires a verified numeric GitHub user identity",
    (githubUserId) => {
      expectCode(
        () =>
          renderAutomaticReply(preview(), defaultAutomaticReplyTemplates.pullRequest, {
            githubUserId,
            githubLogin: "moooyo",
          }),
        "automatic_reply_identity_invalid",
      );
      expectCode(
        () => renderAutomaticReplyIdentity(undefined, { githubUserId, githubLogin: "moooyo" }),
        "automatic_reply_identity_invalid",
      );
    },
  );
});

describe("automatic reply report eligibility", () => {
  it.each(["blocked", "failed", "cancelled", "interrupted"] as const)(
    "rejects %s reports",
    (outcome) => {
      const report = preview();
      report.outcome = outcome;
      expectCode(() => render(report), "automatic_reply_report_ineligible");
      expectCode(() => renderParts(report), "automatic_reply_report_ineligible");
      expectCode(
        () => renderAutomaticReplySummary(report, verifiedIdentity),
        "automatic_reply_report_ineligible",
      );
      expectCode(
        () => renderAutomaticReplySummaryParts(report, verifiedIdentity),
        "automatic_reply_report_ineligible",
      );
    },
  );

  it.each([
    (report: InvestigationResultV1) => {
      report.report.completeness = "partial";
    },
    (report: InvestigationResultV1) => {
      report.report.delivery = "checkpoint";
    },
    (report: InvestigationResultV1) => {
      report.report.loop.stopReason = "budget_exhausted";
    },
    (report: InvestigationResultV1) => {
      report.context.task.parentTaskId = "parent-task";
    },
    (report: InvestigationResultV1) => {
      report.context.parentReportRef = { id: "parent-report", version: 1, digest: "a".repeat(64) };
    },
    (report: InvestigationResultV1) => {
      report.context.task.kind = "pr-verify";
    },
    (report: InvestigationResultV1) => {
      report.context.workItem.kind = "issue";
    },
    (report: InvestigationResultV1) => {
      report.assessment = preview("bug").assessment;
    },
  ])("rejects incomplete, child, follow-up, and mismatched reports", (mutate) => {
    const report = preview();
    mutate(report);
    expectCode(() => render(report), "automatic_reply_report_ineligible");
    expectCode(() => renderParts(report), "automatic_reply_report_ineligible");
    expectCode(
      () => renderAutomaticReplySummary(report, verifiedIdentity),
      "automatic_reply_report_ineligible",
    );
    expectCode(
      () => renderAutomaticReplySummaryParts(report, verifiedIdentity),
      "automatic_reply_report_ineligible",
    );
  });
});

describe("structured automatic reply content", () => {
  it.each([" ", "", "\n", "\n\n"])(
    "separates the server identity when accepted template placeholders use %j separators",
    (separator) => {
      const report = preview();
      const template = tokenNames.map((token) => `{{${token}}}`).join(separator);
      expect(validateAutomaticReplyTemplate(template)).toBe(template);
      const parts = renderAutomaticReplyParts(report, template, verifiedIdentity);
      expect(parts.body).toBe(`${parts.identity}\n\n${parts.content}`);
      expect(automaticReplyResultWithoutIdentity(parts.body, report, verifiedIdentity)).toBe(
        parts.content,
      );
      expect(parts.body.split(parts.identity)).toHaveLength(2);
    },
  );

  it.each(["pr", "bug", "feature"] as const)(
    "keeps one server identity while composing the complete %s report content",
    (kind) => {
      const report = preview(kind);
      recordModels(report, ["gpt-6-astra"]);
      const parts = renderParts(report);
      expect(parts.identity).toBe(renderAutomaticReplyIdentity(report, verifiedIdentity));
      expect(parts.body).toBe(`${parts.identity}\n\n${parts.content}`);
      expect(parts.body).toBe(render(report));
      expect(parts.body.split(parts.identity)).toHaveLength(2);
      expect(parts.content).not.toContain(parts.identity);
      expect(parts.content).toContain("### Full assessment");
      expect(parts.content).toContain("### Finding analysis");
      expect(parts.content.endsWith("</details>")).toBe(true);
      expect(automaticReplyResultWithoutIdentity(parts.body, report, verifiedIdentity)).toBe(
        parts.content,
      );
    },
  );

  it("rejects mismatched publisher disclosures and altered prefixes instead of removing arbitrary prose", () => {
    const report = preview();
    recordModels(report, ["gpt-6-astra"]);
    const parts = renderParts(report);
    expectCode(
      () =>
        automaticReplyResultWithoutIdentity(parts.body, report, {
          githubUserId: 200,
          githubLogin: "different-publisher",
        }),
      "automatic_reply_identity_mismatch",
    );
    for (const body of [
      `Header before identity\n${parts.body}`,
      ` ${parts.body}`,
      parts.body.replace("GPT-6 Astra", "another-model"),
      parts.body.replace("running through Agentic Review", "running through another service"),
      parts.body.replace(`${parts.identity}\n`, `${parts.identity}Extra text\n`),
      parts.content,
      parts.identity,
    ]) {
      expectCode(
        () => automaticReplyResultWithoutIdentity(body, report, verifiedIdentity),
        "automatic_reply_identity_mismatch",
      );
    }
  });

  it("retains every oversized finding in structured parts while preserving the legacy publication limit", () => {
    const report = preview("pr", 60);
    report.findings[59]!.rootCause.explanation = "Final finding retained in complete report parts.";
    const before = structuredClone(report);
    const parts = renderParts(report);
    expect(Buffer.byteLength(parts.body, "utf8")).toBeGreaterThan(59_000);
    for (const finding of report.findings) expect(parts.content).toContain(finding.title);
    expect(parts.content).toContain("Final finding retained in complete report parts.");
    expect(parts.content.endsWith("</details>")).toBe(true);
    expectCode(() => render(report), "automatic_reply_too_large");
    expect(report).toEqual(before);
  });
});

describe("automatic reply summary fallback", () => {
  it("keeps an oversized PR summary safe and explicit about the full report remaining in the Dashboard", () => {
    const report = preview("pr", 60);
    recordModels(report, ["gpt-6-astra"]);
    report.report.summary =
      `@reviewer <script>run()</script> [open](https://internal.invalid/report) ` +
      `password=hiddenSummarySecret C:\\private\\report.log https://localhost:444/private ` +
      `${report.id} ${report.context.task.id} ` +
      "Long public context. ".repeat(4_000);
    report.assessment.summary = "FULL_ASSESSMENT_REMAINS_IN_DASHBOARD";
    report.findings[59]!.rootCause.explanation = "FINAL_FINDING_REMAINS_IN_DASHBOARD";
    report.validation.checks[0]!.status = "failed";
    const before = structuredClone(report);
    expectCode(() => render(report), "automatic_reply_too_large");
    const summary = renderAutomaticReplySummary(report, verifiedIdentity);
    const parts = renderAutomaticReplySummaryParts(report, verifiedIdentity);
    expect(parts.body).toBe(summary);
    expect(parts.identity).toBe(renderAutomaticReplyIdentity(report, verifiedIdentity));
    expect(parts.body).toBe(`${parts.identity}\n\n${parts.content}`);
    expect(parts.body.split(parts.identity)).toHaveLength(2);
    expect(parts.content.startsWith("## Static review completed — summary only")).toBe(true);
    expect(parts.content).not.toContain(parts.identity);
    expect(automaticReplyResultWithoutIdentity(parts.body, report, verifiedIdentity)).toBe(
      parts.content,
    );
    expect(summary.startsWith(renderAutomaticReplyIdentity(report, verifiedIdentity))).toBe(true);
    expect(summary).toContain("## Static review completed — summary only");
    expect(summary).toContain("End-to-end validation:");
    expect(summary).toContain(`Pull request reviewed at commit ${"b".repeat(40)}.`);
    expect(summary).toContain("Later pushes are outside this report.");
    expect(summary).toContain(
      `**Recorded validation:** ${report.validation.checks.length} checks; ${report.validation.checks.filter((check) => check.status === "passed").length} passed.`,
    );
    expect(summary).toContain("review the complete report and its recommended next steps");
    expect(summary).toContain("The full report is not embedded");
    expect(summary).toContain("available to authorized repository operators in the Dashboard");
    expect(summary).toContain("No findings have been presented as a complete list here.");
    expect(summary).toContain("does not authorize approval or merging");
    expect(summary).toContain("@\u200breviewer");
    expect(summary).toContain("&lt;script&gt;");
    expect(summary).not.toMatch(/https?:\/\//u);
    expect(summary).not.toContain("<details>");
    expect(summary).not.toContain("## Findings");
    for (const privateText of [
      "@reviewer",
      "<script>",
      "hiddenSummarySecret",
      "C:\\private",
      "https://localhost",
      report.id,
      report.context.task.id,
      "FULL_ASSESSMENT_REMAINS_IN_DASHBOARD",
      "FINAL_FINDING_REMAINS_IN_DASHBOARD",
    ]) {
      expect(summary).not.toContain(privateText);
    }
    expect(Buffer.byteLength(summary, "utf8")).toBeLessThan(5_000);
    expect(report).toEqual(before);
  });

  it.each(["needs_information", "needs_verification"] as const)(
    "keeps completed bug triage separate from its %s follow-up",
    (status) => {
      const report = preview("bug");
      if (report.assessment.kind !== "bug") throw new Error("Expected a bug fixture.");
      report.assessment.bugAssessment.status = status;
      report.assessment.reproduction.status = "not_run";
      const summary = renderAutomaticReplySummary(report, verifiedIdentity);
      expect(summary).toContain("Static investigation completed — summary only");
      expect(summary).toContain(`Bug triage: ${status.replaceAll("_", " ")}`);
      expect(summary).toContain("Runtime reproduction: not run");
      expect(summary).toContain("The issue text and discussion snapshot");
      expect(summary).toContain("Later edits are outside this report.");
      expect(summary).toContain(
        "any requested information or validation remains a follow-up action",
      );
      expect(summary).toContain(
        status === "needs_information"
          ? "For the issue author: review and provide the missing information"
          : "For repository maintainers: review the proposed validation steps",
      );
      expect(summary).not.toContain("Investigation failed");
      expect(summary).not.toMatch(/https?:\/\//u);
    },
  );

  it("preserves feature and other-issue classifications without embedding their complete assessments", () => {
    const feature = preview("feature");
    if (feature.assessment.kind !== "feature") throw new Error("Expected a feature fixture.");
    const summary = renderAutomaticReplySummary(feature, verifiedIdentity);
    expect(summary).toContain(
      `Feature request: ${feature.assessment.featureAssessment.status.replaceAll("_", " ")}.`,
    );
    expect(summary).not.toContain("Runtime reproduction");
    const other = triageFixture("other", "FULL_CLASSIFICATION_EXPLANATION");
    const otherSummary = renderAutomaticReplySummary(other, verifiedIdentity);
    expect(otherSummary).toContain(
      "Issue triage completed. Consult the complete assessment for its classification.",
    );
    expect(otherSummary).not.toContain("FULL_CLASSIFICATION_EXPLANATION");
    expect(otherSummary).not.toContain("Runtime reproduction");
  });

  it("states when the reviewed PR commit is unavailable without exposing an unsafe source identity", () => {
    const report = preview();
    const subject = report.context.subjects[0]!;
    if (subject.kind !== "original_pr") throw new Error("Expected an original PR subject.");
    subject.headSha = "https://internal.invalid/not-a-commit";
    const summary = renderAutomaticReplySummary(report, verifiedIdentity);
    expect(summary).toContain("The reviewed commit is unavailable.");
    expect(summary).not.toContain(subject.headSha);
    expect(summary).not.toMatch(/https?:\/\//u);
  });
});

describe("automatic PR replies", () => {
  it("keeps the visible reply concise and moves complete finding analysis into one collapsed details block", () => {
    const report = preview("pr", 3);
    for (const [index, finding] of report.findings.entries()) {
      finding.title = `Retained finding ${index}`;
      finding.trigger.conditions = [`Detailed trigger ${index}`];
      finding.rootCause.explanation = `Detailed root cause ${index}`;
      finding.fixRecommendation.summary = `Detailed repair recommendation ${index}`;
    }
    const body = render(report);
    const detailsStart = body.indexOf("<details>");
    const visible = body.slice(0, detailsStart);
    const details = body.slice(detailsStart);
    expect(detailsStart).toBeGreaterThan(0);
    const positions = ["## Conclusion", "## Summary", "## Findings", "<details>"].map((section) =>
      body.indexOf(section),
    );
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(body.match(/<details>/gu)).toHaveLength(1);
    expect(body.match(/<\/details>/gu)).toHaveLength(1);
    expect(body).toContain("<details>\n<summary>Details</summary>");
    expect(body).not.toContain("<details open");
    expect(visible).not.toContain("**Trigger conditions:**");
    expect(visible).not.toContain("**Root cause:**");
    expect(visible).not.toContain("**Recheck conclusion:**");
    for (const [index, finding] of report.findings.entries()) {
      expect(visible).toContain(
        `**[${finding.priority}] Retained finding ${index}** — **Confirmed.**`,
      );
      expect(visible).not.toContain(`Detailed trigger ${index}`);
      expect(visible).not.toContain(`Detailed root cause ${index}`);
      expect(details).toContain(`Detailed trigger ${index}`);
      expect(details).toContain(`Detailed root cause ${index}`);
      expect(details).toContain(`Detailed repair recommendation ${index}`);
    }
    for (const section of [
      "### Full assessment",
      "### Full summary",
      "### Finding analysis",
      "### Validation",
      "### Recommended next steps",
      "### Scope",
      "### Limitations",
    ]) {
      expect(details).toContain(section);
    }
  });

  it("bounds visible summaries without removing any complete finding text from Details", () => {
    const report = preview();
    report.findings[0]!.title = `Long title ${"x".repeat(500)}`;
    report.findings[0]!.impact.description = `Long impact ${"y".repeat(2000)}`;
    report.report.summary = `Long summary ${"z".repeat(2000)}`;
    const body = render(report);
    const visible = body.slice(0, body.indexOf("<details>"));
    const details = body.slice(body.indexOf("<details>"));
    expect(visible.length).toBeLessThan(1800);
    expect(visible).toContain("…");
    expect(details).toContain(report.findings[0]!.title);
    expect(details).toContain(report.findings[0]!.impact.description);
    expect(details).toContain(report.report.summary);
  });

  it.each(["no-blocking-findings", "changes-requested", "inconclusive"] as const)(
    "preserves the %s conclusion without turning E2E advice into execution evidence",
    (conclusion) => {
      const report = preview();
      if (report.assessment.kind !== "pr") throw new Error("Expected a PR fixture.");
      report.assessment.reviewConclusion.status = conclusion;
      const body = render(report);
      const label = conclusion.replaceAll("-", " ");
      expect(body).toContain(
        `**Review conclusion:** ${label.charAt(0).toUpperCase()}${label.slice(1)}.`,
      );
      expect(body).toContain("**End-to-end validation:** Required.");
      expect(body).toContain("**Not run; required:**");
      expect(body).toContain(`Original PR at head ${"b".repeat(40)}`);
      expect(body).toContain(`; base ${"d".repeat(40)}`);
      expect(body).not.toContain("All tests passed");
    },
  );

  it("renders every finding in priority and ordinal order without changing the report", () => {
    const report = preview("pr", 8);
    for (const [index, finding] of report.findings.entries()) {
      finding.title = `Unique retained finding ${index}`;
      finding.priority = (["P3", "P1", "P0", "P2"] as const)[index % 4]!;
      finding.ordinal = 8 - index;
    }
    const before = structuredClone(report);
    const body = render(report);
    const expected = [...report.findings].sort(
      (left, right) => left.priority.localeCompare(right.priority) || left.ordinal - right.ordinal,
    );
    let previous = -1;
    for (const [index, finding] of expected.entries()) {
      const position = body.indexOf(`#### ${index + 1}. [${finding.priority}] ${finding.title}`);
      expect(position).toBeGreaterThan(previous);
      previous = position;
    }
    expect(body).toContain("**Trigger conditions:**");
    expect(body).toContain("**Inputs:**");
    expect(body).toContain("**Trigger steps:**");
    expect(body).toContain("**Affected parties:**");
    expect(body).toContain("**Repair constraints:**");
    expect(body).toContain("**Recheck conclusion:**");
    expect(report).toEqual(before);
  });

  it("reports confirmed findings, independent root-cause hypotheses, and withdrawn candidates accurately", () => {
    const report = preview();
    report.findings[0]!.rootCause.status = "hypothesis";
    report.report.recheck.records[0]!.unresolvedQuestions = [
      "Which cancellation boundary owns the final write?",
    ];
    report.report.loop.candidates.push({
      ...report.report.loop.candidates[0]!,
      id: "withdrawn-candidate",
      findingId: null,
      findingVersion: null,
      status: "withdrawn",
      title: "Potential duplicate write",
      rationale: "The existing guard already prevents this path.",
    });
    report.report.loop.candidates.push({
      ...report.report.loop.candidates[0]!,
      id: "merged-candidate",
      findingId: null,
      findingVersion: null,
      status: "merged",
      title: "Related cancellation path",
      rationale: "Covered by the retained cancellation finding.",
    });
    const body = render(report);
    expect(body).toContain("**Status:** Confirmed.");
    expect(body).toContain("**Root cause:** Hypothesis.");
    expect(body).toContain("**Remaining uncertainty:**");
    expect(body).toContain("Which cancellation boundary owns the final write?");
    expect(body).toContain("**Withdrawn:** Potential duplicate write");
    expect(body).toContain("**Merged:** Related cancellation path");
  });

  it("does not infer validation success from an empty finding or check collection", () => {
    const report = preview("pr", 0);
    report.validation.checks = [];
    report.validation.summary = "Source inspection only.";
    const body = render(report);
    expect(body).toContain("No retained findings were recorded in the reviewed scope.");
    expect(body).toContain("**Checks: Not run.**");
    expect(body).toContain("Source inspection only.");
    expect(body).not.toMatch(/(?:all tests|all checks) passed/iu);
  });

  it("preserves all validation states and the subject for each check", () => {
    const report = preview();
    const check = report.validation.checks[0]!;
    report.validation.checks = (["passed", "failed", "not_run", "blocked"] as const).map(
      (value, index) => ({
        ...check,
        id: `check-${index}`,
        description: `Check description ${index}`,
        status: value,
        required: index % 2 === 0,
      }),
    );
    const body = render(report);
    expect(body).toContain("**Passed; required:** Check description 0");
    expect(body).toContain("**Failed:** Check description 1");
    expect(body).toContain("**Not run; required:** Check description 2");
    expect(body).toContain("**Blocked:** Check description 3");
    expect(body.match(/Subject: Original PR at head/gu)).toHaveLength(4);
  });

  it("includes check-only runtime evidence and preserves only final unresolved questions as current uncertainty", () => {
    const report = preview();
    const finalRecheck = report.report.recheck.records[0]!;
    finalRecheck.unresolvedQuestions = [];
    report.report.recheck.records.unshift({
      ...finalRecheck,
      id: "earlier-recheck",
      round: 1,
      conclusion: "The cancellation behavior initially needed clarification.",
      unresolvedQuestions: ["ALREADY_RESOLVED_QUESTION"],
    });
    report.verificationEvidence.push({
      ...report.verificationEvidence[0]!,
      id: "check-only-evidence",
      source: "executor_observation",
      authority: "worker",
      summary: "The observed value was 2 instead of the expected 1.",
      artifactRefs: [],
    });
    report.validation.checks[0]!.status = "failed";
    report.validation.checks[0]!.evidenceRefs = ["check-only-evidence"];
    const body = render(report);
    expect(body).toContain("**Failed; required:**");
    expect(body).toContain("The observed value was 2 instead of the expected 1.");
    expect(body).toContain("Executor observation; worker");
    expect(body).toContain("**Earlier recheck conclusion:**");
    expect(body).not.toContain("ALREADY_RESOLVED_QUESTION");
    expect(body).not.toContain("**Remaining uncertainty:**");
  });
});

describe("automatic issue replies", () => {
  it.each(["bug", "feature", "other"] as const)(
    "keeps the %s summary and distinct assessment explanation in the triage result",
    (kind) => {
      const reason = "The recorded evidence requires this separate assessment explanation.";
      const report = triageFixture(kind, reason);
      report.report.summary = "This is the concise report summary.";
      const body = render(report);
      const result = body.slice(body.indexOf("## Triage result"), body.indexOf("## Next steps"));
      expect(result).toContain(report.report.summary);
      expect(result).toContain(reason);
      expect(body).not.toContain("\n## Summary\n");
      const details = body.slice(body.indexOf("<details>"));
      expect(details).toContain(report.report.summary);
      expect(details).toContain(reason);
    },
  );

  it.each(["bug", "feature", "other"] as const)(
    "shows a duplicated %s summary and assessment explanation only once after whitespace normalization",
    (kind) => {
      const phrase = "The recorded evidence needs further investigation.";
      const report = triageFixture(kind, phrase);
      report.report.summary = "The  recorded evidence\nneeds further investigation.";
      const body = render(report);
      const visible = body.slice(0, body.indexOf("<details>"));
      expect(visible.split(phrase)).toHaveLength(2);
      expect(visible).not.toContain("## Summary");
      const details = body.slice(body.indexOf("<details>"));
      expect(details).toContain("### Full summary");
      expect(details).toContain(phrase);
      expect(details).toContain(report.report.summary);
    },
  );

  it.each(["bug", "feature", "other"] as const)(
    "retains the complete %s summary and explanation in details when the visible result is shortened",
    (kind) => {
      const reason = `Detailed assessment reason ${"y".repeat(900)}`;
      const report = triageFixture(kind, reason);
      report.report.summary = `Detailed report summary ${"x".repeat(1200)}`;
      const body = render(report);
      const result = body.slice(body.indexOf("## Triage result"), body.indexOf("## Next steps"));
      expect(result).toContain("Detailed report summary");
      expect(result).toContain("Detailed assessment reason");
      expect(result).not.toContain(report.report.summary);
      expect(result).not.toContain(reason);
      expect(result).toContain("…");
      const details = body.slice(body.indexOf("<details>"));
      expect(details).toContain(report.report.summary);
      expect(details).toContain(reason);
    },
  );

  it("uses a triage result and actionable next steps before collapsed investigation details", () => {
    const report = preview("bug", 3);
    recordModels(report, ["gpt-6-astra"]);
    const body = render(report);
    const detailsStart = body.indexOf("<details>");
    const visible = body.slice(0, detailsStart);
    const details = body.slice(detailsStart);
    expect(
      visible.startsWith(
        "I'm GPT-6 Astra, an AI assistant running through Agentic Review on behalf of GitHub user `@moooyo`. I'm conducting this automated bug triage. This triage was generated by AI and may contain errors.",
      ),
    ).toBe(true);
    const headings = ["## Triage result", "## Next steps", "<details>"];
    let previous = -1;
    for (const heading of headings) {
      const position = body.indexOf(heading);
      expect(position).toBeGreaterThan(previous);
      previous = position;
    }
    expect(visible).not.toContain("## Findings");
    expect(visible).not.toContain("## Summary");
    expect(visible).toContain(report.report.summary);
    expect(visible).not.toMatch(/\[P[0-3]\]/u);
    expect(body.match(/<details>/gu)).toHaveLength(1);
    expect(body.match(/<\/details>/gu)).toHaveLength(1);
    expect(body).toContain("<details>\n<summary>Investigation details</summary>");
    expect(body).not.toMatch(/<details\s+open/iu);
    expect(body.trimEnd()).toMatch(/<\/details>$/u);
    for (const finding of report.findings) {
      expect(details).toContain(finding.title);
      expect(details).toContain(finding.rootCause.explanation);
    }
    for (const section of ["### Scope", "### Limitations", "### Validation"]) {
      expect(details).toContain(section);
    }
    expect(details).toContain(report.plans[0]!.steps[0]!.description);
  });

  it.each([
    ["confirmed", "Confirmed bug"],
    ["needs_information", "Needs more information"],
    ["needs_verification", "Needs verification"],
    ["already_fixed", "Already fixed upstream"],
    ["duplicate", "Duplicate"],
    ["not_a_bug", "Expected behavior"],
  ] as const)(
    "separates a %s triage assessment from its reproduction evidence",
    (assessmentStatus, label) => {
      const report = preview("bug");
      if (report.assessment.kind !== "bug") throw new Error("Expected a bug fixture.");
      report.assessment.bugAssessment.status = assessmentStatus;
      report.assessment.bugAssessment.rationale = `Recorded triage rationale for ${label}.`;
      report.assessment.bugAssessment.missingInformation = [
        "Which installed version shows the failure?",
      ];
      report.assessment.bugAssessment.upstreamFix = {
        identifier: "Commit abc123",
        explanation: "The related guard was added.",
        evidenceRefs: [],
      };
      report.assessment.bugAssessment.duplicateOf = {
        identifier: "Issue 77",
        explanation: "The same startup condition is reported.",
        evidenceRefs: [],
      };
      const body = render(report);
      const visible = body.slice(0, body.indexOf("<details>"));
      expect(visible).toContain(`**${label}.**`);
      expect(visible).not.toContain("**Assessment:**");
      expect(visible).toContain(`Recorded triage rationale for ${label}.`);
      expect(visible).toContain("**Runtime reproduction:** Not attempted.");
      expect(visible).toContain(report.assessment.reproduction.summary);
      expect(body).toContain("**Status:** Hypothesis.");
      expect(body).toContain("**Root cause:** Hypothesis.");
      expect(body).toContain("**Unconfirmed hypotheses:**");
      expect(body).toContain("Which installed version shows the failure?");
      expect(body).toContain("**Existing fix:** Commit abc123");
      expect(body).toContain("**Duplicate reference:** Issue 77");
      expect(body).toContain("Issue text and discussion snapshot");
    },
  );

  it.each([
    ["reproduced", "Reproduced"],
    ["not_reproduced", "Not reproduced"],
    ["not_run", "Not attempted"],
    ["blocked", "Blocked"],
  ] as const)("preserves %s reproduction status", (reproductionStatus, label) => {
    const report = preview("bug");
    if (report.assessment.kind !== "bug") throw new Error("Expected a bug fixture.");
    report.assessment.reproduction.status = reproductionStatus;
    report.assessment.reproduction.summary = `Recorded experiment outcome: ${reproductionStatus.replaceAll("_", " ")}.`;
    const body = render(report);
    const visible = body.slice(0, body.indexOf("<details>"));
    expect(visible).toContain(`**Runtime reproduction:** ${label}.`);
    expect(visible).not.toContain("**Reproduction:**");
    expect(visible).toContain(report.assessment.reproduction.summary);
    expect(visible).toContain("**Needs verification.**");
    expect(visible).not.toContain("**Expected behavior.**");
  });

  it("asks for every missing detail without treating an empty finding list as a negative diagnosis", () => {
    const report = preview("bug", 0);
    if (report.assessment.kind !== "bug") throw new Error("Expected a bug fixture.");
    report.assessment.bugAssessment.status = "needs_information";
    report.assessment.bugAssessment.rationale =
      "The report lacks the details needed to assess the failure.";
    report.assessment.bugAssessment.missingInformation = Array.from(
      { length: 12 },
      (_, index) =>
        `Please provide diagnostic item ${index + 1}, including ${"the exact observed behavior ".repeat(12).trim()}.`,
    );
    const body = render(report);
    const visible = body.slice(0, body.indexOf("<details>"));
    const nextSteps = visible.slice(visible.indexOf("## Next steps"));
    expect(visible).toContain("**Needs more information.**");
    expect(nextSteps).toContain("Could you provide:");
    expect(nextSteps).not.toContain("**Information needed:**");
    for (const request of report.assessment.bugAssessment.missingInformation) {
      expect(nextSteps).toContain(request);
    }
    expect(visible).not.toMatch(
      /no retained findings|no (?:confirmed )?bugs? (?:were |was )?found/iu,
    );
    expect(visible).not.toContain("**Expected behavior.**");
  });

  it("offers the linked reproduction experiment and every unconfirmed hypothesis before details", () => {
    const report = preview("bug");
    if (report.assessment.kind !== "bug") throw new Error("Expected a bug fixture.");
    report.assessment.bugAssessment.hypotheses = Array.from(
      { length: 10 },
      (_, index) =>
        `Unverified startup hypothesis ${index + 1}: ${"the initialization sequence may race ".repeat(10).trim()}.`,
    );
    const plan = report.plans[0]!;
    plan.title = "Capture the failing startup sequence";
    plan.rationale = "Determine whether initialization fails before a window is created.";
    const body = render(report);
    const visible = body.slice(0, body.indexOf("<details>"));
    const nextSteps = visible.slice(visible.indexOf("## Next steps"));
    expect(nextSteps).toContain(plan.title);
    expect(nextSteps).toContain(plan.rationale);
    expect(nextSteps).toMatch(/unconfirmed hypotheses/iu);
    for (const hypothesis of report.assessment.bugAssessment.hypotheses) {
      expect(nextSteps).toContain(hypothesis);
    }
    expect(nextSteps).not.toContain("Root cause confirmed");
    expect(body.slice(body.indexOf("<details>"))).toContain(plan.steps[0]!.description);
  });

  it("recommends confirmed repairs and proposed fix plans without promoting hypotheses to fixes", () => {
    const report = preview("bug", 3);
    if (report.assessment.kind !== "bug") throw new Error("Expected a bug fixture.");
    report.assessment.bugAssessment.status = "confirmed";
    const fixPlan = {
      ...report.plans[0]!,
      kind: "fix" as const,
      title: "Guard the confirmed startup failure",
    };
    fixPlan.rationale = "Preserve a working startup state when initialization fails.";
    report.plans.push({
      ...fixPlan,
      id: "unrelated-fix-plan",
      subjectRef: "another-subject",
      title: "Unrelated repair must stay out of triage next steps",
    });
    report.plans[0] = fixPlan;
    for (const [index, finding] of report.findings.entries()) {
      finding.fixRecommendation.summary = `Repair recommendation ${index + 1}.`;
      finding.confirmation.status = index < 2 ? "confirmed" : "hypothesis";
    }
    const body = render(report);
    const visible = body.slice(0, body.indexOf("<details>"));
    const nextSteps = visible.slice(visible.indexOf("## Next steps"));
    expect(nextSteps).toContain("Repair recommendation 1.");
    expect(nextSteps).toContain("Repair recommendation 2.");
    expect(nextSteps).not.toContain("Repair recommendation 3.");
    expect(nextSteps).toContain(fixPlan.title);
    expect(nextSteps).toContain(fixPlan.rationale);
    expect(nextSteps).toContain("**Proposed fix plan:**");
    expect(nextSteps).toContain(
      "See Investigation details for the procedure and recorded validation results.",
    );
    expect(nextSteps).not.toMatch(
      /(?:fix|plan) (?:has been |was )?(?:executed|applied|passed)|all (?:tests|checks) passed/iu,
    );
    expect(nextSteps).not.toContain("Unrelated repair must stay out of triage next steps");
    expect(body.slice(body.indexOf("<details>"))).toContain("Repair recommendation 3.");
  });

  it("puts the upstream fix and evidence explanation first without guessing a release", () => {
    const report = preview("bug", 0);
    if (report.assessment.kind !== "bug") throw new Error("Expected a bug fixture.");
    report.assessment.bugAssessment.status = "already_fixed";
    report.assessment.bugAssessment.upstreamFix = {
      identifier: "Commit abc123",
      explanation: "The startup guard now handles the reported empty state.",
      evidenceRefs: [],
    };
    const body = render(report);
    const visible = body.slice(0, body.indexOf("<details>"));
    expect(visible).toContain("**Already fixed upstream.**");
    expect(visible).toContain("Commit abc123");
    expect(visible).toContain("The startup guard now handles the reported empty state.");
    expect(visible).not.toMatch(
      /(?:released|shipped|available) in (?:the )?(?:latest|version|release)/iu,
    );
  });

  it("explains a duplicate reference without claiming to close or modify the issue", () => {
    const report = preview("bug", 0);
    if (report.assessment.kind !== "bug") throw new Error("Expected a bug fixture.");
    report.assessment.bugAssessment.status = "duplicate";
    report.assessment.bugAssessment.duplicateOf = {
      identifier: "Issue 77",
      explanation: "Both reports fail after importing the same malformed settings value.",
      evidenceRefs: [],
    };
    const body = render(report);
    const visible = body.slice(0, body.indexOf("<details>"));
    expect(visible).toContain("**Duplicate.**");
    expect(visible).toContain("Issue 77");
    expect(visible).toContain(
      "Both reports fail after importing the same malformed settings value.",
    );
    expect(visible).not.toMatch(
      /(?:I|we) (?:have )?(?:closed|labeled)|(?:issue |report )(?:is|was|has been) closed/iu,
    );
  });

  it("explains expected behavior without asking a reporter to inspect hidden findings", () => {
    const report = preview("bug", 0);
    if (report.assessment.kind !== "bug") throw new Error("Expected a bug fixture.");
    report.assessment.bugAssessment.status = "not_a_bug";
    report.assessment.bugAssessment.expectedBehavior =
      "Disabled startup apps do not launch until they are enabled again.";
    const body = render(report);
    const visible = body.slice(0, body.indexOf("<details>"));
    expect(visible).toContain("**Expected behavior.**");
    expect(visible).toContain(report.assessment.bugAssessment.expectedBehavior);
  });

  it.each([
    "ready",
    "needs_information",
    "needs_decision",
    "already_supported",
    "duplicate",
    "not_feasible",
  ] as const)(
    "renders a %s feature assessment with its full decision and acceptance details",
    (assessmentStatus) => {
      const report = preview("feature");
      if (report.assessment.kind !== "feature") throw new Error("Expected a feature fixture.");
      const feature = report.assessment.featureAssessment;
      feature.status = assessmentStatus;
      feature.missingInformation = ["Which selection format should be accepted?"];
      feature.decisions = [
        {
          question: "Where should the export command live?",
          options: [
            { label: "Settings", tradeoffs: "Accessible to existing users." },
            { label: "Command palette", tradeoffs: "Requires keyboard discovery." },
          ],
        },
      ];
      feature.usage = "Use the existing Export settings command.";
      feature.duplicateOf = {
        identifier: "Issue 88",
        explanation: "It covers the same selection request.",
        evidenceRefs: [],
      };
      const body = render(report);
      const visible = body.slice(0, body.indexOf("<details>"));
      const nextSteps = visible.slice(visible.indexOf("## Next steps"));
      const label = assessmentStatus.replaceAll("_", " ");
      expect(visible).toContain("**Classification:** Feature request.");
      expect(visible).toContain("conducting this automated issue triage");
      expect(visible).not.toContain("automated bug triage");
      expect(visible).not.toContain("**Reproduction:**");
      expect(visible).not.toContain("**Runtime reproduction:**");
      expect(body).toContain(
        `**Feature assessment:** ${label.charAt(0).toUpperCase()}${label.slice(1)}.`,
      );
      expect(body).toContain("**Requirements:**");
      expect(body).toContain("**Feasibility:**");
      expect(body).toContain("**Decision needed:** Where should the export command live?");
      expect(body).toContain("Settings: Accessible to existing users.");
      expect(body).toContain("Command palette: Requires keyboard discovery.");
      expect(body).toContain("**Acceptance criteria:**");
      expect(body).toContain("**Alternatives:**");
      expect(body).toContain("**Existing usage:** Use the existing Export settings command.");
      expect(body).toContain("**Duplicate reference:** Issue 88");
      if (assessmentStatus === "needs_information") {
        expect(nextSteps).toContain(feature.missingInformation[0]);
      } else if (assessmentStatus === "needs_decision") {
        expect(nextSteps).toContain("Where should the export command live?");
        expect(nextSteps).toContain("Settings: Accessible to existing users.");
        expect(nextSteps).toContain("Command palette: Requires keyboard discovery.");
      } else if (assessmentStatus === "already_supported") {
        expect(nextSteps).toContain(feature.usage);
      } else if (assessmentStatus === "duplicate") {
        expect(nextSteps).toContain("Issue 88");
        expect(nextSteps).toContain("It covers the same selection request.");
      } else if (assessmentStatus === "not_feasible") {
        for (const alternative of feature.alternatives) expect(nextSteps).toContain(alternative);
      } else {
        expect(nextSteps).toContain(report.plans[0]!.title);
        expect(nextSteps).toContain(report.plans[0]!.rationale);
      }
    },
  );

  it("renders other issue classifications and retained scope exclusions and limitations", () => {
    const report = preview("feature");
    report.assessment = {
      kind: "other_issue",
      subjectRef: report.context.task.subjectRef,
      summary: "A documentation question.",
      classification: "Documentation question",
      explanation: "The existing option needs clearer documentation.",
      evidenceRefs: [],
    };
    report.report.coverage.exclusions.push({
      id: "excluded-item",
      subjectRef: report.context.task.subjectRef,
      description: "Unrelated installer behavior",
      reason: "Outside this request.",
    });
    const body = render(report);
    const visible = body.slice(0, body.indexOf("<details>"));
    expect(visible).toContain("**Classification:** Documentation question");
    expect(visible).toContain("The existing option needs clearer documentation.");
    expect(visible).toContain("conducting this automated issue triage");
    expect(visible).not.toContain("automated bug triage");
    expect(visible).not.toContain("**Reproduction:**");
    expect(visible).not.toContain("**Runtime reproduction:**");
    expect(body).toContain("Unrelated installer behavior — Outside this request.");
    expect(body).toContain("**Recorded limitations:**");
  });
});

describe("public reply safety and size", () => {
  it("neutralizes prose Markdown, HTML, mentions, executable links, and injected publication markers", () => {
    const report = preview();
    report.report.summary =
      "@reviewer <img src=x onerror=alert(1)> ![remote](https://evil.invalid/pixel) [run](javascript:alert(1))\n" +
      "<!-- agentic-review-action:fake:deadbeef -->\n[reference]: https://evil.invalid/\n# Injected heading\n" +
      "&lt;script&gt;alert(1)&lt;/script&gt; {{summary}}";
    const body = render(report);
    expect(body).not.toContain("@reviewer");
    expect(body).toContain("@\u200breviewer");
    expect(body).not.toContain("<img");
    expect(body).not.toContain("<!--");
    expect(body).not.toContain("agentic-review-action:fake");
    expect(body).not.toContain("https://evil.invalid");
    expect(body).not.toContain("javascript:alert");
    expect(body).toContain("\\[reference\\]");
    expect(body).toContain("\\# Injected heading");
    expect(body).toContain("&amp;lt;script&amp;gt;");
    expect(body).toContain("\\{\\{summary\\}\\}");
  });

  it("also neutralizes unsafe literal text in configurable templates", () => {
    const body = renderAutomaticReply(
      preview(),
      tokenTemplate.replace(
        "{{details}}",
        "@team <!-- agentic-review-action:fake:digest -->\n[run](javascript:alert(1))\n{{details}}",
      ),
      verifiedIdentity,
    );
    expect(body).not.toContain("@team");
    expect(body).not.toContain("<!--");
    expect(body).not.toContain("javascript:alert");
    expect(body).toContain("\\[run\\]");
  });

  it.each(["pr", "bug"] as const)(
    "does not allow model text or literal template HTML to close or expand the trusted %s details wrapper",
    (kind) => {
      const report = preview(kind);
      report.findings[0]!.rootCause.explanation =
        "Injected </details><details open><summary>Fake</summary> payload.";
      const template = defaultAutomaticReplyTemplates[
        kind === "pr" ? "pullRequest" : "issue"
      ].replace("{{conclusion}}", "{{conclusion}}\n</details><details open>");
      const body = renderAutomaticReply(report, template, verifiedIdentity);
      expect(body.match(/<details>/gu)).toHaveLength(1);
      expect(body.match(/<\/details>/gu)).toHaveLength(1);
      expect(body).not.toContain("<details open>");
      expect(body).toContain("&lt;/details&gt;&lt;details open&gt;");
      expect(body.endsWith("</details>")).toBe(true);
    },
  );

  it.each(["```\n{{details}}", "~~~\n{{details}}", "    {{details}}"])(
    "keeps the details wrapper outside template code fences and indentation",
    (replacement) => {
      const template = defaultAutomaticReplyTemplates.pullRequest.replace(
        "{{details}}",
        replacement,
      );
      const body = renderAutomaticReply(preview(), template, verifiedIdentity);
      expect(body).toContain("\n\n<details>\n<summary>Details</summary>");
      expect(body).not.toContain("```");
      expect(body).not.toContain("~~~");
      expect(body).not.toContain("\n    <details>");
    },
  );

  it("preserves code discussion containing an incomplete HTML comment delimiter", () => {
    const report = preview();
    report.findings[0]!.rootCause.explanation =
      "The parser sees `<!--` and drops the rest of the document.";
    const body = render(report);
    expect(body).toContain("The parser sees");
    expect(body).toContain("&lt;");
    expect(body).toContain("and drops the rest of the document.");
  });

  it.each([
    ['{"password":"hunter2"}', "hunter2"],
    ["Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ["-----BEGIN PRIVATE KEY-----\nMIIEPrivateMaterialWithoutEnd", "MIIEPrivateMaterialWithoutEnd"],
    ["INVESTIGATION_GITHUB_TOKEN=secretHeaderValue", "secretHeaderValue"],
    ["--password superSecretArgument", "superSecretArgument"],
  ])("redacts common structured credential formats", (text, secret) => {
    const report = preview();
    report.report.summary = text;
    expect(render(report)).not.toContain(secret);
  });

  it("keeps source code references readable without copying raw drafts, private paths, credentials, or identifiers", () => {
    const report = preview();
    report.report.summary =
      `Inspect \`SaveSettingsAsync<T>()\` in C:\\AgenticReview\\runtime\\private.log. password=hunter2 token=secret-value ` +
      `Bearer abcdefghijklmnopqrstuvwxyz ghp_abcdefghijklmnopqrstuvwxyz012345 /home/worker/private/log.txt ` +
      `${report.id} ${report.context.task.id} ${report.artifacts[0]!.id} https://localhost:444/private`;
    report.diagnostics[0] = {
      id: "secret-diagnostic",
      code: "private_code",
      category: "error",
      message: "DO_NOT_PUBLISH_DIAGNOSTIC",
      retryable: false,
      evidenceRefs: [],
      prerequisiteRefs: [],
    };
    report.feedbackDrafts[0]!.body = "DO_NOT_PUBLISH_RAW_DRAFT";
    report.plans[0]!.prerequisites.push({
      id: "internal-authorization",
      kind: "authorization",
      description: "DO_NOT_PUBLISH_PERMISSION",
    });
    const body = render(report);
    expect(body).toContain("SaveSettingsAsync&lt;T&gt;()");
    for (const privateText of [
      "C:\\AgenticReview",
      "/home/worker",
      "hunter2",
      "secret-value",
      "abcdefghijklmnopqrstuvwxyz",
      report.id,
      report.context.task.id,
      report.artifacts[0]!.id,
      "https://localhost",
      "DO_NOT_PUBLISH_DIAGNOSTIC",
      "DO_NOT_PUBLISH_RAW_DRAFT",
      "DO_NOT_PUBLISH_PERMISSION",
    ]) {
      expect(body).not.toContain(privateText);
    }
  });

  it.each([
    ["/srv/privacy-fixture/capture.png", "privacy-fixture/capture.png"],
    ["Saved /data/privacy-fixture/recording.webm.", "privacy-fixture/recording.webm"],
    ["path=/custom-root/privacy-fixture/screen.png", "privacy-fixture/screen.png"],
    ['Captured "/srv/privacy fixture/Sensitive Shot.png".', "Sensitive Shot.png"],
    ["Captured '/data/privacy fixture/Sensitive Recording.webm'.", "Sensitive Recording.webm"],
    [
      "Captured (`/isolated-volume/privacy fixture/Private Preview.png`), then continued.",
      "Private Preview.png",
    ],
    ["Saved '/custom-root/privacy fixture/owner\\'s Private Image.png'.", "Private Image.png"],
    ["Captured [/custom-root/privacy-fixture/SecretScreenshot.png].", "SecretScreenshot.png"],
    ["**/home/privacy-fixture/HiddenCapture.png**", "HiddenCapture.png"],
    ["<code>/srv/privacy-fixture/HiddenRecording.webm</code>", "HiddenRecording.webm"],
    ['Unclosed "/custom-root/privacy-fixture/PrivateCapture.png', "PrivateCapture.png"],
  ])("redacts absolute POSIX paths in static report text: %s", (summary, privateFragment) => {
    const report = preview();
    report.report.summary = summary;
    for (const body of [
      render(report),
      renderAutomaticReplySummaryParts(report, verifiedIdentity).body,
    ]) {
      expect(body).toContain("local path omitted");
      expect(body).not.toContain(privateFragment);
      expect(body).not.toContain("/srv/");
      expect(body).not.toContain("/data/");
      expect(body).not.toContain("/custom-root/");
      expect(body).not.toContain("/isolated-volume/");
    }
  });

  it("preserves punctuation around an absolute POSIX path without publishing the path", () => {
    const report = preview();
    report.report.summary =
      "Before (/srv/privacy-fixture/capture.png), after /data/private-output.log.";
    expect(render(report)).toContain(
      "Before (\\[local path omitted\\]), after \\[local path omitted\\].",
    );
  });

  it("preserves relative source references and public HTTPS URL paths and query values", () => {
    const report = preview();
    report.report.summary =
      "Inspect src/Settings UI/Renderer.cs, ./src/Renderer.cs, and ../shared/Renderer.cs. " +
      "Reference https://example.com/home/public/srv/document?next='/data/public/file.png'&root=/custom-volume/source.";
    const body = render(report);
    for (const reference of [
      "src/Settings UI/Renderer.cs",
      "./src/Renderer.cs",
      "../shared/Renderer.cs",
    ])
      expect(body).toContain(reference);
    expect(body).toContain(
      "https\u200b://example.com/home/public/srv/document?next='/data/public/file.png'&amp;root=/custom-volume/source.",
    );
    expect(body).not.toContain("local path omitted");
  });

  it("constructs public frozen source links with encoded path segments and line ranges", () => {
    const report = preview();
    report.findings[0]!.locations = [
      {
        kind: "source",
        subjectRef: report.context.task.subjectRef,
        path: "src/Settings UI/A(test)#1.cs",
        startLine: 7,
        endLine: 11,
      },
    ];
    expect(render(report)).toContain(
      `https://github.com/moooyo/PowerToys/blob/${"b".repeat(40)}/src/Settings%20UI/A%28test%29%231.cs#L7-L11`,
    );
  });

  it("does not expose secrets through an otherwise valid source-link destination", () => {
    const report = preview();
    const credential = "ghp_abcdefghijklmnopqrstuvwxyz012345";
    report.findings[0]!.locations = [
      {
        kind: "source",
        subjectRef: report.context.task.subjectRef,
        path: `src/${credential}.cs`,
        startLine: 1,
        endLine: 2,
      },
    ];
    const body = render(report);
    expect(body).not.toContain(credential);
    expect(body).not.toContain("https://github.com/");
  });

  it.each([
    "../private.txt",
    "/etc/passwd",
    "C:\\private\\file.txt",
    "src/../private",
    "src\\file.cs",
    "src//file.cs",
  ])("does not turn unsafe source path %s into a public link", (path) => {
    const report = preview();
    report.findings[0]!.locations = [
      {
        kind: "source",
        subjectRef: report.context.task.subjectRef,
        path,
        startLine: 1,
        endLine: 2,
      },
    ];
    const body = render(report);
    expect(body).not.toContain("https://github.com/");
    expect(body).toContain("Source location unavailable for a public link.");
  });

  it("does not trust model URLs, arbitrary repository hosts, or issue snapshots as source-link identities", () => {
    const report = preview("bug");
    report.findings[0]!.locations = [
      {
        kind: "source",
        subjectRef: report.context.task.subjectRef,
        path: "src/main.cs",
        startLine: 1,
        endLine: 2,
      },
    ];
    const issueBody = render(report);
    expect(issueBody).not.toContain("https://github.com/");
    expect(issueBody).toContain("src/main.cs:1–2 (public source link unavailable).");
    const pr = preview();
    pr.context.repository.fullName = "github.com@evil.invalid/repo";
    expect(render(pr)).not.toContain("https://github.com/");
    pr.context.repository.fullName = "moooyo/PowerToys";
    pr.context.subjects[0]!.repositoryId = "different-repository";
    expect(render(pr)).not.toContain("https://github.com/");
  });

  it("rejects terminal whitespace in otherwise valid repository and source identities", () => {
    const report = preview();
    report.context.repository.fullName += "\n";
    expect(render(report)).not.toContain("https://github.com/");
    report.context.repository.fullName = "moooyo/PowerToys";
    const subject = report.context.subjects[0]!;
    if (subject.kind !== "original_pr") throw new Error("Expected an original PR subject.");
    subject.headSha += "\n";
    expect(render(report)).not.toContain("https://github.com/");
  });

  it("does not link proposed patch locations to the unmodified base commit", () => {
    const report = preview();
    const original = report.context.subjects[0]!;
    report.context.subjects[0] = {
      id: original.id,
      repositoryId: original.repositoryId,
      workItemId: original.workItemId,
      revisionKey: original.revisionKey,
      kind: "local_patch",
      baseSubjectRef: "base-subject",
      baseSha: "b".repeat(40),
      patchDigest: "c".repeat(64),
      artifactRef: "patch-artifact",
    };
    const body = render(report);
    expect(body).not.toContain("https://github.com/");
    expect(body).toContain("Proposed local patch (not the original source)");
  });

  it("accepts exactly 59000 UTF-8 bytes and blocks overflow without truncation", () => {
    const report = preview("feature", 0);
    report.assessment.summary = "Size boundary anchor.";
    const available = 59_000 - Buffer.byteLength(render(report), "utf8");
    report.assessment.summary += "漢".repeat(Math.floor(available / 3)) + "a".repeat(available % 3);
    const body = render(report);
    expect(Buffer.byteLength(body, "utf8")).toBe(59_000);
    report.assessment.summary += "é";
    expectCode(() => render(report), "automatic_reply_too_large");
  });

  it("blocks an oversized complete finding collection instead of silently publishing top findings", () => {
    const report = preview("pr", 60);
    expectCode(() => render(report), "automatic_reply_too_large");
    expect(report.findings).toHaveLength(60);
  });
});
