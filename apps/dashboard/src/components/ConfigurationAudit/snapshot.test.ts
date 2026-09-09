import type { RepositoryConfigurationSnapshotV1 } from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { repositorySnapshotSchedulingLabels } from "./snapshot";

const old: RepositoryConfigurationSnapshotV1 = {
  id: "repo-1",
  githubRepositoryId: 1,
  fullName: "owner/repo",
  enabled: true,
  version: 1,
  reviewerGithubUserId: null,
  reviewerGithubLogin: null,
  authorizationPolicy: null,
  connectionStatus: "unknown",
  connectionMessage: null,
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
};
describe("repository historical scheduling limits", () => {
  it("keeps absent historical limits distinct from unlimited", () => {
    expect(repositorySnapshotSchedulingLabels(old)).toEqual({
      active: "Not recorded in this snapshot",
      queue: "Not recorded in this snapshot",
    });
  });
  it("shows the exact recorded values", () => {
    expect(
      repositorySnapshotSchedulingLabels({
        ...old,
        schedulingLimits: { maxActiveLeases: 2, maxQueuedJobs: null },
      }),
    ).toEqual({ active: "2", queue: "Unlimited at this scope" });
  });
});
