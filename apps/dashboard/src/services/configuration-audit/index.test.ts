import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfigurationAuditUnavailableError,
  SampleConfigurationAuditAdapter,
} from "./sample-adapter";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("configuration audit service selection", () => {
  it("keeps fixed historical repository receipts without consulting current mutable state", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const adapter = new SampleConfigurationAuditAdapter();
    expect(adapter.mode).toBe("sample");
    const operations = [
      () => adapter.listGlobalConfigurationAudit(),
      () => adapter.getGlobalConfigurationAudit("audit-one"),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toBeInstanceOf(ConfigurationAuditUnavailableError);
      await expect(operation()).rejects.toMatchObject({
        code: "unsupported_operation",
        retryable: false,
      });
    }
    const oldPage = await adapter.listRepositoryConfigurationAudit("repo-powertoys");
    const oldSummary = oldPage.items[0];
    if (!oldSummary) throw new Error("Expected a historical sample event.");
    const oldEvent = await adapter.getRepositoryConfigurationAudit(
      "repo-powertoys",
      "repository",
      oldSummary.id,
      oldSummary,
    );
    expect(oldEvent.snapshot).not.toHaveProperty("schedulingLimits");
    const newPage = await adapter.listRepositoryConfigurationAudit("repo-terminal");
    const newSummary = newPage.items[0];
    if (!newSummary) throw new Error("Expected a current-shape sample event.");
    const newEvent = await adapter.getRepositoryConfigurationAudit(
      "repo-terminal",
      "repository",
      newSummary.id,
    );
    expect(newEvent.snapshot).toHaveProperty("schedulingLimits", {
      maxActiveLeases: 2,
      maxQueuedJobs: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("selects sample mode only in development and exports callable functions", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const service = await import("./index");
    expect(service.configurationAudit.mode).toBe("sample");
    await expect(service.listRepositoryConfigurationAudit("repo-one")).resolves.toMatchObject({
      items: [],
      total: 0,
    });
    await expect(
      service.getRepositoryConfigurationAudit("repo-one", "prompt", "audit-one"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.listGlobalConfigurationAudit()).rejects.toMatchObject({
      code: "unsupported_operation",
    });
    await expect(service.getGlobalConfigurationAudit("audit-one")).rejects.toMatchObject({
      code: "unsupported_operation",
    });
  });

  it.each(["test", "production"])("selects the connected adapter in %s", async (mode) => {
    vi.stubEnv("NODE_ENV", mode);
    const { configurationAudit } = await import("./index");
    expect(configurationAudit.mode).toBe("connected");
  });
});
