import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import {
  type InvestigationAccount,
  InvestigationNewPasswordSchema,
  InvestigationUsernameInputSchema,
  normalizeInvestigationUsername,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import {
  InvestigationPasswordStore,
  InvestigationPasswordStoreError,
  investigationPasswordSchemaVersion,
} from "./password-store.js";

export interface InvestigationAdministratorResetOptions {
  readonly databasePath: string;
  readonly username: string;
  readonly passwordPath: string;
}

/** Direct local recovery. This operation is intentionally not exposed through an HTTP route. */
export async function resetInvestigationAdministrator(
  options: InvestigationAdministratorResetOptions,
): Promise<InvestigationAccount> {
  if (!Value.Check(InvestigationUsernameInputSchema, options.username))
    throw new Error("The administrator username is invalid.");
  const databasePath = resolve(options.databasePath);
  if (!statSync(databasePath, { throwIfNoEntry: false })?.isFile())
    throw new Error("An existing password account database is required.");
  const schemaReader = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const versions = schemaReader
      .prepare("SELECT version FROM investigation_password_metadata")
      .all();
    if (versions.length !== 1 || versions[0]?.version !== investigationPasswordSchemaVersion)
      throw new Error("An existing compatible password account database is required.");
  } finally {
    schemaReader.close();
  }
  const passwordFile = statSync(options.passwordPath, { throwIfNoEntry: false });
  if (passwordFile === undefined || !passwordFile.isFile() || passwordFile.size > 512)
    throw new Error("A protected UTF-8 password file of at most 512 bytes is required.");
  const password = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    readFileSync(options.passwordPath),
  );
  if (!Value.Check(InvestigationNewPasswordSchema, password))
    throw new Error(
      "The replacement password must contain 15 to 128 characters, including a non-whitespace character.",
    );
  const store = new InvestigationPasswordStore(databasePath);
  try {
    return await store.resetAdministratorOffline(
      normalizeInvestigationUsername(options.username),
      password,
    );
  } finally {
    store.close();
  }
}

const usage =
  "Usage: pnpm --filter @agentic-review/server run accounts:reset-admin --database <existing-account-db> --username <administrator> --password-path <protected-utf8-file>\nStop the server before recovery. The file is read verbatim; no password value belongs in command-line arguments.\n";

export async function runInvestigationAdministratorReset(
  args: readonly string[] = process.argv.slice(2),
  output: { write: (value: string) => void; error: (value: string) => void } = {
    write: (value) => process.stdout.write(value),
    error: (value) => process.stderr.write(value),
  },
): Promise<number> {
  try {
    const parsed = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: false,
      options: {
        database: { type: "string" },
        username: { type: "string" },
        "password-path": { type: "string" },
        help: { type: "boolean" },
      },
    });
    if (parsed.values.help === true) {
      output.write(usage);
      return 0;
    }
    if (
      parsed.values.database === undefined ||
      parsed.values.username === undefined ||
      parsed.values["password-path"] === undefined
    )
      throw new Error("The database, username, and password-path arguments are required.");
    const account = await resetInvestigationAdministrator({
      databasePath: parsed.values.database,
      username: parsed.values.username,
      passwordPath: parsed.values["password-path"],
    });
    output.write(
      `${JSON.stringify({ event: "administrator_password_reset", accountId: account.id, username: account.username, version: account.version })}\n`,
    );
    return 0;
  } catch (error) {
    const message =
      error instanceof InvestigationPasswordStoreError
        ? error.message
        : "Administrator recovery failed. Check the arguments, existing database, and protected password file.";
    output.error(`${JSON.stringify({ event: "administrator_password_reset_failed", message })}\n`);
    return 1;
  }
}
