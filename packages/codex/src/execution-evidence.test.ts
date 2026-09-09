import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { collectCommandEvidence, redactExecutionText } from "./execution-evidence.js";
import { CodexJsonlParser } from "./jsonl.js";
import {
  PrReviewPlanV2ModelOutputSchema,
  PrReviewPlanV2ModelResultSchema,
  PrReviewPlanV2Schema,
} from "./review-results.js";

const parse = (events: unknown[]) =>
  new CodexJsonlParser().push(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
const command = (id: string, status: string, exitCode: number | null) => ({
  type: "item.completed",
  item: { type: "command_execution", id, command: "npm test", status, exit_code: exitCode },
});

describe("CLI execution evidence", () => {
  it("captures completed and failed commands without turning shell exits into verification claims", () => {
    const result = collectCommandEvidence(
      parse([
        {
          type: "item.started",
          item: {
            id: "item_1",
            type: "command_execution",
            command: "npm test",
            status: "in_progress",
          },
        },
        command("item_1", "completed", 0),
        command("item_2", "completed", 1),
      ]),
      redactExecutionText,
    );
    expect(result).toEqual({
      commandCapture: "complete",
      commands: [
        { itemId: "item_1", command: "npm test", status: "completed", exitCode: 0 },
        { itemId: "item_2", command: "npm test", status: "failed", exitCode: 1 },
      ],
    });
    expect(result).not.toHaveProperty("verificationStatus");
  });

  it("marks missing exits, future statuses, invalid fields and overflow as incomplete", () => {
    const missing = collectCommandEvidence(
      parse([command("item_1", "completed", null), command("item_2", "future", 0)]),
      redactExecutionText,
    );
    expect(missing.commandCapture).toBe("incomplete");
    expect(missing.commands.every((item) => item.status === "unknown")).toBe(true);
    const overflow = collectCommandEvidence(
      parse(Array.from({ length: 130 }, (_, index) => command(`item_${index}`, "completed", 0))),
      redactExecutionText,
    );
    expect(overflow.commands).toHaveLength(128);
    expect(overflow.commandCapture).toBe("incomplete");
  });

  it("redacts exact secrets before bounding plus token, header, assignment and URL credentials", () => {
    const secret = "configured-credential-value";
    const text = `npm test --token "plain value" password=hidden Authorization: Bearer eyJabc.def.ghi https://name:pass@example.com/?api_key=abc sk-proj-123456789 github_pat_123456789 ${secret}`;
    const result = redactExecutionText(text, [secret]);
    for (const value of [
      "plain value",
      "hidden",
      "eyJabc.def.ghi",
      "name:pass",
      "api_key=abc",
      "sk-proj-123456789",
      "github_pat_123456789",
      secret,
    ]) {
      expect(result).not.toContain(value);
    }
    expect(redactExecutionText("x".repeat(2_047) + secret, [secret])).not.toContain(
      secret.slice(0, 1),
    );
    expect(redactExecutionText("x".repeat(3_000))).toHaveLength(2_048);
  });

  it.each([
    'curl -H "Authorization: Token opaque-session" --head https://example.com',
    "curl -H 'Proxy-Authorization: Negotiate opaque-session' https://example.com",
    "curl -H 'Cookie: session_id=opaque-session; quoted=\"secondary-cookie\"' https://example.com",
    'curl -H "Set-Cookie: session_id=opaque-session; Secure; HttpOnly" https://example.com',
    "Authorization: Token opaque-session, additional=secondary-cookie",
    "Cookie: session_id=opaque-session; additional=secondary-cookie",
    '{"Authorization":"Token opaque-session"}',
    `echo arw1_${"a".repeat(43)}`,
  ])("redacts complete credential values from captured command evidence: %s", (text) => {
    const result = collectCommandEvidence(
      parse([
        {
          type: "item.completed",
          item: {
            id: "header-command",
            type: "command_execution",
            command: text,
            status: "completed",
            exit_code: 0,
          },
        },
      ]),
      redactExecutionText,
    );
    const stored = JSON.stringify(result.commands);
    for (const secret of ["opaque-session", "secondary-cookie", `arw1_${"a".repeat(43)}`]) {
      expect(stored).not.toContain(secret);
    }
    expect(stored).toContain("[REDACTED]");
  });
});

describe("V2 result source separation", () => {
  const modelResult = {
    schemaVersion: "PrReviewPlanV2",
    summary: "Review complete.",
    assessment: "comment",
    findings: [],
    requestedRecipeIds: [],
    verification: { status: "not_run", summary: "No tests ran.", commands: [] },
  };
  const executionEvidence = {
    schemaVersion: "ReviewExecutionEvidenceV1",
    source: "worker",
    commandCapture: "complete",
    commands: [],
    worktree: { status: "unknown", source: "not_observed" },
  };

  it("requires verification and refuses worker evidence from the model", () => {
    expect(Value.Check(PrReviewPlanV2ModelOutputSchema, modelResult)).toBe(true);
    expect(Value.Check(PrReviewPlanV2ModelResultSchema, modelResult)).toBe(true);
    expect(
      Value.Check(PrReviewPlanV2ModelResultSchema, { ...modelResult, executionEvidence }),
    ).toBe(false);
    expect(Value.Check(PrReviewPlanV2Schema, modelResult)).toBe(false);
    expect(Value.Check(PrReviewPlanV2Schema, { ...modelResult, executionEvidence })).toBe(true);
  });
});
