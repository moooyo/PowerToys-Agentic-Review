import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createServerLifecycleTestingHarness } from "./server-lifecycle.testing.js";

const runtimeSourceRoot = dirname(fileURLToPath(import.meta.url));

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("ServerLifecycleCore", () => {
  it("keeps effect injection out of the production factory surface", async () => {
    const productionSource = await readFile(join(runtimeSourceRoot, "server-lifecycle.ts"), "utf8");
    const options = /export interface ProductionServerLifecycleOptions \{([^}]*)\}/u.exec(
      productionSource,
    )?.[1];
    expect(options).toContain("shutdownTimeoutMilliseconds");
    expect(options).not.toContain("effects");
    expect(options).not.toContain("hardExit");
    expect(productionSource).toContain("timer.ref()");
    expect(productionSource).toContain("capturedProcessExit(exitCode)");

    const constructorNeedle = `new ${"ServerLifecycleCore"}(`;
    const constructorReferences: string[] = [];
    for (const name of await readdir(runtimeSourceRoot)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      if ((await readFile(join(runtimeSourceRoot, name), "utf8")).includes(constructorNeedle)) {
        constructorReferences.push(name);
      }
    }
    expect(constructorReferences.sort()).toEqual(
      ["server-lifecycle.testing.ts", "server-lifecycle.ts"].sort(),
    );

    const tsconfig = JSON.parse(
      await readFile(join(runtimeSourceRoot, "..", "..", "tsconfig.json"), "utf8"),
    ) as { readonly exclude?: readonly string[] };
    expect(tsconfig.exclude).toContain("src/**/*.testing.ts");
    const productionRuntime = await readdir(join(runtimeSourceRoot, "..", "..", "dist", "runtime"));
    expect(productionRuntime.filter((name) => name.includes(".testing."))).toEqual([]);
    const publicRuntime = await import("../../dist/runtime/server-lifecycle.js");
    expect(Object.keys(publicRuntime)).toEqual(["createProductionServerLifecycle"]);
    const publicLifecycle = publicRuntime.createProductionServerLifecycle({
      shutdownTimeoutMilliseconds: 5_000,
    });
    expect(Object.isFrozen(publicLifecycle)).toBe(true);
    expect(Object.isFrozen(publicLifecycle.admission)).toBe(true);
    expect(Object.keys(publicLifecycle).sort()).toEqual(
      [
        "admission",
        "adoptApplication",
        "adoptStorageRuntime",
        "completion",
        "markRunning",
        "onArtifactFailStop",
        "requestGracefulShutdown",
        "sealStartupFailure",
        "sealStartupShutdown",
        "signal",
        "trackBackground",
      ].sort(),
    );
    expect("state" in publicLifecycle).toBe(false);
    const declaration = await readFile(
      join(runtimeSourceRoot, "..", "..", "dist", "runtime", "server-lifecycle.d.ts"),
      "utf8",
    );
    expect(declaration).not.toContain("ServerLifecycleCore");
    expect(declaration).not.toContain("ServerLifecycleCoreEffects");
    expect(declaration).not.toContain("server-lifecycle-core");
  });

  it("seals a storage-only startup failure and closes that owner before hard exit", async () => {
    const harness = createServerLifecycleTestingHarness();
    const storageClose = vi.fn(async () => undefined);
    harness.lifecycle.adoptStorageRuntime({ close: storageClose });

    harness.lifecycle.sealStartupFailure(new Error("startup failed"));

    expect(harness.lifecycle.signal.aborted).toBe(true);
    expect(harness.lifecycle.admission.read()).toBe(false);
    expect(harness.lifecycle.state).toBe("fail-stopping");
    expect(harness.armedDeadlineCount).toBe(1);
    expect(harness.queuedTeardownCount).toBe(1);
    harness.runQueuedTeardown();
    await vi.waitFor(() => expect(storageClose).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(harness.hardExitCodes).toEqual([1]));
  });

  it.each([
    { adoptApplication: true, name: "application-only" },
    { adoptApplication: false, name: "ownerless" },
  ])(
    "seals an $name startup failure without inventing missing owners",
    async ({ adoptApplication }) => {
      const harness = createServerLifecycleTestingHarness();
      const applicationClose = vi.fn(async () => undefined);
      if (adoptApplication) {
        harness.lifecycle.adoptApplication({ close: applicationClose });
      }

      harness.lifecycle.sealStartupFailure(new Error("startup failed"));
      expect(() => harness.lifecycle.adoptStorageRuntime({ close: async () => undefined })).toThrow(
        /sealed/u,
      );
      harness.runQueuedTeardown();

      await vi.waitFor(() => expect(harness.hardExitCodes).toEqual([1]));
      expect(applicationClose).toHaveBeenCalledTimes(adoptApplication ? 1 : 0);
    },
  );

  it("upgrades a startup signal when startup is sealed as failed", async () => {
    const harness = createServerLifecycleTestingHarness();
    const applicationClose = vi.fn(async () => undefined);
    harness.lifecycle.requestGracefulShutdown("SIGTERM");
    harness.lifecycle.adoptApplication({ close: applicationClose });

    harness.lifecycle.sealStartupFailure(new Error("startup interrupted"));

    expect(harness.lifecycle.state).toBe("fail-stopping");
    expect(harness.armedDeadlineCount).toBe(1);
    expect(harness.queuedTeardownCount).toBe(1);
    harness.runQueuedTeardown();
    await vi.waitFor(() => expect(applicationClose).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(harness.hardExitCodes).toEqual([1]));
  });

  it("seals a graceful startup shutdown with partial owners without hard exit", async () => {
    const harness = createServerLifecycleTestingHarness();
    const background = Promise.withResolvers<void>();
    const events: string[] = [];
    harness.lifecycle.requestGracefulShutdown("SIGTERM");
    harness.lifecycle.trackBackground(
      "startup-background",
      background.promise.then(() => {
        events.push("background");
      }),
    );
    harness.lifecycle.adoptStorageRuntime({
      close: async () => {
        events.push("storage");
      },
    });

    harness.lifecycle.sealStartupShutdown();
    harness.runQueuedTeardown();
    await settle();
    expect(events).not.toContain("storage");
    background.resolve();
    await harness.lifecycle.completion;

    expect(events).toEqual(["background", "storage"]);
    expect(harness.lifecycle.state).toBe("stopped");
    expect(harness.hardExitCodes).toEqual([]);
  });

  it("rejects startup-shutdown sealing before any shutdown request", () => {
    const harness = createServerLifecycleTestingHarness();
    expect(() => harness.lifecycle.sealStartupShutdown()).toThrow(/only after shutdown starts/u);
  });

  it("lets an early startup fatal wait for an explicit partial-owner seal", async () => {
    const harness = createServerLifecycleTestingHarness();
    harness.lifecycle.onArtifactFailStop(new Error("storage failed during startup"));
    harness.runQueuedTeardown();
    await settle();
    expect(harness.hardExitCodes).toEqual([]);

    harness.lifecycle.sealStartupShutdown();

    await vi.waitFor(() => expect(harness.hardExitCodes).toEqual([1]));
    expect(harness.armedDeadlineCount).toBe(1);
    expect(harness.queuedTeardownCount).toBe(0);
  });

  it("synchronously aborts and arms fail-stop before queued teardown", async () => {
    const harness = createServerLifecycleTestingHarness();
    const events: string[] = [];
    harness.lifecycle.adoptApplication({
      close: async () => {
        events.push("application");
      },
    });
    harness.lifecycle.trackBackground(
      "poller",
      Promise.resolve().then(() => {
        events.push("background");
      }),
    );
    harness.lifecycle.adoptStorageRuntime({
      close: async () => {
        events.push("storage");
      },
    });
    harness.lifecycle.markRunning();
    expect(Object.isFrozen(harness.lifecycle.admission)).toBe(true);
    expect(harness.lifecycle.admission.read()).toBe(true);

    harness.lifecycle.onArtifactFailStop(new Error("artifact storage failed"));

    expect(harness.lifecycle.signal.aborted).toBe(true);
    expect(harness.lifecycle.admission.read()).toBe(false);
    expect(harness.lifecycle.state).toBe("fail-stopping");
    expect(harness.armedDeadlineCount).toBe(1);
    expect(harness.queuedTeardownCount).toBe(1);
    expect(events).not.toContain("application");
    expect(events).not.toContain("storage");

    harness.runQueuedTeardown();
    await vi.waitFor(() => expect(harness.hardExitCodes).toEqual([1]));
    expect(events.indexOf("application")).toBeLessThan(events.indexOf("storage"));
    expect(events.indexOf("background")).toBeLessThan(events.indexOf("storage"));
    expect(harness.lifecycle.state).toBe("hard-exit");
  });

  it("deduplicates repeated fatal and graceful shutdown requests", async () => {
    const harness = createServerLifecycleTestingHarness();
    const applicationClose = vi.fn(async () => undefined);
    const storageClose = vi.fn(async () => undefined);
    harness.lifecycle.adoptApplication({ close: applicationClose });
    harness.lifecycle.adoptStorageRuntime({ close: storageClose });
    harness.lifecycle.markRunning();

    harness.lifecycle.onArtifactFailStop(new Error("first fatal"));
    harness.lifecycle.onArtifactFailStop(new Error("second fatal"));
    harness.lifecycle.requestGracefulShutdown("SIGTERM");

    expect(harness.armedDeadlineCount).toBe(1);
    expect(harness.queuedTeardownCount).toBe(1);
    harness.runQueuedTeardown();
    await vi.waitFor(() => expect(harness.hardExitCodes).toEqual([1]));
    expect(applicationClose).toHaveBeenCalledTimes(1);
    expect(storageClose).toHaveBeenCalledTimes(1);
  });

  it("waits for application and every background task before storage close", async () => {
    const harness = createServerLifecycleTestingHarness();
    const application = Promise.withResolvers<void>();
    const background = Promise.withResolvers<void>();
    const storageClose = vi.fn(async () => undefined);
    harness.lifecycle.adoptApplication({ close: () => application.promise });
    harness.lifecycle.trackBackground("poller", background.promise);
    harness.lifecycle.adoptStorageRuntime({ close: storageClose });
    harness.lifecycle.markRunning();

    harness.lifecycle.onArtifactFailStop(new Error("fatal"));
    harness.runQueuedTeardown();
    await settle();
    expect(storageClose).not.toHaveBeenCalled();

    application.resolve();
    await settle();
    expect(storageClose).not.toHaveBeenCalled();

    background.resolve();
    await vi.waitFor(() => expect(storageClose).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(harness.hardExitCodes).toEqual([1]));
  });

  it("observes a rejected poller before closing storage and completing fail-stop", async () => {
    const harness = createServerLifecycleTestingHarness();
    const poller = Promise.withResolvers<void>();
    const events: string[] = [];
    harness.lifecycle.adoptApplication({
      close: async () => {
        events.push("application");
      },
    });
    harness.lifecycle.trackBackground(
      "poller",
      poller.promise.finally(() => {
        events.push("poller-settled");
      }),
    );
    harness.lifecycle.adoptStorageRuntime({
      close: async () => {
        events.push("storage");
      },
    });
    harness.lifecycle.markRunning();

    poller.reject(new Error("poller failed"));
    await vi.waitFor(() => expect(harness.lifecycle.state).toBe("fail-stopping"));
    expect(harness.queuedTeardownCount).toBe(1);
    harness.runQueuedTeardown();

    await vi.waitFor(() => expect(harness.hardExitCodes).toEqual([1]));
    expect(events.indexOf("application")).toBeLessThan(events.indexOf("storage"));
    expect(events.indexOf("poller-settled")).toBeLessThan(events.indexOf("storage"));
  });

  it("hard-exits without closing storage when ingress drain fails", async () => {
    const harness = createServerLifecycleTestingHarness();
    const storageClose = vi.fn(async () => undefined);
    harness.lifecycle.adoptApplication({
      close: () => Promise.reject(new Error("application close failed")),
    });
    harness.lifecycle.adoptStorageRuntime({ close: storageClose });
    harness.lifecycle.markRunning();

    harness.lifecycle.onArtifactFailStop(new Error("fatal"));
    harness.runQueuedTeardown();

    await vi.waitFor(() => expect(harness.hardExitCodes).toEqual([1]));
    expect(storageClose).not.toHaveBeenCalled();
  });

  it("does not continue into storage close after the hard deadline fires", async () => {
    const harness = createServerLifecycleTestingHarness();
    const application = Promise.withResolvers<void>();
    const storageClose = vi.fn(async () => undefined);
    harness.lifecycle.adoptApplication({ close: () => application.promise });
    harness.lifecycle.adoptStorageRuntime({ close: storageClose });
    harness.lifecycle.markRunning();

    harness.lifecycle.onArtifactFailStop(new Error("fatal"));
    harness.runQueuedTeardown();
    await settle();
    harness.fireHardDeadline();

    expect(harness.hardExitCodes).toEqual([1]);
    expect(harness.lifecycle.state).toBe("hard-exit");
    expect(storageClose).not.toHaveBeenCalled();
    application.resolve();
    await settle();
    expect(storageClose).not.toHaveBeenCalled();
  });

  it("completes one ordered graceful shutdown without hard exit", async () => {
    const harness = createServerLifecycleTestingHarness();
    const events: string[] = [];
    harness.lifecycle.adoptApplication({
      close: async () => {
        events.push("application");
      },
    });
    harness.lifecycle.trackBackground(
      "poller",
      Promise.resolve().then(() => {
        events.push("background");
      }),
    );
    harness.lifecycle.adoptStorageRuntime({
      close: async () => {
        events.push("storage");
      },
    });
    harness.lifecycle.markRunning();

    harness.lifecycle.requestGracefulShutdown("SIGTERM");
    expect(harness.lifecycle.signal.aborted).toBe(true);
    expect(harness.lifecycle.admission.read()).toBe(false);
    expect(harness.queuedTeardownCount).toBe(1);
    harness.runQueuedTeardown();
    await harness.lifecycle.completion;

    expect(harness.lifecycle.state).toBe("stopped");
    expect(harness.hardExitCodes).toEqual([]);
    expect(events.indexOf("application")).toBeLessThan(events.indexOf("storage"));
    expect(events.indexOf("background")).toBeLessThan(events.indexOf("storage"));
    expect(() => harness.fireHardDeadline()).toThrow(/No lifecycle hard deadline/u);
  });

  it("treats a post-abort background rejection as graceful drain completion", async () => {
    const harness = createServerLifecycleTestingHarness();
    const background = Promise.withResolvers<void>();
    const storageClose = vi.fn(async () => undefined);
    harness.lifecycle.adoptApplication({ close: async () => undefined });
    harness.lifecycle.trackBackground("poller", background.promise);
    harness.lifecycle.adoptStorageRuntime({ close: storageClose });
    harness.lifecycle.markRunning();

    harness.lifecycle.requestGracefulShutdown("SIGTERM");
    harness.runQueuedTeardown();
    await settle();
    expect(harness.lifecycle.signal.aborted).toBe(true);
    expect(storageClose).not.toHaveBeenCalled();

    const abortError = new Error("poller aborted");
    abortError.name = "AbortError";
    background.reject(abortError);
    await harness.lifecycle.completion;

    expect(storageClose).toHaveBeenCalledTimes(1);
    expect(harness.lifecycle.state).toBe("stopped");
    expect(harness.hardExitCodes).toEqual([]);
  });

  it("upgrades graceful shutdown to fail-stop without starting another teardown", async () => {
    const harness = createServerLifecycleTestingHarness();
    const application = Promise.withResolvers<void>();
    const storageClose = vi.fn(async () => undefined);
    harness.lifecycle.adoptApplication({ close: () => application.promise });
    harness.lifecycle.adoptStorageRuntime({ close: storageClose });
    harness.lifecycle.markRunning();

    harness.lifecycle.requestGracefulShutdown("SIGTERM");
    harness.runQueuedTeardown();
    await settle();
    harness.lifecycle.onArtifactFailStop(new Error("fatal during drain"));

    expect(harness.lifecycle.state).toBe("fail-stopping");
    expect(harness.armedDeadlineCount).toBe(1);
    expect(harness.queuedTeardownCount).toBe(0);
    application.resolve();
    await vi.waitFor(() => expect(storageClose).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(harness.hardExitCodes).toEqual([1]));
  });
});
