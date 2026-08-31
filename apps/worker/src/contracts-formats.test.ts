import { DateTimeSchema, GitHubActorSchema } from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { registerWorkerContractFormats } from "./contracts-formats.js";

describe("Worker contract formats", () => {
  it("accepts exact RFC 3339 timestamps and rejects date-only strings", () => {
    registerWorkerContractFormats();

    expect(Value.Check(DateTimeSchema, "2026-08-31T17:30:00.123Z")).toBe(true);
    expect(Value.Check(DateTimeSchema, "2026-08-31T17:30:00+08:00")).toBe(true);
    expect(Value.Check(DateTimeSchema, "2024-02-29T23:59:59.0-08:00")).toBe(true);
    expect(Value.Check(DateTimeSchema, "2026-08-31")).toBe(false);
    expect(Value.Check(DateTimeSchema, "not-a-date")).toBe(false);
  });

  it.each([
    "2026-08-31T24:00:00Z",
    "2026-02-30T12:00:00Z",
    "2026-02-31T12:00:00Z",
    "2025-02-29T12:00:00Z",
    "2026-04-31T12:00:00Z",
    "2026-13-01T12:00:00Z",
    "2026-00-01T12:00:00Z",
    "2026-08-00T12:00:00Z",
    "2026-08-31T23:60:00Z",
    "2026-08-31T23:59:60Z",
    "2026-08-31T23:59:59+24:00",
    "2026-08-31T23:59:59+08:60",
    "2026-08-31T23:59:59.Z",
  ])("rejects invalid calendar or time fields in %s", (value) => {
    registerWorkerContractFormats();

    expect(Value.Check(DateTimeSchema, value)).toBe(false);
  });

  it("uses URL parsing for the contracts uri format", () => {
    registerWorkerContractFormats();

    expect(
      Value.Check(GitHubActorSchema, {
        githubUserId: 1,
        login: "octocat",
        avatarUrl: "https://avatars.example.test/octocat.png",
      }),
    ).toBe(true);
    expect(
      Value.Check(GitHubActorSchema, {
        githubUserId: 1,
        login: "octocat",
        avatarUrl: "not a URI",
      }),
    ).toBe(false);
  });
});
