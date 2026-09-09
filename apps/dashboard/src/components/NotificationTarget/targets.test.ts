import { describe, expect, it } from "vitest";
import {
  clearNotificationTargetParameters,
  type NotificationTarget,
  notificationTargetPath,
  parseNotificationTarget,
} from "./targets";

const targets: NotificationTarget[] = [
  { kind: "job", repositoryId: "repository-a", jobId: "job-a" },
  { kind: "publication", repositoryId: "repository-b", publicationId: "publication-b" },
  {
    kind: "validation",
    repositoryId: "repository-a",
    workItemKind: "pull_request",
    workItemId: "work-item-a",
    reviewRunId: "run-a",
  },
  {
    kind: "validation",
    repositoryId: "repository-b",
    workItemKind: "issue",
    workItemId: "work-item-b",
    reviewRunId: "run-b",
    requestId: "request-b",
    jobId: "historical-job-b",
  },
];

describe("exact notification targets", () => {
  it.each(targets)("round trips the complete $kind target", (target) => {
    const url = new URL(notificationTargetPath(target), "https://dashboard.example");
    expect(url.origin).toBe("https://dashboard.example");
    expect(parseNotificationTarget(url.pathname, url.search)).toEqual({ kind: "target", target });
  });

  it("keeps the explicit destination repository without using the current selection", () => {
    expect(notificationTargetPath(targets[1] as NotificationTarget)).toBe(
      "/publications?repositoryId=repository-b&publicationId=publication-b",
    );
  });

  it.each([
    ["/jobs", "?jobId=job-a"],
    ["/jobs", "?repositoryId=repository-a&jobId=job-a&jobId=job-a"],
    ["/jobs", "?repositoryId=repository-a&repositoryId=repository-a&jobId=job-a"],
    ["/jobs", "?repositoryId=repository-a&jobId=job-a&publicationId=publication-a"],
    ["/publications", "?repositoryId=repository-a&publicationId="],
    ["/publications", "?repositoryId=repository-a&publicationId=a&publicationId=b"],
    ["/publications", "?repositoryId=repository-a&publicationId=owner%2Frepo"],
    ["/publications", "?repositoryId=repository-a&publicationId=a%0A"],
    ["/pull-requests", "?repositoryId=repository-a&reviewRunId=run-a"],
    ["/issues", "?repositoryId=repository-a&workItemId=item-a&reviewRunId=run-a&jobId=job-a"],
    ["/issues", "?repositoryId=repository-a&workItemId=item-a&reviewRunId=run-a&requestId=req-a"],
    [
      "/issues",
      "?repositoryId=repository-a&workItemId=item-a&reviewRunId=run-a&publicationId=pub-a",
    ],
    ["/workers", "?repositoryId=repository-a&jobId=job-a"],
    ["//foreign.example/jobs", "?repositoryId=repository-a&jobId=job-a"],
    ["/jobs", `?repositoryId=repository-a&jobId=${"a".repeat(129)}`],
  ])("rejects incomplete, mixed, or ambiguous %s %s", (pathname, search) => {
    expect(parseNotificationTarget(pathname as string, search as string).kind).toBe("invalid");
  });

  it("does not infer a target from unrelated list filters", () => {
    expect(parseNotificationTarget("/jobs", "?repositoryId=repository-a&status=failed")).toEqual({
      kind: "none",
    });
  });

  it("clears every target field while preserving repository selection and list filters", () => {
    expect(
      clearNotificationTargetParameters(
        "?repositoryId=repository-a&workItemId=item&reviewRunId=run&requestId=request&jobId=job&jobId=old&publicationId=pub&status=failed",
      ),
    ).toBe("?repositoryId=repository-a&status=failed");
    expect(clearNotificationTargetParameters("?jobId=job")).toBe("");
  });

  it("rejects a result target without its request identity before navigation", () => {
    expect(() =>
      notificationTargetPath({
        ...(targets[2] as Extract<NotificationTarget, { kind: "validation" }>),
        jobId: "job-a",
      }),
    ).toThrow("incomplete or invalid");
  });
});
