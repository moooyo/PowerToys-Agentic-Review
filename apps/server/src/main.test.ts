import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ start: vi.fn<() => Promise<void>>() }));
vi.mock("./investigation/runtime-main.js", () => ({ runInvestigationServer: runtime.start }));

afterEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
});

// Runtime assembly, scoped identities, persistence, and shutdown are covered by
// investigation/runtime-main.test.ts and runtime-auth.test.ts. This entry must
// await that lifecycle rather than report success while startup is still pending.
describe("native investigation production entry", () => {
  it("keeps the entry pending until the owned server lifecycle completes", async () => {
    let finish: (() => void) | undefined;
    runtime.start.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    let settled = false;
    const entry = import("./main.js").then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    finish?.();
    await entry;
    expect(settled).toBe(true);
    expect(runtime.start).toHaveBeenCalledOnce();
  });

  it("propagates an unsuccessful native runtime instead of starting a legacy fallback", async () => {
    const failure = new Error("Synthetic native runtime startup failure.");
    runtime.start.mockRejectedValueOnce(failure);
    await expect(import("./main.js")).rejects.toBe(failure);
    expect(runtime.start).toHaveBeenCalledOnce();
  });
});
