import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  createRuntime: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock("./investigation/runtime.js", () => ({
  createInvestigationExecutionRuntime: state.createRuntime,
}));
vi.mock("./investigation/runtime-config.js", () => ({
  loadInvestigationWorkerRuntimeConfig: () => ({ logLevel: "info" }),
}));
vi.mock("./logging/logger.js", () => ({
  ConsoleJsonLogger: class {
    error = state.error;
    info = state.info;
  },
}));

import { main } from "./main.js";

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe.runIf(process.platform === "win32")("investigation Worker entry lifecycle", () => {
  it.each([false, true])(
    "preserves failure status when shutdown was requested: %s",
    async (shutdownRequested) => {
      const signals = new Map<string, () => void>();
      const originalOnce = process.once;
      vi.spyOn(process, "once").mockImplementation((event, listener) => {
        if (["SIGINT", "SIGTERM", "SIGBREAK"].includes(String(event))) {
          signals.set(String(event), listener as () => void);
          return process;
        }
        return originalOnce.call(process, event, listener);
      });
      const stop = vi.fn(async () => undefined);
      state.createRuntime.mockResolvedValue({
        run: async () => {
          if (shutdownRequested) signals.get("SIGTERM")!();
          throw new Error("Synthetic execution lifecycle fault.");
        },
        stop,
      });
      process.exitCode = 0;
      await main();
      expect(process.exitCode).toBe(1);
      expect(stop).toHaveBeenCalledTimes(shutdownRequested ? 2 : 1);
      expect(state.error).toHaveBeenCalledWith(
        "The investigation Worker stopped because of an unrecoverable error.",
      );
    },
  );

  it("keeps graceful shutdown successful when runtime execution has no fault", async () => {
    const signals = new Map<string, () => void>();
    const originalOnce = process.once;
    vi.spyOn(process, "once").mockImplementation((event, listener) => {
      if (["SIGINT", "SIGTERM", "SIGBREAK"].includes(String(event))) {
        signals.set(String(event), listener as () => void);
        return process;
      }
      return originalOnce.call(process, event, listener);
    });
    const stop = vi.fn(async () => undefined);
    state.createRuntime.mockResolvedValue({
      run: async () => signals.get("SIGTERM")!(),
      stop,
    });
    process.exitCode = 0;
    await main();
    expect(process.exitCode).toBe(0);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(state.error).not.toHaveBeenCalled();
  });
});
