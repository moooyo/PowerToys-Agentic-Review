import {
  InvestigationAccountSchema,
  InvestigationNewPasswordSchema,
  InvestigationUsernameSchema,
  normalizeInvestigationUsername,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import type { Account, CreateAccountInput, UpdateAccountInput } from "./auth-api";

export const permissionOptions = [
  { value: "repository:manage", label: "Manage repositories" },
  { value: "task:create", label: "Create investigations" },
  { value: "task:cancel", label: "Cancel investigations" },
  { value: "action:prepare", label: "Prepare actions" },
  { value: "action:execute", label: "Execute actions" },
] satisfies { value: Account["permissions"][number]; label: string }[];

export interface AccountFormValues {
  username: string;
  password: string;
  displayName: string;
  enabled: boolean;
  isAdmin: boolean;
  repositoryIdsText: string;
  permissions: Account["permissions"];
  actionCapabilities: Account["actionCapabilities"];
  allowRepositoryExecution: boolean;
}

export type AccountFormField = "username" | "password" | "displayName" | "repositoryIdsText";

export class AccountFormError extends Error {
  constructor(
    public readonly field: AccountFormField,
    message: string,
  ) {
    super(message);
    this.name = "AccountFormError";
  }
}

export function accountFormValues(account?: Account): AccountFormValues {
  return {
    username: account?.username ?? "",
    password: "",
    displayName: account?.displayName ?? "",
    enabled: account?.enabled ?? true,
    isAdmin: account?.isAdmin ?? false,
    repositoryIdsText: account?.repositoryIds.join("\n") ?? "",
    permissions: [...(account?.permissions ?? [])],
    actionCapabilities: [...(account?.actionCapabilities ?? [])],
    allowRepositoryExecution: account?.allowRepositoryExecution ?? false,
  };
}

export function parseRepositoryIds(value: string): string[] {
  const ids = [...new Set(value.split(/[\s,]+/u).filter(Boolean))];
  if (!Value.Check(InvestigationAccountSchema.properties.repositoryIds, ids)) {
    throw new AccountFormError(
      "repositoryIdsText",
      "Enter up to 1,024 exact repository IDs, separated by commas or new lines. Wildcards are not supported.",
    );
  }
  return ids;
}

export function assertNewPassword(password: string): void {
  if (!Value.Check(InvestigationNewPasswordSchema, password)) {
    throw new AccountFormError(
      "password",
      "Use a password between 15 and 128 characters, including a non-whitespace character.",
    );
  }
}

function accountAccessInput(form: AccountFormValues) {
  const displayName = form.displayName.trim();
  if (!Value.Check(InvestigationAccountSchema.properties.displayName, displayName)) {
    throw new AccountFormError("displayName", "Enter a display name between 1 and 120 characters.");
  }
  return {
    displayName,
    isAdmin: form.isAdmin,
    repositoryIds: parseRepositoryIds(form.repositoryIdsText),
    permissions: [...form.permissions],
    actionCapabilities: [...form.actionCapabilities],
    allowRepositoryExecution: form.allowRepositoryExecution,
  };
}

export function createAccountInput(form: AccountFormValues): CreateAccountInput {
  const username = normalizeInvestigationUsername(form.username);
  if (!Value.Check(InvestigationUsernameSchema, username)) {
    throw new AccountFormError(
      "username",
      "Use 3–64 letters, numbers, periods, underscores, or hyphens; start with a letter or number.",
    );
  }
  assertNewPassword(form.password);
  return { ...accountAccessInput(form), username, password: form.password };
}

export function updateAccountInput(form: AccountFormValues, version: number): UpdateAccountInput {
  return { ...accountAccessInput(form), enabled: form.enabled, version };
}

export function accountWriteVersion(
  account: Account,
  conflict: boolean,
  latest: Account | undefined,
  reviewed: boolean,
): number {
  if (!conflict) return account.version;
  if (!latest || latest.id !== account.id || !reviewed) {
    throw new Error("Refresh this account and review its current access before trying again.");
  }
  return latest.version;
}

export async function submitAccountForm(
  form: AccountFormValues,
  account: Account | undefined,
  version: number | undefined,
  api: {
    createAccount: (input: CreateAccountInput) => Promise<Account>;
    updateAccount: (id: string, input: UpdateAccountInput) => Promise<Account>;
  },
  clearPassword: () => void,
): Promise<Account> {
  try {
    if (!account) return await api.createAccount(createAccountInput(form));
    return await api.updateAccount(
      account.id,
      updateAccountInput(form, version ?? account.version),
    );
  } finally {
    clearPassword();
  }
}

export async function submitAccountPassword(
  account: Account,
  newPassword: string,
  version: number,
  reset: (id: string, input: { version: number; newPassword: string }) => Promise<Account>,
  clearPassword: () => void,
): Promise<Account> {
  try {
    assertNewPassword(newPassword);
    return await reset(account.id, { version, newPassword });
  } finally {
    clearPassword();
  }
}
