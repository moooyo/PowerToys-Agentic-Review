import { mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireDesktopLease } from "./desktop-lease.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(await realpath(tmpdir()), "desktop-lease-"));
});
afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});
const acquire = (sessionId = 3, ownerId = "job-1") =>
  acquireDesktopLease({ lockDirectory: directory, sessionId, ownerId });

describe("shared desktop lease", () => {
  it.skipIf(process.platform !== "win32")(
    "treats Windows path casing aliases as the same shared lock",
    async () => {
      const lease = await acquireDesktopLease({
        lockDirectory: directory.toUpperCase(),
        sessionId: 3,
        ownerId: "first",
      });
      await expect(acquire()).rejects.toMatchObject({ code: "DESKTOP_QUARANTINED" });
      await lease.releaseRestored();
    },
  );
  it("excludes different jobs/nodes in the same session until restoration", async () => {
    const first = await acquire();
    await expect(acquire(3, "other-server:job-2")).rejects.toMatchObject({
      code: "DESKTOP_QUARANTINED",
    });
    await first.releaseRestored();
    await (await acquire(3, "other-server:job-2")).releaseRestored();
  });
  it("allows independently owned interactive sessions", async () => {
    const [first, second] = await Promise.all([acquire(3), acquire(4)]);
    await first.releaseRestored();
    await second.releaseRestored();
  });
  it("retains failed cleanup quarantine durably", async () => {
    const lease = await acquire();
    await lease.quarantine("CLEANUP_FAILED");
    const record = JSON.parse(await readFile(join(directory, "session-3.lock"), "utf8"));
    expect(record).toMatchObject({
      state: "quarantined",
      reasonCode: "CLEANUP_FAILED",
      ownerId: "job-1",
    });
    await expect(acquire()).rejects.toMatchObject({ code: "DESKTOP_QUARANTINED" });
    await expect(lease.releaseRestored()).rejects.toThrow();
  });
  it("never reclaims a crashed, empty, or unknown lock", async () => {
    await writeFile(join(directory, "session-3.lock"), "");
    await expect(acquire()).rejects.toMatchObject({ code: "DESKTOP_QUARANTINED" });
    expect(await readFile(join(directory, "session-3.lock"), "utf8")).toBe("");
  });
  it("does not remove a replacement lock", async () => {
    const lease = await acquire();
    const path = join(directory, "session-3.lock");
    await rename(path, `${path}.original`);
    await writeFile(path, '{"ownerToken":"different"}');
    await expect(lease.releaseRestored()).rejects.toMatchObject({ code: "DESKTOP_LOCK_UNSAFE" });
    await expect(lease.quarantine("OWNER_CHANGED")).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe('{"ownerToken":"different"}');
  });
  it.each([0, -1, 1.5, 4_294_967_296])("rejects invalid session %s", async (session) => {
    await expect(acquire(session)).rejects.toMatchObject({ code: "DESKTOP_LOCK_UNSAFE" });
  });
  it("has exactly one winner under simultaneous acquisition", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) => acquire(3, `job-${index}`)),
    );
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    for (const result of fulfilled) await result.value.releaseRestored();
  });
});
