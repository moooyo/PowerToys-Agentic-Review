import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseOwnerLock } from "../../dist/database/owner-lock.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DatabaseOwnerLock", () => {
  it("allows only one owner for a normalized database path", async () => {
    const directory = await createTemporaryDirectory();
    const databasePath = join(directory, "state.sqlite");
    const first = await DatabaseOwnerLock.acquire(databasePath);
    try {
      await expect(DatabaseOwnerLock.acquire(join(directory, ".", "state.sqlite"))).rejects.toThrow(
        /already owns database/u,
      );
    } finally {
      await first.close();
    }

    const replacement = await DatabaseOwnerLock.acquire(databasePath);
    await replacement.close();
  });

  it.skipIf(process.platform === "win32")(
    "treats paths through a symlinked parent as the same database",
    async () => {
      const directory = await createTemporaryDirectory();
      const dataDirectory = join(directory, "data");
      const aliasDirectory = join(directory, "alias");
      await mkdir(dataDirectory);
      await symlink(dataDirectory, aliasDirectory, "dir");
      const first = await DatabaseOwnerLock.acquire(join(dataDirectory, "state.sqlite"));
      try {
        await expect(
          DatabaseOwnerLock.acquire(join(aliasDirectory, "state.sqlite")),
        ).rejects.toThrow(/already owns database/u);
      } finally {
        await first.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")("rejects hard-linked database aliases", async () => {
    const directory = await createTemporaryDirectory();
    const databasePath = join(directory, "state.sqlite");
    await writeFile(databasePath, "");
    await link(databasePath, join(directory, "state-alias.sqlite"));

    await expect(DatabaseOwnerLock.acquire(databasePath)).rejects.toThrow(
      /must not have hard links/u,
    );
  });
});

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-owner-lock-"));
  temporaryDirectories.push(directory);
  return directory;
};
