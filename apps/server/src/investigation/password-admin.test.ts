import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resetInvestigationAdministrator,
  runInvestigationAdministratorReset,
} from "../../dist/investigation/password-admin.js";
import { InvestigationPasswordStore } from "../../dist/investigation/password-store.js";

const directories: string[] = [];
const stores: InvestigationPasswordStore[] = [];
const oldPassword = "Synthetic original administrator password";
const replacement = "  Synthetic recovered administrator password  ";

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "password-admin-cli-"));
  directories.push(directory);
  const databasePath = join(directory, "accounts.sqlite");
  const passwordPath = join(directory, "new-password.txt");
  await writeFile(passwordPath, replacement);
  const store = new InvestigationPasswordStore(databasePath);
  stores.push(store);
  const admin = await store.initializeBootstrap({
    username: "fixture-admin",
    password: oldPassword,
    repositoryIds: ["repo-1"],
    permissions: ["task:create"],
  });
  if (admin === null) throw new Error("The fresh fixture needs an administrator.");
  return { directory, databasePath, passwordPath, store, admin };
}

describe("offline administrator password recovery", () => {
  it("resets only the existing administrator password, preserves access, and revokes sessions", async () => {
    const fixtureData = await fixture();
    const session = await fixtureData.store.authenticate("fixture-admin", oldPassword);
    expect(session).not.toBeNull();
    fixtureData.store.close();
    const reset = await resetInvestigationAdministrator({
      databasePath: fixtureData.databasePath,
      passwordPath: fixtureData.passwordPath,
      username: " FIXTURE-ADMIN ",
    });
    expect(reset).toMatchObject({
      id: fixtureData.admin.id,
      username: "fixture-admin",
      repositoryIds: ["repo-1"],
      permissions: ["task:create"],
      version: 2,
    });
    const reopened = new InvestigationPasswordStore(fixtureData.databasePath);
    stores.push(reopened);
    expect(reopened.getSession(session!.token)).toBeNull();
    expect(await reopened.authenticate("fixture-admin", oldPassword)).toBeNull();
    expect(await reopened.authenticate("fixture-admin", replacement.trim())).toBeNull();
    expect(await reopened.authenticate("fixture-admin", replacement)).not.toBeNull();
  }, 20000);

  it("rejects an existing empty target without creating schema or changing its bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "password-admin-empty-"));
    directories.push(directory);
    const databasePath = join(directory, "empty.sqlite");
    const passwordPath = join(directory, "password.txt");
    await writeFile(databasePath, "");
    await writeFile(passwordPath, replacement);
    await expect(
      resetInvestigationAdministrator({ databasePath, passwordPath, username: "fixture-admin" }),
    ).rejects.toThrow();
    expect((await readFile(databasePath)).byteLength).toBe(0);
  });

  it("does not promote regular accounts, accept inline secrets, or print password material", async () => {
    const fixtureData = await fixture();
    const user = await fixtureData.store.createAccount(
      { id: fixtureData.admin.id, version: fixtureData.admin.version },
      { username: "fixture-user", password: oldPassword },
    );
    fixtureData.store.close();
    await expect(
      resetInvestigationAdministrator({
        databasePath: fixtureData.databasePath,
        passwordPath: fixtureData.passwordPath,
        username: user.username,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const messages: string[] = [];
    const output = {
      write: (value: string) => {
        messages.push(value);
      },
      error: (value: string) => {
        messages.push(value);
      },
    };
    expect(await runInvestigationAdministratorReset(["--password", replacement], output)).toBe(1);
    expect(
      await runInvestigationAdministratorReset(
        [
          "--database",
          fixtureData.databasePath,
          "--username",
          "fixture-admin",
          "--password-path",
          fixtureData.passwordPath,
        ],
        output,
      ),
    ).toBe(0);
    expect(messages.join("")).not.toContain(replacement);
    expect(messages.join("")).not.toContain(oldPassword);
    expect(messages.join("")).not.toContain("$scrypt$");
    expect(messages.join("")).toContain("administrator_password_reset");
  }, 20000);
});
