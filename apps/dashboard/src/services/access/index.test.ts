import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("../repositories");
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function sampleAccess() {
  vi.stubEnv("NODE_ENV", "development");
  const { MockRepositoryAdapter } = await import("../repositories/mock-adapter");
  const repositories = new MockRepositoryAdapter({ initialRepositories: [] });
  vi.doMock("../repositories", () => ({ repositories }));
  const { access } = await import("./index");
  return { repositories, access };
}

describe("default access service repository integration", () => {
  it("uses current sample records, including repositories created after the access service was initialized", async () => {
    const { repositories, access } = await sampleAccess();
    const repositoryId = "repo-powertoys";
    const request = {
      changeId: "created-repository-access",
      principal: { issuer: "urn:sample:identity", subject: "reviewer" },
      role: "reviewer" as const,
      expectedVersion: 0,
      reason: "Review the newly managed repository",
    };
    expect(access.mode).toBe("sample");
    await expect(access.context()).resolves.toMatchObject({ platformAdministrator: true });
    await expect(access.context(repositoryId)).rejects.toMatchObject({ status: 404 });
    await expect(access.list(repositoryId)).rejects.toMatchObject({ status: 404 });
    await expect(access.history(repositoryId)).rejects.toMatchObject({ status: 404 });
    await expect(access.change(repositoryId, request)).rejects.toMatchObject({ status: 404 });

    const resolved = await repositories.resolve("microsoft/PowerToys");
    const created = await repositories.create({
      githubRepositoryId: resolved.githubRepositoryId,
      fullName: resolved.fullName,
    });
    expect(created.id).toBe(repositoryId);
    await expect(access.context(repositoryId)).resolves.toMatchObject({
      repository: { repositoryId, role: "admin", source: "platform" },
    });
    await expect(access.list(repositoryId)).resolves.toMatchObject({ total: 0, items: [] });
    await expect(access.change(repositoryId, request)).resolves.toMatchObject({
      replayed: false,
      change: { repositoryId, principal: request.principal, role: "reviewer", version: 1 },
    });
    await expect(access.list(repositoryId)).resolves.toMatchObject({
      total: 1,
      items: [{ principal: request.principal, role: "reviewer", version: 1 }],
    });
    await expect(access.history(repositoryId)).resolves.toMatchObject({
      total: 1,
      items: [{ changeId: request.changeId }],
    });
    await expect(access.context("repo-terminal")).rejects.toMatchObject({ status: 404 });
    await expect(access.context("repo-unknown")).rejects.toMatchObject({ status: 404 });
    await expect(access.change("repo-unknown", request)).rejects.toMatchObject({ status: 404 });
  });

  it("propagates repository lookup failures without replacing them with access or sample data", async () => {
    const { repositories, access } = await sampleAccess();
    const { ReviewControlHttpError } = await import("../review-control/errors");
    const error = new ReviewControlHttpError("The repository lookup failed.", {
      status: 503,
      operation: "get repository",
      retryable: true,
    });
    vi.spyOn(repositories, "get").mockRejectedValue(error);
    await expect(access.context("repo-powertoys")).rejects.toBe(error);
    await expect(access.list("repo-powertoys")).rejects.toBe(error);
  });

  it("selects the connected adapter outside development without consulting the sample catalog", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const get = vi.fn();
    vi.doMock("../repositories", () => ({ repositories: { get } }));
    const { access } = await import("./index");
    expect(access.mode).toBe("connected");
    expect(get).not.toHaveBeenCalled();
  });
});
